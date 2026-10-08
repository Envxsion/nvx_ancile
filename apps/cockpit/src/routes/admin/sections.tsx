/**
 * ------------------------------------------------------------------
 *  Title    |  Admin sections
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every admin view the design calls for. Health, grants,
 *           |  decisions, models and routing read Core (live.tsx).
 *           |  The rest show the sample workspace in demo mode, and an
 *           |  empty state saying what will live there, and when,
 *           |  when Core is running: sample data never passes for yours.
 *  Note     |  The section list is data so the boot test can check
 *           |  every route resolves to a screen.
 * ------------------------------------------------------------------
 */

import { useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { ComputeScreen } from '../../compute/ComputeScreen';
import { ConfirmationChain } from '../../compute/ConfirmationChain';
import * as demo from '../../fixtures/demo';
import { usd } from '../../lib/format';
import { MemoryScreen } from '../../memory/MemoryScreen';
import { AutomationsScreen } from '../../ops/AutomationsScreen';
import { DiagnosticsScreen } from '../../ops/DiagnosticsScreen';
import { HealthScreen } from '../../ops/HealthScreen';
import { LicenceScreen } from '../../ops/LicenceScreen';
import { LogsScreen } from '../../ops/LogsScreen';
import { PluginsScreen } from '../../ops/PluginsScreen';
import { TracesScreen } from '../../ops/TracesScreen';
import { PRO_SURFACES, ProSurfaceView } from '../../pro/slot';
import { useUi } from '../../state/ui';
import { Icon, type IconName } from '../../ui/Icon';
import { EmptyState, StatusDot } from '../../ui/primitives';
import { LiveDecisions, LiveGrants, LiveModels, LiveRouting } from './live';

export interface AdminSection {
  id: string;
  label: string;
  icon: IconName;
  group: 'System' | 'Trust' | 'Models' | 'Extend';
  render: () => ReactNode;
}

/** Sample screens show what a control will do; they never pretend to do it. */
const SAMPLE = 'Sample data: start NVX Ancile to use this';

/** The sample version in demo mode, the real (or not-yet) version otherwise. */
const demoOr = (sample: () => ReactNode, real: () => ReactNode) =>
  function DemoOr() {
    const demo = useUi((s) => s.demo);
    return <>{demo ? sample() : real()}</>;
  };

function Health() {
  return (
    <>
      <div className="admin__bar">
        <p className="mute">
          Checked every 15 seconds. A service that fails three checks in a row restarts on its own when a
          restart adapter is set.
        </p>
        <button type="button" className="btn btn--primary btn--sm" title={SAMPLE} disabled>
          <Icon name="pulse" size={14} />
          Run diagnostics
        </button>
      </div>
      <ul className="rows">
        {demo.health.map((h) => (
          <li key={h.service} className="row row--health" data-status={h.status}>
            <StatusDot status={h.status} label={h.status} />
            <span className="row__title">{h.service}</span>
            <span className="row__meta">{h.detail}</span>
            <span data-num className="mute row__num">
              {h.latencyMs === null ? 'n/a' : `${h.latencyMs} ms`}
            </span>
            {h.status !== 'ok' ? (
              <button type="button" className="btn btn--ghost btn--sm" title={SAMPLE} disabled>
                Restart
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Compute() {
  const total = demo.nodes.reduce((sum, n) => sum + n.rate * n.hours + n.storage, 0);
  return (
    <>
      <div className="stat-line">
        <span>
          <span className="stat-line__value" data-num>
            {usd(total)}
          </span>
          <span className="mute">spent this month</span>
        </span>
        <span>
          <span className="stat-line__value" data-num>
            {usd(total * 2.1)}
          </span>
          <span className="mute">projected by the 31st</span>
        </span>
        <span>
          <span className="stat-line__value" data-num>
            $150.00
          </span>
          <span className="mute">monthly cap</span>
        </span>
      </div>
      <ul className="rows">
        {demo.nodes.map((n) => (
          <li key={n.id} className="row row--node" data-status={n.state}>
            <StatusDot status={n.state === 'running' ? 'ok' : 'idle'} label={n.state} />
            <span className="row__title">{n.name}</span>
            <span className="row__meta">
              {n.gpu} · {n.model}
            </span>
            <span data-num className="mute row__num">
              {usd(n.rate)}/h · {n.hours} h · {usd(n.storage)} storage
            </span>
            <button type="button" className="btn btn--ghost btn--sm" title={SAMPLE} disabled>
              {n.state === 'running' ? 'Stop' : 'Start'}
            </button>
          </li>
        ))}
      </ul>
      <h3 className="admin__h">Recent actions</h3>
      <div className="chains">
        {demo.operations.map((o) => (
          <ConfirmationChain
            key={o.id}
            title={o.title}
            reached={o.reached}
            failed={o.failed}
            timeline={o.timeline}
            detail={o.detail}
            suggestion={o.suggestion}
          />
        ))}
      </div>
    </>
  );
}

function Grants() {
  return (
    <>
      <p className="mute admin__lede">
        What the AI may do without asking, and why. Revoking takes effect on its next action.
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
          {demo.grants.map((g) => (
            <tr key={g.id}>
              <td data-num>{g.action}</td>
              <td data-num className="table__mono">
                {g.pattern}
              </td>
              <td>{g.scope}</td>
              <td>
                <span data-num>{g.uses}</span> <span className="mute">· {g.lastUsed}</span>
              </td>
              <td>{g.expires}</td>
              <td>
                <button type="button" className="link-btn link-btn--danger" title={SAMPLE} disabled>
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

function Memory() {
  return (
    <>
      <p className="mute admin__lede">
        Plain markdown in a git repository. Every change NVX Ancile makes is a commit you can read and revert.
      </p>
      <ul className="rows">
        {demo.memoryFiles.map((f) => (
          <li key={f.path} className="row row--link">
            <Icon name="memory" size={14} />
            <span className="row__title" data-num>
              {f.path}
            </span>
            <span className="row__meta">
              <span data-num>{f.entries}</span> entries
            </span>
            <span className="mute">
              {f.by} · {f.updated}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function Logs() {
  const [levels, setLevels] = useState<ReadonlySet<string>>(() => new Set(['info', 'warn', 'error']));
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const rows = demo.logs.filter(
    (l) =>
      levels.has(l.level) &&
      (!needle || `${l.trace} ${l.service}/${l.component} ${l.msg}`.toLowerCase().includes(needle)),
  );
  const flip = (l: string) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (!next.delete(l)) next.add(l);
      return next;
    });
  return (
    <>
      <div className="filters" role="group" aria-label="Filter logs">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className="filter"
            data-level={l}
            aria-pressed={levels.has(l)}
            onClick={() => flip(l)}
          >
            {l}
          </button>
        ))}
        <input
          className="input input--sm"
          placeholder="Trace id, component or text"
          aria-label="Search logs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="btn btn--ghost btn--sm" title={SAMPLE} disabled>
          Export
        </button>
      </div>
      {rows.length === 0 ? <p className="mute admin__lede">No lines match these filters.</p> : null}
      <ol className="logs" data-scrollable>
        {rows.map((l) => (
          <li key={`${l.at}-${l.msg}`} className="log" data-level={l.level}>
            <time data-num>{l.at}</time>
            <span className="log__level">{l.level}</span>
            <span className="log__where" data-num>
              {l.service}/{l.component}
            </span>
            <span className="log__msg">{l.msg}</span>
            <span className="log__trace" data-num title={l.trace}>
              {l.trace.slice(0, 8)}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Decisions() {
  const setApproval = useUi((s) => s.setApproval);
  return (
    <EmptyState
      icon="shield"
      title="Every permission decision, in order"
      body="Each automatic allow, remembered grant, approval and refusal will be listed here with a link to the trace. One decision is waiting on you now."
      action={{ label: 'Review the waiting request', onClick: () => setApproval(true) }}
    />
  );
}

/** Logs opened from a trace arrive with ?trace=. */
function LogsFromSearch() {
  const search = useSearch({ strict: false }) as { trace?: string };
  return <LogsScreen key={search.trace ?? ''} initialTrace={search.trace ?? ''} />;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: 'health', label: 'Health', icon: 'pulse', group: 'System', render: demoOr(Health, HealthScreen) },
  {
    id: 'compute',
    label: 'Compute',
    icon: 'node',
    group: 'System',
    render: demoOr(Compute, () => <ComputeScreen />),
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    icon: 'factcheck',
    group: 'System',
    render: () => <DiagnosticsScreen />,
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: 'logs',
    group: 'System',
    render: demoOr(Logs, () => <LogsFromSearch />),
  },
  {
    id: 'traces',
    label: 'Traces',
    icon: 'tree',
    group: 'System',
    render: () => <TracesScreen />,
  },
  { id: 'grants', label: 'Grants', icon: 'shield', group: 'Trust', render: demoOr(Grants, LiveGrants) },
  {
    id: 'decisions',
    label: 'Decisions',
    icon: 'check',
    group: 'Trust',
    render: demoOr(Decisions, LiveDecisions),
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: 'memory',
    group: 'Trust',
    render: demoOr(Memory, () => <MemoryScreen />),
  },
  {
    id: 'models',
    label: 'Models',
    icon: 'model',
    group: 'Models',
    render: LiveModels,
  },
  {
    id: 'routing',
    label: 'Routing',
    icon: 'branch',
    group: 'Models',
    render: LiveRouting,
  },
  {
    id: 'plugins',
    label: 'Plugins',
    icon: 'plus',
    group: 'Extend',
    render: () => <PluginsScreen />,
  },
  {
    id: 'automations',
    label: 'Automations',
    icon: 'regenerate',
    group: 'Extend',
    render: () => <AutomationsScreen />,
  },
  {
    id: 'license',
    label: 'Licence',
    icon: 'key',
    group: 'Extend',
    render: () => <LicenceScreen />,
  },
  // Pro features (DESIGN.md §9): their own screen with Pro, a card explaining them without.
  ...PRO_SURFACES.filter((s) => s.place === 'admin').map(
    (s): AdminSection => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
      group: s.group ?? (s.feature === 'team' ? 'Trust' : s.feature === 'fleet' ? 'System' : 'Extend'),
      render: () => <ProSurfaceView id={s.id} />,
    }),
  ),
];
