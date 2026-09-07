import { createReadStream, createWriteStream } from 'fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import multer from 'multer';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';
import { KNOWLEDGE_DIR } from '../knowledgeBase.js';
import { setLLMSettings } from '../llm.js';
import { setVoiceSettings } from '../voice.js';
import { setGoogleAuthSettings } from '../googleAuth.js';
import { setTelegramSettings } from '../telegram.js';
import { setPixaiSettings } from '../pixai.js';
import Settings from '../models/Settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', '..', 'uploads');
const snapshotDir = join(process.env.HOME ?? tmpdir(), '.elfie', 'backups');

const BACKUP_FORMAT = 'elfie.backup';
const BACKUP_VERSION = 1;
const INSERT_CHUNK = 500;
const MAX_SNAPSHOTS = 5;

// Coleções derivadas: dá pra reconstruir a partir do resto, então ficam de fora do backup
// pra não inflar o arquivo. O índice vetorial (~/.elfie/lancedb) também não vai — depois
// de importar é só rodar o reindex da base de conhecimento.
const SKIP_COLLECTIONS = new Set(['workflowruns']);


/* ------------------------------------------------------------------ helpers */

async function walkFiles(dir, base = dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }

  const out = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
    } else if (entry.isFile()) {
      const info = await stat(abs);
      out.push({ abs, rel: relative(base, abs).split(sep).join('/'), size: info.size, mtime: info.mtime });
    }
  }
  return out;
}

function packBuffer(pack, name, buf) {
  return new Promise((res, rej) => {
    pack.entry({ name, size: buf.length }, buf, (err) => (err ? rej(err) : res()));
  });
}

function packFile(pack, name, file) {
  return new Promise((res, rej) => {
    const entry = pack.entry({ name, size: file.size, mtime: file.mtime }, (err) => (err ? rej(err) : res()));
    const source = createReadStream(file.abs);
    source.on('error', rej);
    source.pipe(entry);
  });
}

async function listBackupCollections() {
  const all = await mongoose.connection.db.listCollections().toArray();
  return all
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.') && !SKIP_COLLECTIONS.has(name))
    .sort();
}

// Impede que um .tar.gz montado à mão escreva fora do diretório de destino.
function safeJoin(base, name) {
  const target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw Object.assign(new Error(`Unsafe path in archive: ${name}`), { status: 400 });
  }
  return target;
}

async function extractArchive(archivePath, destDir) {
  // Um erro em uma entrada não pode derrubar o stream no meio do caminho: guarda o
  // primeiro problema, drena o resto do arquivo e só então estoura.
  let failure = null;
  const fail = (err) => { failure ??= err; };

  const extractor = tarExtract();
  extractor.on('entry', (header, stream, next) => {
    stream.on('error', fail);
    const skip = () => { stream.resume(); stream.on('end', () => next()); };

    if (header.type !== 'file') return skip();

    let target;
    try { target = safeJoin(destDir, header.name); }
    catch (err) { fail(err); return skip(); }

    mkdir(dirname(target), { recursive: true })
      .then(() => pipeline(stream, createWriteStream(target)))
      .then(() => next())
      .catch((err) => { fail(err); next(); });
  });

  try {
    await pipeline(createReadStream(archivePath), createGunzip(), extractor);
  } catch (err) {
    fail(err);
  }
  if (failure) throw failure;
}

async function copyTree(fromDir, toDir) {
  const files = await walkFiles(fromDir);
  for (const file of files) {
    const target = safeJoin(toDir, file.rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.abs, target);
  }
  return files.length;
}

