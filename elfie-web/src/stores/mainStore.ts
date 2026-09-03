import { create } from 'zustand';
import { API_BASE } from '../constants';
import { applyAccentColor, DEFAULT_ACCENT_COLOR } from '../utils/accentColor';

export interface Character {
  _id: string;
  name: string;
  personality: string;
  model: string;
  photo: string;
  voiceId: string;
  userName: string;
  userBasicData: string;
  longTermMemory: string[];
  greatSageWarnings: boolean;
}

interface SettingsStore {
  aiName: string;
  aiPhoto: string;
  userName: string;
  userPhoto: string;
  accentColor: string;
  llmProvider: 'openrouter' | 'deepseek';
  characters: Character[];
  activeCharacterId: string | null;
  activeCharacter: Character | null;
  setUserName: (name: string) => void;
  setUserPhoto: (photo: string) => void;
  setAccentColor: (color: string) => void;
  loadSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  aiName: 'Elfie',
  aiPhoto: '',
  userName: '',
  userPhoto: '',
  accentColor: DEFAULT_ACCENT_COLOR,
  llmProvider: 'openrouter',
  characters: [],
  activeCharacterId: null,
  activeCharacter: null,
  setUserName: (userName) => set({ userName }),
  setUserPhoto: (userPhoto) => set({ userPhoto }),
  setAccentColor: (accentColor) => {
    applyAccentColor(accentColor);
    set({ accentColor });
  },
  loadSettings: async () => {
    try {
      const [settingsRes, charsRes] = await Promise.all([
        fetch(`${API_BASE}/api/settings`),
        fetch(`${API_BASE}/api/characters`),
      ]);
      const settings = await settingsRes.json();
      const { characters, activeCharacterId } = await charsRes.json();
      const active: Character | null =
        characters.find((c: Character) => c._id === String(activeCharacterId)) ?? characters[0] ?? null;
      const accentColor = settings.accentColor || DEFAULT_ACCENT_COLOR;
      applyAccentColor(accentColor);
      set({
        userName: settings.userName || '',
        userPhoto: settings.userPhoto || '',
        accentColor,
        llmProvider: settings.llmProvider === 'deepseek' ? 'deepseek' : 'openrouter',
        characters: characters ?? [],
        activeCharacterId: String(activeCharacterId) || null,
        activeCharacter: active,
        aiName: active?.name || 'Elfie',
        aiPhoto: active?.photo || '',
      });
    } catch (err) {
      console.error('[loadSettings]', err);
    }
  },
}));
