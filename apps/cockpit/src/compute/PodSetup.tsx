/**
 * ------------------------------------------------------------------
 *  Title    |  Pod set up by hand
 *  Ref      |  docs/compute.md (Setting up RunPod)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a RunPod pod needs to serve NVX Ancile: the
 *           |  start command and the environment, with the key this
 *           |  Controller sends, ready to copy into the RunPod console.
 *  How      |  A closed disclosure in Add node; it asks Core for
 *           |  /compute/node-setup only when opened. The key is masked
 *           |  on screen and copied whole.
 *  Note     |  Pods created from the app get all of this themselves.
 * ------------------------------------------------------------------
 */

import type { NodeSetup } from '@nvx/contracts/controller';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { CopyButton } from '../ops/common';

const mask = (v: string) => `${v.slice(0, 4)}${'•'.repeat(12)}`;

export function PodSetup() {
  const [open, setOpen] = useState(false);
  const setup = useQuery({
    queryKey: ['compute', 'node-setup'],
    queryFn: () => api.get<NodeSetup>('/compute/node-setup'),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const s = setup.data;
  const envText = s
    ? Object.entries(s.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : '';
  return (
    <details className="pod-setup" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Setting the pod up yourself?</summary>
      {setup.isPending && open ? <p className="mute">Asking the Controller…</p> : null}
      {setup.isError ? (
        <p className="mute">The Controller did not answer. Check it is running, then open this again.</p>
      ) : null}
      {s ? (
        <div className="pod-setup__body">
          <p className="mute">
            In the RunPod console, give the pod a CUDA image, a volume at <code>/workspace</code>, HTTP port{' '}
            <code>8000</code>, and these:
          </p>
          <div className="pod-setup__block">
            <span className="pod-setup__label">Start command</span>
            <code className="pod-setup__code">{s.start_command}</code>
            <CopyButton text={s.start_command} small />
          </div>
          <div className="pod-setup__block">
            <span className="pod-setup__label">Environment</span>
            <code className="pod-setup__code">
              {Object.entries(s.env).map(([k, v]) => (
                <span key={k}>
                  {k}={k === 'ANCILE_MODEL' ? v : mask(v)}
                </span>
              ))}
            </code>
            <CopyButton text={envText} small />
          </div>
          {s.node_token ? (
            <p className="mute">
              The key is the one this Controller sends to its nodes; with any other value, every chat routed
              to the pod is refused.
            </p>
          ) : (
            <p className="pod-setup__warn">
              The Controller has no node key yet. Set <code>CONTROLLER_NODE_TOKEN</code> and restart it, then
              open this again.
            </p>
          )}
        </div>
      ) : null}
    </details>
  );
}
