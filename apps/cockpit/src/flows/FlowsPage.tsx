/**
 * ------------------------------------------------------------------
 *  Title    |  Flows: the list, and a notebook's flow
 *  Ref      |  DESIGN.md §16.3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where every flow lives: the workspace default that
 *           |  answers everywhere, each notebook's own, the team
 *           |  blocks you reuse, and the starting shapes. A notebook's
 *           |  Flow tab opens its flow straight in the editor, or offers
 *           |  to make one.
 *  How      |  Precedence is shown in words: a thread's flow beats its
 *           |  notebook's, which beats the workspace default; with none
 *           |  at all, answers come from the model you pick.
 * ------------------------------------------------------------------
 */

import type { Flow, FlowSummary } from '@nvx/contracts';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type CSSProperties, useState } from 'react';
import { Term } from '../help/Term';
import { useNotebooks } from '../lib/data';
import { hueVar, relative } from '../lib/format';
import type { Hue } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';
import { EmptyState, Skeleton } from '../ui/primitives';
import { activateFlow, deleteFlow, needsCore, useFlow, useFlows } from './api';
import { FlowEditor } from './FlowEditor';
import { NewFlowDialog } from './NewFlow';
import { FlowPreview } from './Preview';
import { LOCAL_TEMPLATES } from './templates';
import '../styles/flows.css';

function FlowCard({ f, sub, onOpen }: { f: FlowSummary; sub?: string; onOpen: () => void }) {
  const full = useFlow(f.id);
  return (
    <div className="fcard" data-active={f.active || undefined}>
      <button type="button" className="fcard__open" onClick={onOpen} aria-label={`Open ${f.name}`}>
        <div className="fcard__preview">
          {full.data ? <FlowPreview graph={full.data} height={96} /> : <Skeleton lines={2} />}
        </div>
        <span className="fcard__name">
          {f.name.replace(/^Block:\s*/, '')}
          {f.active ? (
            <span className="fcard__live" title="Answers use this flow">
              <Icon name="seal" size={11} /> In use
            </span>
          ) : null}
        </span>
        <span className="fcard__meta">
          {sub ? `${sub} · ` : ''}
          {f.nodes} nodes · v{f.version} · {relative(f.updated_at)}
        </span>
        {f.models.length ? (
          <span className="fcard__models">
            {f.models
              .slice(0, 4)
              .map((m) => m.split('/').pop())
              .join(' · ')}
          </span>
        ) : null}
      </button>
      <DropMenu
        items={[
          { label: 'Open', icon: 'edit', onSelect: onOpen },
          ...(!f.active && !f.name.startsWith('Block:')
            ? [
                {
                  label: 'Use this flow',
                  icon: 'seal' as const,
                  onSelect: () =>
                    void activateFlow(f.id).then(
                      () => notify({ level: 'success', title: `${f.name} now answers here` }),
                      (err) =>
                        notify({ level: 'error', title: 'Not switched', body: (err as Error).message }),
                    ),
                },
              ]
            : []),
          { kind: 'separator' as const },
          {
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onSelect: () =>
              void deleteFlow(f.id).then(
                () => notify({ level: 'info', title: `Deleted ${f.name}` }),
                (err) => notify({ level: 'error', title: 'Not deleted', body: (err as Error).message }),
              ),
          },
        ]}
        trigger={
          <button
            type="button"
            className="icon-btn icon-btn--sm fcard__more"
            aria-label={`More for ${f.name}`}
          >
            <Icon name="more" size={14} />
          </button>
        }
      />
    </div>
  );
}

