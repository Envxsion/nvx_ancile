/**
 * ------------------------------------------------------------------
 *  Title    |  MCP servers NVX Ancile uses
 *  Ref      |  packages/contracts/src/mcp.ts · docs/plugins.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The servers that give the assistant its tools: whether
 *           |  each is connected (live), what went wrong in words, and
 *           |  for each tool how it asks and whether it may be used.
 *           |  Add, edit, test, switch off and remove servers added
 *           |  here; servers from config/mcp.yaml are listed read-only
 *           |  apart from their tool settings.
 *  How      |  One card per server; the tools open under it. Changes
 *           |  answer with the server as Core now sees it, which goes
 *           |  straight into the cached list. mcp.server_changed on the
 *           |  event stream moves the dot (lib/events.ts → ./mcp.ts).
 * ------------------------------------------------------------------
 */

import type { McpServerView, McpToolView, Tier } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { type ConfirmCopy, ConfirmDialog } from '../ui/Confirm';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';
import { EmptyState, Skeleton, StatusDot, TierBadge } from '../ui/primitives';
import { LoadFailed, reportFailure } from './common';
import { McpServerDialog } from './McpServerDialog';
import {
  fetchMcpServers,
  MCP_SERVERS_KEY,
  putServer,
  STATUS_DOT,
  STATUS_WORDS,
  serverPath,
  TOOLS_KEY,
  tierOptions,
  toolPath,
} from './mcp';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function McpServersSection() {
  const servers = useQuery({ queryKey: MCP_SERVERS_KEY, queryFn: fetchMcpServers });
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<{ copy: ConfirmCopy; server: McpServerView } | null>(null);

  const list = servers.data ?? [];
  const hasGitHub = list.some((s) => s.name === 'github');

  const remove = useMutation({
    mutationFn: (s: McpServerView) => api.del(serverPath(s.id)).then(() => s),
    onSuccess: (s) => {
      queryClient.setQueryData<McpServerView[]>(MCP_SERVERS_KEY, (l) => l?.filter((x) => x.id !== s.id));
      notify({ level: 'success', title: `${s.name} is removed`, body: 'Its secrets are deleted too.' });
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      return queryClient.invalidateQueries({ queryKey: TOOLS_KEY });
    },
    onError: (e) => reportFailure(e, 'Removing the server'),
  });

  return (
    <section className="plug-section" aria-labelledby="mcp-servers-h">
      <div className="plug-section__head">
        <div>
          <h2 className="admin__h" id="mcp-servers-h">
            MCP servers NVX Ancile uses
          </h2>
          <p className="mute">
            Each server gives the assistant more tools. Every call is checked at the moment it runs, like the
            assistant's own.
          </p>
        </div>
        {list.length ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Add server
          </button>
        ) : null}
      </div>

      {servers.isPending ? (
        <Skeleton lines={2} label="Loading servers" />
      ) : servers.isError && !servers.data ? (
        <LoadFailed error={servers.error} what="MCP servers" onRetry={() => void servers.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="node"
          title="No MCP servers yet"
          body="Add one to give the assistant its tools: a command NVX Ancile starts on this computer, or an address it connects to. GitHub is one click."
          action={{ label: 'Add server', onClick: () => setAdding(true) }}
        />
      ) : (
        <ul className="mcp-list">
          {list.map((s, i) => (
            <McpServerCard
              key={s.id}
              server={s}
              delay={i * 40}
              onEdit={() => setEditing(s)}
              onRemove={() =>
                setConfirm({
                  server: s,
                  copy: {
                    title: `Remove ${s.name}?`,
                    body: `The assistant loses its ${plural(s.tools.length, 'tool')} at once, and the server's saved secrets are deleted too. You can add it again later.`,
                    action: 'Remove server',
                  },
                })
              }
            />
          ))}
        </ul>
      )}

      <McpServerDialog
        open={adding || editing !== null}
        server={editing}
        offerGitHub={!hasGitHub}
        onOpenChange={(o) => {
          if (o) return;
          setAdding(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        copy={confirm?.copy ?? null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && remove.mutate(confirm.server)}
      />
    </section>
  );
}

export function McpServerCard({
  server: s,
  delay = 0,
  onEdit,
  onRemove,
}: {
  server: McpServerView;
  delay?: number;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const fromFile = s.source === 'file';
  const toolsId = `mcp-tools-${s.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<McpServerView>(serverPath(s.id), { enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: MCP_SERVERS_KEY });
      const prev = queryClient.getQueryData<McpServerView[]>(MCP_SERVERS_KEY);
      queryClient.setQueryData<McpServerView[]>(MCP_SERVERS_KEY, (l) =>
        l?.map((x) => (x.id === s.id ? { ...x, enabled, status: enabled ? 'connecting' : 'disabled' } : x)),
      );
      return { prev };
    },
    onSuccess: (saved) => saved && putServer(queryClient, saved),
    onError: (e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(MCP_SERVERS_KEY, ctx.prev);
      reportFailure(e, 'Changing the server');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TOOLS_KEY }),
  });

  const test = useMutation({
    mutationFn: () => api.post<McpServerView>(`${serverPath(s.id)}/test`, {}),
    onSuccess: (r) => {
      if (r) putServer(queryClient, r);
      const now = r ?? s;
      notify(
        now.status === 'connected'
          ? {
              level: 'success',
              title: `${s.name} is connected`,
              body: `${plural(now.tools.length, 'tool')} ready.`,
            }
          : {
              level: 'error',
              title: `${s.name} did not connect`,
              body: now.last_error ?? 'Check the command or address, then test again.',
            },
      );
      return queryClient.invalidateQueries({ queryKey: TOOLS_KEY });
    },
    onError: (e) => reportFailure(e, 'The test'),
  });

  const where = s.transport === 'stdio' ? [s.command, ...s.args].filter(Boolean).join(' ') : (s.url ?? '');
  const toolCount = s.tools.length;
  const changed = s.tools.filter((t) => t.overridden || t.disabled).length;

  return (
    <li
      className="mcp m-glass"
      data-status={s.status}
      style={{ animationDelay: `${delay}ms` }}
      aria-label={`${s.name}, ${STATUS_WORDS[s.status]}`}
    >
      <div className="mcp__head">
        <StatusDot status={STATUS_DOT[s.status]} label={STATUS_WORDS[s.status]} />
        <div className="mcp__names">
          <strong>
            {s.name}
            {fromFile ? (
              <span className="mcp__badge" title="Change it in config/mcp.yaml">
                From config file
              </span>
            ) : null}
          </strong>
          <span className="mcp__where mute">
            <Icon name={s.transport === 'stdio' ? 'command' : 'globe'} size={12} />
            <span>{s.transport === 'stdio' ? 'Local command' : 'Remote'}</span>
            {where ? <code title={where}>{where}</code> : null}
          </span>
        </div>
        <span className="mcp__state" data-status={s.status}>
          {STATUS_WORDS[s.status]}
        </span>
        {fromFile ? null : (
          <Switch
            checked={s.enabled}
            onChange={(on) => toggle.mutate(on)}
            label={`Use ${s.name}`}
            disabled={toggle.isPending}
          />
        )}
      </div>

      {s.status === 'error' && s.last_error ? (
        <p className="mcp__note mcp__note--fail" role="status">
          {s.last_error}
        </p>
      ) : s.status === 'connecting' ? (
        <p className="mcp__note">Connecting. Its tools show here when it answers.</p>
      ) : null}

      <div className="mcp__foot">
        <button
          type="button"
          className="mcp__disclose"
          aria-expanded={open}
          aria-controls={toolsId}
          disabled={toolCount === 0}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="chevronRight" size={12} className="mcp__chev" />
          {toolCount === 0
            ? s.status === 'connected'
              ? 'No tools'
              : 'Tools show once connected'
            : `${open ? 'Hide' : 'Show'} ${plural(toolCount, 'tool')}`}
          {changed ? <span className="mcp__count mute"> · {changed} changed</span> : null}
        </button>
        <span className="mcp__actions">
          {s.connected_at && s.status === 'connected' ? (
            <span className="mute mcp__since">Connected {relative(s.connected_at)}</span>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => test.mutate()}
            disabled={!s.enabled || test.isPending}
            data-busy={test.isPending || undefined}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          {fromFile ? null : (
            <>
              <button type="button" className="btn btn--ghost btn--sm" onClick={onEdit}>
                Edit
              </button>
              <DropMenu
                items={[{ label: 'Remove server', icon: 'trash', danger: true, onSelect: onRemove }]}
                trigger={
                  <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for ${s.name}`}>
                    <Icon name="more" size={15} />
                  </button>
                }
              />
            </>
          )}
        </span>
      </div>

      {open && toolCount ? (
        <div id={toolsId} className="mcp__tools">
          {fromFile ? (
            <p className="mcp__note">
              Set in config/mcp.yaml: change the server there. How each tool asks can be changed here.
            </p>
          ) : null}
          <ul className="mcp-tools">
            {s.tools.map((t) => (
              <McpToolRow key={t.name} serverId={s.id} tool={t} />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

export function McpToolRow({ serverId, tool: t }: { serverId: string; tool: McpToolView }) {
  const update = useMutation({
    mutationFn: (patch: { tier?: Tier | null; disabled?: boolean }) =>
      api.patch<McpServerView>(toolPath(serverId, t.name), patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: MCP_SERVERS_KEY });
      const prev = queryClient.getQueryData<McpServerView[]>(MCP_SERVERS_KEY);
      queryClient.setQueryData<McpServerView[]>(MCP_SERVERS_KEY, (l) =>
        l?.map((s) =>
          s.id !== serverId
            ? s
            : {
                ...s,
                tools: s.tools.map((x) =>
                  x.name !== t.name
                    ? x
                    : {
                        ...x,
                        ...(patch.disabled !== undefined && { disabled: patch.disabled }),
                        ...(patch.tier !== undefined && {
                          tier: patch.tier ?? x.default_tier,
                          overridden: patch.tier !== null,
                        }),
                      },
                ),
              },
        ),
      );
      return { prev };
    },
    onSuccess: (saved) => saved && putServer(queryClient, saved),
    onError: (e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(MCP_SERVERS_KEY, ctx.prev);
      reportFailure(e, 'Changing the tool');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TOOLS_KEY }),
  });

  return (
    <li className="mcp-tool" data-off={t.disabled || undefined}>
      <div className="mcp-tool__text">
        <span className="mcp-tool__name">
          <code>{t.name}</code>
          {t.overridden ? <span className="mcp__badge">Changed</span> : null}
          {t.destructive ? <span className="mcp-tool__flag mute">Changes things</span> : null}
          {t.read_only && !t.destructive ? <span className="mcp-tool__flag mute">Only reads</span> : null}
        </span>
        {t.description ? <p className="mute">{t.description}</p> : null}
      </div>
      <div className="mcp-tool__ctl">
        <TierBadge tier={t.tier} />
        <select
          className="input input--sm mcp-tool__tier"
          aria-label={`How ${t.name} asks`}
          value={t.overridden ? t.tier : ''}
          disabled={t.disabled}
          onChange={(e) => update.mutate({ tier: e.target.value ? (e.target.value as Tier) : null })}
        >
          {tierOptions(t).map((o) => (
            <option key={o.value || 'default'} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Switch
          checked={!t.disabled}
          onChange={(on) => update.mutate({ disabled: !on })}
          label={`Let the assistant use ${t.name}`}
        />
      </div>
    </li>
  );
}
