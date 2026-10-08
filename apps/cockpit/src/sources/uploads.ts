/**
 * ------------------------------------------------------------------
 *  Title    |  Upload queue
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Files on their way to Core, wherever they were dropped,
 *           |  carrying on while you close the dialog or change page.
 *  How      |  Three at a time; the rest wait. Each row shows its own
 *           |  upload progress, then hands over to the source's stages
 *           |  (reading, passages, indexing) in the sources list.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import { helpDone } from '../help/store';
import { tourEvent } from '../help/tours';
import { type UploadHandle, uploadFile } from '../lib/notebooks';
import { notify } from '../state/notify';

export interface Upload {
  id: string;
  notebookId: string;
  name: string;
  size: number;
  progress: number;
  state: 'waiting' | 'sending' | 'done' | 'failed' | 'cancelled';
}

const MAX_PARALLEL = 3;
export const MAX_BYTES = 200 * 1024 * 1024;

interface UploadState {
  items: Upload[];
  add: (notebookId: string, files: File[]) => void;
  cancel: (id: string) => void;
  clearDone: () => void;
}

const files = new Map<string, File>();
const handles = new Map<string, UploadHandle>();

export const useUploads = create<UploadState>((set, get) => {
  const patch = (id: string, p: Partial<Upload>) =>
    set((s) => ({ items: s.items.map((u) => (u.id === id ? { ...u, ...p } : u)) }));

  const pump = () => {
    const { items } = get();
    let sending = items.filter((u) => u.state === 'sending').length;
    for (const u of items) {
      if (sending >= MAX_PARALLEL) break;
      if (u.state !== 'waiting') continue;
      const file = files.get(u.id);
      if (!file) continue;
      sending++;
      patch(u.id, { state: 'sending' });
      const h = uploadFile(u.notebookId, file, (p) => patch(u.id, { progress: p }));
      handles.set(u.id, h);
      void h.done.then((source) => {
        handles.delete(u.id);
        files.delete(u.id);
        const cancelled = get().items.find((x) => x.id === u.id)?.state === 'cancelled';
        if (!cancelled) patch(u.id, { state: source ? 'done' : 'failed', progress: source ? 1 : u.progress });
        if (source) {
          helpDone('source');
          tourEvent('source-added');
        }
        // Finished rows leave on their own; failures stay until cleared.
        if (source) setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== u.id) })), 2_500);
        pump();
      });
    }
  };

  return {
    items: [],
    add: (notebookId, list) => {
      const accepted: Upload[] = [];
      for (const f of list) {
        if (f.size > MAX_BYTES) {
          notify({
            level: 'error',
            title: `${f.name} is too large`,
            body: 'Files up to 200 MB can be added. Split it, or add the parts you need.',
          });
          continue;
        }
        const id = crypto.randomUUID();
        files.set(id, f);
        accepted.push({ id, notebookId, name: f.name, size: f.size, progress: 0, state: 'waiting' });
      }
      if (!accepted.length) return;
      set((s) => ({ items: [...s.items, ...accepted] }));
      pump();
    },
    cancel: (id) => {
      handles.get(id)?.cancel();
      files.delete(id);
      set((s) => ({ items: s.items.filter((u) => u.id !== id) }));
      pump();
    },
    clearDone: () =>
      set((s) => ({ items: s.items.filter((u) => u.state === 'waiting' || u.state === 'sending') })),
  };
});
