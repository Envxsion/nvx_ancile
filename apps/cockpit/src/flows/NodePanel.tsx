/**
 * ------------------------------------------------------------------
 *  Title    |  Node settings
 *  Ref      |  DESIGN.md §16.1, §16.2, §16.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything about the selected node, editable in place:
 *           |  its model and role, routes and rules, what context it
 *           |  sees (with a live token estimate), and the debug tools:
 *           |  its last run, run it alone, run up to it, pin an
 *           |  output, bypass it.
 *  How      |  Every change goes through the editor's apply(), so it
 *           |  is one undo step. Typing in a field records once per
 *           |  field focus, not per keystroke.
 * ------------------------------------------------------------------
 */

import type { ContextPolicy, FlowNode, RuleCondition } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { hueVar } from '../lib/format';
import type { Hue } from '../lib/types';
import { notify } from '../state/notify';
import { Segmented, Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import {
  invalidIssues,
  needsCore,
  type RunNodeResult,
  runNode,
  tryFlow,
  upToHere,
  useFlows,
  useLastRun,
} from './api';
import { contextSummary, msText, usd } from './describe';
import { Area, Field, ModelList, ModelPicker, Num, Section, Select, Text } from './fields';
import { removeEdges, renameNode, renameRoute, setDisabled, updateNode, updateParams } from './graph';
import { KINDS } from './kinds';
import { type FlowModel, windowText } from './models';
import { useEditor } from './store';

const HUES: Hue[] = ['azure', 'jade', 'amber', 'coral', 'magenta', 'cyan', 'chalk'];
const VARS = ['input', 'notebook', 'date', 'branch'];

/* ---- Hooks ------------------------------------------------------------------ */

/** Apply a params patch, recording one undo step per burst of typing. */
function useParams(id: string) {
  const apply = useEditor((s) => s.apply);
  const last = useRef(0);
  return (patch: Record<string, unknown>) => {
    const now = Date.now();
    const fresh = now - last.current > 800;
    last.current = now;
    apply((g) => updateParams(g, id, patch), { record: fresh });
  };
}

/* ---- Context policy ------------------------------------------------------- */

const kt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n)));

