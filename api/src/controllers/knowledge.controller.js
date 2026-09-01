import {
  listAllFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  readKnowledgeFile,
  writeKnowledgeFile,
  deleteKnowledgeFile,
} from "../knowledgeBase.js";
import { ingestFile, deleteFileChunks, deleteFolderChunks, getIngestStatus } from "../knowledgeIngest.js";
import { searchKnowledgeBase } from "../knowledgeSearch.js";
import KnowledgeTag from "../models/KnowledgeTag.js";

function sendError(res, err, fallback) {
  console.error("[knowledge]", err);
  res.status(err.status ?? 500).json({ error: err.status ? err.message : fallback });
}

export async function listFolders(_req, res) {
  try {
    res.json(await listAllFolders());
  } catch (err) {
    sendError(res, err, "Failed to list knowledge folders");
  }
}

export async function postFolder(req, res) {
  try {
    const { name, description, tags } = req.body;
    res.status(201).json(await createFolder(name, description, tags));
  } catch (err) {
    sendError(res, err, "Failed to create folder");
  }
}

export async function patchFolder(req, res) {
  try {
    const { description, tags } = req.body;
    await updateFolder(req.params.name, description, tags);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, "Failed to update folder");
  }
}

export async function removeFolder(req, res) {
  try {
    await deleteFolder(req.params.name);
    res.json({ ok: true });
    deleteFolderChunks(req.params.name).catch((err) =>
      console.error("[knowledge] deleteFolderChunks falhou:", err.message),
    );
  } catch (err) {
    sendError(res, err, "Failed to delete folder");
  }
}

export async function getFile(req, res) {
  try {
    const content = await readKnowledgeFile(req.params.name, req.params.file);
    if (content === null) return res.status(404).json({ error: "File not found" });
    res.json({ content });
  } catch (err) {
    sendError(res, err, "Failed to read file");
  }
}

export async function putFile(req, res) {
  try {
    const { content } = req.body;
    await writeKnowledgeFile(req.params.name, req.params.file, content);
    res.json({ ok: true });
    ingestFile(req.params.name, req.params.file, content ?? "").catch((err) =>
      console.error("[knowledge] ingestFile falhou:", err.message),
    );
  } catch (err) {
    sendError(res, err, "Failed to save file");
  }
}

export async function removeFile(req, res) {
  try {
    await deleteKnowledgeFile(req.params.name, req.params.file);
    res.json({ ok: true });
    deleteFileChunks(req.params.name, req.params.file).catch((err) =>
      console.error("[knowledge] deleteFileChunks falhou:", err.message),
    );
  } catch (err) {
    sendError(res, err, "Failed to delete file");
  }
}

export async function getFileStatus(req, res) {
  const status = getIngestStatus(req.params.name, req.params.file);
  res.json(status ?? { status: "unknown" });
}

export async function searchKnowledge(req, res) {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (!query.trim()) return res.json([]);
    const results = await searchKnowledgeBase(query);
    res.json(results);
  } catch (err) {
    sendError(res, err, "Failed to search knowledge base");
  }
}

export async function listTags(_req, res) {
  try {
    const tags = await KnowledgeTag.find().sort({ name: 1 }).select("name description").lean();
    res.json(tags);
  } catch (err) {
    sendError(res, err, "Failed to list tags");
  }
}

export async function reindexAll(_req, res) {
  try {
    const folders = await listAllFolders();
    let count = 0;
    for (const folder of folders) {
      for (const file of folder.files) {
        const content = await readKnowledgeFile(folder.name, file);
        if (content === null) continue;
        await ingestFile(folder.name, file, content);
        count++;
      }
    }
    res.json({ ok: true, filesIndexed: count });
  } catch (err) {
    sendError(res, err, "Failed to reindex knowledge base");
  }
}
