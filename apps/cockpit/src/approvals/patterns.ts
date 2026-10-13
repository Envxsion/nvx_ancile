/**
 * ------------------------------------------------------------------
 *  Title    |  Patterns in the approval dialog
 *  Ref      |  docs/permissions.md#patterns
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say in words what each suggested pattern covers, check
 *           |  live whether a pattern of your own covers the request in
 *           |  front of you, and offer worked examples to start from.
 *  How      |  The matcher is Core's own (@nvx/contracts grant-patterns),
 *           |  so "matches: yes" here means Core will save it. Every
 *           |  example carries a request it must cover and one it must
 *           |  not; test/approvalPatterns.test.ts checks them all.
 * ------------------------------------------------------------------
 */

import { isWebPattern, matchResource } from '@nvx/contracts';
import type { PendingApproval } from '../lib/types';

const scheme = (s: string) => {
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : '';
};

/** Does `pattern` cover this request? A site rule covers searches and fetches only. */
export function patternCovers(pattern: string, a: Pick<PendingApproval, 'action' | 'resource'>): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (isWebPattern(p) && !a.action.startsWith('web.')) return false;
  return matchResource(p, a.resource);
}

/** One suggested pattern, in words. */
export function describePattern(p: string, i: number, resource: string): string {
  const s = scheme(resource);
  if (p === 'web:*') return 'Every web search and every website';
  if (p === 'web:search') return 'Every web search';
  if (i === 0 || p === resource) {
    switch (s) {
      case 'fs':
        return 'This file only';
      case 'web':
        return 'This search only';
      case 'http':
        return 'This address only';
      case 'shell':
        return 'This exact command only';
      case 'mcp':
        return 'This tool call only';
      default:
        return 'This only';
    }
  }
  if (s === 'fs' && p.endsWith('/**'))
    return `Anything under ${p.replace(/^fs:/, '').replace(/\/\*\*$/, '/')}`;
  if (s === 'http' && p.endsWith('/**'))
    return `Anything under ${p.replace(/^http:/, '').replace(/\*\*$/, '')}`;
  if (s === 'mcp' && p.endsWith('/*'))
    return `Any tool on the ${p.replace(/^mcp:/, '').replace(/\/\*$/, '')} server`;
  if (s === 'shell' && p.endsWith(' *')) return `Any ${p.replace(/^shell:/, '').replace(/ \*$/, '')} command`;
  return p;
}

export interface PatternExample {
  /** What it allows, in words. */
  label: string;
  pattern: string;
  /** How it differs from its neighbours, when that is not obvious. */
  note?: string;
  /** A request it covers (checked by the tests). */
  covers: { action: string; resource: string };
  /** A request it does not cover (checked by the tests). */
  misses: { action: string; resource: string };
}

const search = (q: string) => ({ action: 'web.search', resource: `web:search/${q}` });
const fetchOf = (url: string) => ({ action: 'web.fetch', resource: `http:${url}` });

export const PATTERN_EXAMPLES: PatternExample[] = [
  {
    label: 'All web searches',
    pattern: 'web:search',
    covers: search('tutoring centres in Leeds'),
    misses: fetchOf('https://example.com/'),
  },
  {
    label: 'All fetches, any website',
    pattern: 'web:fetch',
    covers: fetchOf('https://aiera.blog/post'),
    misses: search('tutoring centres'),
  },
  {
    label: 'All websites and all searches',
    pattern: 'web:*',
    covers: fetchOf('https://ai.g2.com/reviews'),
    misses: { action: 'shell.exec', resource: 'shell:curl https://ai.g2.com' },
  },
  {
    label: 'One site',
    pattern: 'web:example.com',
    note: 'Only example.com itself, not www.example.com or other subdomains.',
    covers: fetchOf('https://example.com/pricing'),
    misses: fetchOf('https://docs.example.com/'),
  },
  {
    label: 'A site and its subdomains',
    pattern: 'web:*.example.com',
    note: 'example.com and anything ending in .example.com, such as docs.example.com.',
    covers: fetchOf('https://docs.example.com/start'),
    misses: fetchOf('https://example.org/'),
  },
  {
    label: 'A path on a site, and everything below it',
    pattern: 'web:example.com/docs/**',
    covers: fetchOf('https://example.com/docs/api/auth'),
    misses: fetchOf('https://example.com/blog/'),
  },
  {
    label: 'All files under a folder',
    pattern: 'fs:/workspace/notes/**',
    note: '* is one level; ** is any depth.',
    covers: { action: 'fs.write', resource: 'fs:/workspace/notes/2026/trial.md' },
    misses: { action: 'fs.write', resource: 'fs:/workspace/finance/q3.md' },
  },
  {
    label: 'Commands that start the same way',
    pattern: 'shell:git status*',
    note: 'Never covers a second command chained on with ; && | or $( ).',
    covers: { action: 'shell.exec', resource: 'shell:git status --short' },
    misses: { action: 'shell.exec', resource: 'shell:git status; rm notes.md' },
  },
  {
    label: 'Every tool on one MCP server',
    pattern: 'mcp:github/*',
    covers: { action: 'mcp.github.create_issue', resource: 'mcp:github/create_issue' },
    misses: { action: 'mcp.slack.post', resource: 'mcp:slack/post' },
  },
];
