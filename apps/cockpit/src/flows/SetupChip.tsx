/**
 * ------------------------------------------------------------------
 *  Title    |  Setup chip and dialog
 *  Ref      |  ROADMAP FW2, DESIGN.md §16
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A node that needs a key, a GPU provider or an MCP
 *           |  server says so on its card, in words, with a "Set up"
 *           |  button. The button opens the right place in a dialog,
 *           |  without leaving the canvas, and the node re-checks.
 *  How      |  The needs come from setup.ts. A key and the RunPod
 *           |  connection reuse the Settings key row; an MCP server
 *           |  offers Switch on or Test connection; Claude Code
 *           |  sign-in and adding a server open their settings page.
 *           |  "Check again" refetches models, keys and servers.
 * ------------------------------------------------------------------
 */

import type { McpServerView } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CREDENTIAL_META, CredentialRow, useCredentials } from '../credentials/ApiKeys';
import { api } from '../lib/api';
import { fetchMcpServers, MCP_SERVERS_KEY, putServer, serverPath, TOOLS_KEY } from '../ops/mcp';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import type { SetupContext, SetupNeed } from './setup';
import { useEditor } from './store';

/** The chip on a card: the first need in words, and how many more. */
export function SetupChip({ needs }: { needs: SetupNeed[] }) {
  const [open, setOpen] = useState(false);
  const first = needs[0];
  if (!first) return null;
  return (
    <div className="fnode__setup nodrag">
      <span className="fnode__setup-what" title={first.why}>
        <Icon name="warn" size={11} />
        Needs {first.missing.toLowerCase()}
        {needs.length > 1 ? ` and ${needs.length - 1} more` : ''}
      </span>
      <button type="button" className="fnode__setup-btn" onClick={() => setOpen(true)}>
        Set up
      </button>
      {open ? <SetupDialog needs={needs} onOpenChange={setOpen} /> : null}
    </div>
  );
}

function SetupDialog({ needs, onOpenChange }: { needs: SetupNeed[]; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    setChecking(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['credentials'] }),
        qc.invalidateQueries({ queryKey: ['flows', 'models'] }),
        qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
        qc.invalidateQueries({ queryKey: TOOLS_KEY }),
      ]);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog fsetup" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            <Icon name="warn" size={18} /> Set up this step
          </Dialog.Title>
          <ul className="fsetup__list">
            {needs.map((n) => (
              <li key={`${n.code}:${JSON.stringify(n.fix)}`} className="fsetup__need">
                <b>{n.missing}</b>
                <span className="mute">{n.why}</span>
                <Fix need={n} onDone={recheck} onLeave={() => onOpenChange(false)} />
              </li>
            ))}
          </ul>
          <div className="dialog__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void recheck()}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check again'}
            </button>
            <Dialog.Close className="btn btn--primary" type="button">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Fix({ need, onDone, onLeave }: { need: SetupNeed; onDone: () => void; onLeave: () => void }) {
  const fix = need.fix;
  const navigate = useNavigate();
  const creds = useCredentials();
  const go = (to: () => void) => () => {
    onLeave();
    to();
  };
  if (fix.kind === 'key' || fix.kind === 'runpod') {
    const id = fix.kind === 'runpod' ? 'runpod' : fix.credential;
    const meta = CREDENTIAL_META.find((m) => m.id === id);
    if (!meta)
      return (
        <button
          type="button"
          className="btn btn--sm"
          onClick={go(() => void navigate({ to: '/settings/$group', params: { group: 'keys' } }))}
        >
          Open API keys
        </button>
      );
    return (
      <div className="fsetup__inline">
        <CredentialRow meta={meta} status={creds.data?.find((s) => s.id === id)} />
        {fix.kind === 'runpod' ? (
          <span className="mute">
            If the key is saved and pods still do not start, check it was made with permission to create and
            stop pods.
          </span>
        ) : null}
      </div>
    );
  }
  if (fix.kind === 'claude')
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={go(() => void navigate({ to: '/settings/$group', params: { group: 'claude-code' } }))}
      >
        {need.action}
      </button>
    );
  if (fix.kind === 'choose-model')
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={go(() => {
          // Opens the step's own panel, where the model picker is.
          const st = useEditor.getState();
          st.select([need.node_id]);
          st.setPanel('node');
        })}
      >
        {need.action}
      </button>
    );
  if (fix.kind === 'enable-model')
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={go(() => void navigate({ to: '/admin/$section', params: { section: 'models' } }))}
      >
        {need.action}
      </button>
    );
  return <McpFix server={fix.server} status={fix.status} onDone={onDone} onLeave={onLeave} />;
}

function McpFix({
  server,
  status,
  onDone,
  onLeave,
}: {
  server: string | null;
  status: McpServerView['status'] | 'missing';
  onDone: () => void;
  onLeave: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const act = useMutation({
    mutationFn: async () => {
      if (!server) return null;
      const path = serverPath(server);
      return status === 'disabled'
        ? api.patch<McpServerView>(path, { enabled: true })
        : api.post<McpServerView>(`${path}/test`, {});
    },
    onSuccess: (r) => {
      if (r) putServer(qc, r);
      if (r && r.status !== 'connected')
        notify({
          level: 'error',
          title: `${r.name} did not connect`,
          body: r.last_error ?? 'Check its command or address in Admin, Plugins.',
        });
      onDone();
    },
    onError: (e) =>
      notify({ level: 'error', title: 'The server did not answer', body: (e as Error).message }),
  });
  if (!server || status === 'missing')
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          onLeave();
          void navigate({ to: '/admin/$section', params: { section: 'plugins' } });
        }}
      >
        Add the server
      </button>
    );
  return (
    <button type="button" className="btn btn--sm" disabled={act.isPending} onClick={() => act.mutate()}>
      {act.isPending ? 'Working…' : status === 'disabled' ? 'Switch it on' : 'Test the connection'}
    </button>
  );
}

/** The context the needs are computed from, read once for the whole canvas. */
export function useSetupContext(models: SetupContext['models']): SetupContext {
  const servers = useQuery({ queryKey: MCP_SERVERS_KEY, queryFn: fetchMcpServers, staleTime: 30_000 });
  const creds = useCredentials();
  return {
    models,
    servers: servers.data,
    runpodConnected: creds.data ? !!creds.data.find((s) => s.id === 'runpod')?.set : undefined,
  };
}
