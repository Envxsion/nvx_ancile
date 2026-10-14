/**
 * S0: a source's context level says what a question really gets.
 * "Passages" (stored as `full`) searches the source for each question;
 * the whole source is never sent, so the old "Full" label is gone.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));

import { ARTICLES } from '../src/help/articles';
import { queryClient } from '../src/lib/query';
import type { SourceView } from '../src/lib/types';
import { SourceCard } from '../src/sources/SourceCard';

const source: SourceView = {
  id: 'src_1',
  title: 'Field notes',
  kind: 'file',
  status: 'ready',
  detail: '12 pages',
  contextLevel: 'full',
  tags: [],
};

describe('what a question can use from a source', () => {
  it('calls the level Passages, never Full, and says the whole source is not sent', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <SourceCard s={source} notebookId="nb_1" />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    const levels = screen.getByRole('radiogroup', { name: 'What questions can use from Field notes' });
    expect(screen.getByRole('radio', { name: 'Passages' })).toBeChecked();
    expect(levels).not.toHaveTextContent('Full');
  });

  it('says the same in the help article', () => {
    const body = ARTICLES.find((a) => a.id === 'context-levels')?.body ?? '';
    expect(body).toMatch(/\*\*Passages\*\*/);
    expect(body).toMatch(/whole source is never sent at once/);
    expect(body).not.toMatch(/\*\*Full\*\*/);
  });
});
