/**
 * ------------------------------------------------------------------
 *  Title    |  Approval dialog
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The agent is paused and waiting on you. Say exactly
 *           |  what it wants to do, and let one answer cover the
 *           |  similar requests that will follow (DESIGN.md §5).
 *  How      |  Gated: pick how wide the permission is (the narrowest
 *           |  pattern is pre-selected and editable) and how long it
 *           |  lasts. Critical: no remember option at all; the button
 *           |  says "Approve once" because that is all it can do.
 *           |  A call whose arguments may change (args_editable) has
 *           |  "Edit before allowing": the tool's own editor, then
 *           |  "Allow once with changes" (scope once, updated_args).
 *           |  Core decides again on the changed call; a refusal
 *           |  shows here and the dialog stays open.
 *           |  A pattern of my own has an (i) that opens worked
 *           |  examples in place, and a live check that it covers the
 *           |  request (Core's own matcher). When more than one request
 *           |  waits in the thread, they are listed here: each can be
 *           |  answered in place or opened, or all at once. A remembered
 *           |  answer settles the others it covers (Core decides each
 *           |  again), and the dialog moves on to the next one left.
 *  Note     |  The answer goes to POST /approvals/:id; the run picks
 *           |  up in the thread at once. Core enforces the same rules
 *           |  (a critical approval cannot be remembered, a pattern
 *           |  must cover what was asked), so the dialog only guides.
 * ------------------------------------------------------------------
 */

import type { Approval } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys, useApprovals, useNotebooks, useThreads } from '../lib/data';
import { toPendingApproval } from '../lib/mappers';
import { queryClient } from '../lib/query';
import type { PendingApproval } from '../lib/types';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { TierBadge } from '../ui/primitives';
import { ArgsEditor, sameArgs } from './EditArgs';
import { describePattern, PATTERN_EXAMPLES, patternCovers } from './patterns';
import { usePermissionPreset } from './preset';

const SCOPES = [
  { id: 'once', label: 'Just this once', hint: 'Ask again next time' },
  { id: 'thread', label: 'In this thread', hint: 'Until the thread ends' },
  { id: 'notebook', label: 'In this notebook', hint: 'For every thread in this notebook' },
  { id: 'always', label: 'Always', hint: 'Everywhere, until you revoke it' },
] as const;

const EXPIRY = [
  { id: '0', label: 'No expiry' },
  { id: '3600', label: '1 hour' },
  { id: '86400', label: '1 day' },
  { id: '604800', label: '1 week' },
];

/**
 * The requests still waiting, read fresh from Core (a saved answer may have
 * settled some). In the demo, the cached list less the ones just answered.
 */
async function freshPending(demo: boolean, answered: string[]): Promise<PendingApproval[]> {
  if (demo) {
    const cached = queryClient.getQueryData<PendingApproval[]>(keys.approvals) ?? [];
    return cached.filter((a) => !answered.includes(a.id));
  }
  return (await api.get<{ items: Approval[] }>('/approvals')).items.map(toPendingApproval);
}

const errorText = (error: unknown) => ({
  title: error instanceof ApiCallError ? error.body.error.title : 'Your answer did not reach Core',
  body:
    error instanceof ApiCallError
      ? error.body.error.hint
      : 'Check that NVX Ancile is running, then answer again.',
});

const shortTarget = (a: PendingApproval) => {
  const r = a.resource.replace(/^(web:search\/|http:https?:\/\/|fs:|shell:|mcp:)/, '');
  return r.length > 60 ? `${r.slice(0, 59)}…` : r;
};

