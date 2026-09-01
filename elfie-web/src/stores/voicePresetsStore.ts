import { create } from 'zustand';
import { API_BASE } from '../constants';

export type VoiceProvider = 'elevenlabs' | 'fishaudio';

export interface VoicePreset {
  _id: string;
  name: string;
  voiceId: string;
  provider: VoiceProvider;
}

interface VoicePresetsStore {
  voicePresets: VoicePreset[];
  loadVoicePresets: () => Promise<void>;
}

export const useVoicePresetsStore = create<VoicePresetsStore>((set) => ({
  voicePresets: [],
  loadVoicePresets: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/voice-presets`);
      const voicePresets = await res.json();
      set({ voicePresets: Array.isArray(voicePresets) ? voicePresets : [] });
    } catch (err) {
      console.error('[loadVoicePresets]', err);
    }
  },
}));
