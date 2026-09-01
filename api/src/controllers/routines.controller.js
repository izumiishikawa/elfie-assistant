import Routine from '../models/Routine.js';
import { runRoutineNow } from '../routines.js';

const FIELDS = [
  'name', 'prompt', 'characterId', 'hour', 'minute', 'daysOfWeek', 'runOnce', 'scheduledDate',
  'enabled', 'notify', 'forceTts', 'triggeredWorkflowIds',
];

function validate(body, { partial = false } = {}) {
  if (!partial || body.name !== undefined) {
    if (!body.name || !body.name.trim()) return 'Nome obrigatório.';
  }
  if (!partial || body.prompt !== undefined) {
    if (!body.prompt || !body.prompt.trim()) return 'Prompt obrigatório.';
  }
  if (!partial || body.hour !== undefined) {
    if (!Number.isInteger(body.hour) || body.hour < 0 || body.hour > 23) return 'Hora inválida.';
  }
  if (!partial || body.minute !== undefined) {
    if (!Number.isInteger(body.minute) || body.minute < 0 || body.minute > 59) return 'Minuto inválido.';
  }
  if (body.daysOfWeek !== undefined) {
    if (!Array.isArray(body.daysOfWeek) || body.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return 'Dias da semana inválidos.';
    }
  }
  if (body.triggeredWorkflowIds !== undefined) {
    if (!Array.isArray(body.triggeredWorkflowIds) || body.triggeredWorkflowIds.some((id) => typeof id !== 'string')) {
      return 'Automações inválidas.';
    }
  }
  return null;
}

export async function listRoutines(_req, res) {
  try {
    const routines = await Routine.find().sort({ hour: 1, minute: 1 });
    res.json(routines);
  } catch (err) {
    console.error('[listRoutines]', err);
    res.status(500).json({ error: 'Failed to list routines' });
  }
}

export async function createRoutine(req, res) {
  try {
    const error = validate(req.body);
    if (error) return res.status(400).json({ error });
    const patch = {};
    for (const f of FIELDS) if (req.body[f] !== undefined) patch[f] = req.body[f];
    if (patch.name) patch.name = patch.name.trim();
    if (patch.prompt) patch.prompt = patch.prompt.trim();
    const routine = await Routine.create(patch);
    res.status(201).json(routine);
  } catch (err) {
    console.error('[createRoutine]', err);
    res.status(500).json({ error: 'Failed to create routine' });
  }
}

export async function updateRoutine(req, res) {
  try {
    const error = validate(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    const patch = {};
    for (const f of FIELDS) if (req.body[f] !== undefined) patch[f] = req.body[f];
    if (patch.name) patch.name = patch.name.trim();
    if (patch.prompt) patch.prompt = patch.prompt.trim();
    const routine = await Routine.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!routine) return res.status(404).json({ error: 'Routine not found' });
    res.json(routine);
  } catch (err) {
    console.error('[updateRoutine]', err);
    res.status(500).json({ error: 'Failed to update routine' });
  }
}

export async function deleteRoutine(req, res) {
  try {
    const routine = await Routine.findByIdAndDelete(req.params.id);
    if (!routine) return res.status(404).json({ error: 'Routine not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[deleteRoutine]', err);
    res.status(500).json({ error: 'Failed to delete routine' });
  }
}

export async function runRoutineNowController(req, res) {
  try {
    await runRoutineNow(req.params.id);
    res.json({ message: 'Executed' });
  } catch (err) {
    console.error('[runRoutineNow]', err);
    res.status(500).json({ error: err.message || 'Failed to run routine' });
  }
}
