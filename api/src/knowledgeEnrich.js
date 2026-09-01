import { z } from 'zod';
import { getLLMClient, getDefaultSummarizerModel } from './llm.js';
import { getEmbedding, cosineSimilarity } from './embeddings.js';
import KnowledgeTag from './models/KnowledgeTag.js';
import Entity from './models/Entity.js';

const TAG_DEDUP_THRESHOLD = 0.6;
const ENTITY_EMBEDDING_DEDUP_THRESHOLD = 0.85;

const ENTITY_TYPES = ['person', 'project', 'place', 'date', 'other'];

const chunkEnrichmentSchema = z.object({
  contextPrefix: z.string().default(''),
  tags: z.array(z.string()).default([]),
  entities: z
    .array(z.object({ name: z.string(), type: z.enum(ENTITY_TYPES).default('other') }))
    .default([]),
});
const fileEnrichmentSchema = z.object({
  chunks: z.array(chunkEnrichmentSchema),
});

const ENRICHMENT_SYSTEM_PROMPT = `You enrich chunks of a personal knowledge base note for retrieval. For each \
chunk (given in order), produce:
- contextPrefix: 1-2 short sentences (same language as the content) situating the chunk — what file/folder it's \
from and what it's about — so it reads sensibly even shown alone, out of context. Not a summary of the whole file, \
just enough to disambiguate this specific chunk.
- tags: 1-4 short topic tags. STRONGLY prefer reusing one of the "existingTags" provided if it genuinely fits — \
only propose a new tag when nothing existing really covers it.
- entities: named people, projects, places, or dates explicitly mentioned in this chunk (empty array if none). \
type is one of: person, project, place, date, other.

Return strict JSON: { "chunks": [ { "contextPrefix": "...", "tags": ["..."], "entities": [{"name":"...","type":"..."}] }, ... ] } \
with EXACTLY one entry per input chunk, in the same order. No prose outside the JSON.`;

async function callEnrichmentLLM(chunkTexts, folderMeta, existingTagNames) {
  const userPayload = {
    folder: folderMeta?.name ?? '',
    folderDescription: folderMeta?.description ?? '',
    existingTags: existingTagNames,
    chunks: chunkTexts,
  };

  const res = await getLLMClient().chat.completions.create({
    model: getDefaultSummarizerModel(),
    max_tokens: 8000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: ENRICHMENT_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return null;

  const parsed = fileEnrichmentSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error('[knowledgeEnrich] resposta fora do schema esperado:', parsed.error.message);
    return null;
  }

  const results = parsed.data.chunks.slice(0, chunkTexts.length);
  while (results.length < chunkTexts.length) results.push({ contextPrefix: '', tags: [], entities: [] });
  return results;
}

async function resolveTag(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const existing = await KnowledgeTag.find().select('+embedding').lean();
  const exact = existing.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.name;

  const embedding = await getEmbedding(trimmed);
  if (embedding) {
    let best = null;
    for (const tag of existing) {
      if (!tag.embedding?.length) continue;
      const score = cosineSimilarity(embedding, tag.embedding);
      if (score >= TAG_DEDUP_THRESHOLD && (!best || score > best.score)) best = { name: tag.name, score };
    }
    if (best) return best.name;
  }

  try {
    const created = await KnowledgeTag.create({ name: trimmed, embedding });
    return created.name;
  } catch (err) {
    if (err.code === 11000) return trimmed;
    throw err;
  }
}

async function resolveEntity(name, type, mention) {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const existing = await Entity.find().select('+embedding').lean();
  const lower = trimmed.toLowerCase();
  let match = existing.find(
    (e) => e.name.toLowerCase() === lower || e.aliases.some((a) => a.toLowerCase() === lower),
  );

  if (!match) {
    const embedding = await getEmbedding(trimmed);
    if (embedding) {
      let best = null;
      for (const e of existing) {
        if (!e.embedding?.length) continue;
        const score = cosineSimilarity(embedding, e.embedding);
        if (score >= ENTITY_EMBEDDING_DEDUP_THRESHOLD && (!best || score > best.score)) best = { entity: e, score };
      }
      if (best) match = best.entity;
    }
    if (!match) {
      const created = await Entity.create({ name: trimmed, type, aliases: [], embedding, mentions: [mention] });
      return created.name;
    }
  }

  const update = { $push: { mentions: mention } };
  if (trimmed !== match.name) update.$addToSet = { aliases: trimmed };
  await Entity.updateOne({ _id: match._id }, update);
  return match.name;
}

export async function enrichFile(folder, file, chunks, folderMeta) {
  const empty = chunks.map(() => ({ contextPrefix: '', tags: [], entityNames: [] }));
  if (chunks.length === 0) return empty;

  let llmResults;
  try {
    const existingTagNames = (await KnowledgeTag.find().select('name').lean()).map((t) => t.name);
    llmResults = await callEnrichmentLLM(chunks, folderMeta, existingTagNames);
  } catch (err) {
    console.error(`[knowledgeEnrich] falha no enriquecimento de ${folder}/${file}:`, err.message);
    return empty;
  }
  if (!llmResults) return empty;

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const { contextPrefix, tags, entities } = llmResults[i];
    const chunkId = `${folder}/${file}#${i}`;

    const resolvedTags = [];
    for (const t of tags) {
      const resolved = await resolveTag(t);
      if (resolved) resolvedTags.push(resolved);
    }

    const resolvedEntityNames = [];
    for (const e of entities) {
      const mention = { folder, file, snippet: chunks[i].slice(0, 200), chunkId };
      const resolved = await resolveEntity(e.name, e.type, mention);
      if (resolved) resolvedEntityNames.push(resolved);
    }

    out.push({ contextPrefix, tags: resolvedTags, entityNames: resolvedEntityNames });
  }
  return out;
}