// Dump só do banco, guardado localmente antes de um restore destruir o estado atual.
async function snapshotDatabase() {
  await mkdir(snapshotDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(snapshotDir, `pre-restore-${stamp}.tar.gz`);

  const pack = tarPack();
  const flushed = pipeline(pack, createGzip(), createWriteStream(target));

  await packBuffer(pack, 'manifest.json', Buffer.from(JSON.stringify({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    contents: { database: true, uploads: false, knowledge: false },
    note: 'Automatic snapshot taken right before a restore. Database only.',
  }, null, 2)));

  for (const name of await listBackupCollections()) {
    const docs = await mongoose.connection.db.collection(name).find({}).toArray();
    await packBuffer(pack, `db/${name}.json`, Buffer.from(EJSON.stringify(docs, undefined, 2, { relaxed: true })));
  }

  pack.finalize();
  await flushed;

  // Mantém só os snapshots mais recentes pra pasta não crescer sem limite.
  const kept = (await readdir(snapshotDir))
    .filter((f) => f.startsWith('pre-restore-') && f.endsWith('.tar.gz'))
    .sort()
    .reverse();
  for (const stale of kept.slice(MAX_SNAPSHOTS)) {
    await rm(join(snapshotDir, stale), { force: true }).catch(() => {});
  }

  return target;
}


/* --------------------------------------------------------------------- info */

const sumBytes = (files) => files.reduce((total, f) => total + f.size, 0);

export async function backupInfo(_req, res) {
  try {
    const names = await listBackupCollections();
    const collections = await Promise.all(names.map(async (name) => ({
      name,
      count: await mongoose.connection.db.collection(name).countDocuments(),
    })));

    const [uploadFiles, knowledgeFiles] = await Promise.all([
      walkFiles(uploadDir),
      walkFiles(KNOWLEDGE_DIR),
    ]);

    let snapshots = [];
    try {
      const entries = await readdir(snapshotDir);
      snapshots = await Promise.all(entries
        .filter((f) => f.startsWith('pre-restore-') && f.endsWith('.tar.gz'))
        .sort().reverse()
        .map(async (f) => ({ name: f, path: join(snapshotDir, f), bytes: (await stat(join(snapshotDir, f))).size })));
    } catch { /* nenhum snapshot ainda */ }

    res.json({
      collections,
      documents: collections.reduce((total, c) => total + c.count, 0),
      uploads: { files: uploadFiles.length, bytes: sumBytes(uploadFiles) },
      knowledge: { files: knowledgeFiles.length, bytes: sumBytes(knowledgeFiles) },
      snapshotDir,
      snapshots,
    });
  } catch (err) {
    console.error('[backupInfo]', err);
    res.status(500).json({ error: 'Failed to read backup info' });
  }
}


/* ------------------------------------------------------------------- export */

export async function exportBackup(req, res) {
  const includeUploads = req.query.uploads !== '0';
  const includeKnowledge = req.query.knowledge !== '0';

  try {
    const uploadFiles = includeUploads ? await walkFiles(uploadDir) : [];
    const knowledgeFiles = includeKnowledge ? await walkFiles(KNOWLEDGE_DIR) : [];
    const collections = await listBackupCollections();

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="elfie-backup-${stamp}.tar.gz"`);

    const pack = tarPack();
    const flushed = pipeline(pack, createGzip(), res);

    await packBuffer(pack, 'manifest.json', Buffer.from(JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      contents: {
        database: true,
        uploads: includeUploads,
        knowledge: includeKnowledge,
      },
      counts: {
        collections: collections.length,
        uploadFiles: uploadFiles.length,
        knowledgeFiles: knowledgeFiles.length,
      },
      excluded: [
        'workflowruns (execution history)',
        '~/.elfie/lancedb (vector index — rebuild it with Knowledge → Reindex)',
      ],
    }, null, 2)));

    for (const name of collections) {
      const docs = await mongoose.connection.db.collection(name).find({}).toArray();
      await packBuffer(pack, `db/${name}.json`, Buffer.from(EJSON.stringify(docs, undefined, 2, { relaxed: true })));
    }

    for (const file of uploadFiles) {
      if (res.destroyed) break;
      await packFile(pack, `uploads/${file.rel}`, file);
    }
    for (const file of knowledgeFiles) {
      if (res.destroyed) break;
      await packFile(pack, `knowledge/${file.rel}`, file);
    }

    pack.finalize();
    await flushed;
  } catch (err) {
    console.error('[exportBackup]', err);
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: 'Failed to export backup' });
  }
}


/* ------------------------------------------------------------------- import */

export const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => mkdir(join(tmpdir(), 'elfie-restore'), { recursive: true })
      .then(() => cb(null, join(tmpdir(), 'elfie-restore')))
      .catch(cb),
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}.tar.gz`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },
}).single('backup');

export async function importBackup(req, res) {
  const archivePath = req.file?.path;
  let workDir = null;

  const cleanup = async () => {
    if (archivePath) await rm(archivePath, { force: true }).catch(() => {});
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    if (!archivePath) return res.status(400).json({ error: 'No backup file received' });
    if (req.body?.confirm !== 'REPLACE') {
      return res.status(400).json({ error: 'Restore not confirmed' });
    }

    workDir = await mkdtemp(join(tmpdir(), 'elfie-restore-'));
    try {
      await extractArchive(archivePath, workDir);
    } catch (err) {
      if (err.status === 400) throw err;
      throw Object.assign(new Error('Could not read the backup file — is it an elfie .tar.gz backup?'), { status: 400 });
    }

    let manifest;
    try { manifest = JSON.parse(await readFile(join(workDir, 'manifest.json'), 'utf-8')); }
    catch { throw Object.assign(new Error('This file is not an elfie backup (no manifest.json)'), { status: 400 }); }

    if (manifest.format !== BACKUP_FORMAT) {
      throw Object.assign(new Error('This file is not an elfie backup'), { status: 400 });
    }
    if (Number(manifest.version) > BACKUP_VERSION) {
      throw Object.assign(new Error('This backup was created by a newer version of elfie'), { status: 400 });
    }

    const snapshot = await snapshotDatabase();

    // banco
    const restored = {};
    let dbFiles = [];
    try { dbFiles = (await readdir(join(workDir, 'db'))).filter((f) => f.endsWith('.json')); } catch { /* sem db/ */ }

    for (const fileName of dbFiles) {
      const name = fileName.slice(0, -'.json'.length);
      if (SKIP_COLLECTIONS.has(name)) continue;
      const docs = EJSON.parse(await readFile(join(workDir, 'db', fileName), 'utf-8'));
      if (!Array.isArray(docs)) continue;

      const collection = mongoose.connection.db.collection(name);
      await collection.deleteMany({});
      for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
        const chunk = docs.slice(i, i + INSERT_CHUNK);
        if (chunk.length) await collection.insertMany(chunk, { ordered: false });
      }
      restored[name] = docs.length;
    }

    // arquivos
    const uploadsRestored = await copyTree(join(workDir, 'uploads'), uploadDir);
    const knowledgeRestored = await copyTree(join(workDir, 'knowledge'), KNOWLEDGE_DIR);

    // configurações que ficam em memória precisam reler o que acabou de entrar no banco
    const settings = await Settings.findOne().lean();
    if (settings) {
      setLLMSettings(settings);
      setVoiceSettings(settings);
      setGoogleAuthSettings(settings);
      setTelegramSettings(settings);
      setPixaiSettings(settings);
    }

    res.json({
      ok: true,
      restored,
      uploadFiles: uploadsRestored,
      knowledgeFiles: knowledgeRestored,
      needsReindex: knowledgeRestored > 0,
      snapshot,
      exportedAt: manifest.exportedAt ?? null,
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[importBackup]', err);
    res.status(500).json({ error: 'Failed to import backup' });
  } finally {
    await cleanup();
  }
}
