import { readdir, readFile, writeFile, mkdir, rm, rename, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { homedir } from "os";

export const KNOWLEDGE_DIR = join(homedir(), ".elfie", "knowledge");

const MAX_FILE_CHARS = 16000;
const KNOWLEDGE_FILE_RE = /\.(txt|md)$/i;

async function readFolderMeta(folderPath) {
  try {
    const raw = await readFile(join(folderPath, "_meta.json"), "utf-8");
    const meta = JSON.parse(raw);
    return {
      description: typeof meta.description === "string" ? meta.description : "",
      tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === "string") : [],
    };
  } catch {
    return { description: "", tags: [] };
  }
}

export async function getFolderMeta(folderName) {
  return readFolderMeta(join(KNOWLEDGE_DIR, folderName));
}

export async function readKnowledgeFile(folderName, fileName) {
  const folderPath = resolve(KNOWLEDGE_DIR, folderName);
  const filePath = resolve(folderPath, fileName);
  const withinBase = (p) => p === KNOWLEDGE_DIR || p.startsWith(KNOWLEDGE_DIR + sep);
  if (!withinBase(folderPath) || !withinBase(filePath) || !KNOWLEDGE_FILE_RE.test(filePath)) return null;
  try {
    const content = await readFile(filePath, "utf-8");
    return content.length > MAX_FILE_CHARS
      ? `${content.slice(0, MAX_FILE_CHARS)}\n\n[...conteúdo truncado, arquivo maior que o limite]`
      : content;
  } catch {
    return null;
  }
}


const SAFE_NAME_RE = /^[^/\\]+$/;

function isSafeName(name) {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".") &&
    SAFE_NAME_RE.test(name)
  );
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function resolveWithin(...parts) {
  const p = resolve(KNOWLEDGE_DIR, ...parts);
  if (p !== KNOWLEDGE_DIR && !p.startsWith(KNOWLEDGE_DIR + sep)) throw httpError("Caminho inválido.", 400);
  return p;
}

export async function listAllFolders() {
  let entries;
  try {
    entries = await readdir(KNOWLEDGE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = join(KNOWLEDGE_DIR, entry.name);
    const [meta, files] = await Promise.all([
      readFolderMeta(folderPath),
      readdir(folderPath).then((names) => names.filter((n) => KNOWLEDGE_FILE_RE.test(n))).catch(() => []),
    ]);
    folders.push({ name: entry.name, description: meta.description, tags: meta.tags, files });
  }
  return folders;
}

async function writeFolderMeta(folderPath, description, tags) {
  await writeFile(
    join(folderPath, "_meta.json"),
    JSON.stringify({ description: description ?? "", tags: Array.isArray(tags) ? tags : [] }, null, 2),
    "utf-8",
  );
}

export async function createFolder(name, description, tags) {
  const trimmed = (name ?? "").trim();
  if (!isSafeName(trimmed)) throw httpError('Nome de pasta inválido — não pode ter "/" nem começar com ".".', 400);
  const folderPath = resolveWithin(trimmed);
  try {
    await stat(folderPath);
    throw httpError("Já existe uma pasta com esse nome.", 409);
  } catch (err) {
    if (err.status) throw err;
  }
  await mkdir(folderPath, { recursive: true });
  await writeFolderMeta(folderPath, description, tags);
  return { name: trimmed, description: description ?? "", tags: Array.isArray(tags) ? tags : [], files: [] };
}

export async function updateFolder(name, description, tags) {
  const trimmed = (name ?? "").trim();
  if (!isSafeName(trimmed)) throw httpError("Nome de pasta inválido.", 400);
  const folderPath = resolveWithin(trimmed);
  try {
    await stat(folderPath);
  } catch {
    throw httpError("Pasta não encontrada.", 404);
  }
  await writeFolderMeta(folderPath, description, tags);
}

export async function deleteFolder(name) {
  const trimmed = (name ?? "").trim();
  if (!isSafeName(trimmed)) throw httpError("Nome de pasta inválido.", 400);
  const folderPath = resolveWithin(trimmed);
  await rm(folderPath, { recursive: true, force: true });
}

export async function writeKnowledgeFile(folderName, fileName, content) {
  const trimmedFolder = (folderName ?? "").trim();
  const trimmedFile = (fileName ?? "").trim();
  if (!isSafeName(trimmedFolder) || !isSafeName(trimmedFile) || !KNOWLEDGE_FILE_RE.test(trimmedFile)) {
    throw httpError("Nome de pasta/arquivo inválido — o arquivo precisa terminar em .txt ou .md.", 400);
  }
  const folderPath = resolveWithin(trimmedFolder);
  const filePath = resolveWithin(trimmedFolder, trimmedFile);
  try {
    await stat(folderPath);
  } catch {
    throw httpError("Pasta não encontrada.", 404);
  }
  await writeFile(filePath, content ?? "", "utf-8");
}

export async function deleteKnowledgeFile(folderName, fileName) {
  const trimmedFolder = (folderName ?? "").trim();
  const trimmedFile = (fileName ?? "").trim();
  if (!isSafeName(trimmedFolder) || !isSafeName(trimmedFile)) throw httpError("Nome de pasta/arquivo inválido.", 400);
  const filePath = resolveWithin(trimmedFolder, trimmedFile);
  await rm(filePath, { force: true });
}

export async function moveKnowledgeFile(fromFolder, fromFile, toFolder, toFile) {
  const trimmedFromFolder = (fromFolder ?? "").trim();
  const trimmedFromFile = (fromFile ?? "").trim();
  const trimmedToFolder = (toFolder || fromFolder || "").trim();
  const trimmedToFile = (toFile || fromFile || "").trim();
  if (
    !isSafeName(trimmedFromFolder) || !isSafeName(trimmedFromFile)
    || !isSafeName(trimmedToFolder) || !isSafeName(trimmedToFile)
    || !KNOWLEDGE_FILE_RE.test(trimmedToFile)
  ) {
    throw httpError("Nome de pasta/arquivo inválido — o arquivo de destino precisa terminar em .txt ou .md.", 400);
  }
  const fromPath = resolveWithin(trimmedFromFolder, trimmedFromFile);
  const toFolderPath = resolveWithin(trimmedToFolder);
  const toPath = resolveWithin(trimmedToFolder, trimmedToFile);
  try {
    await stat(fromPath);
  } catch {
    throw httpError("Arquivo de origem não encontrado.", 404);
  }
  try {
    await stat(toFolderPath);
  } catch {
    throw httpError("Pasta de destino não encontrada.", 404);
  }
  await rename(fromPath, toPath);
  return { folder: trimmedToFolder, file: trimmedToFile };
}

export async function renameKnowledgeFolder(oldName, newName) {
  const trimmedOld = (oldName ?? "").trim();
  const trimmedNew = (newName ?? "").trim();
  if (!isSafeName(trimmedOld) || !isSafeName(trimmedNew)) throw httpError("Nome de pasta inválido.", 400);
  const oldPath = resolveWithin(trimmedOld);
  const newPath = resolveWithin(trimmedNew);
  try {
    await stat(oldPath);
  } catch {
    throw httpError("Pasta não encontrada.", 404);
  }
  try {
    await stat(newPath);
    throw httpError("Já existe uma pasta com esse nome.", 409);
  } catch (err) {
    if (err.status) throw err;
  }
  await rename(oldPath, newPath);
  return { name: trimmedNew };
}
