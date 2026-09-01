import { connect } from '@lancedb/lancedb';
import { Index, rerankers } from '@lancedb/lancedb';
import { Schema, Field, Utf8, List, FixedSizeList, Float32, Float64 } from 'apache-arrow';
import { join } from 'path';
import { homedir } from 'os';

export const LANCEDB_DIR = join(homedir(), '.elfie', 'lancedb');

const EMBEDDING_DIM = 1536;

function chunksSchema() {
  const strList = (name) => new Field(name, new List(new Field('item', new Utf8())), false);
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('contextPrefix', new Utf8(), false),
    new Field('folder', new Utf8(), false),
    new Field('file', new Utf8(), false),
    strList('tags'),
    strList('entityNames'),
    new Field('mtime', new Float64(), false),
    new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32())), false),
  ]);
}

let _dbPromise = null;
async function getDb() {
  if (!_dbPromise) _dbPromise = connect(LANCEDB_DIR);
  return _dbPromise;
}

let _tablePromise = null;
export async function getChunksTableForMaintenance() {
  return getChunksTable();
}
async function getChunksTable() {
  if (_tablePromise) return _tablePromise;
  _tablePromise = (async () => {
    const db = await getDb();
    const names = await db.tableNames();
    let table;
    if (names.includes('chunks')) {
      table = await db.openTable('chunks');
    } else {
      table = await db.createEmptyTable('chunks', chunksSchema());
    }
    await table.createIndex('text', { config: Index.fts() });
    return table;
  })();
  return _tablePromise;
}

function escapeSqlString(s) {
  return String(s).replace(/'/g, "''");
}

function chatChunksSchema() {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('contextPrefix', new Utf8(), false),
    new Field('chatId', new Utf8(), false),
    new Field('chatTitle', new Utf8(), false),
    new Field('startAt', new Float64(), false),
    new Field('endAt', new Float64(), false),
    new Field('mtime', new Float64(), false),
    new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32())), false),
  ]);
}

let _chatTablePromise = null;
async function getChatChunksTable() {
  if (_chatTablePromise) return _chatTablePromise;
  _chatTablePromise = (async () => {
    const db = await getDb();
    const names = await db.tableNames();
    let table;
    if (names.includes('chat_chunks')) {
      table = await db.openTable('chat_chunks');
    } else {
      table = await db.createEmptyTable('chat_chunks', chatChunksSchema());
    }
    await table.createIndex('text', { config: Index.fts() });
    return table;
  })();
  return _chatTablePromise;
}

export async function upsertChatChunks(rows) {
  if (!rows?.length) return;
  const table = await getChatChunksTable();
  await table.add(rows);
}

export async function deleteChatChunksForChat(chatId) {
  const table = await getChatChunksTable();
  await table.delete(`chatId = '${escapeSqlString(chatId)}'`);
}

function rowToChatChunk(r) {
  return {
    id: r.id,
    text: r.text,
    contextPrefix: r.contextPrefix,
    chatId: r.chatId,
    chatTitle: r.chatTitle,
    startAt: r.startAt,
    endAt: r.endAt,
  };
}

export async function searchChatChunks({ queryText, queryEmbedding, topK = 30 }) {
  const table = await getChatChunksTable();
  const count = await table.countRows();
  if (count === 0) return [];

  let query = table.query();
  if (queryText?.trim()) query = query.fullTextSearch(queryText.trim());
  if (queryEmbedding) query = query.nearestTo(queryEmbedding);

  if (queryText?.trim() && queryEmbedding) {
    const rrf = await rerankers.RRFReranker.create();
    query = query.rerank(rrf);
  }

  const rows = await query.limit(topK).toArray();
  return rows.map(rowToChatChunk);
}

export async function upsertChunks(rows) {
  if (!rows?.length) return;
  const table = await getChunksTable();
  await table.add(rows);
}

export async function deleteChunksForFile(folder, file) {
  const table = await getChunksTable();
  await table.delete(`folder = '${escapeSqlString(folder)}' AND file = '${escapeSqlString(file)}'`);
}

export async function deleteChunksForFolder(folder) {
  const table = await getChunksTable();
  await table.delete(`folder = '${escapeSqlString(folder)}'`);
}

export async function renameChunksFile(oldFolder, oldFile, newFolder, newFile) {
  const table = await getChunksTable();
  await table.update({
    where: `folder = '${escapeSqlString(oldFolder)}' AND file = '${escapeSqlString(oldFile)}'`,
    values: { folder: newFolder, file: newFile },
  });
}

export async function renameChunksFolder(oldFolder, newFolder) {
  const table = await getChunksTable();
  await table.update({
    where: `folder = '${escapeSqlString(oldFolder)}'`,
    values: { folder: newFolder },
  });
}

export async function searchChunks({ queryText, queryEmbedding, topK = 30 }) {
  const table = await getChunksTable();
  const count = await table.countRows();
  if (count === 0) return [];

  let query = table.query();
  if (queryText?.trim()) query = query.fullTextSearch(queryText.trim());
  if (queryEmbedding) query = query.nearestTo(queryEmbedding);

  if (queryText?.trim() && queryEmbedding) {
    const rrf = await rerankers.RRFReranker.create();
    query = query.rerank(rrf);
  }

  const rows = await query.limit(topK).toArray();
  return rows.map(rowToChunk);
}

export function toPlainArray(v) {
  if (Array.isArray(v)) return v;
  return v ? Array.from(v) : [];
}

function rowToChunk(r) {
  return {
    id: r.id,
    text: r.text,
    contextPrefix: r.contextPrefix,
    folder: r.folder,
    file: r.file,
    tags: toPlainArray(r.tags),
    entityNames: toPlainArray(r.entityNames),
  };
}

export async function getChunksByIds(ids) {
  if (!ids?.length) return [];
  const table = await getChunksTable();
  const inList = ids.map((id) => `'${escapeSqlString(id)}'`).join(', ');
  const rows = await table.query().where(`id IN (${inList})`).toArray();
  return rows.map(rowToChunk);
}
