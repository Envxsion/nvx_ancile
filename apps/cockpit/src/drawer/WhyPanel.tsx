/**
 * ------------------------------------------------------------------
 *  Title    |  Why did the AI say this?
 *  Ref      |  DESIGN.md §11.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The chain behind one answer: which model wrote it and
 *           |  what was tried first, the memory it was given, which
 *           |  passages it read and how each scored, which it cited,
 *           |  the tools it used and the decision behind each, any
 *           |  compaction, what it cost, and how it held up.
 *  How      |  GET /messages/:id/explain: Core assembles it from what
 *           |  it recorded while the answer was written. Shows the
 *           |  answer chosen with W (or "Why" under it), else the
 *           |  latest one. Each section says plainly when there is
 *           |  nothing to show, rather than hiding.
 * ------------------------------------------------------------------
 */

import type { AnswerRoute, Explain, FlowProvenance } from '@nvx/contracts';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useThread } from '../lib/data';
import { startFactcheck, useExplain } from '../lib/factcheck';
import { modelName, percent, usd } from '../lib/format';
import { reasonWords, shortResource } from '../lib/mappers';
import { useMemoryFile } from '../memory/api';
import { useUi } from '../state/ui';
import { ScoreRing } from '../thread/Claims';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import { WhyDemo } from './WhyDemo';

const OUTCOME: Record<NonNullable<Explain['tools'][number]['decision']>['outcome'], string> = {
  auto: 'Allowed on its own (read-only)',
  grant: 'Allowed by a rule you made',
  approved: 'You approved it',
  denied: 'You declined it',
  policy_deny: 'Blocked by a policy',
  expired: 'Nobody answered in time',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="why__section">
      <h3 className="why__h">{title}</h3>
      {children}
    </section>
  );
}

function Retrieval({ x }: { x: Explain }) {
  const openViewer = useUi((s) => s.openViewer);
  const r = x.retrieval;
  if (!r)
    return (
      <p className="mute">
        {x.retrieval_error
          ? `Your sources could not be searched (${x.retrieval_error.title}), so this answer is not from them.`
          : 'This answer did not draw on sources: the thread is not in a notebook.'}
      </p>
    );
  if (!r.hits.length)
    return <p className="mute">The search found nothing in this notebook for the question.</p>;
  const best = Math.max(...r.hits.map((h) => h.score), 0.0001);
  return (
    <>
      <p className="mute">
        Searched for “{r.query.length > 90 ? `${r.query.slice(0, 90)}…` : r.query}” ({r.mode}
        {r.embedder ? `, ${r.embedder.replace(/^local\//, '')}` : ''}) in{' '}
        <span data-num>{Math.round(r.ms)}</span> ms.
        {r.invalid_markers
          ? ` ${r.invalid_markers} made-up ${r.invalid_markers === 1 ? 'citation was' : 'citations were'} removed.`
          : ''}
      </p>
      <ul className="why__retrieval">
        {r.hits.map((h) => (
          <li key={h.marker} data-cited={h.cited || undefined}>
            <span className="why__bar" style={{ width: `${Math.max(6, (h.score / best) * 100)}%` }} />
            <button
              type="button"
              className="why__rtitle link-btn link-btn--quiet"
              onClick={() => openViewer({ sourceId: h.source_id, marker: h.marker })}
              title={h.source_title}
            >
              [{h.marker}] {h.source_title}
              {h.page != null ? `, p. ${h.page}` : ''}
            </button>
            <span
              className="mute why__ranks"
              data-num
              title="Rank by meaning · rank by words, then the reranker's score"
            >
              {h.ranks.vector ?? '–'}·{h.ranks.text ?? '–'}
              {h.rerank_score != null ? ` → ${h.rerank_score.toFixed(2)}` : ''}
            </span>
            <span className="why__cited">{h.cited ? 'Cited' : 'Not cited'}</span>
          </li>
        ))}
      </ul>
      {r.grounded ? (
        <p className="why__sealed">
          <Icon name="seal" size={13} className="gilt-ink" /> Every paragraph that states something cites a
          passage.
        </p>
      ) : null}
    </>
  );
}

