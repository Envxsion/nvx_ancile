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

import {
  BULK_MAX,
  type ContextLevel,
  type Note,
  type Notebook,
  type Source,
  type ThreadBulkResult,
} from '@nvx/contracts';
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

/**
 * Delete a notebook. With `everything`, its threads go to the Trash first (30 days, as any
 * deleted thread) and the sources no other notebook uses are deleted with it.
 */
export async function deleteNotebook(
  id: string,
  opts: { everything?: boolean; threadIds?: string[] } = {},
): Promise<boolean> {
  try {
    if (opts.everything) {
      const ids = opts.threadIds ?? [];
      let left = 0;
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const r = await api.post<ThreadBulkResult>('/threads/bulk', {
          action: 'delete',
          ids: ids.slice(i, i + BULK_MAX),
        });
        left += r.skipped.length;
      }
      if (left)
        notify({
          level: 'info',
          title:
            left === 1
              ? '1 thread was answering, so it stays in your sidebar'
              : `${left} threads were answering, so they stay in your sidebar`,
        });
    }
    await api.del(`/notebooks/${id}${opts.everything ? '?sources=delete' : ''}`);
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

/** Every cached list of sources: one source can sit in several notebooks. */
function eachSourceList(update: (list: SourceView[]) => SourceView[]): void {
  for (const [key, list] of queryClient.getQueriesData<SourceView[]>({ queryKey: ['sources'] }))
    if (list) queryClient.setQueryData(key, update(list));
}

/** Rename a source everywhere it is used. The new title sticks: re-reading it never overwrites it. */
export async function renameSource(sourceId: string, title: string): Promise<Source> {
  const next = title.trim();
  const before = queryClient.getQueriesData<SourceView[]>({ queryKey: ['sources'] });
  eachSourceList((list) => list.map((x) => (x.id === sourceId ? { ...x, title: next } : x)));
  try {
    const s = await api.patch<Source>(`/sources/${sourceId}`, { title: next });
    void queryClient.invalidateQueries({ queryKey: keys.source(sourceId) });
    return s;
  } catch (error) {
    for (const [key, list] of before) queryClient.setQueryData(key, list);
    report(error, 'Renaming the source');
    throw error;
  }
}

/** What a source's details dialog can set: tags, author, date and language. Null clears one. */
export interface SourceDetailsPatch {
  tags?: string[];
  author?: string | null;
  published_on?: string | null;
  language?: string | null;
}

/** Save a source's details everywhere it is listed; a failure puts the lists back and says so. */
export async function saveSourceDetails(sourceId: string, patch: SourceDetailsPatch): Promise<boolean> {
  const before = queryClient.getQueriesData<SourceView[]>({ queryKey: ['sources'] });
  eachSourceList((list) =>
    list.map((x) =>
      x.id === sourceId
        ? {
            ...x,
            ...(patch.tags && { tags: patch.tags }),
            ...('author' in patch && { author: patch.author ?? null }),
            ...('published_on' in patch && { publishedOn: patch.published_on ?? null }),
            ...('language' in patch && { language: patch.language ?? null }),
          }
        : x,
    ),
  );
  try {
    await api.patch<Source>(`/sources/${sourceId}`, patch);
    void queryClient.invalidateQueries({ queryKey: keys.source(sourceId) });
    void queryClient.invalidateQueries({ queryKey: ['sources'] });
    return true;
  } catch (error) {
    for (const [key, list] of before) queryClient.setQueryData(key, list);
    report(error, 'Saving the source details');
    return false;
  }
}

/**
 * Add and remove tags on many sources at once. Each source is saved on its own, so one that fails
 * (it was deleted meanwhile) never stops the rest; the notice says how many went and which did not.
 */
export async function tagSources(
  sources: readonly Pick<SourceView, 'id' | 'title' | 'tags'>[],
  add: string[],
  remove: string[],
): Promise<{ done: number; failed: string[] }> {
  const { editTags } = await import('../sources/tags');
  let done = 0;
  const failed: string[] = [];
  for (const s of sources) {
    const next = editTags(s.tags, add, remove);
    if (next.length === s.tags.length && next.every((t, i) => t === s.tags[i])) {
      done++;
      continue;
    }
    try {
      await api.patch<Source>(`/sources/${s.id}`, { tags: next });
      done++;
    } catch {
      failed.push(s.title);
    }
  }
  void queryClient.invalidateQueries({ queryKey: ['sources'] });
  const what = [
    add.length ? `added ${add.join(', ')}` : '',
    remove.length ? `removed ${remove.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  notify({
    level: failed.length ? 'warn' : 'success',
    title: `Tags ${what} on ${done} ${done === 1 ? 'source' : 'sources'}`,
    ...(failed.length && {
      body: `${failed.length} could not be saved and keep their old tags: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' and more' : ''}.`,
    }),
  });
  return { done, failed };
}

/**
 * Delete a source from the workspace: it leaves every notebook and search.
 * Answers that cited it keep the quoted passage and mark it "Source
 * removed" (Core keeps a tombstone). Knowledge keeps the file aside, but
 * nothing here brings it back, so the card asks first and offers no Undo.
 * TODO(phase-5): a restore route over Knowledge's soft delete, then Undo.
 */
export async function deleteSource(s: SourceView): Promise<void> {
  const before = queryClient.getQueriesData<SourceView[]>({ queryKey: ['sources'] });
  eachSourceList((list) => list.filter((x) => x.id !== s.id));
  try {
    await api.del(`/sources/${s.id}`);
    queryClient.removeQueries({ queryKey: keys.source(s.id) });
    queryClient.removeQueries({ queryKey: keys.sourceContent(s.id) });
    void queryClient.invalidateQueries({ queryKey: ['sources'] });
    // Answers that cited it now say so.
    void queryClient.invalidateQueries({ queryKey: ['citations'] });
    void refreshNotebooks();
    notify({ level: 'success', title: 'Source deleted', body: s.title });
  } catch (error) {
    for (const [key, list] of before) queryClient.setQueryData(key, list);
    report(error, 'Deleting the source');
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

/** SR1: read a scanned PDF with OCR, whatever the Sources setting says. */
export async function readWithOcr(notebookId: string, sourceId: string): Promise<void> {
  try {
    await api.post(`/sources/${sourceId}/ocr`);
    refreshSources(notebookId);
    notify({
      level: 'info',
      title: 'Reading it with OCR',
      body: 'Each page is read on this computer. You can keep working.',
    });
  } catch (error) {
    report(error, 'Reading with OCR');
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
    void queryClient.invalidateQueries({ queryKey: ['citations'] });
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
