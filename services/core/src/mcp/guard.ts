/**
 * ------------------------------------------------------------------
 *  Title    |  MCP tool lists you approved (rug-pull guard)
 *  Ref      |  docs/plugins.md (When a server changes its tools)
 *           |  · packages/contracts/src/mcp.ts (McpToolApproval)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  An MCP server you approved can change its tools later:
 *           |  add one, or give an old one a new description or
 *           |  schema that tells the model something else. Notice it,
 *           |  refuse the new and changed tools until you approve the
 *           |  new list once, and let the unchanged ones carry on.
 *  How      |  A server's list is fingerprinted the first time it is
 *           |  seen (when you add it), and that list is the approved
 *           |  one. Every (re)connect and tools/list_changed observes
 *           |  the list again. On a change: the server is "changed",
 *           |  its grants are revoked, cached Auto mode verdicts for
 *           |  its tools are forgotten, the Cockpit is told once
 *           |  (mcp.tools_changed and a notification), and check()
 *           |  refuses its new and changed tools in the gate. approve()
 *           |  takes the fingerprint you were shown, so a list that
 *           |  changed again meanwhile is never approved unseen.
 *           |  What is fingerprinted has a version (fingerprint.ts). A
 *           |  list is made at version 2 now (name, description, schema,
 *           |  annotations and Ancile's tier, action and destructive
 *           |  meta). A row made before it is version 1 and is compared
 *           |  as it was made; the first time its server lists tools that
 *           |  still match, it is moved up to version 2 silently and
 *           |  once: nothing is revoked, announced or asked again.
 *  Note     |  Two origins: NVX Ancile's host (manager.ts) and Claude
 *           |  Code's own servers (claude-code-watch.ts), keyed apart,
 *           |  so a server name can exist in both. A server never seen
 *           |  has no record and its tools are not refused here.
 * ------------------------------------------------------------------
 */

import { AncileError, type McpToolApproval, type McpToolDiff, type McpToolOrigin } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { PermissionStore } from '../permissions/store';
import {
  diffTools,
  emptyDiff,
  FINGERPRINT_VERSION,
  type FingerprintTool,
  listFingerprint,
  type ToolHashes,
  toolHashes,
  toolHashesV2,
} from './fingerprint';

const log = logFor('mcp');

/** The principal Claude Code's tool calls are decided as (claudecode/permission-map.ts). */
const CLAUDE_CODE_PRINCIPAL = 'agent:claude-code';

export interface ApprovalRow {
  origin: McpToolOrigin;
  server: string;
  approved_tools: ToolHashes;
  approved_fingerprint: string;
  approved_at: string;
  current_tools: ToolHashes;
  current_fingerprint: string;
  changed_at: string | null;
  coverage: 'full' | 'names';
  /** What the hashes cover (fingerprint.ts): 1 before 0048, 2 now. Absent reads as 1. */
  fingerprint_version?: number;
}

export interface McpApprovalStore {
  list(): Promise<ApprovalRow[]>;
  put(row: ApprovalRow): Promise<void>;
  remove(origin: McpToolOrigin, server: string): Promise<void>;
}

export class MemoryMcpApprovalStore implements McpApprovalStore {
  readonly rows = new Map<string, ApprovalRow>();
  async list() {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async put(row: ApprovalRow) {
    this.rows.set(approvalKey(row.origin, row.server), structuredClone(row));
  }
  async remove(origin: McpToolOrigin, server: string) {
    this.rows.delete(approvalKey(origin, server));
  }
}

interface Row {
  origin: McpToolOrigin;
  server: string;
  approved_tools: ToolHashes;
  approved_fingerprint: string;
  approved_at: Date;
  current_tools: ToolHashes;
  current_fingerprint: string;
  changed_at: Date | null;
  coverage: 'full' | 'names';
  fingerprint_version: number;
}

export class PgMcpApprovalStore implements McpApprovalStore {
  constructor(private readonly sql: Sql) {}

  async list() {
    const rows = await this.sql<Row[]>`select * from core.mcp_tool_approvals`;
    return rows.map((r) => ({
      ...r,
      approved_at: r.approved_at.toISOString(),
      changed_at: r.changed_at ? r.changed_at.toISOString() : null,
    }));
  }

