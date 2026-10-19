/**
 * ------------------------------------------------------------------
 *  Title    |  Live context, in Settings → Usage
 *  Ref      |  docs/claude-code.md (Usage) · docs/threads.md (Context)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How full the thread you last had open is, where the
 *           |  status bar's context meter leads: the same meter with
 *           |  the compaction line, the parts that fill it, and what
 *           |  you can do about it. Every way it can be empty says why.
 *  How      |  The last thread from the UI store (set as threads open,
 *           |  never stored). A Claude Code thread shows Claude Code's
 *           |  own count from its live state; any other thread
 *           |  NVX Ancile's budget for the branch on screen
 *           |  (GET /threads/:id/context-budget). Both refresh as the
 *           |  thread changes.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { useClaudeCodeLive } from '../claudecode/live';
import { live as demoLive } from '../fixtures/demoLive';
import { ApiCallError } from '../lib/api';
import { compactNow, useContextBudget } from '../lib/branching';
import { useThread } from '../lib/data';
import { compact } from '../lib/format';
import { useUi } from '../state/ui';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';
import { ContextGauge, contextWords } from './Meter';

function Empty({ line, more }: { line: string; more: string }) {
  return (
    <div className="u-plan-empty">
      <p>{line}</p>
      <p className="u-quiet">{more}</p>
    </div>
  );
}

function ThreadLink({ id, title }: { id: string; title: string | null | undefined }) {
  return (
    <Link to="/t/$threadId" params={{ threadId: id }}>
      {title || 'Untitled thread'}
    </Link>
  );
}

/** Claude Code's own count for a Claude Code thread. */
function ClaudeCodeCount({ threadId, title }: { threadId: string; title: string | null }) {
  const live = useClaudeCodeLive(threadId);
  if (live.isPending) return <Skeleton lines={2} label="Reading Claude Code's context" />;
  if (live.isError)
    return (
      <LoadFailed compact error={live.error} what="Claude Code's context" onRetry={() => live.refetch()} />
    );
  const ctx = live.data?.context ?? null;
  if (!ctx || ctx.max_tokens <= 0)
    return (
      <div className="u-plan-empty">
        <p>
          Claude Code reports its own context once its session is open in{' '}
          <ThreadLink id={threadId} title={title} />.
        </p>
        <p className="u-quiet">Send a message there to open it; this then shows how full it is.</p>
      </div>
    );
  const pct = Math.max(0, Math.min(100, ctx.percent));
  const at = ctx.compacts_at ?? null;
  return (
    <div className="u-context">
      <p className="u-context__thread">
        <ThreadLink id={threadId} title={title} />
      </p>
      <div className="u-context__meter">
        <ContextGauge percent={pct} compactsAt={at} />
        <span>{contextWords(pct, at)}</span>
      </div>
      <p className="u-quiet" data-num>
        Claude Code's own count: {compact(ctx.used_tokens)} of {compact(ctx.max_tokens)} tokens.{' '}
        {at
          ? 'It compacts by itself at the line; type /compact to do it now.'
          : 'Type /compact to compact now.'}
      </p>
    </div>
  );
}

/** NVX Ancile's budget for the branch on screen. */
function BranchBudget({ threadId, title }: { threadId: string; title: string | null }) {
  const budget = useContextBudget(threadId);
  if (budget.isPending) return <Skeleton lines={2} label="Measuring this thread's context" />;
  if (budget.isError)
    return (
      <LoadFailed
        compact
        error={budget.error}
        what="This thread's context"
        onRetry={() => budget.refetch()}
      />
    );
  const b = budget.data;
  if (b.window === 0)
    return (
      <Empty
        line="This thread's model does not say how large its context is, so there is nothing to measure."
        more="Pick a model with a known context window and this shows how full the branch is and when it compacts."
      />
    );
  const pct = b.ratio * 100;
  const at = (b.compacts_at ?? 0.95) * 100;
  const u = b.used;
  const canCompact = b.level !== 'ok' && b.compactable > 0;
  const parts = [
    ['History', u.history],
    ['System', u.system],
    ['Memory', u.memory],
    ['Sources', u.retrieval],
    ['Room for the reply', u.reserve_output],
  ] as const;
  return (
    <div className="u-context">
      <p className="u-context__thread">
        <ThreadLink id={threadId} title={title} />
      </p>
      <div className="u-context__meter">
        <ContextGauge percent={pct} compactsAt={at} />
        <span>{contextWords(pct, at)}</span>
      </div>
      <p className="u-quiet" data-num>
        {compact(b.total)} of {compact(b.window)} tokens for this branch
        {b.compaction ? `, with a summary of ${b.compaction.replaced_messages} older messages` : ''}.
      </p>
      <dl className="u-context__parts">
        {parts.map(([label, n]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd data-num>{compact(n)}</dd>
          </div>
        ))}
      </dl>
      {canCompact ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void compactNow(threadId)}>
          Compact older messages
        </button>
      ) : null}
    </div>
  );
}

export function LiveContext() {
  const demo = useUi((s) => s.demo);
  const threadId = useUi((s) => s.lastThreadId) ?? undefined;
  const thread = useThread(demo ? undefined : threadId);

  if (demo) {
    const pct = demoLive.context.ratio * 100;
    return (
      <div className="u-context">
        <div className="u-context__meter">
          <ContextGauge percent={pct} compactsAt={95} />
          <span>{contextWords(pct, 95)}</span>
        </div>
        <p className="u-quiet">Sample figures: start NVX Ancile to measure your own threads.</p>
      </div>
    );
  }
  if (!threadId)
    return (
      <Empty
        line="No thread open yet."
        more="Open a thread and this shows how full its context is for the model that answers it, what fills it, and when it compacts."
      />
    );
  if (thread.isPending) return <Skeleton lines={2} label="Reading the thread" />;
  if (thread.isError) {
    if (thread.error instanceof ApiCallError && thread.error.status === 404)
      return (
        <Empty
          line="The thread you last had open is gone."
          more="Open another thread and its context shows here."
        />
      );
    return <LoadFailed compact error={thread.error} what="The thread" onRetry={() => thread.refetch()} />;
  }
  const t = thread.data;
  return t.claudeCode ? (
    <ClaudeCodeCount threadId={threadId} title={t.title ?? null} />
  ) : (
    <BranchBudget threadId={threadId} title={t.title ?? null} />
  );
}
