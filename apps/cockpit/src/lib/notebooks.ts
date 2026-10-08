/**
 * ------------------------------------------------------------------
 *  Title    |  Notebooks, sources and notes: the actions
 *  Ref      |  ROADMAP.md Phase 3 · contracts/knowledge.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Make a notebook, fill it with sources (files, links,
 *           |  pasted text, past threads), decide how much of each a
 *           |  question may use, and keep notes beside them.
 *  How      |  Plain calls through lib/api.ts that refresh the queries
 *           |  they change. Uploads use XHR for real upload progress;
 *           |  after that the source's own stages report through
 *           |  source.progress events.
 * ------------------------------------------------------------------
 */

import type { ContextLevel, Note, Notebook, Source } from '@nvx/contracts';
import { notify } from '../state/notify';
import { API_BASE, ApiCallError, api, newTraceparent } from './api';
import { keys } from './data';
import { toSourceView } from './mappers';
import { queryClient } from './query';
import type { SourceView } from './types';

function report(error: unknown, what: string): void {
  if (error instanceof ApiCallError)
    notify({ level: 'error', title: error.body.error.title, body: error.body.error.hint });
  else
    notify({
      level: 'error',
      title: `${what} didn't reach Core`,
      body: 'Check that NVX Ancile is running, then try again.',
    });
}

const refreshNotebooks = () => queryClient.invalidateQueries({ queryKey: keys.notebooks });

export async function createNotebook(input: {
  title: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}): Promise<Notebook | null> {
  try {
    const nb = await api.post<Notebook>('/notebooks', input);
    void refreshNotebooks();
    return nb;
  } catch (error) {
    report(error, 'Creating the notebook');
    return null;
  }
}

export async function patchNotebook(
  id: string,
  patch: Partial<{
    title: string;
    description: string | null;
    color: string | null;
    icon: string | null;
    pinned: boolean;
    archived: boolean;
  }>,
): Promise<boolean> {
  try {
    await api.patch(`/notebooks/${id}`, patch);
    void refreshNotebooks();
    return true;
  } catch (error) {
    report(error, 'Saving the notebook');
    return false;
  }
}

export async function deleteNotebook(id: string): Promise<boolean> {
  try {
    await api.del(`/notebooks/${id}`);
    void refreshNotebooks();
    void queryClient.invalidateQueries({ queryKey: keys.threads });
    return true;
  } catch (error) {
    report(error, 'Deleting the notebook');
    return false;
  }
}

/* ---- Sources ------------------------------------------------------------ */

function placeSource(notebookId: string, s: SourceView): void {
  queryClient.setQueryData<SourceView[]>(keys.sources(notebookId), (list) =>
    list ? [s, ...list.filter((x) => x.id !== s.id)] : [s],
  );
}

const refreshSources = (notebookId: string) => {
  void queryClient.invalidateQueries({ queryKey: keys.sources(notebookId) });
  void refreshNotebooks();
};

export async function addLink(notebookId: string, url: string): Promise<SourceView | null> {
  try {
    const s = toSourceView(await api.post<Source>('/sources', { kind: 'url', url, notebook_id: notebookId }));
    placeSource(notebookId, s);
    refreshSources(notebookId);
    return s;
  } catch (error) {
    report(error, 'Adding the link');
    return null;
  }
}

export async function addText(notebookId: string, text: string, title?: string): Promise<SourceView | null> {
  try {
    const s = toSourceView(
      await api.post<Source>('/sources', {
        kind: 'text',
        text,
        notebook_id: notebookId,
        ...(title && { title }),
      }),
    );
    placeSource(notebookId, s);
    refreshSources(notebookId);
    return s;
  } catch (error) {
    report(error, 'Adding the text');
    return null;
  }
}

export async function addThread(notebookId: string, threadId: string): Promise<SourceView | null> {
  try {
    const s = toSourceView(
      await api.post<Source>('/sources', { kind: 'thread', thread_id: threadId, notebook_id: notebookId }),
    );
    placeSource(notebookId, s);
    refreshSources(notebookId);
    return s;
  } catch (error) {
    report(error, 'Adding the thread');
    return null;
  }
}

export interface UploadHandle {
  done: Promise<SourceView | null>;
  cancel: () => void;
}

/** One file, with upload progress 0..1 before the source's own stages take over. */
export function uploadFile(notebookId: string, file: File, onProgress: (p: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('notebook_id', notebookId);
  const done = new Promise<SourceView | null>((resolve) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const s = toSourceView(body as Source);
        placeSource(notebookId, s);
        refreshSources(notebookId);
        resolve(s);
        return;
      }
      const err = (body as { error?: { title?: string; hint?: string } } | null)?.error;
      notify({
        level: 'error',
        title: err?.title ?? `${file.name} could not be added`,
        body: err?.hint ?? 'Check the file opens on this computer, then try again.',
      });
      resolve(null);
    };
    xhr.onerror = () => {
      report(null, `Uploading ${file.name}`);
      resolve(null);
    };
    xhr.onabort = () => resolve(null);
  });
  xhr.open('POST', `${API_BASE}/sources`);
  xhr.setRequestHeader('traceparent', newTraceparent().header);
  xhr.setRequestHeader('accept', 'application/json');
  xhr.send(form);
  return { done, cancel: () => xhr.abort() };
}

