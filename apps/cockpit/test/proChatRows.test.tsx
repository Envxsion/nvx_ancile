/**
 * CH6, CH7 and EX3 (Pro halves), as the public Cockpit shows them: where Pro is not on, a quiet line
 * says what it adds and nothing is broken; where it is, the Pro part gets the right props and what
 * Core sends is shown as it is. The Pro screens themselves are tested in pro/cockpit/test.
 */
import { keptWords, pageRuns } from '@nvx/contracts/attachments';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, params }: { children: ReactNode; params?: { section?: string } }) => (
    <a href={`#${params?.section ?? ''}`}>{children}</a>
  ),
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

// The licence and the Pro UI are the one thing these tests steer.
const pro = vi.hoisted(() => ({
  state: { unlocked: false, loading: false, build: 'free' as 'free' | 'pro', ui: null as unknown },
}));
vi.mock('../src/pro/slot', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/pro/slot')>();
  return { ...real, useProFeature: () => ({ ...pro.state, noSeat: false }) };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { AttachPro } from '../src/thread/AttachPro';
import { chipWords } from '../src/thread/attach';
import { ExportPro } from '../src/thread/ExportPro';
import { ModelQueue } from '../src/thread/ModelQueue';
import { Parts } from '../src/thread/Parts';
import {
  isPlain,
  queueStep,
  resolveSteer,
  STEER_WORDS,
  setSteer,
  takeBack,
  useQueue,
} from '../src/thread/queue';
import { SteerNotes, steeredOf } from '../src/thread/SteerNotes';

const get = vi.mocked(api.get);
const del = vi.mocked(api.del);

const wrap = (ui: ReactNode) => <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
const extras = (over = {}) => ({ mentions: [], model: null, flowId: null, ...over });
const queue = (over = {}) =>
  useQueue.setState({
    byThread: { t1: { text: 'Later', extras: extras(), after: 'a1', state: 'waiting', ...over } },
  });

beforeEach(() => {
  pro.state = { unlocked: false, loading: false, build: 'free', ui: null };
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  useQueue.setState({ byThread: {} });
  get.mockReset();
  del.mockReset();
});

describe('CH6: the chip', () => {
  it('says what it holds, and with Pro what it costs in tokens', () => {
    expect(chipWords({ kind: 'pdf', pages: 40, truncated: false })).toBe('40 pages');
    expect(chipWords({ kind: 'pdf', pages: 1, truncated: true })).toBe('1 page, start only');
    expect(chipWords({ kind: 'text', pages: null, truncated: false })).toBe('');
    expect(chipWords({ kind: 'pdf', pages: 40, truncated: false, tokens: 18_400 })).toBe(
      '40 pages, about 18,400 tokens',
    );
    expect(chipWords({ kind: 'text', pages: null, truncated: false, tokens: 12 })).toBe('about 12 tokens');
  });

  it('shows one quiet line about Pro where it is not on, and nothing where it is', () => {
    render(
      wrap(
        <ul>
          <AttachPro />
        </ul>,
      ),
    );
    expect(screen.getByText(/Pro shows what each file costs in tokens/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'About Pro' })).toBeTruthy();
    cleanup();
    pro.state.unlocked = true;
    render(
      wrap(
        <ul>
          <AttachPro />
        </ul>,
      ),
    );
    expect(screen.queryByText(/Pro shows what each file costs/)).toBeNull();
    cleanup();
    pro.state = { ...pro.state, unlocked: false, loading: true };
    render(
      wrap(
        <ul>
          <AttachPro />
        </ul>,
      ),
    );
    expect(screen.queryByText(/Pro shows/)).toBeNull();
  });

  it('writes a trimmed file as "Pages 3–7 of 40 kept"', () => {
    expect(keptWords({ pages: [3, 4, 5, 6, 7], of: 40, unit: 'page' })).toBe('Pages 3–7 of 40 kept');
    expect(keptWords({ pages: [3, 4, 5, 6, 7, 12], of: 40, unit: 'page' })).toBe('Pages 3–7, 12 of 40 kept');
    expect(keptWords({ pages: [1], of: 1, unit: 'page', partial: true })).toBe(
      'Page 1 of 1 kept, the last one in part',
    );
    expect(keptWords({ pages: [2, 3], of: 9, unit: 'part' })).toBe('Parts 2–3 of 9 kept');
    expect(pageRuns([5, 3, 4, 4, 9])).toBe('3–5, 9');
  });

  it('shows it on the sent file, beside its page count', () => {
    render(
      wrap(
        <Parts
          streaming={false}
          waiting={false}
          parts={[
            {
              type: 'file',
              name: 'manual.pdf',
              mime: 'application/pdf',
              url: '',
              text: 'x',
              pages: 40,
              kept: { pages: [3, 4, 5, 6, 7], of: 40, unit: 'page' },
            },
          ]}
        />,
      ),
    );
    expect(screen.getByText('manual.pdf')).toBeTruthy();
    expect(screen.getByText('40 pages')).toBeTruthy();
    expect(screen.getByText('Pages 3–7 of 40 kept')).toBeTruthy();
  });
});

