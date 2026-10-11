/**
 * ------------------------------------------------------------------
 *  Title    |  Code highlighting
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Quiet colour for code in answers and tool steps:
 *           |  keywords, strings, comments, numbers. Enough to read
 *           |  a file at a glance, never a light show.
 *  How      |  A small line tokeniser with per-language keyword sets
 *           |  and comment styles. A block comment or string that
 *           |  spans lines carries its state to the next line. No
 *           |  grammar files and no dependency: unknown languages
 *           |  come back as plain text.
 *  Note     |  Colours are tokens in thread.css (.tok-*), never here.
 * ------------------------------------------------------------------
 */

export type TokenKind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'type' | 'tag' | 'attr' | 'plain';
export interface Token {
  k: TokenKind;
  v: string;
}

interface Grammar {
  keywords: Set<string>;
  line: string[];
  block?: [string, string];
  /** Quote characters that open strings. */
  quotes: string;
  /** Capitalised words read as types. */
  types?: boolean;
  /** Markup: tags and attributes. */
  markup?: boolean;
  /** Keys before a colon (yaml, toml, json). */
  keys?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS = words(`
  abstract as async await break case catch class const continue debugger declare default delete do
  else enum export extends false finally for from function get if implements import in instanceof
  interface keyof let new null of private protected public readonly return satisfies set static
  super switch this throw true try type typeof undefined var void while with yield`);
const PY = words(`
  and as assert async await break class continue def del elif else except False finally for from
  global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case`);
const RUST = words(`
  as async await break const continue crate dyn else enum extern false fn for if impl in let loop match
  mod move mut pub ref return self Self static struct super trait true type unsafe use where while`);
const GO = words(`
  break case chan const continue default defer else fallthrough for func go goto if import interface
  map package range return select struct switch type var nil true false`);
const CLIKE = words(`
  auto bool break case catch char class const continue default delete do double else enum explicit
  extern false final float for friend goto if inline int long namespace new null nullptr operator
  override private protected public return short signed sizeof static struct switch template this
  throw true try typedef typename union unsigned using virtual void volatile while var val fun
  string object let async await readonly sealed record import package extends implements interface`);
const SH = words(`
  if then else elif fi for in do done while until case esac function return local export readonly
  echo cd exit set unset source alias true false`);
const PS = words(`
  if else elseif foreach for while do until switch function param return begin process end try catch
  finally throw break continue in true false null`);
const SQL = words(`
  select from where and or not insert into values update set delete create table alter drop index
  primary key foreign references join left right inner outer on as group by order having limit offset
  distinct union all null is in exists case when then else end returning with default begin commit`);
const CSS = words(`important inherit initial unset none auto var calc`);
const YAML = words(`true false null yes no on off`);

const GRAMMARS: Record<string, Grammar> = {
  js: { keywords: JS, line: ['//'], block: ['/*', '*/'], quotes: `"'\``, types: true },
  py: { keywords: PY, line: ['#'], quotes: `"'`, types: true },
  rust: { keywords: RUST, line: ['//'], block: ['/*', '*/'], quotes: `"`, types: true },
  go: { keywords: GO, line: ['//'], block: ['/*', '*/'], quotes: `"'\``, types: true },
  c: { keywords: CLIKE, line: ['//'], block: ['/*', '*/'], quotes: `"'`, types: true },
  sh: { keywords: SH, line: ['#'], quotes: `"'` },
  ps: { keywords: PS, line: ['#'], block: ['<#', '#>'], quotes: `"'` },
  sql: { keywords: SQL, line: ['--'], block: ['/*', '*/'], quotes: `'"` },
  css: { keywords: CSS, line: [], block: ['/*', '*/'], quotes: `"'`, keys: true },
  json: { keywords: words('true false null'), line: [], quotes: `"`, keys: true },
  yaml: { keywords: YAML, line: ['#'], quotes: `"'`, keys: true },
  toml: { keywords: YAML, line: ['#'], quotes: `"'`, keys: true },
  html: { keywords: new Set(), line: [], block: ['<!--', '-->'], quotes: `"'`, markup: true },
};

const ALIASES: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  typescript: 'js',
  python: 'py',
  rs: 'rust',
  golang: 'go',
  cpp: 'c',
  'c++': 'c',
  h: 'c',
  hpp: 'c',
  cc: 'c',
  cs: 'c',
  csharp: 'c',
  java: 'c',
  kt: 'c',
  kotlin: 'c',
  swift: 'c',
  scala: 'c',
  dart: 'c',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  shellscript: 'sh',
  powershell: 'ps',
  ps1: 'ps',
  psm1: 'ps',
  pwsh: 'ps',
  scss: 'css',
  less: 'css',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  postgres: 'sql',
  pgsql: 'sql',
  dockerfile: 'sh',
};

/** Fence or extension as the grammar to use, or null to show it plain. */
export function grammarOf(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  if (GRAMMARS[l]) return l;
  return ALIASES[l] ?? null;
}

/** A language name for a file, from its extension: "src/app.tsx" → "tsx". */
export function langOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.replaceAll('\\', '/').split('/').pop() ?? '';
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  const m = /\.([a-z0-9+]+)$/i.exec(name);
  return m ? (m[1] as string).toLowerCase() : null;
}

