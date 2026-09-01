import { getEmbedding } from './embeddings.js';
import { searchChunks, getChunksByIds } from './lancedb.js';
import { rerank } from './reranker.js';
import Entity from './models/Entity.js';

const CANDIDATE_POOL = 30;
const DEFAULT_TOP_K = 8;

async function findEntityMentionChunkIds(queryText) {
  const lower = queryText.toLowerCase();
  const entities = await Entity.find().select('name aliases mentions').lean();
  const matched = entities.filter(
    (e) => lower.includes(e.name.toLowerCase()) || e.aliases.some((a) => lower.includes(a.toLowerCase())),
  );
  const ids = new Set();
  for (const e of matched) for (const m of e.mentions) if (m.chunkId) ids.add(m.chunkId);
  return [...ids];
}

export async function searchKnowledgeBase(
  queryText,
  { topK = DEFAULT_TOP_K, queryEmbedding = null, rerankResults = true } = {},
) {
  if (!queryText?.trim()) return [];
  const embedding = queryEmbedding ?? (await getEmbedding(queryText));

  const [hybridResults, entityChunkIds] = await Promise.all([
    searchChunks({ queryText, queryEmbedding: embedding, topK: CANDIDATE_POOL }),
    findEntityMentionChunkIds(queryText),
  ]);

  const seen = new Set(hybridResults.map((c) => c.id));
  const missingIds = entityChunkIds.filter((id) => !seen.has(id));
  const entityChunks = missingIds.length > 0 ? await getChunksByIds(missingIds) : [];

  const candidates = [...hybridResults, ...entityChunks];
  if (candidates.length === 0) return [];

  if (!rerankResults) return candidates.slice(0, topK);
  return rerank(queryText, candidates, topK);
}
