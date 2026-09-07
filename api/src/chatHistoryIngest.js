import Chat from './models/Chat.js';
import { getEmbedding } from './embeddings.js';
import { upsertChatChunks, deleteChatChunksForChat } from './lancedb.js';

const MAX_CHUNK_CHARS = 1800;

const STALE_MS = 2 * 60 * 1000;
const MAX_CANDIDATES_PER_TICK = 50;

const inProgress = new Set();

function messageText(m) {
  const text = (m.content ?? '').trim();
  if (text) return text;
  if (m.imageFilenames?.length) return '[imagem enviada]';
  if (m.voiceNotes?.length) return '[nota de voz]';
  return '';
}

function formatDate(d) {
  return new Date(d ?? Date.now()).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function chunkMessages(pendingMessages, baseIndex, flushTrailing) {
  const pieces = [];
  let bufferLines = [];
  let bufferStart = null;
  let bufferChars = 0;

  const flushBuffer = (endIdx) => {
    if (bufferLines.length === 0) return;
    pieces.push({ text: bufferLines.join('\n\n'), startAt: bufferStart, endAt: endIdx });
    bufferLines = [];
    bufferStart = null;
    bufferChars = 0;
  };

  pendingMessages.forEach((m, i) => {
    const idx = baseIndex + i;
    const text = messageText(m);
    if (!text) return;
    // O prompt de uma rotina/automação NÃO foi o usuário que escreveu. Indexá-lo
    // como "Usuário:" planta uma lembrança falsa: numa busca no histórico o modelo
    // encontra o Izumi "pedindo" coisas que na verdade são o gatilho agendado.
    // Mesma mentira que ele apontou na interface, só que na camada de memória.
    // Rotular em vez de descartar mantém o antecedente da resposta dela no chunk.
    const speaker =
      m.role === 'user'
        ? (m.triggeredByRoutine || m.triggeredByWorkflow ? 'Gatilho automático' : 'Usuário')
        : 'Elfie';
    const line = `${speaker}: ${text}`;

    if (line.length > MAX_CHUNK_CHARS) {
      flushBuffer(idx - 1);
      for (let c = 0; c < line.length; c += MAX_CHUNK_CHARS) {
        pieces.push({ text: line.slice(c, c + MAX_CHUNK_CHARS), startAt: idx, endAt: idx });
      }
      return;
    }

    if (bufferChars + line.length > MAX_CHUNK_CHARS) flushBuffer(idx - 1);
    if (bufferStart === null) bufferStart = idx;
    bufferLines.push(line);
    bufferChars += line.length + 2;
  });

  if (flushTrailing) {
    flushBuffer(baseIndex + pendingMessages.length - 1);
    return { pieces, nextIndex: baseIndex + pendingMessages.length };
  }
  return { pieces, nextIndex: bufferStart !== null ? bufferStart : baseIndex + pendingMessages.length };
}

export async function ingestChatTail(chatId, { force = false } = {}) {
  const key = String(chatId);
  if (inProgress.has(key)) return;
  inProgress.add(key);
  try {
    const chat = await Chat.findById(chatId).select('title messages lastIngestedIndex').lean();
    if (!chat) return;

    const baseIndex = chat.lastIngestedIndex ?? 0;
    const pendingMessages = chat.messages.slice(baseIndex);
    if (pendingMessages.length === 0) return;

    const { pieces, nextIndex } = chunkMessages(pendingMessages, baseIndex, force);
    if (pieces.length === 0) return;

    const title = chat.title || 'Conversa sem título';
    const mtime = Date.now();
    const rows = [];
    for (const piece of pieces) {
      const contextPrefix = `Conversa "${title}" — ${formatDate(chat.messages[piece.startAt]?.createdAt)}`;
      const embedding = await getEmbedding(`${contextPrefix}\n\n${piece.text}`);
      if (!embedding) {
        console.warn(`[chatHistoryIngest] embedding falhou para chat ${key}#${piece.startAt}-${piece.endAt}, pulando chunk`);
        continue;
      }
      rows.push({
        id: `${key}#${piece.startAt}-${piece.endAt}`,
        text: piece.text,
        contextPrefix,
        chatId: key,
        chatTitle: title,
        startAt: piece.startAt,
        endAt: piece.endAt,
        mtime,
        vector: embedding,
      });
    }

    if (rows.length > 0) await upsertChatChunks(rows);
    await Chat.updateOne({ _id: chatId }, { $set: { lastIngestedIndex: nextIndex } });
  } catch (err) {
    console.error(`[chatHistoryIngest] falha ao indexar chat ${chatId}:`, err.message);
  } finally {
    inProgress.delete(key);
  }
}

export async function deleteChatHistoryChunks(chatId) {
  await deleteChatChunksForChat(String(chatId));
}

export async function runChatHistoryFlushCheck() {
  const cutoff = new Date(Date.now() - STALE_MS);
  const candidates = await Chat.find({
    updatedAt: { $lt: cutoff },
    $expr: { $gt: [{ $size: '$messages' }, { $ifNull: ['$lastIngestedIndex', 0] }] },
  })
    .select('_id')
    .limit(MAX_CANDIDATES_PER_TICK)
    .lean();

  for (const c of candidates) await ingestChatTail(c._id, { force: true });
}
