/**
 * ------------------------------------------------------------------
 *  Title    |  The scope editor
 *  Ref      |  docs/scopes.md · packages/contracts/src/scopes.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say what a notebook, or one thread in it, may use:
 *           |  which models answer, whether anything leaves this
 *           |  computer, the network, memory, sources, tools, MCP
 *           |  servers and folders. Summary first; the long lists wait
 *           |  behind "More limits".
 *  How      |  A notebook has a Private switch (local models only,
 *           |  nothing leaves this computer), which greys out what it
 *           |  rules out. A thread can only narrow its notebook: each
 *           |  row says where its value comes from, a value the
 *           |  notebook does not allow cannot be switched on (the row
 *           |  says why), and a value clamped after the notebook was
 *           |  narrowed is flagged. Only changed fields are sent; a
 *           |  thread value set back to the notebook's goes back to
 *           |  inheriting (null). Core's 422 (scope.widen,
 *           |  scope.private_conflict) shows inline, on the rows it
 *           |  names, and the editor stays open. "Tool preset" picks a
 *           |  named set of tool rules (Research, Coding, Read only or
 *           |  your own); a thread's preset narrows its notebook's.
 *           |  "Sent before it became private" lists what had already
 *           |  left this computer when the notebook (or thread) stopped
 *           |  letting data leave: engines and providers, how many
 *           |  answers, and the dates. It can't be recalled; it says so.
 * ------------------------------------------------------------------
 */

import type {
  AppliedToolPreset,
  EffectiveScope,
  PatchNotebookScopeRequest,
  ScopeEngine,
  ScopeField,
  ScopeValues,
  SharedBeforeLocal,
  StoredScope,
  ToolPreset,
} from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useId, useMemo, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError } from '../lib/api';
import { useNotebooks, useSources, useThreads } from '../lib/data';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import {
  ALL_ENGINES,
  allowedEngines,
  DEFAULT_SCOPE,
  ENGINE_WORDS,
  FIELD_WORDS,
  patchNotebookScope,
  patchThreadScope,
  presetName,
  provenanceOf,
  scopeSummary,
  sharedBeforeText,
  useNotebookScope,
  useThreadScope,
  useToolPresets,
} from './api';

type Level = 'notebook' | 'thread';
type Bool = 'data_leaves_machine' | 'network' | 'memory_read' | 'memory_write' | 'context_links';
type List =
  | 'models_allow'
  | 'models_deny'
  | 'tools_allow'
  | 'tools_deny'
  | 'mcp_servers_allow'
  | 'mcp_servers_deny'
  | 'folders';

const PRIVATE_WORDS = 'Private notebook: local models only, nothing leaves this computer';

const BOOLS: { field: Bool; label: string; hint: string }[] = [
  {
    field: 'data_leaves_machine',
    label: 'Data may leave this computer',
    hint: 'Off: only local models, local reviewers and local tools',
  },
  {
    field: 'network',
    label: 'Tools may use the network',
    hint: 'Off: no web, no git push, not even localhost',
  },
  { field: 'memory_read', label: 'Read memory', hint: 'What NVX Ancile remembers goes into each turn' },
  {
    field: 'memory_write',
    label: 'Learn into memory',
    hint: 'New things it learns here are offered to memory',
  },
  { field: 'context_links', label: 'Context links', hint: 'Other threads and notebooks can be pulled in' },
];

const ENGINE_HINT: Record<string, string> = {
  gateway_cloud: 'Models from providers such as Anthropic, OpenAI and OpenRouter',
  gateway_local: 'Ollama, servers on this computer and your GPU nodes',
  claude_code: 'Your own Claude Code, as a model or a session',
};

