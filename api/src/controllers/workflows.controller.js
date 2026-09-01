import { randomBytes } from 'crypto';
import Workflow from '../models/Workflow.js';
import WorkflowRun from '../models/WorkflowRun.js';
import { runWorkflowManually } from '../workflows.js';

const FIELDS = ['name', 'enabled', 'characterId', 'nodes', 'edges'];

function validate(body, { partial = false } = {}) {
  if (!partial || body.name !== undefined) {
    if (!body.name || !body.name.trim()) return 'Nome obrigatório.';
  }
  if (body.nodes !== undefined && !Array.isArray(body.nodes)) return 'nodes inválido.';
  if (body.edges !== undefined && !Array.isArray(body.edges)) return 'edges inválido.';
  return null;
}

function ensureWebhookCredentials(workflow) {
  const hasWebhookNode = (workflow.nodes || []).some((n) => n.type === 'webhook');
  if (hasWebhookNode && !workflow.webhookToken) {
    workflow.webhookToken = randomBytes(32).toString('hex');
    workflow.webhookSecret = randomBytes(24).toString('hex');
  }
}

export async function listWorkflows(_req, res) {
  try {
    const workflows = await Workflow.find().sort({ name: 1 });
    res.json(workflows);
  } catch (err) {
    console.error('[listWorkflows]', err);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
}

export async function getWorkflow(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(workflow);
  } catch (err) {
    console.error('[getWorkflow]', err);
    res.status(500).json({ error: 'Failed to get workflow' });
  }
}

export async function createWorkflow(req, res) {
  try {
    const error = validate(req.body);
    if (error) return res.status(400).json({ error });
    const patch = {};
    for (const f of FIELDS) if (req.body[f] !== undefined) patch[f] = req.body[f];
    if (patch.name) patch.name = patch.name.trim();
    const workflow = new Workflow(patch);
    ensureWebhookCredentials(workflow);
    await workflow.save();
    res.status(201).json(workflow);
  } catch (err) {
    console.error('[createWorkflow]', err);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
}

export async function updateWorkflow(req, res) {
  try {
    const error = validate(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    for (const f of FIELDS) if (req.body[f] !== undefined) workflow[f] = req.body[f];
    if (workflow.name) workflow.name = workflow.name.trim();
    ensureWebhookCredentials(workflow);
    await workflow.save();
    res.json(workflow);
  } catch (err) {
    console.error('[updateWorkflow]', err);
    res.status(500).json({ error: 'Failed to update workflow' });
  }
}

export async function deleteWorkflow(req, res) {
  try {
    const workflow = await Workflow.findByIdAndDelete(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    await WorkflowRun.deleteMany({ workflowId: workflow._id });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[deleteWorkflow]', err);
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
}

export async function regenerateWebhook(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    workflow.webhookToken = randomBytes(32).toString('hex');
    workflow.webhookSecret = randomBytes(24).toString('hex');
    await workflow.save();
    res.json(workflow);
  } catch (err) {
    console.error('[regenerateWebhook]', err);
    res.status(500).json({ error: 'Failed to regenerate webhook credentials' });
  }
}

export async function runWorkflowNowController(req, res) {
  try {
    const run = await runWorkflowManually(req.params.id, req.body?.payload ?? {});
    res.json(run);
  } catch (err) {
    console.error('[runWorkflowNow]', err);
    res.status(500).json({ error: err.message || 'Failed to run workflow' });
  }
}

export async function listWorkflowRuns(req, res) {
  try {
    const runs = await WorkflowRun.find({ workflowId: req.params.id }).sort({ createdAt: -1 }).limit(50);
    res.json(runs);
  } catch (err) {
    console.error('[listWorkflowRuns]', err);
    res.status(500).json({ error: 'Failed to list workflow runs' });
  }
}

export async function getWorkflowRun(req, res) {
  try {
    const run = await WorkflowRun.findById(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    console.error('[getWorkflowRun]', err);
    res.status(500).json({ error: 'Failed to get workflow run' });
  }
}