/** Worked examples for a pattern of your own; each one fills the field. */
function PatternHelp({ id, onPick }: { id: string; onPick: (pattern: string) => void }) {
  return (
    <section id={id} className="pattern-help" aria-label="How patterns work">
      <p className="pattern-help__lede">
        A pattern says which later requests this answer covers. Choose an example to fill the field, then
        adjust it. Core only saves a pattern that covers the request in front of you.
      </p>
      <ul className="pattern-help__list">
        {PATTERN_EXAMPLES.map((x) => (
          <li key={x.pattern}>
            <button type="button" className="pattern-help__ex" onClick={() => onPick(x.pattern)}>
              <span>{x.label}</span>
              <code data-num>{x.pattern}</code>
            </button>
            {x.note ? <span className="pattern-help__note">{x.note}</span> : null}
          </li>
        ))}
      </ul>
      <p className="pattern-help__more">
        <strong>Denying instead.</strong> Choose a pattern and a Remember scope, then press Decline and
        remember: matching requests are refused without asking, and a deny beats an allow of the same reach.
      </p>
      <p className="pattern-help__more">
        <strong>How long it lasts.</strong> Just this once remembers nothing. In this thread covers this
        thread only; in this notebook, every thread in it; Always, everywhere until you revoke it in Admin,
        Permissions. Expires ends it sooner. Critical actions are never remembered.
      </p>
    </section>
  );
}

