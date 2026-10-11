/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code sessions
 *  Ref      |  packages/contracts/src/claudecode.ts · help "claude-code"
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every Claude Code session on this computer, grouped by
 *           |  the folder it ran in, newest first: what is already in
 *           |  NVX Ancile, what has new messages, what is open in a
 *           |  terminal right now. Open one, or sync one that is
 *           |  behind.
 *  How      |  A tall dialog, opened from the palette or Settings →
 *           |  Claude Code (openClaudeCodeSessions). Pages of sessions
 *           |  follow next_cursor ("Show more"). By default sessions
 *           |  come in by themselves, so the view is quiet: no picking.
 *           |  With auto_import off it offers picking and importing:
 *           |  exactly { session_ids, notebook_id? }; no notebook means
 *           |  Core puts each one in its folder's notebook.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeSession, ImportClaudeCodeSessionsResult } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { ERROR_ARTICLES } from '../help/articles';
import { useLayer } from '../keys/dispatch';
import { ApiCallError } from '../lib/api';
import { useNotebooks } from '../lib/data';
import { relative } from '../lib/format';
import { LoadFailed, reportFailure } from '../ops/common';
import { useUi } from '../state/ui';
import { Check } from '../ui/controls';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { NotebookPick } from '../ui/NotebookPick';
import { EmptyState, Skeleton } from '../ui/primitives';
import {
  importSessions,
  sessionsInFolder,
  sizeWords,
  syncThread,
  useClaudeCodeSessions,
  useClaudeCodeStatus,
  useImportProgress,
} from './api';
import '../styles/claudecode.css';

/* ---- Where it opens ------------------------------------------------------ */

