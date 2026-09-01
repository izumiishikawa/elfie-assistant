import { create } from 'zustand';
import { API_BASE } from '../constants';

export interface Character {
  _id: string;
  name: string;
  personality: string;
  model: string;
  photo: string;
  userName: string;
  userBasicData: string;
  longTermMemory: string[];
}

interface SettingsStore {
  // active character fields (derived from activeCharacter)
  aiName: string;
  aiPhoto: string;
  // user fields
  userName: string;
  userPhoto: string;
  // characters
  characters: Character[];
  activeCharacterId: string | null;
  activeCharacter: Character | null;
  // actions
  setUserName: (name: string) => void;
  setUserPhoto: (photo: string) => void;
  loadSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  aiName: 'Elfie',
  aiPhoto: '',
  userName: '',
  userPhoto: '',
  characters: [],
  activeCharacterId: null,
  activeCharacter: null,
  setUserName: (userName) => set({ userName }),
  setUserPhoto: (userPhoto) => set({ userPhoto }),
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

      set({
        userName: settings.userName || '',
        userPhoto: settings.userPhoto || '',
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
