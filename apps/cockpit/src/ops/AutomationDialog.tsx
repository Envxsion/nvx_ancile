/**
 * ------------------------------------------------------------------
 *  Title    |  Automation dialog
 *  Ref      |  packages/contracts/src/ops.ts (Create/UpdateAutomationRequest)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Make an automation of your own, or change one: what it
 *           |  does, when it runs, and for a built-in job its settings.
 *  How      |  One form for both. The schedule picker covers every N
 *           |  minutes or hours, daily, and weekly on chosen days, with
 *           |  Custom for any other cron; Core checks it again. A
 *           |  built-in job keeps its name and what it does; only its
 *           |  schedule (when it has one) and its own options change
 *           |  here, each option as a field of its type. Back up memory
 *           |  also takes its git remote here, with Test push.
 * ------------------------------------------------------------------
 */

import type { AutomationOption, AutomationView, ModelInfo, UserAutomationKind } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { useFlows } from '../flows/api';
import { useLayer } from '../keys/dispatch';
import { api } from '../lib/api';
import { useNotebooks } from '../lib/data';
import { toModelView } from '../lib/mappers';
import { queryClient } from '../lib/query';
import { billingTitle, billingWords, displayName, planTwinOf, sameModelBothWays } from '../models/billing';
import { LATEST_TAG, nowNote, offerable, retiredNote } from '../models/lines';
import { notify } from '../state/notify';
import { Segmented, Switch } from '../ui/controls';
import { AUTOMATIONS_KEY } from './builtins';
import { reportFailure } from './common';
import { MemoryBackupSetup } from './MemoryBackup';
import {
  cronError,
  cronFromDraft,
  DEFAULT_DRAFT,
  draftFromCron,
  MIN_MINUTES,
  type ScheduleDraft,
  type ScheduleMode,
  WEEKDAYS,
} from './schedule';

export { AUTOMATIONS_KEY };

const KINDS: { value: UserAutomationKind; label: string; lede: string }[] = [
  {
    value: 'ask_model',
    label: 'Ask a model',
    lede: 'Sends your message in a new thread each time, so the answers stay in your history.',
  },
  {
    value: 'run_flow',
    label: 'Run a flow',
    lede: 'Sends your message through a flow, in a new thread each time.',
  },
  {
    value: 'recheck_sources',
    label: 'Re-check links',
    lede: "Looks at a notebook's web sources again and marks the pages that changed.",
  },
  { value: 'notify', label: 'Remind me', lede: 'Puts a reminder in your notifications.' },
];

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/* ---- The schedule picker --------------------------------------------------- */

export function SchedulePicker({
  value,
  onChange,
}: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
}) {
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const switchMode = (mode: ScheduleMode) => {
    // Carry the schedule over so Custom opens on what was picked.
    const next = { ...value, mode };
    if (mode === 'custom') next.cron = cronFromDraft(value);
    if (mode === 'minutes' && (value.every < MIN_MINUTES || value.every > 59)) next.every = 15;
    if (mode === 'hours' && value.every > 23) next.every = 1;
    onChange(next);
  };
  const customError = value.mode === 'custom' ? cronError(value.cron) : null;
  const toggleDay = (d: number) =>
    set({ days: value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d] });

  return (
    <fieldset className="field sched">
      <legend>When it runs</legend>
      <Segmented
        size="sm"
        label="How often"
        value={value.mode}
        onChange={switchMode}
        options={[
          { value: 'minutes', label: 'Minutes' },
          { value: 'hours', label: 'Hours' },
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'custom', label: 'Custom' },
        ]}
      />
      {value.mode === 'minutes' || value.mode === 'hours' ? (
        <label className="sched__line">
          <span>Every</span>
          <input
            className="input input--sm sched__num"
            type="number"
            min={value.mode === 'minutes' ? MIN_MINUTES : 1}
            max={value.mode === 'minutes' ? 59 : 23}
            value={value.every}
            aria-label={value.mode === 'minutes' ? 'Minutes between runs' : 'Hours between runs'}
            onChange={(e) => set({ every: Number(e.target.value) })}
          />
          <span>{value.mode === 'minutes' ? 'minutes' : value.every === 1 ? 'hour' : 'hours'}</span>
        </label>
      ) : null}
      {value.mode === 'weekly' ? (
        <div className="sched__days" role="group" aria-label="Days">
          {WEEKDAYS.map((d) => (
            <button
              key={d.value}
              type="button"
              className="chip sched__day"
              aria-pressed={value.days.includes(d.value)}
              aria-label={d.name}
              onClick={() => toggleDay(d.value)}
            >
              {d.short}
            </button>
          ))}
        </div>
      ) : null}
      {value.mode === 'daily' || value.mode === 'weekly' ? (
        <label className="sched__line">
          <span>At</span>
          <input
            className="input input--sm sched__time"
            type="time"
            value={value.time}
            aria-label="Time of day"
            onChange={(e) => set({ time: e.target.value || value.time })}
          />
        </label>
      ) : null}
      {value.mode === 'custom' ? (
        <>
          <input
            className="input input--mono"
            value={value.cron}
            aria-label="Cron schedule"
            aria-invalid={customError ? true : undefined}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            onChange={(e) => set({ cron: e.target.value })}
          />
          <span className={customError ? 'field__error' : 'field__hint'}>
            {customError ?? 'Minute, hour, day of month, month and weekday.'}
          </span>
        </>
      ) : null}
      <span className="field__hint">In this computer's time.</span>
    </fieldset>
  );
}

