/**
 * ------------------------------------------------------------------
 *  Title    |  Your words, as you pasted them
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A prompt often carries a pasted log, stack trace or
 *           |  test output. Rendered as prose it loses its columns;
 *           |  this finds those runs and fences them, so they read
 *           |  as the monospaced block they were.
 *  How      |  Paragraphs where most lines look like output
 *           |  (indentation, gutters, pipes, prompts, log levels,
 *           |  stack frames), 4+ lines together, become one ```text
 *           |  fence. Text that already has a fence is left as is.
 *  Note     |  Display only: the stored message is never changed.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';

const LOGGY = [
  /^\s{2,}\S/, // indented
  /^\s*\d+\s*[|│→:]/, // line-number gutters
  /[|│]\s*$|\s[|│]\s/, // pipes and table rules
  /^\s*[❯›>$#]\s/, // prompts and pointers
  /^\s*(FAIL|PASS|ERROR|ERR!|WARN|INFO|DEBUG|TRACE|stderr|stdout|Traceback|at |File ")/,
  /\b\w+Error\b:/, // "AssertionError: …"
  /[{};]\s*$/, // code endings
  /^\s*[\^~]+\s*$/, // carets under a column
  /\w+=\S+.*\w+=\S+/, // key=value pairs
  /\(\d+(\.\d+)?\s*m?s\)|\d+\s*passed|\d+\s*failed/, // test runner tallies
];

const loggy = (line: string) => LOGGY.some((re) => re.test(line));

interface Para {
  lines: string[];
  /** Leading prose lines ("Here's the output:") kept out of the fence. */
  lead: number;
  log: boolean;
}

function para(text: string): Para {
  const lines = text.split('\n');
  let lead = 0;
  while (lead < lines.length - 1 && !loggy(lines[lead] ?? '') && /:\s*$/.test(lines[lead] ?? '')) lead++;
  const rest = lines.slice(lead).filter((l) => l.trim());
  const log = rest.length > 0 && rest.filter(loggy).length / rest.length >= 0.5;
  return { lines, lead, log };
}

/** Fences runs of pasted output in plain text; everything else is returned as is. */
export function fenceLogs(text: string): string {
  if (text.includes('```') || !text.includes('\n')) return text;
  const paras = text.split(/\n[ \t]*\n/).map(para);
  if (!paras.some((p) => p.log)) return text;
  const out: string[] = [];
  let i = 0;
  while (i < paras.length) {
    const p = paras[i] as Para;
    if (!p.log) {
      out.push(p.lines.join('\n'));
      i++;
      continue;
    }
    // Neighbouring log paragraphs are one paste.
    let j = i + 1;
    while (j < paras.length && paras[j]?.log && paras[j]?.lead === 0) j++;
    const block = paras.slice(i, j);
    const body = block.map((b, k) => b.lines.slice(k === 0 ? p.lead : 0).join('\n'));
    const size = body.join('\n').split('\n').length;
    if (size < 4) out.push(...block.map((b) => b.lines.join('\n')));
    else {
      if (p.lead) out.push(p.lines.slice(0, p.lead).join('\n'));
      out.push(['```text', body.join('\n\n'), '```'].join('\n'));
    }
    i = j;
  }
  return out.join('\n\n');
}

/**
 * NVX Ancile's context block for Claude Code (<ancile-context>…) and Claude
 * Code's own notes (<system-reminder>…) are never the person's words.
 * Core leaves them out when it brings a prompt in; this is the backstop.
 */
export function hideContextBlocks(text: string): string {
  if (!text.includes('<')) return text;
  return text.replace(/<(ancile-context|system-reminder)>[\s\S]*?<\/\1>\s*/g, '');
}

/** Your message's parts with context blocks hidden and pasted output fenced, for display. */
export function displayUserParts(parts: Part[]): Part[] {
  let changed = false;
  const next = parts.map((p) => {
    if (p.type !== 'text') return p;
    const text = fenceLogs(hideContextBlocks(p.text));
    if (text === p.text) return p;
    changed = true;
    return { ...p, text };
  });
  return changed ? next : parts;
}
