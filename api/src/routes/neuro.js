import { Router } from 'express';
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import Chat from '../models/Chat.js';
import {
  getTask, deleteTask, sendToDaemon,
  getOrCreateSession, getSession, setSessionSseRes, setSessionStatus,
  pushSessionEvent, submitSessionAnswer, waitForSessionAnswer, getSessionHistory,
  getRunningSessions,
} from '../neuroStore.js';
import { getTTSProvider, getFishAudioApiKey, getFishAudioDefaultVoiceId } from '../voice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', '..', 'uploads');

async function speakNeuroText(text, voiceId) {
  const clean = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();
  if (!clean) return;

  let buffer;
  if (getTTSProvider() === 'fishaudio') {
    const apiKey = getFishAudioApiKey();
    if (!apiKey) return;
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: clean,
        reference_id: voiceId || getFishAudioDefaultVoiceId() || undefined,
        format: 'mp3',
        latency: 'low',
      }),
    });
    if (!res.ok) throw new Error(`Fish Audio ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return;
    const vid = voiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream?optimize_streaming_latency=4&output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: clean,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.2, style: 0 },
        }),
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  }

  const filename = `voice-${randomBytes(12).toString('hex')}.mp3`;
  await writeFile(resolve(uploadDir, filename), buffer);
  await sendToDaemon({ cmd: 'play_audio', filename });
}

const tag = (id) => `[neuro:${id?.slice(0, 8)}]`;

export default (app) => {
  const router = Router();

  router.get('/active', (_req, res) => {
    res.json(getRunningSessions());
  });

  router.post('/:taskId/confirm', async (req, res) => {
    const { taskId } = req.params;
    const task = getTask(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status !== 'pending_confirm') return res.status(409).json({ error: 'already confirmed' });
    task.status = 'running';
    console.log(`${tag(taskId)} confirmed — starting session for chat ${task.chatId}`);
    try {
      await sendToDaemon({
        cmd: 'neuro_start',
        taskId: task.taskId,
        chatId: task.chatId,
        prompt: task.prompt,
        contextPreamble: task.contextPreamble || '',
        channel: task.channel,
        elfieSystemPrompt: task.elfieSystemPrompt || '',
      });
      res.json({ ok: true });
    } catch (err) {
      task.status = 'pending_confirm';
      res.status(503).json({ error: `daemon unreachable: ${err.message}` });
    }
  });

  router.get('/session/:chatId/stream', (req, res) => {
    const { chatId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const session = getOrCreateSession(chatId);
    setSessionSseRes(chatId, res);

    for (const ev of session.events.slice(-100)) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch {}
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (session.sseRes === res) session.sseRes = null;
    });
  });

  router.post('/session/:chatId/event', async (req, res) => {
    const { chatId } = req.params;
    const ev = req.body;
    const preview = ev.text ? ` "${ev.text.slice(0, 60)}${ev.text.length > 60 ? '…' : ''}"` : '';
    console.log(`${tag(chatId)} session event: ${ev.type}${preview}`);

    const session = getSession(chatId);

    if (ev.type === 'neuro_text' && ev.text?.trim() && session?.channel === 'voice') {
      speakNeuroText(ev.text.trim(), session.voiceId).catch((err) =>
        console.error(`${tag(chatId)} TTS error: ${err.message}`),
      );
    }

    if (ev.type === 'neuro_done' || ev.type === 'neuro_waiting' || ev.type === 'neuro_interrupted') {
      setSessionStatus(chatId, 'waiting');
    }
    if (ev.type === 'neuro_session_ended') {
      setSessionStatus(chatId, 'ended');
    }

    if (ev.type === 'neuro_text' && ev.text?.trim()) {
      try {
        const chat = await Chat.findById(chatId);
        if (chat) {
          chat.messages.push({ role: 'assistant', content: ev.text.trim() });
          await chat.save();
        }
      } catch (err) {
        console.error(`${tag(chatId)} failed to save neuro_text: ${err.message}`);
      }
    }


    pushSessionEvent(chatId, ev);
    res.json({ ok: true });
  });

  router.post('/session/:chatId/send', async (req, res) => {
    const { chatId } = req.params;
    const { message } = req.body ?? {};
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    console.log(`${tag(chatId)} sending to session: "${message.slice(0, 60)}"`);
    try {
      await sendToDaemon({ cmd: 'neuro_send', chatId, message: message.trim() });
      pushSessionEvent(chatId, { type: 'neuro_user_message', text: message.trim() });
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ error: `daemon unreachable: ${err.message}` });
    }
  });

  router.post('/session/:chatId/interrupt', async (req, res) => {
    const { chatId } = req.params;
    console.log(`${tag(chatId)} interrupt requested`);
    try {
      await sendToDaemon({ cmd: 'neuro_interrupt', chatId });
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ error: `daemon unreachable: ${err.message}` });
    }
  });

  router.delete('/session/:chatId', async (req, res) => {
    const { chatId } = req.params;
    console.log(`${tag(chatId)} kill session requested`);
    try {
      await sendToDaemon({ cmd: 'neuro_kill', chatId });
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ error: `daemon unreachable: ${err.message}` });
    }
  });

  router.get('/session/:chatId/history', (req, res) => {
    res.json(getSessionHistory(req.params.chatId));
  });

  router.post('/session/:chatId/answer', (req, res) => {
    const { chatId } = req.params;
    const { answer } = req.body ?? {};
    if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
    sendToDaemon({ cmd: 'neuro_send', chatId, message: answer.trim() })
      .then(() => {
        pushSessionEvent(chatId, { type: 'neuro_user_message', text: answer.trim() });
        res.json({ ok: true });
      })
      .catch((err) => res.status(503).json({ error: err.message }));
  });

  router.post('/:taskId/answer', (req, res) => {
    const { taskId } = req.params;
    const { answer } = req.body ?? {};
    if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
    const task = getTask(taskId);
    if (task?.chatId) submitSessionAnswer(task.chatId, answer.trim());
    res.json({ ok: true });
  });

  router.get('/:taskId/pending-answer', async (req, res) => {
    const { taskId } = req.params;
    const task = getTask(taskId);
    if (!task?.chatId) return res.status(404).json({ error: 'task not found' });
    const answer = await waitForSessionAnswer(task.chatId, 60_000);
    if (answer === null) return res.status(408).json({ error: 'timeout' });
    res.json({ answer });
  });

  app.use('/api/neuro', router);
};
