import { requireOptionalNativeModule } from "expo";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

interface AndroidVoiceTranscription {
  isAvailable(): boolean;
  prepare(locale: string): Promise<string>;
  transcribe(uri: string, locale: string): Promise<string>;
}

const native = requireOptionalNativeModule<AndroidVoiceTranscription>("T3VoiceTranscription");

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  if (!native?.isAvailable()) return null;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return { prepare: (options) => prepareVoiceTranscription(native, locale, options) };
}

async function prepareVoiceTranscription(
  module: AndroidVoiceTranscription,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  try {
    const preparedLocale = await module.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return {
      locale: preparedLocale,
      transcribe: (uri, options) => transcribe(module, uri, preparedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (error instanceof VoiceTranscriptionError) throw error;
    const unavailable = (error as { code?: unknown } | null)?.code === "Unavailable";
    throw new VoiceTranscriptionError(
      unavailable ? "unsupported-locale" : "preparation-failed",
      unavailable
        ? "On-device voice transcription does not support this device language."
        : "Voice transcription could not prepare this language.",
      { cause: error },
    );
  }
}

async function transcribe(
  module: AndroidVoiceTranscription,
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const text = await module.transcribe(uri, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return text;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (error instanceof VoiceTranscriptionError) throw error;
    throw new VoiceTranscriptionError("transcription-failed", "Voice transcription failed.", {
      cause: error,
    });
  }
}
