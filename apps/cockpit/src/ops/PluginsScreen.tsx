/**
 * ------------------------------------------------------------------
 *  Title    |  Plugins
 *  Ref      |  DESIGN.md §4.4, §12 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Both directions of MCP in one place. Apps that use NVX
 *           |  Ancile: connect one (pick what it may do, take its token
 *           |  and config once), see when it was last used, disconnect
 *           |  it. Tools NVX Ancile can use: every tool with the tier it
 *           |  asks at, and the MCP servers it connects to, with a test.
 * ------------------------------------------------------------------
 */

import type { McpClientView } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Check } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton, StatusDot, TierBadge } from '../ui/primitives';
import { CopyButton, LoadFailed, reportFailure } from './common';

interface ServerInfo {
  url: string;
  tools: { name: string; title: string; action: string }[];
}
interface ToolRow {
  name: string;
  description: string;
  action: string;
  tier: 'auto' | 'gated' | 'critical';
  destructive: boolean;
  source: { kind: string; server?: string } | string;
}
interface McpServer {
  server: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  connected: boolean;
  tools: number;
  lastError: string | null;
  connectedAt: string | null;
}

const sourceWords = (s: ToolRow['source']) => {
  const kind = typeof s === 'string' ? s : s.kind;
  if (kind === 'builtin') return 'Built in';
  if (kind === 'mcp')
    return `From ${typeof s === 'string' ? 'an MCP server' : (s.server ?? 'an MCP server')}`;
  return kind;
};

