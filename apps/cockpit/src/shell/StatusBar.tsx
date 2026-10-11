/**
 * ------------------------------------------------------------------
 *  Title    |  Status bar
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  30 px that answer "what is it using, how full is it,
 *           |  what is it costing, does it need me, is it well".
 *  How      |  Each segment is a button that opens the place you fix
 *           |  it: model → palette in @ scope, approvals → the dialog,
 *           |  health → admin, the branch → the Repo panel. Numbers roll rather than jump. Which
 *           |  segments show is a setting (Settings → Layout).
 *  Note     |  "Demo data" shows whenever fixtures are on screen, so
 *           |  nobody mistakes the sample notebook for their own.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { type ComputeNode, useComputeStatus, useNodes } from '../compute/data';
import { live as demoLive } from '../fixtures/demo';
import { tourEvent } from '../help/tours';
import { useConnection } from '../lib/connection';
import { useApprovals, useSystemHealth } from '../lib/data';
import { usd } from '../lib/format';
import { useCurrentModel, useThreadIdFromRoute } from '../lib/models';
import { RepoSegment } from '../repos/RepoSegment';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { Ticker } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { HueChip, StatusDot, Tip } from '../ui/primitives';
import { ContextMeter } from './ContextMeter';

/** The node to show: one that is running (or waking), the dearest first; else none. */
export function shownNode(nodes: ComputeNode[] | undefined): ComputeNode | null {
  const up = (nodes ?? []).filter((n) => n.observed_state === 'running' || n.observed_state === 'starting');
  up.sort(
    (a, b) =>
      Number(b.observed_state === 'running') - Number(a.observed_state === 'running') ||
      b.hourly_rate - a.hourly_rate,
  );
  return up[0] ?? null;
}

/** The GPU node segment: the demo's sample node, or a real running node, or nothing. */
function NodeSegment({ demo }: { demo: boolean }) {
  const status = useComputeStatus();
  const ready = !demo && !!status.data?.configured && !!status.data.reachable;
  const nodes = useNodes(ready);
  const real = ready ? shownNode(nodes.data) : null;
  const node = demo
    ? demoLive.node
    : real
      ? {
          name: real.name,
          state: real.observed_state === 'running' ? 'running' : 'waking',
          rate: real.hourly_rate,
        }
      : null;
  if (!node) return null;
  return (
    <Link
      to="/admin/$section"
      params={{ section: 'compute' }}
      className="status-seg"
      aria-label={`GPU node ${node.name}: ${node.state === 'running' ? 'running' : 'starting'}, ${usd(node.rate)} an hour`}
    >
      <StatusDot status={node.state === 'running' ? 'ok' : node.state === 'error' ? 'down' : 'idle'} />
      <span>{node.name}</span>
      <span data-num className="mute">
        {usd(node.rate)}/h
      </span>
    </Link>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="status-seg status-seg--static" data-num>
      {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

export function StatusBar() {
  const demo = useUi((s) => s.demo);
  const openPalette = useUi((s) => s.openPalette);
  const setApproval = useUi((s) => s.setApproval);
  const show = usePrefs((s) => s.prefs.layout.status);
  const offline = useConnection((s) => s.status === 'offline');
  const model = useCurrentModel(useThreadIdFromRoute());
  const approvals = useApprovals().data?.length ?? 0;
  const healthQuery = useSystemHealth();
  const health = offline
    ? { status: 'down' as const, summary: 'Core is not answering' }
    : (healthQuery.data ?? { status: 'ok' as const, summary: 'Checking' });

  return (
    <footer className="statusbar" role="contentinfo" aria-label="Status">
      {show.model ? (
        <Tip label="Change model" binding="model.switch">
          <button
            type="button"
            className="status-seg"
            onClick={() => openPalette('models')}
            aria-label={`Model: ${model?.name ?? 'none ready'}. Change model`}
          >
            {model ? <HueChip hue={model.hue}>{model.name}</HueChip> : <span>Choose a model</span>}
            <Icon name="chevronDown" size={12} />
          </button>
        </Tip>
      ) : null}

      {show.context ? <ContextMeter /> : null}

      {demo ? null : <RepoSegment />}

      {show.node ? <NodeSegment demo={demo} /> : null}

      <span className="statusbar__spacer" />

      {demo ? (
        <span
          className="status-seg status-seg--static status-demo"
          title="Sample data: NVX Ancile has not reached Core from this browser yet."
        >
          Demo data
        </span>
      ) : null}

      {approvals > 0 && show.approvals ? (
        <button
          type="button"
          className="status-seg status-seg--attention"
          data-tour="approvals"
          onClick={() => {
            setApproval(true);
            tourEvent('approval-opened');
          }}
        >
          <Icon name="shield" size={13} />
          <Ticker value={approvals} />
          <span>{approvals === 1 ? 'decision waiting' : 'decisions waiting'}</span>
        </button>
      ) : null}

      {show.health ? (
        <Link
          to="/admin/$section"
          params={{ section: 'health' }}
          className="status-seg"
          aria-label={`System health: ${health.summary}`}
          data-health={health.status}
        >
          <StatusDot status={health.status} />
          <span>{health.summary}</span>
        </Link>
      ) : null}

      {show.clock ? <Clock /> : null}
    </footer>
  );
}
