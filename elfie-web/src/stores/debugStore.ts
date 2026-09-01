import { create } from 'zustand';

interface LogEntry {
  id: number;
  level: 'info' | 'error';
  message: string;
  time: string;
}

interface DebugStore {
  logs: LogEntry[];
  log: (message: string) => void;
  error: (message: string) => void;
  clear: () => void;
}

let counter = 0;

export const useDebugStore = create<DebugStore>((set) => ({
  logs: [],
  log: (message) =>
    set((s) => ({
      logs: [
        { id: ++counter, level: 'info' as const, message, time: new Date().toLocaleTimeString() },
        ...s.logs,
      ].slice(0, 50),
    })),
  error: (message) =>
    set((s) => ({
      logs: [
        { id: ++counter, level: 'error' as const, message, time: new Date().toLocaleTimeString() },
        ...s.logs,
      ].slice(0, 50),
    })),
  clear: () => set({ logs: [] }),
}));
