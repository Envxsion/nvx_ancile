/**
 * ------------------------------------------------------------------
 *  Title    |  Prompt files
 *  Ref      |  prompts/README.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Prompts live in prompts/*.md with front matter, so they
 *           |  can be read, diffed and edited without touching code.
 *  How      |  A small subset of Mustache: {{name}} substitutes,
 *           |  {{#name}}…{{/name}} renders its body only when the
 *           |  value is truthy. Files are read once and cached; a
 *           |  missing file falls back to the text built into Core.
 * ------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const cache = new Map<string, string>();

export function stripFrontMatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}

export function render(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined>,
): string {
  const sections = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, name: string, body: string) => (vars[name] ? body : ''),
  );
  return sections
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const v = vars[name];
      return v === undefined || v === null ? '' : String(v);
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function loadPrompt(dir: string, id: string, fallback: string): Promise<string> {
  const key = `${dir}::${id}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let text = fallback;
  try {
    text = stripFrontMatter(await readFile(join(dir, `${id.replace(/\./g, '/')}.md`), 'utf8'));
  } catch {
    /* fall back to the built-in text */
  }
  cache.set(key, text);
  return text;
}

export const BUILTIN_SYSTEM =
  'You are the assistant inside NVX Ancile, a private workspace. It is {{now}}. You are running as {{model_name}}. Be direct and specific, never invent citations, paths or numbers, and say plainly when you are unsure.';

/** What the model is told about its tools, appended to the system prompt when tools are offered. */
export const TOOLS_NOTE =
  'You can work with files in the workspace at /workspace using the fs_* tools. Reading never needs approval; writing asks the user once per location; deleting asks every time. If a call is declined, accept it and carry on.';
