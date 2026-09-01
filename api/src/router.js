import { getLLMClient, resolveModel } from "./llm.js";

function getModels() {
  return {
    classifier: process.env.ROUTER_CLASSIFIER_MODEL ?? "openai/gpt-4o-mini",
    default: process.env.ROUTER_DEFAULT_MODEL ?? resolveModel(''),
    complex: process.env.ROUTER_COMPLEX_MODEL ?? "anthropic/claude-sonnet-4-5",
    nsfw: process.env.ROUTER_NSFW_MODEL ?? "deepseek/deepseek-v3.2",
  };
}

const CLASSIFIER_PROMPT = `You are a message classifier for an AI companion app. The user speaks Brazilian Portuguese, often informally and via voice (so expect filler words, casual phrasing, incomplete sentences, and regional slang).

Classify the user's latest message into exactly one category:

- "neuro_task": HIGHEST PRIORITY. Use this when the task requires autonomous execution on the user's PC — regardless of how casually or indirectly it's phrased. This includes:
  • File/folder operations: creating, deleting, moving, renaming, organizing, cleaning up, listing contents — e.g. "vai na minha pasta de downloads e organiza", "arruma meus arquivos", "apaga os duplicados", "cria uma pasta pra isso"
  • Downloading or saving anything from the internet to disk
  • Installing, running, or managing software or processes
  • Running scripts or terminal commands
  • Any task where the AI must act on the computer rather than just answer a question
  Also use this if the user explicitly asks to activate "a neuro" (ative a neuro / acione a neuro / use a neuro).
  KEY INSIGHT: Informal/voice phrasing like "vai lá e faz X", "cê pode ir na pasta e...", "me organiza o Y" all mean the AI should DO something on the computer → neuro_task.

- "nsfw": sexual, romantic, intimate, adult, or erotic content — only if no PC execution is needed.

- "default": casual conversation, emotional support, simple questions, small talk, or information requests that don't require touching the computer.

RULE: When in doubt between neuro_task and default, pick neuro_task. A false positive (treating a question as a task) is far less harmful than a false negative (treating a task as a question).

Reply with a single word: nsfw, neuro_task, or default. No punctuation, no explanation.`;

export const NEURO_INVOKE_RE =
  /\b(ativ[ae]r?|acion[eo]e?|use?r?|usa)\s+(a\s+)?neuro\b|\bneuro[,\s]+[eé]\s+(claramente\s+)?necess[aá]ri/i;

export async function classifyMessage(message, recentHistory) {
  if (NEURO_INVOKE_RE.test(message)) {
    console.log(
      `[router] neuro_invoke_re matched — shortcutting to neuro_task`,
    );
    return "neuro_task";
  }
  const context = recentHistory
    .slice(-6)
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 120)}`,
    )
    .join("\n");

  try {
    const res = await getLLMClient().chat.completions.create({
      model: getModels().classifier,
      max_tokens: 5,
      temperature: 0,
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        {
          role: "user",
          content: `${context ? `Context:\n${context}\n\n` : ""}Message: ${message}`,
        },
      ],
    });
    const label = res.choices[0]?.message?.content
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z_]/g, "");
    if (label === "nsfw") return "nsfw";
    if (label === "neuro_task") return "neuro_task";
    return "default";
  } catch (err) {
    console.error(
      "[router] classification failed, using default:",
      err.message,
    );
    return "default";
  }
}

export async function resolveModel(message, history, characterModel) {
  const category = await classifyMessage(message, history);
  const models = getModels();
  const defaultModel = characterModel?.trim() || models.default;

  console.log(
    `[router] category="${category}" characterModel="${characterModel || "none"}" → model="${
      category === "nsfw"
        ? models.nsfw
        : category === "complex"
          ? models.complex
          : category === "neuro_task"
            ? "(neuro — no LLM)"
            : defaultModel
    }"`,
  );

  switch (category) {
    case "nsfw":
      return {
        model: models.nsfw,
        provider: null,
        supportsTools: true,
        category,
      };
    case "complex":
      return {
        model: models.complex,
        provider: null,
        supportsTools: true,
        category,
      };
    case "neuro_task":
      return { model: null, provider: null, supportsTools: false, category };
    default:
      return {
        model: defaultModel,
        provider: null,
        supportsTools: true,
        category,
      };
  }
}
