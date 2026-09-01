import OpenAI from 'openai';

let _settings = {};

export function setLLMSettings(s) {
  _settings = s ?? {};
}

function _provider() {
  return _settings.llmProvider ?? process.env.LLM_PROVIDER ?? 'openrouter';
}

export function getLLMClient() {
  if (_provider() === 'deepseek') {
    return new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: _settings.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '',
    });
  }
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3000',
      'X-Title': 'Elfie',
    },
  });
}

function createOpenRouterClient() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3000',
      'X-Title': 'Elfie',
    },
  });
}

export function getEmbeddingClient() {
  return createOpenRouterClient();
}

export function getVisionClient() {
  return createOpenRouterClient();
}

const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp';

export function isDeepSeekActive() {
  return _provider() === 'deepseek';
}

export function getDeepSeekVisionModel() {
  return DEEPSEEK_VISION_MODEL;
}

export function getDefaultChatModel() {
  return _provider() === 'deepseek'
    ? (_settings.deepseekModel || DEEPSEEK_DEFAULT_MODEL)
    : (process.env.OPENROUTER_MODEL ?? 'gpt-4o');
}

export function resolveModel(characterModel, forcePro = false, hasImages = false) {
  if (hasImages && _provider() === 'deepseek') return DEEPSEEK_VISION_MODEL;
  if (forcePro && _provider() === 'deepseek') return 'deepseek-v4-pro';
  const m = characterModel?.trim();
  if (!m) return getDefaultChatModel();
  if (_provider() !== 'deepseek') return m;
  if (!m.includes('/')) return m;
  return getDefaultChatModel();
}

export function getFastVoiceModel() {
  return _provider() === 'deepseek'
    ? DEEPSEEK_DEFAULT_MODEL
    : (process.env.VOICE_MODEL ?? 'openai/gpt-4o-mini');
}

export function getToolVoiceModel() {
  return _provider() === 'deepseek'
    ? getFastVoiceModel()
    : (process.env.VOICE_TOOL_MODEL ?? getDefaultChatModel());
}

export function getToolChatModel() {
  return _provider() === 'deepseek'
    ? 'deepseek-v4-pro'
    : (process.env.CHAT_TOOL_MODEL ?? getDefaultChatModel());
}

export function getDefaultSummarizerModel() {
  return _provider() === 'deepseek'
    ? DEEPSEEK_DEFAULT_MODEL
    : (process.env.SUMMARIZER_MODEL ?? 'openai/gpt-4o-mini');
}

export function getDefaultProactiveModel() {
  return _provider() === 'deepseek'
    ? DEEPSEEK_DEFAULT_MODEL
    : (process.env.PROACTIVE_MODEL ?? 'gpt-4o');
}

const EXPLICIT_CACHE_MODEL_RE = /^(anthropic\/|qwen|google\/gemini)/i;

export function withCacheControl(text, model) {
  if (_provider() === 'openrouter' && EXPLICIT_CACHE_MODEL_RE.test(model || '')) {
    return [
      { type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
  }
  return text;
}

export function getThinkingParams(hasTools, forceThinking = false) {
  if (_provider() !== 'deepseek') return {};
  return { thinking: { type: forceThinking ? 'enabled' : 'disabled' } };
}
