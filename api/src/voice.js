let _settings = {};

export function setVoiceSettings(s) {
  _settings = s ?? {};
}

export function getTTSProvider() {
  return _settings.ttsProvider ?? process.env.TTS_PROVIDER ?? 'elevenlabs';
}

export function getSTTProvider() {
  return _settings.sttProvider ?? process.env.STT_PROVIDER ?? 'elevenlabs';
}

export function getFishAudioApiKey() {
  return _settings.fishaudioApiKey || process.env.FISHAUDIO_API_KEY || '';
}

export function getFishAudioDefaultVoiceId() {
  return process.env.FISHAUDIO_VOICE_ID ?? '';
}
