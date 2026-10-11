/**
 * ------------------------------------------------------------------
 *  Title    |  Admin sections backed by Core
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The admin views that have real data in Phase 2: health
 *           |  from the supervisor, remembered grants (with revoke),
 *           |  the decision log, models and their readiness, and the
 *           |  fallback chains routing resolves to right now.
 *  How      |  Plain React Query reads; writes invalidate what they
 *           |  change. sections.tsx shows these when Core is running
 *           |  and the sample versions in demo mode.
 * ------------------------------------------------------------------
 */

import type { Decision, Grant } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PresetPicker } from '../../approvals/preset';
import { ApiCallError, api } from '../../lib/api';
import { keys, useModels, useSystemHealth } from '../../lib/data';
import { relative } from '../../lib/format';
import { shortResource } from '../../lib/mappers';
import { queryClient } from '../../lib/query';
import { startCoreHint } from '../../lib/runtime';
import { AddModelDialog, useAddModel } from '../../models/AddModel';
import { notify } from '../../state/notify';
import { ErrorState } from '../../ui/ErrorState';
import { Icon } from '../../ui/Icon';
import { EmptyState, Skeleton, StatusDot } from '../../ui/primitives';

const SERVICE_LABEL: Record<string, string> = {
  postgres: 'Database',
  knowledge: 'Knowledge',
  notebook: 'Notebook engine',
  agent: 'The lab',
  controller: 'Controller',
  disk: 'Disk space',
};

/** A read that failed says so, with a retry, rather than passing for an empty list. */
function LoadFailed({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => void }) {
  if (error instanceof ApiCallError) return <ErrorState error={error.body} onRetry={onRetry} />;
  return (
    <EmptyState
      icon="alert"
      title={`${what} could not be loaded`}
      body="Core did not answer. Check that NVX Ancile is running, then try again."
      action={{ label: 'Try again', onClick: onRetry }}
    />
  );
}

