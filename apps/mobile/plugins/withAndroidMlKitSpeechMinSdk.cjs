const { withAndroidManifest } = require("expo/config-plugins");

// ML Kit speech declares minSdk 26 while the app supports 24. The transcriber only loads it on 31+,
// and the merger honours overrideLibrary only in the app's main manifest.
const LIBRARIES = "com.google.mlkit.genai.speechrecognition,com.google.mlkit.genai.common";

module.exports = function withAndroidMlKitSpeechMinSdk(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults.manifest;
    manifest.$["xmlns:tools"] ??= "http://schemas.android.com/tools";
    manifest["uses-sdk"] = [{ $: { "tools:overrideLibrary": LIBRARIES } }];
    return nextConfig;
  });
};
