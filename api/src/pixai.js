// Porte em JS do wrapper não-oficial https://github.com/shidktbw/pixaiAPI (Python).
// A pixai.art não publica uma API oficial: o site fala GraphQL em api.pixai.art/graphql
// com o mesmo token que fica no localStorage do navegador (api.pixai.art:token).
// O fluxo é assíncrono — cria a task, faz polling até a mídia aparecer, baixa a imagem.
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', 'uploads');

const BASE = 'https://api.pixai.art/graphql';

// Headers do app web da pixai. Isso NÃO é cosmético: com o 'webstar/5.0' que o wrapper
// Python original mandava (ou sem User-Agent), a moderação de prompt deles é bem mais
// rígida e recusa conteúdo que a mesma conta gera sem problema pelo site. Testado com o
// mesmo prompt e os mesmos parâmetros, variando só o header.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://pixai.art',
  Referer: 'https://pixai.art/',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Mesmos defaults do payloads.py do projeto original.
const DEFAULT_MODEL_ID = '1648918127446573124';
const DEFAULT_NEGATIVE_PROMPTS =
  'worst quality, large head, low quality, extra digits, bad eye, EasyNegativeV2, ng_deepnegative_v1_75t';
const DEFAULT_SAMPLING_METHOD = 'DPM++ 2M Karras';

const MAX_LORAS = 5;

// Toda geração sai em 3:5 (retrato). 576x960 é a razão exata com os dois lados
// múltiplos de 64, que é o que os modelos SD esperam.
const FORCED_WIDTH = 576;
const FORCED_HEIGHT = 960;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 240_000;

const CREATE_TASK = `mutation createGenerationTask($parameters: JSONObject!) {
  createGenerationTask(parameters: $parameters) { id status }
}`;

const GET_TASK = `query getTaskById($id: ID!) {
  task(id: $id) { id status media { id urls { variant url } } }
}`;

// Busca de checkpoints e LoRAs no catálogo da pixai. ANY_MODEL / ANY_LORA são os
// meta-tipos que o próprio site usa; filtrar por "LORA" direto devolve zero.
const LIST_MODELS = `query listGenerationModels(
  $keyword: String, $types: [GenerationModelType], $first: Int, $after: String,
  $feed: String, $loraBaseModelTypes: [GenerationModelType!]
) {
  generationModels(
    keyword: $keyword, types: $types, first: $first, after: $after,
    feed: $feed, loraBaseModelTypes: $loraBaseModelTypes
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      id title type isNsfw likedCount
      media { urls { variant url } }
      latestAvailableVersion { id name loraBaseModelType extra }
    } }
  }
}`;

const GET_VERSION = `query getGenerationModelByVersionId($id: ID!) {
  generationModelVersion(id: $id) {
    id name loraBaseModelType extra
    media { urls { variant url } }
    model { id title type isNsfw media { urls { variant url } } }
  }
}`;

let _settings = {};

export function setPixaiSettings(s) {
  _settings = s ?? {};
}

export function getPixaiToken() {
  return (_settings.pixaiToken || process.env.PIXAI_TOKEN || '').trim();
}

export function getPixaiModelId() {
  return (_settings.pixaiModelId || process.env.PIXAI_MODEL_ID || DEFAULT_MODEL_ID).trim();
}

export function hasPixaiToken() {
  return getPixaiToken().length > 0;
}

// Tipo do checkpoint escolhido (SD_V1_MODEL, SDXL_MODEL...). Só LoRAs treinadas em cima
// da mesma base funcionam, então isso é o filtro de compatibilidade da busca.
export function getPixaiBaseModelType() {
  return (_settings.pixaiModelBaseType || '').trim();
}

// [{ versionId, title, weight }] escolhidas nas configurações.
export function getPixaiLoras() {
  const loras = Array.isArray(_settings.pixaiLoras) ? _settings.pixaiLoras : [];
  return loras
    .filter((l) => l?.versionId)
    .slice(0, MAX_LORAS)
    .map((l) => ({
      versionId: String(l.versionId),
      title: l.title ?? '',
      baseModelType: l.baseModelType ?? '',
      triggerWords: (l.triggerWords ?? '').trim(),
      weight: Number.isFinite(Number(l.weight)) ? Number(l.weight) : 1,
    }));
}

const TOKEN_HELP =
  'Get a fresh one from pixai.art: DevTools → Application → Local Storage → api.pixai.art:token, ' +
  'then paste it in Settings → AI Provider → Image generation.';

