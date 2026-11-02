package expo.modules.t3voicetranscription

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import com.google.mlkit.genai.speechrecognition.speechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.speechRecognizerRequest
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import kotlin.concurrent.thread
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.withContext

// ML Kit's file input takes headerless 16-bit mono PCM at this rate.
private const val SAMPLE_RATE = 16_000

class T3VoiceTranscriptionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3VoiceTranscription")

    // Basic mode needs Android 12; Advanced (Gemini Nano) is picked when the device has it.
    Function("isAvailable") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.S }

    AsyncFunction("prepare") Coroutine { locale: String ->
      withRecognizer(locale) { recognizer ->
        when (recognizer.checkStatus()) {
          FeatureStatus.AVAILABLE -> Unit
          FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> {
            val result = recognizer.download().first {
              it is DownloadStatus.DownloadCompleted || it is DownloadStatus.DownloadFailed
            }
            if (result is DownloadStatus.DownloadFailed) throw result.e
          }
          else -> throw CodedException(
            "Unavailable",
            "On-device speech recognition is not available for $locale on this device.",
            null,
          )
        }
        locale
      }
    }

    AsyncFunction("transcribe") Coroutine { uri: String, locale: String ->
      val pcm = withContext(Dispatchers.IO) { decodePcm(uri) }
      withRecognizer(locale) { recognizer -> recognize(recognizer, pcm) }
    }
  }
}

private suspend fun <T> withRecognizer(locale: String, block: suspend (SpeechRecognizer) -> T): T {
  val recognizer = SpeechRecognition.getClient(
    speechRecognizerOptions {
      this.locale = Locale.forLanguageTag(locale)
      preferredMode = SpeechRecognizerOptions.Mode.MODE_ADVANCED
    }
  )
  try {
    return block(recognizer)
  } finally {
    recognizer.close()
  }
}

private suspend fun recognize(recognizer: SpeechRecognizer, pcm: ByteArray): String {
  val (input, output) = ParcelFileDescriptor.createPipe()
  // The pipe applies backpressure, so the recognizer reads at its own pace.
  thread(name = "T3VoiceTranscriptionWriter") {
    try {
      ParcelFileDescriptor.AutoCloseOutputStream(output).use { it.write(pcm) }
    } catch (_: IOException) {
      // The recognizer stopped reading early; its error surfaces through the flow.
    }
  }
  val text = StringBuilder()
  try {
    recognizer
      .startRecognition(speechRecognizerRequest { audioSource = AudioSource.fromPfd(input) })
      .takeWhile { it !is SpeechRecognizerResponse.CompletedResponse }
      .collect { response ->
        when (response) {
          is SpeechRecognizerResponse.FinalTextResponse -> text.append(response.text).append(' ')
          is SpeechRecognizerResponse.ErrorResponse -> throw response.e
          else -> Unit
        }
      }
  } finally {
    input.close()
  }
  return text.toString().trim()
}

private fun decodePcm(uri: String): ByteArray {
  val extractor = MediaExtractor()
  extractor.setDataSource(Uri.parse(uri).path ?: uri)
  val track = (0 until extractor.trackCount).firstOrNull {
    extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
  } ?: throw CodedException("InvalidAudio", "The recording has no audio track.", null)
  extractor.selectTrack(track)
  val format = extractor.getTrackFormat(track)
  var sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
  var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
  val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
  val pcm = ByteArrayOutputStream()
  try {
    codec.configure(format, null, null, 0)
    codec.start()
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    while (true) {
      if (!inputDone) {
        val index = codec.dequeueInputBuffer(10_000)
        if (index >= 0) {
          val size = extractor.readSampleData(codec.getInputBuffer(index)!!, 0)
          if (size < 0) {
            codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            inputDone = true
          } else {
            codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
            extractor.advance()
          }
        }
      }
      val index = codec.dequeueOutputBuffer(info, 10_000)
      if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
        sampleRate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        channels = codec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      } else if (index >= 0) {
        val bytes = ByteArray(info.size)
        codec.getOutputBuffer(index)!!.apply { position(info.offset) }.get(bytes)
        pcm.write(bytes)
        codec.releaseOutputBuffer(index, false)
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
      }
    }
  } finally {
    codec.release()
    extractor.release()
  }
  return toMono16k(pcm.toByteArray(), sampleRate, channels)
}

// ponytail: linear resampling without a low-pass filter; recordings are already 16 kHz mono, so this is normally a copy.
private fun toMono16k(pcm: ByteArray, sampleRate: Int, channels: Int): ByteArray {
  if (sampleRate == SAMPLE_RATE && channels == 1) return pcm
  val samples = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
  val frames = samples.remaining() / channels
  if (frames == 0) return ByteArray(0)
  val mono = FloatArray(frames) { frame ->
    (0 until channels).sumOf { samples.get(frame * channels + it).toInt() }.toFloat() / channels
  }
  val outFrames = (frames.toLong() * SAMPLE_RATE / sampleRate).toInt()
  val out = ByteBuffer.allocate(outFrames * 2).order(ByteOrder.LITTLE_ENDIAN)
  for (i in 0 until outFrames) {
    val position = i.toDouble() * sampleRate / SAMPLE_RATE
    val j = position.toInt()
    val next = mono[minOf(j + 1, frames - 1)]
    val value = mono[j] + (next - mono[j]) * (position - j).toFloat()
    out.putShort(value.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
  }
  return out.array()
}
