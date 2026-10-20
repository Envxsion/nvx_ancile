/**
 * ------------------------------------------------------------------
 *  Title    |  Tools offered when no repository exists
 *  Ref      |  DESIGN.md §5.2 · conductor/epoch.ts (the tool superset)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The 22 git and GitHub tools are about 1,900 of the
 *           |  2,600 tokens of tool schemas every turn carries. With
 *           |  no repository registered they cannot do anything (each
 *           |  answers "add a repository first"), so they are left
 *           |  out of the epoch's tool superset.
 *  How      |  Decided from one stable fact, whether any repository is
 *           |  registered, not from the wording of a question: the
 *           |  epoch's tool block must stay the same from turn to turn
 *           |  for prompt caches to hold, and it changes only when the
 *           |  first repository is added or the last removed.
 *  Note     |  Capability is unchanged: nothing a tool could have done
 *           |  is lost.
 * ------------------------------------------------------------------
 */

import type { ToolSpec } from '../tools/registry';

const REPO_TOOL = /^(git|gh)_/;

export function offeredTools(all: ToolSpec[], input: { hasRepos: boolean }): ToolSpec[] {
  return input.hasRepos ? all : all.filter((t) => !REPO_TOOL.test(t.name) || t.source.kind !== 'builtin');
}
