/**
 * ------------------------------------------------------------------
 *  Title    |  File editor host
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Draws the code editor when a file is open (store.ts).
 *           |  Mounted once, in AppShell; the editor itself loads only
 *           |  when a file is first opened.
 * ------------------------------------------------------------------
 */

import { lazy, Suspense } from 'react';
import { useFileEditor } from './store';

const FileEditor = lazy(() => import('./FileEditor').then((m) => ({ default: m.FileEditor })));

export function FileEditorHost() {
  const open = useFileEditor((s) => s.open);
  const close = useFileEditor((s) => s.close);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <FileEditor key={`${open.path}\n${open.threadId ?? ''}`} file={open} onClose={close} />
    </Suspense>
  );
}
