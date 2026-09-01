import Chat from './models/Chat.js';
import Character from './models/Character.js';
import Settings from './models/Settings.js';
import { getEmbedding, normaliseMemories } from './embeddings.js';
import { getLLMClient, getDefaultSummarizerModel } from './llm.js';

const SUMMARIZER_PROMPT = `Summarize this conversation in 4-6 concise bullet points for an AI companion's memory.
Focus on:
- Topics discussed
- The user's emotional state or mood
- Personal information the user shared
- Decisions, plans, or things the user wants
- Anything meaningful the AI learned about the user

Be concise. Each bullet should be 1-2 sentences. Write in third person about the user.
Return only the bullet points, no headers.`;

export async function summarizeChat(chatId) {
  const chat = await Chat.findById(chatId).lean();
  if (!chat || chat.messages.length < 4) return null;

  const transcript = chat.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  try {
    const res = await getLLMClient().chat.completions.create({
      model: getDefaultSummarizerModel(),
      max_tokens: 300,
      messages: [
        { role: 'system', content: SUMMARIZER_PROMPT },
        { role: 'user', content: transcript.slice(0, 12000) },
      ],
    });

    const summaryText = res.choices[0]?.message?.content?.trim();
    if (!summaryText) return null;

    const embedding = await getEmbedding(summaryText);

    const s = await Settings.findOne().lean();
    const charId = s?.activeCharacterId ?? (await Character.findOne().lean())?._id;
    if (!charId) return null;

    const char = await Character.findById(charId);
    if (!char) return null;

    const alreadySummarised = char.chatSummaries?.some(
      (s) => String(s.chatId) === String(chatId),
    );
    if (alreadySummarised) return null;

    char.chatSummaries = normaliseMemories(char.chatSummaries ?? []);
    char.chatSummaries.push({ text: summaryText, embedding, chatId, createdAt: new Date() });
    await char.save();

    console.log(`[summarizer] summarised chat ${chatId}`);
    return summaryText;
  } catch (err) {
    console.error('[summarizer] failed:', err.message);
    return null;
  }
}
