/**
 * Whether the "Connect this browser" screen is up (app/ConnectScreen.tsx). Its own module,
 * with no imports from the app, so lib/api.ts can raise it without an import cycle.
 */
import { create } from 'zustand';

export const useConnectGate = create<{ needed: boolean; raise(): void }>((set) => ({
  needed: false,
  raise: () => set({ needed: true }),
}));