function log(fn, ...args) {
  console.log(`\n[pixai:${fn}]`, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
  const token = getPixaiToken();
  if (!token) throw new Error(`PixAI token not set. ${TOKEN_HELP}`);

  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...BROWSER_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`PixAI returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`); }

  // Token inválido/expirado não volta como erro GraphQL, volta como 401 {message, code}.
  if (!res.ok) {
    const message = data?.message ?? text.slice(0, 200);
    if (res.status === 401) throw new Error(`PixAI rejected the token (${message}). It expires. ${TOKEN_HELP}`);
    throw new Error(`PixAI error ${res.status}: ${message}`);
  }

  if (data.errors?.length) {
    const first = data.errors[0];
    if (first.extensions?.code === 'UNAUTHENTICATED') {
      throw new Error(`PixAI says you are not logged in — the token is missing or expired. ${TOKEN_HELP}`);
    }
    // Moderação de prompt da própria PixAI, avaliada no servidor deles. Não é erro nosso e
    // não tem parâmetro pra contornar — vale identificar direito pra não parecer bug.
    if (/against PixAI'?s policy|content policy|violates/i.test(first.message ?? '')) {
      throw Object.assign(
        new Error(`PixAI's own content moderation rejected this prompt: "${first.message}"`),
        { moderated: true },
      );
    }
    throw new Error(`PixAI error: ${first.message}`);
  }

  return data.data;
}

const pickUrl = (media, variant) =>
  media?.urls?.find((u) => u.variant === variant)?.url ?? media?.urls?.[0]?.url ?? '';

// Toda LoRA carrega as tags que a ativam em extra.triggerWords — é o texto que o site
// cola no prompt quando você adiciona ela. Sem isso a LoRA carrega mas não faz efeito.
const pickTriggerWords = (extra) => {
  const raw = extra?.triggerWords;
  return typeof raw === 'string' ? raw.trim() : '';
};

function normaliseModel(node) {
  const version = node.latestAvailableVersion;
  return {
    modelId: node.id,
    versionId: version?.id ?? null,
    versionName: version?.name ?? '',
    title: node.title ?? '(untitled)',
    type: node.type,
    baseModelType: version?.loraBaseModelType ?? node.type,
    isNsfw: !!node.isNsfw,
    likes: node.likedCount ?? 0,
    triggerWords: pickTriggerWords(version?.extra),
    thumbnail: pickUrl(node.media, 'THUMBNAIL'),
  };
}

// kind: 'model' (checkpoints) ou 'lora'. baseModelType filtra LoRAs compatíveis com o
// checkpoint escolhido — uma LoRA de SD_V1 não roda em cima de um SDXL.
export async function searchModels({ keyword = '', kind = 'model', cursor = null, limit = 24, baseModelType = '' } = {}) {
  const data = await gql(LIST_MODELS, {
    keyword: keyword.trim() || undefined,
    types: [kind === 'lora' ? 'ANY_LORA' : 'ANY_MODEL'],
    first: Math.min(Math.max(Number(limit) || 24, 1), 50),
    after: cursor || undefined,
    feed: keyword.trim() ? undefined : 'hot',
    ...(kind === 'lora' && baseModelType && { loraBaseModelTypes: [baseModelType] }),
  });

  const conn = data?.generationModels;
  return {
    items: (conn?.edges ?? []).map((e) => normaliseModel(e.node)).filter((m) => m.versionId),
    nextCursor: conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null,
    totalCount: conn?.totalCount ?? 0,
  };
}

export async function getModelVersion(versionId) {
  const data = await gql(GET_VERSION, { id: String(versionId) });
  const v = data?.generationModelVersion;
  if (!v) return null;
  return {
    versionId: v.id,
    versionName: v.name ?? '',
    modelId: v.model?.id ?? null,
    title: v.model?.title ?? '(untitled)',
    type: v.model?.type ?? '',
    baseModelType: v.loraBaseModelType ?? v.model?.type ?? '',
    isNsfw: !!v.model?.isNsfw,
    triggerWords: pickTriggerWords(v.extra),
    thumbnail: pickUrl(v.media, 'THUMBNAIL') || pickUrl(v.model?.media, 'THUMBNAIL'),
  };
}

