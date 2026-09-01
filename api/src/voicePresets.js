import Character from './models/Character.js';
import Settings from './models/Settings.js';
import VoicePreset from './models/VoicePreset.js';
import { setVoiceSettings } from './voice.js';

async function getOrCreateSettings() {
  let s = await Settings.findOne();
  if (!s) s = await Settings.create({});
  return s;
}

export async function switchActiveVoice({ voiceId, name } = {}) {
  let resolvedVoiceId = voiceId ? String(voiceId).trim() : '';
  let provider = null;

  if (!resolvedVoiceId && name) {
    const trimmedName = String(name).trim();
    const preset = await VoicePreset.findOne({ name: new RegExp(`^${trimmedName}$`, 'i') });
    if (!preset) {
      const names = (await VoicePreset.find().select('name')).map((p) => p.name);
      const err = new Error(
        `No saved voice named "${trimmedName}".` +
          (names.length ? ` Available: ${names.join(', ')}.` : ' No voices have been saved yet.'),
      );
      err.code = 'NOT_FOUND';
      throw err;
    }
    resolvedVoiceId = preset.voiceId;
    provider = preset.provider;
  }

  if (!resolvedVoiceId) {
    const err = new Error('voiceId or name is required');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const settings = await getOrCreateSettings();
  const charId = settings.activeCharacterId ?? (await Character.findOne())?._id;
  if (!charId) {
    const err = new Error('No active character');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const character = await Character.findByIdAndUpdate(charId, { $set: { voiceId: resolvedVoiceId } }, { new: true });
  if (!character) {
    const err = new Error('Active character not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (provider && provider !== settings.ttsProvider) {
    const updatedSettings = await Settings.findOneAndUpdate({}, { $set: { ttsProvider: provider } }, { new: true });
    setVoiceSettings(updatedSettings);
  }

  return { character, voiceId: resolvedVoiceId, provider };
}
