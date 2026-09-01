import { getEmbeddingClient } from './llm.js';

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';
const SIMILARITY_THRESHOLD = 0.45;

export async function getEmbedding(text) {
  try {
    const res = await getEmbeddingClient().embeddings.create({ model: EMBEDDING_MODEL, input: text.slice(0, 2000) });
    return res.data[0].embedding;
  } catch (err) {
    console.error('[embeddings] getEmbedding failed:', err.message);
    return null;
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchMemories(queryEmbedding, items, topK = 5) {
  if (!queryEmbedding || !items?.length) return [];
  return items
    .filter((m) => m?.embedding?.length)
    .map((m) => ({ text: m.text ?? m, score: cosineSimilarity(queryEmbedding, m.embedding) }))
    .filter((m) => m.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((m) => m.text);
}

export function normaliseMemories(items) {
  return (items ?? []).map((m) =>
    typeof m === 'string' ? { text: m, embedding: null } : m,
  );
}

export function sanitiseMemories(items) {
  return (items ?? []).map((m) => (typeof m === 'string' ? m : m.text ?? ''));
}

export function hasSimilarMemory(queryEmbedding, items, threshold = 0.90) {
  if (!queryEmbedding || !items?.length) return false;
  return items.some(
    (m) => m?.embedding?.length && cosineSimilarity(queryEmbedding, m.embedding) >= threshold,
  );
}