export function FlowsScreen() {
  const flows = useFlows();
  const notebooks = useNotebooks();
  const navigate = useNavigate();
  const [creating, setCreating] = useState<{
    scope: Flow['scope'];
    ref: string | null;
    name: string;
    activate: boolean;
  } | null>(null);
  const open = (id: string) => void navigate({ to: '/flows/$flowId', params: { flowId: id } });
  const missing = flows.isError && needsCore(flows.error);
  const list = flows.data ?? [];
  const workspace = list.filter((f) => f.scope === 'workspace' && !f.name.startsWith('Block:'));
  const blocks = list.filter((f) => f.name.startsWith('Block:'));
  const byNotebook = list.filter((f) => f.scope === 'notebook');
  const nbName = (id: string | null) => notebooks.data?.find((n) => n.id === id)?.title ?? 'A notebook';

  return (
    <div className="page fflows" data-scrollable>
      <div className="page__measure fflows__measure">
        <header className="fflows__head">
          <div>
            <h1 className="page__title" data-display>
              Flows
            </h1>
            <p className="fflows__lede">
              How your messages are answered, drawn as a graph: which models, in what order, what each one
              sees. A thread’s flow beats its notebook’s, which beats the workspace default. With no flow,
              answers come from the model you pick.
            </p>
          </div>
          <button
            type="button"
            disabled={missing}
            className="btn btn--primary"
            onClick={() =>
              setCreating({
                scope: 'workspace',
                ref: null,
                name: 'My flow',
                activate: workspace.length === 0,
              })
            }
          >
            <Icon name="plus" size={14} /> New flow
          </button>
        </header>

        {missing ? (
          <EmptyState
            icon="branch"
            title="Flows need a newer Core"
            body="This Core cannot store or run flows yet. The starting shapes below show what you will be able to build."
          />
        ) : flows.isPending ? (
          <Skeleton lines={5} label="Loading flows" />
        ) : null}

        {!missing ? (
          <>
            <section className="page__section">
              <div className="page__section-head">
                <h2>Everywhere</h2>
              </div>
              {workspace.length ? (
                <div className="fflows__grid">
                  {workspace.map((f) => (
                    <FlowCard key={f.id} f={f} onOpen={() => open(f.id)} />
                  ))}
                </div>
              ) : (
                <p className="mute">No workspace flow. Answers use the model you pick, as in a plain chat.</p>
              )}
            </section>
            <section className="page__section">
              <div className="page__section-head">
                <h2>Notebooks</h2>
              </div>
              {byNotebook.length ? (
                <div className="fflows__grid">
                  {byNotebook.map((f) => (
                    <FlowCard key={f.id} f={f} sub={nbName(f.scope_ref)} onOpen={() => open(f.id)} />
                  ))}
                </div>
              ) : (
                <p className="mute">
                  No notebook has its own flow yet. Open a notebook and choose Flow to give it one.
                </p>
              )}
            </section>
            {blocks.length ? (
              <section className="page__section">
                <div className="page__section-head">
                  <h2>Team blocks</h2>
                </div>
                <div className="fflows__grid">
                  {blocks.map((f) => (
                    <FlowCard key={f.id} f={f} onOpen={() => open(f.id)} />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        <section className="page__section">
          <div className="page__section-head">
            <h2>Starting shapes</h2>
          </div>
          <div className="fflows__grid">
            {LOCAL_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className="fcard fcard--template"
                disabled={missing}
                onClick={() => setCreating({ scope: 'workspace', ref: null, name: t.name, activate: false })}
              >
                <div className="fcard__preview">
                  <FlowPreview graph={t.graph} height={96} />
                </div>
                <span className="fcard__name">{t.name}</span>
                <span className="fcard__meta">{t.description}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {creating ? (
        <NewFlowDialog
          open
          onOpenChange={(o) => !o && setCreating(null)}
          scope={creating.scope}
          scopeRef={creating.ref}
          defaultName={creating.name}
          activate={creating.activate}
          onCreated={(f) => open(f.id)}
        />
      ) : null}
    </div>
  );
}

export function FlowEditorScreen() {
  const { flowId } = useParams({ strict: false }) as { flowId?: string };
  const flow = useFlow(flowId);
  const back =
    flow.data?.scope === 'notebook' && flow.data.scope_ref
      ? { to: '/n/$notebookId', label: 'the notebook', params: { notebookId: flow.data.scope_ref } }
      : { to: '/flows', label: 'flows' };
  if (!flowId) return null;
  return <FlowEditor flowId={flowId} back={back} />;
}

/** A notebook's Flow tab: its own flow in the editor, or an offer to make one. */
export function NotebookFlowScreen() {
  const { notebookId } = useParams({ strict: false }) as { notebookId?: string };
  const flows = useFlows('notebook', notebookId);
  const notebooks = useNotebooks();
  const nb = notebooks.data?.find((n) => n.id === notebookId);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  if (!notebookId) return null;
  const own = (flows.data ?? []).filter((f) => f.scope_ref === notebookId);
  const active = own.find((f) => f.active) ?? own[0];
  if (flows.isPending)
    return (
      <div className="page">
        <Skeleton lines={6} label="Loading the notebook's flow" />
      </div>
    );
  if (active)
    return (
      <FlowEditor
        flowId={active.id}
        back={{ to: '/n/$notebookId', label: nb?.title ?? 'the notebook', params: { notebookId } }}
      />
    );
  const missing = flows.isError && needsCore(flows.error);
  return (
    <div
      className="page page--center"
      style={{ '--hue': hueVar((nb?.color as Hue) ?? 'azure') } as CSSProperties}
    >
      <div className="fnb-empty">
        <EmptyState
          icon="branch"
          title={
            missing ? 'Flows need a newer Core' : `${nb?.title ?? 'This notebook'} has no flow of its own`
          }
          body={
            missing ? (
              'This Core cannot store or run flows yet.'
            ) : (
              <>
                Its answers use the workspace <Term id="flow">flow</Term>, or the model you pick. Give it its
                own: route code to one model and writing to another, put a <Term id="manager">manager</Term>{' '}
                over a team, or fact-check every answer.
              </>
            )
          }
          {...(!missing && { action: { label: 'Give it a flow', onClick: () => setCreating(true) } })}
          secondary={
            <Link to="/flows" className="fp-link">
              See every flow
            </Link>
          }
        />
      </div>
      {creating ? (
        <NewFlowDialog
          open
          onOpenChange={setCreating}
          scope="notebook"
          scopeRef={notebookId}
          defaultName={`${nb?.title ?? 'Notebook'} flow`}
          activate
          onCreated={() =>
            void flows.refetch().then(() => navigate({ to: '/n/$notebookId/flow', params: { notebookId } }))
          }
        />
      ) : null}
    </div>
  );
}
