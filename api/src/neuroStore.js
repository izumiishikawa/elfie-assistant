import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import net from 'net';
import { join } from 'path';
import { tmpdir } from 'os';

const IS_WINDOWS = process.platform === 'win32';

// No Linux o daemon escuta num socket unix em /tmp/elfie.sock. No Windows o
// suporte a AF_UNIX é irregular, então ele sobe um TCP no loopback e publica a
// porta escolhida em %TEMP%\elfie\elfie.port — ver daemon/platform_compat.py.
const SOCK_PATH = '/tmp/elfie.sock';
const PORT_PATH = join(tmpdir(), 'elfie', 'elfie.port');
const DEFAULT_TCP_PORT = 41907;

function daemonTarget() {
  if (process.env.ELFIE_DAEMON_ADDR) {
    const raw = process.env.ELFIE_DAEMON_ADDR;
    const m = /^(.*):(\d+)$/.exec(raw);
    return m ? { host: m[1] || '127.0.0.1', port: Number(m[2]) } : { path: raw };
  }
  if (!IS_WINDOWS) return { path: SOCK_PATH };
  let port = DEFAULT_TCP_PORT;
  try {
    const parsed = Number(readFileSync(PORT_PATH, 'utf-8').trim());
    if (Number.isInteger(parsed) && parsed > 0) port = parsed;
  } catch { /* daemon ainda não subiu: tenta a porta padrão */ }
  return { host: '127.0.0.1', port };
}

export function sendToDaemon(cmd) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    sock.connect(daemonTarget(), () => sock.write(JSON.stringify(cmd) + '\n'));
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('end', () => { try { finish(resolve, JSON.parse(buf)); } catch { finish(resolve, { ok: true }); } });
    sock.on('error', (err) => finish(reject, err));
    setTimeout(() => { sock.destroy(); finish(reject, new Error('daemon timeout')); }, 5000);
  });
}

const tasks = new Map();

export function createTask(prompt, channel = 'chat', chatId = null) {
  const taskId = randomUUID();
  tasks.set(taskId, { taskId, prompt, channel, chatId, status: 'pending_confirm' });
  return taskId;
}

export function getTask(taskId) { return tasks.get(taskId); }
export function deleteTask(taskId) { tasks.delete(taskId); }

const sessions = new Map();

export function getOrCreateSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      chatId,
      events: [],
      sseRes: null,
      pendingAnswerResolvers: [],
      channel: null,
      voiceId: null,
      status: 'idle',
    });
  }
  return sessions.get(chatId);
}

export function setSessionStatus(chatId, status) {
  const s = getOrCreateSession(chatId);
  s.status = status;
}

export function getSession(chatId) { return sessions.get(chatId); }

export function getRunningSessions() {
  return [...sessions.values()]
    .filter((s) => s.status === 'running' || s.status === 'waiting')
    .map((s) => ({ chatId: s.chatId, channel: s.channel, status: s.status }));
}

export function setSessionVoiceConfig(chatId, { channel, voiceId }) {
  const s = getOrCreateSession(chatId);
  s.channel = channel;
  s.voiceId = voiceId ?? null;
  s.status = 'running';
}

export function setSessionSseRes(chatId, res) {
  const s = getOrCreateSession(chatId);
  s.sseRes = res;
}

export function pushSessionEvent(chatId, event) {
  const s = sessions.get(chatId);
  if (!s) return false;
  const stamped = { ...event, ts: Date.now() };
  s.events.push(stamped);
  if (s.sseRes) s.sseRes.write(`data: ${JSON.stringify(stamped)}\n\n`);
  return true;
}

export function submitSessionAnswer(chatId, answer) {
  const s = sessions.get(chatId);
  if (!s) return false;
  const resolvers = s.pendingAnswerResolvers.splice(0);
  for (const resolve of resolvers) resolve(answer);
  return true;
}

export function waitForSessionAnswer(chatId, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const s = getOrCreateSession(chatId);
    const timer = setTimeout(() => {
      const idx = s.pendingAnswerResolvers.indexOf(resolve);
      if (idx !== -1) s.pendingAnswerResolvers.splice(idx, 1);
      resolve(null);
    }, timeoutMs);
    s.pendingAnswerResolvers.push((ans) => {
      clearTimeout(timer);
      resolve(ans);
    });
  });
}

export function getSessionHistory(chatId) {
  return sessions.get(chatId)?.events ?? [];
}

export function deleteSession(chatId) {
  sessions.delete(chatId);
}

export function pushEvent(taskId, event) {
  const task = tasks.get(taskId);
  if (task?.chatId) return pushSessionEvent(task.chatId, event);
  return false;
}

export function submitAnswer(taskId, answer) {
  const task = tasks.get(taskId);
  if (task?.chatId) return submitSessionAnswer(task.chatId, answer);
  return false;
}

export function waitForAnswer(taskId, timeoutMs = 60_000) {
  const task = tasks.get(taskId);
  if (task?.chatId) return waitForSessionAnswer(task.chatId, timeoutMs);
  return Promise.resolve(null);
}