interface SessionsState {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useClaudeCodeSessionsDialog = create<SessionsState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export const openClaudeCodeSessions = () => useClaudeCodeSessionsDialog.getState().show();

export function ClaudeCodeSessionsHost() {
  const open = useClaudeCodeSessionsDialog((s) => s.open);
  const close = useClaudeCodeSessionsDialog((s) => s.close);
  const navigate = useNavigate();
  const autoImport = useClaudeCodeStatus({ enabled: open }).data?.settings.auto_import ?? true;
  useLayer(open);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick cc-sessions" aria-describedby="cc-sessions-lede">
          {open ? (
            <SessionsBrowser
              autoImport={autoImport}
              onClose={close}
              onOpenThread={(threadId) => {
                close();
                void navigate({ to: '/t/$threadId', params: { threadId } });
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---- Grouping ------------------------------------------------------------ */

export interface SessionGroup {
  key: string;
  project: string;
  cwd: string | null;
  missing: boolean;
  items: ClaudeCodeSession[];
}

/** By folder; folders by their newest session; sessions newest first. */
export function groupSessions(items: ClaudeCodeSession[]): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>();
  const newest = (s: ClaudeCodeSession) => Date.parse(s.updated_at) || 0;
  for (const s of [...items].sort((a, b) => newest(b) - newest(a))) {
    const key = s.cwd ?? `project:${s.project}`;
    const g = byKey.get(key);
    if (g) g.items.push(s);
    else byKey.set(key, { key, project: s.project, cwd: s.cwd, missing: s.cwd_missing, items: [s] });
  }
  return [...byKey.values()];
}

/* ---- One session --------------------------------------------------------- */

function SessionRow({
  s,
  picked,
  onPick,
  onOpenThread,
}: {
  s: ClaudeCodeSession;
  picked: boolean;
  /** Absent when sessions come in by themselves: nothing to pick. */
  onPick?: (on: boolean) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const size = sizeWords(s.size_bytes);
  const title = s.title || 'Untitled session';
  return (
    <li className="cc-session" data-picked={picked || undefined} data-pickable={onPick ? true : undefined}>
      {onPick ? <Check checked={picked} onChange={onPick} label={`Select ${title}`} /> : null}
      <div className="cc-session__main">
        {onPick ? (
          <button type="button" className="cc-session__title" onClick={() => onPick(!picked)} dir="auto">
            {title}
          </button>
        ) : s.thread_id ? (
          <button
            type="button"
            className="cc-session__title"
            onClick={() => s.thread_id && onOpenThread(s.thread_id)}
            dir="auto"
          >
            {title}
          </button>
        ) : (
          <span className="cc-session__title" dir="auto">
            {title}
          </span>
        )}
        <div className="cc-session__meta mute">
          <span>{relative(s.updated_at)}</span>
          {s.git_branch ? (
            <span className="cc-session__branch">
              <Icon name="branch" size={11} />
              {s.git_branch}
            </span>
          ) : null}
          {size ? <span data-num>{size}</span> : null}
        </div>
        {s.active_elsewhere ? (
          <p className="cc-session__note mute">
            {onPick ? 'Importing it now is fine. ' : ''}Continuing it in NVX Ancile waits until that terminal
            closes.
          </p>
        ) : null}
      </div>
      <div className="cc-session__badges">
        {s.thread_id ? (
          <button
            type="button"
            className="tag cc-tag cc-tag--link"
            onClick={() => s.thread_id && onOpenThread(s.thread_id)}
            title="Open the thread"
          >
            <Icon name="check" size={11} />
            In NVX Ancile
          </button>
        ) : null}
        {s.thread_id && s.behind ? (
          <>
            <span className="tag cc-tag" data-tone="new">
              New messages
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={syncing}
              data-busy={syncing || undefined}
              onClick={async () => {
                if (!s.thread_id) return;
                setSyncing(true);
                await syncThread(s.thread_id);
                setSyncing(false);
              }}
            >
              <Icon name="regenerate" size={12} />
              Sync
            </button>
          </>
        ) : null}
        {!s.thread_id && !onPick ? (
          <span className="tag cc-tag" title="Sessions come in by themselves">
            Coming in
          </span>
        ) : null}
        {s.active_elsewhere ? (
          <span className="tag cc-tag" data-tone="live">
            Open in a terminal right now
          </span>
        ) : null}
        {s.cwd_missing ? (
          <span className="tag cc-tag" data-tone="warn">
            Folder missing
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* ---- What happened ------------------------------------------------------- */

function ImportReport({
  result,
  titles,
  onOpenThread,
  onAgain,
  onClose,
}: {
  result: ImportClaudeCodeSessionsResult;
  titles: Map<string, string>;
  onOpenThread: (threadId: string) => void;
  onAgain: () => void;
  onClose: () => void;
}) {
  const n = result.imported.length;
  return (
    <section className="cc-report" aria-live="polite">
      <h3 className="cc-report__title">
        {n ? `Imported ${n} ${n === 1 ? 'session' : 'sessions'}` : 'Nothing was imported'}
      </h3>
      {n ? (
        <ul className="cc-report__list">
          {result.imported.map((i) => (
            <li key={i.session_id}>
              <button type="button" className="link-btn" onClick={() => onOpenThread(i.thread_id)}>
                {titles.get(i.session_id) ?? 'Open the thread'}
              </button>
              <span className="mute">
                {i.added ? ` ${i.added} ${i.added === 1 ? 'message' : 'messages'}` : ' already up to date'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.failed.length ? (
        <>
          <h4 className="cc-report__sub">{result.failed.length} could not be imported</h4>
          <ul className="cc-report__fails">
            {result.failed.map((f) => (
              <li key={f.session_id} className="cc-report__fail">
                <Icon name="warn" size={13} />
                <div>
                  <p className="cc-report__fail-title">
                    {titles.get(f.session_id) ? `${titles.get(f.session_id)}: ` : ''}
                    {f.title}
                  </p>
                  <p className="mute">{f.hint}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="cc-report__actions">
        <button type="button" className="btn btn--quiet btn--sm" onClick={onAgain}>
          Import more
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  );
}

/** An error from Core, with the guide's article for it when there is one. */
function CcError({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  if (!(error instanceof ApiCallError)) return <LoadFailed error={error} what={what} onRetry={onRetry} />;
  const article = ERROR_ARTICLES[error.body.error.code];
  return (
    <div className="cc-error">
      <ErrorState error={error.body} onRetry={onRetry} compact />
      {article ? (
        <button type="button" className="link-btn" onClick={() => useUi.getState().setHelp(true, article)}>
          How Claude Code works in NVX Ancile
        </button>
      ) : null}
    </div>
  );
}

/* ---- The browser --------------------------------------------------------- */

export function SessionsBrowser({
  onClose,
  onOpenThread,
  autoImport,
}: {
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  /** Sessions come in by themselves (the default): a quiet view, nothing to import by hand. */
  autoImport: boolean;
}) {
  const importing = useImportProgress((p) => p.line);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ImportClaudeCodeSessionsResult | null>(null);
  const titles = useRef(new Map<string, string>());
  const notebooks = useNotebooks().data ?? [];
  const sessions = useClaudeCodeSessions(term, true);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  for (const s of sessions.items) titles.current.set(s.session_id, s.title);
  const groups = useMemo(() => groupSessions(sessions.items), [sessions.items]);

  const pick = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const run = async (ids: string[], label: string) => {
    if (!ids.length) return;
    setBusy(label);
    try {
      const r = await importSessions({
        session_ids: ids,
        ...(notebookId ? { notebook_id: notebookId } : {}),
      });
      setResult(r);
      setPicked(new Set());
    } catch (error) {
      reportFailure(error, 'Importing sessions');
    } finally {
      setBusy(null);
    }
  };

  const importFolder = async (g: SessionGroup) => {
    setBusy(g.key);
    try {
      const all = g.cwd ? await sessionsInFolder(g.cwd) : g.items;
      for (const s of all) titles.current.set(s.session_id, s.title);
      const ids = all.filter((s) => !s.thread_id).map((s) => s.session_id);
      setBusy(null);
      await run(ids, g.key);
    } catch (error) {
      setBusy(null);
      reportFailure(error, 'Importing the folder');
    }
  };

  const count = picked.size;

  return (
    <div className="cc-browser">
      <header className="cc-browser__head">
        <Dialog.Title className="dialog__title">Claude Code sessions</Dialog.Title>
        <p id="cc-sessions-lede" className="dialog__lede">
          {autoImport
            ? 'Every Claude Code session on this computer, by folder, newest first. They come in as threads by themselves and stay in step.'
            : 'Claude Code sessions on this computer, by folder, newest first. Pick the ones to bring in as threads.'}
        </p>
        <label className="cc-browser__search">
          <Icon name="search" size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a session"
            aria-label="Find a session"
          />
        </label>
      </header>

      {result ? (
        <ImportReport
          result={result}
          titles={titles.current}
          onOpenThread={onOpenThread}
          onAgain={() => setResult(null)}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="cc-browser__list" data-scrollable>
            {sessions.isPending ? (
              <Skeleton lines={6} label="Loading sessions" />
            ) : sessions.isError && !sessions.items.length ? (
              <CcError
                error={sessions.error}
                what="Claude Code sessions"
                onRetry={() => void sessions.refetch()}
              />
            ) : groups.length === 0 ? (
              <EmptyState
                icon="folder"
                title={term ? 'No sessions match' : 'No Claude Code sessions yet'}
                body={
                  term
                    ? 'Try fewer words, or part of the folder name.'
                    : 'Sessions appear here once Claude Code has been used on this computer.'
                }
              />
            ) : (
              groups.map((g) => {
                const left = g.items.filter((s) => !s.thread_id).length;
                return (
                  <section key={g.key} className="cc-group" aria-label={g.project}>
                    <header className="cc-group__head">
                      <Icon name="folder" size={14} />
                      <div className="cc-group__words">
                        <h3 className="cc-group__name">{g.project}</h3>
                        {g.cwd ? (
                          <p className="cc-group__path mute" data-num title={g.cwd}>
                            {g.cwd}
                          </p>
                        ) : null}
                      </div>
                      {!autoImport && (left > 0 || g.cwd) ? (
                        <button
                          type="button"
                          className="btn btn--quiet btn--sm"
                          disabled={!!busy}
                          data-busy={busy === g.key || undefined}
                          onClick={() => void importFolder(g)}
                        >
                          Import all from this folder
                        </button>
                      ) : null}
                    </header>
                    <ul className="cc-group__items">
                      {g.items.map((s) => (
                        <SessionRow
                          key={s.session_id}
                          s={s}
                          picked={picked.has(s.session_id)}
                          onPick={autoImport ? undefined : (on) => pick(s.session_id, on)}
                          onOpenThread={onOpenThread}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
            {sessions.hasNextPage ? (
              <div className="cc-browser__more">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={sessions.isFetchingNextPage}
                  data-busy={sessions.isFetchingNextPage || undefined}
                  onClick={() => void sessions.fetchNextPage()}
                >
                  Show more
                </button>
              </div>
            ) : null}
          </div>

          {autoImport ? (
            <footer className="dialog__actions cc-browser__foot">
              <p className="cc-browser__status mute" role="status">
                {importing ? (
                  <>
                    <span className="cc-spin" aria-hidden="true" />
                    {importing}
                  </>
                ) : (
                  'Everything here is in step.'
                )}
              </p>
              <button type="button" className="btn btn--quiet btn--sm" onClick={onClose}>
                Close
              </button>
            </footer>
          ) : (
            <footer className="dialog__actions cc-browser__foot">
              <div className="cc-browser__dest">
                <span className="mute">Put them in</span>
                <NotebookPick
                  notebooks={notebooks}
                  value={notebookId}
                  onChange={setNotebookId}
                  noneLabel="The folder's notebook"
                  heading="Put the threads in"
                  noneIcon="folder"
                />
              </div>
              {count ? (
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setPicked(new Set())}>
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={count === 0 || !!busy}
                data-busy={busy === 'picked' || undefined}
                onClick={() => void run([...picked], 'picked')}
              >
                {count === 0 ? 'Import sessions' : `Import ${count} ${count === 1 ? 'session' : 'sessions'}`}
              </button>
            </footer>
          )}
        </>
      )}
    </div>
  );
}
