/**
 * Pasted output in your message: fenced for display, prose left alone.
 */
import { describe, expect, it } from 'vitest';
import { costText } from '../src/thread/Message';
import { displayUserParts, fenceLogs } from '../src/thread/userText';

const LOG = `FAIL  src/poll.test.ts > retries a 503
AssertionError: expected 3 calls, got 2
 ❯ src/poll.test.ts:41:23
     41|     expect(fetchMock).toHaveBeenCalledTimes(3);
       |                       ^`;

describe('context blocks', () => {
  it('never shows the context block sent to Claude Code, or its reminders', () => {
    const parts = displayUserParts([
      {
        type: 'text',
        text: '<ancile-context>\nWhat the others said.\n</ancile-context>\n\n<system-reminder>x</system-reminder>\nNow add a test',
      },
    ]);
    expect(parts).toEqual([{ type: 'text', text: 'Now add a test' }]);
  });
});

describe('fenceLogs', () => {
  it('fences a pasted log and keeps the lead-in as prose', () => {
    const text = `Here's the output from CI:\n\n${LOG}\n\nFix it properly.`;
    expect(fenceLogs(text)).toBe(
      `Here's the output from CI:\n\n\`\`\`text\n${LOG}\n\`\`\`\n\nFix it properly.`,
    );
  });

  it('keeps a lead-in line inside the same paragraph out of the fence', () => {
    expect(fenceLogs(`It printed:\n${LOG}`)).toBe(`It printed:\n\n\`\`\`text\n${LOG}\n\`\`\``);
  });

  it('joins neighbouring log paragraphs into one block', () => {
    const out = fenceLogs(`${LOG}\n\n Test Files  1 failed | 14 passed (15)\n      Tests  1 failed (204)`);
    expect(out.match(/```/g)).toHaveLength(2);
  });

  it('leaves prose, short snippets and existing fences exactly as written', () => {
    const prose = 'Can you look at this?\nIt broke after the upgrade.\n\nThanks.';
    expect(fenceLogs(prose)).toBe(prose);
    expect(fenceLogs('a = 1;\nb = 2;')).toBe('a = 1;\nb = 2;');
    const fenced = `See:\n\`\`\`\n${LOG}\n\`\`\``;
    expect(fenceLogs(fenced)).toBe(fenced);
  });

  it('returns the same parts when nothing changes', () => {
    const parts = [{ type: 'text' as const, text: 'Short question.' }];
    expect(displayUserParts(parts)).toBe(parts);
  });
});

describe('costText', () => {
  it('never rounds a real cost down to nothing', () => {
    expect(costText(0.0004)).toBe('under $0.001');
    expect(costText(0.031)).toBe('$0.031');
    expect(costText(0.584)).toBe('$0.58');
    expect(costText(0)).toBe('$0.000');
  });
});
