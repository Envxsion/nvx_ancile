/**
 * Whether the sign-in gate is up (pro/gate.tsx). Its own module, with no
 * imports from the app, so lib/api.ts can raise it without an import cycle.
 */
import { create } from 'zustand';

export const useSignInGate = create<{ needed: boolean; raise(): void }>((set) => ({
  needed: false,
  raise: () => set({ needed: true }),
}));
