/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: one-line digests of tool steps
 *  Ref      |  docs/engines.md (Context for each engine)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When a thread's turns go to another engine, its tool
 *           |  steps travel as one line each ("read src/app.ts (420
 *           |  lines)", "edited x +12 −3", "ran `pnpm test` → exit 0"),
 *           |  never as the full output, so a mixed thread does not
 *           |  resend thousands of lines to every model.
 *  How      |  A tool call is paired with its result by call id. Known
 *           |  tools (Claude Code's, NVX Ancile's) get a tailored line;
 *           |  anything else says what was called and whether it
 *           |  worked. Paths are shown relative to the session's
 *           |  folder when there is one, else by their last parts.
 *  Note     |  Pure. Digests are for models, not shown in the UI.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';

const MAX_ARG = 80;
const MAX_LINE = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string, n = MAX_ARG) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const lines = (s: string) => (s ? s.split(/\r?\n/).length : 0);

/** A tool result's text (Claude Code keeps strings; Ancile's tools keep JSON). */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result))
    return result
      .map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : typeof b === 'string' ? b : ''))
      .filter(Boolean)
      .join('\n');
  if (isObj(result) && typeof result.text === 'string') return result.text;
  if (result === null || result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return '';
  }
}

/** A path as a person would say it: relative to the folder, else its last three parts. */
export function shortPath(p: string, cwd?: string | null): string {
  const norm = p.replace(/\\/g, '/');
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return norm.slice(base.length + 1);
  }
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : norm;
}

function exitOf(text: string, ok: boolean): string {
  const m = /exit(?:ed with)? code[:\s]+(-?\d+)/i.exec(text) ?? /exit status (-?\d+)/i.exec(text);
  if (m) return `exit ${m[1]}`;
  return ok ? 'exit 0' : 'failed';
}

function firstLine(text: string): string {
  const l = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean);
  return l ? clip(l, 120) : '';
}

/** Lines added and removed between two texts, the way a diff stat counts them. */
export function lineDelta(before: string, after: string): { add: number; del: number } {
  const a = before ? before.split(/\r?\n/) : [];
  const b = after ? after.split(/\r?\n/) : [];
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let kept = 0;
  for (const l of b) {
    const n = counts.get(l) ?? 0;
    if (n > 0) {
      counts.set(l, n - 1);
      kept++;
    }
  }
  return { add: b.length - kept, del: a.length - kept };
}

/** One line for one tool step. */
export function digestStep(
  tool: string,
  args: unknown,
  result: { ok: boolean; result: unknown } | null,
  cwd?: string | null,
): string {
  const a = isObj(args) ? args : {};
  const out = result ? resultText(result.result) : '';
  const ok = result ? result.ok : true;
  const fail = result && !result.ok ? ' (failed)' : '';
  const path = (k = 'file_path') => shortPath(str(a[k]) || str(a.path) || str(a.notebook_path) || '?', cwd);
  const name = tool.toLowerCase();
  let line: string;
  switch (tool) {
    case 'Read': {
      const n = out ? lines(out) : 0;
      line = `read ${path()}${n ? ` (${n} lines)` : ''}${fail}`;
      break;
    }
    case 'Edit': {
      const d = lineDelta(str(a.old_string), str(a.new_string));
      line = `edited ${path()} +${d.add} −${d.del}${fail}`;
      break;
    }
    case 'MultiEdit': {
      const edits = Array.isArray(a.edits) ? a.edits.filter(isObj) : [];
      let add = 0;
      let del = 0;
      for (const e of edits) {
        const d = lineDelta(str(e.old_string), str(e.new_string));
        add += d.add;
        del += d.del;
      }
      line = `edited ${path()} +${add} −${del}${fail}`;
      break;
    }
    case 'Write':
      line = `wrote ${path()} (${lines(str(a.content))} lines)${fail}`;
      break;
    case 'NotebookEdit':
      line = `edited the notebook ${path('notebook_path')}${fail}`;
      break;
    case 'Bash':
    case 'PowerShell':
      line = `ran \`${clip(str(a.command))}\` → ${result ? exitOf(out, ok) : 'no result'}`;
      break;
    case 'Grep': {
      const n = out ? out.split(/\r?\n/).filter(Boolean).length : 0;
      line = `searched for \`${clip(str(a.pattern), 50)}\`${a.path ? ` in ${shortPath(str(a.path), cwd)}` : ''} (${n} matches)${fail}`;
      break;
    }
    case 'Glob': {
      const n = out ? out.split(/\r?\n/).filter(Boolean).length : 0;
      line = `listed files matching \`${clip(str(a.pattern), 50)}\` (${n})${fail}`;
      break;
    }
    case 'LS':
      line = `listed ${path()}${fail}`;
      break;
    case 'WebFetch':
      line = `fetched ${clip(str(a.url))}${fail}`;
      break;
    case 'WebSearch':
      line = `searched the web for \`${clip(str(a.query), 60)}\`${fail}`;
      break;
    case 'Task':
    case 'Agent': {
      const what = clip(str(a.description) || str(a.prompt) || 'a task', 80);
      const said = out ? firstLine(out) : '';
      line = `subagent: ${what}${said ? ` → ${said}` : ''}${fail}`;
      break;
    }
    case 'TodoWrite': {
      const n = Array.isArray(a.todos) ? a.todos.length : 0;
      line = `updated the to-do list (${n} items)`;
      break;
    }
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = tool.split('__');
        line = `called ${server}/${rest.join('__') || '?'}${fail}`;
        break;
      }
      const keys = Object.entries(a)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .slice(0, 2)
        .map(([k, v]) => `${k}=${clip(String(v), 40)}`)
        .join(', ');
      line = `called ${tool}${keys ? ` (${keys})` : ''} → ${result ? (ok ? 'ok' : 'failed') : 'no result'}`;
    }
  }
  return clip(line, MAX_LINE);
}

/**
 * A message's parts as plain text for another model: text kept, thinking
 * left out, each tool step one line, files and images named.
 */
export function digestParts(parts: Part[], cwd?: string | null): { text: string; digested: number } {
  const results = new Map<string, { ok: boolean; result: unknown }>();
  for (const p of parts) if (p.type === 'tool_result') results.set(p.call_id, p);
  const out: string[] = [];
  let digested = 0;
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.trim()) out.push(p.text.trim());
    } else if (p.type === 'tool_call') {
      digested++;
      out.push(`[tool] ${digestStep(p.tool, p.args, results.get(p.call_id) ?? null, cwd)}`);
    } else if (p.type === 'tool_result') {
      // Paired with its call above; an orphan result (the call was in an earlier message) is named only.
      if (!parts.some((q) => q.type === 'tool_call' && q.call_id === p.call_id)) {
        digested++;
        out.push(`[tool result] ${p.ok ? 'ok' : 'failed'}: ${firstLine(resultText(p.result))}`);
      }
    } else if (p.type === 'image') out.push(p.caption ? `[image: ${clip(p.caption)}]` : '[image]');
    else if (p.type === 'file') out.push(`[file ${p.name}]`);
  }
  return { text: out.join('\n'), digested };
}
