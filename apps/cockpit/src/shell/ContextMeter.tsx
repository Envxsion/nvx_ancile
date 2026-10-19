/**
 * ------------------------------------------------------------------
 *  Title    |  Context meter
 *  Ref      |  DESIGN.md §8.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How full this branch is for the model that would answer
 *           |  it, in the status bar: a meter with a tick where it
 *           |  compacts, "62%", and on hover "62% of context: compacts
 *           |  at 95%" with the parts that make it up. Past the warning
 *           |  line it offers to compact.
 *  How      |  GET /threads/:id/context-budget for the open thread,
 *           |  refreshed with the thread. A Claude Code thread shows
 *           |  Claude Code's own count instead (its live state), in the
 *           |  same meter (usage/Meter.tsx). On demo data it shows the
 *           |  sample figures.
 * ------------------------------------------------------------------
 */

import { useNavigate } from '@tanstack/react-router';
import { useClaudeCodeLive } from '../claudecode/live';
import { live as demoLive } from '../fixtures/demoLive';
import { compactNow, useContextBudget } from '../lib/branching';
import { useThread } from '../lib/data';
import { compact } from '../lib/format';
import { useThreadIdFromRoute } from '../lib/models';
import { useUi } from '../state/ui';
import { Tip } from '../ui/primitives';
import { ContextGauge, contextTone, contextWords } from '../usage/Meter';

const LEVEL = { calm: 'ok', high: 'warn', over: 'critical' } as const;

/** Claude Code's own count for a Claude Code thread (nothing until its session is open). */
function ClaudeCodeContext({ threadId }: { threadId: string }) {
  const live = useClaudeCodeLive(threadId).data;
  const navigate = useNavigate();
  const ctx = live?.context ?? null;
  if (!ctx || ctx.max_tokens <= 0) return null;
  const pct = Math.max(0, Math.min(100, ctx.percent));
  const at = ctx.compacts_at ?? null;
  const label = [
    `${contextWords(pct, at)}.`,
    `Claude Code's own count: ${compact(ctx.used_tokens)} of ${compact(ctx.max_tokens)} tokens.`,
    at
      ? 'Claude Code compacts by itself there; type /compact to do it now.'
      : 'Type /compact to compact now.',
  ].join(' ');
  return (
    <Tip label={label}>
      <button
        type="button"
        className="status-seg"
        data-level={LEVEL[contextTone(pct, at)]}
        data-tour="context-meter"
        aria-label={`${label} Open usage`}
        onClick={() => void navigate({ to: '/settings/$group', params: { group: 'usage' } })}
      >
        <ContextGauge percent={pct} compactsAt={at} />
        <span className="mute">context</span>
      </button>
    </Tip>
  );
}

export function ContextMeter() {
  const demo = useUi((s) => s.demo);
  const live = demoLive.context;
  const threadId = useThreadIdFromRoute();
  // Claude Code counts its own context; Ancile's estimate would mislead there.
  const thread = useThread(demo ? undefined : threadId);
  const fromClaudeCode = thread.data ? !!thread.data.claudeCode : null;
  const budget = useContextBudget(demo || fromClaudeCode !== false ? undefined : threadId);

  if (demo) {
    const pct = live.ratio * 100;
    const tone = contextTone(pct, 95);
    return (
      <div
        className="status-seg status-seg--static"
        data-level={LEVEL[tone]}
        title={`${contextWords(pct, 95)}. ${compact(live.used)} of ${compact(live.window)} tokens`}
      >
        <ContextGauge percent={pct} compactsAt={95} />
        <span className="mute">context</span>
      </div>
    );
  }

  if (threadId && fromClaudeCode) return <ClaudeCodeContext threadId={threadId} />;

  const b = budget.data;
  if (!threadId || !b || b.window === 0 || fromClaudeCode !== false) return null;
  const u = b.used;
  const pct = b.ratio * 100;
  const at = (b.compacts_at ?? 0.95) * 100;
  const canCompact = b.level !== 'ok' && b.compactable > 0;
  const label = [
    `${contextWords(pct, at)}.`,
    `${compact(b.total)} of ${compact(b.window)} tokens for this branch.`,
    `History ${compact(u.history)}${b.compaction ? ' (with a summary)' : ''}, system ${compact(u.system)}, room for the reply ${compact(u.reserve_output)}.`,
    canCompact ? 'Click to compact the older messages.' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tip label={label}>
      <button
        type="button"
        className="status-seg"
        data-level={b.level}
        data-tour="context-meter"
        aria-label={`Context used: ${label}`}
        onClick={() => (canCompact ? void compactNow(threadId) : undefined)}
        aria-disabled={!canCompact || undefined}
      >
        <ContextGauge percent={pct} compactsAt={at} />
        <span className="mute">context</span>
      </button>
    </Tip>
  );
}
