/**
 * ------------------------------------------------------------------
 *  Title    |  What a flow node still needs
 *  Ref      |  ROADMAP FW2, DESIGN.md §16
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Turn "needs an API key" in a lint list into a plain
 *           |  statement on the node: what is missing, why the node
 *           |  needs it, and which place fixes it.
 *  How      |  Pure. Reads a node, the models Core lists, the MCP
 *           |  servers and the connected GPU credential; returns the
 *           |  needs with the fix each one opens. The chip and its
 *           |  dialog (SetupChip.tsx) show them; the answer is
 *           |  recomputed from live data, so a fixed need disappears
 *           |  by itself once the data refreshes.
 *  Note     |  A GPU node asleep is not a need: it wakes on use.
 * ------------------------------------------------------------------
 */

import type { FlowNode, McpServerView } from '@nvx/contracts';
import { modelOf, providerOf } from './kinds';
import type { FlowModel } from './models';

/** Where the fix happens. `key` and `runpod` are done inline in a dialog; the rest open their place. */
export type SetupFix =
  | { kind: 'key'; credential: string }
  | { kind: 'runpod' }
  | { kind: 'claude' }
  | { kind: 'enable-model'; model: string }
  | { kind: 'choose-model' }
  | { kind: 'mcp'; server: string | null; status: McpServerView['status'] | 'missing' };

export interface SetupNeed {
  node_id: string;
  /** Stable code, for tests and the help centre. */
  code:
    | 'key'
    | 'runpod'
    | 'claude_sign_in'
    | 'model_off'
    | 'model_unknown'
    | 'test_model'
    | 'mcp_down'
    | 'mcp_missing';
  /** What is missing, in a few words (the chip). */
  missing: string;
  /** Why this node needs it, in a sentence. */
  why: string;
  /** The label of the button. */
  action: string;
  fix: SetupFix;
}

export interface SetupContext {
  models: Map<string, FlowModel>;
  /** From GET /mcp/servers; undefined while it has not answered. */
  servers: McpServerView[] | undefined;
  /** Whether the RunPod key is saved. */
  runpodConnected: boolean | undefined;
}

const name = (n: FlowNode) => n.label || n.id;
const realAndReady = (m: FlowModel) => !m.offline && m.chat && m.status === 'ready';

/**
 * The server an MCP tool belongs to, or null for any other tool. The assistant sees
 * `<server>__<tool>`; a server name may hold a single underscore, so a known name wins.
 */
export function mcpServerOf(tool: string, known: string[] = []): string | null {
  const own = known.filter((n) => tool.startsWith(`${n}__`)).sort((a, b) => b.length - a.length)[0];
  if (own) return own;
  const m = /^([a-z0-9][a-z0-9_-]*?)__./.exec(tool);
  return m ? (m[1] as string) : null;
}

function toolsOf(n: FlowNode): string[] {
  if (n.kind === 'tool') return n.params.tool ? [n.params.tool] : [];
  if (n.kind === 'model' || n.kind === 'manager') return n.params.tools;
  return [];
}

export function setupNeeds(n: FlowNode, ctx: SetupContext): SetupNeed[] {
  if (n.disabled) return [];
  const out: SetupNeed[] = [];
  const id = modelOf(n);
  if (id && ctx.models.size) {
    const m = ctx.models.get(id);
    if (!m) {
      out.push({
        node_id: n.id,
        code: 'model_unknown',
        missing: 'A model that is not in your list',
        why: `${name(n)} calls ${id}, which this workspace does not have.`,
        action: 'Choose a model',
        fix: { kind: 'enable-model', model: id },
      });
    } else if (m.offline && [...ctx.models.values()].some(realAndReady)) {
      // TO2: a flow saved with a test model (no AI) once a real model is ready.
      out.push({
        node_id: n.id,
        code: 'test_model',
        missing: 'A real model',
        why: `${name(n)} uses ${m.name}, a test model that does not use AI. Choose a model that does.`,
        action: 'Choose a model',
        fix: { kind: 'choose-model' },
      });
    } else if (m.via === 'controller' && m.status !== 'ready' && m.status !== 'disabled') {
      out.push({
        node_id: n.id,
        code: 'runpod',
        missing: 'A connected GPU provider',
        why: `${name(n)} runs ${m.name} on a GPU node, and no GPU provider is connected.`,
        action: 'Connect RunPod',
        fix: { kind: 'runpod' },
      });
    } else if (m.status === 'needs_key') {
      out.push({
        node_id: n.id,
        code: 'key',
        missing: 'An API key',
        why: `${name(n)} calls ${m.name}, and it answers only with your ${providerLabel(m.provider)} key.`,
        action: 'Add the key',
        fix: { kind: 'key', credential: providerOf(m.id) },
      });
    } else if (m.status === 'signed_out') {
      out.push({
        node_id: n.id,
        code: 'claude_sign_in',
        missing: 'Claude Code signed in',
        why: `${name(n)} calls ${m.name}, which runs through your Claude Code sign-in.`,
        action: 'Open Claude Code settings',
        fix: { kind: 'claude' },
      });
    } else if (m.status === 'disabled') {
      out.push({
        node_id: n.id,
        code: 'model_off',
        missing: 'The model switched on',
        why: `${name(n)} calls ${m.name}, which is switched off.`,
        action: 'Switch it on',
        fix: { kind: 'enable-model', model: m.id },
      });
    }
  }
  // MCP tools: the server must exist, be on, and be connected.
  if (ctx.servers) {
    const seen = new Set<string>();
    for (const tool of toolsOf(n)) {
      const sname = mcpServerOf(
        tool,
        ctx.servers.map((x) => x.name),
      );
      if (!sname || seen.has(sname)) continue;
      seen.add(sname);
      const s = ctx.servers.find((x) => x.name === sname);
      if (!s) {
        out.push({
          node_id: n.id,
          code: 'mcp_missing',
          missing: `The ${sname} server`,
          why: `${name(n)} uses ${tool}, and no MCP server called ${sname} is set up.`,
          action: 'Add the server',
          fix: { kind: 'mcp', server: null, status: 'missing' },
        });
      } else if (s.status !== 'connected') {
        out.push({
          node_id: n.id,
          code: 'mcp_down',
          missing: `${sname} connected`,
          why:
            s.status === 'disabled'
              ? `${name(n)} uses ${tool}, and the ${sname} server is switched off.`
              : `${name(n)} uses ${tool}, and the ${sname} server is not connected${s.last_error ? `: ${s.last_error}` : '.'}`,
          action: s.status === 'disabled' ? 'Switch it on' : 'Open the server',
          fix: { kind: 'mcp', server: s.id, status: s.status },
        });
      }
    }
  }
  return out;
}

function providerLabel(p: string): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** Every node's needs, by node id. */
export function setupByNode(nodes: FlowNode[], ctx: SetupContext): Map<string, SetupNeed[]> {
  const m = new Map<string, SetupNeed[]>();
  for (const n of nodes) {
    const needs = setupNeeds(n, ctx);
    if (needs.length) m.set(n.id, needs);
  }
  return m;
}
