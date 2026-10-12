/**
 * ------------------------------------------------------------------
 *  Title    |  Providers, routing and cost for one model
 *  Ref      |  docs/openrouter.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One dialog with three tabs: who serves the model, how
 *           |  it picks among them, and what it will cost. Opened from
 *           |  a model's menu in Settings → Models and from a flow step.
 *  How      |  Radix dialog and tabs. Routing saves for the model (the
 *           |  default every notebook and thread starts from).
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { useState } from 'react';
import '../styles/openrouter.css';
import { useEndpoints } from './api';
import { CostCalculator } from './CostCalculator';
import { EndpointExplorer } from './EndpointExplorer';
import { RoutingOverrideEditor } from './RoutingControls';

export type OrTab = 'providers' | 'routing' | 'cost';

export function OpenRouterDialog({
  model,
  modelId,
  name,
  initial = 'providers',
  onClose,
}: {
  model: string;
  modelId: string;
  name: string;
  initial?: OrTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<OrTab>(initial);
  const eps = useEndpoints(model);
  const providers = eps.data?.endpoints.map((e) => e.provider) ?? [];
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick or-dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">{name} on OpenRouter</Dialog.Title>
          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as OrTab)}>
            <Tabs.List className="or-tabs" aria-label="About this model">
              <Tabs.Trigger value="providers" className="or-tab">
                Providers
              </Tabs.Trigger>
              <Tabs.Trigger value="routing" className="or-tab">
                Routing
              </Tabs.Trigger>
              <Tabs.Trigger value="cost" className="or-tab">
                Cost
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="providers">
              <EndpointExplorer model={model} />
            </Tabs.Content>
            <Tabs.Content value="routing">
              <RoutingOverrideEditor
                scope="model"
                id={modelId}
                model={model}
                modelId={modelId}
                providers={providers}
              />
            </Tabs.Content>
            <Tabs.Content value="cost">
              <CostCalculator model={model} modelId={modelId} />
            </Tabs.Content>
          </Tabs.Root>
          <div className="dialog__actions">
            <Dialog.Close asChild>
              <button type="button" className="btn btn--ghost">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
