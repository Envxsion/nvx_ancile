/**
 * ------------------------------------------------------------------
 *  Title    |  Compute rules
 *  Ref      |  DESIGN.md §7.3 · docs/compute.md#rules
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The rules that keep GPU nodes in check: stop idle
 *           |  nodes, a monthly cap, and start or stop on a schedule,
 *           |  on all nodes or the chosen ones, on the chosen days.
 *  How      |  Each rule is a row: a switch, its title and one plain
 *           |  line, and a "more" menu to edit or remove it. Adding or
 *           |  editing opens one dialog whose fields start empty; the
 *           |  save button stays off until the required field reads.
 *           |  Removing asks first, then offers Undo.
 *  Note     |  The checks and wording live in ./ruleDraft.ts, so tests
 *           |  cover them without rendering.
 * ------------------------------------------------------------------
 */

import { WEEKDAYS, type Weekday } from '@nvx/contracts/controller';
import * as Dialog from '@radix-ui/react-dialog';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { type ConfirmCopy, ConfirmDialog } from '../ui/Confirm';
import { Check, Segmented, Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';
import { Skeleton } from '../ui/primitives';
import { type ComputeNode, deleteRule, type Rule, saveRule, useNodes, useRules } from './data';
import {
  DAY_LABEL,
  DAY_NAME,
  draftOf,
  editable,
  emptyDraft,
  problems,
  type RuleDraft,
  type RuleKind,
  ruleOf,
  ruleSummary,
  ruleTitle,
} from './ruleDraft';

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ---- Pickers ------------------------------------------------------------ */

/** Mon to Sun as one compact toggle group; arrows move, Space or Enter toggles. */
export function WeekdayPicker({
  value,
  onChange,
  label = 'Days',
}: {
  value: Weekday[];
  onChange: (next: Weekday[]) => void;
  label?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focus, setFocus] = useState(0);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d =
      e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowLeft'
          ? -1
          : e.key === 'Home'
            ? -i
            : e.key === 'End'
              ? 6 - i
              : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + WEEKDAYS.length) % WEEKDAYS.length;
    setFocus(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="daypick" role="group" aria-label={label}>
      {WEEKDAYS.map((w, i) => {
        const on = value.includes(w);
        return (
          <button
            key={w}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className="daypick__day"
            aria-pressed={on}
            aria-label={DAY_NAME[w]}
            tabIndex={i === focus ? 0 : -1}
            onFocus={() => setFocus(i)}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(on ? value.filter((d) => d !== w) : [...value, w])}
          >
            {DAY_LABEL[w]}
          </button>
        );
      })}
    </div>
  );
}

