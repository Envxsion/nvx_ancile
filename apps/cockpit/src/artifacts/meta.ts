/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact names, icons and file names
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The words and icons each artifact type shows, and the
 *           |  file name a download gets.
 * ------------------------------------------------------------------
 */

import type { ArtifactType } from '@nvx/contracts';
import type { IconName } from '../ui/Icon';

export const TYPE_LABEL: Record<ArtifactType, string> = {
  html: 'Web page',
  svg: 'SVG image',
  react: 'React component',
  mermaid: 'Diagram',
  markdown: 'Document',
  code: 'Code',
};

export const TYPE_ICON: Record<ArtifactType, IconName> = {
  html: 'globe',
  svg: 'image',
  react: 'layout',
  mermaid: 'tree',
  markdown: 'note',
  code: 'terminal',
};

/** Types drawn in the sandboxed frame; the rest the Cockpit draws itself. */
export const FRAMED: ReadonlySet<ArtifactType> = new Set(['html', 'svg', 'react', 'mermaid']);

const EXT: Record<string, string> = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  rust: 'rs',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  ruby: 'rb',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  toml: 'toml',
};

export function fileName(type: ArtifactType, key: string, language: string | null): string {
  const base = key || 'artifact';
  switch (type) {
    case 'html':
      return `${base}.html`;
    case 'svg':
      return `${base}.svg`;
    case 'react':
      return `${base}.${language === 'tsx' ? 'tsx' : 'jsx'}`;
    case 'mermaid':
      return `${base}.mmd`;
    case 'markdown':
      return `${base}.md`;
    default:
      return `${base}.${(language && EXT[language.toLowerCase()]) || 'txt'}`;
  }
}

export function mimeOf(type: ArtifactType): string {
  if (type === 'html') return 'text/html';
  if (type === 'svg') return 'image/svg+xml';
  if (type === 'markdown') return 'text/markdown';
  return 'text/plain';
}

/** Save text or base64 bytes as a file, from the Cockpit (never from the frame). */
export function saveFile(name: string, mime: string, data: string, base64 = false): void {
  const bytes = base64 ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(data);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const lineCount = (s: string) => (s ? s.split('\n').length : 0);