  async put(r: ApprovalRow) {
    const j = (v: unknown) => this.sql.json(v as never);
    await this.sql`
      insert into core.mcp_tool_approvals
        (origin, server, approved_tools, approved_fingerprint, approved_at,
         current_tools, current_fingerprint, changed_at, coverage, fingerprint_version)
      values (${r.origin}, ${r.server}, ${j(r.approved_tools)}, ${r.approved_fingerprint}, ${r.approved_at},
              ${j(r.current_tools)}, ${r.current_fingerprint}, ${r.changed_at}, ${r.coverage},
              ${r.fingerprint_version ?? 1})
      on conflict (origin, server) do update set
        approved_tools = excluded.approved_tools,
        approved_fingerprint = excluded.approved_fingerprint,
        approved_at = excluded.approved_at,
        current_tools = excluded.current_tools,
        current_fingerprint = excluded.current_fingerprint,
        changed_at = excluded.changed_at,
        coverage = excluded.coverage,
        fingerprint_version = excluded.fingerprint_version`;
  }

  async remove(origin: McpToolOrigin, server: string) {
    await this.sql`delete from core.mcp_tool_approvals where origin = ${origin} and server = ${server}`;
  }
}

export const approvalKey = (origin: McpToolOrigin, server: string) => `${origin}:${server}`;

export function parseApprovalKey(key: string): { origin: McpToolOrigin; server: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const origin = key.slice(0, i);
  const server = key.slice(i + 1);
  if ((origin !== 'host' && origin !== 'claude_code') || !server) return null;
  return { origin, server };
}

/** An MCP action's server and tool: `mcp.<server>.<tool>`. */
export function mcpAction(action: string): { server: string; tool: string } | null {
  const m = /^mcp\.([^.]+)\.(.+)$/.exec(action);
  return m ? { server: m[1] as string, tool: m[2] as string } : null;
}

export const originOf = (principal: string): McpToolOrigin =>
  principal === CLAUDE_CODE_PRINCIPAL ? 'claude_code' : 'host';

const changedState = (r: ApprovalRow) => r.current_fingerprint !== r.approved_fingerprint;

function diffOf(r: ApprovalRow): McpToolDiff | null {
  return changedState(r) ? diffTools(r.approved_tools, r.current_tools) : null;
}

/** Tools that may not run until the new list is approved: new ones and changed ones. */
function heldOf(r: ApprovalRow): Set<string> {
  if (!changedState(r)) return new Set();
  const d = diffTools(r.approved_tools, r.current_tools);
  return new Set([...d.added, ...d.changed]);
}

export function toView(r: ApprovalRow): McpToolApproval {
  return {
    key: approvalKey(r.origin, r.server),
    origin: r.origin,
    server: r.server,
    state: changedState(r) ? 'changed' : 'approved',
    approved_fingerprint: r.approved_fingerprint,
    current_fingerprint: r.current_fingerprint,
    approved_at: r.approved_at,
    changed_at: changedState(r) ? r.changed_at : null,
    diff: diffOf(r),
    coverage: r.coverage,
  };
}

export type McpToolCheck = { ok: true } | { ok: false; reason: string; code: 'mcp.tools_changed' };

export interface McpGuardDeps {
  store: McpApprovalStore;
  /** Grants are revoked when a server's list changes. */
  grants?: Pick<PermissionStore, 'listGrants' | 'revokeGrant'>;
  /** Forget cached Auto mode verdicts for actions starting with this prefix. */
  forgetVerdicts?: (actionPrefix: string) => void;
  /** mcp.tools_changed and the notification. */
  bus?: Pick<EventBus, 'publish'>;
  now?: () => Date;
}

export interface Observed {
  state: 'approved' | 'changed';
  held: Set<string>;
  diff: McpToolDiff | null;
}

/** The literal start of a glob, up to its first wildcard. */
const literal = (p: string) => p.split('*')[0] ?? '';

export class McpToolGuard {
  private readonly rows = new Map<string, ApprovalRow>();
  private loading: Promise<void> | null = null;
  /** One observation at a time per server: a reconnect and a list_changed can race. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly approvedListeners = new Set<(origin: McpToolOrigin, server: string) => void>();
  private readonly now: () => Date;

  constructor(private readonly deps: McpGuardDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private load(): Promise<void> {
    this.loading ??= this.deps.store.list().then((rows) => {
      for (const r of rows) this.rows.set(approvalKey(r.origin, r.server), r);
    });
    return this.loading;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Called with a server whose new list was approved (the host re-registers its tools). */
  onApproved(fn: (origin: McpToolOrigin, server: string) => void): () => void {
    this.approvedListeners.add(fn);
    return () => this.approvedListeners.delete(fn);
  }

