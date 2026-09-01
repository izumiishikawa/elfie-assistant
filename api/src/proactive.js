
import Settings from './models/Settings.js';
import Character from './models/Character.js';
import Chat from './models/Chat.js';
import { getLLMClient, getDefaultProactiveModel } from './llm.js';
import { sendExpoPush } from './push.js';
const MAX_PER_DAY = 2;
const MIN_HOURS_BETWEEN = 3;
const SLEEP_START = 23;
const SLEEP_END = 8;

function getTimeOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

function shouldSendNow(settings, now) {
  const hour = now.getHours();

  if (hour >= SLEEP_START || hour < SLEEP_END) return false;

  const today = now.toDateString();
  const resetDay = settings.proactiveDateReset
    ? new Date(settings.proactiveDateReset).toDateString()
    : null;
  const count = resetDay === today ? (settings.proactiveCountToday ?? 0) : 0;
  if (count >= MAX_PER_DAY) return false;

  if (settings.lastProactiveAt) {
    const hoursSince = (now - new Date(settings.lastProactiveAt)) / 3_600_000;
    if (hoursSince < MIN_HOURS_BETWEEN) return false;
  }

  const hoursSinceLast = settings.lastProactiveAt
    ? (now - new Date(settings.lastProactiveAt)) / 3_600_000
    : 999;
  const baseProbability = Math.min(0.15 + hoursSinceLast * 0.02, 0.55);
  return Math.random() < baseProbability;
}

async function buildProactivePrompt(char, settings, now) {
  const hour = now.getHours();
  const timeOfDay = getTimeOfDay(hour);
  const name = char?.name || 'Elfie';
  const personality = char?.personality || '';
  const userName = char?.userName || settings?.userName || '';

  const lastChat = await Chat.findOne({ characterId: char?._id })
    .sort({ updatedAt: -1 })
    .lean();

  const hoursSinceChat = lastChat?.updatedAt
    ? Math.round((now - new Date(lastChat.updatedAt)) / 3_600_000)
    : null;

  const lastSummary = char?.chatSummaries?.slice(-1)[0]?.text ?? null;

  const context = [
    `Current time: ${timeOfDay} (${hour}:00)`,
    hoursSinceChat !== null
      ? `Last conversation: ${hoursSinceChat}h ago`
      : 'No previous conversations.',
    lastSummary ? `Last conversation context:\n${lastSummary}` : '',
  ].filter(Boolean).join('\n');

  return `You are ${name}${personality ? `, ${personality}` : ''}.
You want to send a spontaneous message to ${userName || 'your person'} to start a conversation.

Context:
${context}

Write a single short, natural message (1-3 sentences) as if you just thought of them and decided to reach out.
Be genuine, warm, and spontaneous. Match the time of day naturally.
Don't start with their name. Don't be generic or robotic.
Just the message text — nothing else, no quotes.`;
}

export async function runProactiveCheck() {
  const now = new Date();

  const settings = await Settings.findOne().lean();
  if (!settings?.pushToken) return;
  if (!shouldSendNow(settings, now)) return;

  const lastChat = await Chat.findOne(
    settings.activeCharacterId ? { characterId: settings.activeCharacterId } : {}
  ).sort({ updatedAt: -1 }).lean();
  const lastMsg = lastChat?.messages?.at(-1);
  if (lastMsg?.role === 'assistant') return;

  let char = null;
  if (settings.activeCharacterId) {
    char = await Character.findById(settings.activeCharacterId).lean();
  }
  if (!char) char = await Character.findOne().lean();
  if (!char) return;

  try {
    const prompt = await buildProactivePrompt(char, settings, now);

    const res = await getLLMClient().chat.completions.create({
      model: getDefaultProactiveModel(),
      max_tokens: 150,
      temperature: 0.9,
      messages: [{ role: 'user', content: prompt }],
    });

    const message = res.choices[0]?.message?.content?.trim();
    if (!message) return;

    const chat = await Chat.findOne({ characterId: char._id }).sort({ updatedAt: -1 });
    const targetChat = chat ?? await Chat.create({ characterId: char._id });
    targetChat.messages.push({ role: 'assistant', content: message });
    await targetChat.save();

    await sendExpoPush(settings.pushToken, char.name, message, { type: 'proactive' });

    const today = now.toDateString();
    const resetDay = settings.proactiveDateReset
      ? new Date(settings.proactiveDateReset).toDateString()
      : null;
    const newCount = resetDay === today ? (settings.proactiveCountToday ?? 0) + 1 : 1;

    await Settings.findOneAndUpdate({}, {
      lastProactiveAt: now,
      proactiveCountToday: newCount,
      proactiveDateReset: now,
    });

    console.log(`[proactive] sent: "${message.slice(0, 60)}..."`);
  } catch (err) {
    console.error('[proactive] failed:', err.message);
  }
}
