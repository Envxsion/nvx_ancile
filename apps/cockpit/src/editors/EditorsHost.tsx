/**
 * ------------------------------------------------------------------
 *  Title    |  Editors host
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Draws whichever editor is open (editors/store.ts): the
 *           |  scope editor, instructions and persona, or a new Claude
 *           |  Code thread in a folder. Mounted once, in AppShell.
 * ------------------------------------------------------------------
 */

import { NewClaudeCodeThread } from '../claudecode/NewThread';
import { ScopeEditor } from '../scopes/ScopeEditor';
import { InstructionsEditor } from './InstructionsEditor';
import { useEditors } from './store';

export function EditorsHost() {
  const open = useEditors((s) => s.open);
  const close = useEditors((s) => s.close);
  if (!open) return null;
  if (open.kind === 'scope')
    return <ScopeEditor key={`${open.level}-${open.id}`} {...open} onClose={close} />;
  if (open.kind === 'instructions')
    return (
      <InstructionsEditor key={`${open.level}-${open.id}`} level={open.level} id={open.id} onClose={close} />
    );
  return <NewClaudeCodeThread notebookId={open.notebookId} cwd={open.cwd} onClose={close} />;
}