  /**
   * A server listed its tools. The first list is the approved one; a later
   * one that differs marks the server changed (once per new list).
   */
  observe(
    origin: McpToolOrigin,
    server: string,
    tools: FingerprintTool[],
    coverage: 'full' | 'names' = 'full',
  ): Promise<Observed> {
    const key = approvalKey(origin, server);
    return this.serial(key, async () => {
      await this.load();
      // What the list is now, at the version that is made today.
      const latest = toolHashesV2(tools);
      const latestFp = listFingerprint(latest);
      const at = this.now().toISOString();
      const prev = this.rows.get(key);
      // A row made before the fingerprint covered tiers and hints is compared as it was made.
      const legacy = prev !== undefined && (prev.fingerprint_version ?? 1) < FINGERPRINT_VERSION;
      const hashes = legacy ? toolHashes(tools) : latest;
      const fp = legacy ? listFingerprint(hashes) : latestFp;
      const sameNames = (a: ToolHashes, b: ToolHashes) =>
        Object.keys(a).sort().join('\u0000') === Object.keys(b).sort().join('\u0000');

      if (
        !prev ||
        (prev.coverage !== coverage && !changedState(prev) && sameNames(prev.approved_tools, hashes))
      ) {
        // First seen (just added), or what is compared changed with the same tools: this is the approved list.
        const row: ApprovalRow = {
          origin,
          server,
          approved_tools: latest,
          approved_fingerprint: latestFp,
          approved_at: prev?.approved_at ?? at,
          current_tools: latest,
          current_fingerprint: latestFp,
          changed_at: null,
          coverage,
          fingerprint_version: FINGERPRINT_VERSION,
        };
        await this.deps.store.put(row);
        this.rows.set(key, row);
        return { state: 'approved', held: new Set(), diff: null };
      }
      if (prev.current_fingerprint === fp) {
        // Still the list that was approved, as it was fingerprinted then: count it at version 2, silently.
        if (legacy && !changedState(prev)) return this.observed(await this.upgrade(prev, latest, latestFp));
        return this.observed(prev);
      }

      let row: ApprovalRow = {
        ...prev,
        current_tools: hashes,
        current_fingerprint: fp,
        changed_at: fp === prev.approved_fingerprint ? null : at,
      };
      await this.deps.store.put(row);
      this.rows.set(key, row);
      if (!changedState(row)) {
        // Back to the approved list (a legacy one, as it was fingerprinted): move it up to version 2 as well.
        if (legacy) row = await this.upgrade(row, latest, latestFp);
        log.info({ origin, server }, 'MCP server is back to the tools you approved');
        await this.announce(row);
        return this.observed(row);
      }
      const diff = diffTools(row.approved_tools, row.current_tools);
      log.warn(
        {
          origin,
          server,
          added: diff.added.length,
          removed: diff.removed.length,
          changed: diff.changed.length,
        },
        'MCP server changed its tools since they were approved; new and changed tools are refused',
      );
      await this.void(origin, server);
      await this.announce(row);
      return this.observed(row);
    });
  }

  /**
   * Move an approved, unchanged row from version 1 to version 2: the same list, now fingerprinted with the
   * tiers and hints. Quiet on purpose (nothing revoked, announced or asked again): what was approved did not change.
   */
  private async upgrade(r: ApprovalRow, hashes: ToolHashes, fp: string): Promise<ApprovalRow> {
    const row: ApprovalRow = {
      ...r,
      approved_tools: hashes,
      approved_fingerprint: fp,
      current_tools: hashes,
      current_fingerprint: fp,
      changed_at: null,
      fingerprint_version: FINGERPRINT_VERSION,
    };
    await this.deps.store.put(row);
    this.rows.set(approvalKey(r.origin, r.server), row);
    log.info(
      { origin: r.origin, server: r.server },
      'an MCP tool list was fingerprinted again with its tiers and hints',
    );
    return row;
  }

  private observed(r: ApprovalRow): Observed {
    return { state: changedState(r) ? 'changed' : 'approved', held: heldOf(r), diff: diffOf(r) };
  }

  /** Revoke the server's own grants and forget Auto mode's cached verdicts for its tools. */
  private async void(origin: McpToolOrigin, server: string) {
    const prefix = `mcp.${server}.`;
    this.deps.forgetVerdicts?.(prefix);
    const grants = this.deps.grants;
    if (!grants) return;
    try {
      for (const g of await grants.listGrants()) {
        if ((originOf(g.principal) === 'claude_code') !== (origin === 'claude_code')) continue;
        const lit = literal(g.action_pattern);
        if (lit.startsWith(prefix) || g.action_pattern === `mcp.${server}`) await grants.revokeGrant(g.id);
      }
    } catch (err) {
      log.warn(
        { server, err: (err as Error).message },
        'could not revoke the grants of a changed MCP server',
      );
    }
  }

