/**
 * ------------------------------------------------------------------
 *  Title    |  Admin → Compute
 *  Ref      |  DESIGN.md §7.3, §13.3 · ROADMAP.md Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Your GPU nodes, what they cost, and the rules that keep
 *           |  them in check. Start or stop a node and watch the four
 *           |  links of its confirmation chain light as the provider
 *           |  answers; a failure shows the provider's own words and
 *           |  the fix.
 *  How      |  Cards per node with its rate, hours and spend this
 *           |  month, what it serves, and when it last answered. A
 *           |  cost band on top: spent, projected and the cap. Rules
 *           |  below (./Rules.tsx). Terminate asks you to type the
 *           |  node's name: it cannot be undone.
 *  Note     |  Sample nodes (no provider connected) say so on every
 *           |  card; everything still works against them.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { type CSSProperties, useMemo, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError } from '../lib/api';
import { relative, usd } from '../lib/format';
import { Ticker } from '../ui/controls';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { EmptyState, Skeleton, StatusDot, Tip } from '../ui/primitives';
import { ConfirmationChain } from './ConfirmationChain';
import { ConnectRunPodDialog, useDisconnectRunPod, useProvider } from './ConnectRunPod';
import {
  ACTION_WORD,
  addNode,
  type ComputeNode,
  type CostSummary,
  chainOf,
  forgetNode,
  nodeAction,
  useComputeStatus,
  useCosts,
  useLiveOps,
  useNodeOperations,
  useNodes,
} from './data';
import { PodSetup } from './PodSetup';
import { Rules } from './Rules';

const STATE_WORD: Record<ComputeNode['observed_state'], string> = {
  creating: 'Being created',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  terminating: 'Terminating',
  terminated: 'Terminated',
  error: 'In error',
  unknown: 'Unknown',
};

const dotFor = (s: ComputeNode['observed_state']) =>
  s === 'running'
    ? 'ok'
    : s === 'error'
      ? 'down'
      : s === 'starting' || s === 'creating' || s === 'stopping'
        ? 'degraded'
        : 'idle';

function idleWords(n: ComputeNode): string {
  if (n.observed_state !== 'running')
    return n.last_activity_at ? `Last answered ${relative(n.last_activity_at)}` : 'No requests yet';
  if (!n.last_activity_at) return 'Running, no requests yet';
  const mins = Math.round((Date.now() - Date.parse(n.last_activity_at)) / 60_000);
  return mins < 2 ? 'Answering now' : `Idle ${mins} min`;
}

/* ---- Cost band --------------------------------------------------------- */

