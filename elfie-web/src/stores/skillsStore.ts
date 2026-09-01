import { create } from 'zustand';
import { API_BASE } from '../constants';

export type SkillParamLocation = 'path' | 'query' | 'header' | 'body';
export type SkillParamType = 'string' | 'number' | 'boolean';
export type SkillAuthType = 'none' | 'bearer' | 'apiKeyHeader' | 'basic';
export type SkillMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SkillResponseMode = 'text' | 'image';

export interface SkillParam {
  name: string;
  in: SkillParamLocation;
  type: SkillParamType;
  required: boolean;
  description: string;
}

export interface SkillHeader {
  key: string;
  value: string;
}

export interface Skill {
  _id: string;
  name: string;
  description: string;
  packageId: string | null;
  method: SkillMethod;
  urlTemplate: string;
  authType: SkillAuthType;
  authHeaderName: string;
  hasAuthValue: boolean;
  headers: SkillHeader[];
  params: SkillParam[];
  timeoutMs: number;
  enabled: boolean;
  requiresConfirmation: boolean;
  alwaysVisible: boolean;
  responseMode: SkillResponseMode;
  imageUrlField: string;
}

export interface SkillPackage {
  _id: string;
  name: string;
  description: string;
}

interface SkillsStore {
  skills: Skill[];
  packages: SkillPackage[];
  loadSkills: () => Promise<void>;
  loadPackages: () => Promise<void>;
}

export const useSkillsStore = create<SkillsStore>((set) => ({
  skills: [],
  packages: [],
  loadSkills: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/skills`);
      const skills = await res.json();
      set({ skills: Array.isArray(skills) ? skills : [] });
    } catch (err) {
      console.error('[loadSkills]', err);
    }
  },
  loadPackages: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/skill-packages`);
      const packages = await res.json();
      set({ packages: Array.isArray(packages) ? packages : [] });
    } catch (err) {
      console.error('[loadPackages]', err);
    }
  },
}));