describe('CH7: what to do with a queued message', () => {
  const at = (p: Partial<Parameters<typeof queueStep>[1]> = {}) => ({
    busy: false,
    lastId: 'a1',
    lastStatus: 'complete',
    ...p,
  });
  const q = (steer?: { id: string; state: 'sending' | 'pending' | 'applied' }) => ({
    state: 'waiting' as const,
    after: 'a1',
    ...(steer && { steer }),
  });

  it('lets a note the model has read go whatever happens to the turn, and waits while one is in flight', () => {
    expect(queueStep(q({ id: 'n', state: 'applied' }), at({ busy: true }))).toBe('steered');
    expect(queueStep(q({ id: 'n', state: 'applied' }), at({ lastStatus: 'error' }))).toBe('steered');
    expect(queueStep(q({ id: 'n', state: 'pending' }), at({ busy: true }))).toBe('wait');
    expect(queueStep(q({ id: '', state: 'sending' }), at({ lastStatus: 'streaming' }))).toBe('wait');
  });

  it('asks Core once when the turn ends with the note still waiting, even if the turn errored', () => {
    expect(queueStep(q({ id: 'n', state: 'pending' }), at())).toBe('resolve-steer');
    expect(queueStep(q({ id: 'n', state: 'pending' }), at({ lastStatus: 'error' }))).toBe('resolve-steer');
    // Without a note nothing changes: an error holds, another branch holds, otherwise it sends.
    expect(queueStep(q(), at({ lastStatus: 'error' }))).toBe('hold-error');
    expect(queueStep(q(), at({ lastId: 'x' }))).toBe('hold-branch');
    expect(queueStep(q(), at())).toBe('send');
  });

  it('drops the message once Core says the model read the note', async () => {
    queue();
    setSteer('t1', { id: 'stn_1', state: 'pending' });
    get.mockResolvedValue({ state: 'applied' });
    expect(await resolveSteer('t1')).toBe('applied');
    expect(get).toHaveBeenCalledWith('/pro/steer/stn_1');
    expect(useQueue.getState().byThread.t1).toBeUndefined();
  });

  it('sends it as a normal message when the note missed the turn, or Core cannot say', async () => {
    for (const reply of [
      () => Promise.resolve({ state: 'expired' }),
      () => Promise.reject(new Error('down')),
    ]) {
      queue();
      setSteer('t1', { id: 'stn_1', state: 'pending' });
      get.mockImplementation(reply as never);
      expect(await resolveSteer('t1')).toBe('missed');
      const left = useQueue.getState().byThread.t1;
      expect(left).toMatchObject({ text: 'Later', state: 'waiting' });
      expect(left?.steer).toBeUndefined();
      expect(queueStep(left, at())).toBe('send');
    }
  });

  it('takes a waiting note back from Core and returns its words, but does not give back one the model read', () => {
    queue();
    setSteer('t1', { id: 'stn_2', state: 'pending' });
    del.mockResolvedValue({});
    expect(takeBack('t1')).toBe('Later');
    expect(del).toHaveBeenCalledWith('/pro/steer/stn_2');
    queue();
    setSteer('t1', { id: 'stn_3', state: 'applied' });
    expect(takeBack('t1')).toBeNull();
    expect(useQueue.getState().byThread.t1).toBeUndefined();
    expect(takeBack('t1')).toBeNull();
  });

  it('offers only words as a note: files, images, a flow, a chosen model or a mention wait for the turn', () => {
    expect(isPlain(extras() as never)).toBe(true);
    expect(isPlain(extras({ attachments: [{}] }) as never)).toBe(false);
    expect(isPlain(extras({ images: [{}] }) as never)).toBe(false);
    expect(isPlain(extras({ flowId: 'f' }) as never)).toBe(false);
    expect(isPlain(extras({ model: 'm' }) as never)).toBe(false);
    expect(isPlain(extras({ mentions: [{ kind: 'source', id: 's' }] }) as never)).toBe(false);
  });

  it('has words for each state', () => {
    expect(STEER_WORDS.pending).toBe('Goes to the model at its next step');
    expect(STEER_WORDS.applied).toBe('The model has your note');
  });
});