export async function setContextLevel(notebookId: string, sourceId: string, level: ContextLevel) {
  const before = queryClient.getQueryData<SourceView[]>(keys.sources(notebookId));
  queryClient.setQueryData<SourceView[]>(keys.sources(notebookId), (list) =>
    list?.map((s) => (s.id === sourceId ? { ...s, contextLevel: level } : s)),
  );
  try {
    await api.patch(`/notebooks/${notebookId}/sources/${sourceId}`, { context_level: level });
  } catch (error) {
    queryClient.setQueryData(keys.sources(notebookId), before);
    report(error, 'Changing what questions can use');
  }
}

export async function removeSource(notebookId: string, s: SourceView): Promise<void> {
  const before = queryClient.getQueryData<SourceView[]>(keys.sources(notebookId));
  queryClient.setQueryData<SourceView[]>(keys.sources(notebookId), (list) =>
    list?.filter((x) => x.id !== s.id),
  );
  try {
    await api.del(`/notebooks/${notebookId}/sources/${s.id}`);
    void refreshNotebooks();
    notify({
      level: 'success',
      title: 'Removed from the notebook',
      body: s.title,
      undo: () =>
        void api
          .put(`/notebooks/${notebookId}/sources/${s.id}`, { context_level: s.contextLevel })
          .then(() => refreshSources(notebookId))
          .catch((e: unknown) => report(e, 'Putting it back')),
    });
  } catch (error) {
    queryClient.setQueryData(keys.sources(notebookId), before);
    report(error, 'Removing the source');
  }
}

export async function retrySource(notebookId: string, sourceId: string): Promise<void> {
  try {
    await api.post(`/sources/${sourceId}/retry`);
    refreshSources(notebookId);
  } catch (error) {
    report(error, 'Retrying');
  }
}

export async function refetchSource(notebookId: string, sourceId: string): Promise<void> {
  try {
    await api.post(`/sources/${sourceId}/refetch`);
    refreshSources(notebookId);
    notify({
      level: 'info',
      title: 'Fetching it again',
      body: 'Answers will use the new version once it is read.',
    });
  } catch (error) {
    report(error, 'Refetching');
  }
}

export async function mergeSources(notebookId: string, keepId: string, dropId: string): Promise<void> {
  try {
    await api.post('/sources/merge', { keep_id: keepId, drop_id: dropId });
    refreshSources(notebookId);
    notify({
      level: 'success',
      title: 'Merged',
      body: 'The duplicate is gone; its notebooks now use the original.',
    });
  } catch (error) {
    report(error, 'Merging');
  }
}

export async function dismissDuplicate(notebookId: string, a: string, b: string): Promise<void> {
  try {
    await api.post('/sources/duplicates/dismiss', { a_id: a, b_id: b });
    refreshSources(notebookId);
  } catch (error) {
    report(error, 'Keeping both');
  }
}

/* ---- Notes -------------------------------------------------------------- */

export async function createNote(notebookId: string, title: string, content = ''): Promise<Note | null> {
  try {
    const n = await api.post<Note>(`/notebooks/${notebookId}/notes`, { title, content_md: content });
    void queryClient.invalidateQueries({ queryKey: keys.notes(notebookId) });
    void refreshNotebooks();
    return n;
  } catch (error) {
    report(error, 'Creating the note');
    return null;
  }
}

export async function saveNote(
  notebookId: string,
  noteId: string,
  patch: Partial<{ title: string; content_md: string; pinned: boolean }>,
): Promise<boolean> {
  try {
    await api.patch(`/notes/${noteId}`, patch);
    void queryClient.invalidateQueries({ queryKey: keys.notes(notebookId) });
    return true;
  } catch (error) {
    report(error, 'Saving the note');
    return false;
  }
}

export async function deleteNote(notebookId: string, noteId: string): Promise<void> {
  try {
    await api.del(`/notes/${noteId}`);
    void queryClient.invalidateQueries({ queryKey: keys.notes(notebookId) });
    void refreshNotebooks();
  } catch (error) {
    report(error, 'Deleting the note');
  }
}

/** Keep an answer: it becomes a note in the notebook, with a link back. */
export async function saveAnswerAsNote(
  messageId: string,
  notebookId: string,
  title?: string,
): Promise<boolean> {
  try {
    await api.post(`/messages/${messageId}/to-note`, { notebook_id: notebookId, ...(title && { title }) });
    void queryClient.invalidateQueries({ queryKey: keys.notes(notebookId) });
    void refreshNotebooks();
    notify({ level: 'success', title: 'Saved as a note' });
    return true;
  } catch (error) {
    report(error, 'Saving the note');
    return false;
  }
}
