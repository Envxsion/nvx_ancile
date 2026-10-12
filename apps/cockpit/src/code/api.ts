/**
 * ------------------------------------------------------------------
 *  Title    |  Code editor: Core calls
 *  Ref      |  docs/api.md (Files) · packages/contracts/src/files.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Read a file for the editor, and save it back.
 *  How      |  GET /files and PUT /files. Core runs the permission
 *           |  gate on both; a save it would ask about comes back as
 *           |  files.needs_confirm, which the editor turns into a
 *           |  "Save anyway" question (saveOutcome below).
 * ------------------------------------------------------------------
 */

import { FileContent, type FileWriteRequest, FileWriteResult } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiCallError, api } from '../lib/api';

export const fileKey = (path: string, threadId: string | null) => ['file', path, threadId] as const;

export function readFile(path: string, threadId: string | null): Promise<FileContent> {
  const q = new URLSearchParams({ path });
  if (threadId) q.set('thread_id', threadId);
  return api.get(`/files?${q}`, FileContent);
}

export function useFile(path: string, threadId: string | null) {
  return useQuery({
    queryKey: fileKey(path, threadId),
    queryFn: () => readFile(path, threadId),
    retry: false,
    // The file is the truth on disk: never show a cached copy as current.
    staleTime: 0,
    gcTime: 30_000,
  });
}

export type SaveOutcome =
  | { kind: 'saved'; sha256: string; bytes: number }
  | { kind: 'confirm'; reason: string }
  | { kind: 'changed' }
  | { kind: 'failed'; title: string; hint: string };

/** Save, and say what happened in the terms the editor shows. */
export async function saveFile(req: FileWriteRequest): Promise<SaveOutcome> {
  try {
    const r = await api.put('/files', req, FileWriteResult);
    return { kind: 'saved', sha256: r.sha256, bytes: r.bytes };
  } catch (err) {
    if (err instanceof ApiCallError) {
      const e = err.body.error;
      if (e.code === 'files.needs_confirm')
        return { kind: 'confirm', reason: String(e.context.reason ?? e.detail ?? e.title) };
      if (e.code === 'files.changed') return { kind: 'changed' };
      return { kind: 'failed', title: e.title, hint: e.hint };
    }
    return {
      kind: 'failed',
      title: 'The file could not be saved',
      hint: 'NVX Ancile is not answering. Check it is running, then save again.',
    };
  }
}
