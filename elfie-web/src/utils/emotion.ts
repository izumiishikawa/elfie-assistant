
export type EmotionKey = "tesao" | "feliz" | "triste" | "brava" | "surpresa" | "pensativa" | "neutra";

export const EMOTIONS: Record<EmotionKey, { emoji: string; re?: RegExp }> = {
  tesao: { emoji: "😏", re: /tesão|tesud[ao]|excitad[ao]|gemid|geme[r\b]|safad[ao]|molhad[ao]|taras?[ao]|😏|🥵|🔥/i },
  feliz: { emoji: "😄", re: /kk+\b|haha|rs{2,}\b|adorei|amei|que bom|que(ri|r)id[ao]|😄|😆|😂|🎉|❤️|🥰/u },
  triste: { emoji: "😢", re: /sinto muito|que triste|lamento|😢|😭|💔/u },
  brava: { emoji: "😤", re: /irritant|que raiva|frustrant|😤|😠|😡/u },
  surpresa: { emoji: "😳", re: /\buau\b|\bnossa!|sério\?|caramba|😳|😱/u },
  pensativa: { emoji: "🤔", re: /\bhmm+\b|deixa eu pensar|interessante\.{3}|🤔/u },
  neutra: { emoji: "🙂" },
};

const EMOTION_PRIORITY: EmotionKey[] = ["tesao", "surpresa", "brava", "triste", "feliz", "pensativa"];

export function detectEmotion(input: { content?: string; toolsUsed?: string[] } | undefined): {
  key: EmotionKey;
  emoji: string;
} {
  const text = input?.content ?? "";
  for (const key of EMOTION_PRIORITY) {
    if (EMOTIONS[key].re?.test(text)) return { key, emoji: EMOTIONS[key].emoji };
  }
  return { key: "neutra", emoji: EMOTIONS.neutra.emoji };
}
