/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode in a thread
 *  Ref      |  docs/auto-mode.md (Low friction)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything Auto mode needs from you, with as little in
 *           |  the way as possible: a grouped card when several asks
 *           |  share a batch, a compact plan card when a plan waits for
 *           |  your yes, and once approved a slim "Working to your
 *           |  plan" line with progress. A quiet badge marks each call
 *           |  that ran by itself.
 *  How      |  At most one card at a time, above the composer: a batch
 *           |  first (the run is waiting on it), then a plan to
 *           |  approve, else the plan line. Every card collapses. No
 *           |  modals: answers go straight to Core.
 *           |  Batch: POST /approvals/:id (once) per item, or POST
 *           |  /approvals/batch for "Allow all" and "Deny all".
 *           |  Plan: GET /auto/plans/current?thread_id=, refetched on
 *           |  plan.changed; POST /auto/plans/:id/decision.
 *           |  A step outside your approved plan joins the batch card
 *           |  ("1 step outside your plan") with Allow once, Add to
 *           |  plan (POST /auto/plans/:id/steps, then allow once) and
 *           |  Deny. Above the cards, a quiet line says when the
 *           |  reviewer is offline (GET /auto/reviewer, auto.reviewer),
 *           |  once per outage, until you dismiss it.
 *  Note     |  "Change" puts "About the plan: " in the composer: the
 *           |  agent revises its plan from what you write. The plan
 *           |  stays waiting until then.
 * ------------------------------------------------------------------
 */

import type { AutoPlan, BatchDecisionResult, ReviewerStatus } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { usePermissionPreset } from '../approvals/preset';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Tip } from '../ui/primitives';
import {
  autoWhy,
  type Batch,
  type BatchItem,
  batchTitle,
  dismissedOutage,
  dismissOutage,
  openBatch,
  REVIEWER_KEY,
  reviewerOfflineCopy,
  useAuto,
} from './store';

export const AUTO_KEYS = {
  plan: (threadId: string) => ['auto', 'plan', threadId] as const,
};

const rise = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6, transition: { duration: 0.12 } },
};

function failed(error: unknown, what: string): void {
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} didn't reach Core`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Check that NVX Ancile is running, then try again.',
  });
}

/* ---- The plan ------------------------------------------------------------- */

/** The thread's current plan. Asked only in Auto mode, or once a plan event has arrived. */
export function usePlan(threadId: string) {
  const demo = useUi((s) => s.demo);
  const preset = usePermissionPreset().data;
  const tick = useAuto((s) => s.planTick[threadId] ?? 0);
  useEffect(() => {
    if (tick) void queryClient.invalidateQueries({ queryKey: AUTO_KEYS.plan(threadId) });
  }, [tick, threadId]);
  return useQuery({
    queryKey: AUTO_KEYS.plan(threadId),
    queryFn: () =>
      api
        .get<{ plan: AutoPlan | null }>(`/auto/plans/current?thread_id=${encodeURIComponent(threadId)}`)
        .then((r) => r.plan),
    enabled: !demo && threadId.startsWith('thr_') && (preset === 'auto' || tick > 0),
    staleTime: 30_000,
    retry: false,
  });
}

export async function decidePlan(
  threadId: string,
  plan: AutoPlan,
  decision: 'approve' | 'reject',
): Promise<boolean> {
  try {
    const next = await api.post<AutoPlan>(`/auto/plans/${plan.id}/decision`, { decision });
    queryClient.setQueryData(AUTO_KEYS.plan(threadId), next);
    return true;
  } catch (error) {
    if (error instanceof ApiCallError && error.body.error.code === 'auto.plan_not_pending') {
      void queryClient.invalidateQueries({ queryKey: AUTO_KEYS.plan(threadId) });
      notify({ level: 'info', title: 'This plan was already answered', body: 'Nothing else changed.' });
      return false;
    }
    failed(error, 'Your answer');
    return false;
  }
}

