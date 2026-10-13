/**
 * ------------------------------------------------------------------
 *  Title    |  Plugins: From Claude Code
 *  Ref      |  docs/claude-code.md (MCP servers) · docs/plugins.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The MCP servers you already have in Claude Code (claude.ai
 *           |  connectors, your user and project config, plugins), read-
 *           |  only, with where each is set up and whether it is
 *           |  connected. They are managed in Claude Code and used by
 *           |  Claude Code threads.
 *  How      |  GET /claude-code/mcp-servers (Core asks Claude Code from a
 *           |  session that sends nothing; Refresh asks again). Grouped
 *           |  by where each is set up; connected ones first, the rest
 *           |  folded under "not connected".
 *  Note     |  Nothing here changes a server: no switch, no edit, no
 *           |  remove. Names only, never a command, address or token.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeMcpServer, ClaudeCodeMcpServers, ClaudeCodeMcpSource } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { Icon } from '../ui/Icon';
import { Skeleton, StatusDot } from '../ui/primitives';
import { LoadFailed, reportFailure } from './common';

export const CC_MCP_KEY = ['claude-code', 'mcp-servers'] as const;

const GROUPS: { source: ClaudeCodeMcpSource; title: string }[] = [
  { source: 'claudeai', title: 'claude.ai connectors' },
  { source: 'user', title: 'Your Claude Code config' },
  { source: 'project', title: 'Project config (.mcp.json)' },
  { source: 'local', title: 'One folder only (local config)' },
  { source: 'plugin', title: 'Claude Code plugins' },
  { source: 'other', title: 'Managed by your organisation' },
];

const STATUS: Record<
  NonNullable<ClaudeCodeMcpServer['status']>,
  { words: string; dot: 'ok' | 'degraded' | 'down' | 'idle' }
> = {
  connected: { words: 'Connected', dot: 'ok' },
  'needs-auth': { words: 'Needs sign-in in Claude Code', dot: 'degraded' },
  pending: { words: 'Starting', dot: 'idle' },
  failed: { words: 'Did not connect', dot: 'down' },
  disabled: { words: 'Turned off in Claude Code', dot: 'idle' },
};

/** "claude.ai Vercel" → "Vercel"; "plugin:design:linear" → "linear" (from the design plugin). */
export function displayName(s: ClaudeCodeMcpServer): { name: string; from: string | null } {
  if (s.source === 'claudeai' && s.name.startsWith('claude.ai '))
    return { name: s.name.slice(10), from: null };
  const p = /^plugin:([^:]+):(.+)$/.exec(s.name);
  if (p) return { name: p[2] ?? s.name, from: `${p[1]} plugin` };
  return { name: s.name, from: null };
}

function Row({ s }: { s: ClaudeCodeMcpServer }) {
  const d = displayName(s);
  const st = s.status ? STATUS[s.status] : null;
  return (
    <li className="mcp m-glass" data-status={s.status ?? 'unknown'}>
      <div className="mcp__head">
        <StatusDot status={st?.dot ?? 'idle'} label={st?.words ?? 'Set up in Claude Code'} />
        <div className="mcp__names">
          <strong>
            {d.name}
            <span className="mcp__badge">Claude Code</span>
          </strong>
          <span className="mute">
            {[
              d.from,
              st?.words ?? 'Set up in Claude Code',
              s.tools ? `${s.tools} ${s.tools === 1 ? 'tool' : 'tools'}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
    </li>
  );
}

function Group({ title, servers }: { title: string; servers: ClaudeCodeMcpServer[] }) {
  const [open, setOpen] = useState(false);
  const on = servers.filter((s) => s.status === 'connected' || s.status === null);
  const off = servers.filter((s) => s.status !== 'connected' && s.status !== null);
  const id = `cc-mcp-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return (
    <section className="mcp-cc" aria-labelledby={id}>
      <h3 className="admin__h" id={id}>
        {title}
      </h3>
      {on.length ? (
        <ul className="mcp-list">
          {on.map((s) => (
            <Row key={s.name} s={s} />
          ))}
        </ul>
      ) : null}
      {off.length ? (
        <>
          <button
            type="button"
            className="link-btn link-btn--quiet"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide' : 'Show'} {off.length} not connected
          </button>
          {open ? (
            <ul className="mcp-list">
              {off.map((s) => (
                <Row key={s.name} s={s} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function ClaudeCodeMcpSection() {
  const q = useQuery({
    queryKey: CC_MCP_KEY,
    queryFn: () => api.get<ClaudeCodeMcpServers>('/claude-code/mcp-servers'),
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      queryClient.setQueryData(
        CC_MCP_KEY,
        await api.get<ClaudeCodeMcpServers>('/claude-code/mcp-servers?refresh=1'),
      );
    } catch (e) {
      reportFailure(e, 'Asking Claude Code for its servers');
    } finally {
      setBusy(false);
    }
  };
  const data = q.data;
  const servers = data?.servers ?? [];

  return (
    <section className="plug-section" aria-labelledby="cc-mcp-h">
      <div className="plug-section__head">
        <div>
          <h2 className="admin__h" id="cc-mcp-h">
            From Claude Code
          </h2>
          <p className="mute">
            MCP servers you set up in Claude Code. They are managed in Claude Code and are available to Claude
            Code threads; NVX Ancile only lists them here.
          </p>
        </div>
        {data?.can_refresh ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <Icon name="regenerate" size={13} />
            {busy ? 'Asking Claude Code' : 'Refresh'}
          </button>
        ) : null}
      </div>

      {q.isPending ? (
        <Skeleton lines={2} label="Asking Claude Code for its servers" />
      ) : q.isError && !data ? (
        <LoadFailed error={q.error} what="Claude Code's MCP servers" onRetry={() => void q.refetch()} />
      ) : servers.length === 0 ? (
        <p className="mute">
          {data?.can_refresh
            ? 'Claude Code has no MCP servers of its own yet. Servers you add in Claude Code (claude mcp add, or a connector on claude.ai) show here.'
            : 'Install and sign in to Claude Code (Settings → Claude Code) to see the MCP servers you have there.'}
        </p>
      ) : (
        <>
          {data?.from === 'config' ? (
            <p className="mute">
              Names from Claude Code's config. Whether each is connected shows once Claude Code can be asked.
            </p>
          ) : data?.updated_at ? (
            <p className="mute">Checked {relative(data.updated_at)}.</p>
          ) : null}
          {GROUPS.map((g) => {
            const list = servers.filter((s) => s.source === g.source);
            return list.length ? <Group key={g.source} title={g.title} servers={list} /> : null;
          })}
        </>
      )}
    </section>
  );
}
