/**
 * ------------------------------------------------------------------
 *  Title    |  defineTool
 *  Ref      |  DESIGN.md §5.2, §12
 *  ID       |  plugin-sdk
 * ------------------------------------------------------------------
 *  Purpose  |  Every custom tool in Ancile is an MCP server. This adds
 *           |  what MCP alone does not carry: the permission action,
 *           |  how to turn arguments into a resource URI, a tier, and
 *           |  whether the action is destructive (which floors it).
 *  How      |  defineTool() returns a plain descriptor. toMcpRegistration()
 *           |  produces the name/config/handler triple for
 *           |  McpServer.registerTool, with the standard hints set and
 *           |  Ancile's extras under _meta['sh.nvx.ancile/*'].
 * ------------------------------------------------------------------
 */

import type { Tier } from '@nvx/contracts';
import type { z } from 'zod';

export const META_PREFIX = 'sh.nvx.ancile';

export interface ToolContext {
  /** Present when Ancile invoked the tool; idempotency key for side effects. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodTypeAny, R> {
  name: string;
  description: string;
  input: S;
  /** Permission action, e.g. "fs.read", "http.post", "mcp.github.create_issue" */
  action: string;
  tier: Tier;
  destructive?: boolean;
  /** Arguments → resource URI the permission check runs against, e.g. fs:/workspace/a.md */
  resource: (args: z.infer<S>) => string;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<R>;
}

export function defineTool<S extends z.ZodTypeAny, R>(def: ToolDefinition<S, R>): ToolDefinition<S, R> {
  if (def.destructive && def.tier === 'auto') {
    throw new Error(`Tool ${def.name}: a destructive action can never be AUTO (DESIGN.md §5.2)`);
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(def.action)) {
    throw new Error(`Tool ${def.name}: action "${def.action}" must look like "namespace.verb"`);
  }
  return def;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Tier → standard MCP hints, which other MCP clients also understand. */
export function annotationsFor(
  def: Pick<ToolDefinition<z.ZodTypeAny, unknown>, 'tier' | 'destructive' | 'name'>,
): McpToolAnnotations {
  return {
    title: def.name,
    readOnlyHint: def.tier === 'auto',
    destructiveHint: def.destructive === true || def.tier === 'critical',
  };
}

export function toMcpRegistration<S extends z.ZodTypeAny, R>(def: ToolDefinition<S, R>) {
  return {
    name: def.name,
    config: {
      description: def.description,
      inputSchema: def.input,
      annotations: annotationsFor(def),
      _meta: {
        [`${META_PREFIX}/action`]: def.action,
        [`${META_PREFIX}/tier`]: def.tier,
        [`${META_PREFIX}/destructive`]: def.destructive === true,
      },
    },
    handler: async (args: z.infer<S>, extra?: { signal?: AbortSignal; _meta?: Record<string, unknown> }) => {
      const key = extra?._meta?.[`${META_PREFIX}/idempotency_key`];
      const result = await def.handler(args, {
        ...(typeof key === 'string' && { idempotencyKey: key }),
        ...(extra?.signal && { signal: extra.signal }),
      });
      return {
        content: [
          { type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) },
        ],
      };
    },
  };
}
