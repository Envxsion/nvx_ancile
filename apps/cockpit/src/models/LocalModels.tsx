/**
 * ------------------------------------------------------------------
 *  Title    |  Download a local model
 *  Ref      |  docs/models.md (Download a local model) · ROADMAP track E
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One click from Admin → Models to a model running on this
 *           |  computer: the recommended list, what each is good for,
 *           |  its size and licence, and a plain answer to "will it
 *           |  fit?" before anything is downloaded.
 *  How      |  GET /local-models (polled each second while a download
 *           |  runs). Download, Cancel and Resume post to Core, which
 *           |  asks Ollama (or, for the search embedder, the knowledge
 *           |  service). When a download is done the model is in every
 *           |  picker: this dialog says so and offers nothing more.
 *  Note     |  Ollama is never installed from here. When it is missing,
 *           |  the dialog links to its official download page and, on
 *           |  Linux, shows the official command to copy.
 * ------------------------------------------------------------------
 */

import type { LocalDownload, LocalModelsView, LocalModelView } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';

export const useLocalModelsDialog = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

const KEY = ['local-models'] as const;
const ACTIVE = new Set<LocalDownload['status']>(['starting', 'downloading', 'verifying']);

export const isActive = (d: LocalDownload | null | undefined) => !!d && ACTIVE.has(d.status);

export function useLocalModels(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<LocalModelsView>('/local-models'),
    enabled,
    refetchInterval: (q) => (q.state.data?.items.some((i) => isActive(i.download)) ? 1_000 : false),
  });
}

const gb = (n: number) => (n < 1 ? `${Math.round(n * 1024)} MB` : `${Math.round(n * 10) / 10} GB`);
const bytes = (n: number) => gb(n / 1024 ** 3);

/** "2.1 GB of 5.2 GB", or what Ollama is doing when it has not said a size. */
export function progressWords(d: LocalDownload): string {
  if (d.status === 'starting') return 'Starting';
  if (d.status === 'verifying') return 'Checking it is complete';
  if (d.total && d.completed !== null) return `${bytes(d.completed)} of ${bytes(d.total)}`;
  return d.step ? d.step.charAt(0).toUpperCase() + d.step.slice(1) : 'Downloading';
}

const VERDICT: Record<LocalModelView['fit']['verdict'], { label: string; tone: string }> = {
  good: { label: 'Fits well', tone: 'ok' },
  slow: { label: 'Fits, but slow', tone: 'warn' },
  no: { label: "Won't fit", tone: 'fail' },
  unknown: { label: 'Cannot check', tone: 'idle' },
};

function errorWords(e: unknown) {
  return e instanceof ApiCallError
    ? { title: e.body.error.title, body: e.body.error.hint }
    : { title: 'That did not start', body: 'Check NVX Ancile is running, then try again.' };
}

