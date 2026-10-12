/**
 * ------------------------------------------------------------------
 *  Title    |  Memory export and import: data
 *  Ref      |  docs/memory.md (Import and export) · contracts memory.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What Memory → Import and export reads and writes: the
 *           |  export plan and the download itself, an import's
 *           |  preview, its suggestions, and the one decision that
 *           |  commits the accepted ones.
 *  How      |  React Query over /api/v1/memory/export and
 *           |  /memory/imports. The export is fetched as a file and
 *           |  saved by the browser; the picked import file is read
 *           |  here (text, or base64 for a zip or a bundle) and only
 *           |  its contents and name are sent to Core.
 *  Note     |  Nothing in this module looks for files on its own: it
 *           |  only ever reads the one file the person picked.
 * ------------------------------------------------------------------
 */

import type {
  ApiError,
  MemoryExportFormat,
  MemoryExportPlan,
  MemoryImportDecision,
  MemoryImportDecisionResult,
  MemoryImportList,
  MemoryImportPreview,
  MemoryImportRequest,
  MemoryImportView,
} from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { API_BASE, ApiCallError, api, localError, newTraceparent } from '../lib/api';
import { queryClient } from '../lib/query';
import { refreshMemory } from './api';

export const transferKeys = {
  plan: ['memory', 'export-plan'] as const,
  imports: ['memory', 'imports'] as const,
  import: (id: string) => ['memory', 'imports', id] as const,
};

export const useExportPlan = () =>
  useQuery({ queryKey: transferKeys.plan, queryFn: () => api.get<MemoryExportPlan>('/memory/export/plan') });

export const useImports = () =>
  useQuery({ queryKey: transferKeys.imports, queryFn: () => api.get<MemoryImportList>('/memory/imports') });

export const useImport = (id: string | null) =>
  useQuery({
    queryKey: transferKeys.import(id ?? ''),
    queryFn: () => api.get<MemoryImportView>(`/memory/imports/${id}`),
    enabled: !!id,
  });

export interface ExportChoice {
  format: MemoryExportFormat;
  notebookId: string | null;
  leaveOutPrivate: boolean;
}

export function exportQuery(c: ExportChoice): string {
  const q = new URLSearchParams({ format: c.format });
  if (c.notebookId) q.set('notebook', c.notebookId);
  if (c.leaveOutPrivate && !c.notebookId) q.set('private', 'leave_out');
  return q.toString();
}

/** Fetch the export and hand it to the browser to save. Nothing is uploaded anywhere. */
export async function downloadExport(c: ExportChoice, save = saveBlob): Promise<string> {
  const { header, traceId } = newTraceparent();
  const res = await fetch(`${API_BASE}/memory/export?${exportQuery(c)}`, {
    credentials: 'same-origin',
    headers: { traceparent: header },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiCallError(
      res.status,
      body?.error
        ? body
        : localError('http.unexpected', 'The export did not arrive', 'Try again in a moment.', traceId),
    );
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ancile-memory';
  save(await res.blob(), name);
  return name;
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A picked file as the import request wants it: text, or base64 for a zip or a bundle. */
export async function readPicked(
  file: File,
): Promise<Pick<MemoryImportRequest, 'text' | 'data_base64' | 'filename'>> {
  const binary = /\.(zip|bundle)$/i.test(file.name);
  const read = <T extends string | ArrayBuffer>(as: 'text' | 'buffer') =>
    new Promise<T>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
      if (as === 'text') r.readAsText(file);
      else r.readAsArrayBuffer(file);
    });
  if (!binary) return { filename: file.name, text: await read<string>('text') };
  const bytes = new Uint8Array(await read<ArrayBuffer>('buffer'));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { filename: file.name, data_base64: btoa(s) };
}

export const previewImport = (req: MemoryImportRequest) =>
  api.post<MemoryImportPreview>('/memory/imports/preview', req);

export function useCreateImport() {
  return useMutation({
    mutationFn: (req: MemoryImportRequest) => api.post<MemoryImportView>('/memory/imports', req),
    onSuccess: (v) => {
      queryClient.setQueryData(transferKeys.import(v.id), v);
      void queryClient.invalidateQueries({ queryKey: transferKeys.imports });
    },
  });
}

export function useDecideImport(id: string) {
  return useMutation({
    mutationFn: (d: Partial<MemoryImportDecision>) =>
      api.post<MemoryImportDecisionResult>(`/memory/imports/${id}/decide`, d),
    onSuccess: (r) => {
      queryClient.setQueryData(transferKeys.import(id), r.import);
      void queryClient.invalidateQueries({ queryKey: transferKeys.imports });
      void refreshMemory();
    },
  });
}
