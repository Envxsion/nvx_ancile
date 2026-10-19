/**
 * ------------------------------------------------------------------
 *  Title    |  What a code block can do
 *  Ref      |  roadmap AN3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The small decisions behind a code block's header:
 *           |  which blocks can be run, what a saved file is called,
 *           |  and the words that ask for a run.
 *  How      |  Pure functions. Running is never done by the page:
 *           |  Run puts a request in the composer, and when you send
 *           |  it the model calls python_run, which Core allows or
 *           |  asks about on the real code (permissions/decide)
 *           |  inside the no-network sandbox. Saving goes through
 *           |  PUT /files, the same gate the file editor uses.
 * ------------------------------------------------------------------
 */

const EXT: Record<string, string> = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  html: 'html',
  css: 'css',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  rust: 'rs',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  markdown: 'md',
  md: 'md',
  mermaid: 'mmd',
  text: 'txt',
};

export const isPython = (lang: string | null | undefined): boolean =>
  !!lang && /^(python|py|python3|py3)$/i.test(lang);

export const isMermaid = (lang: string | null | undefined): boolean => !!lang && /^mermaid$/i.test(lang);

export function extFor(lang: string | null | undefined): string {
  return (lang && EXT[lang.toLowerCase()]) || 'txt';
}

/** A file name to offer: snippet.py, snippet.ts, snippet.txt. */
export const defaultFileName = (lang: string | null | undefined): string => `snippet.${extFor(lang)}`;

/** Why a file name cannot be used, in words; null when it is fine. Paths stay inside the workspace. */
export function fileNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the file a name.';
  if (n.length > 200) return 'That name is too long.';
  if (/[\0<>:"|?*]/.test(n.replace(/^[a-z]:[\\/]/i, ''))) return 'A file name cannot have < > : " | ? or *.';
  if (n.split(/[\\/]/).includes('..')) return 'A file name cannot go up a folder.';
  return null;
}

/** The message Run writes in the composer. The code is quoted as a fence, long enough to hold it. */
export function runRequest(code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const bar = '`'.repeat(longest + 1);
  return `Run this Python and show me what it prints:\n\n${bar}python\n${code.replace(/\n$/, '')}\n${bar}`;
}
