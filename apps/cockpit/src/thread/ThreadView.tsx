/**
 * ------------------------------------------------------------------
 *  Title    |  Thread view
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The conversation at reading measure, its pinned TL;DR,
 *           |  and the composer, with scroll restored to the message
 *           |  you were reading rather than a pixel offset.
 *  How      |  Saved messages come from the thread query; a message
 *           |  still being written is overlaid from its live run
 *           |  (lib/run.ts). Opening a thread mid-answer re-attaches
 *           |  to the run, so a reload never loses the stream. While
 *           |  an answer streams, the view follows it unless you have
 *           |  scrolled up to read.
 *           |  Scroll anchor = the first visible message id + offset,
 *           |  saved per thread. New text is announced politely.
 *           |  A thread from Claude Code sends to its live session
 *           |  (claudecode/live.ts) and shows Claude Code's state,
 *           |  pickers and notices around the composer; a message
 *           |  sent while a turn runs waits as the one queued.
 * ------------------------------------------------------------------
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CcLiveLine, CcNotices, CcPickers, lastTurn, useCcActions } from '../claudecode/LiveBar';
import {
  interruptClaudeCode,
  refreshLive,
  sendClaudeCode,
  useClaudeCodeCommands,
  useClaudeCodeLive,
} from '../claudecode/live';
import { patchCc, useCcThread } from '../claudecode/store';
import { CcEventRow, ClaudeCodeMarker } from '../claudecode/ThreadMarker';
import { ApiCallError } from '../lib/api';
import { useConnection } from '../lib/connection';
import { useThread, useThreads } from '../lib/data';
import { useCurrentModel } from '../lib/models';
import { attachRun, detachThread, type LiveTurn, resumeThread, useRuns } from '../lib/run';
import { sendMessage } from '../lib/turns';
import type { MessageView } from '../lib/types';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { BranchLayer } from '../tree/BranchLayer';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import { nextAnnouncement } from './announce';
import { type ClaudeCodeComposer, Composer, type SendExtras } from './Composer';
import { ComposerHints } from './ComposerHints';
import { Message } from './Message';
import { ToolCwd } from './ToolSteps';

const anchorKey = (threadId: string) => `nvx.ancile.scroll:${threadId}`;

function overlay(m: MessageView, live: LiveTurn | undefined): MessageView {
  if (!live) return m;
  const writing = !live.done;
  return {
    ...m,
    parts: live.parts.length || writing ? live.parts : m.parts,
    status: writing
      ? 'streaming'
      : live.error
        ? 'error'
        : live.status === 'cancelled'
          ? 'stopped'
          : (m.status ?? 'complete'),
    modelId: live.modelId ?? m.modelId,
    ...(live.fallback && { fallback: { from: live.fallback.from, reason: live.fallback.reason } }),
    error: live.error,
  };
}

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const connection = useConnection((s) => s.status);
  // The rail's list hears about a new auto-title first (the first send
  // refreshes it); the thread itself is refetched only when the answer ends.
  const listTitle = useThreads().data?.find((t) => t.id === threadId)?.title;
  const demo = useUi((s) => s.demo);
  const model = useCurrentModel(threadId);
  const turns = useRuns((s) => s.turns);
  const [local, setLocal] = useState<MessageView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tldrOpen, setTldrOpen] = useState(true);
  const [announce, setAnnounce] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on thread change only
  useEffect(() => {
    setLocal([]);
    following.current = true;
    useUi.getState().resetDrawerTab();
  }, [threadId]);

  // Opened mid-answer (a reload, another tab): pick the stream back up.
  const activeRun = thread.data?.activeRun;
  useEffect(() => {
    if (activeRun?.messageId) attachRun({ runId: activeRun.id, threadId, messageId: activeRun.messageId });
  }, [activeRun?.id, activeRun?.messageId, threadId]);
  // Leaving the thread lets its streams go (a browser allows six connections);
  // coming back picks up any it left unfinished.
  useEffect(() => {
    resumeThread(threadId);
    return () => detachThread(threadId);
  }, [threadId]);

  const messages = [...(thread.data?.messages ?? []), ...local].map((m) => overlay(m, turns[m.id]));
  const last = messages[messages.length - 1];
  const liveTurn = last ? turns[last.id] : undefined;
  const streamedLength =
    liveTurn?.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 1), 0) ?? 0;

  useEffect(() => {
    if (!selected && last)
      setSelected(messages.findLast((m) => m.role === 'assistant' && !m.cc)?.id ?? last.id);
  }, [last, selected, messages]);

  // Restore the reading position by message, not by pixel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore once per thread load, not per message
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !thread.data) return;
    try {
      const saved = JSON.parse(localStorage.getItem(anchorKey(threadId)) ?? 'null') as {
        id: string;
        offset: number;
      } | null;
      const target = saved && el.querySelector<HTMLElement>(`[data-mid="${saved.id}"]`);
      if (target) el.scrollTop = target.offsetTop - saved.offset;
      else el.scrollTop = el.scrollHeight;
    } catch {
      el.scrollTop = el.scrollHeight;
    }
  }, [threadId, thread.isSuccess]);

  // Follow a streaming answer while you are at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as text arrives
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [streamedLength, messages.length]);

  // For screen readers: the answer as it arrives, by sentence or paragraph
  // (Settings → Accessibility), and always a word when it finishes. Only an
  // answer seen streaming here is read, never an old one on load.
  const announceMode = usePrefs((s) => s.prefs.accessibility.announce);
  const showWhole = usePrefs((s) => s.prefs.reading.streaming === 'whole');
  const spoken = useRef<{ id: string | null; upTo: number }>({ id: null, upTo: 0 });
  const lastText =
    last?.role === 'assistant'
      ? (last.parts ?? []).reduce((t, p) => (p.type === 'text' ? t + p.text : t), '')
      : '';
  useEffect(() => {
    if (last?.role !== 'assistant') return;
    const writing = last.status === 'streaming' || last.status === 'pending';
    if (writing && spoken.current.id !== last.id) spoken.current = { id: last.id, upTo: 0 };
    if (spoken.current.id !== last.id) return;
    if (writing && showWhole) return;
    const r = nextAnnouncement(lastText, spoken.current.upTo, announceMode, !writing);
    spoken.current.upTo = r.upTo;
    if (writing) {
      if (r.say) setAnnounce(r.say);
      return;
    }
    spoken.current = { id: null, upTo: 0 };
    const end = last.status === 'error' ? 'The answer could not be finished.' : 'Answer finished.';
    setAnnounce(r.say ? `${r.say} ${end}` : end);
  }, [last?.id, last?.status, last?.role, lastText, announceMode, showWhole]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-mid]'));
    const first = items.find((n) => n.offsetTop + n.offsetHeight > el.scrollTop);
    if (!first) return;
    try {
      localStorage.setItem(
        anchorKey(threadId),
        JSON.stringify({ id: first.dataset.mid, offset: first.offsetTop - el.scrollTop }),
      );
    } catch {
      /* ignore */
    }
  };

  const busy = last?.status === 'streaming';

  // A thread from Claude Code carries its session on.
  const cc = demo ? null : (thread.data?.claudeCode ?? null);
  const ccLive = useClaudeCodeLive(cc ? threadId : undefined);
  const ccCommands = useClaudeCodeCommands(cc ? threadId : undefined);
  const ccState = useCcThread(threadId);
  const [replace, setReplace] = useState({ text: '', n: 0 });
  const ccWorking = !!cc && (busy || last?.status === 'pending' || ccLive.data?.state === 'working');
  const ccAct = useCcActions({
    threadId,
    notebookId: thread.data?.notebookId ?? null,
    headId: last?.id ?? null,
  });

  // A turn starting or ending changes what the session reports.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when a turn starts or ends
  useEffect(() => {
    if (cc) refreshLive(threadId);
  }, [busy, cc, threadId]);

  // The queued message goes as soon as the running turn ends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires when the turn ends or a message is queued
  useEffect(() => {
    const q = ccState.queued;
    if (!cc || ccWorking || !q) return;
    patchCc(threadId, { queued: null });
    void sendClaudeCode({
      threadId,
      parentId: last?.id ?? null,
      text: q.text,
      sourceIds: q.sourceIds,
      model: ccState.model,
      effort: ccState.effort,
    }).then((ok) => {
      if (!ok) setReplace((r) => ({ text: q.text, n: r.n + 1 }));
    });
  }, [ccWorking, ccState.queued]);

  const claudeCode: ClaudeCodeComposer | undefined = useMemo(
    () =>
      cc
        ? {
            commands: ccCommands.data ?? [],
            act: ccAct,
            bar: <CcPickers threadId={threadId} live={ccLive.data} commands={ccCommands.data} />,
            working: ccWorking,
            onStop: () => void interruptClaudeCode(threadId),
          }
        : undefined,
    [cc, ccCommands.data, ccAct, threadId, ccLive.data, ccWorking],
  );

  const send = async (text: string, extras?: SendExtras): Promise<boolean> => {
    following.current = true;
    if (demo) {
      const optimistic: MessageView = {
        id: `local-${crypto.randomUUID()}`,
        parentId: last?.id ?? null,
        role: 'user',
        modelId: null,
        createdAt: new Date().toISOString(),
        blocks: [{ kind: 'p', spans: [{ text }] }],
      };
      setLocal((l) => [...l, optimistic]);
      notify({
        level: 'info',
        title: 'Not sent: this is demo data',
        body: 'Core is not running, so the message stays on this screen only.',
        undo: () => setLocal((l) => l.filter((m) => m.id !== optimistic.id)),
      });
      return true;
    }
    if (cc) {
      const sourceIds = extras?.mentions.filter((m) => m.kind === 'source').map((m) => m.id);
      if (ccWorking) {
        if (ccState.queued) {
          notify({
            level: 'info',
            title: 'A message is already queued',
            body: 'It sends when this turn ends. Remove it to queue a different one.',
          });
          return false;
        }
        patchCc(threadId, { queued: { text, ...(sourceIds?.length && { sourceIds }) } });
        return true;
      }
      const ok = await sendClaudeCode({
        threadId,
        parentId: last?.id ?? null,
        text,
        model: ccState.model,
        effort: ccState.effort,
        sourceIds,
        asBranch: ccState.forkNext,
      });
      if (ok && ccState.forkNext) patchCc(threadId, { forkNext: false });
      if (ok) setAnnounce('Message sent to Claude Code.');
      return ok;
    }
    if (busy) {
      notify({
        level: 'info',
        title: 'This thread is still answering',
        body: 'Wait for it, or press Stop first.',
      });
      return false;
    }
    const ok = await sendMessage({
      threadId,
      parentId: last?.id ?? null,
      text,
      model: extras?.model ?? null,
      defaultModel: model?.id ?? null,
      mentions: extras?.mentions,
      flowId: extras?.flowId ?? null,
    });
    if (ok) setAnnounce('Message sent.');
    return ok;
  };

  if (thread.isPending) {
    return (
      <div className="thread">
        <div className="thread__scroll">
          <div className="thread__measure">
            <Skeleton lines={4} label="Loading thread" />
            <Skeleton lines={7} label="Loading thread" />
          </div>
        </div>
      </div>
    );
  }

  if (thread.isError && !thread.data) {
    const offline = connection === 'offline';
    const err = thread.error instanceof ApiCallError ? thread.error.body : null;
    return (
      <div className="thread thread--center">
        {err ? (
          <ErrorState error={err} onRetry={() => void thread.refetch()} />
        ) : (
          <EmptyState
            icon={offline ? 'pulse' : 'alert'}
            title={offline ? 'This thread will open when Core answers' : 'This thread could not be opened'}
            body={
              offline
                ? 'Core is not answering, and this thread was not loaded on this device yet. It retries on its own.'
                : 'Something unexpected went wrong. Try again, or open the logs.'
            }
            action={{ label: 'Try again', onClick: () => void thread.refetch() }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="thread">
      <div className="thread__scroll" data-scrollable ref={scroller} onScroll={onScroll}>
        <div className="thread__measure">
          <h1 className="thread__title" data-display dir="auto">
            {listTitle ?? thread.data?.title}
          </h1>
          {thread.data?.claudeCode ? (
            <div className="thread__origin">
              <ClaudeCodeMarker threadId={threadId} binding={thread.data.claudeCode} />
            </div>
          ) : null}

          {thread.data?.tldr ? (
            <section className="tldr" data-open={tldrOpen || undefined}>
              <button
                type="button"
                className="tldr__toggle"
                onClick={() => setTldrOpen((o) => !o)}
                aria-expanded={tldrOpen}
              >
                <Icon name={tldrOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                Where this thread has got to
              </button>
              {tldrOpen ? <p className="tldr__body">{thread.data.tldr}</p> : null}
            </section>
          ) : null}

          {messages.length === 0 ? (
            <EmptyState
              icon="thread"
              title="Nothing here yet"
              body="Ask a question below. Every reply can be regenerated with another model, edited and explained."
            />
          ) : (
            <ToolCwd.Provider value={thread.data?.claudeCode?.cwd ?? null}>
              <ol className="thread__messages" aria-label="Conversation">
                {messages.map((m) => {
                  // Tool results already drawn in the answer before them.
                  if (m.folded) return null;
                  // Claude Code's commands, notices and compactions: quiet rows, not bubbles.
                  if (m.cc)
                    return (
                      <li key={m.id} data-mid={m.id} data-cc={m.cc.kind}>
                        <CcEventRow e={m.cc} />
                      </li>
                    );
                  const live = turns[m.id];
                  return (
                    <li key={m.id} data-mid={m.id}>
                      <Message
                        m={m}
                        threadId={threadId}
                        selected={selected === m.id}
                        onSelect={setSelected}
                        waiting={
                          !!live && !live.done && (!!live.approvalId || live.status === 'waiting_approval')
                        }
                        liveModelName={live?.modelName ?? null}
                        approvalId={live?.approvalId ?? null}
                      />
                    </li>
                  );
                })}
              </ol>
            </ToolCwd.Provider>
          )}
        </div>
      </div>

      <div className="thread__composer">
        <div className="thread__measure">
          {cc ? <CcNotices threadId={threadId} /> : null}
          {demo ? null : (
            <ComposerHints
              threadId={threadId}
              headId={last?.id ?? null}
              fromClaudeCode={thread.data ? !!thread.data.claudeCode : null}
            />
          )}
          {cc ? (
            <CcLiveLine threadId={threadId} binding={cc} live={ccLive.data} last={lastTurn(messages)} />
          ) : null}
          <Composer
            threadId={threadId}
            parentId={last?.id ?? null}
            onSend={send}
            busy={cc ? false : busy}
            notebookId={thread.data?.notebookId ?? null}
            claudeCode={claudeCode}
            replaceText={replace}
          />
        </div>
        {demo ? null : <BranchLayer threadId={threadId} />}
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="false">
        {announce}
      </div>
    </div>
  );
}