function CostBand({ costs }: { costs: CostSummary }) {
  const cap = costs.cap ?? 0;
  const spent = cap ? Math.min(1, costs.total_to_date / cap) : 0;
  const projected = cap ? Math.min(1, costs.projected_total / cap) : 0;
  const level = projected >= 1 ? 'over' : projected >= 0.8 ? 'warn' : 'ok';
  const month = new Date(`${costs.month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
  return (
    <section className="cost-band m-glass" aria-label="Costs this month" data-level={level}>
      <div className="cost-band__tile">
        <span className="cost-band__label">Spent in {month}</span>
        <Ticker value={costs.total_to_date} format={(v) => usd(v)} className="cost-band__value" />
      </div>
      <div className="cost-band__tile">
        <span className="cost-band__label">Projected by month end</span>
        <Ticker value={costs.projected_total} format={(v) => usd(v)} className="cost-band__value" />
        <span className="cost-band__note">If what is running now keeps running</span>
      </div>
      <div className="cost-band__tile cost-band__tile--cap">
        <span className="cost-band__label">Monthly cap</span>
        <span className="cost-band__value" data-num>
          {cap ? usd(cap, 0) : 'None'}
        </span>
        {cap ? (
          <div
            className="cap-meter"
            role="meter"
            aria-label="Spent against the cap"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(spent * 100)}
            style={{ '--spent': spent, '--projected': projected } as CSSProperties}
          >
            <span className="cap-meter__projected" />
            <span className="cap-meter__spent" />
          </div>
        ) : null}
        <span className="cost-band__note">
          {level === 'over'
            ? 'At this rate the cap is reached this month'
            : level === 'warn'
              ? 'Projected to come close to the cap'
              : `${Math.round(spent * 100)}% used`}
        </span>
      </div>
    </section>
  );
}

/* ---- Node card --------------------------------------------------------- */

function NodeCard({
  node,
  cost,
  sample,
  onTerminate,
}: {
  node: ComputeNode;
  cost: CostSummary['nodes'][number] | undefined;
  sample: boolean;
  onTerminate: (n: ComputeNode) => void;
}) {
  const live = useLiveOps((s) => s.byNode[node.id]);
  const clear = useLiveOps((s) => s.clear);
  const [history, setHistory] = useState(false);
  const ops = useNodeOperations(node.id, history);
  const busy = live && !['confirmed', 'failed', 'timed_out'].includes(live.status);
  const state = node.observed_state;
  const local = node.provider === 'local';
  const canStart = ['stopped', 'error', 'unknown'].includes(state) && !local;
  const canStop = ['running', 'starting'].includes(state) && !local;

  const more: MenuEntry[] = [
    {
      label: 'Restart',
      icon: 'regenerate',
      disabled: busy || state !== 'running' || local,
      onSelect: () => void nodeAction(node, 'restart'),
    },
    {
      label: history ? 'Hide recent actions' : 'Show recent actions',
      icon: 'clock',
      onSelect: () => setHistory((v) => !v),
    },
    { kind: 'separator' },
    { label: 'Remove from NVX Ancile', icon: 'close', disabled: busy, onSelect: () => void forgetNode(node) },
    {
      label: 'Terminate…',
      icon: 'trash',
      danger: true,
      disabled: busy || local || state === 'terminated',
      onSelect: () => onTerminate(node),
    },
  ];

  return (
    <article className="node-card" data-state={state} data-busy={busy || undefined} aria-label={node.name}>
      <header className="node-card__head">
        <span className="node-card__glyph" aria-hidden="true">
          <Icon name="node" size={16} />
        </span>
        <div className="node-card__titles">
          <h3 className="node-card__name">{node.name}</h3>
          <p className="node-card__sub mute">
            {node.gpu_type}
            {node.region ? ` · ${node.region}` : ''}
          </p>
        </div>
        {sample ? (
          <Tip label="A sample node: no GPU, no cost. Connect RunPod or a machine on your network to use a real one.">
            <span className="node-card__sample">Sample</span>
          </Tip>
        ) : local ? (
          <span className="node-card__sample">Your network</span>
        ) : null}
        <span className="node-card__state">
          <StatusDot status={dotFor(state)} label={STATE_WORD[state]} />
          <span>{STATE_WORD[state]}</span>
        </span>
      </header>

      <dl className="node-card__figures">
        <div>
          <dt>Rate</dt>
          <dd data-num>{local ? 'Free' : `${usd(node.hourly_rate)}/h`}</dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd data-num>{cost ? `${cost.hours_this_month.toFixed(1)} h` : '0 h'}</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd data-num>{usd((cost?.compute_cost ?? 0) + (cost?.storage_cost ?? 0))}</dd>
        </div>
        <div>
          <dt>Projected</dt>
          <dd data-num>{usd(cost?.projected_month_cost ?? 0)}</dd>
        </div>
      </dl>

      <div className="node-card__models" role="group" aria-label="Serves">
        {node.served_models.length ? (
          node.served_models.map((m) => (
            <span key={m} className="model-tag" title={`Pick "${m} on ${node.name}" in the model switcher`}>
              {m}
            </span>
          ))
        ) : (
          <span className="mute">No models reported yet</span>
        )}
      </div>

      {live ? (
        <div className="node-card__chain">
          <ConfirmationChain title={`${ACTION_WORD[live.action]} ${node.name}`} {...chainOf(live)} />
          {!busy ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm node-card__dismiss"
              onClick={() => clear(node.id)}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {history ? (
        <ol className="node-card__history">
          {ops.isPending ? (
            <li className="mute">Loading…</li>
          ) : (ops.data ?? []).length === 0 ? (
            <li className="mute">No actions yet.</li>
          ) : (
            (ops.data ?? []).map((o) => (
              <li key={o.id} data-status={o.status}>
                <span>{ACTION_WORD[o.action]}</span>
                <span className="mute">{o.reason?.startsWith('rule:') ? 'by a rule' : 'by you'}</span>
                <span className="node-card__op-status">{o.status.replace('_', ' ')}</span>
                <span className="mute">{relative(o.created_at)}</span>
              </li>
            ))
          )}
        </ol>
      ) : null}

      <footer className="node-card__foot">
        <span className="node-card__activity mute">{idleWords(node)}</span>
        {local ? (
          <Tip label="NVX Ancile can't power a machine on or off. It notices within a minute when you do.">
            <span className="mute node-card__manual">Managed on the machine</span>
          </Tip>
        ) : canStart ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy}
            onClick={() => void nodeAction(node, 'start')}
          >
            <Icon name="play" size={13} />
            Start
          </button>
        ) : canStop ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void nodeAction(node, 'stop')}
          >
            <Icon name="stop" size={13} />
            Stop
          </button>
        ) : null}
        <DropMenu
          items={more}
          trigger={
            <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for ${node.name}`}>
              <Icon name="more" size={15} />
            </button>
          }
        />
      </footer>
    </article>
  );
}

