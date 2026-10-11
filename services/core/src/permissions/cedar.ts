/**
 * ------------------------------------------------------------------
 *  Title    |  Cedar policies
 *  Ref      |  DESIGN.md §5.3, config/policies/*.cedar
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Admin-authored rules: hard forbids, and tier escalation
 *           |  (a permit annotated @escalate("critical") that matches
 *           |  lifts the tier). Grants are not Cedar; they are the hot
 *           |  path and live in Postgres.
 *  How      |  base.cedar, the chosen preset-<name>.cedar and any other
 *           |  non-preset file are split into single policies and
 *           |  sorted into two sets:
 *           |    forbids    every `forbid`, plus one catch-all permit;
 *           |               a deny means a forbid matched
 *           |    escalators every @escalate permit; an allow means
 *           |               one matched, and its annotation says how far
 *           |  The WASM module is imported lazily, once.
 *           |  BuiltinPolicy keeps the essential rules when no policy
 *           |  files exist or they fail to parse (and the boot test
 *           |  says which file and line).
 * ------------------------------------------------------------------
 */

import type { Tier } from '@nvx/contracts';
import type { PolicyEvaluator } from './decide';
import { scheme } from './normalize';

/**
 * What an outside app (an MCP client of Ancile's /mcp, or an `external:`
 * principal) may ever do, whatever it has been granted: read. Keep in step
 * with `base.external-read-only` in config/policies/base.cedar.
 */
export const EXTERNAL_READ_ACTIONS = ['knowledge.search', 'notebooks.read', 'memory.read'] as const;

export const isExternal = (principal: string) =>
  principal.startsWith('mcp:') || principal.startsWith('external:');

/** Writes, deletes and executions outside the workspace are always critical; outside apps only read. */
export class BuiltinPolicy implements PolicyEvaluator {
  async forbids(req?: { principal: string; action: string }) {
    if (
      req &&
      isExternal(req.principal) &&
      !(EXTERNAL_READ_ACTIONS as readonly string[]).includes(req.action)
    )
      return { forbidden: true, policyId: 'base.external-read-only' };
    return { forbidden: false };
  }

  async escalation(req: {
    action: string;
    outsideRoot: boolean;
    resource: string;
    automation?: boolean;
  }): Promise<Tier | null> {
    // Keep in step with base.escalate-automations: nobody is watching an automation.
    if (req.automation && req.action !== 'fs.read' && req.action !== 'fs.list') return 'critical';
    const writes = /\.(write|delete|move|exec|chmod)$/.test(req.action) || req.action.startsWith('shell.');
    if (req.resource.startsWith('fs:') && req.outsideRoot && writes) return 'critical';
    if (/\.(send|pay|terminate|push|publish)$/.test(req.action)) return 'critical';
    return null;
  }
}

export interface CedarPolicySet {
  /** Source text keyed by file name, for error messages that point somewhere. */
  files: Record<string, string>;
  /** Which preset file to include (preset-<name>.cedar); others are skipped. */
  preset?: string | null;
}

export class PolicyParseError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'PolicyParseError';
  }
}

type Cedar = typeof import('@cedar-policy/cedar-wasm/nodejs');
let cedarModule: Promise<Cedar> | null = null;
const loadCedar = () => (cedarModule ??= import('@cedar-policy/cedar-wasm/nodejs'));

interface ParsedPolicy {
  key: string;
  id: string;
  text: string;
  effect: 'permit' | 'forbid';
  escalate: Tier | null;
}

const annotation = (text: string, name: string) => new RegExp(`@${name}\\("([^"]*)"\\)`).exec(text)?.[1];

/** Resource URI → the Cedar entity attributes policies test against. */
export function resourceAttrs(
  resource: string,
  outsideRoot: boolean,
): { scheme: string; path: string; host: string; workspace: boolean } {
  const s = scheme(resource);
  const rest = resource.slice(s.length + 1);
  let path = rest;
  let host = '';
  if (s === 'http') {
    try {
      const u = new URL(rest);
      host = u.hostname;
      path = u.pathname;
    } catch {
      /* not a URL: keep the raw text */
    }
  }
  return { scheme: s, path, host, workspace: !outsideRoot };
}

function principalUid(principal: string): { type: string; id: string } {
  if (principal.startsWith('agent:')) return { type: 'Ancile::Agent', id: principal.slice(6) };
  if (principal.startsWith('external:')) return { type: 'Ancile::External', id: principal.slice(9) };
  // Apps connected to Ancile's own MCP server are outside apps too.
  if (principal.startsWith('mcp:')) return { type: 'Ancile::External', id: principal.slice(4) };
  return { type: 'Ancile::User', id: principal };
}

export class CedarPolicy implements PolicyEvaluator {
  private constructor(
    private readonly cedar: Cedar,
    private readonly forbidSet: Record<string, string>,
    private readonly escalateSet: Record<string, string>,
    private readonly byKey: Map<string, ParsedPolicy>,
  ) {}

