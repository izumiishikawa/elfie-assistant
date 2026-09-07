
import Workflow from './models/Workflow.js';
import WorkflowRun from './models/WorkflowRun.js';
import Chat from './models/Chat.js';
import Character from './models/Character.js';
import Settings from './models/Settings.js';
import { runAgentTurn, loadActiveChar, generateVoiceNote } from './controllers/chats.controller.js';
import { sendExpoPush } from './push.js';
import { sendToDaemon } from './neuroStore.js';
import { sendTelegramMessage } from './telegram.js';
import { getLLMClient, getDefaultChatModel, getThinkingParams } from './llm.js';

const noopSendEvent = () => {};

const TRIGGER_NODE_TYPES = new Set(['webhook', 'schedule', 'routine']);


function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const SOLE_TOKEN_RE = /^\{\{\s*([\w.]+)\s*\}\}$/;

function stringify(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function interpolate(template, context) {
  if (typeof template !== 'string') return template;
  return template.replace(TOKEN_RE, (_, path) => stringify(getPath(context, path)));
}

function resolveValue(template, context) {
  if (typeof template !== 'string') return template;
  const sole = template.match(SOLE_TOKEN_RE);
  if (sole) return getPath(context, sole[1]);
  return interpolate(template, context);
}


async function resolveCharAndSettings(workflow) {
  if (workflow.characterId) {
    const [char, settings] = await Promise.all([
      Character.findById(workflow.characterId)
        .select('+longTermMemory.embedding +chatSummaries.embedding')
        .lean(),
      Settings.findOne().lean(),
    ]);
    if (char) return { char, settings };
  }
  return loadActiveChar();
}

async function runPromptNode(node, context, workflow) {
  const data = node.data || {};
  const promptText = interpolate(data.prompt || '', context);
  if (!promptText.trim()) return { output: '' };

  const { char, settings } = await resolveCharAndSettings(workflow);
  if (!char) throw new Error('Nenhum personagem disponível para executar este step');

  // hidden: o Chat aqui é só o recipiente que runAgentTurn exige pra rodar um
  // turno; o produto deste nó é o `output` que segue pro resto do grafo. Cada
  // execução criava uma conversa nova na lista do usuário, que nunca foi a ideia.
  const chat = await Chat.create({ characterId: char._id, hidden: true });
  chat.messages.push({ role: 'user', content: promptText, triggeredByWorkflow: workflow._id });
  await chat.save();

  const fullText = await runAgentTurn({
    chat,
    char,
    settings,
    text: promptText,
    isFirstMessage: true,
    sendEvent: noopSendEvent,
    signal: new AbortController().signal,
  });

  if (data.forceTts && fullText) {
    try {
      const filename = await generateVoiceNote(fullText, char.voiceId);
      if (filename) {
        const chatId = chat._id.toString();
        await sendToDaemon({ cmd: 'switch', chatId });
        await sendToDaemon({ cmd: 'unmute' });
        await sendToDaemon({ cmd: 'play_audio', filename });
      }
    } catch (err) {
      console.error('[workflows] forceTts falhou:', err.message);
    }
  }

  if (data.notify && settings?.pushToken && fullText) {
    try {
      await sendExpoPush(settings.pushToken, char.name || workflow.name, fullText, {
        type: 'workflow',
        workflowId: workflow._id.toString(),
        chatId: chat._id.toString(),
      });
    } catch (err) {
      console.error('[workflows] push falhou:', err.message);
    }
  }

  return { output: fullText, chatId: chat._id.toString() };
}

const HTTP_TIMEOUT_MS = 15000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function runHttpRequestNode(node, context) {
  const data = node.data || {};
  const method = (data.method || 'GET').toUpperCase();
  const url = interpolate(data.urlTemplate || '', context);
  if (!url) throw new Error('URL vazia');

  const headers = {};
  for (const h of data.headers || []) {
    if (h?.key) headers[h.key] = interpolate(h.value || '', context);
  }

  let body;
  if (data.bodyTemplate && BODY_METHODS.has(method)) {
    body = interpolate(data.bodyTemplate, context);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    const message = err.name === 'AbortError' ? `Timed out after ${HTTP_TIMEOUT_MS}ms` : err.message;
    return { ok: false, status: 0, body: message };
  } finally {
    clearTimeout(timeout);
  }
}

async function runTelegramMessageNode(node, context) {
  const data = node.data || {};
  const text = interpolate(data.message || '', context);
  if (!text.trim()) return { output: '' };
  await sendTelegramMessage(text);
  return { output: text };
}

function compareCondition(operator, actual, expected) {
  switch (operator) {
    case 'equals':
      return String(actual ?? '') === String(expected ?? '');
    case 'not_equals':
      return String(actual ?? '') !== String(expected ?? '');
    case 'contains':
      return String(actual ?? '').includes(String(expected ?? ''));
    case 'greater_than':
      return parseFloat(actual) > parseFloat(expected);
    case 'less_than':
      return parseFloat(actual) < parseFloat(expected);
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    default:
      return false;
  }
}

async function evaluateLlmCondition(data, context) {
  const question = interpolate(data.question || '', context);
  if (!question.trim()) return false;
  try {
    const res = await getLLMClient().chat.completions.create({
      model: getDefaultChatModel(),
      messages: [
        { role: 'system', content: 'Responda estritamente com a palavra "true" ou "false", nada mais.' },
        { role: 'user', content: question },
      ],
      max_tokens: 20,
      ...getThinkingParams(false),
    });
    const text = (res.choices[0]?.message?.content || '').trim().toLowerCase();
    if (/\b(false|não|nao)\b/.test(text)) return false;
    if (/\b(true|sim)\b/.test(text)) return true;
    console.warn('[workflows] condição LLM: resposta ambígua, assumindo false:', JSON.stringify(text));
    return false;
  } catch (err) {
    console.error('[workflows] condição LLM falhou:', err.message);
    return false;
  }
}

async function evaluateCondition(node, context) {
  const data = node.data || {};
  if (data.mode === 'llm') return evaluateLlmCondition(data, context);
  const actual = resolveValue(data.field || '', context);
  const expected = resolveValue(data.value ?? '', context);
  return compareCondition(data.operator, actual, expected);
}


function buildAdjacency(workflow) {
  const outgoing = new Map();
  for (const edge of workflow.edges || []) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  return outgoing;
}

function nextNodeIds(node, edges, conditionResult) {
  if (node.type === 'condition') {
    const handle = conditionResult ? 'true' : 'false';
    return edges.filter((e) => e.sourceHandle === handle).map((e) => e.target);
  }
  return edges.map((e) => e.target);
}

const STEP_OUTPUT_CHARS = 2000;

function truncateOutput(value) {
  if (typeof value === 'string') {
    return value.length > STEP_OUTPUT_CHARS ? `${value.slice(0, STEP_OUTPUT_CHARS)}…` : value;
  }
  if (value && typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > STEP_OUTPUT_CHARS ? { truncated: `${text.slice(0, STEP_OUTPUT_CHARS)}…` } : value;
  }
  return value;
}

async function walkFrom(nodeId, workflow, nodesById, adjacency, context, run, visited) {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  const node = nodesById.get(nodeId);
  if (!node) return;

  const step = { nodeId: node.id, nodeType: node.type, startedAt: new Date(), status: 'success', output: null, error: null };
  let conditionResult;

  try {
    if (TRIGGER_NODE_TYPES.has(node.type)) {
      step.output = truncateOutput(context.trigger.body);
      context.steps[node.id] = { output: context.trigger.body };
    } else if (node.type === 'prompt') {
      const result = await runPromptNode(node, context, workflow);
      step.output = truncateOutput(result.output);
      context.steps[node.id] = result;
    } else if (node.type === 'http_request') {
      const result = await runHttpRequestNode(node, context);
      step.output = truncateOutput(result);
      context.steps[node.id] = result;
    } else if (node.type === 'condition') {
      conditionResult = await evaluateCondition(node, context);
      step.output = { result: conditionResult };
      context.steps[node.id] = { output: conditionResult };
    } else if (node.type === 'telegram_message') {
      const result = await runTelegramMessageNode(node, context);
      step.output = truncateOutput(result.output);
      context.steps[node.id] = result;
    }
  } catch (err) {
    step.status = 'error';
    step.error = err.message;
    context.steps[node.id] = { error: err.message };
  }

  step.finishedAt = new Date();
  run.steps.push(step);

  if (step.status === 'error') return;

  const next = nextNodeIds(node, adjacency.get(node.id) || [], conditionResult);
  for (const targetId of next) {
    await walkFrom(targetId, workflow, nodesById, adjacency, context, run, visited);
  }
}

function findStartNode(workflow, triggerType) {
  if (triggerType === 'manual') {
    return (workflow.nodes || []).find((n) => TRIGGER_NODE_TYPES.has(n.type));
  }
  return (workflow.nodes || []).find((n) => n.type === triggerType);
}

const MAX_RUNS_PER_WORKFLOW = 50;

async function pruneOldRuns(workflowId) {
  const old = await WorkflowRun.find({ workflowId }).sort({ createdAt: -1 }).skip(MAX_RUNS_PER_WORKFLOW).select('_id');
  if (old.length) await WorkflowRun.deleteMany({ _id: { $in: old.map((r) => r._id) } });
}

export async function executeWorkflow(workflow, { type, payload = {}, headers = {} }) {
  const startNode = findStartNode(workflow, type);
  const run = await WorkflowRun.create({ workflowId: workflow._id, trigger: { type, payload }, status: 'running' });

  if (!startNode) {
    run.status = 'error';
    run.error = 'Workflow não tem nenhum nó de entrada compatível com este gatilho';
    run.finishedAt = new Date();
    await run.save();
    return run;
  }

  const nodesById = new Map((workflow.nodes || []).map((n) => [n.id, n]));
  const adjacency = buildAdjacency(workflow);
  const context = { trigger: { type, body: payload, headers }, steps: {} };

  try {
    await walkFrom(startNode.id, workflow, nodesById, adjacency, context, run, new Set());
    run.status = run.steps.some((s) => s.status === 'error') ? 'error' : 'success';
  } catch (err) {
    run.status = 'error';
    run.error = err.message;
  }
  run.finishedAt = new Date();
  await run.save();

  workflow.lastRunAt = new Date();
  await workflow.save();

  pruneOldRuns(workflow._id).catch((err) => console.error('[workflows] prune falhou:', err.message));

  return run;
}


export async function runWorkflowManually(workflowId, samplePayload = {}) {
  const workflow = await Workflow.findById(workflowId);
  if (!workflow) throw new Error('Workflow not found');
  return executeWorkflow(workflow, { type: 'manual', payload: samplePayload });
}

export async function resolveWebhookWorkflow(workflowId, token, secretHeader) {
  const workflow = await Workflow.findById(workflowId);
  if (!workflow) {
    const err = new Error('Workflow not found');
    err.status = 404;
    throw err;
  }
  if (!workflow.enabled) {
    const err = new Error('Workflow disabled');
    err.status = 403;
    throw err;
  }
  if (!workflow.webhookToken || workflow.webhookToken !== token) {
    const err = new Error('Invalid token');
    err.status = 401;
    throw err;
  }
  if (workflow.webhookSecret && workflow.webhookSecret !== secretHeader) {
    const err = new Error('Invalid secret');
    err.status = 401;
    throw err;
  }
  return workflow;
}

export async function triggerWorkflowFromRoutine(workflowId, { routine, output }) {
  const workflow = await Workflow.findById(workflowId);
  if (!workflow || !workflow.enabled) return null;
  const payload = {
    routineId: routine._id.toString(),
    routineName: routine.name,
    prompt: routine.prompt,
    output,
  };
  return executeWorkflow(workflow, { type: 'routine', payload });
}

function isScheduleDue(node, workflow, now) {
  const data = node.data || {};
  if (now.getHours() !== data.hour || now.getMinutes() !== data.minute) return false;
  if (Array.isArray(data.daysOfWeek) && data.daysOfWeek.length > 0 && !data.daysOfWeek.includes(now.getDay())) return false;
  if (workflow.lastRunAt) {
    const last = new Date(workflow.lastRunAt);
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

export async function runScheduledWorkflowsCheck() {
  const now = new Date();
  const workflows = await Workflow.find({ enabled: true, 'nodes.type': 'schedule' });
  for (const workflow of workflows) {
    const scheduleNode = findStartNode(workflow, 'schedule');
    if (!scheduleNode || !isScheduleDue(scheduleNode, workflow, now)) continue;
    try {
      await executeWorkflow(workflow, { type: 'schedule', payload: {} });
    } catch (err) {
      console.error(`[workflows] "${workflow.name}" (schedule) falhou:`, err.message);
    }
  }
}
