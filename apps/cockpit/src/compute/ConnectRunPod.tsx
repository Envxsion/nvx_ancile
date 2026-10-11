/**
 * ------------------------------------------------------------------
 *  Title    |  Connect RunPod
 *  Ref      |  docs/compute.md (Connecting RunPod)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Turn sample nodes into real ones: paste a RunPod API key
 *           |  once, and the Controller manages your pods from then on.
 *  How      |  PUT /compute/provider. The Controller checks the key with
 *           |  RunPod before anything changes; only then does Core save
 *           |  it, encrypted. DELETE goes back to sample nodes.
 *  Note     |  The key is never shown again once saved.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';

export interface ProviderInfo {
  kind: string;
  connected: boolean;
  detail: string;
  key_saved: boolean;
}

const KEY = ['compute', 'provider'] as const;

export function useProvider(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ProviderInfo>('/compute/provider'),
    enabled,
    staleTime: 30_000,
  });
}

const refreshCompute = () => queryClient.invalidateQueries({ queryKey: ['compute'] });

export function ConnectRunPodDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  useLayer(open);
  const [key, setKey] = useState('');
  const connect = useMutation({
    mutationFn: (api_key: string) => api.put<ProviderInfo>('/compute/provider', { api_key }),
    onSuccess: () => {
      setKey('');
      onOpenChange(false);
      notify({
        level: 'success',
        title: 'RunPod connected',
        body: 'Add a pod by its id, or create one. The sample nodes are gone.',
      });
      return refreshCompute();
    },
  });
  const problem = connect.error instanceof ApiCallError ? connect.error.body.error : null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) connect.reset();
        onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content
          className="dialog m-glass-thick connect-runpod"
          aria-describedby="connect-runpod-desc"
        >
          <Dialog.Title className="dialog__title">Connect RunPod</Dialog.Title>
          <p id="connect-runpod-desc" className="dialog__lede">
            NVX Ancile starts, stops and watches the pods in your RunPod account. GPU time is billed by
            RunPod, to you.
          </p>
          <form
            className="add-node__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) connect.mutate(key.trim());
            }}
          >
            <label className="field">
              <span>RunPod API key</span>
              <input
                className="input input--mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="rpa_…"
                aria-invalid={problem ? true : undefined}
                aria-describedby="runpod-key-hint"
                // biome-ignore lint/a11y/noAutofocus: the dialog opens to this one field
                autoFocus
              />
              <span id="runpod-key-hint" className="field__hint">
                In RunPod: Settings → API Keys → Create, with read and write access to pods. It is checked
                with RunPod before it is saved, and kept encrypted on this computer.
              </span>
            </label>
            {problem ? (
              <p className="connect-runpod__problem" role="alert">
                <strong>{problem.title}.</strong> {problem.hint}
              </p>
            ) : null}
            <div className="dialog__actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn--ghost">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn--primary" disabled={!key.trim() || connect.isPending}>
                {connect.isPending ? 'Checking with RunPod…' : 'Connect RunPod'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Back to sample nodes; refused while real nodes are still managed through RunPod. */
export function useDisconnectRunPod() {
  return useMutation({
    mutationFn: () => api.del<ProviderInfo>('/compute/provider'),
    onSuccess: () => {
      notify({
        level: 'success',
        title: 'RunPod disconnected',
        body: 'The key is removed from this computer. Sample nodes are back.',
      });
      return refreshCompute();
    },
    onError: (e) =>
      notify({
        level: 'error',
        title: e instanceof ApiCallError ? e.body.error.title : 'RunPod was not disconnected',
        body: e instanceof ApiCallError ? e.body.error.hint : 'Try again.',
      }),
  });
}
