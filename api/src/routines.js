
import Routine from './models/Routine.js';
import Chat from './models/Chat.js';
import Character from './models/Character.js';
import Settings from './models/Settings.js';
import { runAgentTurn, loadActiveChar, generateVoiceNote } from './controllers/chats.controller.js';
import { sendExpoPush } from './push.js';
import { sendToDaemon } from './neuroStore.js';
import { triggerWorkflowFromRoutine } from './workflows.js';

const noopSendEvent = () => {};

async function resolveCharAndSettings(routine) {
  if (routine.characterId) {
    const [char, settings] = await Promise.all([
      Character.findById(routine.characterId)
        .select('+longTermMemory.embedding +chatSummaries.embedding')
        .lean(),
      Settings.findOne().lean(),
    ]);
    if (char) return { char, settings };
  }
  return loadActiveChar();
}

async function executeRoutine(routine) {
  const { char, settings } = await resolveCharAndSettings(routine);
  if (!char) {
    console.warn(`[routines] "${routine.name}": nenhum personagem disponível, pulando`);
    return;
  }

  const chat = await Chat.create({ characterId: char._id });
  const isFirstMessage = true;
  chat.messages.push({ role: 'user', content: routine.prompt, triggeredByRoutine: routine._id });
  await chat.save();

  let fullText = '';
  try {
    fullText = await runAgentTurn({
      chat,
      char,
      settings,
      text: routine.prompt,
      isFirstMessage,
      sendEvent: noopSendEvent,
      signal: new AbortController().signal,
    });
  } catch (err) {
    console.error(`[routines] "${routine.name}" falhou:`, err.message);
    return;
  }

  console.log(`[routines] "${routine.name}" executada: "${(fullText || '').slice(0, 60)}"`);

  for (const workflowId of routine.triggeredWorkflowIds ?? []) {
    try {
      await triggerWorkflowFromRoutine(workflowId, { routine, output: fullText });
    } catch (err) {
      console.error(`[routines] "${routine.name}" falhou ao disparar automação ${workflowId}:`, err.message);
    }
  }

  if (routine.forceTts && fullText) {
    try {
      const filename = await generateVoiceNote(fullText, char.voiceId);
      if (filename) {
        const chatId = chat._id.toString();
        await sendToDaemon({ cmd: 'switch', chatId });
        await sendToDaemon({ cmd: 'unmute' });
        await sendToDaemon({ cmd: 'play_audio', filename });
      }
    } catch (err) {
      console.error(`[routines] "${routine.name}" forceTts falhou:`, err.message);
    }
  }

  if (routine.notify && settings?.pushToken && fullText) {
    try {
      await sendExpoPush(settings.pushToken, char.name || routine.name, fullText, {
        type: 'routine',
        routineId: routine._id.toString(),
        chatId: chat._id.toString(),
      });
    } catch (err) {
      console.error(`[routines] push falhou para "${routine.name}":`, err.message);
    }
  }
}

export async function runRoutineNow(routineId) {
  const routine = await Routine.findById(routineId);
  if (!routine) throw new Error('Routine not found');
  await executeRoutine(routine);
  routine.lastRunAt = new Date();
  await routine.save();
}

function isDue(routine, now) {
  if (now.getHours() !== routine.hour || now.getMinutes() !== routine.minute) return false;
  if (routine.runOnce) {
    if (!routine.scheduledDate) return false;
    const d = new Date(routine.scheduledDate);
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) {
      return false;
    }
  } else if (routine.daysOfWeek?.length > 0 && !routine.daysOfWeek.includes(now.getDay())) {
    return false;
  }
  if (routine.lastRunAt) {
    const last = new Date(routine.lastRunAt);
    const sameMinute =
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate() &&
      last.getHours() === now.getHours() &&
      last.getMinutes() === now.getMinutes();
    if (sameMinute) return false;
  }
  return true;
}

export async function runRoutinesCheck() {
  const now = new Date();
  const routines = await Routine.find({ enabled: true });
  for (const routine of routines) {
    if (!isDue(routine, now)) continue;
    try {
      await executeRoutine(routine);
    } finally {
      routine.lastRunAt = now;
      if (routine.runOnce) routine.enabled = false;
      await routine.save();
    }
  }
}
