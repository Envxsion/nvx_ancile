/**
 * ------------------------------------------------------------------
 *  Title    |  Don't bring in this folder
 *  Ref      |  packages/contracts/src/claudecode.ts (ExcludeClaudeCodeFolderRequest)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One confirm, shared by the sessions view and a folder
 *           |  notebook's menu, before a Claude Code folder stops
 *           |  coming in. It says what happens to what is already in.
 *  How      |  useExcludeFolder() gives `ask(cwd)` and the dialog to
 *           |  render; confirming is POST /claude-code/projects/exclude.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { type ConfirmCopy, ConfirmDialog } from '../ui/Confirm';
import { excludeFolder, folderOf } from './api';

export function excludeCopy(cwd: string): ConfirmCopy {
  const folder = folderOf(cwd);
  return {
    title: `Stop bringing in ${folder}?`,
    body: `Sessions from ${folder} stop coming in. Threads already brought in from it are archived, not deleted, unless you've written in them.`,
    action: "Don't bring in this folder",
  };
}

export function useExcludeFolder() {
  const [cwd, setCwd] = useState<string | null>(null);
  const dialog = (
    <ConfirmDialog
      copy={cwd ? excludeCopy(cwd) : null}
      onConfirm={() => {
        if (cwd) void excludeFolder(cwd);
      }}
      onClose={() => setCwd(null)}
    />
  );
  return { ask: setCwd, dialog };
}