export function ApprovalDialog({ approval }: { approval: PendingApproval }) {
  const open = useUi((s) => s.approvalOpen);
  const setOpen = useUi((s) => s.setApproval);
  const setMark = useUi((s) => s.setMark);
  const demo = useUi((s) => s.demo);
  const critical = approval.tier === 'critical';
  const threads = useThreads();
  const notebooks = useNotebooks();
  const thread = threads.data?.find((t) => t.id === approval.threadId);
  const notebookId = thread?.notebookId ?? null;
  const notebookTitle = notebooks.data?.find((n) => n.id === notebookId)?.title;
  // Careful remembers an answer for the thread at most (Core refuses wider).
  const careful = usePermissionPreset().data === 'careful';
  const scopes = SCOPES.filter((s) =>
    s.id === 'notebook'
      ? !!notebookId && !careful
      : s.id === 'thread'
        ? !!approval.threadId
        : s.id === 'always'
          ? !careful
          : true,
  );
  const [busy, setBusy] = useState(false);
  const [pattern, setPattern] = useState(approval.suggestions[0] ?? approval.resource);
  const [custom, setCustom] = useState(false);
  const [scope, setScope] = useState<(typeof SCOPES)[number]['id']>('once');
  const [ttl, setTtl] = useState('0');
  // Edit before allowing: the changed arguments, and whether they parse.
  const editable = !!approval.argsEditable && !demo;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(approval.args);
  const [draftValid, setDraftValid] = useState(true);
  const [refusal, setRefusal] = useState<{ title: string; hint: string } | null>(null);
  const [help, setHelp] = useState(false);
  const helpId = useId();
  const checkId = `${helpId}-check`;
  const changed = editing && draftValid && !sameArgs(draft, approval.args);
  const remembering = !critical && !editing && scope !== 'once';
  const covers = patternCovers(pattern, approval);
  // Everything else waiting in this thread (or, outside a thread, everywhere).
  const others = (useApprovals().data ?? []).filter(
    (a) => a.id !== approval.id && (a.threadId ?? null) === (approval.threadId ?? null),
  );
  const waitingCount = others.length + 1;
  const allowable = [approval, ...others].filter((a) => a.tier !== 'critical').length;
  useLayer(open);
  // Focus goes back where it was when the dialog opened, not to the page body.
  const returnTo = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);

  // State starts fresh per approval: AppShell keys this dialog by approval id.
  // (Resetting in an effect on open raced a quick first click.)

  const decide = async (decision: 'approve' | 'deny', withChanges = false) => {
    const remembered = !critical && !editing && scope !== 'once';
    if (!demo) {
      setBusy(true);
      setRefusal(null);
      try {
        await api.post(`/approvals/${approval.id}`, {
          decision,
          scope: critical || editing ? 'once' : scope,
          ...(remembered && { pattern }),
          ...(remembered && ttl !== '0' && { ttl_seconds: Number(ttl) }),
          ...(withChanges && { updated_args: draft }),
        });
      } catch (error) {
        // Changed arguments refused: say why here, and keep the question open.
        if (withChanges && error instanceof ApiCallError && error.status === 422) {
          setRefusal({ title: error.body.error.title, hint: error.body.error.hint });
          return;
        }
        notify({ level: 'error', ...errorText(error) });
        return;
      } finally {
        setBusy(false);
      }
    }
    const left = await moveOn([approval.id]);
    notify({
      level: decision === 'approve' ? 'success' : 'info',
      title:
        decision === 'approve'
          ? withChanges
            ? 'Allowed with your changes. The agent is carrying on.'
            : 'Approved. The agent is carrying on.'
          : 'Declined. The agent has been told.',
      body:
        [
          remembered
            ? `${decision === 'approve' ? 'Allowed' : 'Blocked'} ${SCOPES.find((s) => s.id === scope)?.label.toLowerCase()}: ${pattern}.`
            : '',
          left ? `${left} more waiting in this thread.` : '',
        ]
          .filter(Boolean)
          .join(' ') || undefined,
    });
  };

  /**
   * After an answer: read what is still waiting, and go to the next request in
   * this thread, or close when there is none. Returns how many are left here.
   */
  const moveOn = async (answered: string[]): Promise<number> => {
    const fresh = await freshPending(demo, answered).catch(() => null);
    if (!fresh) {
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
      setOpen(false);
      setMark('idle');
      return 0;
    }
    const here = fresh.filter((a) => (a.threadId ?? null) === (approval.threadId ?? null));
    // Focus first, then the list: the focused request is never missing from it.
    if (here[0]) setOpen(true, here[0].id);
    else {
      setOpen(false);
      setMark('idle');
    }
    queryClient.setQueryData(keys.approvals, fresh);
    return here.length;
  };

  /** Answer another waiting request in place, just this once. */
  const decideOther = async (id: string, decision: 'approve' | 'deny') => {
    if (!demo) {
      setBusy(true);
      try {
        await api.post(`/approvals/${id}`, { decision, scope: 'once' });
      } catch (error) {
        notify({ level: 'error', ...errorText(error) });
        return;
      } finally {
        setBusy(false);
      }
    }
    const fresh = await freshPending(demo, [id]).catch(() => null);
    if (fresh) queryClient.setQueryData(keys.approvals, fresh);
    else void queryClient.invalidateQueries({ queryKey: keys.approvals });
  };

  /**
   * Allow or deny every request waiting here. A remembered answer goes first,
   * on this request, so Core settles the others it covers; the rest are
   * answered once. Critical requests are never allowed in bulk.
   */
  const decideAll = async (decision: 'approve' | 'deny') => {
    const answered: string[] = [];
    if (!demo) {
      setBusy(true);
      try {
        if (remembering) {
          await api.post(`/approvals/${approval.id}`, {
            decision,
            scope,
            pattern,
            ...(ttl !== '0' && { ttl_seconds: Number(ttl) }),
          });
          answered.push(approval.id);
        }
        const still = remembering ? await freshPending(false, answered) : [approval, ...others];
        const ids = still
          .filter((a) => (a.threadId ?? null) === (approval.threadId ?? null))
          .filter((a) => decision === 'deny' || a.tier !== 'critical')
          .map((a) => a.id);
        if (ids.length) await api.post('/approvals/batch', { approval_ids: ids, decision });
        answered.push(...ids);
      } catch (error) {
        notify({ level: 'error', ...errorText(error) });
        return;
      } finally {
        setBusy(false);
      }
    } else {
      answered.push(
        approval.id,
        ...others.filter((a) => decision === 'deny' || a.tier !== 'critical').map((a) => a.id),
      );
    }
    const left = await moveOn(answered);
    notify({
      level: decision === 'approve' ? 'success' : 'info',
      title:
        decision === 'approve' ? 'Allowed. The agent is carrying on.' : 'Declined. The agent has been told.',
      body: left
        ? `${left} critical ${left === 1 ? 'request is' : 'requests are'} still waiting: answer each one.`
        : undefined,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content
          className="dialog approval"
          data-tier={approval.tier}
          aria-describedby="approval-desc"
          // Land on the question itself: neither answer should be one keypress away.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            const el = returnTo.current;
            if (el instanceof HTMLElement && el.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
          tabIndex={-1}
        >
          <div className="approval__head">
            <span className="approval__badges">
              <TierBadge tier={approval.tier} />
              {waitingCount > 1 ? (
                <span className="approval__count" data-num>
                  {waitingCount} waiting
                </span>
              ) : null}
            </span>
            <Dialog.Close className="icon-btn icon-btn--sm" aria-label="Decide later">
              <Icon name="close" size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Title className="dialog__title">
            {critical ? 'NVX Ancile needs your go-ahead for this' : 'Allow the agent to do this?'}
          </Dialog.Title>
          <p id="approval-desc" className="dialog__lede">
            {approval.reason}
          </p>

          <dl className="approval__facts">
            {approval.threadId ? (
              <>
                <dt>Thread</dt>
                <dd>
                  <Link
                    to="/t/$threadId"
                    params={{ threadId: approval.threadId }}
                    className="approval__thread"
                    onClick={() => setOpen(false)}
                  >
                    {thread?.title || 'Untitled thread'}
                  </Link>
                </dd>
              </>
            ) : null}
            <dt>Tool</dt>
            <dd data-num>{approval.tool}</dd>
            <dt>Action</dt>
            <dd data-num>{approval.action}</dd>
            <dt>On</dt>
            <dd data-num className="approval__resource">
              {approval.resource}
            </dd>
          </dl>
          {editing ? (
            <section className="approval__edit" aria-label="Edit before allowing">
              <div className="approval__edit-head">
                <span>Change what it will do</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setEditing(false);
                    setDraft(approval.args);
                    setDraftValid(true);
                    setRefusal(null);
                  }}
                >
                  Discard changes
                </button>
              </div>
              <ArgsEditor
                tool={approval.tool}
                original={approval.args}
                value={draft}
                onChange={(v, valid) => {
                  setDraftValid(valid);
                  if (valid) setDraft(v);
                  setRefusal(null);
                }}
              />
            </section>
          ) : (
            <pre className="approval__preview">{approval.argsPreview}</pre>
          )}
          {refusal ? (
            <p className="approval__refusal" role="alert">
              <Icon name="alert" size={14} />
              <span>
                <strong>{refusal.title}</strong> {refusal.hint}
              </span>
            </p>
          ) : null}

          {critical ? (
            <p className="approval__critical">
              <Icon name="warn" size={14} />
              Critical actions are never remembered. NVX Ancile will ask every time.
            </p>
          ) : (
            <>
              {editing ? (
                <p className="approval__critical approval__once">
                  <Icon name="shield" size={14} />
                  Changes apply to this call only, so remembering is off while you edit.
                </p>
              ) : null}
              <fieldset className="field" disabled={editing}>
                <legend>Allow</legend>
                <RadioGroup.Root
                  className="choices"
                  disabled={editing}
                  value={custom ? '__custom' : pattern}
                  onValueChange={(v) => {
                    if (v === '__custom') setCustom(true);
                    else {
                      setCustom(false);
                      setPattern(v);
                    }
                  }}
                >
                  {approval.suggestions.map((p, i) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: the Radix radio inside is the control
                    <label key={p} className="choice">
                      <RadioGroup.Item value={p} className="radio">
                        <RadioGroup.Indicator className="radio__dot" />
                      </RadioGroup.Item>
                      <span className="choice__text">
                        <span>{describePattern(p, i, approval.resource)}</span>
                        <span data-num className="mute choice__mono">
                          {p}
                        </span>
                      </span>
                    </label>
                  ))}
                  <div className="choice-row">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: the Radix radio inside is the control */}
                    <label className="choice">
                      <RadioGroup.Item value="__custom" className="radio">
                        <RadioGroup.Indicator className="radio__dot" />
                      </RadioGroup.Item>
                      <span className="choice__text">
                        <span>A pattern of my own</span>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm choice-row__info"
                      aria-label="How patterns work"
                      aria-expanded={help}
                      aria-controls={helpId}
                      title="How patterns work"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setHelp((x) => !x);
                      }}
                    >
                      <Icon name="info" size={14} />
                    </button>
                  </div>
                  {custom ? (
                    <div className="pattern-field">
                      <input
                        className="input input--mono"
                        value={pattern}
                        onChange={(e) => setPattern(e.target.value)}
                        aria-label="Custom pattern"
                        aria-describedby={checkId}
                        spellCheck={false}
                      />
                      <p
                        id={checkId}
                        className="pattern-field__check"
                        data-ok={covers || undefined}
                        aria-live="polite"
                      >
                        <Icon name={covers ? 'check' : 'warn'} size={12} />
                        <span>
                          This pattern matches the current request: {covers ? 'yes' : 'no'}
                          {covers && others.length
                            ? `. It also matches ${others.filter((o) => patternCovers(pattern, o)).length} of the ${others.length} others waiting.`
                            : ''}
                        </span>
                      </p>
                    </div>
                  ) : null}
                </RadioGroup.Root>
                {help ? (
                  <PatternHelp
                    id={helpId}
                    onPick={(p) => {
                      setCustom(true);
                      setPattern(p);
                    }}
                  />
                ) : null}
              </fieldset>

              <div className="approval__row">
                <fieldset className="field" disabled={editing}>
                  <legend>Remember</legend>
                  <RadioGroup.Root
                    className="segmented"
                    disabled={editing}
                    value={scope}
                    onValueChange={(v) => setScope(v as typeof scope)}
                    aria-label="Remember this decision"
                  >
                    {scopes.map((s) => (
                      <RadioGroup.Item
                        key={s.id}
                        value={s.id}
                        className="segmented__opt"
                        title={
                          s.id === 'notebook' && notebookTitle
                            ? `For every thread in ${notebookTitle}`
                            : s.hint
                        }
                      >
                        {s.label}
                      </RadioGroup.Item>
                    ))}
                  </RadioGroup.Root>
                </fieldset>
                <label className="field field--inline">
                  <span>Expires</span>
                  <select
                    className="input"
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    disabled={editing || scope === 'once'}
                  >
                    {EXPIRY.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}

          {others.length ? (
            <section className="approval__queue" aria-label="Other requests waiting">
              <h3 className="approval__queue-title">
                Also waiting in this thread <span data-num>({others.length})</span>
              </h3>
              <ul>
                {others.map((o) => (
                  <li key={o.id} data-tier={o.tier}>
                    <button
                      type="button"
                      className="approval__queue-open"
                      onClick={() => setOpen(true, o.id)}
                      title="Open this request"
                    >
                      <span className="approval__queue-tool">{o.tool}</span>
                      <span data-num className="approval__queue-target">
                        {shortTarget(o)}
                      </span>
                      {remembering && patternCovers(pattern, o) ? (
                        <span className="approval__queue-match">Covered by your answer</span>
                      ) : null}
                    </button>
                    {o.tier === 'critical' ? (
                      <span className="approval__queue-note">Critical: open it to answer</span>
                    ) : (
                      <span className="approval__queue-acts">
                        <button
                          type="button"
                          className="link-btn"
                          disabled={busy}
                          onClick={() => void decideOther(o.id, 'deny')}
                        >
                          Decline
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={busy}
                          onClick={() => void decideOther(o.id, 'approve')}
                        >
                          Allow once
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {!editing ? (
                <div className="approval__queue-all">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => void decideAll('deny')}
                  >
                    Decline all {waitingCount}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy || allowable === 0}
                    onClick={() => void decideAll('approve')}
                    title={
                      remembering
                        ? 'Remembers your answer on this request first, then allows the rest once'
                        : 'Allows each of them once'
                    }
                  >
                    Allow all {allowable}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="dialog__actions" data-tour="approval-choices">
            {editable && !editing ? (
              <button
                type="button"
                className="btn btn--ghost approval__edit-btn"
                onClick={() => {
                  setEditing(true);
                  setScope('once');
                }}
                disabled={busy}
              >
                <Icon name="edit" size={13} />
                Edit before allowing
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void decide('deny')}
              disabled={busy}
            >
              {critical || editing || scope === 'once' ? 'Decline' : 'Decline and remember'}
            </button>
            {editing ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void decide('approve', true)}
                disabled={busy || !changed}
                title={!draftValid ? 'Fix the JSON first' : !changed ? 'Nothing changed yet' : undefined}
              >
                Allow once with changes
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void decide('approve')}
                disabled={busy}
                data-autofocus
              >
                {critical || scope === 'once' ? 'Approve once' : 'Approve and remember'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
