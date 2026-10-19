/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's folders
 *  Ref      |  docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Where Claude Code keeps its config and sessions, in one
 *           |  place, so nothing in Core reads ~/.claude by guesswork.
 *  How      |  CLAUDE_CONFIG_DIR (Claude Code's documented variable)
 *           |  wins when set; otherwise ~/.claude. The test profile
 *           |  points it at an empty folder.
 * ------------------------------------------------------------------
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export function claudeConfigDir(env: Env = process.env, home: string = homedir()): string {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  return set ? set : join(home, '.claude');
}

export function claudeProjectsDir(env: Env = process.env, home: string = homedir()): string {
  return join(claudeConfigDir(env, home), 'projects');
}