export function ContextEditor({
  value,
  onChange,
  estimateFor,
}: {
  value: ContextPolicy;
  onChange: (p: ContextPolicy) => void;
  estimateFor?: { node_id?: string; edge_id?: string; window?: number };
}) {
  const conv = value.conversation;
  const src = value.sources;
  // Core estimates the whole graph whenever it changes (FlowEditor); pick
  // the row for this edge, the edges into this node, or out of a Context node.
  const estimates = useEditor((s) => s.estimates);
  const edges = useEditor((s) => s.graph.edges);
  const est = useMemo(() => {
    if (estimates === 'needs-core') return 'needs-core' as const;
    if (!estimates || !estimateFor) return null;
    const outOf = new Set(edges.filter((e) => e.from === estimateFor.node_id).map((e) => e.id));
    const rows = estimates.filter((x) =>
      estimateFor.edge_id
        ? x.edge_id === estimateFor.edge_id
        : x.node_id === estimateFor.node_id || (x.edge_id != null && outOf.has(x.edge_id)),
    );
    return rows.sort((a, b) => b.total - a.total)[0] ?? null;
  }, [estimates, edges, estimateFor]);

  return (
    <div className="fp-context">
      <Field label="Conversation">
        <Select
          label="Conversation"
          value={conv.mode}
          onChange={(mode) =>
            onChange({
              ...value,
              conversation: mode === 'last_n' ? { mode, n: 6 } : ({ mode } as ContextPolicy['conversation']),
            })
          }
          options={[
            { value: 'none', label: 'None' },
            { value: 'last_n', label: 'The last few turns' },
            { value: 'branch', label: 'This branch (compacted)' },
            { value: 'siblings', label: 'This branch, and what siblings tried' },
            { value: 'tree_summary', label: 'A summary of the whole tree' },
            { value: 'tldr', label: 'Just the TL;DR' },
          ]}
        />
      </Field>
      {conv.mode === 'last_n' ? (
        <Field label="Turns">
          <Num
            label="Turns"
            value={conv.n}
            min={1}
            max={200}
            onChange={(n) => onChange({ ...value, conversation: { mode: 'last_n', n: n ?? 6 } })}
          />
        </Field>
      ) : null}
      <Field label="Sources">
        <Select
          label="Sources"
          value={src.mode}
          onChange={(mode) =>
            onChange({
              ...value,
              sources:
                mode === 'retrieved'
                  ? { mode, k: 8 }
                  : mode === 'named'
                    ? { mode, source_ids: [] }
                    : { mode: 'none' },
            })
          }
          options={[
            { value: 'none', label: 'None' },
            { value: 'retrieved', label: 'Passages found for this message' },
            { value: 'named', label: 'Named sources' },
          ]}
        />
      </Field>
      {src.mode === 'retrieved' ? (
        <Field label="Passages">
          <Num
            label="Passages"
            value={src.k}
            min={1}
            max={50}
            onChange={(k) => onChange({ ...value, sources: { mode: 'retrieved', k: k ?? 8 } })}
          />
        </Field>
      ) : null}
      <Field label="Memory">
        <Segmented
          size="sm"
          label="Memory"
          value={value.memory}
          onChange={(memory) => onChange({ ...value, memory })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'project', label: 'Project' },
            { value: 'pack', label: 'All' },
          ]}
        />
      </Field>
      <Field label="Earlier work">
        <Segmented
          size="sm"
          label="Earlier work"
          value={value.upstream}
          onChange={(upstream) => onChange({ ...value, upstream })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'plan', label: 'Plan' },
            { value: 'previous', label: 'Previous' },
            { value: 'all', label: 'All' },
          ]}
        />
      </Field>
      <Field label="Token budget" hint="Trimmed in this order: earlier work, sources, conversation, memory.">
        <Num
          label="Token budget"
          value={value.budget_tokens}
          min={256}
          max={1_000_000}
          step={1000}
          placeholder="No cap"
          onChange={(b) =>
            onChange({ ...value, ...(b ? { budget_tokens: b } : { budget_tokens: undefined }) })
          }
          suffix="tokens"
        />
      </Field>
      {estimateFor ? (
        <div className="fp-estimate" data-over={est && est !== 'needs-core' && est.over ? true : undefined}>
          {est === 'needs-core' ? (
            <span className="mute">A live token estimate needs a newer Core.</span>
          ) : est ? (
            <>
              <span>
                {kt(est.tokens.conversation)} conversation · {kt(est.tokens.sources)} sources ·{' '}
                {kt(est.tokens.memory)} memory · {kt(est.tokens.upstream)} earlier work ·{' '}
                {kt(est.tokens.system + est.tokens.task)} role and task
              </span>
              <span className="fp-estimate__n">
                ≈ {est.total.toLocaleString('en-GB')} tokens
                {est.context_window ? ` of a ${windowText(est.context_window)} window` : ''}
                {est.over ? ', too big: it will be trimmed' : ''}
              </span>
            </>
          ) : (
            <span className="mute">Shown once a model is downstream.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---- Routes and rules ------------------------------------------------- */

function RoutesEditor({ node }: { node: Extract<FlowNode, { kind: 'router' }> }) {
  const apply = useEditor((s) => s.apply);
  const routes = node.params.routes;
  const setRoutes = (next: typeof routes) => apply((g) => updateParams(g, node.id, { routes: next }));
  return (
    <div className="fp-routes">
      {routes.map((r, i) => (
        <div key={r.label} className="fp-route">
          <div className="fp-route__head">
            <input
              className="input fp-input fp-route__label"
              aria-label={`Route ${i + 1} name`}
              defaultValue={r.label}
              onBlur={(e) => {
                const label = e.target.value.trim().replace(/\s+/g, '-').slice(0, 60);
                if (!label || label === r.label || routes.some((x) => x.label === label)) {
                  e.target.value = r.label;
                  return;
                }
                apply((g) =>
                  renameRoute(
                    updateParams(g, node.id, {
                      routes: routes.map((x, j) => (j === i ? { ...x, label } : x)),
                      ...(node.params.default_route === r.label && { default_route: label }),
                    }),
                    node.id,
                    r.label,
                    label,
                  ),
                );
              }}
            />
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label={`Remove route ${r.label}`}
              disabled={routes.length <= 1}
              onClick={() =>
                apply((g) =>
                  removeEdges(
                    updateParams(g, node.id, { routes: routes.filter((_, j) => j !== i) }),
                    g.edges.filter((e) => e.from === node.id && e.label === r.label).map((e) => e.id),
                  ),
                )
              }
            >
              <Icon name="close" size={10} />
            </button>
          </div>
          <textarea
            className="input fp-textarea"
            rows={2}
            aria-label={`When to take ${r.label}`}
            placeholder="When this route fits, in plain words"
            defaultValue={r.when}
            onBlur={(e) =>
              e.target.value !== r.when &&
              setRoutes(routes.map((x, j) => (j === i ? { ...x, when: e.target.value } : x)))
            }
          />
        </div>
      ))}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={routes.length >= 20}
        onClick={() => {
          let n = routes.length + 1;
          while (routes.some((r) => r.label === `route-${n}`)) n++;
          setRoutes([...routes, { label: `route-${n}`, when: '' }]);
        }}
      >
        <Icon name="plus" size={12} /> Add a route
      </button>
    </div>
  );
}

const FIELDS: { value: RuleCondition['field']; label: string }[] = [
  { value: 'text', label: 'Message text' },
  { value: 'length', label: 'Message length' },
  { value: 'notebook', label: 'Notebook' },
  { value: 'mentions_model', label: '@model named' },
  { value: 'has_attachment', label: 'Has an attachment' },
  { value: 'hour', label: 'Hour of day' },
  { value: 'budget_left_usd', label: 'Turn budget left' },
  { value: 'month_spend_usd', label: 'Spend this month' },
  { value: 'branch_depth', label: 'Branch depth' },
  { value: 'language', label: 'Language' },
  { value: 'node_awake', label: 'GPU node awake' },
];
const OPS: { value: RuleCondition['op']; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'matches', label: 'matches (regex)' },
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'gt', label: 'more than' },
  { value: 'lt', label: 'less than' },
  { value: 'in', label: 'is one of' },
];

function RulesEditor({ node }: { node: Extract<FlowNode, { kind: 'rule' }> }) {
  const apply = useEditor((s) => s.apply);
  const rules = node.params.rules;
  const set = (next: typeof rules) => apply((g) => updateParams(g, node.id, { rules: next }));
  const numeric = (f: RuleCondition['field']) =>
    ['length', 'hour', 'budget_left_usd', 'month_spend_usd', 'branch_depth'].includes(f);
  return (
    <div className="fp-rules">
      {rules.map((r, i) => (
        <div key={r.label} className="fp-rule">
          <div className="fp-route__head">
            <span className="fp-rule__n">{i + 1}</span>
            <input
              className="input fp-input fp-route__label"
              aria-label={`Rule ${i + 1} route`}
              defaultValue={r.label}
              onBlur={(e) => {
                const label = e.target.value.trim().replace(/\s+/g, '-').slice(0, 60);
                if (!label || label === r.label) return;
                apply((g) =>
                  renameRoute(
                    updateParams(g, node.id, { rules: rules.map((x, j) => (j === i ? { ...x, label } : x)) }),
                    node.id,
                    r.label,
                    label,
                  ),
                );
              }}
            />
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label="Remove this rule"
              onClick={() => set(rules.filter((_, j) => j !== i))}
            >
              <Icon name="close" size={10} />
            </button>
          </div>
          {r.all.map((c, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions are ordered and may repeat a field
            <div key={`${k}-${c.field}`} className="fp-cond">
              <span className="fp-cond__and">{k === 0 ? 'When' : 'and'}</span>
              <Select
                label="Field"
                value={c.field}
                options={FIELDS}
                onChange={(field) =>
                  set(
                    rules.map((x, j) =>
                      j === i ? { ...x, all: x.all.map((y, m) => (m === k ? { ...y, field } : y)) } : x,
                    ),
                  )
                }
              />
              <Select
                label="Test"
                value={c.op}
                options={OPS}
                onChange={(op) =>
                  set(
                    rules.map((x, j) =>
                      j === i ? { ...x, all: x.all.map((y, m) => (m === k ? { ...y, op } : y)) } : x,
                    ),
                  )
                }
              />
              <input
                className="input fp-input"
                aria-label="Value"
                defaultValue={Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}
                onBlur={(e) => {
                  const raw = e.target.value;
                  const value =
                    c.op === 'in'
                      ? raw
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      : numeric(c.field)
                        ? Number(raw) || 0
                        : raw === 'true'
                          ? true
                          : raw === 'false'
                            ? false
                            : raw;
                  set(
                    rules.map((x, j) =>
                      j === i ? { ...x, all: x.all.map((y, m) => (m === k ? { ...y, value } : y)) } : x,
                    ),
                  );
                }}
              />
              {r.all.length > 1 ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--xs"
                  aria-label="Remove this condition"
                  onClick={() =>
                    set(rules.map((x, j) => (j === i ? { ...x, all: x.all.filter((_, m) => m !== k) } : x)))
                  }
                >
                  <Icon name="minus" size={10} />
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="fp-link"
            onClick={() =>
              set(
                rules.map((x, j) =>
                  j === i ? { ...x, all: [...x.all, { field: 'text', op: 'contains', value: '' }] } : x,
                ),
              )
            }
          >
            and…
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() =>
          set([
            ...rules,
            { label: `rule-${rules.length + 1}`, all: [{ field: 'text', op: 'contains', value: '' }] },
          ])
        }
      >
        <Icon name="plus" size={12} /> Add a rule
      </button>
      <Field label="Otherwise" hint="Route taken when no rule matches. Empty: an ‘otherwise’ port.">
        <Text
          label="Otherwise route"
          value={node.params.default_route ?? ''}
          onChange={(v) => apply((g) => updateParams(g, node.id, { default_route: v || undefined }))}
          placeholder="otherwise"
        />
      </Field>
    </div>
  );
}

/* ---- Model settings (model and manager) ---------------------------- */

function ModelSettings({
  node,
  models,
}: {
  node: Extract<FlowNode, { kind: 'model' | 'manager' }>;
  models: FlowModel[];
}) {
  const set = useParams(node.id);
  const p = node.params;
  const tools = useQuery({
    queryKey: ['flows', 'tools'],
    queryFn: () =>
      api
        .get<{ items: { name: string; description: string; tier: string }[] }>('/tools')
        .then((r) => r.items),
    staleTime: 60_000,
  });
  const m = models.find((x) => x.id === p.model);
  return (
    <>
      <Field label="Model" wide>
        <ModelPicker
          label="Model"
          value={p.model}
          models={models}
          onChange={(id) => id && set({ model: id })}
        />
      </Field>
      {m?.awake === false ? (
        <Field
          label="If its GPU node is asleep"
          hint="Wait for it to wake, or answer with the fallbacks straight away."
        >
          <Num
            label="Wait for wake"
            value={p.wait_for_wake_s}
            min={0}
            max={900}
            suffix="seconds"
            placeholder="Wait as long as it takes"
            onChange={(v) => set({ wait_for_wake_s: v })}
          />
        </Field>
      ) : null}
      {node.kind === 'manager' ? (
        <>
          <Field label="How it manages" wide>
            <Area
              label="How it manages"
              value={node.params.instructions}
              onChange={(v) => set({ instructions: v })}
              rows={4}
              vars={VARS}
            />
          </Field>
          <Field label="Rounds" hint="How many times it may send work back before it must answer.">
            <Num
              label="Rounds"
              value={node.params.max_rounds}
              min={1}
              max={10}
              onChange={(v) => set({ max_rounds: v ?? 3 })}
            />
          </Field>
        </>
      ) : null}
      <Field label="Role" wide hint="Who this model is in the flow. Its system prompt.">
        <Area
          label="Role"
          value={p.role}
          onChange={(v) => set({ role: v })}
          rows={5}
          vars={VARS}
          placeholder="You are the coder. Write the code the plan asks for, nothing more."
        />
      </Field>
      <div className="fp-row">
        <Field label="Temperature">
          <Num
            label="Temperature"
            value={p.temperature}
            min={0}
            max={2}
            step={0.1}
            placeholder="Default"
            onChange={(v) => set({ temperature: v })}
          />
        </Field>
        <Field label="Max output">
          <Num
            label="Max output"
            value={p.max_output}
            min={1}
            max={200_000}
            step={256}
            placeholder="Default"
            suffix="tokens"
            onChange={(v) => set({ max_output: v })}
          />
        </Field>
      </div>
      <Field label="Thinking">
        <Segmented
          size="sm"
          label="Thinking"
          value={p.reasoning ?? 'off'}
          onChange={(reasoning) => set({ reasoning: reasoning === 'off' ? undefined : reasoning })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
      </Field>
      <Field label="Fallbacks" hint="Tried in order if this model fails or refuses." wide>
        <ModelList
          label="Add a fallback"
          value={p.fallbacks}
          models={models}
          onChange={(v) => set({ fallbacks: v })}
        />
      </Field>
      <Field label="Tools it may use" hint="Still asks you first when a tool needs it." wide>
        <div className="fp-tools">
          {(tools.data ?? []).map((t) => (
            <label key={t.name} className="fp-tool" title={t.description}>
              <input
                type="checkbox"
                checked={p.tools.includes(t.name)}
                onChange={(e) =>
                  set({
                    tools: e.target.checked ? [...p.tools, t.name] : p.tools.filter((x) => x !== t.name),
                  })
                }
              />
              <span>{t.name}</span>
              {t.tier !== 'auto' ? (
                <span className="fp-tag" data-tone="warn">
                  asks
                </span>
              ) : null}
            </label>
          ))}
          {tools.isError ? <span className="mute">Tools could not be listed.</span> : null}
        </div>
      </Field>
      <div className="fp-row">
        <Field label="Cost cap per call">
          <Num
            label="Cost cap"
            value={p.cost_cap_usd}
            min={0}
            step={0.01}
            placeholder="Flow cap"
            suffix="USD"
            onChange={(v) => set({ cost_cap_usd: v })}
          />
        </Field>
        <Field label="Reuse answers for">
          <Num
            label="Cache"
            value={p.cache_s ? Math.round(p.cache_s / 60) : undefined}
            min={0}
            max={43_200}
            placeholder="Never"
            suffix="min"
            onChange={(v) => set({ cache_s: v ? v * 60 : undefined })}
          />
        </Field>
      </div>
      <Field label="Speaks to you" hint="Its words stream into the answer you see. Usually the last model.">
        <Switch label="Speaks to you" checked={p.speaks} onChange={(v) => set({ speaks: v })} />
      </Field>
    </>
  );
}

/* ---- Debug: last run, run alone, pin ---------------------------------- */

/** Pretty-print what a node was shown: strings as they are, structures as JSON. */
export function payloadText(p: unknown): string {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (typeof p === 'object' && 'messages' in p) {
    const o = p as { system?: string; messages?: { role: string; content: unknown }[] };
    const parts: string[] = [];
    if (o.system) parts.push(`SYSTEM\n${o.system}`);
    for (const m of o.messages ?? [])
      parts.push(
        `${m.role.toUpperCase()}\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}`,
      );
    return parts.join('\n\n');
  }
  return JSON.stringify(p, null, 2);
}

function DebugSection({ node, flowId }: { node: FlowNode; flowId: string | undefined }) {
  const last = useLastRun(flowId, node.id);
  const apply = useEditor((s) => s.apply);
  const startLive = useEditor((s) => s.startLive);
  const setValidation = useEditor((s) => s.setValidation);
  const runs = KINDS[node.kind].furniture !== true && node.kind !== 'input' && node.kind !== 'output';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<false | 'only' | 'to'>(false);
  const [result, setResult] = useState<RunNodeResult | null>(null);
  if (!runs) return null;
  const lr = last.data;
  const message = () => text.trim() || 'Hello';

  const fail = (err: unknown) => {
    const issues = invalidIssues(err);
    if (issues) {
      setValidation({ ok: false, issues, estimate: { paths: [] } });
      useEditor.getState().setPanel('lint');
      notify({
        level: 'error',
        title: 'The flow has problems to fix first',
        body: 'They are listed in What to fix.',
      });
      return;
    }
    notify({
      level: needsCore(err) ? 'info' : 'error',
      title: needsCore(err) ? 'Running a node needs a newer Core' : 'That did not run',
      body: needsCore(err) ? 'Use Try a message to run the whole flow.' : String((err as Error).message),
    });
  };

  /** This node alone (with its workers): Core answers when it is done. */
  const runOnly = async (mock: boolean) => {
    if (!flowId) return;
    setBusy('only');
    setResult(null);
    try {
      setResult(
        await runNode(flowId, node.id, {
          graph: useEditor.getState().graph,
          input: message(),
          ...(mock && { mock }),
        }),
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Everything up to this node, streamed live on the canvas. */
  const runTo = async (mock: boolean) => {
    setBusy('to');
    try {
      const s = await tryFlow({
        text: message(),
        graph: upToHere(useEditor.getState().graph, node.id),
        ...(mock && { mock }),
      });
      startLive(s.run_id);
      useEditor.getState().setPanel('try');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const shown = result
    ? {
        output: result.output,
        payload: result.payload,
        model: result.model_id,
        ms: result.ms as number | undefined,
        tin: result.tokens_in as number | undefined,
        tout: result.tokens_out as number | undefined,
        cost: result.cost_usd as number | undefined,
        at: null as string | null,
      }
    : lr
      ? {
          output: lr.output,
          payload: lr.payload,
          model: lr.meta.model_id ?? null,
          ms: lr.meta.ms,
          tin: lr.meta.tokens_in,
          tout: lr.meta.tokens_out,
          cost: lr.meta.cost_usd,
          at: lr.at,
        }
      : null;

  return (
    <Section
      title="Debug"
      aside={
        shown?.at ? (
          <span className="mute">
            {new Date(shown.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        ) : result ? (
          <span className="mute">just now</span>
        ) : null
      }
    >
      {busy === 'only' ? (
        <p className="fp-running">
          <span className="fnode__live-pulse" aria-hidden="true" /> Running {node.label || node.id}…
        </p>
      ) : shown ? (
        <div className="fp-last">
          <div className="fp-last__meta">
            {shown.model ? <span>{shown.model}</span> : null}
            {shown.ms != null ? <span>{msText(shown.ms)}</span> : null}
            {shown.tin != null ? (
              <span>
                {shown.tin} in · {shown.tout ?? 0} out
              </span>
            ) : null}
            {shown.cost != null ? <span>{usd(shown.cost)}</span> : null}
          </div>
          <details>
            <summary>What it was given</summary>
            <pre className="fp-pre">{payloadText(shown.payload)}</pre>
          </details>
          <details open>
            <summary>What it said</summary>
            <pre className="fp-pre">{shown.output}</pre>
          </details>
          {node.kind === 'model' ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => apply((g) => updateParams(g, node.id, { pinned_output: shown.output }))}
            >
              <Icon name="pin" size={12} /> Pin this output
            </button>
          ) : null}
        </div>
      ) : last.isPending && flowId ? (
        <p className="mute">Looking for its last run…</p>
      ) : last.isError ? (
        <p className="fp-needs">Its last run could not be read.</p>
      ) : (
        <p className="mute">Not run yet. Run it here, or try a message.</p>
      )}
      <textarea
        className="input fp-textarea"
        rows={2}
        aria-label="Test message"
        placeholder="A test message"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="fp-actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!flowId || !!busy}
          data-busy={busy === 'only' || undefined}
          onClick={() => void runOnly(false)}
        >
          <Icon name="play" size={12} /> Run only this
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!!busy}
          onClick={() => void runTo(false)}
        >
          Run to here
        </button>
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          disabled={!flowId || !!busy}
          title="Mock models: checks wiring and context sizes at no cost"
          onClick={() => void runOnly(true)}
        >
          Dry run
        </button>
      </div>
      {node.kind === 'model' ? (
        <Field
          label="Pinned output"
          hint="Used instead of calling the model, so you can work on the rest for free."
          wide
        >
          <Area
            label="Pinned output"
            value={node.params.pinned_output ?? ''}
            onChange={(v) => apply((g) => updateParams(g, node.id, { pinned_output: v || undefined }))}
            rows={3}
            placeholder="Not pinned"
          />
        </Field>
      ) : null}
    </Section>
  );
}

/* ---- The panel ---------------------------------------------------------------- */

export function NodePanel({
  node,
  models,
  flowId,
}: {
  node: FlowNode;
  models: FlowModel[];
  flowId: string | undefined;
}) {
  const apply = useEditor((s) => s.apply);
  const select = useEditor((s) => s.select);
  const set = useParams(node.id);
  const info = KINDS[node.kind];
  const flows = useFlows();
  const validation = useEditor((s) => s.validation);
  const issues = useMemo(
    () => validation?.issues.filter((i) => i.node_id === node.id) ?? [],
    [validation, node.id],
  );
  const model = useMemo(
    () => models.find((m) => 'model' in node.params && m.id === (node.params as { model?: string }).model),
    [models, node],
  );

  return (
    <div className="fpanel__body" key={node.id}>
      <header className="fp-head" style={{ '--hue': hueVar(info.hue) } as CSSProperties}>
        <span className="fnode__glyph">
          <Icon name={info.icon} size={14} />
        </span>
        <div className="fp-head__text">
          <input
            className="fp-head__label"
            aria-label="Node name"
            defaultValue={node.label ?? ''}
            placeholder={info.name}
            onBlur={(e) =>
              e.target.value !== (node.label ?? '') &&
              apply((g) => updateNode(g, node.id, { label: e.target.value || undefined }))
            }
          />
          <span className="fp-head__kind">
            {info.name} ·{' '}
            <input
              className="fp-head__id"
              aria-label="Node id"
              defaultValue={node.id}
              onBlur={(e) => {
                const id = e.target.value.trim();
                if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) {
                  e.target.value = node.id;
                  return;
                }
                if (id !== node.id) {
                  apply((g) => renameNode(g, node.id, id));
                  select([id]);
                }
              }}
            />
          </span>
        </div>
      </header>
      <p className="fp-blurb">{info.blurb}</p>

      {issues.length ? (
        <ul className="fp-issues">
          {issues.map((i) => (
            <li key={`${i.code}-${i.message}`} data-level={i.level}>
              <Icon name={i.level === 'error' ? 'alert' : 'warn'} size={12} />
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}

      <Section title="Settings">
        {node.kind === 'model' || node.kind === 'manager' ? (
          <ModelSettings node={node} models={models} />
        ) : null}
        {node.kind === 'router' ? (
          <>
            <Field label="Router model" wide hint="A small fast model is usually enough.">
              <ModelPicker
                label="Router model"
                value={node.params.model}
                models={models}
                onChange={(id) => id && set({ model: id })}
              />
            </Field>
            <Field label="How to route" wide>
              <Area
                label="How to route"
                value={node.params.instructions}
                onChange={(v) => set({ instructions: v })}
                rows={4}
                vars={VARS}
                placeholder="Ticket requests go to the Qwen node. Maths and physics go to the maths model. Otherwise, judge what I am trying to do."
              />
            </Field>
            <Field label="Routes" wide hint="Each route is an output port. Describe when it fits.">
              <RoutesEditor node={node} />
            </Field>
            <div className="fp-row">
              <Field label="When unsure, take">
                <Select
                  label="Default route"
                  value={node.params.default_route ?? ''}
                  options={[
                    { value: '', label: 'The best guess' },
                    ...node.params.routes.map((r) => ({ value: r.label, label: r.label })),
                  ]}
                  onChange={(v) => set({ default_route: v || undefined })}
                />
              </Field>
              <Field label="Unsure below">
                <Num
                  label="Minimum confidence"
                  value={Math.round(node.params.min_confidence * 100)}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(v) => set({ min_confidence: (v ?? 50) / 100 })}
                />
              </Field>
            </div>
            <Field label="May pick several routes" hint="Chosen routes run in parallel.">
              <Switch
                label="May pick several routes"
                checked={node.params.multi}
                onChange={(v) => set({ multi: v })}
              />
            </Field>
          </>
        ) : null}
        {node.kind === 'rule' ? <RulesEditor node={node} /> : null}
        {node.kind === 'join' ? (
          <>
            <Field label="Keep">
              <Segmented
                size="sm"
                label="Join mode"
                value={node.params.mode}
                onChange={(mode) => set({ mode })}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'first', label: 'First' },
                  { value: 'vote', label: 'Vote' },
                  { value: 'judge', label: 'Judge' },
                ]}
              />
            </Field>
            {node.params.mode === 'judge' ? (
              <>
                <Field label="Judge" wide>
                  <ModelPicker
                    label="Judge model"
                    value={node.params.judge_model}
                    models={models}
                    onChange={(id) => set({ judge_model: id })}
                  />
                </Field>
                <Field label="How to judge" wide>
                  <Area
                    label="How to judge"
                    value={node.params.judge_instructions}
                    onChange={(v) => set({ judge_instructions: v })}
                    rows={3}
                    placeholder="Pick the answer that is correct, complete and shortest."
                  />
                </Field>
              </>
            ) : null}
          </>
        ) : null}
        {node.kind === 'loop' ? (
          <>
            <Field label="At most">
              <Num
                label="Max iterations"
                value={node.params.max_iterations}
                min={1}
                max={10}
                suffix="times"
                onChange={(v) => set({ max_iterations: v ?? 3 })}
              />
            </Field>
            <Field label="Done when" wide>
              <Area
                label="Done when"
                value={node.params.until}
                onChange={(v) => set({ until: v })}
                rows={2}
              />
            </Field>
            <Field label="Checked by" wide>
              <ModelPicker
                label="Checker"
                value={node.params.until_model}
                models={models}
                onChange={(id) => set({ until_model: id })}
                allowNone="The flow's default model"
              />
            </Field>
          </>
        ) : null}
        {node.kind === 'context' ? (
          <ContextEditor
            value={node.params}
            onChange={(p) => apply((g) => updateParams(g, node.id, p))}
            estimateFor={{ node_id: node.id }}
          />
        ) : null}
        {node.kind === 'retrieve' ? (
          <>
            <Field label="Search for" wide>
              <Area
                label="Query"
                value={node.params.query}
                onChange={(v) => set({ query: v })}
                rows={2}
                vars={VARS}
              />
            </Field>
            <div className="fp-row">
              <Field label="Passages">
                <Num
                  label="Passages"
                  value={node.params.k}
                  min={1}
                  max={50}
                  onChange={(v) => set({ k: v ?? 8 })}
                />
              </Field>
              <Field label="Rerank">
                <Switch label="Rerank" checked={node.params.rerank} onChange={(v) => set({ rerank: v })} />
              </Field>
            </div>
          </>
        ) : null}
        {node.kind === 'factcheck' ? (
          <>
            <Field label="Unsure below">
              <Num
                label="Minimum confidence"
                value={Math.round(node.params.min_confidence * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => set({ min_confidence: (v ?? 70) / 100 })}
              />
            </Field>
            <Field label="Verifier" wide hint="Best from a different family than the writer.">
              <ModelPicker
                label="Verifier"
                value={node.params.verifier}
                models={models}
                onChange={(id) => set({ verifier: id })}
                allowNone="Chosen for independence"
              />
            </Field>
            <Field label="Add a caveat when unsure">
              <Switch
                label="Add a caveat"
                checked={node.params.caveat}
                onChange={(v) => set({ caveat: v })}
              />
            </Field>
          </>
        ) : null}
        {node.kind === 'tool' ? <ToolSettings node={node} /> : null}
        {node.kind === 'template' ? (
          <Field label="Template" wide hint="{{node_id}} inserts that node's output.">
            <Area
              label="Template"
              value={node.params.template}
              onChange={(v) => set({ template: v })}
              rows={6}
              vars={VARS}
              mono
            />
          </Field>
        ) : null}
        {node.kind === 'output' ? (
          <Field
            label="Compose the answer"
            wide
            hint="Leave empty to pass the last output through. {{node_id}} inserts a node's output."
          >
            <Area
              label="Answer template"
              value={node.params.template}
              onChange={(v) => set({ template: v })}
              rows={4}
              vars={VARS}
            />
          </Field>
        ) : null}
        {node.kind === 'human' ? (
          <>
            <Field label="Ask" wide>
              <Area
                label="Question"
                value={node.params.question}
                onChange={(v) => set({ question: v })}
                rows={2}
              />
            </Field>
            <Field label="Show what came before">
              <Switch
                label="Show earlier work"
                checked={node.params.show_upstream}
                onChange={(v) => set({ show_upstream: v })}
              />
            </Field>
          </>
        ) : null}
        {node.kind === 'subflow' ? (
          <Field label="Flow to run" wide>
            <Select
              label="Flow"
              value={node.params.flow_id}
              options={[
                { value: '', label: 'Choose a flow' },
                ...(flows.data ?? []).map((f) => ({ value: f.id, label: f.name })),
              ]}
              onChange={(v) => set({ flow_id: v })}
            />
          </Field>
        ) : null}
        {node.kind === 'note' ? (
          <Field label="Note" wide>
            <Area label="Note" value={node.params.text} onChange={(v) => set({ text: v })} rows={6} />
          </Field>
        ) : null}
        {node.kind === 'input' || node.kind === 'parallel' ? (
          <p className="mute fp-blurb">Nothing to set here.</p>
        ) : null}
      </Section>

      {!info.furniture && info.input ? <IncomingContext nodeId={node.id} window={model?.window} /> : null}

      <Section title="On the canvas">
        <Field label="Colour">
          <div className="fp-hues" role="radiogroup" aria-label="Colour">
            {HUES.map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={(node.color ?? '') === h}
                aria-label={h}
                className="fp-hue"
                style={{ '--hue': hueVar(h) } as CSSProperties}
                onClick={() =>
                  apply((g) => updateNode(g, node.id, { color: node.color === h ? undefined : h }))
                }
              />
            ))}
          </div>
        </Field>
        {!info.furniture ? (
          <Field label="Bypass" hint="Skip it when the flow runs; work passes straight through.">
            <Switch
              label="Bypass"
              checked={!!node.disabled}
              onChange={(v) => apply((g) => setDisabled(g, [node.id], v))}
            />
          </Field>
        ) : null}
        <Field label="Notes" wide hint="For whoever edits this flow next. Never sent to a model.">
          <Area
            label="Notes"
            value={node.notes ?? ''}
            onChange={(v) =>
              apply((g) => updateNode(g, node.id, { notes: v || undefined }), { record: false })
            }
            rows={2}
          />
        </Field>
      </Section>

      <DebugSection node={node} flowId={flowId} />
    </div>
  );
}

/** What reaches this node: one row per incoming connection, each editable. */
function IncomingContext({ nodeId, window: win }: { nodeId: string; window?: number }) {
  const edges = useEditor((s) => s.graph.edges);
  const nodes = useEditor((s) => s.graph.nodes);
  const select = useEditor((s) => s.select);
  const incoming = edges.filter((e) => e.to === nodeId);
  return (
    <Section title="What it sees" aside={win ? <span className="mute">{windowText(win)} window</span> : null}>
      {incoming.length === 0 ? (
        <p className="mute fp-blurb">Nothing connects to it yet.</p>
      ) : (
        <ul className="fp-incoming">
          {incoming.map((e) => {
            const from = nodes.find((n) => n.id === e.from);
            return (
              <li key={e.id}>
                <button type="button" className="fp-incoming__row" onClick={() => select([], e.id)}>
                  <span className="fp-incoming__from">
                    {from?.label || from?.id}
                    {e.label ? <span className="fp-tag">{e.label}</span> : null}
                  </span>
                  <span className="fp-incoming__ctx" data-custom={e.context ? true : undefined}>
                    {contextSummary(e.context)}
                  </span>
                  <Icon name="chevronRight" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ToolSettings({ node }: { node: Extract<FlowNode, { kind: 'tool' }> }) {
  const set = useParams(node.id);
  const tools = useQuery({
    queryKey: ['flows', 'tools'],
    queryFn: () =>
      api
        .get<{ items: { name: string; description: string; tier: string }[] }>('/tools')
        .then((r) => r.items),
    staleTime: 60_000,
  });
  const t = tools.data?.find((x) => x.name === node.params.tool);
  return (
    <>
      <Field label="Tool" wide hint={t?.description}>
        <Select
          label="Tool"
          value={node.params.tool}
          options={[
            { value: '', label: 'Choose a tool' },
            ...(tools.data ?? []).map((x) => ({
              value: x.name,
              label: `${x.name}${x.tier !== 'auto' ? ' (asks first)' : ''}`,
            })),
          ]}
          onChange={(v) => set({ tool: v })}
        />
      </Field>
      <Field label="Arguments" wide hint="JSON. {{input}} and {{node_id}} are filled in.">
        <Area
          label="Arguments"
          value={node.params.args}
          onChange={(v) => set({ args: v })}
          rows={4}
          vars={VARS}
          mono
        />
      </Field>
    </>
  );
}
