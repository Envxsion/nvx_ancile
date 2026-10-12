/**
 * ------------------------------------------------------------------
 *  Title    |  MCP servers NVX Ancile uses
 *  Ref      |  docs/plugins.md · DESIGN.md (tools and permissions)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One shape for the servers Core connects to as an MCP
 *           |  host: what the UI lists, what it sends to add or change
 *           |  one, and the per-tool settings people can override.
 *  How      |  Servers added in the app live in core.mcp_servers; their
 *           |  secret values go to the encrypted secret store and come
 *           |  back only as `set: true`. Servers in config/mcp.yaml are
 *           |  listed too, read-only (source "file").
 *  Note     |  A secret is an env var (stdio) or a request header (http).
 *           |  Leaving a secret's value out on update keeps the stored one.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import { Tier } from './events';

/** Lower-case, used in tool names (`<server>__<tool>`) and resources (`mcp:<server>/<tool>`). */
export const McpServerName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,39}$/,
    'Use 1 to 40 lower-case letters, digits, - or _, starting with a letter or digit.',
  );

const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Not a valid environment variable name.');
const HeaderKey = z.string().regex(/^[A-Za-z0-9-]{1,128}$/, 'Not a valid header name.');

/** A secret as sent: `value` absent keeps what is stored (update only). */
export const McpSecretInput = z
  .object({ key: z.string().min(1).max(128), value: z.string().min(1).max(8_000).optional() })
  .strict();
export type McpSecretInput = z.infer<typeof McpSecretInput>;

/** A secret as shown: never its value. */
export const McpSecretView = z.object({ key: z.string(), set: z.boolean() });
export type McpSecretView = z.infer<typeof McpSecretView>;

const stdioFields = {
  transport: z.literal('stdio'),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(2_000)).max(64).default([]),
  /** Plain (non-secret) environment, e.g. LOG_LEVEL. */
  env: z.record(EnvKey, z.string().max(4_000)).default({}),
  /** Secret environment variables, stored encrypted. */
  secrets: z
    .array(McpSecretInput.extend({ key: EnvKey }))
    .max(32)
    .default([]),
};
const httpFields = {
  transport: z.literal('http'),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'Use an http or https address.'),
  /** Plain request headers. */
  headers: z.record(HeaderKey, z.string().max(4_000)).default({}),
  /** Secret request headers, e.g. Authorization: Bearer …, stored encrypted. */
  secrets: z
    .array(McpSecretInput.extend({ key: HeaderKey }))
    .max(32)
    .default([]),
};

export const CreateMcpServerRequest = z.discriminatedUnion('transport', [
  z.object({ name: McpServerName, enabled: z.boolean().default(true), ...stdioFields }).strict(),
  z.object({ name: McpServerName, enabled: z.boolean().default(true), ...httpFields }).strict(),
]);
export type CreateMcpServerRequest = z.infer<typeof CreateMcpServerRequest>;

/**
 * PATCH /mcp/servers/:id. The transport cannot change (remove and add
 * again). `secrets`, when sent, is the whole list: keys left out are
 * deleted, keys without a value keep the stored one.
 */
export const UpdateMcpServerRequest = z
  .object({
    name: McpServerName,
    enabled: z.boolean(),
    command: stdioFields.command,
    args: stdioFields.args.unwrap(),
    env: stdioFields.env.unwrap(),
    url: httpFields.url,
    headers: httpFields.headers.unwrap(),
    secrets: z.array(McpSecretInput).max(32),
  })
  .partial()
  .strict();
export type UpdateMcpServerRequest = z.infer<typeof UpdateMcpServerRequest>;

/** PATCH /mcp/servers/:id/tools/:tool. `tier: null` goes back to the server's own hint. */
export const UpdateMcpToolRequest = z
  .object({ tier: Tier.nullable(), disabled: z.boolean() })
  .partial()
  .strict();
export type UpdateMcpToolRequest = z.infer<typeof UpdateMcpToolRequest>;

export const McpServerStatus = z.enum(['connecting', 'connected', 'error', 'disabled']);
export type McpServerStatus = z.infer<typeof McpServerStatus>;

export const McpToolView = z.object({
  /** The tool's name on its server. */
  name: z.string(),
  /** The name the assistant sees (`<server>__<tool>`). */
  id: z.string(),
  description: z.string(),
  /** What applies now, after any override. */
  tier: Tier,
  /** What the server's own hints (or SDK metadata) give. */
  default_tier: Tier,
  /** True when someone set the tier here. */
  overridden: z.boolean(),
  disabled: z.boolean(),
  destructive: z.boolean(),
  read_only: z.boolean(),
  /** Added or changed since the server was approved: refused until you approve its new list. */
  held: z.boolean().optional(),
});
export type McpToolView = z.infer<typeof McpToolView>;

/**
 * Who runs the server: NVX Ancile's own MCP host, or Claude Code (its
 * servers, seen from a live session).
 */
export const McpToolOrigin = z.enum(['host', 'claude_code']);
export type McpToolOrigin = z.infer<typeof McpToolOrigin>;

/** Tool names that came, went or changed since the list was approved. */
export const McpToolDiff = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type McpToolDiff = z.infer<typeof McpToolDiff>;

/**
 * The tool list a server was approved with, and whether it still offers that
 * list. A server's list is fingerprinted when it is first added (SHA-256 over
 * canonical JSON of each tool's name, description and input schema). Any
 * change after that ("changed") refuses its new and changed tools until you
 * approve the new list once.
 */
export const McpToolApproval = z.object({
  /** `<origin>:<server name>`. */
  key: z.string(),
  origin: McpToolOrigin,
  server: z.string(),
  state: z.enum(['approved', 'changed']),
  approved_fingerprint: z.string(),
  /** What the server offers now; equal to approved_fingerprint while approved. */
  current_fingerprint: z.string(),
  approved_at: z.string(),
  changed_at: z.string().nullable(),
  /** Against the approved list; null while approved. */
  diff: McpToolDiff.nullable(),
  /**
   * `full`: names, descriptions and input schemas. `names`: Claude Code
   * reports its servers' tool names only, so only those are compared.
   */
  coverage: z.enum(['full', 'names']),
});
export type McpToolApproval = z.infer<typeof McpToolApproval>;

/**
 * POST /mcp/approvals/:key/approve. The fingerprint you were shown: if the
 * server changed again since, nothing is approved (mcp.tools_changed_again).
 */
export const ApproveMcpToolsRequest = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ApproveMcpToolsRequest = z.infer<typeof ApproveMcpToolsRequest>;

export const McpServerView = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  /** "app": added here, editable. "file": config/mcp.yaml, read-only here. */
  source: z.enum(['app', 'file']),
  enabled: z.boolean(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  url: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  secrets: z.array(McpSecretView),
  status: McpServerStatus,
  /** What went wrong, in words, when status is "error". */
  last_error: z.string().nullable(),
  connected_at: z.string().nullable(),
  /** Tools the server offers, with the settings that apply. Empty until connected. */
  tools: z.array(McpToolView),
  /** Its approved tool list, once it has connected. Optional for older Cores. */
  approval: McpToolApproval.nullable().optional(),
});
export type McpServerView = z.infer<typeof McpServerView>;
