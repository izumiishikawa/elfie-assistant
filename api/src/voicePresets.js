import Character from './models/Character.js';
import Settings from './models/Settings.js';
import VoicePreset from './models/VoicePreset.js';
import { setVoiceSettings } from './voice.js';

async function getOrCreateSettings() {
  let s = await Settings.findOne();
  if (!s) s = await Settings.create({});
  return s;
}

function normalizeName(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

async function findPresetFuzzy(trimmedName) {
  const exact = await VoicePreset.findOne({ name: new RegExp(`^${trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  if (exact) return exact;

  const all = await VoicePreset.find();
  const target = normalizeName(trimmedName);
  let best = null;
  let bestDist = Infinity;
  for (const p of all) {
    const dist = levenshtein(target, normalizeName(p.name));
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  const threshold = Math.max(1, Math.ceil(target.length * 0.3));
  return best && bestDist <= threshold ? best : null;
}

export async function listVoicePresets() {
  const [presets, settings] = await Promise.all([
    VoicePreset.find().sort({ name: 1 }).lean(),
    getOrCreateSettings(),
  ]);
  const charId = settings.activeCharacterId ?? (await Character.findOne())?._id;
  const character = charId ? await Character.findById(charId).select('voiceId').lean() : null;
  return presets.map((p) => ({
    name: p.name,
    provider: p.provider,
    active: !!character && character.voiceId === p.voiceId,
  }));
}

export async function switchActiveVoice({ voiceId, name } = {}) {
  let resolvedVoiceId = voiceId ? String(voiceId).trim() : '';
  let provider = null;

  if (!resolvedVoiceId && name) {
    const trimmedName = String(name).trim();
    const preset = await findPresetFuzzy(trimmedName);
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