export function PluginsScreen() {
  const server = useQuery({
    queryKey: ['ops', 'mcp-server'],
    queryFn: () => api.get<ServerInfo>('/mcp/server'),
  });
  const clients = useQuery({
    queryKey: ['ops', 'mcp-clients'],
    queryFn: () => api.get<{ items: McpClientView[] }>('/mcp/clients').then((r) => r.items),
  });
  const tools = useQuery({
    queryKey: ['ops', 'tools'],
    queryFn: () => api.get<{ items: ToolRow[] }>('/tools').then((r) => r.items),
  });
  const servers = useQuery({
    queryKey: ['ops', 'mcp-servers'],
    queryFn: () => api.get<{ items: McpServer[] }>('/mcp/servers').then((r) => r.items),
  });
  const [connecting, setConnecting] = useState(false);
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/mcp/clients/${id}`),
    onSuccess: () => {
      notify({
        level: 'success',
        title: 'Disconnected',
        body: 'Its token stops working now, and its access is revoked.',
      });
      return queryClient.invalidateQueries({ queryKey: ['ops', 'mcp-clients'] });
    },
    onError: (e) => reportFailure(e, 'Disconnecting'),
  });
  const test = useMutation({
    mutationFn: (name: string) => api.post(`/mcp/servers/${encodeURIComponent(name)}/test`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ops', 'mcp-servers'] }),
    onError: (e) => reportFailure(e, 'The test'),
  });

  return (
    <div className="ops plugins">
      <section className="plug-section">
        <div className="plug-section__head">
          <div>
            <h2 className="admin__h">Apps that use NVX Ancile</h2>
            <p className="mute">
              Editors and assistants that speak MCP can search your sources and memory, and only what you
              allow here.
              {server.data ? (
                <>
                  {' '}
                  Address: <code>{server.data.url}</code>
                </>
              ) : null}
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setConnecting(true)}>
            <Icon name="plus" size={13} />
            Connect an app
          </button>
        </div>
        {clients.isPending ? (
          <Skeleton lines={2} label="Loading apps" />
        ) : clients.isError && !clients.data ? (
          <LoadFailed error={clients.error} what="Connected apps" onRetry={() => void clients.refetch()} />
        ) : clients.data.length === 0 ? (
          <EmptyState
            icon="link"
            title="No apps connected"
            body="Connect one to give it a token. You choose what it may do, and can take it back here or in Grants."
            action={{ label: 'Connect an app', onClick: () => setConnecting(true) }}
          />
        ) : (
          <ul className="app-grid">
            {clients.data.map((c) => (
              <li key={c.id} className="app-card m-glass">
                <div className="app-card__head">
                  <span className="app-card__icon" aria-hidden="true">
                    <Icon name="link" size={15} />
                  </span>
                  <div>
                    <strong>{c.name}</strong>
                    <span className="mute">
                      {c.last_used_at ? `Last used ${relative(c.last_used_at)}` : 'Not used yet'} · connected{' '}
                      {relative(c.created_at)}
                    </span>
                  </div>
                </div>
                <div className="app-card__tools">
                  {c.tools.map((t) => (
                    <span key={t} className="tag">
                      {server.data?.tools.find((x) => x.name === t)?.title ?? t}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm app-card__off"
                  onClick={() => disconnect.mutate(c.id)}
                  disabled={disconnect.isPending}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="plug-section">
        <div className="plug-section__head">
          <h2 className="admin__h">MCP servers NVX Ancile uses</h2>
          {(servers.data ?? []).some((s) => s.server === 'github') ? null : <GitHubPreset />}
        </div>
        {servers.isPending ? (
          <Skeleton lines={2} label="Loading servers" />
        ) : (servers.data ?? []).length === 0 ? (
          <p className="mute">
            None yet. Add GitHub with the button above, or add servers in config/mcp.yaml; they connect when
            Core starts.
          </p>
        ) : (
          <ul className="rows">
            {(servers.data ?? []).map((s) => {
              const state = !s.enabled ? 'Off' : s.connected ? 'Connected' : 'Not connected';
              return (
                <li key={s.server} className="row row--health">
                  <StatusDot status={!s.enabled ? 'idle' : s.connected ? 'ok' : 'down'} label={state} />
                  <span className="row__title">{s.server}</span>
                  <span className="row__meta mute">
                    {s.lastError ?? `${s.tools} ${s.tools === 1 ? 'tool' : 'tools'} over ${s.transport}`}
                  </span>
                  <span className="mute">{state}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => test.mutate(s.server)}
                    disabled={!s.enabled}
                    data-busy={(test.isPending && test.variables === s.server) || undefined}
                  >
                    Test
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="plug-section">
        <h2 className="admin__h">Tools the assistant can use</h2>
        {tools.isPending ? (
          <Skeleton lines={4} label="Loading tools" />
        ) : (
          <ul className="tool-grid">
            {(tools.data ?? []).map((t) => (
              <li key={t.name} className="tool-card">
                <div className="tool-card__head">
                  <code>{t.name}</code>
                  <TierBadge tier={t.tier} />
                </div>
                <p className="mute">{t.description}</p>
                <span className="tool-card__src mute">
                  {sourceWords(t.source)}
                  {t.destructive ? ' · changes things' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConnectApp open={connecting} onOpenChange={setConnecting} tools={server.data?.tools ?? []} />
    </div>
  );
}

function ConnectApp({
  open,
  onOpenChange,
  tools,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tools: ServerInfo['tools'];
}) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(['ancile.search']);
  const [made, setMade] = useState<{ token: string; config: unknown; url: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string; config: unknown; url: string }>('/mcp/clients', {
        name: name.trim(),
        tools: chosen,
      }),
    onSuccess: (r) => {
      setMade(r);
      void queryClient.invalidateQueries({ queryKey: ['ops', 'mcp-clients'] });
    },
    onError: (e) => reportFailure(e, 'Connecting'),
  });
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setMade(null);
      setName('');
      setChosen(['ancile.search']);
    }
  };
  const config = made ? JSON.stringify(made.config, null, 2) : '';
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick connect-app" aria-describedby="connect-app-desc">
          <Dialog.Title className="dialog__title">{made ? 'Connected' : 'Connect an app'}</Dialog.Title>
          {made ? (
            <>
              <p id="connect-app-desc" className="dialog__lede">
                Copy the token now: it is shown only once. Paste the config into the app's MCP settings.
              </p>
              <div className="token-box">
                <code>{made.token}</code>
                <CopyButton text={made.token} label="Copy token" small />
              </div>
              <pre className="logline__json connect-app__config">{config}</pre>
              <div className="dialog__actions">
                <CopyButton text={config} label="Copy config" />
                <button type="button" className="btn btn--primary" onClick={() => close(false)}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && chosen.length) create.mutate();
              }}
            >
              <p id="connect-app-desc" className="dialog__lede">
                The app gets its own token and only the access you tick. Every call it makes is checked like
                the assistant's own, and shows in Decisions.
              </p>
              <label className="field">
                <span>Name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My editor"
                  maxLength={80}
                  required
                  // biome-ignore lint/a11y/noAutofocus: the dialog opens to this field
                  autoFocus
                />
              </label>
              <fieldset className="field">
                <legend>It may</legend>
                {tools.map((t) => (
                  <Check
                    key={t.name}
                    label={t.title}
                    checked={chosen.includes(t.name)}
                    onChange={(on) => setChosen((c) => (on ? [...c, t.name] : c.filter((x) => x !== t.name)))}
                  />
                ))}
              </fieldset>
              <div className="dialog__actions">
                <button type="button" className="btn btn--ghost" onClick={() => close(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={!name.trim() || !chosen.length || create.isPending}
                  data-busy={create.isPending || undefined}
                >
                  Connect
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The official GitHub MCP server in one click: issues, pull requests,
 * code search and more as tools, under your grants like any other. It
 * runs with your gh sign-in or a token you paste (kept encrypted), in
 * Docker or as the github-mcp-server binary, whichever is installed.
 */
function GitHubPreset() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const add = useMutation({
    mutationFn: () =>
      api.post<{ runner: string; health: { connected: boolean; tools: number; lastError: string | null } }>(
        '/mcp/presets/github',
        { ...(token.trim() && { token: token.trim() }), read_only: readOnly },
      ),
    onSuccess: (r) => {
      setOpen(false);
      setToken('');
      notify(
        r.health.connected
          ? {
              level: 'success',
              title: `GitHub added with ${r.health.tools} tools`,
              body: `Running through ${r.runner}.`,
            }
          : {
              level: 'warn',
              title: 'GitHub was added but is not connected yet',
              body: r.health.lastError ?? undefined,
            },
      );
      void queryClient.invalidateQueries({ queryKey: ['ops', 'mcp-servers'] });
      return queryClient.invalidateQueries({ queryKey: ['ops', 'tools'] });
    },
    onError: (e) => reportFailure(e, 'Adding GitHub'),
  });
  if (!open)
    return (
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
        <Icon name="plus" size={13} />
        Add GitHub
      </button>
    );
  return (
    <form
      className="mcp-preset"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <p className="mute">
        The official GitHub MCP server. Leave the token empty to use your GitHub CLI sign-in (
        <code>gh auth login</code>).
      </p>
      <input
        className="input input--sm"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="github_pat_… (optional)"
        aria-label="GitHub token for the MCP server"
      />
      <span className="mcp-preset__row mcp-preset__row--start">
        <Check checked={readOnly} onChange={setReadOnly} label="Read-only tools" /> Read-only tools (it can
        look, not change)
      </span>
      <div className="mcp-preset__row">
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={add.isPending}
          data-busy={add.isPending || undefined}
        >
          Add GitHub
        </button>
      </div>
    </form>
  );
}
