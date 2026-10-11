/**
 * ------------------------------------------------------------------
 *  Title    |  Markdown plugins
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Raw HTML in an answer is shown as the text it is, not
 *           |  rendered. Claude Code transcripts are full of tags like
 *           |  <system-reminder> or <example>; rendered, they vanish
 *           |  or swallow what follows.
 *  How      |  A remark step turns `html` nodes into `text`, except a
 *           |  few harmless inline tags (br, kbd, sub, sup, details)
 *           |  that Streamdown's sanitiser still checks. Comments go.
 * ------------------------------------------------------------------
 */

import { defaultRemarkPlugins } from 'streamdown';

const KEEP = new Set(['br', 'kbd', 'sub', 'sup', 'details', 'summary', 'mark', 'ins', 'del', 'u', 's']);

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Whether an HTML fragment is only allowed tags (and text between them). */
function harmless(html: string): boolean {
  const tags = [...html.matchAll(/<\/?\s*([A-Za-z][\w-]*)[^>]*>/g)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
  if (!tags.length) return false;
  return tags.every((t) => KEEP.has(t));
}

/** Containers whose children are blocks, so loose text needs a paragraph. */
const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

function walk(node: MdNode): void {
  if (!node.children) return;
  const flow = FLOW.has(node.type);
  node.children = node.children.flatMap((c): MdNode[] => {
    if (c.type === 'html') {
      const v = c.value ?? '';
      if (/^\s*<!--[\s\S]*-->\s*$/.test(v)) return [];
      if (harmless(v)) return [c];
      const text: MdNode = { type: 'text', value: v };
      return [flow ? { type: 'paragraph', children: [text] } : text];
    }
    walk(c);
    return [c];
  });
}

/** remark plugin: HTML as literal text. */
export function htmlAsText() {
  return (tree: MdNode) => walk(tree);
}

export const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), htmlAsText];
