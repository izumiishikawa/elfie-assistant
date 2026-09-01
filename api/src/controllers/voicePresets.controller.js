import VoicePreset from '../models/VoicePreset.js';

const PROVIDERS = new Set(['elevenlabs', 'fishaudio']);

export async function listVoicePresets(_req, res) {
  try {
    const presets = await VoicePreset.find().sort({ createdAt: 1 });
    res.json(presets);
  } catch (err) {
    console.error('[listVoicePresets]', err);
    res.status(500).json({ error: 'Failed to list voice presets' });
  }
}

export async function createVoicePreset(req, res) {
  try {
    const { name, voiceId, provider } = req.body;
    const trimmedName = (name ?? '').trim();
    const trimmedVoiceId = (voiceId ?? '').trim();
    if (!trimmedName) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (!trimmedVoiceId) return res.status(400).json({ error: 'Voice ID é obrigatório.' });
    if (!PROVIDERS.has(provider)) return res.status(400).json({ error: 'Provedor inválido.' });
    if (await VoicePreset.findOne({ name: new RegExp(`^${trimmedName}$`, 'i') })) {
      return res.status(409).json({ error: 'Já existe uma voz com esse nome.' });
    }
    const preset = await VoicePreset.create({ name: trimmedName, voiceId: trimmedVoiceId, provider });
    res.status(201).json(preset);
  } catch (err) {
    console.error('[createVoicePreset]', err);
    res.status(500).json({ error: 'Failed to create voice preset' });
  }
}

export async function updateVoicePreset(req, res) {
  try {
    const { name, voiceId, provider } = req.body;
    const patch = {};
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) return res.status(400).json({ error: 'Nome é obrigatório.' });
      if (await VoicePreset.findOne({ name: new RegExp(`^${trimmedName}$`, 'i'), _id: { $ne: req.params.id } })) {
        return res.status(409).json({ error: 'Já existe uma voz com esse nome.' });
      }
      patch.name = trimmedName;
    }
    if (voiceId !== undefined) {
      const trimmedVoiceId = voiceId.trim();
      if (!trimmedVoiceId) return res.status(400).json({ error: 'Voice ID é obrigatório.' });
      patch.voiceId = trimmedVoiceId;
    }
    if (provider !== undefined) {
      if (!PROVIDERS.has(provider)) return res.status(400).json({ error: 'Provedor inválido.' });
      patch.provider = provider;
    }

    const preset = await VoicePreset.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!preset) return res.status(404).json({ error: 'Voice preset not found' });
    res.json(preset);
  } catch (err) {
    console.error('[updateVoicePreset]', err);
    res.status(500).json({ error: 'Failed to update voice preset' });
  }
}

export async function deleteVoicePreset(req, res) {
  try {
    const preset = await VoicePreset.findByIdAndDelete(req.params.id);
    if (!preset) return res.status(404).json({ error: 'Voice preset not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[deleteVoicePreset]', err);
    res.status(500).json({ error: 'Failed to delete voice preset' });
  }
}
