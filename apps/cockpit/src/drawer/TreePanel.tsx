/**
 * ------------------------------------------------------------------
 *  Title    |  Branch tree panel
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The thread as the tree it is, beside the conversation:
 *           |  every regenerate, edit and branch visible, the active
 *           |  path drawn in signal.
 *  How      |  LiveTree draws the real tree (tree/BranchTree.tsx) for
 *           |  the open thread, with a way to go full screen. On demo
 *           |  data, TreePanel keeps the hand-built outline, drawn as a
 *           |  windowed list (tree/TreeOutline.tsx): only the rows near
 *           |  the screen are in the page, so a thousand points cost
 *           |  what thirty do.
 * ------------------------------------------------------------------
 */

import { type CSSProperties, useCallback, useMemo, useState } from 'react';
import * as demo from '../fixtures/demo';
import { useBinding } from '../keys/dispatch';
import { useBranchTree } from '../lib/branching';
import { hueVar, modelById } from '../lib/format';
import { useThreadIdFromRoute } from '../lib/models';
import type { TreeNodeView } from '../lib/types';
import { notify } from '../state/notify';
import { LazyBranchTree as BranchTree } from '../tree/LazyTree';
import type { OutlineRow } from '../tree/outline';
import { useBranchLayer } from '../tree/store';
import { TreeOutline } from '../tree/TreeOutline';
import { Icon } from '../ui/Icon';
import { EmptyState, Tip } from '../ui/primitives';

const parentOf = (n: TreeNodeView) => n.parentId;

/** One row of the outline: the glyph, its branch name, the preview, its model. */
function OutlineRowView({ row }: { row: OutlineRow<TreeNodeView> }) {
  const node = row.node;
  const model = modelById(node.modelId);
  return (
    <>
      <span className="tree__glyph" data-role={node.role} />
      <span className="tree__text">
        {node.branch ? (
          <span className="tree__branch" style={{ '--hue': hueVar(node.branch.hue) } as CSSProperties}>
            {node.branch.name}
          </span>
        ) : null}
        <span className="tree__preview">{node.preview}</span>
      </span>
      {node.collapsed > 0 ? (
        <span
          className="tree__collapsed"
          data-num
          title={`${node.collapsed} more messages in a straight line`}
        >
          +{node.collapsed}
        </span>
      ) : null}
      {model ? (
        <span
          className="tree__model"
          style={{ '--hue': hueVar(model.hue) } as CSSProperties}
          title={model.name}
        />
      ) : null}
    </>
  );
}

/** The demo's outline (or any list of tree nodes), windowed, with the panel's keys. */
export function TreePanel({ nodes = demo.tree }: { nodes?: TreeNodeView[] } = {}) {
  const [selected, setSelected] = useState(
    nodes.find((n) => n.id === 'msg_a1')?.id ?? nodes.find((n) => !n.parentId)?.id,
  );
  const [focused, setFocused] = useState(false);
  const index = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const kids = useMemo(() => {
    const m = new Map<string | null, TreeNodeView[]>();
    for (const n of nodes) {
      const list = m.get(n.parentId);
      if (list) list.push(n);
      else m.set(n.parentId, [n]);
    }
    return m;
  }, [nodes]);

  const byId = (id: string | undefined | null) => (id ? index.get(id) : undefined);
  const siblings = (n: TreeNodeView) => kids.get(n.parentId) ?? [n];
  const open = useCallback(
    () =>
      notify({
        level: 'info',
        title: 'This is the sample tree',
        body: 'Open one of your own threads to jump between its branches.',
      }),
    [],
  );

  const move = (pick: (n: TreeNodeView) => TreeNodeView | undefined) => {
    const n = byId(selected);
    const next = n && pick(n);
    if (next) setSelected(next.id);
  };
  useBinding('tree.parent', () => move((n) => byId(n.parentId)), focused);
  useBinding(
    'tree.child',
    () =>
      move((n) => {
        const c = kids.get(n.id) ?? [];
        return c.find((x) => x.active) ?? c[0];
      }),
    focused,
  );
  useBinding(
    'tree.prevSibling',
    () =>
      move((n) => {
        const s = siblings(n);
        return s[s.indexOf(n) - 1];
      }),
    focused,
  );
  useBinding(
    'tree.nextSibling',
    () =>
      move((n) => {
        const s = siblings(n);
        return s[s.indexOf(n) + 1];
      }),
    focused,
  );
  useBinding('list.open', open, focused);

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="mute">
          <span data-num>{nodes.filter((n) => n.branch).length || 1}</span> branches ·{' '}
          <span data-num>{nodes.length}</span> points
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled
          title="Open one of your own threads to compare its branches"
        >
          <Icon name="compare" size={14} />
          Compare
        </button>
      </div>
      <TreeOutline
        nodes={nodes}
        parentOf={parentOf}
        selected={selected}
        onSelect={setSelected}
        onOpen={open}
        label="Branches in this thread"
        onFocusChange={setFocused}
        rowProps={(r) => ({ 'data-active': r.node.active || undefined })}
        renderRow={(r) => <OutlineRowView row={r} />}
      />
      <p className="panel__foot mute">Focus the tree, then j and k walk the path, h and l switch versions.</p>
    </div>
  );
}

/** The open thread's real tree. */
export function LiveTree() {
  const threadId = useThreadIdFromRoute();
  const tree = useBranchTree(threadId);
  const setFull = useBranchLayer((s) => s.setFull);
  if (!threadId)
    return (
      <EmptyState
        icon="tree"
        title="Open a thread to see its tree"
        body="Every version of every message, and where each branch split off."
      />
    );
  const forks = tree.data?.nodes.filter((n) => n.children > 1).length ?? 0;
  return (
    <div className="panel panel--tree">
      <div className="panel__bar">
        <span className="mute">
          {/* No count until the tree is here: the canvas shows its skeleton, or what failed. */}
          {tree.data ? (
            <>
              <span data-num>{tree.data.total}</span> messages · <span data-num>{forks}</span>{' '}
              {forks === 1 ? 'fork' : 'forks'}
            </>
          ) : null}
        </span>
        <Tip label="Full screen" binding="go.tree">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Open the tree full screen"
            onClick={() => setFull(true)}
          >
            <Icon name="expand" size={14} />
          </button>
        </Tip>
      </div>
      <div className="panel__canvas">
        <BranchTree threadId={threadId} variant="panel" />
      </div>
      <p className="panel__foot mute">
        Click the tree, then j and k walk it, h and l switch versions, Enter jumps there. Shift-click two
        points to compare them.
      </p>
    </div>
  );
}
