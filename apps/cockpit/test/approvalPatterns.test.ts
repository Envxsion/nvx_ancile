/**
 * The approval dialog's "remember for" choices say what each pattern
 * covers, by its kind: a file or folder, a command, an address, a server.
 */
import { describe, expect, it } from 'vitest';
import { describePattern } from '../src/approvals/patterns';

const words = (ps: string[]) => ps.map((p, i) => describePattern(p, i, ps[0] ?? ''));

describe('describePattern', () => {
  it('a file, its folders and the workspace', () => {
    expect(words(['fs:/workspace/src/a.ts', 'fs:/workspace/src/**', 'fs:/workspace/**'])).toEqual([
      'This file only',
      'Anything under /workspace/src/',
      'Anything under /workspace/',
    ]);
  });

  it('a shell command is a command, never a file', () => {
    expect(words(['shell:pnpm test', 'shell:pnpm *'])).toEqual([
      'This exact command only',
      'Any pnpm command',
    ]);
    expect(words(['shell:ls'])).toEqual(['This exact command only']);
  });

  it('an address and an MCP server', () => {
    expect(words(['http:https://x.dev/a/b', 'http:https://x.dev/a/**'])).toEqual([
      'This address only',
      'Anything under https://x.dev/a/',
    ]);
    expect(words(['mcp:github/create_issue', 'mcp:github/*'])).toEqual([
      'This tool call only',
      'Any tool on the github server',
    ]);
  });
});
