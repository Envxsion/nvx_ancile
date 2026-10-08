/**
 * ------------------------------------------------------------------
 *  Title    |  Flow editor panels
 *  Ref      |  DESIGN.md §16.5, §16.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The right-hand panels beside the canvas:
 *           |    Edge      what crosses a connection, and the payload
 *           |    Try       run a message through the flow, live
 *           |    Lint      what is wrong, and what each path costs
 *           |    Versions  drafts, publishing, compare, restore, YAML
 *           |    Calls     close routing calls, labelled in one click
 *           |    Settings  name, limits, how teamwork is shown
 * ------------------------------------------------------------------
 */

import type { FlowEdge, RunEvent } from '@nvx/contracts';
import { RunEvent as RunEventSchema } from '@nvx/contracts';
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api';
import { useThreads } from '../lib/data';
import { relative } from '../lib/format';
import { openStream } from '../lib/sse';
import { notify } from '../state/notify';
import { Segmented, Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import {
  exportYaml,
  getVersion,
  importYaml,
  invalidIssues,
  labelDecision,
  needsCore,
  publishFlow,
  restoreVersion,
  tryFlow,
  useCloseCalls,
  useLastRun,
  useVersions,
} from './api';
import { contextSummary, msText, usd } from './describe';
import { Field, Num, Section, Text } from './fields';
import { diff, removeEdges, updateEdge } from './graph';
import { KINDS } from './kinds';
import { ContextEditor, payloadText } from './NodePanel';
import { useEditor } from './store';

/* ---- Edge -------------------------------------------------------------------- */

const DEFAULT_POLICY = {
  conversation: { mode: 'branch' as const },
  sources: { mode: 'retrieved' as const, k: 8 },
  memory: 'pack' as const,
  upstream: 'previous' as const,
};

export function EdgePanel({ edge }: { edge: FlowEdge }) {
  const apply = useEditor((s) => s.apply);
  const select = useEditor((s) => s.select);
  const nodes = useEditor((s) => s.graph.nodes);
  const from = nodes.find((n) => n.id === edge.from);
  const to = nodes.find((n) => n.id === edge.to);
  const flowId = useEditor((s) => s.meta?.id);
  // The literal payload is what the target node was given the last time it ran.
  const last = useLastRun(flowId, edge.to);
  const [showPayload, setShowPayload] = useState(false);

  return (
    <div className="fpanel__body">
      <header className="fp-head">
        <span className="fnode__glyph">
          <Icon name="arrowRight" size={14} />
        </span>
        <div className="fp-head__text">
          <span className="fp-head__title">
            {from?.label || from?.id} → {to?.label || to?.id}
          </span>
          <span className="fp-head__kind">{edge.label ? `Route “${edge.label}”` : 'Connection'}</span>
        </div>
      </header>
      <Section
        title="What crosses it"
        aside={
          <Switch
            label="Use its own context"
            checked={!!edge.context}
            onChange={(on) =>
              apply((g) => updateEdge(g, edge.id, { context: on ? DEFAULT_POLICY : undefined }))
            }
          />
        }
      >
        {edge.context ? (
          <ContextEditor
            value={edge.context}
            onChange={(p) => apply((g) => updateEdge(g, edge.id, { context: p }))}
            estimateFor={{ edge_id: edge.id }}
          />
        ) : (
          <p className="fp-blurb">
            {contextSummary(undefined)}: whatever the next node's Context node, or the flow's defaults, say.
            Switch on to set exactly what crosses this connection.
          </p>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowPayload((v) => !v)}>
          <Icon name="eye" size={12} /> {showPayload ? 'Hide' : 'Show'} what {to?.label || to?.id} was last
          given
        </button>
        {showPayload ? (
          last.data ? (
            <pre className="fp-pre">{payloadText(last.data.payload)}</pre>
          ) : (
            <p className="fp-needs">
              {last.isPending ? 'Looking…' : 'It has not run yet. Try a message first.'}
            </p>
          )
        ) : null}
      </Section>
      <div className="fp-actions">
        <button
          type="button"
          className="btn btn--danger btn--sm"
          onClick={() => {
            apply((g) => removeEdges(g, [edge.id]));
            select([]);
          }}
        >
          <Icon name="trash" size={12} /> Remove connection
        </button>
      </div>
    </div>
  );
}

/* ---- Try a message --------------------------------------------------------- */

export function TryPanel({ scopeRef }: { scopeRef: string | null }) {
  const live = useEditor((s) => s.live);
  const startLive = useEditor((s) => s.startLive);
  const onEvent = useEditor((s) => s.onEvent);
  const clearLive = useEditor((s) => s.clearLive);
  const nodes = useEditor((s) => s.graph.nodes);
  const threads = useThreads();
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem('nvx.ancile.flow-try') ?? '';
    } catch {
      return '';
    }
  });
  const [threadId, setThreadId] = useState('');
  const [mock, setMock] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  // Attach to whichever run the store says is live (Try, or a node run).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach only when the run changes
  useEffect(() => {
    if (!live?.runId) return;
    stop.current?.();
    stop.current = openStream<RunEvent>({
      url: `${API_BASE}/runs/${live.runId}/stream`,
      schema: RunEventSchema,
      onEvent,
      isTerminal: (e) => e.type === 'done',
    });
  }, [live?.runId]);

  const run = async () => {
    const t = text.trim();
    if (!t || busy) return;
    try {
      localStorage.setItem('nvx.ancile.flow-try', t);
    } catch {
      /* ignore */
    }
    setBusy(true);
    try {
      const s = await tryFlow({
        text: t,
        graph: useEditor.getState().graph,
        ...(threadId && { thread_id: threadId }),
        mock,
      });
      startLive(s.run_id);
    } catch (err) {
      const issues = invalidIssues(err);
      if (issues) {
        useEditor.getState().setValidation({ ok: false, issues, estimate: { paths: [] } });
        useEditor.getState().setPanel('lint');
        notify({ level: 'error', title: 'Fix the flow first', body: 'What needs fixing is listed here.' });
        return;
      }
      notify({
        level: needsCore(err) ? 'info' : 'error',
        title: needsCore(err) ? 'Trying a flow needs a newer Core' : 'The flow could not run',
        body: needsCore(err) ? 'The engine for flows is not in this Core yet.' : (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const order = live ? Object.entries(live.nodes).sort((a, b) => a[1].startedAt - b[1].startedAt) : [];
  const local = (threads.data ?? []).filter((t) => !scopeRef || t.notebookId === scopeRef).slice(0, 30);

  return (
    <div className="fpanel__body">
      <Section title="Try a message">
        <textarea
          className="input fp-textarea"
          rows={4}
          aria-label="Message to try"
          placeholder="Ask what you would ask in a chat. Nothing is written to a thread."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <Field label="Context from">
          <select
            className="input fp-input"
            aria-label="Context from"
            value={threadId}
            onChange={(e) => setThreadId(e.target.value)}
          >
            <option value="">An empty conversation</option>
            {local.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Mock models"
          hint="Checks wiring and context sizes at no cost; answers are placeholders."
        >
          <Switch label="Mock models" checked={mock} onChange={setMock} />
        </Field>
        <div className="fp-actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!text.trim() || busy}
            onClick={() => void run()}
          >
            <Icon name="play" size={12} /> {live?.state === 'running' ? 'Run again' : 'Run'}
          </button>
          {live ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={clearLive}>
              Clear
            </button>
          ) : null}
        </div>
      </Section>

      {live ? (
        <Section
          title={live.state === 'running' ? 'Running' : live.state === 'failed' ? 'Stopped' : 'Done'}
          aside={
            <span className="mute">
              {msText(Date.now() - live.startedAt)} · {usd(live.cost)}
            </span>
          }
        >
          <ol className="ftimeline">
            {order.map(([id, n]) => {
              const node = nodes.find((x) => x.id === id);
              const info = node ? KINDS[node.kind] : null;
              const d = live.decisions[id];
              return (
                <li key={id} className="ftimeline__step" data-status={n.status}>
                  <button
                    type="button"
                    className="ftimeline__head"
                    onClick={() => useEditor.getState().select([id])}
                  >
                    {info ? <Icon name={info.icon} size={12} /> : null}
                    <span className="ftimeline__name">{node?.label || id}</span>
                    {n.model ? <span className="ftimeline__model">{n.model.split('/').pop()}</span> : null}
                    <span className="ftimeline__meta">
                      {n.status === 'running'
                        ? 'working…'
                        : `${msText(n.ms)}${n.cost ? ` · ${usd(n.cost)}` : ''}`}
                    </span>
                  </button>
                  {d ? (
                    <p className="ftimeline__decision">
                      Chose <b>{d.chose.join(', ')}</b>
                      {d.confidence != null ? ` (${Math.round(d.confidence * 100)}%)` : ''}: {d.reason}
                    </p>
                  ) : null}
                  {n.reasoning ? (
                    <details className="ftimeline__think">
                      <summary>Thinking</summary>
                      <pre className="fp-pre">{n.reasoning}</pre>
                    </details>
                  ) : null}
                  {/* A router's raw choice is already shown above, in words. */}
                  {n.text && !d ? <pre className="fp-pre ftimeline__out">{n.text}</pre> : null}
                  {n.error ? <p className="ftimeline__err">{n.error}</p> : null}
                </li>
              );
            })}
          </ol>
          {live.answer ? (
            <div className="ftry__answer">
              <span className="fp-field__label">The answer</span>
              <div className="ftry__answer-text">{live.answer}</div>
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

/* ---- Lint --------------------------------------------------------------------- */

export function LintPanel() {
  const v = useEditor((s) => s.validation);
  const select = useEditor((s) => s.select);
  if (!v) return <div className="fpanel__body mute fp-blurb">Checking the flow…</div>;
  return (
    <div className="fpanel__body">
      <Section title={v.issues.length ? `${v.issues.length} to look at` : 'Nothing to fix'}>
        {v.issues.length === 0 ? (
          <p className="fp-blurb">
            Every node is reachable, every model is ready, and every route goes somewhere.
          </p>
        ) : null}
        <ul className="flint">
          {v.issues.map((i) => (
            <li key={`${i.code}-${i.node_id ?? i.edge_id ?? ''}-${i.message}`} data-level={i.level}>
              <button
                type="button"
                className="flint__row"
                onClick={() =>
                  i.node_id ? select([i.node_id]) : i.edge_id ? select([], i.edge_id) : undefined
                }
              >
                <Icon name={i.level === 'error' ? 'alert' : 'warn'} size={13} />
                <span className="flint__msg">{i.message}</span>
                <code className="flint__code">{i.code}</code>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="What each path costs">
        {v.estimate.paths.length === 0 ? (
          <p className="mute fp-blurb">No complete path from the message to the answer yet.</p>
        ) : null}
        <ul className="fpaths">
          {v.estimate.paths.map((p) => (
            <li key={p.nodes.join('>')} className="fpaths__row">
              <span className="fpaths__nodes">{p.nodes.join(' → ')}</span>
              <span className="fpaths__num">
                ≈ {usd(p.cost_usd)} · {msText(p.latency_ms)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/* ---- Versions --------------------------------------------------------------- */

export function VersionsPanel({ onSaved }: { onSaved: () => void }) {
  const meta = useEditor((s) => s.meta);
  const compare = useEditor((s) => s.compare);
  const setCompare = useEditor((s) => s.setCompare);
  const versions = useVersions(meta?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!meta) return null;
  const missing = versions.isError && needsCore(versions.error);

  const publish = async () => {
    try {
      await publishFlow(meta.id, meta.version);
      notify({
        level: 'success',
        title: `Version ${meta.version} is live`,
        body: 'New answers use it from now on.',
      });
      onSaved();
    } catch (err) {
      notify({
        level: needsCore(err) ? 'info' : 'error',
        title: needsCore(err) ? 'Publishing needs a newer Core' : 'Not published',
        body: needsCore(err)
          ? 'Until then the latest saved version is the one answers use.'
          : (err as Error).message,
      });
    }
  };

  const showDiff = async (v: number) => {
    if (compare?.version === v) return setCompare(null);
    try {
      const old = await getVersion(meta.id, v);
      setCompare({ version: v, graph: old, diff: diff(old, useEditor.getState().graph) });
    } catch (err) {
      notify({ level: 'error', title: 'That version could not be loaded', body: (err as Error).message });
    }
  };

  const restore = async (v: number) => {
    try {
      const f = await restoreVersion(meta.id, v);
      notify({
        level: 'success',
        title: `Restored version ${v}`,
        body: `Saved as version ${f.version}. Undo by restoring the one before.`,
      });
      onSaved();
    } catch (err) {
      notify({ level: 'error', title: 'Not restored', body: (err as Error).message });
    }
  };

  const doExport = async () => {
    try {
      const yaml = await exportYaml(meta.id);
      const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${meta.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'flow'}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify({
        level: needsCore(err) ? 'info' : 'error',
        title: needsCore(err) ? 'YAML export needs a newer Core' : 'Not exported',
        body: (err as Error).message,
      });
    }
  };

  return (
    <div className="fpanel__body">
      <Section title="Publish">
        <p className="fp-blurb">
          {meta.published === null || meta.published === meta.version
            ? `Answers use version ${meta.version}.`
            : `Answers use version ${meta.published}. Version ${meta.version} is a draft.`}
        </p>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={meta.published === meta.version}
          onClick={() => void publish()}
        >
          <Icon name="seal" size={12} /> Publish version {meta.version}
        </button>
        {meta.published !== null ? (
          <button
            type="button"
            className="fp-link"
            onClick={() =>
              void publishFlow(meta.id, null).then(
                () => {
                  notify({ level: 'success', title: 'Answers now follow every save' });
                  onSaved();
                },
                (err) => notify({ level: 'error', title: 'Not changed', body: (err as Error).message }),
              )
            }
          >
            Follow every save instead
          </button>
        ) : null}
      </Section>
      <Section title="History">
        {missing ? <p className="fp-needs">Version history needs a newer Core.</p> : null}
        <ol className="fversions">
          {(versions.data ?? [])
            .slice()
            .sort((a, b) => b.version - a.version)
            .map((v) => (
              <li
                key={v.version}
                className="fversions__row"
                data-live={v.version === (meta.published ?? meta.version) || undefined}
                data-compare={compare?.version === v.version || undefined}
              >
                <span className="fversions__n">v{v.version}</span>
                <span className="fversions__msg">{v.message ?? 'Saved'}</span>
                <span className="fversions__at">{relative(v.at)}</span>
                <span className="fversions__actions">
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => void showDiff(v.version)}
                  >
                    {compare?.version === v.version ? 'Hide' : 'Compare'}
                  </button>
                  {v.version !== meta.version ? (
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      onClick={() => void restore(v.version)}
                    >
                      Restore
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
        </ol>
        {compare ? (
          <p className="fdiff-legend">
            Against v{compare.version}: <span data-k="added">{compare.diff.added.length} added</span> ·{' '}
            <span data-k="changed">{compare.diff.changed.length} changed</span> ·{' '}
            <span data-k="removed">{compare.diff.removed.length} removed</span>, shown on the canvas.
          </p>
        ) : null}
      </Section>
      <Section title="Share">
        <div className="fp-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void doExport()}>
            <Icon name="download" size={12} /> Export YAML
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={12} /> Import as a new flow
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,text/yaml"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                const f = await importYaml(await file.text(), meta.scope, meta.scopeRef);
                notify({ level: 'success', title: `Imported ${f.name}` });
              } catch (err) {
                notify({
                  level: needsCore(err) ? 'info' : 'error',
                  title: needsCore(err) ? 'YAML import needs a newer Core' : 'Not imported',
                  body: (err as Error).message,
                });
              }
            }}
          />
        </div>
      </Section>
    </div>
  );
}

/* ---- Close calls ------------------------------------------------------------- */

export function CloseCallsPanel() {
  const meta = useEditor((s) => s.meta);
  const nodes = useEditor((s) => s.graph.nodes);
  const calls = useCloseCalls(meta?.id);
  if (!meta) return null;
  const missing = calls.isError && needsCore(calls.error);
  return (
    <div className="fpanel__body">
      <Section title="Close calls">
        <p className="fp-blurb">
          Messages where a router was nearly torn between two routes. Say which was right: it shows on the
          canvas and teaches routing what you mean.
        </p>
        {missing ? <p className="fp-needs">Close calls need a newer Core.</p> : null}
        {calls.data?.length === 0 ? (
          <p className="mute fp-blurb">No close calls. Routing has been sure of itself.</p>
        ) : null}
        <ul className="fcalls">
          {(calls.data ?? []).map((d) => {
            const node = nodes.find((n) => n.id === d.node_id);
            const routes =
              node?.kind === 'router' ? node.params.routes.map((r) => r.label) : Object.keys(d.scores ?? {});
            return (
              <li key={`${d.message_id}-${d.node_id}`} className="fcalls__row">
                <div className="fcalls__head">
                  <span>{node?.label || d.node_id}</span>
                  <span className="mute">
                    chose {d.chose.join(', ')}
                    {d.confidence != null ? ` at ${Math.round(d.confidence * 100)}%` : ''} · {relative(d.at)}
                  </span>
                </div>
                <div className="fcalls__routes">
                  {routes.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className="chip"
                      aria-pressed={d.label === r}
                      onClick={() =>
                        void labelDecision(meta.id, d, r).catch((err) =>
                          notify({
                            level: needsCore(err) ? 'info' : 'error',
                            title: needsCore(err) ? 'Labelling needs a newer Core' : 'Not saved',
                            body: (err as Error).message,
                          }),
                        )
                      }
                    >
                      {r}
                      {d.scores?.[r] != null ? (
                        <span className="mute"> {Math.round((d.scores[r] as number) * 100)}%</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

/* ---- Flow settings ----------------------------------------------------------- */

export function SettingsPanel({
  onMeta,
}: {
  onMeta: (patch: { name?: string; description?: string }) => void;
}) {
  const meta = useEditor((s) => s.meta);
  const settings = useEditor((s) => s.graph.settings);
  const apply = useEditor((s) => s.apply);
  if (!meta) return null;
  const set = (patch: Partial<typeof settings>) =>
    apply((g) => ({ ...g, settings: { ...g.settings, ...patch } }));
  return (
    <div className="fpanel__body">
      <Section title="This flow">
        <Field label="Name">
          <Text label="Flow name" value={meta.name} onChange={(name) => onMeta({ name })} />
        </Field>
        <Field label="What it is for" wide>
          <textarea
            className="input fp-textarea"
            rows={3}
            aria-label="Description"
            value={meta.description}
            onChange={(e) => onMeta({ description: e.target.value })}
          />
        </Field>
      </Section>
      <Section title="Limits for every answer">
        <div className="fp-row">
          <Field label="Steps">
            <Num
              label="Max steps"
              value={settings.max_steps}
              min={1}
              max={200}
              onChange={(v) => set({ max_steps: v ?? 24 })}
            />
          </Field>
          <Field label="Cost">
            <Num
              label="Cost cap"
              value={settings.cost_cap_usd}
              min={0}
              max={1000}
              step={0.05}
              suffix="USD"
              onChange={(v) => set({ cost_cap_usd: v ?? 1 })}
            />
          </Field>
          <Field label="Time">
            <Num
              label="Timeout"
              value={settings.timeout_s}
              min={10}
              max={3600}
              suffix="s"
              onChange={(v) => set({ timeout_s: v ?? 600 })}
            />
          </Field>
        </div>
        <p className="fp-blurb">When a limit is reached the answer stops and says why. Nothing runs away.</p>
      </Section>
      <Section title="Teamwork under each answer">
        <Segmented
          label="Teamwork"
          value={settings.show_teamwork}
          onChange={(show_teamwork) => set({ show_teamwork })}
          options={[
            { value: 'open', label: 'Open while it runs' },
            { value: 'collapsed', label: 'Folded' },
            { value: 'hidden', label: 'Hidden' },
          ]}
        />
      </Section>
    </div>
  );
}