  private async announce(r: ApprovalRow) {
    const bus = this.deps.bus;
    if (!bus) return;
    const d = diffOf(r) ?? { added: [], removed: [], changed: [] };
    const changed = changedState(r);
    try {
      await bus.publish({
        type: 'mcp.tools_changed',
        key: approvalKey(r.origin, r.server),
        origin: r.origin,
        server: r.server,
        state: changed ? 'changed' : 'approved',
        added: d.added.length,
        removed: d.removed.length,
        changed: d.changed.length,
      });
      if (changed && !emptyDiff(d)) {
        const parts = [
          d.added.length ? `${d.added.length} new` : '',
          d.changed.length ? `${d.changed.length} changed` : '',
          d.removed.length ? `${d.removed.length} removed` : '',
        ].filter(Boolean);
        await bus.publish({
          type: 'notification',
          id: `ntf_${ulid()}`,
          level: 'warn',
          title:
            r.origin === 'claude_code'
              ? `Claude Code's ${r.server} server changed its tools`
              : `${r.server} changed its tools`,
          body: `${parts.join(', ')} since you approved it. New and changed tools are refused until you review the change. Its saved permissions were cleared.`,
          action: { label: 'Review the change', href: '/admin/plugins' },
          category: 'health',
        });
      }
    } catch (err) {
      log.warn({ server: r.server, err: (err as Error).message }, 'could not announce an MCP tool change');
    }
  }

  /**
   * May this MCP call run as far as the approved list goes? Only a server's
   * new and changed tools are refused; unchanged ones carry on.
   */
  async check(principal: string, action: string): Promise<McpToolCheck> {
    const a = mcpAction(action);
    if (!a) return { ok: true };
    await this.load();
    const key = approvalKey(originOf(principal), a.server);
    // A list being observed right now (a session just started) is settled first.
    await this.queues.get(key);
    const r = this.rows.get(key);
    if (!r) return { ok: true };
    const approved = r.approved_tools[a.tool];
    if (approved !== undefined && (!changedState(r) || r.current_tools[a.tool] === approved))
      return { ok: true };
    const isNew = approved === undefined;
    return {
      ok: false,
      code: 'mcp.tools_changed',
      reason: `${a.server} ${isNew ? 'added' : 'changed'} ${a.tool} after you approved its tools. Review the change in Admin → Plugins before it can run`,
    };
  }

  /** The tools of a server that are refused right now. */
  held(origin: McpToolOrigin, server: string): Set<string> {
    const r = this.rows.get(approvalKey(origin, server));
    return r ? heldOf(r) : new Set();
  }

  async list(): Promise<McpToolApproval[]> {
    await this.load();
    return [...this.rows.values()].map(toView).sort((a, b) => a.key.localeCompare(b.key));
  }

  async view(origin: McpToolOrigin, server: string): Promise<McpToolApproval | null> {
    await this.load();
    const r = this.rows.get(approvalKey(origin, server));
    return r ? toView(r) : null;
  }

  /** Approve the list a server offers now; `fingerprint` must be the one you were shown. */
  approve(key: string, fingerprint: string): Promise<McpToolApproval> {
    const ref = parseApprovalKey(key);
    if (!ref) return Promise.reject(approvalNotFound());
    return this.serial(key, async () => {
      await this.load();
      const r = this.rows.get(key);
      if (!r) throw approvalNotFound();
      if (r.current_fingerprint !== fingerprint)
        throw new AncileError({
          code: 'mcp.tools_changed_again',
          title: `${r.server} changed its tools again`,
          hint: 'Look over the new list, then approve it.',
          status: 409,
          errorClass: 'permanent',
        });
      const row: ApprovalRow = {
        ...r,
        approved_tools: r.current_tools,
        approved_fingerprint: r.current_fingerprint,
        approved_at: this.now().toISOString(),
        changed_at: null,
      };
      await this.deps.store.put(row);
      this.rows.set(key, row);
      log.info({ origin: r.origin, server: r.server }, 'MCP server tool list approved');
      await this.announce(row);
      for (const fn of this.approvedListeners) {
        try {
          fn(r.origin, r.server);
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'an MCP approval listener failed');
        }
      }
      return toView(row);
    });
  }

  /** The server is gone (removed or renamed): adding it again starts a fresh approval. */
  forget(origin: McpToolOrigin, server: string): Promise<void> {
    const key = approvalKey(origin, server);
    return this.serial(key, async () => {
      await this.load();
      this.rows.delete(key);
      await this.deps.store.remove(origin, server);
    });
  }
}

const approvalNotFound = () =>
  new AncileError({
    code: 'mcp.not_found',
    title: 'That MCP server was not found',
    hint: 'It may have been removed. Refresh the list in Admin → Plugins.',
    status: 404,
    errorClass: 'permanent',
  });