function failed(error: unknown, what: string) {
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} failed`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Check that NVX Ancile is running, then try again.',
  });
}

export function LiveHealth() {
  const health = useSystemHealth();
  const check = useMutation({
    mutationFn: () => api.get('/system/health?fresh=1'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['system-health'] }),
    onError: (e) => failed(e, 'The check'),
  });
  if (health.isPending) return <Skeleton lines={5} label="Loading health" />;
  if (health.isError && !health.data)
    return <LoadFailed error={health.error} what="Health" onRetry={() => void health.refetch()} />;
  const services = health.data?.services ?? [];
  return (
    <>
      <div className="admin__bar">
        <p className="mute">
          Checked every 15 seconds. A service that fails three checks in a row restarts on its own when a
          restart adapter is set.
        </p>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => check.mutate()}
          disabled={check.isPending}
        >
          {check.isPending ? 'Checking' : 'Check now'}
        </button>
      </div>
      {services.length === 0 ? (
        <EmptyState
          icon="pulse"
          title={health.data?.summary ?? 'No health data yet'}
          body={`${startCoreHint()} Then check again.`}
        />
      ) : (
        <ul className="rows">
          {services.map((s) => (
            <li key={s.service} className="row row--health" data-status={s.status}>
              <StatusDot
                status={s.status === 'ok' ? 'ok' : s.status === 'down' ? 'down' : 'degraded'}
                label={s.status}
              />
              <span className="row__title">{SERVICE_LABEL[s.service] ?? s.service}</span>
              <span className="row__meta">
                {s.last_error ?? (s.status === 'ok' ? 'Answering normally' : '')}
              </span>
              <span className="mute row__num">{s.needs_attention ? 'Needs attention' : ''}</span>
              <span />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const SCOPE_WORDS: Record<Grant['scope'], string> = {
  thread: 'In one thread',
  notebook: 'In one notebook',
  workspace: 'In your workspace',
  always: 'Everywhere',
};

export function LiveGrants() {
  const grants = useQuery({
    queryKey: ['grants'],
    queryFn: () => api.get<{ items: Grant[] }>('/grants').then((r) => r.items),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/grants/${id}`),
    onSuccess: () => {
      notify({ level: 'success', title: 'Revoked', body: 'The agent will ask again next time.' });
      return queryClient.invalidateQueries({ queryKey: ['grants'] });
    },
    onError: (e) => failed(e, 'Revoking'),
  });
  if (grants.isPending) return <Skeleton lines={4} label="Loading grants" />;
  if (grants.isError && !grants.data)
    return (
      <LoadFailed error={grants.error} what="Remembered permissions" onRetry={() => void grants.refetch()} />
    );
  const items = grants.data ?? [];
  if (items.length === 0)
    return (
      <>
        <PresetPicker />
        <EmptyState
          icon="shield"
          title="Nothing remembered yet"
          body="When you approve an action and choose to remember it, it appears here with a revoke button."
        />
      </>
    );
  return (
    <>
      <PresetPicker />
      <p className="mute admin__lede">
        What the agent may do without asking, because you said so. Revoke any of it.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Pattern</th>
            <th>Where</th>
            <th>Used</th>
            <th>Expires</th>
            <th>
              <span className="sr-only">Revoke</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((g) => (
            <tr key={g.id}>
              <td data-num>
                {g.effect === 'deny' ? 'Never ' : ''}
                {g.action_pattern}
              </td>
              <td data-num className="table__mono">
                {g.resource_pattern}
              </td>
              <td>{SCOPE_WORDS[g.scope]}</td>
              <td>
                <span data-num>{g.uses}</span>
                {g.last_used_at ? <span className="mute"> · {relative(g.last_used_at)}</span> : null}
              </td>
              <td>{g.expires_at ? relative(g.expires_at).replace(' ago', '') : 'Never'}</td>
              <td>
                <button
                  type="button"
                  className="link-btn link-btn--danger"
                  onClick={() => revoke.mutate(g.id)}
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${g.action_pattern} on ${g.resource_pattern}`}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const OUTCOME_WORDS: Record<Decision['outcome'], string> = {
  auto: 'Allowed (no need to ask)',
  grant: 'Allowed (remembered)',
  approved: 'You approved',
  denied: 'Declined',
  policy_deny: 'Blocked by a policy',
  expired: 'Nobody answered',
};

export function LiveDecisions() {
  const decisions = useQuery({
    queryKey: ['decisions'],
    queryFn: () => api.get<{ items: Decision[] }>('/decisions?limit=200').then((r) => r.items),
  });
  if (decisions.isPending) return <Skeleton lines={6} label="Loading decisions" />;
  if (decisions.isError && !decisions.data)
    return (
      <LoadFailed error={decisions.error} what="The decision log" onRetry={() => void decisions.refetch()} />
    );
  const items = decisions.data ?? [];
  if (items.length === 0)
    return (
      <EmptyState
        icon="check"
        title="No decisions yet"
        body="Every tool call the agent makes is recorded here: what, on what, and who allowed it."
      />
    );
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Action</th>
          <th>On</th>
          <th>Outcome</th>
          <th>Tier</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id} data-outcome={d.outcome}>
            <td className="mute">{relative(d.at)}</td>
            <td data-num>{d.action}</td>
            <td data-num className="table__mono">
              {shortResource(d.resource)}
            </td>
            <td>{d.policy_id ? `${OUTCOME_WORDS[d.outcome]} (${d.policy_id})` : OUTCOME_WORDS[d.outcome]}</td>
            <td>{d.tier}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const STATUS_WORDS = { ready: 'Ready', needs_key: 'Needs its key', disabled: 'Off' } as const;

export function LiveModels() {
  const models = useModels();
  const toggle = useMutation({
    mutationFn: (m: { id: string; enabled: boolean }) => api.put(`/models/${m.id}`, { enabled: m.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.models }),
    onError: (e) => failed(e, 'Changing the model'),
  });
  const remove = useMutation({
    mutationFn: (m: { id: string; name: string }) => api.del(`/models/${m.id}`).then(() => m),
    onSuccess: (m) => {
      void queryClient.invalidateQueries({ queryKey: keys.models });
      notify({ level: 'info', title: `Removed ${m.name}` });
    },
    onError: (e) => failed(e, 'Removing the model'),
  });
  const showAdd = useAddModel((s) => s.show);
  if (models.isPending) return <Skeleton lines={6} label="Loading models" />;
  if (models.isError && !models.data)
    return <LoadFailed error={models.error} what="Models" onRetry={() => void models.refetch()} />;
  return (
    <>
      <div className="admin__bar">
        <p className="mute admin__lede">
          Models from config/models.yaml, your GPU nodes, and any you add: OpenRouter, your own server, or a
          provider's model id. A model with no key is skipped by routing, never tried and failed.
        </p>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => showAdd()}>
          <Icon name="plus" size={14} />
          Add a model
        </button>
      </div>
      <AddModelDialog />
      <ul className="rows">
        {(models.data ?? []).map((m) => (
          <li
            key={m.id}
            className="row row--health row--model"
            data-status={m.status === 'ready' ? 'ok' : 'idle'}
          >
            <StatusDot
              status={m.status === 'ready' ? 'ok' : 'idle'}
              label={STATUS_WORDS[m.status ?? 'ready']}
            />
            <span className="row__title">
              <span className="row__name" title={m.name}>
                {m.name}
              </span>
              {m.custom ? <span className="tag model-added">Added</span> : null}
            </span>
            <span className="row__meta">
              {m.provider} · {STATUS_WORDS[m.status ?? 'ready']}
              {m.note && m.status !== 'needs_key' ? ` · ${m.note}` : ''}
            </span>
            <span data-num className="mute row__num">
              {m.contextWindow.toLocaleString('en-GB')} tok
            </span>
            {m.offline ? (
              <span />
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => toggle.mutate({ id: m.id, enabled: m.status === 'disabled' })}
                disabled={toggle.isPending}
              >
                {m.status === 'disabled' ? 'Turn on' : 'Turn off'}
              </button>
            )}
            {m.custom ? (
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Remove ${m.name}`}
                title="Remove this model"
                onClick={() => remove.mutate({ id: m.id, name: m.name })}
                disabled={remove.isPending}
              >
                <Icon name="trash" size={13} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

export function LiveRouting() {
  const routing = useQuery({
    queryKey: ['routing'],
    queryFn: () =>
      api
        .get<{ items: { task_class: string; chain: string[]; ok: boolean }[] }>('/routing')
        .then((r) => r.items),
  });
  const models = useModels().data ?? [];
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  if (routing.isPending) return <Skeleton lines={3} label="Loading routing" />;
  if (routing.isError && !routing.data)
    return <LoadFailed error={routing.error} what="Routing" onRetry={() => void routing.refetch()} />;
  return (
    <>
      <p className="mute admin__lede">
        Who answers each kind of task, in order, counting only models that can answer now. Edit
        config/routing.yaml to change the chains.
      </p>
      <ul className="rows">
        {(routing.data ?? []).map((r) => (
          <li key={r.task_class} className="row" data-status={r.ok ? 'ok' : 'down'}>
            <span className="row__title" data-num>
              {r.task_class}
            </span>
            <span className="row__meta">
              {r.ok ? r.chain.map(name).join(' → ') : 'No model can answer this yet'}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