/** How many steps have been used: a step counts once a call that ran under the plan fits its action. */
/** Steps of the plan that ran (their indices, from plan.step_ran). */
export function planProgress(plan: AutoPlan, ran: number[]): number {
  return plan.steps.filter((_, i) => ran.includes(i)).length;
}

function stepTitle(st: AutoPlan['steps'][number]): string {
  return st.note || st.action;
}

function shortResource(r: string): string {
  return r.replace(/^(fs|shell|mcp|http|git):/, '');
}

export function PlanCard({
  threadId,
  plan,
  onChange,
}: {
  threadId: string;
  plan: AutoPlan;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const decide = async (d: 'approve' | 'reject') => {
    setBusy(d);
    await decidePlan(threadId, plan, d);
    setBusy(null);
  };
  return (
    <section className="auto-card" data-kind="plan" aria-label="A plan waits for your answer">
      <button
        type="button"
        className="auto-card__head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="auto-card__chev" />
        <span className="auto-card__title">Approve the plan once</span>
        <span className="auto-card__lede">{plan.summary}</span>
        <span className="auto-card__count" data-num>
          {plan.steps.length} {plan.steps.length === 1 ? 'step' : 'steps'}
        </span>
      </button>
      {open ? (
        <>
          <ol className="auto-card__steps">
            {plan.steps.map((st, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are ordered and may repeat
              <li key={i}>
                <span className="auto-card__n" data-num>
                  {i + 1}
                </span>
                <span className="auto-card__step">
                  <span>{stepTitle(st)}</span>
                  <span className="auto-card__mono" data-mono>
                    {st.action} · {shortResource(st.resource)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="auto-card__note mute">
            Calls that fit these steps run without asking. Anything else is still checked.
          </p>
        </>
      ) : null}
      <div className="auto-card__acts">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!!busy}
          onClick={() => void decide('reject')}
        >
          Decline
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={onChange}>
          Change
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!!busy}
          onClick={() => void decide('approve')}
        >
          {busy === 'approve' ? 'Approving' : 'Approve plan'}
        </button>
      </div>
    </section>
  );
}

export function PlanLine({ plan }: { threadId: string; plan: AutoPlan }) {
  const ran = useAuto((s) => s.planRan[plan.id]);
  const [open, setOpen] = useState(false);
  const done = planProgress(plan, ran ?? []);
  const total = plan.steps.length;
  return (
    <div className="plan-line" data-open={open || undefined}>
      <button
        type="button"
        className="plan-line__head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Working to your plan: ${plan.summary}. ${done} of ${total} steps. ${open ? 'Hide' : 'Show'} the steps`}
      >
        <Icon name="check" size={12} className="plan-line__icon" />
        <span className="plan-line__title">Working to your plan</span>
        <span className="plan-line__summary">{plan.summary}</span>
        <span className="plan-line__bar" aria-hidden="true">
          <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </span>
        <span className="plan-line__count" data-num>
          {done} of {total}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
      </button>
      {open ? (
        <ol className="plan-line__steps">
          {plan.steps.map((st, i) => {
            const used = (ran ?? []).includes(i);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are ordered and may repeat
              <li key={i} data-used={used || undefined}>
                <Icon name={used ? 'check' : 'dot'} size={11} />
                <span>{stepTitle(st)}</span>
                <span className="auto-card__mono" data-mono>
                  {shortResource(st.resource)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

/* ---- The grouped asks ---------------------------------------------------- */

const STATE_WORD: Record<BatchItem['state'], string> = {
  waiting: 'Waiting',
  allowed: 'Allowed',
  denied: 'Denied',
  gone: 'Answered',
};

export async function answerItem(item: BatchItem, decision: 'approve' | 'deny'): Promise<void> {
  if (!item.approvalId) return;
  try {
    await api.post(`/approvals/${item.approvalId}`, { decision, scope: 'once' });
    useAuto.getState().settle([item.approvalId], decision === 'approve' ? 'allowed' : 'denied');
  } catch (error) {
    failed(error, 'Your answer');
  }
  void queryClient.invalidateQueries({ queryKey: keys.approvals });
}

/** Add this step to the approved plan, then let this call run once. */
export async function addToPlan(threadId: string, item: BatchItem): Promise<void> {
  if (!item.approvalId || !item.planId || !item.resource) return;
  try {
    await api.post<AutoPlan>(`/auto/plans/${encodeURIComponent(item.planId)}/steps`, {
      action: item.action,
      resource: item.resource,
      note: `Added from a step outside the plan (${item.tool ?? item.action})`,
    });
    void queryClient.invalidateQueries({ queryKey: AUTO_KEYS.plan(threadId) });
  } catch (error) {
    failed(error, 'Adding the step');
    return;
  }
  await answerItem(item, 'approve');
}

export async function answerBatch(batch: Batch, decision: 'approve' | 'deny'): Promise<void> {
  const ids = batch.items.flatMap((i) => (i.state === 'waiting' && i.approvalId ? [i.approvalId] : []));
  if (!ids.length) return;
  try {
    const r = await api.post<BatchDecisionResult>('/approvals/batch', { approval_ids: ids, decision });
    const by = (st: string) => r.items.filter((i) => i.status === st).map((i) => i.approval_id);
    const { settle } = useAuto.getState();
    settle(by('approved'), 'allowed');
    settle(by('denied'), 'denied');
    settle(
      r.items
        .filter((i) => i.status !== 'approved' && i.status !== 'denied' && i.status !== 'pending')
        .map((i) => i.approval_id),
      'gone',
    );
  } catch (error) {
    failed(error, 'Your answer');
  }
  void queryClient.invalidateQueries({ queryKey: keys.approvals });
}

export function BatchCard({ batch: given }: { batch: Batch }) {
  // Read it live: an answer to one ask changes what "Allow all" covers.
  const batch = useAuto((s) => s.batches[given.id]) ?? given;
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const waiting = batch.items.filter((i) => i.state === 'waiting');
  const ready = waiting.some((i) => i.approvalId);
  const all = async (d: 'approve' | 'deny') => {
    setBusy(true);
    await answerBatch(batch, d);
    setBusy(false);
  };
  return (
    <section className="auto-card" data-kind="batch" aria-label="Auto mode needs your answer">
      <button
        type="button"
        className="auto-card__head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="auto-card__chev" />
        <span className="auto-card__title">{batchTitle(waiting)}</span>
        <span className="auto-card__lede">
          {waiting.length && waiting.every((i) => i.outOfPlan)
            ? 'Your approved plan does not cover this'
            : 'Auto mode could not settle these by itself'}
        </span>
      </button>
      {open ? (
        <ul className="auto-card__items">
          {batch.items.map((item, i) => {
            const what = `${item.action}${item.resource ? ` on ${shortResource(item.resource)}` : ''}`;
            return (
              <li key={item.approvalId ?? `${item.action}-${i}`} data-state={item.state}>
                <span className="auto-card__step">
                  <span className="auto-card__mono" data-mono>
                    {item.action}
                    {item.resource ? <span className="mute"> {shortResource(item.resource)}</span> : null}
                  </span>
                  <span className="auto-card__why">
                    {item.outOfPlan ? <span className="auto-card__tag">Outside your plan</span> : null}
                    {item.reason}
                  </span>
                </span>
                {item.state === 'waiting' ? (
                  <span className="auto-card__item-acts">
                    <button
                      type="button"
                      className="btn btn--ghost btn--xs"
                      disabled={!item.approvalId || busy}
                      aria-label={`Deny ${what}`}
                      onClick={() => void answerItem(item, 'deny')}
                    >
                      Deny
                    </button>
                    {item.outOfPlan && item.planId && item.resource ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        disabled={!item.approvalId || busy}
                        aria-label={`Add ${what} to the plan and allow it`}
                        onClick={() => {
                          setBusy(true);
                          void addToPlan(batch.threadId, item).finally(() => setBusy(false));
                        }}
                      >
                        Add to plan
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--xs"
                      disabled={!item.approvalId || busy}
                      aria-label={`Allow ${what} once`}
                      onClick={() => void answerItem(item, 'approve')}
                    >
                      {item.outOfPlan ? 'Allow once' : 'Allow'}
                    </button>
                  </span>
                ) : (
                  <span className="auto-card__state">{STATE_WORD[item.state]}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="auto-card__acts">
        <span className="auto-card__note mute">Each answer covers this one call. Nothing is remembered.</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!ready || busy}
          onClick={() => void all('deny')}
        >
          Deny all
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!ready || busy}
          onClick={() => void all('approve')}
        >
          Allow all
        </button>
      </div>
    </section>
  );
}

/* ---- Reviewer offline ----------------------------------------------------- */

/** Asked only in Auto mode; the global stream keeps it current. */
export function useReviewerStatus() {
  const demo = useUi((s) => s.demo);
  const preset = usePermissionPreset().data;
  return useQuery({
    queryKey: REVIEWER_KEY,
    queryFn: () => api.get<ReviewerStatus>('/auto/reviewer'),
    enabled: !demo && preset === 'auto',
    staleTime: 60_000,
    retry: false,
  });
}

/** One quiet line while Auto mode decides by its rules alone. Dismissed per outage. */
export function ReviewerOffline({ status }: { status: ReviewerStatus }) {
  const [gone, setGone] = useState(() => dismissedOutage());
  if (status.status !== 'offline' || !status.outage_id || gone === status.outage_id) return null;
  const { why, fix } = reviewerOfflineCopy(status);
  const id = status.outage_id;
  return (
    <div className="reviewer-off" role="status">
      <Icon name="shield" size={12} className="reviewer-off__icon" />
      <span className="reviewer-off__text">
        <strong>Reviewer offline, asking more often.</strong> {why}.
      </span>
      <Link to={fix.to} params={fix.params as never} className="reviewer-off__fix">
        {fix.label}
      </Link>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Dismiss the reviewer notice"
        onClick={() => {
          dismissOutage(id);
          setGone(id);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/* ---- One card at a time -------------------------------------------------- */

export function AutoSlot({ threadId, onChangePlan }: { threadId: string; onChangePlan: () => void }) {
  const batches = useAuto((s) => s.batches);
  const batch = openBatch(batches, threadId);
  const plan = usePlan(threadId).data;
  const reviewer = useReviewerStatus().data;
  const which = batch
    ? 'batch'
    : plan?.status === 'proposed'
      ? 'plan'
      : plan?.status === 'approved'
        ? 'line'
        : null;
  return (
    <>
      {reviewer ? <ReviewerOffline status={reviewer} /> : null}
      <AnimatePresence initial={false} mode="wait">
        {which === 'batch' && batch ? (
          <motion.div key={`b-${batch.id}`} {...rise}>
            <BatchCard batch={batch} />
          </motion.div>
        ) : which === 'plan' && plan ? (
          <motion.div key={`p-${plan.id}`} {...rise}>
            <PlanCard threadId={threadId} plan={plan} onChange={onChangePlan} />
          </motion.div>
        ) : which === 'line' && plan ? (
          <motion.div key={`l-${plan.id}`} {...rise}>
            <PlanLine threadId={threadId} plan={plan} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/* ---- The quiet badge ----------------------------------------------------- */

/** "Ran automatically" on a tool step Auto mode let through; the tooltip says who checked it and why. */
export function AutoRanBadge({ callId }: { callId: string }) {
  const mark = useAuto((s) => s.marks[callId]);
  if (!mark) return null;
  const why = autoWhy(mark);
  return (
    <Tip label={why}>
      <button type="button" className="auto-ran" aria-label={`Ran automatically. ${why}`}>
        <Icon name="sparkle" size={10} />
        Ran automatically
      </button>
    </Tip>
  );
}
