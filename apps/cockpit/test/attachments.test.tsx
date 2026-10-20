/**
 * CH6: files go with one message, shown as chips with page counts, and in a
 * notebook a dropped file asks whether it is for this message or a source:
 * nothing becomes a permanent source on a drop. "Keep in notebook" is a toggle
 * on the chip. Claude Code threads are told to pass a path.
 */
import type { AttachmentRecord } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { ThreadView } from '../src/lib/types';
import { useUploads } from '../src/sources/uploads';
import { useNotify } from '../src/state/notify';
import { useUi } from '../src/state/ui';
import { chipWords, cutNote } from '../src/thread/attach';
import { Composer } from '../src/thread/Composer';

const record = (p: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
  id: 'att_1',
  name: 'manual.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  bytes: 1000,
  pages: 3,
  chars: 900,
  truncated: false,
  ...p,
});

let uploads: ReturnType<typeof fetchRig>;

function fetchRig(reply: (name: string) => { status: number; body: unknown }) {
  const calls: { url: string; name: string }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const file = (init?.body as FormData | undefined)?.get?.('file') as File | null;
    const name = file?.name ?? '';
    calls.push({ url: String(url), name });
    const r = reply(name);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', f);
  return { calls, f };
}

function composer(opts: { notebookId?: string | null; claudeCode?: boolean; threadId?: string } = {}) {
  const onSend = vi.fn().mockResolvedValue(true);
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Composer
          threadId={opts.threadId ?? 'thr_1'}
          parentId={null}
          onSend={onSend}
          notebookId={opts.notebookId ?? null}
          claudeCode={
            opts.claudeCode
              ? { commands: [], act: vi.fn(), bar: <span />, working: false, onStop: vi.fn() }
              : undefined
          }
        />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  const root = document.querySelector('.composer') as HTMLElement;
  const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
  const drop = (...files: File[]) => fireEvent.drop(root, { dataTransfer: { files, types: ['Files'] } });
  return { onSend, input, drop, root };
}