const SCOPE_WORDS: Record<string, string> = {
  thread: 'this thread',
  notebook: 'the notebook',
  workspace: 'the workspace default',
};

/**
 * One model answered (DESIGN §16.3): who chose it, and any flow that was set
 * aside for it, so "why didn't my flow answer?" has an answer.
 */
function ModelRouteSection({ route }: { route: AnswerRoute }) {
  const skipped = route.skipped_flow;
  const who =
    route.from === 'message'
      ? 'You picked this model for this message, so it answered on its own.'
      : route.from === 'thread'
        ? 'This thread’s model answered.'
        : route.thread_model_unready
          ? `This thread’s model, ${modelName(route.thread_model_unready)}, can no longer answer (no key, switched off, or removed), so your default answered. Press M to pick another.`
          : 'Your default model answered.';
  return (
    <Section title="Route">
      <p>
        {who}{' '}
        {skipped
          ? skipped.because === 'message_model'
            ? `${skipped.name}, the flow from ${SCOPE_WORDS[skipped.from] ?? skipped.from}, was set aside for this one message.`
            : `${skipped.name}, the flow from ${SCOPE_WORDS[skipped.from] ?? skipped.from}, is paused in this thread.`
          : route.from === 'default'
            ? 'No flow applies here.'
            : ''}
      </p>
    </Section>
  );
}

