/**
 * ------------------------------------------------------------------
 *  Title    |  First run: bring my chats
 *  Ref      |  ROADMAP SU1 · packages/contracts/src/chatimport.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Bring chats from ChatGPT, Claude or Open WebUI into
 *           |  NVX Ancile on first run, with progress, and without
 *           |  waiting for it: the import carries on in the
 *           |  background and after a restart.
 *  How      |  Pick or drop the export (conversations.json, or the
 *           |  .zip it came in). It uploads once, then GET
 *           |  /imports/chats/:id is followed every second until the
 *           |  job ends. A job already running (the page was reloaded)
 *           |  is found again from GET /imports/chats.
 *  Note     |  Where to find each tool's export is said in words
 *           |  beside the picker. Skipping costs nothing: the same
 *           |  panel can be used any time the file is to hand.
 * ------------------------------------------------------------------
 */

import { CHAT_ORIGIN_LABEL, type ChatImport } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { API_BASE, api, newTraceparent } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import '../styles/setup.css';
import { Icon } from '../ui/Icon';

const ACTIVE = new Set<ChatImport['status']>(['queued', 'running']);

/** "Brought in 120 of 480 chats" with what was left alone, in plain words. */
export function progressWords(j: ChatImport): string {
  const parts = [`${j.done.toLocaleString('en-GB')} of ${j.total.toLocaleString('en-GB')} looked at`];
  if (j.imported) parts.push(`${j.imported.toLocaleString('en-GB')} brought in`);
  if (j.duplicates) parts.push(`${j.duplicates.toLocaleString('en-GB')} already here`);
  if (j.empty) parts.push(`${j.empty.toLocaleString('en-GB')} empty`);
  return parts.join(', ');
}

export function useChatImports() {
  return useQuery({
    queryKey: ['imports', 'chats'],
    queryFn: () => api.get<{ items: ChatImport[] }>('/imports/chats').then((r) => r.items),
    // Follow a job that is still going; a finished list is left alone.
    refetchInterval: (q) => (q.state.data?.some((j) => ACTIVE.has(j.status)) ? 1_000 : false),
  });
}

interface Failed {
  title: string;
  hint: string;
}

/** Send the file once. Progress is the upload's; the job's own progress is followed afterwards. */
function upload(file: File, onProgress: (p: number) => void): Promise<ChatImport | Failed> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as ChatImport);
      const err = (body as { error?: Partial<Failed> } | null)?.error;
      resolve({
        title: err?.title ?? 'That file could not be brought in',
        hint: err?.hint ?? 'Check the file, then try again.',
      });
    };
    xhr.onerror = () =>
      resolve({
        title: 'NVX Ancile did not answer',
        hint: 'Check that NVX Ancile is running, then try again.',
      });
    xhr.open('POST', `${API_BASE}/imports/chats`);
    xhr.setRequestHeader('traceparent', newTraceparent().header);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.send(form);
  });
}

const WHERE: [string, string][] = [
  ['ChatGPT', 'Settings, Data controls, Export data. The email brings a zip.'],
  ['Claude', 'Settings, Privacy, Export data. The email brings a zip.'],
  ['Open WebUI', 'Settings, Chats, Export chats. It saves a .json file.'],
];

export function ChatImportPanel() {
  const jobs = useChatImports();
  const [sending, setSending] = useState<number | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const latest = jobs.data?.[0];

  const send = async (file: File | undefined) => {
    if (!file) return;
    setFailed(null);
    setSending(0);
    const r = await upload(file, setSending);
    setSending(null);
    if ('title' in r) setFailed(r);
    else void queryClient.invalidateQueries({ queryKey: ['imports', 'chats'] });
  };

  const cancel = async (id: string) => {
    await api.post(`/imports/chats/${id}/cancel`).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['imports', 'chats'] });
  };

  // Threads appear in the sidebar as they come in.
  const running = !!latest && ACTIVE.has(latest.status);
  const doneCount = latest?.done ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new count is the reason to look again
  useEffect(() => {
    if (running || latest?.status === 'done') void queryClient.invalidateQueries({ queryKey: keys.threads });
  }, [running, doneCount, latest?.status]);

  return (
    <div className="chatimp">
      <p className="mute">
        Your chats become threads you can search and continue here. Nothing is sent anywhere, and a chat is
        never brought in twice.
      </p>
      <ul className="chatimp__where">
        {WHERE.map(([tool, how]) => (
          <li key={tool}>
            <strong>{tool}:</strong> {how}
          </li>
        ))}
      </ul>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside opens the file picker */}
      <div
        className="chatimp__drop"
        data-over={over || undefined}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files[0]);
        }}
      >
        <button
          type="button"
          className="btn"
          disabled={sending !== null}
          onClick={() => input.current?.click()}
        >
          <Icon name="upload" size={14} />
          {sending !== null ? 'Sending' : 'Choose the export'}
        </button>
        <span className="mute">or drop the .zip or .json here</span>
        <input
          ref={input}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          hidden
          onChange={(e) => {
            void send(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {sending !== null ? (
        <div
          className="chatimp__bar"
          role="progressbar"
          aria-label="Sending the export"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(sending * 100)}
        >
          <span style={{ transform: `scaleX(${sending})` }} />
        </div>
      ) : null}

      {failed ? (
        <p className="chatimp__fail" role="alert">
          <strong>{failed.title}.</strong> {failed.hint}
        </p>
      ) : null}

      {latest ? <JobStatus job={latest} onCancel={() => void cancel(latest.id)} /> : null}
    </div>
  );
}

function JobStatus({ job, onCancel }: { job: ChatImport; onCancel: () => void }) {
  const active = ACTIVE.has(job.status);
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className="chatimp__job" data-status={job.status}>
      {active ? (
        <div
          className="chatimp__bar"
          role="progressbar"
          aria-label={`Bringing in ${CHAT_ORIGIN_LABEL[job.origin]} chats`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ transform: `scaleX(${job.total ? job.done / job.total : 0})` }} />
        </div>
      ) : null}
      <p role="status" aria-live="polite">
        {job.status === 'done'
          ? `Done. ${job.imported.toLocaleString('en-GB')} ${job.imported === 1 ? 'chat is' : 'chats are'} in your sidebar${job.duplicates ? `, and ${job.duplicates.toLocaleString('en-GB')} were already here` : ''}.`
          : job.status === 'cancelled'
            ? `Stopped. ${progressWords(job)}.`
            : job.status === 'failed'
              ? `${job.error?.title ?? 'The import stopped'}. ${job.error?.hint ?? ''}`
              : `${CHAT_ORIGIN_LABEL[job.origin]} chats: ${progressWords(job)}.`}
      </p>
      {active ? (
        <p className="mute chatimp__note">
          You can carry on: this keeps going in the background, and picks up where it stopped if NVX Ancile
          restarts.
        </p>
      ) : null}
      {active ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Stop
        </button>
      ) : null}
    </div>
  );
}
