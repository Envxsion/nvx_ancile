/**
 * ------------------------------------------------------------------
 *  Title    |  Help me choose a model
 *  Ref      |  docs/openrouter.md (Choosing a model)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Describe the job, or pick its kind and a few limits,
 *           |  and get two or three options with plain reasons and
 *           |  the routing preset to use.
 *  How      |  POST /advisor. Core scores deterministically from your
 *           |  models, the local list and your own usage; it never
 *           |  calls a paid model.
 * ------------------------------------------------------------------
 */

import type { AdvisorRequest, AdvisorResult, JobKind } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import '../styles/openrouter.css';
import { Segmented } from '../ui/controls';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { askAdvisor, errorBody, PRESETS, usd } from './api';

const KINDS: { value: JobKind; label: string }[] = [
  { value: 'agent_tools', label: 'Agent with tools' },
  { value: 'long_documents', label: 'Long documents' },
  { value: 'chat', label: 'Chat' },
  { value: 'coding', label: 'Coding' },
  { value: 'reasoning', label: 'Reasoning-heavy' },
  { value: 'cheap_bulk', label: 'Cheap bulk' },
];

const WHERE: Record<AdvisorResult['options'][number]['where'], string> = {
  openrouter: 'OpenRouter',
  local: 'This computer',
  runpod: 'Your GPU',
  claude_code: 'Claude Code',
  direct: 'Direct',
};

export function ModelAdvisor() {
  const [req, setReq] = useState<AdvisorRequest>({
    describe: '',
    kind: null,
    budget: 'medium',
    privacy: 'any',
    speed: 'any',
    explain: false,
  });
  const ask = useMutation({ mutationFn: askAdvisor });
  const set = (patch: Partial<AdvisorRequest>) => setReq((r) => ({ ...r, ...patch }));
  return (
    <section className="or-section" aria-label="Help me choose a model">
      <label className="or-field">
        <span className="or-field__label">What is the job?</span>
        <input
          className="input"
          value={req.describe}
          placeholder="Summarise long contracts and pull out the dates"
          onChange={(e) => set({ describe: e.target.value })}
        />
      </label>
      <div className="or-chips" role="group" aria-label="Or pick a kind">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            className="btn btn--sm btn--ghost"
            aria-pressed={req.kind === k.value}
            onClick={() => set({ kind: req.kind === k.value ? null : k.value })}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="or-row or-row--wrap">
        <Segmented
          label="Budget"
          size="sm"
          value={req.budget}
          onChange={(budget) => set({ budget })}
          options={[
            { value: 'low', label: 'Low budget' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'Money no object' },
          ]}
        />
        <Segmented
          label="Privacy"
          size="sm"
          value={req.privacy}
          onChange={(privacy) => set({ privacy })}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'no_training', label: 'No training on prompts' },
            { value: 'local_only', label: 'Stays with me' },
          ]}
        />
        <Segmented
          label="Speed"
          size="sm"
          value={req.speed}
          onChange={(speed) => set({ speed })}
          options={[
            { value: 'any', label: 'Any speed' },
            { value: 'fast', label: 'Fast' },
          ]}
        />
      </div>
      <div className="dialog__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={ask.isPending}
          onClick={() => ask.mutate(req)}
        >
          Suggest models
        </button>
      </div>
      {ask.error ? <ErrorState error={errorBody(ask.error)} compact /> : null}
      {ask.data ? (
        <ol className="or-options">
          {ask.data.options.length === 0 ? (
            <li>
              No model you have fits this job. Add one in Settings → API keys, or download a local model.
            </li>
          ) : null}
          {ask.data.options.map((o) => (
            <li key={o.model_id} className="or-option">
              <div className="or-option__head">
                <strong>{o.name}</strong>
                <span className="or-dim">{WHERE[o.where]}</span>
                {o.cost_per_1k_turns !== null ? (
                  <span className="or-dim">{usd(o.cost_per_1k_turns)} per 1,000 turns</span>
                ) : null}
              </div>
              <ul>
                {o.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {o.preset ? (
                <p className="or-dim">Routing: {PRESETS.find((p) => p.value === o.preset)?.label}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {ask.data?.explanation ? <p className="or-note">{ask.data.explanation}</p> : null}
    </section>
  );
}

/** The Models screen's "Help me choose" button and its dialog. */
export function AdvisorButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
        <Icon name="search" size={14} />
        Help me choose
      </button>
      {open ? (
        <Dialog.Root open onOpenChange={(o) => !o && setOpen(false)}>
          <Dialog.Portal>
            <Dialog.Overlay className="scrim" />
            <Dialog.Content className="dialog m-glass-thick or-dialog" aria-describedby={undefined}>
              <Dialog.Title className="dialog__title">Help me choose a model</Dialog.Title>
              <ModelAdvisor />
              <div className="dialog__actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn--ghost">
                    Close
                  </button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
