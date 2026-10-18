/**
 * Track C in the Cockpit: the notebook merge dialog (preview first, scope
 * fields that narrow, instructions chosen, then merge with an undo), the
 * merge history, context links on both ends with a refused link's reason,
 * the Why view's links, and context packs' locked state.
 */
import type { ContextLinkList, Explain, NotebookMerge, NotebookMergePreview } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  Link: ({
    children,
    to: _to,
    params: _p,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
  }) => (
    <a href="#link" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LinksDialog } from '../src/notebooks/LinksDialog';
import { MergeDialog } from '../src/notebooks/MergeDialog';
import { MergeHistory } from '../src/notebooks/MergeHistory';
import { ContextPacksLocked } from '../src/pro/ContextPacksLocked';
import { PRO_SURFACES } from '../src/pro/slot';
import { LinksUsed } from '../src/receipt/Sections';

const mocked = api as unknown as Record<'get' | 'post' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const PREVIEW: NotebookMergePreview = {
  into: { id: 'nbk_a', title: 'Alpha' },
  from: { id: 'nbk_b', title: 'Bravo' },
  threads: [
    { id: 'thr_1', title: 'One', cwd: null },
    { id: 'thr_2', title: 'Two', cwd: 'C:/work/repo' },
  ],
  notes: [{ id: 'not_1', title: 'N' }],
  sources: {
    move: [{ id: 's1', title: 'Trial log' }],
    already: [],
    duplicates: [{ id: 's2', title: 'Manual copy', into_id: 's0', into_title: 'Manual' }],
    versions: [{ id: 's3', title: 'Spec', into_id: 's4' }],
  },
  memory: { from_path: 'PROJECTS/bravo.md', into_path: 'PROJECTS/alpha.md', entries: 2 },
  flows: [{ id: 'flw_b', name: 'B flow', active: true, switched_off: true }],
  instructions: {
    into: { instructions: 'Answer briefly.', persona: '' },
    from: { instructions: 'Cite every claim.', persona: 'Engineer' },
    same: false,
  },
  scope: {
    private: { into: false, from: true, merged: true },
    changes: [
      {
        field: 'network',
        into: true,
        from: false,
        merged: false,
        narrows_into: true,
        narrows_from: false,
        note: 'Network for tools: on only if both notebooks allow it',
      },
    ],
    merged: { network: false },
  },
  tool_presets: { into: null, from: null, merged: null, folded: false },
  folders: { into: [], from: ['C:/work/repo'] },
  links: { retarget: 1, dropped: 0 },
  grants_left_behind: 2,
  undo_hours: 168,
  warnings: ['Bravo is private, so the merged notebook will be private: local models only.'],
};

const MERGE: NotebookMerge = {
  id: 'nbm_1',
  into_id: 'nbk_a',
  from_id: 'nbk_b',
  from_title: 'Bravo',
  merged_at: '2026-10-12T10:00:00.000Z',
  undo_until: '2026-10-19T10:00:00.000Z',
  undone_at: null,
  can_undo: true,
  counts: { threads: 2, notes: 1, sources_moved: 1, sources_deduplicated: 1, flows: 1, folders: 1, links: 1 },
  scope_narrowed: ['network'],
};

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/notebooks')
      return {
        items: [
          { id: 'nbk_a', title: 'Alpha', counts: { sources: 0, threads: 0, notes: 0 } },
          { id: 'nbk_b', title: 'Bravo', counts: { sources: 0, threads: 0, notes: 0 } },
        ],
      };
    if (path.includes('/merge-preview')) return PREVIEW;
    if (path.endsWith('/merges')) return { items: [MERGE] };
    if (path.startsWith('/threads?')) return { items: [], next_cursor: null };
    if (path.endsWith('/links'))
      return {
        outgoing: [
          {
            id: 'lnk_1',
            kind: 'sources',
            from: { kind: 'thread', id: 'thr_1', title: 'One' },
            to: { kind: 'notebook', id: 'nbk_p', title: 'Diary' },
            created_at: '2026-10-12T09:00:00.000Z',
            status: { ok: false, code: 'scope.private_notebook', reason: 'The notebook "Diary" is private' },
          },
        ],
        incoming: [],
      } satisfies ContextLinkList;
    throw new Error(`unexpected GET ${path}`);
  });
});

