/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: the plan's limit
 *  Ref      |  docs/claude-code.md (Usage) · claude_code.plan_limit
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When Claude Code stopped a turn at the plan's limit,
 *           |  say when it resets (local time) and offer "Finish on
 *           |  another model": the model picker, opened on your default
 *           |  model that is not Claude Code, sends "Continue from where
 *           |  Claude Code stopped" to the one you choose. Before a turn,
 *           |  a quiet line when a limit is past 90%.
 *  How      |  The limit is read from the answer at the head of the
 *           |  path (provenance.error, kept through a reload). The
 *           |  continuation is an ordinary turn by another model in a
 *           |  Claude Code thread: it reads the thread through the
 *           |  engines' context assembly (docs/engines.md).
 *  Note     |  Nothing is blocked by the warning; the thread keeps its
 *           |  session for when the limit resets.
 * ------------------------------------------------------------------
 */

import { CONTINUE_AFTER_LIMIT, isClaudeCodeModel, type PlanWindow } from '@nvx/contracts';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { useModels } from '../lib/data';
import type { MessageView, ModelView } from '../lib/types';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { usePlanLimits } from '../usage/api';
import { sendClaudeCode } from './live';
import '../styles/cclive.css';

const two = (n: number) => String(n).padStart(2, '0');

/** "Claude Code limit reached, resets at 14:00" in this computer's local time; a day when not today. */
export function limitTitle(resetsAt: string | null | undefined, now = Date.now()): string {
  const at = resetsAt ? new Date(resetsAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'Claude Code limit reached';
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  if (new Date(now).toDateString() === at.toDateString())
    return `Claude Code limit reached, resets at ${time}`;
  const day = at.toLocaleDateString('en-GB', { weekday: 'short' });
  return `Claude Code limit reached, resets ${day} ${time}`;
}

/** The answer at the head stopped at the plan's limit: when it resets (null when not said), or undefined. */
export function limitOf(head: MessageView | undefined): { resetsAt: string | null } | undefined {
  const e = head?.provenance?.error as { code?: string; resets_at?: unknown } | undefined;
  if (head?.role !== 'assistant' || e?.code !== 'claude_code.plan_limit') return undefined;
  return { resetsAt: typeof e.resets_at === 'string' ? e.resets_at : null };
}

const answers = (m: ModelView) =>
  !isClaudeCodeModel(m.id) && m.chat !== false && (m.status === undefined || m.status === 'ready');

/** The models that can finish: your default first when it is not Claude Code, then the rest. */
export function finishModels(models: ModelView[], defaultId: string | null): ModelView[] {
  const ok = models.filter(answers);
  const def = ok.find((m) => m.id === defaultId) ?? ok.find((m) => m.via !== 'controller' && !m.offline);
  return def ? [def, ...ok.filter((m) => m.id !== def.id)] : ok;
}

/** A window past 90% that has not reset yet, the fullest first. */
export function nearLimit(windows: PlanWindow[], now = Date.now()): PlanWindow | null {
  const near = windows
    .filter((w) => (w.percent ?? 0) >= 90 && (!w.resets_at || Date.parse(w.resets_at) > now))
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  return near[0] ?? null;
}

export function LimitNotice({
  threadId,
  head,
  onSent,
}: {
  threadId: string;
  head: MessageView | undefined;
  onSent?: () => void;
}) {
  const limit = limitOf(head);
  const models = useModels().data ?? [];
  const defaultId = useUi((s) => s.live.modelId) || null;
  const [sending, setSending] = useState(false);
  if (!limit || !head) return null;
  const choices = finishModels(models, defaultId);

  const finish = async (m: ModelView) => {
    setSending(true);
    const ok = await sendClaudeCode({
      threadId,
      parentId: head.id,
      text: CONTINUE_AFTER_LIMIT,
      other: { id: m.id, name: m.name },
    });
    setSending(false);
    if (ok) onSent?.();
  };

  return (
    <div className="cc-notice" data-kind="plan_limit" role="alert">
      <Icon name="clock" size={14} className="cc-notice__icon" />
      <div className="cc-notice__text">
        <p>
          <strong>{limitTitle(limit.resetsAt)}</strong> What it wrote so far is kept.
        </p>
      </div>
      <div className="cc-notice__acts">
        {choices.length ? (
          <DM.Root modal={false}>
            <DM.Trigger asChild>
              <button type="button" className="btn btn--primary btn--sm" disabled={sending}>
                Finish on another model
                <Icon name="chevronDown" size={10} />
              </button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content className="menu" side="top" align="end" sideOffset={6} collisionPadding={8}>
                <DM.Label className="menu__label">Continue from where Claude Code stopped</DM.Label>
                {choices.slice(0, 12).map((m, i) => (
                  <DM.Item key={m.id} className="menu__item" onSelect={() => void finish(m)}>
                    {i === 0 ? <Icon name="check" size={14} /> : <span className="menu__noicon" />}
                    <span className="menu__text">
                      {m.name}
                      {i === 0 && m.id === defaultId ? (
                        <span className="cc-pick__desc">Your default</span>
                      ) : null}
                    </span>
                  </DM.Item>
                ))}
              </DM.Content>
            </DM.Portal>
          </DM.Root>
        ) : (
          <span className="mute">Add another model in Settings → Models to finish now.</span>
        )}
      </div>
    </div>
  );
}

/** "Claude Code's 5-hour limit is 92% used, resets at 15:40". */
export function nearLimitWords(w: PlanWindow): string {
  const name =
    w.kind === 'session'
      ? '5-hour limit'
      : w.kind === 'week'
        ? 'weekly limit'
        : w.kind === 'week_model'
          ? `weekly ${w.label ?? 'model'} limit`
          : `${(w.label ?? 'extra usage').toLowerCase()} limit`;
  const at = w.resets_at ? new Date(w.resets_at) : null;
  const when =
    at && !Number.isNaN(at.getTime()) ? `, resets at ${two(at.getHours())}:${two(at.getMinutes())}` : '';
  return `Claude Code's ${name} is ${Math.round(w.percent ?? 0)}% used${when}`;
}

/** Before a turn: a quiet line when a plan limit is past 90%. Nothing is blocked. */
export function NearLimitLine() {
  const limits = usePlanLimits().data;
  const w = limits?.available ? nearLimit(limits.windows) : null;
  if (!w) return null;
  return (
    <p className="hint-line cc-near-limit" role="status">
      <Icon name="pulse" size={12} className="hint-line__icon" />
      <span className="hint-line__text">{nearLimitWords(w)}</span>
    </p>
  );
}
