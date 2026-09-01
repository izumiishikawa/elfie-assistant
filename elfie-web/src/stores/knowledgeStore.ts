import { create } from 'zustand';
import { API_BASE } from '../constants';

export interface KnowledgeFolder {
  name: string;
  description: string;
  tags: string[];
  files: string[];
}

export interface IngestStatus {
  status: 'queued' | 'enriching' | 'embedding' | 'done' | 'error' | 'unknown';
  updatedAt?: string;
  error?: string;
}

export interface KnowledgeSearchResult {
  id: string;
  text: string;
  contextPrefix: string;
  folder: string;
  file: string;
  tags: string[];
  entityNames: string[];
  rerankScore: number;
}

export interface KnowledgeTagInfo {
  name: string;
  description: string;
}

type ApiResult = { ok: boolean; error?: string };

interface KnowledgeStore {
  folders: KnowledgeFolder[];
  tags: KnowledgeTagInfo[];
  ingestStatus: Record<string, IngestStatus>;
  searchResults: KnowledgeSearchResult[];
  searching: boolean;

  loadFolders: () => Promise<void>;
  loadTags: () => Promise<void>;

  createFolder: (name: string, description: string, tags: string[]) => Promise<ApiResult>;
  updateFolder: (name: string, description: string, tags: string[]) => Promise<ApiResult>;
  deleteFolder: (name: string) => Promise<void>;

  getFileContent: (folder: string, file: string) => Promise<string | null>;
  saveFile: (folder: string, file: string, content: string) => Promise<ApiResult>;
  deleteFile: (folder: string, file: string) => Promise<void>;

  pollFileStatus: (folder: string, file: string) => Promise<IngestStatus>;

  search: (query: string) => Promise<void>;
  clearSearch: () => void;

  reindexAll: () => Promise<{ ok: boolean; filesIndexed?: number; error?: string }>;
}

const statusKey = (folder: string, file: string) => `${folder}/${file}`;

async function parseJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export const useKnowledgeStore = create<KnowledgeStore>((set, get) => ({
  folders: [],
  tags: [],
  ingestStatus: {},
  searchResults: [],
  searching: false,

  loadFolders: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge`);
      const folders = await res.json();
      set({ folders: Array.isArray(folders) ? folders : [] });
    } catch (err) {
      console.error('[loadFolders]', err);
    }
  },

  loadTags: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/tags`);
      const tags = await res.json();
      set({ tags: Array.isArray(tags) ? tags : [] });
    } catch (err) {
      console.error('[loadTags]', err);
    }
  },

  createFolder: async (name, description, tags) => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, tags }),
      });
      const data = await parseJson(res);
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao criar pasta.' };
      await get().loadFolders();
      return { ok: true };
    } catch (err) {
      console.error('[createFolder]', err);
      return { ok: false, error: 'Erro ao criar pasta.' };
    }
  },

  updateFolder: async (name, description, tags) => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/folders/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, tags }),
      });
      const data = await parseJson(res);
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao salvar pasta.' };
      await get().loadFolders();
      return { ok: true };
    } catch (err) {
      console.error('[updateFolder]', err);
      return { ok: false, error: 'Erro ao salvar pasta.' };
    }
  },

  deleteFolder: async (name) => {
    try {
      await fetch(`${API_BASE}/api/knowledge/folders/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await get().loadFolders();
    } catch (err) {
      console.error('[deleteFolder]', err);
    }
  },

  getFileContent: async (folder, file) => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/folders/${encodeURIComponent(folder)}/files/${encodeURIComponent(file)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content ?? '';
    } catch (err) {
      console.error('[getFileContent]', err);
      return null;
    }
  },

  saveFile: async (folder, file, content) => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/folders/${encodeURIComponent(folder)}/files/${encodeURIComponent(file)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await parseJson(res);
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao salvar arquivo.' };
      set((s) => ({ ingestStatus: { ...s.ingestStatus, [statusKey(folder, file)]: { status: 'queued' } } }));
      await get().loadFolders();
      return { ok: true };
    } catch (err) {
      console.error('[saveFile]', err);
      return { ok: false, error: 'Erro ao salvar arquivo.' };
    }
  },

  deleteFile: async (folder, file) => {
    try {
      await fetch(`${API_BASE}/api/knowledge/folders/${encodeURIComponent(folder)}/files/${encodeURIComponent(file)}`, { method: 'DELETE' });
      set((s) => {
        const next = { ...s.ingestStatus };
        delete next[statusKey(folder, file)];
        return { ingestStatus: next };
      });
      await get().loadFolders();
    } catch (err) {
      console.error('[deleteFile]', err);
    }
  },

  pollFileStatus: async (folder, file) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/knowledge/folders/${encodeURIComponent(folder)}/files/${encodeURIComponent(file)}/status`,
      );
      const data: IngestStatus = await res.json();
      set((s) => ({ ingestStatus: { ...s.ingestStatus, [statusKey(folder, file)]: data } }));
      return data;
    } catch (err) {
      console.error('[pollFileStatus]', err);
      return { status: 'unknown' };
    }
  },

  search: async (query) => {
    if (!query.trim()) {
      set({ searchResults: [], searching: false });
      return;
    }
    set({ searching: true });
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/search?q=${encodeURIComponent(query)}`);
      const results = await res.json();
      set({ searchResults: Array.isArray(results) ? results : [], searching: false });
    } catch (err) {
      console.error('[search]', err);
      set({ searching: false });
    }
  },

  clearSearch: () => set({ searchResults: [], searching: false }),

  reindexAll: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/reindex`, { method: 'POST' });
      const data = await parseJson(res);
      if (!res.ok) return { ok: false, error: data.error || 'Erro ao reindexar.' };
      await get().loadFolders();
      return { ok: true, filesIndexed: data.filesIndexed };
    } catch (err) {
      console.error('[reindexAll]', err);
      return { ok: false, error: 'Erro ao reindexar.' };
    }
  },
}));

export function ingestStatusKey(folder: string, file: string) {
  return statusKey(folder, file);
}
