/**
 * ------------------------------------------------------------------
 *  Title    |  Paste with formatting
 *  Ref      |  Settings → Composer · "Paste as plain text"
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Text copied from a web page or a document keeps its
 *           |  links, emphasis, headings, lists and code, written as
 *           |  the markdown the composer sends. With "Paste as plain
 *           |  text" on, the browser's plain text is used instead.
 *  How      |  DOMParser reads the clipboard's text/html (never added
 *           |  to the page, so nothing in it runs) and a small walk
 *           |  writes markdown. Anything it does not know becomes its
 *           |  text.
 *  Note     |  Returns null when the HTML carries no formatting worth
 *           |  keeping, so the ordinary paste goes ahead.
 * ------------------------------------------------------------------
 */

const FORMATTING = /<(a\s|b>|b\s|strong|em>|em\s|i>|i\s|code|pre|h[1-6]|ul|ol|li|blockquote)/i;

function inline(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/\s+/g, ' ');
  if (!(n instanceof Element)) return '';
  const inner = () => Array.from(n.childNodes).map(inline).join('');
  switch (n.tagName.toLowerCase()) {
    case 'a': {
      const href = n.getAttribute('href') ?? '';
      const text = inner().trim();
      return /^https?:|^mailto:/.test(href) && text ? `[${text}](${href})` : text;
    }
    case 'b':
    case 'strong': {
      const t = inner().trim();
      return t ? `**${t}**` : '';
    }
    case 'i':
    case 'em': {
      const t = inner().trim();
      return t ? `*${t}*` : '';
    }
    case 'code':
      return `\`${n.textContent ?? ''}\``;
    case 'br':
      return '\n';
    default:
      return block(n);
  }
}

function block(n: Element): string {
  const tag = n.tagName.toLowerCase();
  const kids = () => Array.from(n.childNodes).map(inline).join('');
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${kids().trim()}\n\n`;
  if (tag === 'p' || tag === 'div') return `\n\n${kids().trim()}\n\n`;
  if (tag === 'pre') return `\n\n\`\`\`\n${(n.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`;
  if (tag === 'blockquote')
    return `\n\n${kids()
      .trim()
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}\n\n`;
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(n.children).filter((c) => c.tagName.toLowerCase() === 'li');
    return `\n\n${items
      .map(
        (li, i) =>
          `${tag === 'ol' ? `${i + 1}.` : '-'} ${Array.from(li.childNodes).map(inline).join('').trim()}`,
      )
      .join('\n')}\n\n`;
  }
  if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'title') return '';
  return kids();
}

/** The clipboard's HTML as markdown, or null to let the plain paste through. */
export function htmlToMarkdown(html: string): string | null {
  if (!html || !FORMATTING.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const md = Array.from(doc.body.childNodes)
    .map(inline)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md || null;
}
