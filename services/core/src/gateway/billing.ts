/**
 * ------------------------------------------------------------------
 *  Title    |  Who pays for a model
 *  Ref      |  docs/claude-code.md (Plan or key) · roadmap MD3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The same Claude model can answer on your Claude plan
 *           |  (through Claude Code) or on an API key. This says which
 *           |  bills what, so every list can label it.
 *  How      |  One pure function from a model and what Claude Code
 *           |  reports about its sign-in. Where a model runs (your
 *           |  computer, your network, a rented node) is decided by
 *           |  isLocalModel in engines/select.ts, not a second rule.
 *  Note     |  Claude Code signed in with an API key or a cloud account
 *           |  is pay per use, not a plan. An unknown sign-in is taken
 *           |  as a plan with no name.
 * ------------------------------------------------------------------
 */

import type { ModelBilling, ModelConfig } from '@nvx/contracts';
import { isLocalModel } from '../engines/select';

/** What Claude Code says about its sign-in (claude auth status). */
export interface ClaudeAuth {
  signed_in: boolean;
  auth_method: string | null;
  plan: string | null;
}

/** Sign-ins that bill per token, and who bills (mirrors the cockpit's planCost). */
const METERED: Record<string, string> = {
  api_key: 'anthropic',
  apikey: 'anthropic',
  bedrock: 'bedrock',
  vertex: 'vertex',
  foundry: 'foundry',
};

export function billingOf(
  m: Pick<ModelConfig, 'provider' | 'via' | 'base_url' | 'runs_on'>,
  claude: ClaudeAuth | null,
): ModelBilling {
  if (m.provider === 'claude_code') {
    const metered = claude?.auth_method ? METERED[claude.auth_method.toLowerCase()] : undefined;
    if (metered) return { kind: 'key', payer: metered };
    return { kind: 'plan', payer: claude?.plan?.toLowerCase() || null };
  }
  if (m.provider === 'fake') return { kind: 'none', payer: null };
  if (m.runs_on === 'rented') return { kind: 'rented', payer: null };
  if (isLocalModel(m)) return { kind: 'local', payer: null };
  return { kind: 'key', payer: m.provider };
}