describe('merging a notebook', () => {
  it('previews first, says what narrows, lets you choose the instructions, then merges', async () => {
    mocked.post.mockResolvedValue(MERGE);
    const onOpenChange = vi.fn();
    wrap(
      <MergeDialog open onOpenChange={onOpenChange} into={{ id: 'nbk_a', title: 'Alpha' }} from="nbk_b" />,
    );
    expect(await screen.findByText('2 threads join')).toBeTruthy();
    expect(screen.getByText(/1 copy has the same content/)).toBeTruthy();
    expect(screen.getByText(/both are kept/)).toBeTruthy();
    expect(screen.getByText('The scope narrows')).toBeTruthy();
    expect(screen.getByText(/It becomes private/)).toBeTruthy();
    expect(screen.getByText('Network for tools')).toBeTruthy();
    expect(screen.getByText(/arrive switched off/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Combine them'));
    const box = screen.getByLabelText('Instructions') as HTMLTextAreaElement;
    expect(box.value).toBe('Answer briefly.\n\nCite every claim.');
    fireEvent.click(screen.getByRole('button', { name: 'Merge Bravo into Alpha' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocked.post).toHaveBeenCalledWith('/notebooks/nbk_a/merge', {
      from_id: 'nbk_b',
      instructions: {
        choice: 'combined',
        instructions: 'Answer briefly.\n\nCite every claim.',
        persona: 'Engineer',
      },
    });
  });

  it('keeps the merge in history with Undo', async () => {
    mocked.post.mockResolvedValue({ ...MERGE, undone_at: '2026-10-12T11:00:00.000Z', can_undo: false });
    wrap(<MergeHistory notebookId="nbk_a" />);
    expect(await screen.findByText('Bravo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo merge' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/notebook-merges/nbm_1/undo'));
  });
});

describe('context links', () => {
  it('lists both ends, says why a link is not read, and adds and removes links', async () => {
    mocked.post.mockResolvedValue({});
    mocked.del.mockResolvedValue(undefined);
    wrap(
      <LinksDialog
        open
        onOpenChange={() => {}}
        from={{ kind: 'thread', id: 'thr_1', title: 'One', notebookId: 'nbk_a' }}
      />,
    );
    expect(await screen.findByText(/Not read now: The notebook "Diary" is private/)).toBeTruthy();
    expect(screen.getByText('Nothing reads from it.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Draw on'), { target: { value: 'notebook:nbk_b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/threads/thr_1/links', {
        to_kind: 'notebook',
        to_id: 'nbk_b',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(mocked.del).toHaveBeenCalledWith('/context-links/lnk_1'));
  });

  it('shows in the receipt which links contributed and which were refused', () => {
    const links: Explain['links'] = [
      {
        link_id: 'lnk_1',
        kind: 'sources',
        via: 'thread',
        to_kind: 'notebook',
        to_id: 'nbk_b',
        title: 'Specs',
        state: 'used',
        passages: 3,
        cited: 2,
        code: null,
        reason: null,
      },
      {
        link_id: 'cpk_1',
        kind: 'pack',
        via: 'notebook',
        to_kind: 'pack',
        to_id: 'cpk_1',
        title: 'Diary bits',
        state: 'refused',
        passages: 0,
        cited: 0,
        code: 'scope.private_notebook',
        reason: 'It is private',
      },
    ];
    render(<LinksUsed links={links} />);
    expect(screen.getByText('Notebook “Specs”')).toBeTruthy();
    expect(screen.getByText('Used · 3 passages, 2 cited')).toBeTruthy();
    expect(screen.getByText('Context pack “Diary bits”')).toBeTruthy();
    expect(screen.getByText('Not read')).toBeTruthy();
    expect(screen.getByText('It is private')).toBeTruthy();
  });
});

describe('context packs (Pro)', () => {
  it('has a premium locked state in Admin', () => {
    expect(PRO_SURFACES.find((s) => s.id === 'context-packs')).toMatchObject({
      feature: 'context_packs',
      place: 'admin',
      locked: ContextPacksLocked,
    });
    wrap(<ContextPacksLocked build="free" />);
    expect(screen.getByRole('heading', { name: 'Context packs' })).toBeTruthy();
    expect(screen.getByText('Share it as a signed file')).toBeTruthy();
    expect(screen.getByText(/Context links and notebook merge are free/)).toBeTruthy();
    expect(screen.getByText('Example')).toBeTruthy();
  });
});
