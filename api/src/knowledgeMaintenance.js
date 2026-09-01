
import { getLLMClient, getDefaultSummarizerModel } from './llm.js';
import { cosineSimilarity } from './embeddings.js';
import { getChunksTableForMaintenance, toPlainArray } from './lancedb.js';
import { listAllFolders, readKnowledgeFile, updateFolder } from './knowledgeBase.js';
import KnowledgeTag from './models/KnowledgeTag.js';

const TAG_MERGE_THRESHOLD = 0.85;
const RUN_HOUR = 3;
const RUN_MINUTE = 0;

function escapeSqlString(s) {
  return String(s).replace(/'/g, "''");
}

async function mergeDuplicateTags() {
  const tags = await KnowledgeTag.find().select('+embedding').lean();
  const withEmbedding = tags.filter((t) => t.embedding?.length);

  withEmbedding.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const renameMap = new Map();
  const toDelete = [];
  const kept = [];

  for (const tag of withEmbedding) {
    const dupOf = kept.find((k) => cosineSimilarity(tag.embedding, k.embedding) >= TAG_MERGE_THRESHOLD);
    if (dupOf) {
      renameMap.set(tag.name, dupOf.name);
      toDelete.push(tag._id);
    } else {
      kept.push(tag);
    }
  }

  if (renameMap.size === 0) return 0;

  const table = await getChunksTableForMaintenance();
  const rows = await table.query().toArray();
  for (const row of rows) {
    const oldTags = toPlainArray(row.tags);
    if (!oldTags.some((t) => renameMap.has(t))) continue;
    const newTags = [...new Set(oldTags.map((t) => renameMap.get(t) ?? t))];
    await table.update({
      where: `id = '${escapeSqlString(row.id)}'`,
      values: { tags: newTags },
    });
  }

  await KnowledgeTag.deleteMany({ _id: { $in: toDelete } });
  console.log(`[knowledgeMaintenance] fundiu ${toDelete.length} tag(s) duplicada(s)`);
  return toDelete.length;
}

async function regenerateFolderDescription(folder) {
  if (folder.files.length === 0) return;
  const snippets = [];
  for (const file of folder.files.slice(0, 20)) {
    const content = await readKnowledgeFile(folder.name, file);
    if (content) snippets.push(`- ${file}: ${content.slice(0, 200).replace(/\n/g, ' ')}`);
  }
  if (snippets.length === 0) return;

  try {
    const res = await getLLMClient().chat.completions.create({
      model: getDefaultSummarizerModel(),
      max_tokens: 150,
      messages: [
        {
          role: 'system',
          content:
            'Write ONE short sentence (same language as the content) describing what this knowledge base folder ' +
            'contains, based on its current files. This description is used to route search relevance — be ' +
            'specific about the actual topic, not generic. Return only the sentence, no quotes.',
        },
        { role: 'user', content: `Folder: ${folder.name}\nFiles:\n${snippets.join('\n')}` },
      ],
    });
    const description = res.choices[0]?.message?.content?.trim();
    if (description) await updateFolder(folder.name, description, folder.tags);
  } catch (err) {
    console.error(`[knowledgeMaintenance] falha ao regenerar descrição de "${folder.name}":`, err.message);
  }
}

async function runMaintenance() {
  console.log('[knowledgeMaintenance] iniciando manutenção noturna');
  await mergeDuplicateTags();
  const folders = await listAllFolders();
  for (const folder of folders) await regenerateFolderDescription(folder);
  console.log('[knowledgeMaintenance] manutenção concluída');
}

export { runMaintenance };

let _lastRunDay = null;
export async function runKnowledgeMaintenanceCheck() {
  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() !== RUN_HOUR || now.getMinutes() !== RUN_MINUTE) return;
  if (_lastRunDay === today) return;
  _lastRunDay = today;
  await runMaintenance();
}
