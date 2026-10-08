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
 *           |  data, TreePanel keeps the hand-built outline.
 * ------------------------------------------------------------------
 */

import { type CSSProperties, useMemo, useState } from 'react';
import * as demo from '../fixtures/demo';
import { useBinding } from '../keys/dispatch';
import { useBranchTree } from '../lib/branching';
import { hueVar, modelById } from '../lib/format';
import { useThreadIdFromRoute } from '../lib/models';
import type { TreeNodeView } from '../lib/types';
import { notify } from '../state/notify';
import { LazyBranchTree as BranchTree } from '../tree/LazyTree';
import { useBranchLayer } from '../tree/store';
import { Icon } from '../ui/Icon';
import { EmptyState, Tip } from '../ui/primitives';

interface Row {
  node: TreeNodeView;
  depth: number;
}

function flatten(nodes: TreeNodeView[]): Row[] {
  const children = (id: string | null) => nodes.filter((n) => n.parentId === id);
  const out: Row[] = [];
  const walk = (id: string | null, depth: number) => {
    for (const n of children(id)) {
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function TreePanel() {
  const rows = useMemo(() => flatten(demo.tree), []);
  const [selected, setSelected] = useState(
    rows.find((r) => r.node.id === 'msg_a1')?.node.id ?? rows[0]?.node.id,
  );
  const [focused, setFocused] = useState(false);

  const byId = (id: string | undefined) => demo.tree.find((n) => n.id === id);
  const siblings = (n: TreeNodeView) => demo.tree.filter((x) => x.parentId === n.parentId);

  const move = (pick: (n: TreeNodeView) => TreeNodeView | undefined) => {
    const n = byId(selected);
    const next = n && pick(n);
    if (next) setSelected(next.id);
  };
  useBinding('tree.parent', () => move((n) => byId(n.parentId ?? undefined)), focused);
  useBinding(
    'tree.child',
    () =>
      move(
        (n) =>
          demo.tree.find((x) => x.parentId === n.id && x.active) ??
          demo.tree.find((x) => x.parentId === n.id),
      ),
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
  useBinding(
    'list.open',
    () =>
      notify({
        level: 'info',
        title: 'This is the sample tree',
        body: 'Open one of your own threads to jump between its branches.',
      }),
    focused,
  );

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="mute">
          <span data-num>3</span> branches · <span data-num>{rows.length}</span> points
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
      <div
        className="tree"
        role="tree"
        aria-label="Branches in this thread"
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-activedescendant={selected ? `tree-${selected}` : undefined}
      >
        {rows.map(({ node, depth }) => {
          const model = modelById(node.modelId);
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: the tree owns focus via aria-activedescendant
            <div
              key={node.id}
              id={`tree-${node.id}`}
              role="treeitem"
              aria-selected={selected === node.id}
              aria-level={depth + 1}
              className="tree__row"
              data-active={node.active || undefined}
              data-selected={selected === node.id || undefined}
              style={{ '--depth': depth } as CSSProperties}
              onClick={() => setSelected(node.id)}
              onKeyDown={() => {}}
            >
              <span className="tree__glyph" data-role={node.role} />
              <span className="tree__text">
                {node.branch ? (
                  <span
                    className="tree__branch"
                    style={{ '--hue': hueVar(node.branch.hue) } as CSSProperties}
                  >
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
            </div>
          );
        })}
      </div>
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
          {tree.data ? (
            <>
              <span data-num>{tree.data.total}</span> messages · <span data-num>{forks}</span>{' '}
              {forks === 1 ? 'fork' : 'forks'}
            </>
          ) : (
            'Loading'
          )}
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
