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

import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  defaultUrlTransform,
  type UrlTransform,
} from 'streamdown';

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

/**
 * remark plugin: a single line break in a paragraph stays a line break. Chat
 * models (Gemini above all) write a status block as lines with one newline
 * between them and mean them as lines; markdown would join them into one
 * run of words. Code is untouched (only text nodes are split), and a blank
 * line still starts a new paragraph.
 */
function softBreaks(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((c): MdNode[] => {
    if (c.type === 'text' && c.value?.includes('\n')) {
      const lines = c.value.split(/\r?\n/);
      return lines.flatMap((line, i): MdNode[] => [
        ...(i > 0 ? [{ type: 'break' }] : []),
        ...(line ? [{ type: 'text', value: line }] : []),
      ]);
    }
    softBreaks(c);
    return [c];
  });
}

export function keepLineBreaks() {
  return (tree: MdNode) => softBreaks(tree);
}

export const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), htmlAsText, keepLineBreaks];

/**
 * Images written inline as data:image/… (a model's own picture, a chart) are
 * local and safe in an <img>: let them through the sanitiser and the URL
 * check, for image sources only. Remote images still go to ThreadImage, which
 * never loads one without a yes (docs/images.md).
 */
type Schema = { protocols?: Record<string, string[]> } & Record<string, unknown>;
const rehype = defaultRehypePlugins as Record<string, unknown>;
const withDataImages = (entry: unknown) => {
  if (!Array.isArray(entry)) return entry;
  const [plugin, schema] = entry as [unknown, Schema];
  const src = schema.protocols?.src ?? ['http', 'https'];
  return [plugin, { ...schema, protocols: { ...schema.protocols, src: [...src, 'data'] } }];
};
export const REHYPE_PLUGINS = Object.entries(rehype).map(([name, entry]) =>
  name === 'sanitize' ? withDataImages(entry) : entry,
) as NonNullable<Parameters<typeof import('streamdown').Streamdown>[0]['rehypePlugins']>;

export const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(url)
    ? url
    : defaultUrlTransform(url, key, node);
