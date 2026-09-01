import { create } from 'zustand';
import { API_BASE } from '../constants';

export interface Routine {
  _id: string;
  name: string;
  prompt: string;
  characterId: string | null;
  hour: number;
  minute: number;
  daysOfWeek: number[];
  runOnce: boolean;
  scheduledDate: string | null;
  enabled: boolean;
  notify: boolean;
  forceTts: boolean;
  triggeredWorkflowIds: string[];
  lastRunAt: string | null;
}

export type RoutineInput = Partial<Omit<Routine, '_id' | 'lastRunAt'>>;

interface RoutinesStore {
  routines: Routine[];
  loadRoutines: () => Promise<void>;
  createRoutine: (input: RoutineInput) => Promise<{ ok: boolean; error?: string }>;
  updateRoutine: (id: string, input: RoutineInput) => Promise<{ ok: boolean; error?: string }>;
  deleteRoutine: (id: string) => Promise<void>;
  runRoutineNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

export const useRoutinesStore = create<RoutinesStore>((set, get) => ({
  routines: [],
  loadRoutines: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/routines`);
      const routines = await res.json();
      set({ routines: Array.isArray(routines) ? routines : [] });
    } catch (err) {
      console.error('[loadRoutines]', err);
    }
  },
  createRoutine: async (input) => {
    try {
      const res = await fetch(`${API_BASE}/api/routines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao criar rotina.' };
      await get().loadRoutines();
      return { ok: true };
    } catch (err) {
      console.error('[createRoutine]', err);
      return { ok: false, error: 'Erro ao criar rotina.' };
    }
  },
  updateRoutine: async (id, input) => {
    try {
      const res = await fetch(`${API_BASE}/api/routines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao salvar rotina.' };
      await get().loadRoutines();
      return { ok: true };
    } catch (err) {
      console.error('[updateRoutine]', err);
      return { ok: false, error: 'Erro ao salvar rotina.' };
    }
  },
  deleteRoutine: async (id) => {
    try {
      await fetch(`${API_BASE}/api/routines/${id}`, { method: 'DELETE' });
      await get().loadRoutines();
    } catch (err) {
      console.error('[deleteRoutine]', err);
    }
  },
  runRoutineNow: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/routines/${id}/run`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao executar rotina.' };
      return { ok: true };
    } catch (err) {
      console.error('[runRoutineNow]', err);
      return { ok: false, error: 'Erro ao executar rotina.' };
    }
  },
}));
