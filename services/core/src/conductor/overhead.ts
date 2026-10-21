/**
 * ------------------------------------------------------------------
 *  Title    |  What a request carries besides the conversation
 *  Ref      |  ROADMAP.md HO1 · docs/prompt-caching.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Whether a thread fits a model depends on the whole
 *           |  request, not only the turns: the system prompt, the
 *           |  tools block (every tool's description and schema, often
 *           |  the largest fixed part), the memory pack and the
 *           |  sources. The budget used to guess 600 tokens for all of
 *           |  it; this counts what would really be sent.
 *  How      |  The same functions that build the request give the same
 *           |  text here: systemPrompt (rules and tools note), the
 *           |  canonical tools block (epoch.ts toolsBlock, fed by the
 *           |  scope and the offer rules) and the memory pack the
 *           |  caller reads. Tokens are the ~4 characters estimate.
 *  Note     |  The rules text counts as the epoch's frozen system text
 *           |  will be: what varies rides at the end of the request and
 *           |  is counted by the caller as part of the question.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { approxTokens } from '../memory/inject';
import type { ToolSpec } from '../tools/registry';
import { systemPrompt } from './context';
import { toolsBlock, toolsInScope } from './epoch';
import { offeredTools } from './tool-offer';

export interface RequestOverhead {
  /** The system prompt: rules, the tools note and the thread's own instructions. */
  system: number;
  /** The tools block the request declares (0 for a model without the tools capability). */
  tools: number;
  /** The memory pack the model is given. */
  memory: number;
}

/** The tools a request to this notebook declares, as the turn builds them. */
export function declaredTools(
  all: ToolSpec[],
  input: { notebookId: string | null; hasRepos: boolean },
): ToolSpec[] {
  return offeredTools(toolsInScope(all, input.notebookId), { hasRepos: input.hasRepos });
}

export async function requestOverhead(input: {
  promptsDir: string;
  model: ModelConfig | undefined;
  /** What `declaredTools` gave. */
  specs: ToolSpec[];
  /** Tokens of the memory pack the model would be given. */
  memory: number;
  /** The thread's own instructions, if any. */
  instructions?: string | null;
}): Promise<RequestOverhead> {
  const withTools = !!input.model?.capabilities.includes('tools');
  const base = await systemPrompt({ promptsDir: input.promptsDir, model: input.model, tools: withTools });
  return {
    system: approxTokens(base) + approxTokens(input.instructions ?? ''),
    tools: withTools ? approxTokens(toolsBlock(input.specs, true).json) : 0,
    memory: input.memory,
  };
}
