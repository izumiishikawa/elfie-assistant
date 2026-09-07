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
  if (_provider() === 'inworld') {
    // Inworld's LLM Router speaks the same OpenAI chat-completions wire format as
    // OpenRouter, but auths with "Basic <key>" (same INWORLD_API_KEY already used
    // for the voice S2S bridge in inworldRealtime.js) instead of "Bearer <key>" —
    // the SDK always sends Bearer via `apiKey`, so override the header directly.
    return new OpenAI({
      baseURL: 'https://api.inworld.ai/v1',
      apiKey: 'unused',
      defaultHeaders: { Authorization: `Basic ${process.env.INWORLD_API_KEY || ''}` },
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

const INWORLD_DEFAULT_MODEL = 'openai/gpt-4o-mini';

export function isDeepSeekActive() {
  return _provider() === 'deepseek';
}

export function getDeepSeekVisionModel() {
  return DEEPSEEK_VISION_MODEL;
}

export function getDefaultChatModel() {
  if (_provider() === 'deepseek') return _settings.deepseekModel || DEEPSEEK_DEFAULT_MODEL;
  if (_provider() === 'inworld') return _settings.inworldModel || INWORLD_DEFAULT_MODEL;
  return process.env.OPENROUTER_MODEL ?? 'gpt-4o';
}

// Character.model is OpenRouter/DeepSeek-namespaced (e.g. "z-ai/glm-5.3-flash", an
// OpenRouter slug); Character.inworldLLMModel is Inworld Router-namespaced (e.g.
// "openai/gpt-4o-mini"). Both can look like "provider/model" so they can't be told
// apart by shape — callers must pick the field matching the active provider instead
// of always reading char.model, or a provider switch silently sends the wrong
// catalog's model id to the LLM and it 400s.
export function getCharacterModel(char) {
  if (_provider() === 'inworld') return char?.inworldLLMModel?.trim() || '';
  return char?.model?.trim() || '';
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

export function getVoiceModel(characterModel) {
  if (_provider() === 'deepseek') return getDefaultChatModel();
  return characterModel?.trim() || getDefaultChatModel();
}

export function getToolChatModel() {
  return _provider() === 'deepseek'
    ? 'deepseek-v4-pro'
    : (process.env.CHAT_TOOL_MODEL ?? getDefaultChatModel());
}

export function getDefaultSummarizerModel() {
  if (_provider() === 'deepseek') return DEEPSEEK_DEFAULT_MODEL;
  if (_provider() === 'inworld') return process.env.SUMMARIZER_MODEL ?? getDefaultChatModel();
  return process.env.SUMMARIZER_MODEL ?? 'openai/gpt-4o-mini';
}

export function getDefaultProactiveModel() {
  if (_provider() === 'deepseek') return DEEPSEEK_DEFAULT_MODEL;
  if (_provider() === 'inworld') return process.env.PROACTIVE_MODEL ?? getDefaultChatModel();
  return process.env.PROACTIVE_MODEL ?? 'gpt-4o';
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