/** How a language reads as a label: "tsx" → "TSX", "python" → "Python". */
export function langLabel(lang: string): string {
  const special: Record<string, string> = {
    js: 'JavaScript',
    javascript: 'JavaScript',
    ts: 'TypeScript',
    typescript: 'TypeScript',
    py: 'Python',
    python: 'Python',
    sh: 'Shell',
    bash: 'Bash',
    ps1: 'PowerShell',
    powershell: 'PowerShell',
    md: 'Markdown',
    markdown: 'Markdown',
    rs: 'Rust',
    rust: 'Rust',
    go: 'Go',
    yml: 'YAML',
    text: 'Text',
    txt: 'Text',
    plaintext: 'Text',
  };
  return (
    special[lang.toLowerCase()] ??
    (lang.length <= 4 ? lang.toUpperCase() : lang[0]?.toUpperCase() + lang.slice(1))
  );
}

type Carry = { block: string } | { quote: string } | null;

const NUM = /^(0x[\da-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)[a-z]*\b/i;
const WORD = /^[A-Za-z_$][\w$-]*/;

function tokeniseLine(line: string, g: Grammar, carry: Carry): { tokens: Token[]; carry: Carry } {
  const out: Token[] = [];
  const push = (k: TokenKind, v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.k === k) last.v += v;
    else out.push({ k, v });
  };
  let i = 0;
  let inTag = false;
  if (carry && 'block' in carry) {
    const end = line.indexOf(carry.block);
    if (end < 0) return { tokens: [{ k: 'com', v: line }], carry };
    push('com', line.slice(0, end + carry.block.length));
    i = end + carry.block.length;
    carry = null;
  } else if (carry && 'quote' in carry) {
    const end = line.indexOf(carry.quote);
    if (end < 0) return { tokens: [{ k: 'str', v: line }], carry };
    push('str', line.slice(0, end + 1));
    i = end + 1;
    carry = null;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i] as string;
    const lineCom = g.line.find((c) => rest.startsWith(c));
    if (lineCom && !(g.line.includes('#') && ch === '#' && i > 0 && /\w/.test(line[i - 1] ?? ''))) {
      push('com', rest);
      break;
    }
    if (g.block && rest.startsWith(g.block[0])) {
      const end = rest.indexOf(g.block[1], g.block[0].length);
      if (end < 0) {
        push('com', rest);
        return { tokens: out, carry: { block: g.block[1] } };
      }
      push('com', rest.slice(0, end + g.block[1].length));
      i += end + g.block[1].length;
      continue;
    }
    if (g.quotes.includes(ch) && !(g.markup && !inTag)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length && ch === '`') {
        push('str', rest);
        return { tokens: out, carry: { quote: ch } };
      }
      const s = line.slice(i, j + 1);
      const after = line.slice(j + 1).trimStart();
      push(g.keys && after.startsWith(':') ? 'attr' : 'str', s);
      i = j + 1;
      continue;
    }
    if (g.markup) {
      const tag = /^<\/?[A-Za-z][\w:-]*/.exec(rest);
      if (tag) {
        push('tag', tag[0]);
        inTag = true;
        i += tag[0].length;
        continue;
      }
      if (inTag && (rest.startsWith('/>') || ch === '>')) {
        const v = rest.startsWith('/>') ? '/>' : '>';
        push('tag', v);
        inTag = false;
        i += v.length;
        continue;
      }
      const w = inTag ? WORD.exec(rest) : null;
      if (w) {
        push('attr', w[0]);
        i += w[0].length;
        continue;
      }
      push('plain', ch);
      i += 1;
      continue;
    }
    const num = /[\w$]/.test(line[i - 1] ?? '') ? null : NUM.exec(rest);
    if (num) {
      push('num', num[0]);
      i += num[0].length;
      continue;
    }
    const w = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (w) {
      const word = w[0];
      const next = line.slice(i + word.length).trimStart();
      if (g.keywords.has(word) || g.keywords.has(word.toLowerCase())) push('kw', word);
      else if (
        g.keys &&
        /^\s*:/.test(line.slice(i + word.length)) &&
        /^\s*$/.test(line.slice(0, i).replace(/[-\s]/g, ''))
      )
        push('attr', word);
      else if (next.startsWith('(')) push('fn', word);
      else if (g.types && /^[A-Z][a-z]/.test(word)) push('type', word);
      else push('plain', word);
      i += word.length;
      continue;
    }
    push('plain', ch);
    i += 1;
  }
  return { tokens: out, carry };
}

/** Code as lines of tokens. Plain text for a language it does not know. */
export function highlight(code: string, lang: string | null | undefined): Token[][] {
  const lines = code.split('\n');
  const name = grammarOf(lang);
  const g = name ? GRAMMARS[name] : undefined;
  if (!g) return lines.map((l) => (l ? [{ k: 'plain', v: l }] : []));
  let carry: Carry = null;
  return lines.map((l) => {
    const r = tokeniseLine(l, g, carry);
    carry = r.carry;
    return r.tokens;
  });
}