function useStart() {
  return useMutation({
    mutationFn: (v: { id: string; anyway?: boolean }) =>
      api.post<LocalDownload>(`/local-models/${v.id}/download`, { anyway: v.anyway ?? false }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => notify({ level: 'error', ...errorWords(e) }),
  });
}

function useCancel() {
  return useMutation({
    mutationFn: (id: string) => api.post<LocalDownload>(`/local-models/downloads/${id}/cancel`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => notify({ level: 'error', ...errorWords(e) }),
  });
}

function OllamaBanner({ view }: { view: LocalModelsView }) {
  const o = view.ollama;
  if (o.status === 'running') return null;
  const title =
    o.status === 'installed'
      ? 'Ollama is installed but not running'
      : o.status === 'remote_unreachable'
        ? `Ollama at ${o.url} is not answering`
        : 'Ollama is not installed';
  const body =
    o.status === 'installed'
      ? 'Open Ollama (or run "ollama serve"), then check again.'
      : o.status === 'remote_unreachable'
        ? 'Check that computer is on and Ollama is running there.'
        : 'Chat models download through Ollama, a free app. NVX Ancile never installs it for you: get it from its official page, open it, then check again.';
  return (
    <div className="local-models__banner" role="status">
      <Icon name="warn" size={14} />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
        {o.status === 'missing' ? (
          <div className="local-models__banner-actions">
            <a className="btn btn--ghost btn--sm" href={o.download_url} target="_blank" rel="noreferrer">
              <Icon name="ext" size={12} />
              Get Ollama from ollama.com
            </a>
            {o.install_command ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(o.install_command as string)
                    .then(() => notify({ level: 'success', title: 'Install command copied' }))
                }
              >
                <Icon name="copy" size={12} />
                Copy the install command
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => void queryClient.invalidateQueries({ queryKey: KEY })}
      >
        Check again
      </button>
    </div>
  );
}

function Row({ m, ollamaRunning }: { m: LocalModelView; ollamaRunning: boolean }) {
  const start = useStart();
  const cancel = useCancel();
  const d = m.download;
  const verdict = VERDICT[m.fit.verdict];
  const ready = m.installed && !!m.model_id;
  const pct = d?.total && d.completed !== null ? Math.round((d.completed / d.total) * 100) : null;
  const needsOllama = m.via === 'ollama' && !ollamaRunning;
  const stopped = d && (d.status === 'failed' || d.status === 'cancelled');

  let action: ReactNode;
  if (ready)
    action = (
      <span className="local-models__ready">
        <Icon name="check" size={12} /> In your model picker
      </span>
    );
  else if (isActive(d))
    action = (
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => cancel.mutate((d as LocalDownload).id)}
      >
        Cancel
      </button>
    );
  else if (m.fit.blocker === 'disk')
    action = (
      <button type="button" className="btn btn--ghost btn--sm" disabled>
        Not enough disk
      </button>
    );
  else if (m.fit.verdict === 'no')
    action = (
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={needsOllama || start.isPending}
        onClick={() => {
          if (
            window.confirm(
              `${m.name} needs more memory than this computer has. It may not run at all. Download it anyway?`,
            )
          )
            start.mutate({ id: m.id, anyway: true });
        }}
      >
        Download anyway
      </button>
    );
  else
    action = (
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={needsOllama || start.isPending}
        onClick={() => start.mutate({ id: m.id })}
      >
        <Icon name="download" size={12} />
        {stopped ? 'Resume' : `Download ${gb(m.size_gb)}`}
      </button>
    );

  return (
    <li className="local-models__row" data-fit={m.fit.verdict}>
      <div className="local-models__main">
        <div className="local-models__name">
          <strong>{m.name}</strong>
          {m.recommended ? <span className="tag local-models__pick">Recommended</span> : null}
          {m.kind === 'embedder' ? <span className="tag">Search embedder</span> : null}
        </div>
        <p className="local-models__for">{m.good_for}</p>
        <p className="mute local-models__facts">
          {gb(m.size_gb)} download · about {gb(m.ram_gb)} of memory
          {m.vram_gb ? ` or ${gb(m.vram_gb)} on a graphics card` : ''} ·{' '}
          {m.licence_url ? (
            <a href={m.licence_url} target="_blank" rel="noreferrer">
              {m.licence}
            </a>
          ) : (
            m.licence
          )}
        </p>
        <p className="local-models__fit" data-tone={verdict.tone}>
          <span className="local-models__verdict">{verdict.label}</span> {m.fit.reasons.join(' ')}
        </p>
        {d && isActive(d) ? (
          <div className="local-models__progress">
            <div
              className="local-models__bar"
              role="progressbar"
              aria-label={`Downloading ${m.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(pct !== null && { 'aria-valuenow': pct })}
            >
              <span style={{ width: `${pct ?? 6}%` }} data-indeterminate={pct === null || undefined} />
            </div>
            <span className="mute" data-num>
              {progressWords(d)}
            </span>
          </div>
        ) : null}
        {d?.status === 'failed' && d.error ? (
          <p className="local-models__error" role="alert">
            {d.error.title}. {d.error.hint}
          </p>
        ) : null}
        {d?.status === 'cancelled' ? (
          <p className="mute local-models__note">
            Stopped. Resume carries on from what was already downloaded.
          </p>
        ) : null}
      </div>
      <div className="local-models__action">{action}</div>
    </li>
  );
}

export function LocalModelsDialog() {
  const { open, hide } = useLocalModelsDialog();
  useLayer(open);
  const view = useLocalModels(open);
  const hw = view.data?.hardware;
  const done = view.data?.items.filter((i) => i.download?.status === 'done').length ?? 0;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (o) return;
        hide();
        // Anything that finished is in the pickers now.
        if (done) void queryClient.invalidateQueries({ queryKey: keys.models });
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog local-models m-glass-thick" aria-describedby="local-models-desc">
          <header className="dialog__head">
            <Dialog.Title className="dialog__title">Download a local model</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close">
                <Icon name="close" size={14} />
              </button>
            </Dialog.Close>
          </header>
          <p id="local-models-desc" className="dialog__lede">
            Models that run on this computer: nothing you ask them leaves it. When a download finishes the
            model is in every model picker, ready.
          </p>
          {view.isPending ? (
            <Skeleton lines={5} label="Checking this computer" />
          ) : view.data ? (
            <>
              <p className="local-models__hw" data-num>
                <Icon name="monitor" size={12} /> {gb(hw?.ram_gb ?? 0)} of memory ·{' '}
                {hw?.gpu
                  ? hw.gpu.shared
                    ? `${hw.gpu.name} (shared memory)`
                    : `${hw.gpu.name}${hw.gpu.vram_gb ? `, ${gb(hw.gpu.vram_gb)}` : ''}`
                  : 'no graphics card found'}{' '}
                ·{' '}
                {hw?.disk_free_gb !== null && hw?.disk_free_gb !== undefined
                  ? `${gb(hw.disk_free_gb)} free for models`
                  : 'disk not checked'}
                {view.data.ollama.status === 'running' ? ` · Ollama ${view.data.ollama.version ?? ''}` : ''}
              </p>
              <OllamaBanner view={view.data} />
              <ul className="local-models__list">
                {view.data.items.map((m) => (
                  <Row key={m.id} m={m} ollamaRunning={view.data.ollama.status === 'running'} />
                ))}
              </ul>
            </>
          ) : (
            <p className="local-models__error" role="alert">
              {errorWords(view.error).title}. {errorWords(view.error).body}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
