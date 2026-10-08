/**
 * ------------------------------------------------------------------
 *  Title    |  Flow panel fields
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The small controls every node's settings are built
 *           |  from: a labelled field, text that inserts {{variables}}
 *           |  where the caret is, numbers with sensible bounds, and a
 *           |  model picker that shows provider, price, context window
 *           |  and whether a GPU node is awake.
 * ------------------------------------------------------------------
 */

import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { type CSSProperties, type ReactNode, useId, useRef, useState } from 'react';
import { hueVar } from '../lib/format';
import { useAddModel } from '../models/AddModel';
import { Icon } from '../ui/Icon';
import { rank } from './AddNode';
import { PROVIDER_NAMES, providerOf } from './kinds';
import { type FlowModel, priceText, windowText } from './models';

export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fp-field" data-wide={wide || undefined}>
      <span className="fp-field__label">{label}</span>
      {children}
      {hint ? <span className="fp-field__hint">{hint}</span> : null}
    </div>
  );
}

export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="fp-section">
      <header className="fp-section__head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Text({
  value,
  onChange,
  placeholder,
  mono,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  label: string;
}) {
  return (
    <input
      className="input fp-input"
      data-mono={mono || undefined}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={!mono}
    />
  );
}

/** A textarea with {{variable}} chips that insert at the caret. */
export function Area({
  value,
  onChange,
  label,
  placeholder,
  rows = 4,
  vars,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  vars?: string[];
  mono?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (v: string) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    if (!el) return onChange(value + token);
    const a = el.selectionStart ?? value.length;
    const b = el.selectionEnd ?? value.length;
    onChange(value.slice(0, a) + token + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };
  return (
    <div className="fp-area">
      <textarea
        ref={ref}
        className="input fp-textarea"
        data-mono={mono || undefined}
        rows={rows}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {vars?.length ? (
        <div className="fp-vars" role="group" aria-label="Insert a variable">
          {vars.map((v) => (
            <button key={v} type="button" className="fp-var" onClick={() => insert(v)}>
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  suffix,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  suffix?: string;
  placeholder?: string;
}) {
  return (
    <span className="fp-num">
      <input
        className="input fp-input"
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          if (e.target.value === '') return onChange(undefined);
          const v = Number(e.target.value);
          if (Number.isNaN(v)) return;
          onChange(Math.min(max ?? v, Math.max(min ?? v, v)));
        }}
      />
      {suffix ? <span className="fp-num__suffix">{suffix}</span> : null}
    </span>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className="fp-select">
      <select
        className="input fp-input"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={12} />
    </span>
  );
}

export function ModelLine({ m }: { m: FlowModel }) {
  return (
    <span className="fp-modelline">
      <span className="fp-modelline__dot" style={{ '--hue': hueVar(m.hue) } as CSSProperties} />
      <span className="fp-modelline__name">{m.name}</span>
      <span className="fp-modelline__meta">
        {PROVIDER_NAMES[m.provider] ?? m.provider} · {windowText(m.window)} · {priceText(m)}
      </span>
      {m.awake === false ? (
        <span className="fp-tag" data-tone="mute">
          asleep
        </span>
      ) : null}
      {m.awake === true ? (
        <span className="fp-tag" data-tone="ok">
          awake
        </span>
      ) : null}
      {m.status === 'needs_key' ? (
        <span className="fp-tag" data-tone="warn">
          needs a key
        </span>
      ) : null}
      {m.status === 'disabled' ? (
        <span className="fp-tag" data-tone="mute">
          off
        </span>
      ) : null}
    </span>
  );
}

/** Choose a model from every provider, OpenRouter and GPU node, by name, provider or price. */
export function ModelPicker({
  value,
  models,
  onChange,
  label,
  allowNone,
}: {
  value: string | undefined;
  models: FlowModel[];
  onChange: (id: string | undefined) => void;
  label: string;
  allowNone?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const current = models.find((m) => m.id === value);
  const groups = new Map<string, FlowModel[]>();
  for (const m of models.filter((x) => x.chat)) {
    const g = m.via === 'controller' ? 'GPU nodes' : (PROVIDER_NAMES[m.provider] ?? m.provider);
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="fp-picker" aria-label={label} aria-controls={id}>
          {current ? (
            <ModelLine m={current} />
          ) : value ? (
            <span className="fp-picker__missing">
              {value}{' '}
              <span className="fp-tag" data-tone="warn">
                not in your models
              </span>
            </span>
          ) : (
            <span className="mute">{allowNone ?? 'Choose a model'}</span>
          )}
          <Icon name="chevronDown" size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          id={id}
          className="fp-pop m-glass-thick"
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          <Command label={label} loop filter={rank}>
            <div className="fadd__search">
              <Icon name="search" size={13} />
              <Command.Input autoFocus placeholder="Name, provider, node…" />
            </div>
            <Command.List className="fp-pop__list">
              <Command.Empty className="fadd__empty">No model matches.</Command.Empty>
              {allowNone ? (
                <Command.Item
                  value="none default"
                  className="fadd__item"
                  onSelect={() => {
                    onChange(undefined);
                    setOpen(false);
                  }}
                >
                  <span className="mute">{allowNone}</span>
                </Command.Item>
              ) : null}
              {[...groups].map(([g, ms]) => (
                <Command.Group key={g} heading={g} className="fadd__group">
                  {ms.map((m) => (
                    <Command.Item
                      key={m.id}
                      value={`${m.name}|${m.id} ${m.provider} ${m.family} ${m.nodeName ?? ''}`}
                      className="fadd__item"
                      data-current={m.id === value || undefined}
                      onSelect={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                    >
                      <ModelLine m={m} />
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              <Command.Item
                value="add a model openrouter server endpoint runpod vllm new"
                className="fadd__item fadd__item--add"
                forceMount
                onSelect={() => {
                  setOpen(false);
                  // Added models join the registry at once; pick it here when it lands.
                  useAddModel.getState().show('openrouter', (newId) => onChange(newId));
                }}
              >
                <Icon name="plus" size={13} />
                <span>Add a model… OpenRouter, your own server, or a provider's model id</span>
              </Command.Item>
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** An ordered list of models (fallbacks): chips you can reorder and remove. */
export function ModelList({
  value,
  models,
  onChange,
  label,
}: {
  value: string[];
  models: FlowModel[];
  onChange: (v: string[]) => void;
  label: string;
}) {
  return (
    <div className="fp-chips">
      {value.map((id, i) => {
        const m = models.find((x) => x.id === id);
        return (
          <span key={id} className="fp-chip" style={{ '--hue': hueVar(m?.hue ?? 'chalk') } as CSSProperties}>
            <span className="fp-chip__n">{i + 1}</span>
            {m?.name ?? id}
            <button
              type="button"
              className="fp-chip__x"
              aria-label={`Move ${m?.name ?? id} earlier`}
              disabled={i === 0}
              onClick={() => {
                const next = [...value];
                [next[i - 1], next[i]] = [next[i] as string, next[i - 1] as string];
                onChange(next);
              }}
            >
              <Icon name="arrowUp" size={10} />
            </button>
            <button
              type="button"
              className="fp-chip__x"
              aria-label={`Remove ${m?.name ?? id}`}
              onClick={() => onChange(value.filter((x) => x !== id))}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        );
      })}
      <ModelPicker
        value={undefined}
        models={models.filter((m) => !value.includes(m.id))}
        onChange={(id) => id && onChange([...value, id])}
        label={label}
        allowNone="Add a fallback"
      />
    </div>
  );
}

/** Model id → its provider word, for places that only have the id. */
export const providerName = (id: string) => PROVIDER_NAMES[providerOf(id)] ?? providerOf(id);
