import type { Factcheck, FactcheckClaim } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { markClaims } from '../src/thread/Claims';
import { FactcheckChip } from '../src/thread/Factcheck';

const claim = (
  id: string,
  start: number,
  end: number,
  verdict: FactcheckClaim['verdict'] = 'verified',
): FactcheckClaim => ({
  id,
  text: 'x',
  char_start: start,
  char_end: end,
  importance: 1,
  verdict,
  confidence: 0.8,
  support: 0.7,
  agreement: 1,
  retrieval: 0.9,
  evidence: [],
  rationale: '',
  explanation: '',
});

describe('markClaims', () => {
  const text = 'Owls are nocturnal. [1] They eat mice.';

  it('wraps each claim span as a claim link, at offsets into the answer', () => {
    expect(markClaims(text, 0, [claim('clm_a', 0, 19), claim('clm_b', 24, 38, 'contradicted')])).toBe(
      '[Owls are nocturnal.](#claim-clm_a) [1] [They eat mice.](#claim-clm_b)',
    );
  });

  it('honours where a text part starts in the answer', () => {
    expect(markClaims('They eat mice.', 24, [claim('clm_b', 24, 38)])).toBe('[They eat mice.](#claim-clm_b)');
  });

  it('leaves spans it cannot mark safely: across a citation, in code, outside the part, or opinions', () => {
    const t = 'Run `owls --fast` now. Owls are nocturnal.';
    expect(markClaims(text, 0, [claim('a', 0, 23)])).toBe(text);
    expect(markClaims(t, 0, [claim('b', 4, 17)])).toBe(t);
    expect(markClaims(t, 0, [claim('c', 30, 99)])).toBe(t);
    expect(markClaims(t, 0, [claim('d', 23, 42, 'not_checkable')])).toBe(t);
  });
});

const fc = (over: Partial<Factcheck>): Factcheck => ({
  id: 'fck_1',
  message_id: 'msg_1',
  run_id: 'run_1',
  status: 'done',
  confidence: 0.84,
  verifier_model_id: 'offline/echo',
  claims: [],
  counts: { verified: 3, unverified: 0, contradicted: 0, not_checkable: 1 },
  sealed: true,
  summary: '3 of 3 claims verified.',
  scope: { notebook_id: null, web: false },
  error: null,
  created_at: '2026-10-07T00:00:00.000Z',
  finished_at: '2026-10-07T00:00:01.000Z',
  ...over,
});

describe('FactcheckChip', () => {
  const wrap = (node: React.ReactNode) => render(<Tooltip.Provider>{node}</Tooltip.Provider>);

  it('wears the seal when every claim is verified', () => {
    wrap(<FactcheckChip messageId="msg_1" factcheck={fc({})} progress={undefined} />);
    const chip = screen.getByRole('button', { name: /fact-check: 3 of 3 claims verified/i });
    expect(chip).toHaveAttribute('data-sealed');
    expect(chip).toHaveTextContent('Every claim verified');
  });

  it('leads with contradictions', () => {
    wrap(
      <FactcheckChip
        messageId="msg_1"
        factcheck={fc({
          sealed: false,
          confidence: 0.4,
          counts: { verified: 1, unverified: 1, contradicted: 1, not_checkable: 0 },
        })}
        progress={undefined}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('1 contradicted');
    expect(screen.getByRole('button')).toHaveAttribute('data-level', 'low');
  });

  it('shows the stage and count while checking', () => {
    wrap(
      <FactcheckChip
        messageId="msg_1"
        factcheck={null}
        progress={{ stage: 'verifying', done: 2, total: 5 }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Checking claims2 of 5');
  });
});
