import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

const RERANKER_MODEL = process.env.RERANKER_MODEL ?? 'onnx-community/bge-reranker-v2-m3-ONNX';
const FALLBACK_RERANKER_MODEL = 'Xenova/bge-reranker-base';

let _loadPromise = null;

async function loadReranker(modelId) {
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(modelId),
    AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q8' }),
  ]);
  return { tokenizer, model };
}

async function getReranker() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      return await loadReranker(RERANKER_MODEL);
    } catch (err) {
      console.error(`[reranker] falha ao carregar "${RERANKER_MODEL}", tentando fallback:`, err.message);
      return loadReranker(FALLBACK_RERANKER_MODEL);
    }
  })().catch((err) => {
    _loadPromise = null;
    throw err;
  });
  return _loadPromise;
}

export async function rerank(query, candidates, topK = 8) {
  if (!candidates?.length) return [];
  if (!query?.trim()) return candidates.slice(0, topK);

  const { tokenizer, model } = await getReranker();
  const queries = candidates.map(() => query);
  const docs = candidates.map((c) => c.text);
  const inputs = await tokenizer(queries, { text_pair: docs, padding: true, truncation: true });
  const { logits } = await model(inputs);
  const scores = Array.from(logits.data);

  return candidates
    .map((c, i) => ({ ...c, rerankScore: scores[i] }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topK);
}
