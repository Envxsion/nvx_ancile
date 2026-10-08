import { describe, expect, it } from 'vitest';
import { applyPolicy, type CaptureCandidate } from '../../src/memory/capture';

const candidate = (over: Partial<CaptureCandidate>): CaptureCandidate => ({
  kind: 'preference',
  targetPath: 'USER.md',
  section: 'Preferences',
  text: 'Use British spelling.',
  confidence: 0.95,
  evidence: [{ messageId: 'msg_1' }],
  provenance: 'user_message',
  ...over,
});
const add = { op: 'add' as const, text: 'x', rationale: 'r' };

describe('memory apply policy (DESIGN.md §6.3)', () => {
  it('auto-applies confident corrections the user made themselves', () => {
    expect(applyPolicy(candidate({}), add, 0.85, 'auto_confident')).toBe('auto_apply');
  });

  it('proposes below the threshold', () => {
    expect(applyPolicy(candidate({ confidence: 0.6 }), add, 0.85, 'auto_confident')).toBe('propose');
  });

  it.each(['tool_output', 'source_content'] as const)(
    'never auto-applies anything that came from %s',
    (provenance) => {
      expect(applyPolicy(candidate({ provenance, confidence: 1 }), add, 0.1, 'auto_confident')).toBe(
        'propose',
      );
    },
  );

  it('respects propose-all and off, and skips no-ops', () => {
    expect(applyPolicy(candidate({}), add, 0.85, 'propose_all')).toBe('propose');
    expect(applyPolicy(candidate({}), add, 0.85, 'off')).toBe('skip');
    expect(applyPolicy(candidate({}), { ...add, op: 'noop' }, 0.85, 'auto_confident')).toBe('skip');
  });
});