  static async load(set: CedarPolicySet): Promise<CedarPolicy> {
    const cedar = await loadCedar();
    const policies: ParsedPolicy[] = [];
    const files = Object.entries(set.files)
      .filter(([f]) => !f.startsWith('preset-') || f === `preset-${set.preset ?? 'balanced'}.cedar`)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [file, text] of files) {
      const parts = cedar.policySetTextToParts(text);
      if (parts.type === 'failure')
        throw new PolicyParseError(file, parts.errors.map((e) => e.message).join('; '));
      parts.policies.forEach((p, i) => {
        const effect = /^\s*(?:@[\w]+\("[^"]*"\)\s*)*forbid\b/.test(p) ? 'forbid' : 'permit';
        const esc = annotation(p, 'escalate');
        policies.push({
          key: `${file.replace(/\W/g, '_')}_${i}`,
          id: annotation(p, 'id') ?? `${file}#${i + 1}`,
          text: p,
          effect,
          escalate: esc === 'critical' || esc === 'gated' ? esc : null,
        });
      });
    }
    const forbidSet: Record<string, string> = { __allow_all: 'permit (principal, action, resource);' };
    const escalateSet: Record<string, string> = {};
    for (const p of policies) {
      if (p.effect === 'forbid') forbidSet[p.key] = p.text;
      else if (p.escalate) escalateSet[p.key] = p.text;
    }
    const byKey = new Map(policies.map((p) => [p.key, p] as const));
    const evaluator = new CedarPolicy(cedar, forbidSet, escalateSet, byKey);
    // Fail at load, not at the first tool call: evaluate once against a dummy request.
    evaluator.authorize(evaluator.forbidSet, {
      principal: 'user',
      action: 'fs.read',
      resource: 'fs:/workspace',
      outsideRoot: false,
    });
    return evaluator;
  }

  get policyIds(): string[] {
    return [...this.byKey.values()].map((p) => p.id);
  }

  private authorize(
    policies: Record<string, string>,
    req: { principal: string; action: string; resource: string; outsideRoot: boolean; automation?: boolean },
  ) {
    if (Object.keys(policies).length === 0) return { decision: 'deny' as const, reason: [] as string[] };
    const resourceUid = { type: 'Ancile::Resource', id: req.resource };
    const ans = this.cedar.isAuthorized({
      principal: principalUid(req.principal),
      action: { type: 'Ancile::Action', id: req.action },
      resource: resourceUid,
      context: { thread: '', notebook: '', run_kind: 'chat_turn', automation: req.automation ?? false },
      policies: { staticPolicies: policies },
      entities: [{ uid: resourceUid, attrs: resourceAttrs(req.resource, req.outsideRoot), parents: [] }],
    });
    if (ans.type === 'failure')
      throw new Error(`Cedar could not evaluate the request: ${ans.errors.map((e) => e.message).join('; ')}`);
    return { decision: ans.response.decision, reason: ans.response.diagnostics.reason };
  }

  async forbids(req: { principal: string; action: string; resource: string; outsideRoot: boolean }) {
    const r = this.authorize(this.forbidSet, req);
    if (r.decision === 'allow') return { forbidden: false };
    const hit = r.reason.map((k) => this.byKey.get(k)).find(Boolean);
    return { forbidden: true, ...(hit && { policyId: hit.id }) };
  }

  async escalation(req: {
    principal: string;
    action: string;
    resource: string;
    outsideRoot: boolean;
    automation?: boolean;
  }): Promise<Tier | null> {
    const r = this.authorize(this.escalateSet, req);
    if (r.decision !== 'allow') return null;
    const tiers = r.reason.map((k) => this.byKey.get(k)?.escalate).filter((t): t is Tier => !!t);
    return tiers.includes('critical') ? 'critical' : (tiers[0] ?? null);
  }
}

/**
 * What a preset eases. Only Hands-off eases anything: writing a file inside
 * the workspace no longer asks. Never for a destructive action, never outside
 * the workspace, never for an outside app; base.cedar can still raise it
 * (an unattended automation, for one, still asks every time).
 */
export const PRESET_AUTO: Record<string, readonly string[]> = { hands_off: ['fs.write'] };

export function presetRelax(preset: string | null | undefined): PolicyEvaluator['relax'] {
  const eased = PRESET_AUTO[preset ?? ''] ?? [];
  return (req) =>
    eased.includes(req.action) &&
    req.toolTier === 'gated' &&
    !req.destructive &&
    !req.outsideRoot &&
    req.resource.startsWith('fs:') &&
    !isExternal(req.principal)
      ? 'auto'
      : null;
}

/** Cedar plus the built-in floor: a policy can only add strictness. */
export class LayeredPolicy implements PolicyEvaluator {
  constructor(
    private readonly layers: PolicyEvaluator[],
    readonly relax?: PolicyEvaluator['relax'],
  ) {}

  async forbids(req: Parameters<PolicyEvaluator['forbids']>[0]) {
    for (const l of this.layers) {
      const r = await l.forbids(req);
      if (r.forbidden) return r;
    }
    return { forbidden: false };
  }

  async escalation(req: Parameters<PolicyEvaluator['escalation']>[0]): Promise<Tier | null> {
    let tier: Tier | null = null;
    for (const l of this.layers) {
      const t = await l.escalation(req);
      if (t === 'critical') return t;
      tier ??= t;
    }
    return tier;
  }
}

export async function loadCedarEvaluator(policies: CedarPolicySet): Promise<PolicyEvaluator> {
  const relax = presetRelax(policies.preset);
  if (Object.keys(policies.files).length === 0) return new LayeredPolicy([new BuiltinPolicy()], relax);
  return new LayeredPolicy([await CedarPolicy.load(policies), new BuiltinPolicy()], relax);
}
