/**
 * "New Claude Code thread in a folder" in the palette: always listed, and
 * until Claude Code is known to be there it says why it cannot start one.
 */
import { describe, expect, it } from 'vitest';
import { newClaudeCodeBlocked } from '../src/palette/Palette';

describe('New Claude Code thread in a folder', () => {
  it('is offered once Claude Code is installed', () => {
    expect(newClaudeCodeBlocked({ installed: true }, false)).toBeUndefined();
  });

  it('says why not while the status loads, when it failed, and when Claude Code is missing', () => {
    expect(newClaudeCodeBlocked(undefined, false)).toBe('Checking for Claude Code');
    expect(newClaudeCodeBlocked(undefined, true)).toBe("Claude Code's status could not be read");
    expect(newClaudeCodeBlocked({ installed: false }, false)).toBe(
      'Claude Code is not installed. Set it up in Settings → Claude Code',
    );
  });
});
