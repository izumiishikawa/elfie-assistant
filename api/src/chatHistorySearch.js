import { getEmbedding } from './embeddings.js';
import { searchChatChunks } from './lancedb.js';
import { rerank } from './reranker.js';

const CANDIDATE_POOL = 30;
const DEFAULT_TOP_K = 6;

export async function searchChatHistory(queryText, { topK = DEFAULT_TOP_K } = {}) {
  if (!queryText?.trim()) return [];
  const embedding = await getEmbedding(queryText);
  const candidates = await searchChatChunks({ queryText, queryEmbedding: embedding, topK: CANDIDATE_POOL });
  if (candidates.length === 0) return [];
  return rerank(queryText, candidates, topK);
}
