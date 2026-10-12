/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: choosing one per message
 *  Ref      |  docs/engines.md (Choosing an engine) · docs/scopes.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Decide which engine answers a turn, and refuse it before
 *           |  anything runs when the thread's scope does not allow it.
 *  How      |  The model id decides. `claude-code/<model>` is Claude
 *           |  Code: in a thread bound to a session it carries the
 *           |  session on (Mode B); anywhere else it is Claude Code as
 *           |  a model, answered through the gateway (Mode A). With no
 *           |  model, a bound thread carries its session on unless its
 *           |  own model says otherwise. Every other id is the gateway.
 *           |  The scope check (scopes/checkEngineAllowed) is given the
 *           |  engine, the model that would answer and whether it runs
 *           |  on this machine.
 *  Note     |  Read at send time, never cached: a scope narrowed a
 *           |  moment ago applies to the next message.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  CLAUDE_CODE_MODEL_PREFIX,
  type EffectiveScope,
  isClaudeCodeModel,
  type ModelConfig,
} from '@nvx/contracts';
import type { ModelRegistry } from '../gateway/registry';
import { checkEngineAllowed } from '../scopes';
import type { ThreadRecord } from '../threads/repo';

export interface Selection {
  engine: 'gateway' | 'claude_code';
  /** session: a live Claude Code session (Mode B); model: Claude Code as a model (Mode A); gateway. */
  mode: 'session' | 'model' | 'gateway';
  /** The model id as asked (null: the thread or route decides). */
  modelId: string | null;
  /** For a session: Claude Code's own model name ("opus"), null for its default. */
  engineModel: string | null;
  /** The model that would answer, for the scope check. */
  checkModel: string | null;
  /** It runs on this machine or a node you control. */
  local: boolean;
}

const LOCAL_PROVIDERS = new Set(['ollama', 'local', 'fake', 'node']);
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i;

/**
 * Does this model run on this machine, or a GPU node on your own network?
 * A node rented from a provider (a RunPod pod) does not: prompts leave this
 * machine for it, so a private or local-only scope never uses it.
 */
export function isLocalModel(m: Pick<ModelConfig, 'provider' | 'via' | 'base_url' | 'runs_on'>): boolean {
  if (m.runs_on === 'rented') return false;
  if (LOCAL_PROVIDERS.has(m.provider) || m.via === 'controller') return true;
  if (m.base_url) {
    try {
      return LOOPBACK.test(new URL(m.base_url).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/** Claude Code's own model name from `claude-code/<name>`; "default" means its default. */
export function claudeModelName(id: string | null): string | null {
  if (!id || !isClaudeCodeModel(id)) return null;
  const name = id.slice(CLAUDE_CODE_MODEL_PREFIX.length);
  return name && name !== 'default' ? name : null;
}

export function selectEngine(
  thread: Pick<ThreadRecord, 'settings'>,
  requested: string | null | undefined,
  opts: { registry: Pick<ModelRegistry, 'get' | 'chain'>; taskClass?: string },
): Selection {
  const asked = requested ?? null;
  const saved = thread.settings.model ?? null;
  const bound = !!thread.settings.claude_code?.session_id;
  if (bound && (asked === null ? !saved || isClaudeCodeModel(saved) : isClaudeCodeModel(asked))) {
    const id = asked ?? saved;
    return {
      engine: 'claude_code',
      mode: 'session',
      modelId: id,
      engineModel: claudeModelName(id),
      checkModel: id,
      local: false,
    };
  }
  let resolved = asked ?? saved;
  if (!resolved) {
    try {
      resolved = opts.registry.chain(opts.taskClass ?? 'chat.default', null)[0]?.id ?? null;
    } catch {
      resolved = null;
    }
  }
  if (isClaudeCodeModel(resolved))
    return {
      engine: 'claude_code',
      mode: 'model',
      modelId: asked,
      engineModel: null,
      checkModel: resolved,
      local: false,
    };
  const m = resolved ? opts.registry.get(resolved) : undefined;
  return {
    engine: 'gateway',
    mode: 'gateway',
    modelId: asked,
    engineModel: null,
    checkModel: resolved,
    // No model resolved: nothing is sent by this choice. A flow's steps are each
    // checked against the scope when they run (flows/turn.ts), and with no flow
    // the turn ends with "No model is ready", so a local-only scope must not
    // refuse a flow of local steps up front. An unknown model id stays refused.
    local: m ? isLocalModel(m) : resolved === null,
  };
}

/** The scope said no: what happened, and what to do. */
export function engineRefused(check: { code: string; reason: string }): AncileError {
  return new AncileError({
    code: check.code,
    title: /[.!?]$/.test(check.reason) ? check.reason : `${check.reason}.`,
    hint: 'Pick another model, or change what this notebook or thread allows in its scope settings.',
    status: 403,
    errorClass: 'permanent',
  });
}

/** Throws engineRefused when the thread's scope does not allow this selection. */
export async function assertAllowed(
  scopeOf: (thread: ThreadRecord) => Promise<EffectiveScope>,
  thread: ThreadRecord,
  s: Pick<Selection, 'engine' | 'checkModel' | 'local'>,
): Promise<void> {
  const scope = await scopeOf(thread);
  const check = checkEngineAllowed(scope, { engine: s.engine, modelId: s.checkModel, local: s.local });
  if (!check.ok) throw engineRefused(check);
}
