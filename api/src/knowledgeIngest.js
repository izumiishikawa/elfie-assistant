import { getEmbedding } from './embeddings.js';
import { upsertChunks, deleteChunksForFile, deleteChunksForFolder } from './lancedb.js';
import { getFolderMeta } from './knowledgeBase.js';
import { enrichFile } from './knowledgeEnrich.js';

const MAX_CHUNK_CHARS = 1800;
const OVERLAP_CHARS = 250;

const HEADING_RE = /^(#{1,6})\s+.+$/;

function splitByHeadings(content) {
  const lines = content.split('\n');
  const sections = [];
  let currentHeading = '';
  let currentLines = [];

  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (body) sections.push({ heading: currentHeading, body });
    currentLines = [];
  };

  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      flush();
      currentHeading = line.trim();
    }
    currentLines.push(line);
  }
  flush();

  return sections.length > 0 ? sections : [{ heading: '', body: content.trim() }];
}

function splitBody(body) {
  if (body.length <= MAX_CHUNK_CHARS) return [body];

  const paragraphs = body.split(/\n{2,}/);
  const chunks = [];
  let buffer = '';

  const pushBuffer = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
  };

  for (const para of paragraphs) {
    if (para.length > MAX_CHUNK_CHARS) {
      pushBuffer();
      buffer = '';
      for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS - OVERLAP_CHARS) {
        chunks.push(para.slice(i, i + MAX_CHUNK_CHARS));
      }
      continue;
    }

    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (candidate.length > MAX_CHUNK_CHARS) {
      pushBuffer();
      const overlapTail = buffer.slice(-OVERLAP_CHARS);
      buffer = overlapTail ? `${overlapTail}\n\n${para}` : para;
    } else {
      buffer = candidate;
    }
  }
  pushBuffer();

  return chunks;
}

export function chunkMarkdown(content) {
  const sections = splitByHeadings(content);
  const chunks = [];
  for (const { heading, body } of sections) {
    const bodyWithoutHeadingLine = heading ? body.replace(heading, '').trim() : body;
    if (!bodyWithoutHeadingLine) continue;
    for (const piece of splitBody(bodyWithoutHeadingLine)) {
      chunks.push(heading ? `${heading}\n\n${piece}` : piece);
    }
  }
  return chunks;
}

const ingestStatus = new Map();
const statusKey = (folder, file) => `${folder}/${file}`;

export function getIngestStatus(folder, file) {
  return ingestStatus.get(statusKey(folder, file)) ?? null;
}

function setStatus(folder, file, status, extra = {}) {
  ingestStatus.set(statusKey(folder, file), { status, updatedAt: new Date(), ...extra });
}

export async function ingestFile(folder, file, content) {
  setStatus(folder, file, 'queued');
  try {
    await deleteChunksForFile(folder, file);

    const texts = chunkMarkdown(content);
    if (texts.length === 0) {
      setStatus(folder, file, 'done');
      return;
    }

    setStatus(folder, file, 'enriching');
    const folderMeta = await getFolderMeta(folder);
    const enriched = await enrichFile(folder, file, texts, { name: folder, description: folderMeta.description });

    setStatus(folder, file, 'embedding');
    const mtime = Date.now();
    const rows = [];
    for (let i = 0; i < texts.length; i++) {
      const { contextPrefix, tags, entityNames } = enriched[i];
      const embedText = contextPrefix ? `${contextPrefix}\n\n${texts[i]}` : texts[i];
      const embedding = await getEmbedding(embedText);
      if (!embedding) {
        console.warn(`[knowledgeIngest] embedding falhou para ${folder}/${file}#${i}, pulando chunk`);
        continue;
      }
      rows.push({
        id: `${folder}/${file}#${i}`,
        text: texts[i],
        contextPrefix,
        folder,
        file,
        tags,
        entityNames,
        mtime,
        vector: embedding,
      });
    }

    await upsertChunks(rows);
    setStatus(folder, file, 'done');
  } catch (err) {
    console.error(`[knowledgeIngest] falha ao indexar ${folder}/${file}:`, err.message);
    setStatus(folder, file, 'error', { error: err.message });
  }
}

export async function deleteFileChunks(folder, file) {
  await deleteChunksForFile(folder, file);
  ingestStatus.delete(statusKey(folder, file));
}

export async function deleteFolderChunks(folder) {
  await deleteChunksForFolder(folder);
  for (const key of ingestStatus.keys()) {
    if (key.startsWith(`${folder}/`)) ingestStatus.delete(key);
  }
}

export function renameFileStatus(oldFolder, oldFile, newFolder, newFile) {
  const oldKey = statusKey(oldFolder, oldFile);
  const entry = ingestStatus.get(oldKey);
  if (!entry) return;
  ingestStatus.delete(oldKey);
  ingestStatus.set(statusKey(newFolder, newFile), entry);
}

export function renameFolderStatus(oldFolder, newFolder) {
  const prefix = `${oldFolder}/`;
  for (const key of [...ingestStatus.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const entry = ingestStatus.get(key);
    ingestStatus.delete(key);
    ingestStatus.set(`${newFolder}/${key.slice(prefix.length)}`, entry);
  }
}