/** What stops the schedule being saved, or null. */
export function scheduleBlocker(d: ScheduleDraft): string | null {
  if (d.mode === 'custom') return cronError(d.cron);
  if (d.mode === 'weekly' && d.days.length === 0) return 'Pick at least one day.';
  if (d.mode === 'minutes' && (d.every < MIN_MINUTES || d.every > 59))
    return `Pick ${MIN_MINUTES} to 59 minutes.`;
  if (d.mode === 'hours' && (d.every < 1 || d.every > 23)) return 'Pick 1 to 23 hours.';
  return null;
}

/* ---- Built-in options ------------------------------------------------------ */

/** Why the settings can't be saved as they are (Core checks the same), or null. */
export function optionBlocker(options: AutomationOption[], values: Record<string, unknown>): string | null {
  for (const o of options) {
    const v = values[o.key];
    if (o.type !== 'integer') continue;
    if (typeof v !== 'number' || !Number.isInteger(v)) return `${o.label}: a whole number.`;
    if ((o.min !== null && v < o.min) || (o.max !== null && v > o.max))
      return `${o.label}: ${o.min ?? '…'} to ${o.max ?? '…'}.`;
  }
  const warn = values.warn_at_percent;
  const compact = values.compact_at_percent;
  if (typeof warn === 'number' && typeof compact === 'number' && warn >= compact)
    return 'The warning has to come before compacting.';
  return null;
}

type OptionValue = number | boolean | string;

