/**
 * Where a claim's evidence came from (FC4): your sources, or the web with a link to the page.
 */
import type { FactcheckClaim } from '@nvx/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvidenceList } from '../src/thread/Claims';

const claim = (evidence: FactcheckClaim['evidence']): FactcheckClaim =>
  ({
    id: 'c1',
    text: 'Mount Everest is 8,849 metres tall.',
    verdict: 'verified',
    evidence,
  }) as FactcheckClaim;

const ev = (over: Partial<FactcheckClaim['evidence'][number]>): FactcheckClaim['evidence'][number] => ({
  kind: 'chunk',
  ref: 'chk_1',
  source_id: 'src_1',
  source_title: 'Atlas',
  page: null,
  char_start: null,
  char_end: null,
  quote: 'Everest is 8,849 metres tall.',
  stance: 'supports',
  score: 0.9,
  ...over,
});

describe('evidence origin', () => {
  it('marks a source passage Source, without a link', () => {
    render(<EvidenceList claim={claim([ev({ origin: 'source' })])} />);
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('marks a web passage Web and links the page it came from', () => {
    render(
      <EvidenceList
        claim={claim([
          ev({
            origin: 'web',
            kind: 'url',
            ref: 'https://geo.example/everest',
            source_id: null,
            source_title: 'geo.example',
          }),
        ])}
      />,
    );
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'geo.example' })).toHaveAttribute(
      'href',
      'https://geo.example/everest',
    );
  });
});