/** Flows (DESIGN §16.5): the route this answer took, each decision, and what each step cost. */
function FlowSection({
  flow,
  notebookId,
  traceUrl,
  chosen,
}: {
  flow: FlowProvenance;
  notebookId: string | null;
  traceUrl: string;
  chosen?: AnswerRoute['from'] | undefined;
}) {
  const named = new Map(
    flow.steps.map((s) => [s.node_id, s.label ?? (s.model_id ? modelName(s.model_id) : s.kind)]),
  );
  const navigate = useNavigate();
  const worked = flow.steps.filter((s) => s.status !== 'skipped');
  const priciest = Math.max(...worked.map((s) => s.cost_usd), 0.000001);
  return (
    <Section title="Route">
      <p>
        Answered by the flow <strong>{flow.name}</strong>, version <span data-num>{flow.version}</span>
        {chosen === 'message'
          ? ' (chosen for this answer)'
          : flow.scope === 'thread'
            ? ' (this thread’s own)'
            : flow.scope === 'notebook'
              ? ' (the notebook’s)'
              : ' (the workspace default)'}
        .
      </p>
      <ol className="why__path" aria-label="Path taken">
        {flow.path
          .filter((id) => {
            const k = flow.steps.find((x) => x.node_id === id)?.kind;
            return k !== 'input' && k !== 'output' && id !== 'input' && id !== 'output';
          })
          .map((id, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a manager may visit one node twice; the position is the identity
            <li key={`${id}-${i}`} className="why__hop">
              {i ? <Icon name="arrowRight" size={10} /> : null}
              {named.get(id) ?? id}
            </li>
          ))}
      </ol>
      {flow.decisions.length ? (
        <ul className="why__decisions">
          {flow.decisions.map((d) => (
            <li key={d.node_id}>
              <p className="why__tool">
                <strong>{named.get(d.node_id) ?? d.node_id}</strong> chose {d.chose.join(' and ')}
                {d.confidence !== null ? (
                  <span className="mute">
                    {' '}
                    (<span data-num>{percent(d.confidence)}</span> sure)
                  </span>
                ) : null}
              </p>
              {d.reason ? <p className="mute">{d.reason}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mute">No routing decisions on this path: every step was fixed in the flow.</p>
      )}
      <ul className="why__retrieval">
        {worked.map((s) => (
          <li key={`${s.node_id}-${s.started_at}`}>
            <span className="why__bar" style={{ width: `${Math.max(6, (s.cost_usd / priciest) * 100)}%` }} />
            <span className="why__rtitle">
              {named.get(s.node_id) ?? s.node_id}
              {s.model_id && s.label ? <span className="mute"> · {modelName(s.model_id)}</span> : null}
            </span>
            <span className="why__cited" data-num>
              {(s.ms / 1000).toFixed(1)} s · {usd(s.cost_usd, 4)}
              {s.status === 'pinned' || s.status === 'cached' ? ` · ${s.status}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <p className="why__links">
        {notebookId ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void navigate({ to: `/n/${notebookId}/flow` })}
          >
            <Icon name="tree" size={13} />
            Open the flow
          </button>
        ) : null}
        <a className="btn btn--ghost btn--sm" href={traceUrl}>
          <Icon name="logs" size={13} />
          Every step in Traces
        </a>
        <span className="mute" data-num>
          {usd(flow.cost_usd, 4)} in all
        </span>
      </p>
    </Section>
  );
}

function Live({
  messageId,
  flow,
  route,
  notebookId,
}: {
  messageId: string;
  flow?: FlowProvenance | undefined;
  route?: AnswerRoute | undefined;
  notebookId: string | null;
}) {
  const q = useExplain(messageId);
  if (q.isPending) return <Skeleton lines={6} label="Gathering why" />;
  if (q.isError || !q.data)
    return (
      <EmptyState
        icon="why"
        title="Why it said this"
        body="This answer's record could not be read. Check that Core is running, then open Why again."
        action={{ label: 'Try again', onClick: () => void q.refetch() }}
      />
    );
  const x = q.data;
  const name = x.model.name ?? modelName(x.model.id);
  const f = x.factcheck;
  return (
    <div className="panel why">
      {flow ? (
        <FlowSection flow={flow} notebookId={notebookId} traceUrl={x.trace_url} chosen={route?.from} />
      ) : route && route.kind === 'model' ? (
        <ModelRouteSection route={route} />
      ) : null}
      <Section title="Model">
        <p>
          {x.model.id ? (
            <>
              Answered by <strong>{name}</strong>
              {x.attempts.length
                ? ` after ${x.attempts.length} ${x.attempts.length === 1 ? 'other model' : 'others'} could not.`
                : '.'}
            </>
          ) : (
            'No model answered.'
          )}
          {x.model.requested && x.model.requested !== x.model.id
            ? ` You asked for ${modelName(x.model.requested)}.`
            : ''}
        </p>
        {x.attempts.length ? (
          <ol className="why__attempts">
            {x.attempts.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attempts are ordered and a model can appear twice
              <li key={`${a.model}-${i}`} title={a.detail}>
                <span className="why__step" data-num>
                  {i + 1}
                </span>
                <span>{modelName(a.model)}</span>
                <span className="mute">{reasonWords(a.reason)}</span>
              </li>
            ))}
            <li data-outcome="answered">
              <span className="why__step" data-num>
                {x.attempts.length + 1}
              </span>
              <span>{name}</span>
              <span className="mute">answered</span>
            </li>
          </ol>
        ) : null}
        {x.error ? (
          <p className="why__error">
            <Icon name="warn" size={13} /> {x.error.title}. {x.error.hint}
          </p>
        ) : null}
      </Section>

      <Section title="Memory it was given">
        {!x.memory || x.memory.files.length === 0 ? (
          <p className="mute">No memory was given to this answer.</p>
        ) : (
          <ul className="why__memory">
            {x.memory.files.map((file) => (
              <li key={file.path}>
                <div className="why__file">
                  <Icon name="memory" size={13} />
                  <Link
                    to="/admin/$section"
                    params={{ section: 'memory' }}
                    search={{ file: file.path } as never}
                  >
                    {file.path}
                  </Link>
                  <span data-num className="mute" title={`Read at commit ${file.commit}`}>
                    {file.commit.slice(0, 7)} · {file.tokens} tok
                  </span>
                </div>
                <MemoryEntries path={file.path} keys={file.entries} dropped={file.dropped} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sources it read">
        <Retrieval x={x} />
      </Section>

      <Section title="Tools and decisions">
        {x.tools.length === 0 ? (
          <p className="mute">No tools were used for this answer.</p>
        ) : (
          <ul className="why__tools">
            {x.tools.map((t) => (
              <li
                key={t.call_id}
                data-ok={t.ok === true || undefined}
                data-declined={t.ok === false || undefined}
              >
                <Icon name={t.ok ? 'check' : t.ok === false ? 'warn' : 'clock'} size={13} />
                <div>
                  <p className="why__tool">
                    <code>{t.tool}</code>
                    {t.decision ? (
                      <span className="mute"> on {shortResource(t.decision.resource)}</span>
                    ) : null}
                  </p>
                  <p className="mute why__decision">
                    {t.decision ? OUTCOME[t.decision.outcome] : 'No decision was recorded'}
                    {t.declined_reason ? `: ${t.declined_reason}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {x.compaction ? (
        <Section title="Earlier turns, compacted">
          <p className="mute">
            Older turns were summarised to make room:{' '}
            <span data-num>{x.compaction.tokens_before.toLocaleString('en-GB')}</span> tokens became{' '}
            <span data-num>{x.compaction.tokens_after.toLocaleString('en-GB')}</span>.
          </p>
        </Section>
      ) : null}

      <Section title="Fact-check">
        {!f ? (
          <p className="mute">
            Not checked yet.{' '}
            <button type="button" className="link-btn" onClick={() => void startFactcheck(x.message_id)}>
              Fact-check this answer
            </button>
          </p>
        ) : f.status === 'done' ? (
          <button
            type="button"
            className="why__fc"
            onClick={() => useUi.getState().showEvidence(x.message_id)}
          >
            {f.sealed ? (
              <Icon name="seal" size={14} className="gilt-ink" />
            ) : (
              <ScoreRing value={f.confidence ?? 0} size={14} />
            )}
            <span>
              {f.confidence !== null ? <strong data-num>{percent(f.confidence)} </strong> : null}
              {f.summary}
            </span>
          </button>
        ) : (
          <p className="mute">
            {f.status === 'running' ? 'Checking now.' : (f.error?.title ?? 'It did not finish.')}
          </p>
        )}
      </Section>

      <div className="why__usage">
        {x.usage ? (
          <>
            <span>
              <span data-num>{x.usage.input_tokens.toLocaleString('en-GB')}</span> in
            </span>
            <span>
              <span data-num>{x.usage.output_tokens.toLocaleString('en-GB')}</span> out
            </span>
            {x.usage.cached_tokens ? (
              <span>
                <span data-num>{x.usage.cached_tokens.toLocaleString('en-GB')}</span> cached
              </span>
            ) : null}
            <span data-num>{usd(x.usage.cost_usd, 4)}</span>
          </>
        ) : (
          <span>No usage was recorded.</span>
        )}
        <a className="btn btn--ghost btn--sm" href={x.trace_url} title={`Trace ${x.trace_id}`}>
          Open the trace
        </a>
      </div>
    </div>
  );
}

/** The entries an answer was given, as words: keys are looked up in the file. */
function MemoryEntries({ path, keys, dropped }: { path: string; keys: string[]; dropped: number }) {
  const file = useMemoryFile(keys.length ? path : null);
  const textOf = new Map((file.data?.entries ?? []).map((e) => [e.key, e.text]));
  return (
    <ul className="why__entries">
      {keys.map((k) => (
        <li key={k} dir="auto" title={k}>
          {textOf.get(k) ?? (file.isPending ? '…' : 'An entry since edited or removed')}
        </li>
      ))}
      {dropped ? (
        <li className="mute">
          {dropped} more {dropped === 1 ? 'entry' : 'entries'} did not fit
        </li>
      ) : null}
    </ul>
  );
}

export function WhyPanel() {
  const demo = useUi((s) => s.demo);
  const params = useParams({ strict: false }) as { threadId?: string };
  const thread = useThread(params.threadId);
  const chosen = useUi((s) => s.whyMessage);
  if (demo) return <WhyDemo />;

  const answers = (thread.data?.messages ?? []).filter((m) => m.role === 'assistant');
  const m = answers.find((a) => a.id === chosen) ?? answers.at(-1);
  if (!m)
    return (
      <EmptyState
        icon="why"
        title="Why it said this"
        body="Ask something, then open this panel to see which model answered, what it read, and what it cost."
      />
    );
  if (m.status === 'streaming' || m.status === 'pending')
    return <EmptyState icon="why" title="Still writing" body="Why fills in once the answer has finished." />;
  return (
    <Live
      key={m.id}
      messageId={m.id}
      flow={m.provenance?.flow}
      route={m.provenance?.route}
      notebookId={thread.data?.notebookId ?? null}
    />
  );
}