const pdf = (name = 'manual.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });
const csv = (name = 'sales.csv') => new File(['a,b\n1,2'], name, { type: 'text/csv' });
const docx = () =>
  new File(['x'], 'plan.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
const lastToast = () => useNotify.getState().toasts.at(-1);
const add = vi.fn();

beforeEach(() => {
  queryClient.clear();
  useNotify.setState({ toasts: [], history: [] });
  useUi.setState({ demo: false });
  add.mockClear();
  useUploads.setState({ add, items: [] });
  queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
    id: 'thr_1',
    title: 'Pumps',
    notebookId: null,
    model: null,
    messages: [],
    activeRun: null,
    claudeCode: null,
    headId: null,
    total: 0,
    cursor: null,
    hasMore: false,
  } as ThreadView);
  uploads = fetchRig((name) => ({
    status: 201,
    body: name.endsWith('.pdf')
      ? record({ name })
      : record({ id: 'att_2', name, mime: 'text/csv', kind: 'text', pages: null }),
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('outside a notebook', () => {
  it('attaches a PDF to the message, shown as a chip with its page count, and sends it with the message', async () => {
    const { drop, input, onSend } = composer();
    drop(pdf());
    await screen.findByText('3 pages');
    expect(uploads.calls).toEqual([
      { url: expect.stringContaining('/threads/thr_1/attachments'), name: 'manual.pdf' },
    ]);
    expect(screen.getByLabelText('Attached to this message')).toHaveTextContent('manual.pdf');
    fireEvent.change(input, { target: { value: 'Summarise it' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[1].attachments).toEqual([record()]);
    await waitFor(() => expect(screen.queryByText('manual.pdf')).toBeNull());
    expect(add).not.toHaveBeenCalled();
  });

  it('takes text, code and CSV the same way, and lets a chip be taken back', async () => {
    const { drop } = composer();
    drop(csv());
    await screen.findByText('sales.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Remove sales.csv' }));
    expect(screen.queryByText('sales.csv')).toBeNull();
  });

  it('says why when Core cannot read a file, and adds no chip', async () => {
    uploads = fetchRig(() => ({
      status: 422,
      body: {
        error: {
          title: 'This PDF has no text to read',
          hint: 'Add it to a notebook as a source with OCR on.',
        },
      },
    }));
    const { drop } = composer();
    drop(pdf('scan.pdf'));
    await waitFor(() => expect(lastToast()?.title).toBe('This PDF has no text to read'));
    expect(lastToast()?.body).toContain('OCR');
    expect(screen.queryByLabelText('Attached to this message')).toBeNull();
  });

  it('says a file of another kind cannot go with a message', async () => {
    const { drop } = composer();
    drop(docx());
    await waitFor(() => expect(lastToast()?.title).toBe('That file cannot go with a message'));
    expect(uploads.calls).toHaveLength(0);
  });

  it('allows five files to a message', async () => {
    const { drop } = composer();
    drop(...Array.from({ length: 6 }, (_, i) => csv(`f${i}.csv`)));
    await waitFor(() => expect(uploads.calls).toHaveLength(5));
    expect(lastToast()?.title).toBe('Up to 5 files go with one message');
  });

  it('waits for a file that is still being read before it sends', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = r))),
    );
    const { drop, input, onSend } = composer();
    drop(pdf());
    await screen.findByText('reading');
    fireEvent.change(input, { target: { value: 'go' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastToast()?.title).toBe('A file is still being read');
    expect(onSend).not.toHaveBeenCalled();
    release(new Response(JSON.stringify(record()), { status: 201 }));
    await screen.findByText('3 pages');
  });
});

describe('in a notebook', () => {
  it('asks what a dropped file is for, and adds no source on its own', async () => {
    const { drop } = composer({ notebookId: 'nb_1' });
    drop(pdf());
    const ask = await screen.findByRole('group', { name: 'What to do with these files' });
    expect(ask).toHaveTextContent(
      'manual.pdf: attach to this message only, or add to the notebook as a source?',
    );
    expect(add).not.toHaveBeenCalled();
    expect(uploads.calls).toHaveLength(0);
  });

  it('attaches it to the message when asked to', async () => {
    const { drop } = composer({ notebookId: 'nb_1' });
    drop(pdf());
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to this message' }));
    await screen.findByText('3 pages');
    expect(add).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'What to do with these files' })).toBeNull();
  });

  it('adds it as a source only when asked to', async () => {
    const { drop } = composer({ notebookId: 'nb_1' });
    const file = pdf();
    drop(file);
    fireEvent.click(await screen.findByRole('button', { name: 'Add as a source' }));
    expect(add).toHaveBeenCalledWith('nb_1', [file]);
    expect(uploads.calls).toHaveLength(0);
  });

  it('does nothing at all on Cancel', async () => {
    const { drop } = composer({ notebookId: 'nb_1' });
    drop(pdf());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(add).not.toHaveBeenCalled();
    expect(uploads.calls).toHaveLength(0);
  });

  it('offers only "Add as a source" for a file a message cannot carry', async () => {
    const { drop } = composer({ notebookId: 'nb_1' });
    drop(docx());
    await screen.findByRole('group', { name: 'What to do with these files' });
    expect(screen.queryByRole('button', { name: 'Attach to this message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add as a source' })).toBeInTheDocument();
  });

  it('keeps a file in the notebook only if its toggle is on, once the message has gone', async () => {
    const { drop, input, onSend } = composer({ notebookId: 'nb_1' });
    const file = pdf();
    drop(file);
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to this message' }));
    await screen.findByText('3 pages');
    const keep = screen.getByRole('switch', { name: 'Keep in notebook' });
    expect(keep).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(keep);
    expect(keep).toHaveAttribute('aria-checked', 'true');
    expect(add).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Use this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(add).toHaveBeenCalledWith('nb_1', [file]));
  });

  it('does not keep what was not asked to be kept', async () => {
    const { drop, input, onSend } = composer({ notebookId: 'nb_1' });
    drop(pdf());
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to this message' }));
    await screen.findByText('3 pages');
    fireEvent.change(input, { target: { value: 'Use this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(add).not.toHaveBeenCalled();
  });

  it('says a source of that name is already there, and does not add it twice', async () => {
    queryClient.setQueryData(keys.sources('nb_1'), [
      { id: 'src_1', title: 'Manual.pdf', status: 'ready', contextLevel: 'full' },
    ]);
    const { drop } = composer({ notebookId: 'nb_1' });
    const file = pdf();
    drop(file);
    const ask = await screen.findByRole('group', { name: 'What to do with these files' });
    expect(ask).toHaveTextContent('manual.pdf is already a source here.');
    fireEvent.click(screen.getByRole('button', { name: 'Add as a source' }));
    expect(add).not.toHaveBeenCalled();
    expect(lastToast()?.title).toBe('manual.pdf is already a source here');
  });
});

describe('a Claude Code thread', () => {
  it('is told to pass a path, and nothing is uploaded', async () => {
    const { drop } = composer({ claudeCode: true });
    drop(pdf());
    await waitFor(() => expect(lastToast()?.title).toBe('Claude Code reads files from its folder'));
    expect(uploads.calls).toHaveLength(0);
  });
});

describe('the words on a chip', () => {
  it('count pages, and say when only the start is kept', () => {
    expect(chipWords({ kind: 'pdf', pages: 1, truncated: false })).toBe('1 page');
    expect(chipWords({ kind: 'pdf', pages: 40, truncated: true })).toBe('40 pages, start only');
    expect(chipWords({ kind: 'text', pages: null, truncated: true })).toBe('start only');
    expect(chipWords({ kind: 'text', pages: null, truncated: false })).toBe('');
  });
  it('explain the cut on hover only', () => {
    expect(cutNote({ truncated: true })).toBe('Only the first 200,000 characters were read.');
    expect(cutNote({ truncated: false })).toBeUndefined();
  });
});
