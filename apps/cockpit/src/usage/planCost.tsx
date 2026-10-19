/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's cost, in words
 *  Ref      |  docs/claude-code.md (Usage)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One wording for every place a Claude Code cost shows:
 *           |  a message's footer, Why, the live bar, Settings → Usage,
 *           |  Compare, a flow's steps. Claude Code bills the account
 *           |  it is signed into, so its answers are "Included in your
 *           |  Claude plan", never "$0.000" and never an estimate that
 *           |  reads like a bill.
 *  How      |  Signed in with a Claude account (or not known yet): the
 *           |  plan covers it. Signed in with an Anthropic API key,
 *           |  Bedrock, Vertex AI or Foundry: that is billed, so the
 *           |  words name where and give Claude Code's estimate at API
 *           |  list prices as "about".
 * ------------------------------------------------------------------
 */

import { isClaudeCodeModel } from '@nvx/contracts/engines';
import { useClaudeCodeStatus } from '../claudecode/api';
import { usd } from '../lib/format';
import { useUi } from '../state/ui';

export const IN_PLAN = 'Included in your Claude plan';

/** Sign-ins that bill per token, and where the bill goes. */
const BILLED_TO: Record<string, string> = {
  api_key: 'your Anthropic API key',
  apikey: 'your Anthropic API key',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

/** Where Claude Code's use is billed; null when your Claude plan covers it (also while unknown). */
export function billedTo(authMethod: string | null | undefined): string | null {
  return authMethod ? (BILLED_TO[authMethod.toLowerCase()] ?? null) : null;
}

export { isClaudeCodeModel };

/** An answer Claude Code wrote: in a Claude Code thread, or from Claude Code as a model. */
export function isClaudeCodeAnswer(m: {
  modelId?: string | null;
  provenance?: { claude_code?: unknown } | null;
}): boolean {
  return !!m.provenance?.claude_code || isClaudeCodeModel(m.modelId);
}

/** "Included in your Claude plan", or "About $0.12, billed to your Anthropic API key". */
export function claudeCodeCostWords(estimate: number, billed: string | null): string {
  if (!billed) return IN_PLAN;
  return estimate > 0
    ? `About ${usd(estimate, estimate < 0.1 ? 3 : 2)}, billed to ${billed}`
    : `Billed to ${billed}`;
}

/** Where this computer's Claude Code bills (null: your Claude plan). Reads its status only when `enabled`. */
export function useClaudeBilling(enabled = true): string | null {
  const demo = useUi((s) => s.demo);
  const status = useClaudeCodeStatus({ enabled: enabled && !demo });
  return enabled ? billedTo(status.data?.auth_method) : null;
}

/** A Claude Code cost in words, where a component only has the number. */
export function ClaudeCodeCost({ estimate }: { estimate: number }) {
  return <>{claudeCodeCostWords(estimate, useClaudeBilling())}</>;
}