/** All nodes, or the chosen ones as a list of checkboxes. */
export function NodePicker({
  nodes,
  scope,
  chosen,
  onScope,
  onChosen,
  label,
}: {
  nodes: Pick<ComputeNode, 'id' | 'name'>[];
  scope: 'all' | 'chosen';
  chosen: string[];
  onScope: (s: 'all' | 'chosen') => void;
  onChosen: (ids: string[]) => void;
  label: string;
}) {
  return (
    <div className="rule-nodes">
      <Segmented
        size="sm"
        label={label}
        value={scope}
        onChange={onScope}
        options={[
          { value: 'all', label: 'All nodes' },
          { value: 'chosen', label: 'Chosen nodes' },
        ]}
      />
      {scope === 'chosen' ? (
        nodes.length === 0 ? (
          <span className="field__hint">No nodes yet. Add one first, or pick All nodes.</span>
        ) : (
          <ul className="rule-nodes__list">
            {nodes.map((n) => {
              const on = chosen.includes(n.id);
              return (
                <li key={n.id}>
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: Check is a button, which its label activates */}
                  <label className="rule-nodes__item">
                    <Check
                      checked={on}
                      label={n.name}
                      onChange={(next) =>
                        onChosen(next ? [...chosen, n.id] : chosen.filter((id) => id !== n.id))
                      }
                    />
                    <span>{n.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}

/* ---- Dialog ------------------------------------------------------------- */

const DIALOG_TITLE: Record<RuleKind, [string, string]> = {
  idle_timeout: ['Add an idle stop', 'Edit the idle stop'],
  cost_cap: ['Add a monthly cap', 'Edit the monthly cap'],
  schedule: ['Add a schedule', 'Edit the schedule'],
};

const DIALOG_LEDE: Record<RuleKind, string> = {
  idle_timeout: 'Stop a running node after a stretch with no requests. Its storage is kept.',
  cost_cap: 'A hard ceiling on GPU spend this month, counted across every node.',
  schedule: 'Start or stop nodes at a set time, on the days you choose.',
};

export function RuleDialog({
  draft: initial,
  nodes,
  onClose,
}: {
  draft: RuleDraft | null;
  nodes: Pick<ComputeNode, 'id' | 'name'>[];
  onClose: () => void;
}) {
  const open = Boolean(initial);
  useLayer(open);
  // Keyed by the caller, so a new dialog starts from its own draft.
  const [d, setD] = useState<RuleDraft | null>(initial);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const ids = useId();
  const draft = d ?? initial;
  if (!draft) return null;
  const set = (patch: Partial<RuleDraft>) => setD({ ...draft, ...patch });
  const issues = problems(draft);
  const issue = (f: string) => issues.find((p) => p.field === f)?.message;
  const editing = Boolean(draft.id);
  const ready = issues.length === 0;

  const submit = async () => {
    setTouched(true);
    if (!ready || busy) return;
    setBusy(true);
    const ok = await saveRule(ruleOf(draft) as Rule);
    setBusy(false);
    if (ok) onClose();
  };

  // Shown once the field holds something, or after a save attempt.
  const shown = (f: 'minutes' | 'amount' | 'time' | 'days' | 'nodes', value: string | boolean) =>
    touched || value ? issue(f) : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick rule-dialog" aria-describedby={`${ids}-desc`}>
          <Dialog.Title className="dialog__title">{DIALOG_TITLE[draft.kind][editing ? 1 : 0]}</Dialog.Title>
          <p id={`${ids}-desc`} className="dialog__lede">
            {DIALOG_LEDE[draft.kind]}
          </p>
          <form
            className="rule-dialog__form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {draft.kind === 'idle_timeout' ? (
              <label className="field">
                <span>Minutes with no requests</span>
                <input
                  className="input rule__num"
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={1440}
                  step={1}
                  value={draft.minutes}
                  placeholder="For example, 30"
                  onChange={(e) => set({ minutes: e.target.value })}
                  aria-invalid={Boolean(shown('minutes', draft.minutes)) || undefined}
                  // biome-ignore lint/a11y/noAutofocus: the dialog opens to its one required field
                  autoFocus
                />
                {shown('minutes', draft.minutes) ? (
                  <span className="field__error">{issue('minutes')}</span>
                ) : (
                  <span className="field__hint">
                    From 5 to 1440. Time counts from the later of the last request and start-up.
                  </span>
                )}
              </label>
            ) : null}

            {draft.kind === 'cost_cap' ? (
              <>
                <label className="field">
                  <span>Monthly cap in US dollars</span>
                  <input
                    className="input rule__num"
                    type="number"
                    inputMode="decimal"
                    min={1}
                    step="any"
                    value={draft.amount}
                    placeholder="For example, 150"
                    onChange={(e) => set({ amount: e.target.value })}
                    aria-invalid={Boolean(shown('amount', draft.amount)) || undefined}
                    // biome-ignore lint/a11y/noAutofocus: the dialog opens to its one required field
                    autoFocus
                  />
                  {shown('amount', draft.amount) ? (
                    <span className="field__error">{issue('amount')}</span>
                  ) : (
                    <span className="field__hint">You are warned at 80%.</span>
                  )}
                </label>
                <div className="field">
                  <span>When the cap is reached</span>
                  <Segmented
                    size="sm"
                    label="When the cap is reached"
                    value={draft.onReach}
                    onChange={(onReach) => set({ onReach })}
                    options={[
                      { value: 'block_routing', label: 'Use the cloud' },
                      { value: 'stop_nodes', label: 'Stop nodes' },
                      { value: 'notify_only', label: 'Just tell me' },
                    ]}
                  />
                </div>
              </>
            ) : null}

            {draft.kind === 'schedule' ? (
              <>
                <div className="field">
                  <span>Action</span>
                  <Segmented
                    size="sm"
                    label="Action"
                    value={draft.action}
                    onChange={(action) => set({ action })}
                    options={[
                      { value: 'stop', label: 'Stop' },
                      { value: 'start', label: 'Start' },
                    ]}
                  />
                </div>
                <label className="field">
                  <span>Time</span>
                  <input
                    className="input rule__num"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={draft.time}
                    placeholder="HH:MM, like 23:00"
                    onChange={(e) => set({ time: e.target.value })}
                    aria-invalid={Boolean(shown('time', draft.time)) || undefined}
                    // biome-ignore lint/a11y/noAutofocus: the dialog opens to its one required field
                    autoFocus
                  />
                  {shown('time', draft.time) ? (
                    <span className="field__error">{issue('time')}</span>
                  ) : (
                    <span className="field__hint">24-hour time, in {draft.tz}.</span>
                  )}
                </label>
                <div className="field">
                  <span>Days</span>
                  <WeekdayPicker value={draft.days} onChange={(days) => set({ days })} />
                  {issue('days') ? <span className="field__error">{issue('days')}</span> : null}
                </div>
              </>
            ) : null}

            {draft.kind !== 'cost_cap' || draft.onReach === 'stop_nodes' ? (
              <div className="field">
                <span>{draft.kind === 'cost_cap' ? 'Nodes to stop' : 'Nodes'}</span>
                <NodePicker
                  nodes={nodes}
                  scope={draft.scope}
                  chosen={draft.nodeIds}
                  onScope={(scope) => set({ scope })}
                  onChosen={(nodeIds) => set({ nodeIds })}
                  label={draft.kind === 'cost_cap' ? 'Nodes to stop' : 'Nodes this rule acts on'}
                />
                {draft.scope === 'chosen' && issue('nodes') ? (
                  <span className="field__error">{issue('nodes')}</span>
                ) : null}
              </div>
            ) : null}

            <div className="dialog__actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn--ghost">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
                {busy ? 'Saving…' : editing ? 'Save rule' : 'Add rule'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---- List --------------------------------------------------------------- */

function RuleRow({
  rule,
  names,
  onEdit,
  onRemove,
}: {
  rule: Rule;
  names: Map<string, string>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const title = ruleTitle(rule);
  const toggle = (enabled: boolean) => void saveRule({ ...rule, enabled } as Rule);
  const canEdit = editable(rule);
  return (
    <li className="rule" data-enabled={rule.enabled || undefined}>
      <Switch checked={rule.enabled} onChange={toggle} label={`${title}: ${rule.enabled ? 'on' : 'off'}`} />
      <div className="rule__main">
        <span className="rule__title">{title}</span>
        <span className="rule__field">{ruleSummary(rule, names)}</span>
      </div>
      <DropMenu
        items={[
          {
            label: canEdit ? 'Edit rule' : 'Edit over the API only',
            icon: 'edit',
            disabled: !canEdit,
            onSelect: onEdit,
          },
          { kind: 'separator' },
          { label: 'Remove rule', icon: 'trash', danger: true, onSelect: onRemove },
        ]}
        trigger={
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for rule: ${title}`}>
            <Icon name="more" size={15} />
          </button>
        }
      />
    </li>
  );
}

export function Rules() {
  const rules = useRules();
  const nodes = useNodes();
  const items = rules.data ?? [];
  const live = useMemo(
    () => (nodes.data ?? []).filter((n) => n.observed_state !== 'terminated'),
    [nodes.data],
  );
  const names = useMemo(() => new Map((nodes.data ?? []).map((n) => [n.id, n.name])), [nodes.data]);
  const has = (k: Rule['kind']) => items.some((r) => r.kind === k);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [removing, setRemoving] = useState<{ rule: Rule; copy: ConfirmCopy } | null>(null);

  const openDraft = (d: RuleDraft) => {
    setDialogKey((k) => k + 1);
    setDraft(d);
  };
  const add = (kind: RuleKind) => openDraft(emptyDraft(kind, localTz()));

  return (
    <section className="compute__section" aria-labelledby="rules-h">
      <div className="compute__section-head">
        <h3 id="rules-h" className="admin__h">
          Rules
        </h3>
        <div className="compute__adds">
          {!has('idle_timeout') ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => add('idle_timeout')}>
              <Icon name="plus" size={13} />
              Idle stop
            </button>
          ) : null}
          {!has('cost_cap') ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => add('cost_cap')}>
              <Icon name="plus" size={13} />
              Monthly cap
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => add('schedule')}>
            <Icon name="plus" size={13} />
            Schedule
          </button>
        </div>
      </div>
      <p className="mute compute__lede">
        Rules act through the same confirmation chain as your own clicks, and every action they take is listed
        on the node.
      </p>
      {rules.isPending ? (
        <Skeleton lines={3} label="Loading rules" />
      ) : items.length === 0 ? (
        <p className="mute">No rules yet. An idle stop is the one most people want first.</p>
      ) : (
        <ul className="rules">
          {items.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              names={names}
              onEdit={() => {
                const d = draftOf(r, localTz());
                // Nodes since removed drop out; they would only be invisible ticks.
                d.nodeIds = d.nodeIds.filter((id) => live.some((n) => n.id === id));
                openDraft(d);
              }}
              onRemove={() =>
                setRemoving({
                  rule: r,
                  copy: {
                    title: `Remove the rule "${ruleTitle(r)}"?`,
                    body: 'It stops acting at once. Nodes it already started or stopped stay as they are. You can undo it from the notice that follows.',
                    action: 'Remove rule',
                  },
                })
              }
            />
          ))}
        </ul>
      )}
      <RuleDialog key={dialogKey} draft={draft} nodes={live} onClose={() => setDraft(null)} />
      <ConfirmDialog
        copy={removing?.copy ?? null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void deleteRule(removing.rule, ruleTitle(removing.rule));
        }}
      />
    </section>
  );
}
