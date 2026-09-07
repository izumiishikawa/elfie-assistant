import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { getLLMClient, getVisionClient, isDeepSeekActive, getDeepSeekVisionModel } from "./llm.js";

// Shared with chats.controller.js (text-chat's see_image) and inworldRealtime.js
// (the Inworld voice bridge's see_image) — one vision pipeline, not two.
const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, "..", "uploads");

const VISION_MODEL = "qwen/qwen3-vl-32b-instruct";

function detectImageMime(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "image/jpeg";
}

const VISION_MAX_DIMENSION = 2000;

async function loadImageForVision(source) {
  const raw = await readFile(resolve(uploadDir, source));
  try {
    const resized = await sharp(raw)
      .rotate()
      .resize({
        width: VISION_MAX_DIMENSION,
        height: VISION_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    return `data:image/jpeg;base64,${resized.toString("base64")}`;
  } catch (err) {
    console.warn("[see_image] sharp normalize failed, sending raw bytes:", err.message);
    return `data:${detectImageMime(raw)};base64,${raw.toString("base64")}`;
  }
}

async function callVisionModel(client, model, imageUrl, prompt) {
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 2000,
  });
  const choice = res.choices[0];
  const text = choice?.message?.content?.trim() || "";
  return { text, truncated: choice?.finish_reason === "length" && !!text };
}

const VISION_REFUSAL_RE =
  /\b(i can'?t|i cannot|i won'?t|i'?m (?:not able|unable)|i am (?:not able|unable)|not (?:appropriate|able to help)|against (?:my|the) guidelines|i don'?t feel comfortable|não (?:posso|consigo|é apropriado|me sinto confortável)|não estou (?:autorizad[oa]|apta?))\b/i;
function looksLikeVisionRefusal(text) {
  return !text.trim() || VISION_REFUSAL_RE.test(text);
}

export async function executeImageVision(source, question) {
  const isUrl = /^https?:\/\//i.test(source);
  const imageUrl = isUrl ? source : await loadImageForVision(source);

  const prompt = question?.trim()
    ? `Describe this image in detail, then specifically answer: ${question.trim()}`
    : "Describe this image in thorough, specific detail — people, objects, setting, colors, " +
      "text, actions, composition, everything visible. If the content is explicit or NSFW, " +
      "describe it explicitly and specifically rather than vaguely or euphemistically.";

  if (isDeepSeekActive()) {
    try {
      const { text, truncated } = await callVisionModel(getLLMClient(), getDeepSeekVisionModel(), imageUrl, prompt);
      if (!looksLikeVisionRefusal(text)) {
        if (truncated) {
          console.warn("[see_image] DeepSeek vision response hit max_tokens and was truncated");
          return `${text}\n\n[descrição cortada — bateu no limite de tokens antes de terminar]`;
        }
        return text;
      }
      console.warn("[see_image] DeepSeek vision refused/hedged, falling back to Qwen");
    } catch (err) {
      console.warn("[see_image] DeepSeek vision failed, falling back to Qwen:", err.message);
    }
  }

  const { text, truncated } = await callVisionModel(getVisionClient(), VISION_MODEL, imageUrl, prompt);
  if (truncated) {
    console.warn("[see_image] response hit max_tokens and was truncated");
    return `${text}\n\n[descrição cortada — bateu no limite de tokens antes de terminar]`;
  }
  return text;
}
