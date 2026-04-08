'use client';

import { create } from 'zustand';
import { clearIntelAuth, loadIntelAuth, saveIntelAuth, type IntelAuth } from './authStorage';

type AuthState = {
  auth: IntelAuth | null;
  hydrated: boolean;
  hydrate: () => void;
  connect: (params: { apiBaseUrl: string; apiKey: string; remember?: boolean }) => void;
  disconnect: () => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  auth: null,
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    const a = loadIntelAuth();
    set({ auth: a, hydrated: true });
  },
  connect: ({ apiBaseUrl, apiKey, remember }) => {
    saveIntelAuth({ apiBaseUrl, apiKey }, !!remember);
    const a = loadIntelAuth();
    set({ auth: a, hydrated: true });
  },
  disconnect: () => {
    clearIntelAuth();
    set({ auth: null, hydrated: true });
  },
}));

