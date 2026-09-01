import { Router } from 'express';
import { getFishAudioApiKey } from '../voice.js';

async function fetchElevenLabsVoices() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ELEVENLABS_API_KEY not set'), { status: 500 });

  const r = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!r.ok) throw Object.assign(new Error('ElevenLabs error'), { status: r.status });
  const { voices } = await r.json();

  const list = voices.map((v) => ({
    voice_id:    v.voice_id,
    name:        v.name,
    category:    v.category,
    preview_url: v.preview_url ?? null,
  }));

  list.sort((a, b) => {
    const order = { cloned: 0, generated: 0, premade: 1 };
    return (order[a.category] ?? 1) - (order[b.category] ?? 1) || a.name.localeCompare(b.name);
  });

  return list;
}

async function fetchFishAudioVoices() {
  const apiKey = getFishAudioApiKey();
  if (!apiKey) throw Object.assign(new Error('FISHAUDIO_API_KEY not set'), { status: 500 });

  const r = await fetch('https://api.fish.audio/model?self=true&page_size=100&sort_by=created_at', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw Object.assign(new Error('Fish Audio error'), { status: r.status });
  const { items } = await r.json();

  return (items ?? [])
    .map((m) => ({
      voice_id:    m._id,
      name:        m.title,
      category:    'cloned',
      preview_url: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default (app) => {
  const router = Router();

  router.get('/', async (req, res) => {
    const provider = req.query.provider === 'fishaudio' ? 'fishaudio' : 'elevenlabs';
    try {
      const voices = provider === 'fishaudio'
        ? await fetchFishAudioVoices()
        : await fetchElevenLabsVoices();
      res.json({ voices });
    } catch (err) {
      console.error('[voices]', err);
      res.status(err.status ?? 500).json({ error: err.message ?? 'Failed to fetch voices' });
    }
  });

  app.use('/api/voices', router);
};