const LISTS: { field: List; label: string; any: string; hint: string }[] = [
  {
    field: 'models_allow',
    label: 'Models allowed',
    any: 'Any model',
    hint: 'Model ids, one per line; * and ** work',
  },
  { field: 'models_deny', label: 'Models blocked', any: 'None', hint: 'Model ids, one per line' },
  {
    field: 'tools_allow',
    label: 'Tools allowed',
    any: 'Any tool',
    hint: 'Tool actions such as fs.* or git.status',
  },
  { field: 'tools_deny', label: 'Tools blocked', any: 'None', hint: 'For example git.push*' },
  {
    field: 'mcp_servers_allow',
    label: 'MCP servers allowed',
    any: 'Any server',
    hint: 'Server names, one per line',
  },
  {
    field: 'mcp_servers_deny',
    label: 'MCP servers blocked',
    any: 'None',
    hint: 'Server names, one per line',
  },
  {
    field: 'folders',
    label: 'Folders tools may touch',
    any: 'The workspace',
    hint: 'Full paths, one per line',
  },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Failure {
  title: string;
  hint: string;
  fields: ScopeField[];
}

/** What the thread's notebook allows: its effective scope, or the defaults for a loose thread. */
function parentValues(parent: EffectiveScope | null | undefined): { values: ScopeValues; private: boolean } {
  return parent
    ? { values: parent.scope, private: parent.private }
    : { values: DEFAULT_SCOPE, private: false };
}

export function ScopeEditor({ level, id, onClose }: { level: Level; id: string; onClose: () => void }) {
  const threadQ = useThreadScope(level === 'thread' ? id : null);
  const notebookQ = useNotebookScope(level === 'notebook' ? id : null);
  const stored = level === 'thread' ? threadQ.data : notebookQ.data;
  const notebookId = level === 'notebook' ? id : (stored?.effective.notebook_id ?? null);
  const parentQ = useNotebookScope(level === 'thread' ? notebookId : null);
  const threads = useThreads().data;
  const notebooks = useNotebooks().data;
  const name =
    level === 'thread'
      ? (threads?.find((t) => t.id === id)?.title ?? 'This thread')
      : (notebooks?.find((n) => n.id === id)?.title ?? 'This notebook');
  const loading =
    level === 'thread' ? threadQ.isPending || (!!notebookId && parentQ.isPending) : notebookQ.isPending;
  const error = (level === 'thread' ? threadQ.error : notebookQ.error) as unknown;
  useLayer(true);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog scope-ed" aria-describedby="scope-ed-lede">
          <Dialog.Title className="dialog__title">
            {level === 'thread' ? 'What this thread may use' : 'What this notebook may use'}
          </Dialog.Title>
          <p id="scope-ed-lede" className="dialog__lede">
            {level === 'thread'
              ? `${name}. A thread can only narrow its notebook.`
              : `${name}. Its threads can narrow this further, never widen it.`}
          </p>
          {stored ? (
            <Form
              key={stored.updated_at ?? 'new'}
              level={level}
              id={id}
              stored={stored}
              parent={level === 'thread' ? (parentQ.data?.effective ?? null) : null}
              notebookId={notebookId}
              onClose={onClose}
            />
          ) : loading && !error ? (
            <Skeleton lines={6} label="Reading the scope" />
          ) : (
            <p className="field__error" role="alert">
              {error instanceof ApiCallError
                ? `${error.body.error.title}. ${error.body.error.hint}`
                : 'The scope could not be read. Check that NVX Ancile is running, then open it again.'}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Form({
  level,
  id,
  stored,
  parent,
  notebookId,
  onClose,
}: {
  level: Level;
  id: string;
  stored: StoredScope;
  parent: EffectiveScope | null;
  notebookId: string | null;
  onClose: () => void;
}) {
  const eff = stored.effective;
  const [draft, setDraft] = useState<ScopeValues>(eff.scope);
  const [priv, setPriv] = useState(stored.private);
  const [lists, setLists] = useState<Record<List, string>>(() => {
    const out = {} as Record<List, string>;
    for (const l of LISTS) out[l.field] = (eff.scope[l.field] ?? []).join('\n');
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Failure | null>(null);
  // The preset this level itself chose; a thread's notebook preset applies anyway.
  const storedPreset = stored.patch.tool_preset ?? null;
  const [preset, setPreset] = useState<string | null>(storedPreset);
  const presets = useToolPresets().data;
  const sources = useSources(notebookId).data;
  const detailsOpen = useMemo(
    () =>
      LISTS.some((l) => eff.scope[l.field] !== null && (eff.scope[l.field] ?? []).length > 0) ||
      eff.scope.sources !== null,
    [eff],
  );

  const up = parentValues(level === 'thread' ? parent : null);
  const isPrivate = level === 'notebook' ? priv : eff.private;
  const flagged = (f: ScopeField) => fail?.fields.includes(f) ?? false;
  const clamped = (f: ScopeField) => eff.clamped.includes(f);
  // Where a thread's value comes from; "Default" is left unsaid, so only what was set stands out.
  const prov = (f: ScopeField) => {
    if (level !== 'thread') return null;
    const p = provenanceOf(eff, f);
    return eff.provenance[f]?.level && eff.provenance[f]?.level !== 'default' ? p : null;
  };
  const enginesProv = prov('engines');

  /** Why a thread cannot switch this on; null when it can. */
  const lockedBool = (f: Bool): string | null => {
    if (f === 'data_leaves_machine' && isPrivate) return PRIVATE_WORDS;
    if (level !== 'thread') return null;
    if (up.values[f]) return null;
    return parent?.provenance[f]?.note ?? "Off for the notebook. Change the notebook's scope first";
  };
  const enginesNow = draft.engines ?? (level === 'thread' && parent ? allowedEngines(parent) : ALL_ENGINES);
  const lockedEngine = (e: ScopeEngine): string | null => {
    if (e !== 'gateway_local' && (isPrivate || !draft.data_leaves_machine))
      return isPrivate ? PRIVATE_WORDS : 'Nothing leaves this computer here';
    if (level !== 'thread' || !parent) return null;
    return allowedEngines(parent).includes(e)
      ? null
      : (parent.provenance.engines?.note ?? 'Off for the notebook');
  };
  const engineOn = (e: ScopeEngine) => enginesNow.includes(e) && !lockedEngine(e);

  const setEngine = (e: ScopeEngine, on: boolean) => {
    const next = on ? [...new Set([...enginesNow, e])] : enginesNow.filter((x) => x !== e);
    const ordered = ALL_ENGINES.filter((x) => next.includes(x));
    setDraft((d) => ({
      ...d,
      engines: ordered.length === ALL_ENGINES.length && level === 'notebook' ? null : ordered,
    }));
  };

  // Presets in force once saved: the other level's, then this level's choice.
  const inherited = (eff.tool_presets ?? []).filter((p) => p.level !== level);
  const picked = preset ? presets?.find((p) => p.id === preset) : undefined;
  const chosen: AppliedToolPreset[] = preset
    ? [
        {
          level,
          id: preset,
          name: presetName(presets, preset),
          missing: !picked,
          tools_allow: picked?.tools_allow ?? [],
          tools_deny: picked?.tools_deny ?? [],
          mcp_servers_allow: picked?.mcp_servers_allow ?? [],
          mcp_servers_deny: picked?.mcp_servers_deny ?? [],
          network: picked?.network ?? false,
        },
      ]
    : [];
  const inheritedNames = inherited.map((p) => p.name).join(' and ');

  // The summary of what would be saved, kept up to date as you change things.
  const preview: EffectiveScope = {
    ...eff,
    tool_presets: [...inherited, ...chosen],
    private: isPrivate,
    scope: {
      ...draft,
      ...Object.fromEntries(
        LISTS.map((l) => {
          const v = parseList(lists[l.field]);
          return [l.field, l.field.endsWith('_deny') ? v : v.length ? v : null];
        }),
      ),
    },
  };

  const build = (): PatchNotebookScopeRequest => {
    const patch: Record<string, unknown> = {};
    const put = (f: ScopeField, v: unknown) => {
      if (same(v, eff.scope[f])) return;
      // A thread value set back to what the notebook allows goes back to inheriting.
      patch[f] = level === 'thread' && same(v, up.values[f]) ? null : v;
    };
    for (const b of BOOLS) put(b.field, draft[b.field]);
    if (!same(draft.engines, eff.scope.engines)) patch.engines = draft.engines;
    for (const l of LISTS) put(l.field, preview.scope[l.field]);
    put('sources', draft.sources);
    if (preset !== storedPreset) patch.tool_preset = preset;
    if (level === 'notebook' && priv !== stored.private) patch.private = priv;
    return patch as PatchNotebookScopeRequest;
  };

  const save = async () => {
    const patch = build();
    if (Object.keys(patch).length === 0) return onClose();
    setBusy(true);
    setFail(null);
    try {
      if (level === 'thread') {
        const { private: _p, ...rest } = patch;
        await patchThreadScope(id, rest);
      } else await patchNotebookScope(id, patch);
      notify({
        level: 'success',
        title: level === 'thread' ? "This thread's scope is saved" : "This notebook's scope is saved",
        body: scopeSummary(preview),
      });
      onClose();
    } catch (error) {
      if (error instanceof ApiCallError && error.status === 422) {
        const fields = (error.body.error.context.fields as ScopeField[] | undefined) ?? [];
        setFail({ title: error.body.error.title, hint: error.body.error.hint, fields });
      } else
        setFail({
          title: error instanceof ApiCallError ? error.body.error.title : "The scope didn't reach Core",
          hint:
            error instanceof ApiCallError
              ? error.body.error.hint
              : 'Check that NVX Ancile is running, then try again.',
          fields: [],
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scope-ed__body">
      <p className="scope-ed__summary" aria-live="polite">
        <Icon name={isPrivate ? 'lock' : 'shield'} size={13} />
        <span>{scopeSummary(preview)}</span>
      </p>

      {fail ? (
        <div className="scope-ed__fail" role="alert">
          <Icon name="warn" size={14} />
          <div>
            <strong>{fail.title}</strong>
            <p>{fail.hint}</p>
          </div>
        </div>
      ) : null}

      {stored.shared_before_local?.length ? <SharedBefore records={stored.shared_before_local} /> : null}

      {level === 'notebook' ? (
        <Row
          label="Private"
          hint="Local models only. Nothing leaves this computer, and Claude Code is never used."
          checked={priv}
          onChange={setPriv}
          strong
        />
      ) : null}

      <fieldset className="scope-ed__group">
        <legend>
          Who answers
          {enginesProv ? (
            <span className="scope-ed__legend-prov" title={enginesProv.note ?? undefined}>
              {' '}
              · {enginesProv.label}
            </span>
          ) : null}
        </legend>
        {ALL_ENGINES.map((e) => {
          const why = lockedEngine(e);
          return (
            <Row
              key={e}
              label={ENGINE_WORDS[e] ?? e}
              hint={ENGINE_HINT[e] ?? ''}
              why={why}
              checked={engineOn(e)}
              disabled={!!why}
              onChange={(on) => setEngine(e, on)}
              clamped={clamped('engines')}
              error={flagged('engines')}
            />
          );
        })}
      </fieldset>

      <fieldset className="scope-ed__group">
        <legend>What it may reach</legend>
        {BOOLS.map((b) => {
          const why = lockedBool(b.field);
          const on = draft[b.field] && !(b.field === 'data_leaves_machine' && isPrivate);
          return (
            <Row
              key={b.field}
              label={b.label}
              hint={b.hint}
              why={why}
              checked={on}
              // Switching off is always allowed; switching on is not past the notebook.
              disabled={!!why && !on}
              onChange={(v) => setDraft((d) => ({ ...d, [b.field]: v }))}
              prov={prov(b.field)}
              clamped={clamped(b.field)}
              error={flagged(b.field)}
            />
          );
        })}
      </fieldset>

      <PresetField
        level={level}
        value={preset}
        presets={presets ?? []}
        inherited={inheritedNames}
        onChange={setPreset}
        error={flagged('tool_preset')}
      />

      <details
        className="scope-ed__more"
        open={
          detailsOpen ||
          (fail?.fields.some(
            (f) => f.endsWith('allow') || f.endsWith('deny') || f === 'folders' || f === 'sources',
          ) ??
            false)
        }
      >
        <summary>
          <Icon name="chevronRight" size={12} className="scope-ed__chev" />
          More limits: models, tools, MCP servers, folders and sources
        </summary>
        <div className="scope-ed__lists">
          {sources && sources.length > 0 ? (
            <SourcesField
              all={draft.sources === null}
              chosen={draft.sources ?? []}
              sources={sources.map((s) => ({ id: s.id, title: s.title }))}
              onChange={(v) => setDraft((d) => ({ ...d, sources: v }))}
              prov={prov('sources')}
              locked={level === 'thread' && up.values.sources !== null ? up.values.sources : null}
              error={flagged('sources')}
            />
          ) : null}
          {LISTS.map((l) => (
            <ListField
              key={l.field}
              label={l.label}
              hint={l.hint}
              value={lists[l.field]}
              placeholder={
                level === 'thread' && up.values[l.field] && (up.values[l.field] ?? []).length
                  ? `From the notebook: ${(up.values[l.field] ?? []).join(', ')}`
                  : l.any
              }
              onChange={(v) => setLists((x) => ({ ...x, [l.field]: v }))}
              prov={prov(l.field)}
              clamped={clamped(l.field)}
              error={flagged(l.field)}
            />
          ))}
        </div>
      </details>

      <div className="dialog__actions">
        <Dialog.Close className="btn btn--ghost" type="button">
          Cancel
        </Dialog.Close>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving' : 'Save scope'}
        </button>
      </div>
    </div>
  );
}

/** What had already left this computer before this level stopped letting it (newest first). */
function SharedBefore({ records }: { records: SharedBeforeLocal[] }) {
  return (
    <section className="scope-shared" aria-label="Sent before it became private">
      <h3 className="scope-shared__h">
        <Icon name="clock" size={12} />
        Sent before it became private
      </h3>
      <ul>
        {records.map((r) => {
          const t = sharedBeforeText(r);
          return (
            <li key={r.id}>
              <p>{t.lede}</p>
              {t.detail ? <p className="mute">{t.detail}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Row({
  label,
  hint,
  why,
  checked,
  onChange,
  disabled,
  prov,
  clamped,
  error,
  strong,
}: {
  label: string;
  hint: string;
  why?: string | null;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  prov?: { label: string; note: string | null } | null;
  clamped?: boolean;
  error?: boolean;
  strong?: boolean;
}) {
  const hintId = useId();
  return (
    <div
      className="scope-row"
      data-strong={strong || undefined}
      data-error={error || undefined}
      data-locked={disabled || undefined}
    >
      <div className="scope-row__text">
        <span className="scope-row__label">{label}</span>
        <span id={hintId} className="scope-row__hint">
          {why && disabled ? why : hint}
        </span>
      </div>
      {clamped ? (
        <span
          className="scope-flag"
          title="The notebook was narrowed after this was set, so the notebook's limit applies"
        >
          Clamped to the notebook
        </span>
      ) : null}
      {prov ? (
        <span className="scope-prov" data-level={prov.label} title={prov.note ?? undefined}>
          {prov.label}
        </span>
      ) : null}
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} describedBy={hintId} />
    </div>
  );
}

/**
 * The tool preset this level chooses. A preset only narrows: a thread's
 * preset applies on top of its notebook's, never instead of it.
 */
function PresetField({
  level,
  value,
  presets,
  inherited,
  onChange,
  error,
}: {
  level: Level;
  value: string | null;
  presets: readonly ToolPreset[];
  /** The other level's presets, by name ("" when none). */
  inherited: string;
  onChange: (id: string | null) => void;
  error: boolean;
}) {
  const fid = useId();
  const hintId = useId();
  const current = value ? presets.find((p) => p.id === value) : undefined;
  const own = presets.filter((p) => !p.builtin);
  const hint = current
    ? current.description || 'Your own preset'
    : level === 'thread' && inherited
      ? `The notebook's ${inherited} preset applies. Choose one to narrow it further.`
      : 'Any tool the scope and permissions allow';
  return (
    <fieldset className="scope-ed__group">
      <legend>Tools</legend>
      <div className="scope-row" data-error={error || undefined}>
        <div className="scope-row__text">
          <label htmlFor={fid} className="scope-row__label">
            Tool preset
          </label>
          <span id={hintId} className="scope-row__hint">
            {hint}
            {level === 'thread' && inherited && current
              ? ` The notebook's ${inherited} preset applies too.`
              : ''}
          </span>
        </div>
        <select
          id={fid}
          className="input scope-preset"
          value={value ?? ''}
          aria-describedby={hintId}
          aria-invalid={error || undefined}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{level === 'thread' && inherited ? 'Only the notebook’s' : 'None'}</option>
          {presets
            .filter((p) => p.builtin)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          {own.length ? (
            <optgroup label="Your presets">
              {own.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {value && !current ? <option value={value}>{value} (missing)</option> : null}
        </select>
      </div>
    </fieldset>
  );
}

function ListField({
  label,
  hint,
  value,
  placeholder,
  onChange,
  prov,
  clamped,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  prov: { label: string; note: string | null } | null;
  clamped: boolean;
  error: boolean;
}) {
  const fid = useId();
  return (
    <div className="scope-list" data-error={error || undefined}>
      <div className="scope-list__head">
        <label htmlFor={fid} className="scope-row__label">
          {label}
        </label>
        {clamped ? <span className="scope-flag">Clamped to the notebook</span> : null}
        {prov ? (
          <span className="scope-prov" title={prov.note ?? undefined}>
            {prov.label}
          </span>
        ) : null}
      </div>
      <textarea
        id={fid}
        className="input input--mono scope-list__input"
        rows={value.split('\n').length > 2 ? 4 : 2}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error || undefined}
      />
      <span className="field__hint">{hint}</span>
    </div>
  );
}

function SourcesField({
  all,
  chosen,
  sources,
  onChange,
  prov,
  locked,
  error,
}: {
  all: boolean;
  chosen: string[];
  sources: { id: string; title: string }[];
  onChange: (v: string[] | null) => void;
  prov: { label: string; note: string | null } | null;
  /** A thread may only choose among what its notebook allows. */
  locked: string[] | null;
  error: boolean;
}) {
  const offered = locked ? sources.filter((s) => locked.includes(s.id)) : sources;
  return (
    <div className="scope-list" data-error={error || undefined}>
      <div className="scope-list__head">
        <span className="scope-row__label">
          {FIELD_WORDS.sources[0]?.toUpperCase() + FIELD_WORDS.sources.slice(1)}
        </span>
        {prov ? (
          <span className="scope-prov" title={prov.note ?? undefined}>
            {prov.label}
          </span>
        ) : null}
        <span className="scope-list__all">
          <span className="mute">Every source</span>
          <Switch
            checked={all}
            label="Every source in the notebook"
            disabled={!!locked && !all}
            onChange={(v) => onChange(v ? null : offered.map((s) => s.id))}
          />
        </span>
      </div>
      {all ? null : (
        <ul className="scope-sources">
          {offered.map((s) => (
            <li key={s.id}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.includes(s.id)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))
                  }
                />
                <span>{s.title}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
