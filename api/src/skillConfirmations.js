
const pending = new Map();
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function createPendingConfirmation({ chatId, skillName, skillDescription, args }) {
  const id = `conf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ action: 'timeout' });
    }, DEFAULT_TIMEOUT_MS);
    pending.set(id, { chatId, skillName, skillDescription, args, resolve, timer });
  });
  return { id, promise };
}

export function resolvePendingConfirmation(id, decision) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(decision);
  return true;
}

export function getPendingConfirmation(id) {
  return pending.get(id) || null;
}