describe('CH7: the queued line', () => {
  const line = (busy = true) =>
    render(wrap(<ModelQueue threadId="t1" busy={busy} onSendNow={vi.fn()} onRemove={vi.fn()} />));

  it('without Pro keeps one message that sends when the turn ends, and says what Pro adds', () => {
    queue();
    line();
    expect(screen.getByText('Sends when this turn ends')).toBeTruthy();
    expect(screen.getByText(/Add it as a note the model reads at its next step: part of Pro/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'About Pro' })).toBeTruthy();
    // Still the free controls.
    expect(screen.getByRole('button', { name: 'Stop and send now' })).toBeTruthy();
  });

  it('says nothing about Pro once the turn has ended, or for a message that is held', () => {
    queue();
    line(false);
    expect(screen.queryByText(/part of Pro/)).toBeNull();
    cleanup();
    queue({ state: 'held', why: 'error' });
    line();
    expect(screen.getByText('The answer stopped with an error. Your message is still here.')).toBeTruthy();
    expect(screen.queryByText(/part of Pro/)).toBeNull();
  });

  it('with Pro hands the control the message, whether it can be a note, and how to report back', () => {
    const seen: Record<string, unknown>[] = [];
    pro.state = {
      unlocked: true,
      loading: false,
      build: 'pro',
      ui: {
        parts: {
          SteerQueue: (
            p: Record<string, unknown> & { onSteer: (s: unknown) => void; onBranchChanged: () => void },
          ) => {
            seen.push(p);
            return (
              <>
                <button type="button" onClick={() => p.onSteer({ id: 'stn_9', state: 'pending' })}>
                  steer
                </button>
                <button type="button" onClick={() => p.onBranchChanged()}>
                  branch
                </button>
              </>
            );
          },
        },
      },
    };
    queue({ extras: extras({ attachments: [{}] }) });
    line();
    expect(seen.at(-1)).toMatchObject({
      threadId: 't1',
      text: 'Later',
      after: 'a1',
      plain: false,
      steer: null,
    });
    cleanup();
    queue();
    line();
    expect(seen.at(-1)).toMatchObject({ plain: true });
    fireEvent.click(screen.getByRole('button', { name: 'steer' }));
    expect(useQueue.getState().byThread.t1?.steer).toEqual({ id: 'stn_9', state: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: 'branch' }));
    expect(useQueue.getState().byThread.t1).toMatchObject({ state: 'held', why: 'branch' });
  });

  it('falls back to the free words when Pro has no control yet, and while the licence loads', () => {
    pro.state = { unlocked: true, loading: false, build: 'pro', ui: { parts: {} } };
    queue();
    line();
    expect(screen.getByText('Sends when this turn ends')).toBeTruthy();
    expect(screen.queryByText(/part of Pro/)).toBeNull();
    cleanup();
    pro.state = { unlocked: false, loading: true, build: 'free', ui: null };
    line();
    expect(screen.getByText('Sends when this turn ends')).toBeTruthy();
    expect(screen.queryByText(/part of Pro/)).toBeNull();
  });
});

describe('CH7: notes shown on the answer', () => {
  it('reads what Core recorded and shows each note as plain words', () => {
    const prov = {
      steered: [{ text: 'Use <b>Q3</b>', round: 1, at: 'x' }, { text: '', round: 2 }, { nope: 1 }],
    };
    expect(steeredOf(prov)).toEqual([{ text: 'Use <b>Q3</b>', round: 1 }]);
    expect(steeredOf(undefined)).toEqual([]);
    expect(steeredOf({ steered: 'x' })).toEqual([]);
    render(<SteerNotes provenance={prov} />);
    expect(screen.getByText('You added a note at step 2')).toBeTruthy();
    // Shown as text, never as markup.
    expect(screen.getByText('Use <b>Q3</b>')).toBeTruthy();
    cleanup();
    const { container } = render(<SteerNotes provenance={{}} />);
    expect(container.textContent).toBe('');
  });
});

describe('EX3: the export dialog', () => {
  const props = {
    threadId: 't1',
    title: 'Plant review',
    headId: 'm2',
    options: { sources: true, steps: true, thinking: false, receipts: false },
    onDone: vi.fn(),
  };

  it('says what Pro adds where it is not on', () => {
    render(wrap(<ExportPro {...props} />));
    expect(
      screen.getByText(/Word and PDF files with an evidence appendix, and a comparison of two branches/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'About Pro' })).toBeTruthy();
  });

  it('draws nothing while the licence loads', () => {
    pro.state.loading = true;
    const { container } = render(wrap(<ExportPro {...props} />));
    expect(container.textContent).toBe('');
  });

  it('with Pro hands the tools the thread, the branch end and the dialog’s checkboxes', async () => {
    const seen: Record<string, unknown>[] = [];
    pro.state = {
      unlocked: true,
      loading: false,
      build: 'pro',
      ui: {
        parts: {
          ExportTools: (p: Record<string, unknown>) => {
            seen.push(p);
            return <p>Pro tools</p>;
          },
        },
      },
    };
    render(wrap(<ExportPro {...props} />));
    await waitFor(() => expect(screen.getByText('Pro tools')).toBeTruthy());
    expect(seen[0]).toMatchObject({
      threadId: 't1',
      headId: 'm2',
      title: 'Plant review',
      options: props.options,
    });
  });
});
