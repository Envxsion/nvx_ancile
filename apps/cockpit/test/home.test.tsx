/**
 * HM1: the start screen is a fresh new-thread screen. It no longer repeats
 * the sidebar ("Pick up where you left off"); it offers at most three
 * starters drawn from the current notebook (an open task, recent sources),
 * and none at all in presentation mode or without a notebook.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  notebooks: [] as unknown[],
  sources: [] as unknown[],
  notes: [] as unknown[],
  inserted: [] as { threadId: string; text: string }[],
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="#x">{children}</a>,
}));
vi.mock('../src/lib/data', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/data')>();
  return {
    ...real,
    useNotebooks: () => ({ data: hold.notebooks }),
    useSources: (id: string | null) => ({ data: id ? hold.sources : [] }),
    useNotes: (id: string | null) => ({ data: id ? hold.notes : [] }),
    useThreads: () => {
      throw new Error('Home must not list recent threads: the sidebar does');
    },
  };
});
vi.mock('../src/lib/models', () => ({ useCurrentModel: () => ({ id: 'm', name: 'M' }) }));
vi.mock('../src/help/steps', () => ({ useFirstSteps: () => ({ complete: true, dismissed: true }) }));
vi.mock('../src/help/FirstSteps', () => ({ FirstSteps: () => null }));
vi.mock('../src/telemetry/ShareStats', () => ({ ShareStatsCard: () => null }));
vi.mock('../src/thread/Composer', () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock('../src/lib/selectionWords', () => ({
  insertIntoComposer: (threadId: string, text: string) => hold.inserted.push({ threadId, text }),
}));

import { startersFor } from '../src/home/starters';
import type { SourceView } from '../src/lib/types';
import { HomeScreen } from '../src/routes/Home';
import { usePrefs } from '../src/state/prefs';

const nb = { id: 'nb1', title: 'Thesis', updatedAt: '2026-10-01', archived: false };
const src = (id: string, title: string, createdAt: string, status: SourceView['status'] = 'ready') => ({
  id,
  title,
  createdAt,
  status,
});
const note = {
  id: 'n1',
  content_md: '# Plan\n- [x] done\n- [ ] Draft chapter two\n',
  updated_at: '2026-10-02',
};

const present = (on: boolean) =>
  usePrefs.setState((s) => ({ prefs: { ...s.prefs, layout: { ...s.prefs.layout, presentation: on } } }));

beforeEach(() => {
  hold.notebooks = [nb];
  hold.sources = [
    src('s1', 'Old paper', '2026-09-01'),
    src('s2', 'Fresh paper', '2026-10-05'),
    src('s3', 'Another one', '2026-10-04'),
    src('s4', 'Still reading', '2026-10-06', 'extracting'),
  ];
  hold.notes = [note];
  hold.inserted = [];
  present(false);
});

describe('start screen', () => {
  it('does not repeat the sidebar: no recent threads', () => {
    render(<HomeScreen />);
    expect(screen.queryByText('Pick up where you left off')).toBeNull();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('offers at most three starters from the current notebook: one open task, then the newest ready sources', () => {
    render(<HomeScreen />);
    const cards = screen.getAllByRole('button').filter((b) => b.classList.contains('starter'));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent('Open task');
    expect(cards[0]).toHaveTextContent('Draft chapter two');
    expect(cards[1]).toHaveTextContent('Fresh paper');
    expect(cards[2]).toHaveTextContent('Another one');
    expect(screen.queryByText('Still reading')).toBeNull();
  });

  it('puts the starter in the composer instead of sending it', () => {
    render(<HomeScreen />);
    fireEvent.click(screen.getByText('Fresh paper').closest('button') as HTMLElement);
    expect(hold.inserted).toEqual([
      { threadId: 'new', text: 'Summarise "Fresh paper" and tell me what is worth acting on.' },
    ]);
  });

  it('shows nothing from a notebook in presentation mode', () => {
    present(true);
    render(<HomeScreen />);
    expect(screen.queryByText('Fresh paper')).toBeNull();
    expect(screen.queryByText('Draft chapter two')).toBeNull();
  });

  it('is calm with no notebook yet: the composer and the drop hint only', () => {
    hold.notebooks = [];
    render(<HomeScreen />);
    expect(screen.queryByText('Open task')).toBeNull();
    expect(screen.getByText(/Drop files here/)).toBeInTheDocument();
  });
});

describe('startersFor', () => {
  it('has no starters without a notebook or in presentation mode', () => {
    const base = { notes: [note], sources: [src('s', 'A', '2026-10-01')] };
    expect(startersFor({ ...base, notebookId: null, presenting: false })).toEqual([]);
    expect(startersFor({ ...base, notebookId: 'nb', presenting: true })).toEqual([]);
  });

  it('fills from sources when there is no open task', () => {
    const out = startersFor({
      notebookId: 'nb',
      notes: [{ ...note, content_md: '- [x] all done' }],
      sources: [src('a', 'A', '1'), src('b', 'B', '2'), src('c', 'C', '3'), src('d', 'D', '4')],
      presenting: false,
    });
    expect(out.map((s) => s.title)).toEqual(['D', 'C', 'B']);
  });
});
