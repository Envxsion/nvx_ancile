/**
 * ------------------------------------------------------------------
 *  Title    |  Routing and cost on a flow step
 *  Ref      |  docs/openrouter.md · DESIGN.md §16
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A model, manager or router step on an OpenRouter model
 *           |  can have its own routing (else the thread's, notebook's
 *           |  or model's applies), and opens the cost calculator.
 *  How      |  The choice is kept in the step's params as `routing`;
 *           |  Core sends it with that step's calls only.
 * ------------------------------------------------------------------
 */

import type { RoutingSettings } from '@nvx/contracts';
import { useState } from 'react';
import { DEFAULT_ROUTING, PRESETS } from './api';
import { OpenRouterDialog } from './OpenRouterDialog';
import { RoutingControls } from './RoutingControls';

export function StepRouting({
  model,
  modelId,
  value,
  onChange,
}: {
  model: string;
  modelId: string;
  value: RoutingSettings | undefined;
  onChange: (v: RoutingSettings | undefined) => void;
}) {
  const [cost, setCost] = useState(false);
  return (
    <details className="or-step">
      <summary>
        Provider routing:{' '}
        {value ? PRESETS.find((p) => p.value === value.preset)?.label : 'follows the thread'}
      </summary>
      <div className="or-section">
        {value ? (
          <>
            <RoutingControls model={model} modelId={modelId} value={value} onChange={onChange} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(undefined)}>
              Follow the thread
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(DEFAULT_ROUTING)}>
            Set routing for this step
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCost(true)}>
          Work out the cost
        </button>
      </div>
      {cost ? (
        <OpenRouterDialog
          model={model}
          modelId={modelId}
          name={model}
          initial="cost"
          onClose={() => setCost(false)}
        />
      ) : null}
    </details>
  );
}
