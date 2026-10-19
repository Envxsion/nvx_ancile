/**
 * ------------------------------------------------------------------
 *  Title    |  Admin sections backed by Core
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The admin views that have real data in Phase 2: health
 *           |  from the supervisor, saved permissions (with revoke,
 *           |  and expired ones marked and filterable),
 *           |  the decision log, and models and their readiness. The
 *           |  routing chain editor is RoutingEditor.tsx.
 *  How      |  Plain React Query reads; writes invalidate what they
 *           |  change. sections.tsx shows these when Core is running
 *           |  and the sample versions in demo mode.
 * ------------------------------------------------------------------
 */

import type { Decision, Grant } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { GRANT_SCOPE_WORDS, GrantMenu } from '../../approvals/GrantMenu';
import { expiryWords, filterGrants, type GrantFilter, isExpired } from '../../approvals/grantState';
import { PresetPicker } from '../../approvals/preset';
import { ApiCallError, api } from '../../lib/api';
import { useModels, useSystemHealth } from '../../lib/data';
import { relative } from '../../lib/format';
import { shortResource } from '../../lib/mappers';
import { queryClient } from '../../lib/query';
import { AddModelDialog, useAddModel } from '../../models/AddModel';
import { LoadedNow } from '../../models/LoadedNow';
import { LocalModelsDialog, useLocalModelsDialog } from '../../models/LocalModels';
import { MoreModelsDialog, moreModels } from '../../models/MoreModels';
import { AdvisorButton } from '../../openrouter/ModelAdvisor';
import { notify } from '../../state/notify';
import { Segmented } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
// A read that failed says so, with a retry, rather than passing for an empty list.
import { LoadFailed } from '../../ui/LoadFailed';
import { EmptyState, Skeleton, StatusDot } from '../../ui/primitives';
import { ModelUpdates } from './ModelUpdates';
import { ModelBlocksView } from './modelBlocks';

const SERVICE_LABEL: Record<string, string> = {
  postgres: 'Database',
  knowledge: 'Knowledge',
  notebook: 'Notebook engine',
  agent: 'The lab',
  controller: 'Controller',
  disk: 'Disk space',
};

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
          body="Start NVX Ancile with pnpm start, then check again."
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

const GRANT_FILTERS: { value: GrantFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
];

export function LiveGrants() {
  const grants = useQuery({
    queryKey: ['grants'],
    queryFn: () => api.get<{ items: Grant[] }>('/grants').then((r) => r.items),
  });
  const [filter, setFilter] = useState<GrantFilter>('all');
  if (grants.isPending) return <Skeleton lines={4} label="Loading permissions" />;
  if (grants.isError && !grants.data)
    return <LoadFailed error={grants.error} what="Saved permissions" onRetry={() => void grants.refetch()} />;
  const items = grants.data ?? [];
  if (items.length === 0)
    return (
      <>
        <PresetPicker />
        <EmptyState
          icon="shield"
          title="No saved permissions yet"
          body="When you approve an action and choose to remember it, it appears here, ready to narrow or revoke."
        />
      </>
    );
  const now = Date.now();
  const expired = items.filter((g) => isExpired(g, now)).length;
  const shown = filterGrants(items, filter, now);
  return (
    <>
      <PresetPicker />
      <div className="grants__bar">
        <p className="mute admin__lede">
          What the agent may do without asking, because you said so. Narrow or revoke any of it from its menu.
          An expired one no longer counts.
        </p>
        <Segmented
          label="Show"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={GRANT_FILTERS.map((f) => ({
            value: f.value,
            label:
              f.value === 'expired'
                ? `Expired ${expired}`
                : f.value === 'active'
                  ? `Active ${items.length - expired}`
                  : `All ${items.length}`,
          }))}
        />
      </div>
      {shown.length === 0 ? (
        <p className="mute grants__none">
          {filter === 'expired' ? 'Nothing has expired.' : 'Every saved permission has expired.'}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Pattern</th>
              <th>Where</th>
              <th>Used</th>
              <th>Expires</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => {
              const gone = isExpired(g, now);
              return (
                <tr key={g.id} data-expired={gone || undefined}>
                  <td data-num>
                    {g.effect === 'deny' ? 'Never ' : ''}
                    {g.action_pattern}
                  </td>
                  <td data-num className="table__mono">
                    {g.resource_pattern}
                  </td>
                  <td>{GRANT_SCOPE_WORDS[g.scope]}</td>
                  <td>
                    <span data-num>{g.uses}</span>
                    {g.last_used_at ? <span className="mute"> · {relative(g.last_used_at)}</span> : null}
                  </td>
                  <td>
                    {gone ? (
                      <span className="grant-expired">
                        <Icon name="clock" size={11} />
                        Expired
                      </span>
                    ) : null}{' '}
                    <span className={gone ? 'mute' : undefined}>{expiryWords(g, now)}</span>
                  </td>
                  <td>
                    <GrantMenu grant={g} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

const OUTCOME_WORDS: Record<Decision['outcome'], string> = {
  auto: 'Allowed (no need to ask)',
  grant: 'Allowed (a saved permission)',
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

export function LiveModels() {
  const models = useModels({ all: true });
  const showAdd = useAddModel((s) => s.show);
  const showLocal = useLocalModelsDialog((s) => s.show);
  const [moreOpen, setMoreOpen] = useState(false);
  if (models.isPending) return <Skeleton lines={6} label="Loading models" />;
  if (models.isError && !models.data)
    return <LoadFailed error={models.error} what="Models" onRetry={() => void models.refetch()} />;
  // Only what is real: a provider shows once its key is saved, an Ollama model once pulled.
  const shown = (models.data ?? []).filter((m) => !m.unlisted);
  const waiting = (models.data ?? []).length - shown.length;
  return (
    <>
      <div className="admin__bar">
        <p className="mute admin__lede">
          Models you can use, grouped by who pays: your Claude plan, each provider's API key, and your own
          computer and GPU nodes.
          {waiting > 0 ? ' Add a key in Settings → API keys to see that provider’s models.' : ''} Each
          provider starts with its fast, balanced and best models.
        </p>
        <div className="admin__bar-actions">
          <AdvisorButton />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => showLocal()}>
            <Icon name="download" size={14} />
            Download a local model
          </button>
          {moreModels(models.data ?? []).length > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMoreOpen(true)}>
              <Icon name="plus" size={14} />
              Add more models
            </button>
          ) : null}
          <button type="button" className="btn btn--primary btn--sm" onClick={() => showAdd()}>
            <Icon name="plus" size={14} />
            Add a model
          </button>
        </div>
      </div>
      <AddModelDialog />
      <MoreModelsDialog models={models.data ?? []} open={moreOpen} onOpenChange={setMoreOpen} />
      <LocalModelsDialog />
      <LoadedNow />
      <ModelUpdates />
      <ModelBlocksView models={shown} />
    </>
  );
}
