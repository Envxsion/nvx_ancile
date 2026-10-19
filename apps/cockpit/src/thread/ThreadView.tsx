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
 *           |  A model thread queues the same way (thread/queue.ts):
 *           |  Enter while an answer streams, the message waits above
 *           |  the composer and goes when the turn ends; Esc takes it
 *           |  back, Ctrl+Enter stops the answer and sends it now.
 * ------------------------------------------------------------------
 */

import { useRouterState } from '@tanstack/react-router';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AutoSlot } from '../auto/AutoCards';
import { lastTurn, useCcActions } from '../claudecode/actions';
import { LimitNotice, limitOf, NearLimitLine } from '../claudecode/LimitNotice';
import {
  interruptClaudeCode,
  refreshLive,
  removeQueued,
  sendClaudeCode,
  useClaudeCodeCommands,
  useClaudeCodeLive,
} from '../claudecode/live';
import { patchCc, useCcThread } from '../claudecode/store';
import { ClaudeCodeMarker } from '../claudecode/ThreadMarker';
import { ClaudeCodeUnavailable, unavailableLine } from '../claudecode/Unavailable';
import { ContextNotice } from '../engines/ContextNotice';
import { ApiCallError } from '../lib/api';
import { useConnection } from '../lib/connection';
import { keys, useThread, useThreads } from '../lib/data';
import { useCurrentModel } from '../lib/models';
import { queryClient } from '../lib/query';
import { attachRun, detachThread, resumeThread, useRuns } from '../lib/run';
import {
  ensureLoaded,
  loadEarlier,
  type ReadingAnchor,
  readingAnchor,
  scrollTopFor,
} from '../lib/threadPages';
import { sendMessage, stopMessage } from '../lib/turns';
import type { MessageView } from '../lib/types';
import { PlanNotice } from '../models/PlanNotice';
import { SwitchCostNotice } from '../models/SwitchCostNotice';
import { ScopeChip } from '../scopes/ScopeChip';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { BranchLayer } from '../tree/BranchLayer';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { lazyHost, preloadOnIdle } from '../ui/lazyHost';
import { EmptyState, Skeleton } from '../ui/primitives';
import { nextAnnouncement } from './announce';
import { BusyNotice } from './BusyNotice';
import {
  type ClaudeCodeComposer,
  Composer,
  type ComposerQueue,
  loadEffortChip,
  type SendExtras,
} from './Composer';
import { ComposerHints } from './ComposerHints';
import { headOf, overlay, withHead } from './liveOverlay';
import { MessageList } from './MessageList';
import { ModelGoneNotice } from './ModelGoneNotice';
import { NewTextPill } from './NewTextPill';
import { dequeue, enqueue, hold, queueStep, useQueue } from './queue';
import { stayAtBottomOnShrink } from './stayAtBottom';

// Claude Code's status line, notices and pickers belong to threads from Claude Code only: they load
// after the first paint (preloaded when idle) and are not in the first download (ROADMAP P1).
export const loadCcBar = () => import('../claudecode/LiveBar');
const CcLiveLine = lazyHost(loadCcBar, 'CcLiveLine');
const CcNotices = lazyHost(loadCcBar, 'CcNotices');
const CcPickers = lazyHost(loadCcBar, 'CcPickers');
// The queued message's line draws only while one waits.
const ModelQueue = lazyHost(() => import('./ModelQueue'), 'ModelQueue');

// The effort chip is for reasoning models only; fetch it once the page is idle so it does not pop in late.
preloadOnIdle(loadEffortChip);

const anchorKey = (threadId: string) => `nvx.ancile.scroll:${threadId}`;
/** Load the page before when the view is this close to the top of what is loaded (pixels). */
const EARLIER_AT = 1_200;

/** The message being read in `el`: a binary search over its rows, not a walk over all of them. */
function anchorIn(el: HTMLElement): ReadingAnchor | null {
  const rows = el.querySelectorAll<HTMLElement>('[data-mid]');
  return readingAnchor(
    rows.length,
    (i) => {
      const n = rows[i] as HTMLElement;
      return { id: n.dataset.mid ?? '', top: n.offsetTop, height: n.offsetHeight };
    },
    el.scrollTop,
  );
}

