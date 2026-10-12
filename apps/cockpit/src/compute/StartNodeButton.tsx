/**
 * ------------------------------------------------------------------
 *  Title    |  Start node, on a failed answer
 *  Ref      |  docs/errors.md (compute.node_stopped)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  "Your GPU node is stopped" comes with the one thing to
 *           |  do about it: start the node, right on the answer.
 *  How      |  Reads the node list and starts the stopped node (the
 *           |  first, when there are several). Nothing shows when no
 *           |  node is stopped, so a stale error offers nothing wrong.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { nodeAction, useNodes } from './data';

export function StartNodeButton() {
  const nodes = useNodes();
  const [started, setStarted] = useState(false);
  const stopped = (nodes.data ?? []).find((n) => n.observed_state === 'stopped');
  if (!stopped) return null;
  return (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      disabled={started}
      onClick={() => {
        setStarted(true);
        void nodeAction(stopped, 'start').then((ok) => {
          if (!ok) setStarted(false);
        });
      }}
    >
      {started ? 'Starting node' : 'Start node'}
    </button>
  );
}
