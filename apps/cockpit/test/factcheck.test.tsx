import type { Factcheck, FactcheckClaim } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClaimCard } from '../src/drawer/EvidencePanel';
import { ClaimsProvider, LiveClaim, markClaims, VerdictMark } from '../src/thread/Claims';
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
  critical: false,
  confidence: 0.84,
  verifier_model_id: 'offline/echo',
  claims: [],
  counts: { verified: 3, partly: 0, unverified: 0, contradicted: 0, not_checkable: 1 },
  sealed: true,
  summary: '3 of 3 claims verified.',
  scope: { notebook_id: null, web: false },
  error: null,
  created_at: '2026-10-07T00:00:00.000Z',
  finished_at: '2026-10-07T00:00:01.000Z',
  previous: null,
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
          counts: { verified: 1, partly: 0, unverified: 1, contradicted: 1, not_checkable: 0 },
        })}
        progress={undefined}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('1 contradicted');
    expect(screen.getByRole('button')).toHaveAttribute('data-level', 'low');
  });

  it('keeps the score before a re-run beside the new one, and says when sources changed', () => {
    wrap(
      <FactcheckChip
        messageId="msg_1"
        factcheck={fc({
          sealed: false,
          confidence: 0.42,
          counts: { verified: 1, partly: 0, unverified: 2, contradicted: 0, not_checkable: 0 },
          previous: {
            id: 'fck_0',
            confidence: 0.84,
            summary: '3 of 3 claims verified.',
            finished_at: '2026-10-06T00:00:00.000Z',
            sources_changed: true,
            removed: 1,
            changed: 0,
            note: 'Sources changed since: 1 removed.',
          },
        })}
        progress={undefined}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('42%');
    expect(screen.getByText('Was', { exact: false })).toHaveTextContent('Was 84%');
    expect(screen.getByText('Sources changed since: 1 removed.')).toBeInTheDocument();
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

describe('Partly holds', () => {
  const partly: FactcheckClaim = {
    ...claim('clm_p', 0, 12, 'partly'),
    text: 'Mount Everest is 8,849 metres tall.',
    check: {
      tier_used: 'fast',
      model_id: 'offline/echo',
      escalated_from: null,
      cached: null,
      degraded: [],
      general_knowledge: false,
      nuance: 'The source gives 8,848.86 m; the claim rounds it.',
    },
  };

  it('has its own words, distinct from holds and doesnt hold', () => {
    const { container } = render(<VerdictMark verdict="partly" />);
    expect(container).toHaveTextContent('Partly holds');
    expect(container.firstElementChild).toHaveAttribute('data-verdict', 'partly');
  });

  it('marks the claim and shows the nuance on its card', async () => {
    const { container } = render(
      <Tooltip.Provider>
        <ClaimsProvider messageId="msg_1" claims={[partly]}>
          <LiveClaim id="clm_p">Mount Everest is 8,849 metres tall.</LiveClaim>
        </ClaimsProvider>
      </Tooltip.Provider>,
    );
    const mark = container.querySelector('.claim');
    expect(mark).toHaveAttribute('data-verdict', 'partly');
    expect(mark).toHaveTextContent('Partly holds');
  });

  it('says what differs in the evidence panel', () => {
    render(
      <Tooltip.Provider>
        <ul>
          <ClaimCard c={partly} focused={false} />
        </ul>
      </Tooltip.Provider>,
    );
    expect(screen.getByText('The source gives 8,848.86 m; the claim rounds it.')).toBeInTheDocument();
    expect(screen.getByText('Partly holds')).toBeInTheDocument();
  });

  it('counts partly claims in the chip and no longer seals', () => {
    render(
      <Tooltip.Provider>
        <FactcheckChip
          messageId="msg_1"
          factcheck={fc({
            sealed: false,
            counts: { verified: 2, partly: 1, unverified: 0, contradicted: 0, not_checkable: 0 },
          })}
          progress={undefined}
        />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('2 of 3 hold, 1 in part');
  });

  it('reads an old check whose counts have no partly', () => {
    const old = fc({});
    const counts = { verified: 3, unverified: 0, contradicted: 0, not_checkable: 1 } as Factcheck['counts'];
    render(
      <Tooltip.Provider>
        <FactcheckChip messageId="msg_1" factcheck={{ ...old, counts }} progress={undefined} />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Every claim verified');
  });
});