export async function createGenerationTask({
  prompts,
  negativePrompts = DEFAULT_NEGATIVE_PROMPTS,
  samplingSteps = 20,
  samplingMethod = DEFAULT_SAMPLING_METHOD,
  cfgScale = 6,
  clipSkip = 2,
  modelId,
  loras,
} = {}) {
  // Se a chamada trocou o checkpoint na mão, as LoRAs configuradas provavelmente são de
  // outra base e só iriam sujar o resultado — nesse caso vão fora.
  const overridesModel = !!modelId && modelId !== getPixaiModelId();
  const selectedLoras = (loras ?? (overridesModel ? [] : getPixaiLoras()))
    .filter((l) => l?.versionId)
    .slice(0, MAX_LORAS);

  // Uma LoRA só se aplica na arquitetura em que foi treinada. A pixai aceita o parâmetro
  // de qualquer jeito e devolve a imagem como se nada fosse — o resultado é a LoRA sumir
  // sem erro nenhum, que é bem pior do que falhar.
  const baseType = getPixaiBaseModelType();
  const mismatched = baseType
    ? selectedLoras.filter((l) => l.baseModelType && l.baseModelType !== baseType)
    : [];
  if (mismatched.length > 0) {
    console.warn(`[pixai] LoRA incompatível com o checkpoint (${baseType}): ` +
      mismatched.map((l) => `${l.title || l.versionId} é ${l.baseModelType}`).join('; ') +
      ' — a pixai vai aceitar e ignorar.');
  }

  // Os trigger words de TODA lora selecionada entram no prompt, sempre, na íntegra e
  // exatamente como estão salvos — igual ao que o site cola quando você adiciona a lora.
  // Isso é feito aqui, no servidor: não depende da IA lembrar de escrever nada.
  const promptText = String(prompts ?? '').trim();
  const triggerBlocks = selectedLoras
    .map((l) => String(l.triggerWords ?? '').trim())
    .filter(Boolean);
  const finalPrompt = [promptText, ...triggerBlocks].filter(Boolean).join(', ');

  if (triggerBlocks.length > 0) {
    log('createGenerationTask', `trigger words coladas (${triggerBlocks.length}): ${triggerBlocks.join(' | ')}`);
  }

  const parameters = {
    prompts: finalPrompt,
    extra: {},
    negativePrompts,
    samplingSteps: Number(samplingSteps),
    samplingMethod,
    cfgScale: Number(cfgScale),
    autoPublish: false,
    priority: 1000,
    // Fixo de propósito: o aspect ratio não é escolha da chamada.
    width: FORCED_WIDTH,
    height: FORCED_HEIGHT,
    clipSkip: Number(clipSkip),
    modelId: modelId || getPixaiModelId(),
    controlNets: [],
    // O campo que a pixai REALMENTE aplica é `lora`, um mapa versionId -> peso.
    // `loraParameters` (array de objetos) é aceito, ecoado de volta na task e
    // silenciosamente ignorado pelo pipeline — testado com seed fixa: a imagem sai
    // byte a byte idêntica à de uma geração sem lora nenhuma.
    ...(selectedLoras.length > 0 && {
      lora: Object.fromEntries(selectedLoras.map((l) => [
        String(l.versionId),
        Number.isFinite(Number(l.weight)) ? Number(l.weight) : 1,
      ])),
    }),
  };

  log('createGenerationTask', `"${finalPrompt.slice(0, 100)}"`,
      `${parameters.width}x${parameters.height}`, `steps=${parameters.samplingSteps}`,
      `model=${parameters.modelId}`,
      selectedLoras.length ? `loras=[${selectedLoras.map((l) => `${l.title || l.versionId}@${l.weight}`).join(', ')}]` : 'no loras');

  const data = await gql(CREATE_TASK, { parameters });
  const task = data?.createGenerationTask;
  if (!task?.id) throw new Error('PixAI did not return a task id');
  log('createGenerationTask', `task ${task.id} (${task.status ?? 'no status'})`);
  return task.id;
}

// O original dorme 15s fixos e torce pra estar pronto. Aqui a gente faz polling de
// verdade e para quando a URL aparece (ou quando o status vira uma falha).
export async function waitForTask(taskId, { timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    const data = await gql(GET_TASK, { id: taskId });
    const task = data?.task;
    if (!task) throw new Error(`PixAI task ${taskId} not found`);
    lastStatus = task.status ?? lastStatus;

    const urls = task.media?.urls ?? [];
    const url = urls.find((u) => u.variant === 'PUBLIC')?.url ?? urls[0]?.url;
    if (url) {
      log('waitForTask', `task ${taskId} ready (${lastStatus})`);
      return url;
    }

    if (/fail|error|cancel|reject/i.test(String(task.status ?? ''))) {
      throw new Error(`PixAI generation ${task.status} (task ${taskId})`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`PixAI timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus ?? 'unknown'})`);
}

function extFromResponse(url, contentType) {
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webp')) return 'webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return 'jpg';
  const fromUrl = url.split('?')[0].split('.').pop()?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'webp'].includes(fromUrl) ? fromUrl : 'png';
}

export async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download the PixAI image (HTTP ${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = `pixai-${randomBytes(12).toString('hex')}.${extFromResponse(url, res.headers.get('content-type'))}`;
  await writeFile(resolve(uploadDir, filename), buffer);
  log('downloadImage', `${filename} (${buffer.length} bytes)`);
  return filename;
}

// createGenerationTask -> polling -> download, devolvendo o nome do arquivo em uploads/
// no mesmo formato que nanoBanana.generateImage, pra encaixar no resto do chat.
export async function generateImage(prompt, options = {}) {
  if (!prompt?.trim()) throw new Error('No prompt provided');
  const taskId = await createGenerationTask({ ...options, prompts: prompt.trim() });
  const url = await waitForTask(taskId);
  const filename = await downloadImage(url);
  log('generateImage', `saved → ${filename}`);
  return [filename];
}