/* ---- Dialogs ----------------------------------------------------------- */

function AddNodeDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  provider: string | null;
}) {
  useLayer(open);
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [models, setModels] = useState('');
  const [storage, setStorage] = useState('');
  const [busy, setBusy] = useState(false);
  const local = provider === 'local';
  const submit = async () => {
    if (!ref.trim() || busy) return;
    setBusy(true);
    const n = await addNode({
      provider_ref: ref.trim(),
      ...(name.trim() && { name: name.trim() }),
      ...(models.trim() && {
        served_models: models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
      }),
      ...(storage.trim() && { storage_rate_month: Number(storage) }),
    });
    setBusy(false);
    if (n) {
      onOpenChange(false);
      setRef('');
      setName('');
      setModels('');
      setStorage('');
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick add-node" aria-describedby="add-node-desc">
          <Dialog.Title className="dialog__title">Add a node</Dialog.Title>
          <p id="add-node-desc" className="dialog__lede">
            {local
              ? 'A machine on your network running Ollama, vLLM or any OpenAI-compatible server.'
              : 'An existing RunPod pod. NVX Ancile reads its GPU, rate and state, and can start and stop it from now on.'}
          </p>
          <form
            className="add-node__form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="field">
              <span>{local ? 'Server address' : 'Pod id'}</span>
              <input
                className="input input--mono"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={local ? 'http://192.168.1.20:11434/v1' : '7h9k2m4n6p'}
                required
                // biome-ignore lint/a11y/noAutofocus: the dialog opens to this one field
                autoFocus
              />
              <span className="field__hint">
                {local
                  ? 'The OpenAI base address, ending in /v1.'
                  : 'From the pod page in the RunPod console.'}
              </span>
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Studio A100"
              />
            </label>
            <label className="field">
              <span>Models it serves</span>
              <input
                className="input"
                value={models}
                onChange={(e) => setModels(e.target.value)}
                placeholder="llama-3.3-70b-instruct, qwen2.5-coder-32b"
              />
              <span className="field__hint">
                Separate with commas. Left empty, NVX Ancile asks the server.
              </span>
            </label>
            {!local ? (
              <label className="field">
                <span>Storage per month (optional)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="0.01"
                  value={storage}
                  onChange={(e) => setStorage(e.target.value)}
                  placeholder="10.00"
                />
                <span className="field__hint">
                  What the pod's volume costs while it exists, so projections include it.
                </span>
              </label>
            ) : null}
            {!local ? <PodSetup /> : null}
            <div className="dialog__actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn--ghost">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn--primary" disabled={!ref.trim() || busy}>
                {busy ? 'Adding…' : 'Add node'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TerminateDialog({ node, onClose }: { node: ComputeNode | null; onClose: () => void }) {
  useLayer(Boolean(node));
  // Keyed on the node by the caller, so the field starts empty each time.
  const [typed, setTyped] = useState('');
  const ok = node && typed.trim() === node.name;
  return (
    <Dialog.Root open={Boolean(node)} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick" aria-describedby="terminate-desc">
          <Dialog.Title className="dialog__title">Terminate {node?.name}?</Dialog.Title>
          <p id="terminate-desc" className="dialog__lede">
            The pod and its disk are deleted at the provider. This cannot be undone. To stop paying for
            compute but keep the disk, stop the node instead.
          </p>
          <label className="field">
            <span>Type the node's name to confirm</span>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={node?.name}
            />
          </label>
          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Keep it
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={!ok}
              onClick={() => {
                if (node) void nodeAction(node, 'terminate');
                onClose();
              }}
            >
              Terminate node
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---- Screen ------------------------------------------------------------ */

export function ComputeScreen() {
  const status = useComputeStatus();
  const nodes = useNodes();
  const costs = useCosts();
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const disconnect = useDisconnectRunPod();
  const provider = useProvider(!!status.data?.reachable);
  const [terminating, setTerminating] = useState<ComputeNode | null>(null);
  const costByNode = useMemo(
    () => new Map((costs.data?.nodes ?? []).map((c) => [c.node_id, c])),
    [costs.data],
  );

  if (status.data && !status.data.configured)
    return (
      <EmptyState
        icon="node"
        title="Remote compute is not set up"
        body="Set CONTROLLER_URL and CONTROLLER_TOKEN in .env and restart NVX Ancile to manage GPU nodes here."
      />
    );
  if (nodes.isError) {
    const e = nodes.error;
    return e instanceof ApiCallError ? (
      <ErrorState error={e.body} onRetry={() => void nodes.refetch()} />
    ) : (
      <EmptyState
        icon="alert"
        title="The Controller did not answer"
        body="It starts with NVX Ancile. Check Admin → Health, then try again."
        action={{ label: 'Try again', onClick: () => void nodes.refetch() }}
      />
    );
  }

  const sample = Boolean(status.data?.sample);
  // Nothing connected (a real install before Connect RunPod): connecting comes first.
  const unconnected = provider.data ? !provider.data.connected && provider.data.kind === 'none' : false;
  const runpod = status.data?.provider === 'runpod' || provider.data?.kind === 'runpod';
  const list = (nodes.data ?? []).filter((n) => n.observed_state !== 'terminated');

  return (
    <div className="compute" data-tour="compute">
      <div className="admin__bar">
        <p className="mute">
          Your GPU nodes, what they cost, and the rules that keep them in check. A model on a stopped node
          wakes it when you ask it something.
        </p>
        <div className="compute__bar-actions">
          {sample || unconnected ? (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setConnecting(true)}>
              <Icon name="link" size={14} />
              Connect RunPod
            </button>
          ) : (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              Add a node
            </button>
          )}
          {runpod ? (
            <DropMenu
              items={[
                {
                  label: 'Disconnect RunPod',
                  icon: 'close',
                  danger: true,
                  onSelect: () => disconnect.mutate(),
                },
              ]}
              trigger={
                <button type="button" className="icon-btn icon-btn--sm" aria-label="More for compute">
                  <Icon name="more" size={15} />
                </button>
              }
            />
          ) : null}
        </div>
      </div>

      {sample ? (
        <p className="compute__sample">
          <Icon name="sparkle" size={14} />
          <span>
            These are sample nodes: they start, stop, answer and cost nothing, so you can try everything.{' '}
            <button type="button" className="link-btn" onClick={() => setConnecting(true)}>
              Connect RunPod
            </button>{' '}
            to manage real ones.
          </span>
        </p>
      ) : null}

      {costs.data ? <CostBand costs={costs.data} /> : <Skeleton lines={2} label="Loading costs" />}

      <section className="compute__section" aria-labelledby="nodes-h">
        <div className="compute__section-head">
          <h3 id="nodes-h" className="admin__h">
            Nodes
          </h3>
        </div>
        {nodes.isPending ? (
          <Skeleton lines={5} label="Loading nodes" />
        ) : list.length === 0 ? (
          unconnected ? (
            <EmptyState
              icon="node"
              title="No GPU provider connected"
              body="Connect RunPod with an API key, then add a pod or create one. GPU time is billed by RunPod, to you."
              action={{ label: 'Connect RunPod', onClick: () => setConnecting(true) }}
            />
          ) : (
            <EmptyState
              icon="node"
              title="No nodes yet"
              body="Add a RunPod pod or a machine on your network. Its models then appear in the model switcher."
              action={{ label: 'Add a node', onClick: () => setAdding(true) }}
            />
          )
        ) : (
          <div className="node-grid">
            {list.map((n) => (
              <NodeCard
                key={n.id}
                node={n}
                cost={costByNode.get(n.id)}
                sample={n.provider === 'fake'}
                onTerminate={setTerminating}
              />
            ))}
          </div>
        )}
      </section>

      <Rules />

      <AddNodeDialog open={adding} onOpenChange={setAdding} provider={status.data?.provider ?? null} />
      <ConnectRunPodDialog open={connecting} onOpenChange={setConnecting} />
      <TerminateDialog
        key={terminating?.id ?? 'none'}
        node={terminating}
        onClose={() => setTerminating(null)}
      />
    </div>
  );
}
