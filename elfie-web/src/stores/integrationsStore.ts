import { create } from 'zustand';
import { API_BASE } from '../constants';

export type IntegrationService = 'gmail' | 'calendar' | 'drive' | 'playconsole';

export interface IntegrationTool {
  name: string;
  label: string;
}

export interface Integration {
  service: IntegrationService;
  connected: boolean;
  googleEmail: string | null;
  connectedAt: string | null;
  scopes: string[];
  tools: IntegrationTool[];
}

interface IntegrationsStore {
  integrations: Integration[];
  loadIntegrations: () => Promise<void>;
  disconnect: (service: IntegrationService) => Promise<void>;
}

export const useIntegrationsStore = create<IntegrationsStore>((set, get) => ({
  integrations: [],
  loadIntegrations: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/integrations`);
      const integrations = await res.json();
      set({ integrations: Array.isArray(integrations) ? integrations : [] });
    } catch (err) {
      console.error('[loadIntegrations]', err);
    }
  },
  disconnect: async (service) => {
    try {
      await fetch(`${API_BASE}/api/integrations/${service}`, { method: 'DELETE' });
      await get().loadIntegrations();
    } catch (err) {
      console.error('[disconnect]', err);
    }
  },
}));