export function OptionField({
  option,
  value,
  onChange,
}: {
  option: AutomationOption;
  value: OptionValue;
  onChange: (v: OptionValue) => void;
}) {
  const id = useId();
  // The hint describes the field; it is not part of its name.
  const hint = option.hint ? (
    <span id={`${id}-hint`} className="field__hint">
      {option.hint}
    </span>
  ) : null;
  const describedBy = option.hint ? `${id}-hint` : undefined;
  if (option.type === 'boolean')
    return (
      <div className="auto-opt auto-opt--switch">
        <div className="auto-opt__text">
          <span>{option.label}</span>
          {hint}
        </div>
        <Switch
          checked={value === true}
          onChange={onChange}
          label={option.label}
          {...(describedBy && { describedBy })}
        />
      </div>
    );
  return (
    <div className="auto-opt">
      <label htmlFor={id}>{option.label}</label>
      {option.type === 'choice' ? (
        <select
          id={id}
          className="input input--sm"
          value={String(value)}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          {(option.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : (
        <span className="sched__line">
          <input
            id={id}
            className="input input--sm sched__num"
            type="number"
            min={option.min ?? undefined}
            max={option.max ?? undefined}
            value={typeof value === 'number' ? value : Number(option.default)}
            aria-describedby={describedBy}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {option.unit ? <span>{option.unit}</span> : null}
        </span>
      )}
      {hint}
    </div>
  );
}

/* ---- The dialog -------------------------------------------------------------- */

export function AutomationDialog({
  open,
  automation,
  onOpenChange,
}: {
  open: boolean;
  /** The one being changed; null makes a new one. */
  automation: AutomationView | null;
  onOpenChange: (open: boolean) => void;
}) {
  useLayer(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick auto-dialog" aria-describedby="auto-dialog-desc">
          {open ? (
            <AutomationForm
              key={automation?.id ?? 'new'}
              automation={automation}
              onDone={() => onOpenChange(false)}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AutomationForm({ automation, onDone }: { automation: AutomationView | null; onDone: () => void }) {
  const isNew = automation === null;
  const builtin = automation?.origin === 'builtin';
  const c = automation?.config ?? {};
  const [kind, setKind] = useState<UserAutomationKind>(
    (automation?.kind as UserAutomationKind | undefined) ?? 'ask_model',
  );
  const [title, setTitle] = useState(builtin ? '' : (automation?.title ?? ''));
  const [schedule, setSchedule] = useState<ScheduleDraft>(
    automation?.cron ? draftFromCron(automation.cron) : DEFAULT_DRAFT,
  );
  const [prompt, setPrompt] = useState(str(c.prompt));
  const [notebook, setNotebook] = useState(str(c.notebook_id));
  const [model, setModel] = useState(str(c.model));
  const [flow, setFlow] = useState(str(c.flow_id));
  const [remindTitle, setRemindTitle] = useState(str(c.title));
  const [remindBody, setRemindBody] = useState(str(c.body));
  const [options, setOptions] = useState<Record<string, OptionValue>>(() =>
    Object.fromEntries(
      (automation?.options ?? []).map((o) => {
        const v = c[o.key];
        return [
          o.key,
          typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : o.default,
        ];
      }),
    ),
  );
  const [busy, setBusy] = useState(false);
  // An event-driven built-in has no schedule to pick; memory backup takes its remote here.
  const scheduled = !builtin || automation.trigger === 'schedule';
  const backup = builtin && automation.id === 'memory_backup';
  const needsRemote = backup && automation.setup !== null;
  const [remote, setRemote] = useState('');

  const notebooks = useNotebooks();
  const flows = useFlows();
  const models = useQuery({
    queryKey: ['flows', 'models'],
    staleTime: 60_000,
    enabled: !builtin && kind === 'ask_model',
    queryFn: () => api.get<{ items: ModelInfo[] }>('/models').then((r) => r.items),
  });
  const chatModels = (models.data ?? []).filter(
    (m) => !m.capabilities.includes('embeddings') && !m.capabilities.includes('rerank'),
  );
  // Who pays for the chosen model (MD3): a plan or a key, and when a plan could do the same.
  const modelViews = chatModels.map(toModelView);
  const dupes = sameModelBothWays(modelViews);
  const chosenModel = modelViews.find((m) => m.id === model);
  const planTwin = planTwinOf(chosenModel, modelViews);
  const notebookList = notebooks.data ?? [];
  const flowList = flows.data ?? [];
  // A required pick falls back to the first one there is.
  const recheckNotebook = notebook || notebookList[0]?.id || '';
  const flowId = flow || flowList[0]?.id || '';

  const blocker = (() => {
    const s = scheduled ? scheduleBlocker(schedule) : null;
    if (s) return s;
    if (needsRemote && !remote.trim()) return 'Type the git remote to push to.';
    if (builtin) return optionBlocker(automation.options, options);
    if (!title.trim()) return 'Give it a name.';
    if ((kind === 'ask_model' || kind === 'run_flow') && !prompt.trim()) return 'Write the message to send.';
    if (kind === 'run_flow' && !flowId) return 'Make a flow first, in Flows.';
    if (kind === 'recheck_sources' && !recheckNotebook) return 'Make a notebook first.';
    if (kind === 'notify' && !remindTitle.trim()) return 'Write what the reminder says.';
    return null;
  })();

  const config = (): Record<string, unknown> => {
    switch (kind) {
      case 'ask_model':
        return { prompt: prompt.trim(), notebook_id: notebook || null, model: model || null };
      case 'run_flow':
        return { flow_id: flowId, prompt: prompt.trim(), notebook_id: notebook || null };
      case 'recheck_sources':
        return { notebook_id: recheckNotebook };
      case 'notify':
        return { title: remindTitle.trim(), body: remindBody.trim() };
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (blocker || busy) return;
    setBusy(true);
    const cron = cronFromDraft(schedule);
    try {
      if (isNew) {
        await api.post<AutomationView>('/automations', { kind, title: title.trim(), cron, config: config() });
        notify({ level: 'success', title: `${title.trim()} is set up` });
      } else if (builtin) {
        // Only what changed, so an untouched setting does not count as a change.
        const changed = Object.fromEntries(
          automation.options
            .filter((o) => options[o.key] !== (c[o.key] ?? o.default))
            .map((o) => [o.key, options[o.key]]),
        );
        // A new remote is saved with the keys first; then the backup can be switched on.
        if (needsRemote) await api.put('/credentials/memory_remote', { value: remote.trim() });
        const patch = {
          ...(scheduled && cron !== automation.cron && { cron }),
          ...(Object.keys(changed).length && { config: changed }),
          ...(needsRemote && { enabled: true }),
        };
        if (Object.keys(patch).length)
          await api.patch<AutomationView>(`/automations/${automation.id}`, patch);
        if (needsRemote) {
          void queryClient.invalidateQueries({ queryKey: ['credentials'] });
          notify({ level: 'success', title: 'Memory backup is on', body: 'It pushes every hour.' });
        }
      } else {
        await api.patch<AutomationView>(`/automations/${automation.id}`, {
          title: title.trim(),
          cron,
          config: config(),
        });
      }
      await queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      onDone();
    } catch (err) {
      reportFailure(err, isNew ? 'Making the automation' : 'Saving it');
    } finally {
      setBusy(false);
    }
  };

  const lede = builtin ? automation.description : KINDS.find((k) => k.value === kind)?.lede;

  return (
    <>
      <Dialog.Title className="dialog__title">
        {isNew ? 'New automation' : builtin ? automation.title : `Edit ${automation.title}`}
      </Dialog.Title>
      <p id="auto-dialog-desc" className="dialog__lede">
        {lede}
      </p>
      <form className="auto-form" onSubmit={(e) => void submit(e)}>
        {isNew ? (
          <Segmented
            label="What it does"
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
          />
        ) : null}

        {!builtin ? (
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === 'notify' ? 'Weekly review' : 'Morning brief'}
              // biome-ignore lint/a11y/noAutofocus: the dialog opens to its first field
              autoFocus
            />
          </label>
        ) : null}

        {!builtin && (kind === 'ask_model' || kind === 'run_flow') ? (
          <>
            {kind === 'run_flow' ? (
              <label className="field">
                <span>Flow</span>
                <select className="input" value={flowId} onChange={(e) => setFlow(e.target.value)}>
                  {flowList.length === 0 ? <option value="">No flows yet</option> : null}
                  {flowList.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span>Message</span>
              <textarea
                className="input"
                rows={4}
                maxLength={8_000}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Summarise what changed in my sources this week."
              />
            </label>
            <div className="auto-form__pair">
              <label className="field">
                <span>Notebook</span>
                <select className="input" value={notebook} onChange={(e) => setNotebook(e.target.value)}>
                  <option value="">None</option>
                  {notebookList.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'ask_model' ? (
                <label className="field">
                  <span>Model</span>
                  <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">Default model</option>
                    {offerable(modelViews, [model]).map((m) => (
                      <option key={m.id} value={m.id}>
                        {displayName(m, dupes)}
                        {m.aliasOf ? ` (${LATEST_TAG}, ${nowNote(m, modelViews)})` : ''}
                        {m.lifecycle === 'retired' ? ` (${retiredNote(m, modelViews)})` : ''}
                      </option>
                    ))}
                  </select>
                  {chosenModel?.billing ? (
                    <span className="field__hint">
                      {billingTitle(chosenModel.billing, chosenModel.price)}.
                      {planTwin?.billing
                        ? ` ${billingWords(planTwin.billing)} can run this as Claude Code instead, which uses its own tools.`
                        : ''}
                    </span>
                  ) : null}
                </label>
              ) : null}
            </div>
            <p className="field__hint">
              Nobody is watching when it runs, so anything the answer wants to change waits for your yes.
            </p>
          </>
        ) : null}

        {!builtin && kind === 'recheck_sources' ? (
          <label className="field">
            <span>Notebook</span>
            <select className="input" value={recheckNotebook} onChange={(e) => setNotebook(e.target.value)}>
              {notebookList.length === 0 ? <option value="">No notebooks yet</option> : null}
              {notebookList.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {!builtin && kind === 'notify' ? (
          <>
            <label className="field">
              <span>Reminder</span>
              <input
                className="input"
                value={remindTitle}
                maxLength={120}
                onChange={(e) => setRemindTitle(e.target.value)}
                placeholder="Review this week's notes"
              />
            </label>
            <label className="field">
              <span>Details (optional)</span>
              <textarea
                className="input"
                rows={2}
                maxLength={1_000}
                value={remindBody}
                onChange={(e) => setRemindBody(e.target.value)}
              />
            </label>
          </>
        ) : null}

        {scheduled ? <SchedulePicker value={schedule} onChange={setSchedule} /> : null}

        {backup ? <MemoryBackupSetup needsRemote={needsRemote} remote={remote} onRemote={setRemote} /> : null}

        {builtin && automation.options.length ? (
          <fieldset className="field auto-opts">
            <legend>Settings</legend>
            {automation.options.map((o) => (
              <OptionField
                key={o.key}
                option={o}
                value={options[o.key] ?? o.default}
                onChange={(v) => setOptions((prev) => ({ ...prev, [o.key]: v }))}
              />
            ))}
          </fieldset>
        ) : null}

        <div className="dialog__actions">
          {blocker ? <span className="auto-form__why mute">{blocker}</span> : null}
          <Dialog.Close asChild>
            <button type="button" className="btn btn--ghost">
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" className="btn btn--primary" disabled={!!blocker || busy}>
            {isNew
              ? busy
                ? 'Creating…'
                : 'Create automation'
              : busy
                ? 'Saving…'
                : needsRemote
                  ? 'Save and turn on'
                  : 'Save changes'}
          </button>
        </div>
      </form>
    </>
  );
}