const rowOf = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-mid="${typeof CSS !== 'undefined' ? CSS.escape(id) : id}"]`);

/**
 * The parts of following and announcing a streaming answer that depend on its text, so they
 * redraw with each token and the screen around them does not: this component renders nothing.
 */
function StreamEffects({
  lastBase,
  messageCount,
  scroller,
  following,
  setAnnounce,
}: {
  lastBase: MessageView | undefined;
  messageCount: number;
  scroller: RefObject<HTMLElement | null>;
  following: RefObject<boolean>;
  setAnnounce: (words: string) => void;
}) {
  const live = useRuns((s) => (lastBase ? s.turns[lastBase.id] : undefined));
  const last = useMemo(() => (lastBase ? overlay(lastBase, live) : undefined), [lastBase, live]);
  const streamedLength = live?.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 1), 0) ?? 0;

  // Follow a streaming answer while you are at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as text arrives
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [streamedLength, messageCount]);

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
  }, [last?.id, last?.status, last?.role, lastText, announceMode, showWhole, setAnnounce]);
  return null;
}

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const connection = useConnection((s) => s.status);
  // The rail's list hears about a new auto-title first (the first send
  // refreshes it); the thread itself is refetched only when the answer ends.
  const listTitle = useThreads().data?.find((t) => t.id === threadId)?.title;
  const demo = useUi((s) => s.demo);
  const model = useCurrentModel(threadId);
  const [local, setLocal] = useState<MessageView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tldrOpen, setTldrOpen] = useState(true);
  const [announce, setAnnounce] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Paging: what you were reading while an earlier page loads, and the message jumped to.
  const prepend = useRef<ReadingAnchor | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const scrollFrame = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on thread change only
  useEffect(() => {
    setLocal([]);
    setJumpTo(null);
    prepend.current = null;
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

  // Saved messages, and what was just sent in demo mode. A row lays its own live text over itself
  // (MessageList), so a token redraws that row and nothing here (ROADMAP P2). What this screen
  // needs from the last run (status, model, error) changes a few times per answer.
  const messages = useMemo(
    () => [...(thread.data?.messages ?? []), ...local],
    [thread.data?.messages, local],
  );
  const lastBase = messages[messages.length - 1];
  const head = useRuns(useShallow((s) => headOf(lastBase ? s.turns[lastBase.id] : undefined)));
  const last = useMemo(() => (lastBase ? withHead(lastBase, head) : undefined), [lastBase, head]);

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

  // Earlier pages: loaded as you near the top, with what you were reading kept in place.
  const hasMore = !!thread.data?.hasMore;
  const earlier = useCallback(async () => {
    const el = scroller.current;
    if (!el || prepend.current) return;
    prepend.current = anchorIn(el) ?? { id: '', offset: 0 };
    setLoadingEarlier(true);
    const ok = await loadEarlier(threadId).catch(() => false);
    setLoadingEarlier(false);
    if (!ok) prepend.current = null;
  }, [threadId]);
  const firstId = thread.data?.messages[0]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a page lands in front
  useLayoutEffect(() => {
    const el = scroller.current;
    const at = prepend.current;
    if (!el || !at) return;
    prepend.current = null;
    const top = scrollTopFor(at, (id) => rowOf(el, id)?.offsetTop ?? null);
    if (top !== null) el.scrollTop = top;
  }, [firstId]);
  // A short last page that does not fill the view: fetch the one before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked as pages land
  useEffect(() => {
    const el = scroller.current;
    if (el && hasMore && el.scrollHeight <= el.clientHeight + EARLIER_AT) void earlier();
  }, [hasMore, firstId, earlier]);

  // Jump to a message (a search hit opens the thread at #message-id): load its page, then show it.
  const hash = useRouterState({ select: (s) => s.location.hash });
  useEffect(() => {
    const id = (hash ?? '').replace(/^#/, '');
    if (!id || !thread.isSuccess) return;
    let gone = false;
    void ensureLoaded(threadId, id).then((ok) => {
      if (!gone && ok) setJumpTo(id);
    });
    return () => {
      gone = true;
    };
  }, [hash, threadId, thread.isSuccess]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !jumpTo) return;
    const raf = requestAnimationFrame(() => {
      const row = rowOf(el, jumpTo);
      if (!row) return;
      following.current = false;
      row.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [jumpTo]);

  // A notice above the composer (a moved folder, a limit) makes the list shorter: while you
  // were at the bottom, stay there, so it never covers the last lines of the answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list mounts once the thread has loaded
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    return stayAtBottomOnShrink(el, () => following.current);
    // The list mounts once the thread has loaded.
  }, [threadId, thread.isPending]);

  // Once a frame at most: where you are, whether to follow, whether to load earlier.
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const el = scroller.current;
      if (!el) return;
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (hasMore && el.scrollTop < EARLIER_AT) void earlier();
      const at = anchorIn(el);
      if (!at) return;
      try {
        localStorage.setItem(anchorKey(threadId), JSON.stringify(at));
      } catch {
        /* ignore */
      }
    });
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

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

  // The live tail (CC6): a terminal wrote the session and Core took it in, so show the new turns.
  const syncedAt = ccLive.data?.synced_at ?? null;
  const seenSync = useRef<string | null>(null);
  useEffect(() => {
    if (!syncedAt) return;
    if (seenSync.current && seenSync.current !== syncedAt)
      void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    seenSync.current = syncedAt;
  }, [syncedAt, threadId]);

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
      other: ccState.other,
    }).then((ok) => {
      if (!ok) setReplace((r) => ({ text: q.text, n: r.n + 1 }));
    });
  }, [ccWorking, ccState.queued]);

  // CH7: the message that waits behind a running answer in a model thread.
  const queued = useQueue((s) => s.byThread[threadId]);

  // Delivered the way a plain send is: as a reply to the message on screen.
  const deliver = (text: string, extras: SendExtras) =>
    sendMessage({
      threadId,
      parentId: last?.id ?? null,
      text,
      model: extras.model ?? null,
      defaultModel: model?.id ?? null,
      mentions: extras.mentions,
      flowId: extras.flowId ?? null,
      ...(extras.images?.length && { images: extras.images }),
      ...(extras.attachments?.length && { attachments: extras.attachments }),
    });
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  // The turn ended: send the queued message, unless the answer failed or you moved to another
  // branch, when it stays where it is and says why.
  useEffect(() => {
    if (cc) return;
    const step = queueStep(queued, { busy, lastId: last?.id ?? null, lastStatus: last?.status });
    if (step === 'hold-error') hold(threadId, 'error');
    if (step === 'hold-branch') hold(threadId, 'branch');
    if (step !== 'send') return;
    const q = dequeue(threadId);
    if (!q) return;
    void deliverRef.current(q.text, q.extras).then((ok) => {
      if (!ok && enqueue(threadId, { text: q.text, extras: q.extras, after: q.after }))
        hold(threadId, 'failed');
    });
  }, [queued, busy, last?.id, last?.status, cc, threadId]);

  // Back out of the queue: its words return to the composer, joined to whatever is written there.
  const unqueue = useCallback(() => {
    const q = dequeue(threadId);
    if (q)
      window.dispatchEvent(new CustomEvent('ancile:composer-insert', { detail: { threadId, text: q.text } }));
  }, [threadId]);

  const sendQueuedNow = () => {
    if (queued?.state === 'held') {
      const q = dequeue(threadId);
      if (q)
        void deliver(q.text, q.extras).then((ok) => {
          if (!ok && enqueue(threadId, { text: q.text, extras: q.extras, after: q.after }))
            hold(threadId, 'failed');
        });
    } else if (last) void stopMessage(last.id, threadId);
  };

  const queueApi: ComposerQueue = useMemo(() => {
    if (cc) {
      const waiting = ccState.queued ?? null;
      const inCore = ccLive.data?.queue?.at(-1) ?? null;
      return {
        queued: !!waiting || !!inCore,
        remove: () => {
          const text = waiting?.text ?? inCore?.text ?? '';
          if (waiting) patchCc(threadId, { queued: null });
          else if (inCore) void removeQueued(threadId, inCore.id);
          if (text)
            window.dispatchEvent(new CustomEvent('ancile:composer-insert', { detail: { threadId, text } }));
        },
      };
    }
    return { queued: !!queued, remove: unqueue };
  }, [cc, ccState.queued, ccLive.data?.queue, queued, threadId, unqueue]);

  const claudeCode: ClaudeCodeComposer | undefined = useMemo(
    () =>
      cc
        ? {
            commands: ccCommands.data ?? [],
            act: ccAct,
            bar: <CcPickers threadId={threadId} live={ccLive.data} commands={ccCommands.data} />,
            // Model, effort and settings; only the model while another model answers.
            chips: ccState.other ? 1 : 3,
            working: ccWorking,
            onStop: () => void interruptClaudeCode(threadId),
            // Claude Code not here (or signed out): read-only for it; another model can still answer.
            readOnly: ccState.other ? null : unavailableLine(ccLive.data),
          }
        : undefined,
    [cc, ccCommands.data, ccAct, threadId, ccLive.data, ccWorking, ccState.other],
  );

  // A message sent for you later (as a branch, or to finish on another model) leaves the composer empty.
  const clearComposer = useCallback(() => setReplace((r) => ({ text: '', n: r.n + 1 })), []);

  // "Change" on a plan: say what to change, and the agent revises it from your words.
  const changePlan = useCallback(() => {
    setReplace((r) => ({ text: 'About the plan: ', n: r.n + 1 }));
    requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
  }, []);

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
      // Another model answering this turn keeps the window's own queue; a Claude Code turn
      // goes to Core's (CC6), which keeps it through a reload and waits for a terminal too.
      if (ccWorking && ccState.other) {
        if (extras?.images?.length) {
          notify({
            level: 'info',
            title: 'Images wait for this turn to end',
            body: 'Send the message with its images once Claude Code has finished.',
          });
          return false;
        }
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
        ...(extras?.images?.length && { imageIds: extras.images.map((i) => i.id) }),
        asBranch: ccState.forkNext,
        other: ccState.other,
      });
      if (ok && ccState.forkNext) patchCc(threadId, { forkNext: false });
      if (ok)
        setAnnounce(
          ccState.other ? `Message sent to ${ccState.other.name}.` : 'Message sent to Claude Code.',
        );
      return ok;
    }
    if (busy) {
      // CH7: write ahead. The message waits above the composer and goes when this turn ends; with
      // "stop and send now" the running answer is stopped and the same queue sends it.
      if (
        !enqueue(threadId, {
          text,
          extras: { ...extras, now: undefined } as SendExtras,
          after: last?.id ?? null,
        })
      ) {
        notify({
          level: 'info',
          title: 'A message is already queued',
          body: 'It sends when this turn ends. Press Esc in the composer to take it back.',
        });
        return false;
      }
      if (extras?.now && last) void stopMessage(last.id, threadId);
      setAnnounce(
        extras?.now
          ? 'Stopping the answer. Your message sends next.'
          : 'Message queued. It sends when this turn ends.',
      );
      return true;
    }
    const ok = await sendMessage({
      threadId,
      parentId: last?.id ?? null,
      text,
      model: extras?.model ?? null,
      defaultModel: model?.id ?? null,
      mentions: extras?.mentions,
      flowId: extras?.flowId ?? null,
      ...(extras?.images?.length && { images: extras.images }),
      ...(extras?.attachments?.length && { attachments: extras.attachments }),
    });
    if (ok) setAnnounce('Message sent.');
    return ok;
  };

  // The composer is memoised: it gets this, which never changes, not a new function per render.
  const sendRef = useRef(send);
  sendRef.current = send;
  const onSend = useCallback((text: string, extras: SendExtras) => sendRef.current(text, extras), []);

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
          <ErrorState error={err} onRetry={() => thread.refetch()} retry="always" />
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
          <div className="thread__head">
            <h1 className="thread__title" data-display dir="auto">
              {listTitle ?? thread.data?.title}
            </h1>
            <ScopeChip threadId={threadId} />
          </div>
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
            <>
              {hasMore ? (
                <div className="thread__earlier">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void earlier()}
                    disabled={loadingEarlier}
                  >
                    {loadingEarlier ? 'Loading earlier messages' : 'Show earlier messages'}
                  </button>
                </div>
              ) : null}
              <MessageList
                messages={messages}
                threadId={threadId}
                selected={selected}
                onSelect={setSelected}
                jumpTo={jumpTo}
                cwd={thread.data?.claudeCode?.cwd ?? null}
                scroller={scroller}
              />
            </>
          )}
        </div>
      </div>

      <div className="thread__composer">
        <NewTextPill
          scroller={scroller}
          following={following}
          lastId={lastBase?.id}
          messageCount={messages.length}
          threadId={threadId}
          ready={!thread.isPending}
        />
        <div className="thread__measure">
          {demo ? null : <BusyNotice threadId={threadId} onSent={clearComposer} />}
          {demo ? null : <ModelGoneNotice threadId={threadId} />}
          {demo || cc ? null : <PlanNotice threadId={threadId} />}
          {cc ? null : <SwitchCostNotice threadId={threadId} />}
          {cc ? <CcNotices threadId={threadId} /> : null}
          {cc ? <LimitNotice threadId={threadId} head={last} onSent={clearComposer} /> : null}
          {cc && !ccState.other ? <ClaudeCodeUnavailable threadId={threadId} live={ccLive.data} /> : null}
          {cc && !limitOf(last) && !unavailableLine(ccLive.data) ? <NearLimitLine /> : null}
          <ContextNotice threadId={threadId} />
          <AutoSlot threadId={threadId} onChangePlan={changePlan} />
          {demo ? null : (
            <ComposerHints
              threadId={threadId}
              headId={last?.id ?? null}
              fromClaudeCode={thread.data ? !!thread.data.claudeCode : null}
            />
          )}
          {cc ? (
            <CcLiveLine threadId={threadId} binding={cc} live={ccLive.data} last={lastTurn(messages)} />
          ) : cc === null && !demo && queued ? (
            <ModelQueue threadId={threadId} busy={busy} onSendNow={sendQueuedNow} onRemove={unqueue} />
          ) : null}
          <Composer
            threadId={threadId}
            parentId={last?.id ?? null}
            onSend={onSend}
            busy={cc ? false : busy}
            notebookId={thread.data?.notebookId ?? null}
            claudeCode={claudeCode}
            replaceText={replace}
            queue={queueApi}
          />
        </div>
        {demo ? null : <BranchLayer threadId={threadId} />}
      </div>

      <StreamEffects
        lastBase={lastBase}
        messageCount={messages.length}
        scroller={scroller}
        following={following}
        setAnnounce={setAnnounce}
      />
      <div className="sr-only" aria-live="polite" aria-atomic="false">
        {announce}
      </div>
    </div>
  );
}
