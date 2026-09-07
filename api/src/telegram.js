import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import Chat from './models/Chat.js';
import Settings from './models/Settings.js';
import {
  loadActiveChar, runAgentTurn, registerActiveStream, unregisterActiveStream, generateVoiceNote,
} from './controllers/chats.controller.js';
import { getSTTProvider } from './voice.js';
import { transcribeElevenLabs, transcribeFishAudio } from './routes/transcribe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', 'uploads');

const TELEGRAM_TEXT_LIMIT = 4000;

const VOICE_STYLE_HINT =
  '[O usuário mandou uma mensagem de voz e vai receber sua resposta como áudio também — isto está mais para uma ligação de ' +
  'verdade do que um chat de texto. Responda curto e natural, como você falaria em voz alta: frases faladas, sem markdown, ' +
  'sem listas, sem asteriscos, sem emojis decorativos.]';

let _settings = {};
let _pollingToken = null;

export function setTelegramSettings(s) {
  _settings = s ?? {};
  maybeStartPolling();
}

function maybeStartPolling() {
  const token = _settings.telegramBotToken?.trim();
  if (!token || token === _pollingToken) return;
  _pollingToken = token;
  console.log('[telegram] starting long-poll loop');
  pollLoop(token);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tgApi(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

async function tgApiFile(token, method, form) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

async function pollLoop(token) {
  let offset = 0;
  while (_settings.telegramBotToken?.trim() === token) {
    try {
      const updates = await tgApi(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(token, update.message).catch((err) =>
            console.error('[telegram] handleMessage failed:', err.message),
          );
        }
      }
    } catch (err) {
      console.error('[telegram] getUpdates failed, retrying in 5s:', err.message);
      await sleep(5000);
    }
  }
  console.log('[telegram] poll loop exiting (token changed/cleared)');
}

function chunkText(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks;
}

async function sendLocalFile(token, chatId, method, field, filename) {
  const buffer = await readFile(resolve(uploadDir, filename));
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(field, new Blob([buffer]), filename);
  await tgApiFile(token, method, form);
}

async function downloadTelegramFile(token, fileId) {
  const file = await tgApi(token, 'getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = (file.file_path.split('.').pop() || 'jpg').toLowerCase();
  const filename = `${randomBytes(16).toString('hex')}.${ext}`;
  await writeFile(resolve(uploadDir, filename), buffer);
  return filename;
}

async function transcribeTelegramVoice(token, fileId) {
  const file = await tgApi(token, 'getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`voice download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const provider = getSTTProvider();
  const transcribe = provider === 'fishaudio' ? transcribeFishAudio : transcribeElevenLabs;
  return transcribe(buffer, 'pt', 'audio/ogg', 'voice.ogg');
}

export async function sendTelegramMessage(text) {
  const token = _settings.telegramBotToken?.trim();
  const chatId = _settings.telegramOwnerId;
  if (!token || !chatId) throw new Error('Telegram não está configurado (bot token ausente ou nenhum usuário vinculado)');
  for (const chunk of chunkText(text, TELEGRAM_TEXT_LIMIT)) {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: chunk });
  }
}

async function deliverAssistantMessage(token, chatId, m, { respondAsVoice = false, voiceId = '' } = {}) {
  if (m.content?.trim()) {
    if (respondAsVoice) {
      const filename = await generateVoiceNote(m.content.trim(), voiceId);
      if (filename) {
        await sendLocalFile(token, chatId, 'sendVoice', 'voice', filename).catch((err) =>
          console.error('[telegram] sendVoice (reply) failed:', err.message),
        );
      } else {
        await tgApi(token, 'sendMessage', { chat_id: chatId, text: m.content.trim() }).catch(() => {});
      }
    } else {
      for (const chunk of chunkText(m.content.trim(), TELEGRAM_TEXT_LIMIT)) {
        await tgApi(token, 'sendMessage', { chat_id: chatId, text: chunk }).catch((err) =>
          console.error('[telegram] sendMessage failed:', err.message),
        );
      }
    }
  }
  for (const filename of m.imageFilenames ?? []) {
    await sendLocalFile(token, chatId, 'sendPhoto', 'photo', filename).catch((err) =>
      console.error('[telegram] sendPhoto failed:', err.message),
    );
  }
  for (const gif of m.gifs ?? []) {
    const url = gif.mp4 || gif.url;
    if (!url) continue;
    await tgApi(token, 'sendAnimation', { chat_id: chatId, animation: url }).catch((err) =>
      console.error('[telegram] sendAnimation failed:', err.message),
    );
  }
  for (const vn of m.voiceNotes ?? []) {
    await sendLocalFile(token, chatId, 'sendVoice', 'voice', vn.filename).catch((err) =>
      console.error('[telegram] sendVoice failed:', err.message),
    );
  }
}

async function handleMessage(token, message) {
  const senderId = String(message.from?.id ?? '');
  if (!senderId || message.from?.is_bot) return;

  const settingsDoc = await Settings.findOne();
  if (!settingsDoc) return;

  if (!settingsDoc.telegramOwnerId) {
    settingsDoc.telegramOwnerId = senderId;
    await settingsDoc.save();
    console.log(`[telegram] linked to Telegram user ${senderId}`);
  } else if (settingsDoc.telegramOwnerId !== senderId) {
    console.warn(`[telegram] ignoring message from unlinked user ${senderId}`);
    return;
  }

  const chatId = message.chat.id;
  tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  let elfieChat = settingsDoc.telegramChatId ? await Chat.findById(settingsDoc.telegramChatId) : null;
  if (!elfieChat) {
    const { char } = await loadActiveChar();
    elfieChat = await Chat.create({ characterId: char?._id ?? null, title: 'Telegram' });
    settingsDoc.telegramChatId = elfieChat._id;
    await settingsDoc.save();
    console.log(`[telegram] created chat ${elfieChat._id} for this conversation`);
  }

  const imageFilenames = [];
  if (message.photo?.length) {
    try {
      const best = message.photo[message.photo.length - 1];
      imageFilenames.push(await downloadTelegramFile(token, best.file_id));
    } catch (err) {
      console.error('[telegram] photo download failed:', err.message);
    }
  } else if (message.document?.mime_type?.startsWith('image/')) {
    try {
      imageFilenames.push(await downloadTelegramFile(token, message.document.file_id));
    } catch (err) {
      console.error('[telegram] document image download failed:', err.message);
    }
  }

  let respondAsVoice = false;
  let text = message.text || message.caption || '';
  if (!text.trim() && message.voice) {
    try {
      text = await transcribeTelegramVoice(token, message.voice.file_id);
      respondAsVoice = true;
    } catch (err) {
      console.error('[telegram] voice transcription failed:', err.message);
      await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'Não consegui entender o áudio, tenta de novo?' }).catch(() => {});
      return;
    }
  }

  if (!text.trim() && imageFilenames.length === 0) {
    if (message.audio) {
      await tgApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Manda como mensagem de voz (o microfone), não como arquivo de áudio — assim eu consigo ouvir.',
      }).catch(() => {});
    }
    return;
  }

  const isFirstMessage = elfieChat.messages.filter((m) => m.role === 'user').length === 0;
  elfieChat.messages.push({ role: 'user', content: text, imageFilenames });
  await elfieChat.save();

  const { char, settings } = await loadActiveChar();
  const beforeCount = elfieChat.messages.length;
  const ac = new AbortController();
  const chatIdStr = elfieChat._id.toString();
  registerActiveStream(chatIdStr, ac);

  try {
    await runAgentTurn({
      chat: elfieChat, char, settings, text, imageFilenames,
      isFirstMessage, sendEvent: () => {}, signal: ac.signal,
      styleHint: respondAsVoice ? VOICE_STYLE_HINT : '',
    });
  } catch (err) {
    console.error('[telegram] runAgentTurn failed:', err.message);
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'Deu ruim aqui do meu lado, tenta de novo?' }).catch(() => {});
    return;
  } finally {
    unregisterActiveStream(chatIdStr);
  }

  const newMessages = elfieChat.messages.slice(beforeCount);
  for (const m of newMessages) {
    if (m.role !== 'assistant') continue;
    await deliverAssistantMessage(token, chatId, m, { respondAsVoice, voiceId: char?.voiceId || '' });
  }
}
