import { Router } from 'express';
import multer from 'multer';
import { pipeline } from '@xenova/transformers';
import { getFishAudioApiKey } from '../voice.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

let whisper = null;

async function getWhisper() {
  if (!whisper) {
    const model = process.env.WHISPER_MODEL ?? 'Xenova/whisper-small';
    console.log(`[transcribe] carregando modelo ${model}…`);
    whisper = await pipeline('automatic-speech-recognition', model, { quantized: true });
    console.log('[transcribe] modelo pronto');
  }
  return whisper;
}


function wavToFloat32(buffer) {
  const view = new DataView(buffer);
  const sampleRate = view.getUint32(24, true);
  const dataOffset = 44;
  const samples = (buffer.byteLength - dataOffset) / 2;
  const float32 = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    float32[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return { float32, sampleRate };
}

async function transcribeWhisper(fileBuffer) {
  const buf = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
  const { float32, sampleRate } = wavToFloat32(buf);
  const t = await getWhisper();
  const result = await t(float32, { sampling_rate: sampleRate, language: 'english' });
  return result.text?.trim() ?? '';
}

export async function transcribeElevenLabs(fileBuffer, language = 'en', mimeType = 'audio/wav', filename = 'audio.wav') {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  form.append('model_id', 'scribe_v2');
  form.append('tag_audio_events', 'false');
  if (language) form.append('language_code', language);

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs STT ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.text?.trim() ?? '';
}

export async function transcribeFishAudio(fileBuffer, language = 'en', mimeType = 'audio/wav', filename = 'audio.wav') {
  const apiKey = getFishAudioApiKey();
  if (!apiKey) throw new Error('FISHAUDIO_API_KEY not set');

  const form = new FormData();
  form.append('audio', new Blob([fileBuffer], { type: mimeType }), filename);
  if (language) form.append('language', language);

  const res = await fetch('https://api.fish.audio/v1/asr', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fish Audio ASR ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.text?.trim() ?? '';
}

export default (app) => {
  const router = Router();

  router.post('/', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'audio required' });

    const provider = req.body?.provider ?? 'whisper';
    const language = req.body?.language ?? 'en';

    try {
      let transcript;
      if (provider === 'elevenlabs') {
        transcript = await transcribeElevenLabs(req.file.buffer, language, req.file.mimetype, req.file.originalname);
      } else if (provider === 'fishaudio') {
        transcript = await transcribeFishAudio(req.file.buffer, language, req.file.mimetype, req.file.originalname);
      } else {
        transcript = await transcribeWhisper(req.file.buffer);
      }
      res.json({ transcript, provider });
    } catch (err) {
      console.error(`[transcribe:${provider}]`, err);
      res.status(500).json({ error: 'transcription failed', provider });
    }
  });

  app.use('/api/transcribe', router);
};
