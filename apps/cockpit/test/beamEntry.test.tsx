/**
 * B1: Beam opens from the composer's Compare models button, in a Claude
 * Code thread too (where / opens Claude Code's own commands), with the
 * draft as the question, which leaves the composer once the beam starts;
 * and from Beam this question on a message, which beams the question
 * already asked (an answer's own question) instead of writing a new one.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...real,
    api: {
      get: vi.fn().mockResolvedValue([]),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
    },
  };
});

import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import type { MessageView, ThreadView } from '../src/lib/types';
import { useBeam } from '../src/pro/beam';
import { useUi } from '../src/state/ui';
import { Composer } from '../src/thread/Composer';
import { MessageActions } from '../src/thread/MessageActions';

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const msg = (p: Partial<MessageView> & Pick<MessageView, 'id' | 'role'>): MessageView => ({
  parentId: null,
  blocks: [],
  parts: [{ type: 'text', text: `${p.id} text` }],
  modelId: null,
  createdAt: '2026-10-14T10:00:00Z',
  status: 'complete',
  ...p,
});

const question = msg({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Why is the sky blue?' }] });
const answer = msg({ id: 'm2', role: 'assistant', parentId: 'm1' });

beforeEach(() => {
  queryClient.clear();
  useBeam.setState({ open: null });
  useUi.setState({ demo: false });
  queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
    id: 'thr_1',
    title: 'Sky',
    notebookId: 'nb_1',
    model: null,
    messages: [question, answer],
    activeRun: null,
    claudeCode: null,
    headId: 'm2',
    total: 2,
    cursor: 'm1',
    hasMore: false,
  } as ThreadView);
});

describe('Compare models in the composer', () => {
  it('opens Beam with the draft as the question, and clears the draft once the beam starts', () => {
    wrap(<Composer threadId="thr_1" parentId="m2" onSend={vi.fn()} notebookId="nb_1" />);
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Compare these please ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    const open = useBeam.getState().open;
    expect(open).toMatchObject({
      threadId: 'thr_1',
      notebookId: 'nb_1',
      parentId: 'm2',
      text: 'Compare these please',
    });
    expect(input.value).toBe('Compare these please ');
    act(() => open?.onStarted?.());
    expect(input.value).toBe('');
  });

  it('opens Beam with nothing to clear when the draft is empty', () => {
    wrap(<Composer threadId="thr_1" parentId="m2" onSend={vi.fn()} notebookId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    expect(useBeam.getState().open).toMatchObject({ text: '', notebookId: null });
    expect(useBeam.getState().open?.onStarted).toBeUndefined();
  });

  it('is there in a Claude Code thread, whose / menu has no /beam', () => {
    wrap(
      <Composer
        threadId="thr_1"
        parentId="m2"
        onSend={vi.fn()}
        notebookId="nb_1"
        claudeCode={{ commands: [], act: vi.fn(), bar: <span />, working: false, onStop: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    expect(useBeam.getState().open).toMatchObject({ threadId: 'thr_1' });
  });
});

describe('Beam this question', () => {
  it('on a question, beams that question as it was asked', () => {
    wrap(<MessageActions message={question} threadId="thr_1" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Beam this question' }));
    expect(useBeam.getState().open).toMatchObject({
      threadId: 'thr_1',
      notebookId: 'nb_1',
      questionId: 'm1',
      text: 'Why is the sky blue?',
    });
  });

  it('on an answer, beams the question it answered', () => {
    wrap(<MessageActions message={answer} threadId="thr_1" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Beam this question' }));
    expect(useBeam.getState().open).toMatchObject({ questionId: 'm1', text: 'Why is the sky blue?' });
  });

  it('says so when an answer has no question above it, and does nothing on demo data', () => {
    const orphan = msg({ id: 'm9', role: 'assistant', parentId: null });
    const first = wrap(<MessageActions message={orphan} threadId="thr_1" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Beam this question' }));
    expect(useBeam.getState().open).toBeNull();
    first.unmount();
    useUi.setState({ demo: true });
    wrap(<MessageActions message={question} threadId="thr_1" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Beam this question' }));
    expect(useBeam.getState().open).toBeNull();
  });
});
