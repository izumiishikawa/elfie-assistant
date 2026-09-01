import { create } from 'zustand';
import { API_BASE } from '../constants';

export type WorkflowNodeType = 'webhook' | 'schedule' | 'routine' | 'prompt' | 'condition' | 'http_request';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: Record<string, any>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: 'true' | 'false' | null;
}

export interface Workflow {
  _id: string;
  name: string;
  enabled: boolean;
  characterId: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  webhookToken: string | null;
  webhookSecret: string | null;
  lastRunAt: string | null;
}

export type WorkflowInput = Partial<Omit<Workflow, '_id' | 'webhookToken' | 'webhookSecret' | 'lastRunAt'>>;

export interface WorkflowRunStep {
  nodeId: string;
  nodeType: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'success' | 'error' | 'skipped';
  output: any;
  error: string | null;
}

export interface WorkflowRun {
  _id: string;
  workflowId: string;
  trigger: { type: string; payload: any };
  status: 'running' | 'success' | 'error';
  steps: WorkflowRunStep[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface WorkflowsStore {
  workflows: Workflow[];
  runs: Record<string, WorkflowRun[]>;
  loadWorkflows: () => Promise<void>;
  createWorkflow: (input: WorkflowInput) => Promise<{ ok: boolean; error?: string; workflow?: Workflow }>;
  updateWorkflow: (id: string, input: WorkflowInput) => Promise<{ ok: boolean; error?: string; workflow?: Workflow }>;
  deleteWorkflow: (id: string) => Promise<void>;
  runWorkflowNow: (id: string, payload?: any) => Promise<{ ok: boolean; error?: string; run?: WorkflowRun }>;
  loadRuns: (id: string) => Promise<void>;
  regenerateWebhook: (id: string) => Promise<{ ok: boolean; error?: string; workflow?: Workflow }>;
}

export const useWorkflowsStore = create<WorkflowsStore>((set, get) => ({
  workflows: [],
  runs: {},
  loadWorkflows: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows`);
      const workflows = await res.json();
      set({ workflows: Array.isArray(workflows) ? workflows : [] });
    } catch (err) {
      console.error('[loadWorkflows]', err);
    }
  },
  createWorkflow: async (input) => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao criar automação.' };
      await get().loadWorkflows();
      return { ok: true, workflow: data };
    } catch (err) {
      console.error('[createWorkflow]', err);
      return { ok: false, error: 'Erro ao criar automação.' };
    }
  },
  updateWorkflow: async (id, input) => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao salvar automação.' };
      await get().loadWorkflows();
      return { ok: true, workflow: data };
    } catch (err) {
      console.error('[updateWorkflow]', err);
      return { ok: false, error: 'Erro ao salvar automação.' };
    }
  },
  deleteWorkflow: async (id) => {
    try {
      await fetch(`${API_BASE}/api/workflows/${id}`, { method: 'DELETE' });
      await get().loadWorkflows();
    } catch (err) {
      console.error('[deleteWorkflow]', err);
    }
  },
  runWorkflowNow: async (id, payload) => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: payload ?? {} }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao testar automação.' };
      await get().loadRuns(id);
      return { ok: true, run: data };
    } catch (err) {
      console.error('[runWorkflowNow]', err);
      return { ok: false, error: 'Erro ao testar automação.' };
    }
  },
  loadRuns: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${id}/runs`);
      const runs = await res.json();
      set((state) => ({ runs: { ...state.runs, [id]: Array.isArray(runs) ? runs : [] } }));
    } catch (err) {
      console.error('[loadRuns]', err);
    }
  },
  regenerateWebhook: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${id}/regenerate-webhook`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao regenerar webhook.' };
      await get().loadWorkflows();
      return { ok: true, workflow: data };
    } catch (err) {
      console.error('[regenerateWebhook]', err);
      return { ok: false, error: 'Erro ao regenerar webhook.' };
    }
  },
}));
