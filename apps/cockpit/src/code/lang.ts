/**
 * ------------------------------------------------------------------
 *  Title    |  Editor languages
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Which grammar a file gets in the code editor, from its
 *           |  name or a fence's language, and the grammar itself,
 *           |  loaded only when a file needs it.
 *  How      |  languageOf() is pure (tested); loadLanguage() imports
 *           |  the @codemirror/lang-* package on demand, so opening a
 *           |  Python file never downloads the SQL grammar.
 * ------------------------------------------------------------------
 */

import type { Extension } from '@codemirror/state';

export type EditorLanguage =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'json'
  | 'markdown'
  | 'css'
  | 'html'
  | 'rust'
  | 'sql'
  | 'yaml'
  | 'go'
  | 'java'
  | 'cpp';

const BY_NAME: Record<string, EditorLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyi: 'python',
  python: 'python',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  svg: 'html',
  xml: 'html',
  vue: 'html',
  svelte: 'html',
  rs: 'rust',
  rust: 'rust',
  sql: 'sql',
  pgsql: 'sql',
  postgres: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  go: 'go',
  java: 'java',
  kt: 'java',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  'c++': 'cpp',
  cs: 'java',
};

/** A file path ("src/app.tsx") or a language name ("python") → the grammar to use, or null for plain text. */
export function languageOf(pathOrLang: string | null | undefined): EditorLanguage | null {
  if (!pathOrLang) return null;
  const s = pathOrLang.trim().toLowerCase();
  if (BY_NAME[s]) return BY_NAME[s];
  const name = s.replaceAll('\\', '/').split('/').pop() ?? '';
  const m = /\.([a-z0-9+]+)$/.exec(name);
  return m ? (BY_NAME[m[1] as string] ?? null) : null;
}

/** Is this file Markdown (so the editor offers Rendered as well as Raw)? */
export function isMarkdownPath(path: string | null | undefined): boolean {
  return languageOf(path) === 'markdown';
}

/** The grammar's CodeMirror extension, loaded on first use. */
export async function loadLanguage(lang: EditorLanguage | null): Promise<Extension> {
  switch (lang) {
    case 'javascript':
    case 'jsx':
    case 'typescript':
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({
        jsx: lang === 'jsx' || lang === 'tsx',
        typescript: lang === 'typescript' || lang === 'tsx',
      });
    }
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
    case 'cpp':
      return (await import('@codemirror/lang-cpp')).cpp();
    default:
      return [];
  }
}
