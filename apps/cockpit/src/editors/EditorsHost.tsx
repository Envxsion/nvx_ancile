/**
 * ------------------------------------------------------------------
 *  Title    |  Editors host
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Draws whichever editor is open (editors/store.ts): the
 *           |  scope editor, instructions and persona, a new Claude
 *           |  Code thread in a folder, context links, context packs or a
 *           |  notebook merge. Mounted once, in AppShell.
 * ------------------------------------------------------------------
 */

import { NewClaudeCodeThread } from '../claudecode/NewThread';
import { LinksDialog } from '../notebooks/LinksDialog';
import { MergeDialog } from '../notebooks/MergeDialog';
import { PackPicker } from '../pro/PackPicker';
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
  if (open.kind === 'links')
    return (
      <LinksDialog
        open
        onOpenChange={(o) => !o && close()}
        from={{ kind: open.level, id: open.id, title: open.title, notebookId: open.notebookId }}
      />
    );
  if (open.kind === 'packs')
    return (
      <PackPicker
        key={`${open.level}-${open.id}`}
        target={{ kind: open.level, id: open.id, title: open.title }}
        onOpenChange={(o) => !o && close()}
      />
    );
  if (open.kind === 'merge')
    return <MergeDialog open onOpenChange={(o) => !o && close()} into={open.into} from={open.from} />;
  return <NewClaudeCodeThread notebookId={open.notebookId} cwd={open.cwd} onClose={close} />;
}
