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
});
export type McpToolView = z.infer<typeof McpToolView>;

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
});
export type McpServerView = z.infer<typeof McpServerView>;
