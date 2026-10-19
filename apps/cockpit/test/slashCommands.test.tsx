/**
 * CH5: every "/" command in the composer does its work, shows in the menu
 * with a description and its argument as ghost text, a command that does not
 * exist is explained and never sent, "//" sends a slash, and the test
 * directives /say and /slow are for the dev build only.
 */
import type { Effort } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../src/lib/branching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/branching')>()),
  compactNow: vi.fn().mockResolvedValue({ reused: false }),
  branchHere: vi.fn().mockResolvedValue({ id: 'brn_1' }),
}));
vi.mock('../src/lib/factcheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/factcheck')>()),
  startFactcheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/threads')>()),
  exportThread: vi.fn(),
}));
vi.mock('../src/router', () => ({ router: { navigate: vi.fn() } }));

import { useEditors } from '../src/editors/store';
import { api } from '../src/lib/api';
import { branchHere, compactNow } from '../src/lib/branching';
import { keys } from '../src/lib/data';
import { startFactcheck } from '../src/lib/factcheck';
import { queryClient } from '../src/lib/query';
import { exportThread } from '../src/lib/threads';
import type { MessageView, ModelView, ThreadView } from '../src/lib/types';
import { useMemoryUi } from '../src/memory/api';
import { router } from '../src/router';
import { useNotify } from '../src/state/notify';
import { usePrefs } from '../src/state/prefs';
import { useUi } from '../src/state/ui';
import { Composer } from '../src/thread/Composer';
import { ghostFor, readTyped, SLASH, slashFor, TEST_DIRECTIVES } from '../src/thread/slash';

const mocked = api as unknown as Record<'get' | 'patch', ReturnType<typeof vi.fn>>;

const msg = (p: Partial<MessageView> & Pick<MessageView, 'id' | 'role'>): MessageView => ({
  parentId: null,
  blocks: [],
  parts: [{ type: 'text', text: `${p.id} text` }],
  modelId: null,
  createdAt: '2026-10-14T10:00:00Z',
  status: 'complete',
  ...p,
});

const model = (p: Partial<ModelView> = {}): ModelView => ({
  id: 'anthropic/sonnet',
  name: 'Sonnet',
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
  ...p,
});

function seed(opts: { answer?: boolean; models?: ModelView[]; effort?: Effort | null } = {}) {
  const messages = [
    msg({ id: 'm1', role: 'user' }),
    ...(opts.answer === false ? [] : [msg({ id: 'm2', role: 'assistant', parentId: 'm1' })]),
  ];
  queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
    id: 'thr_1',
    title: 'Pumps',
    notebookId: 'nb_1',
    model: 'anthropic/sonnet',
    messages,
    activeRun: null,
    claudeCode: null,
    effort: opts.effort ?? null,
    headId: messages.at(-1)?.id ?? null,
    total: messages.length,
    cursor: 'm1',
    hasMore: false,
  } as ThreadView);
  queryClient.setQueryData(keys.models, opts.models ?? [model()]);
}

function composer(onSend = vi.fn().mockResolvedValue(true), notebookId: string | null = 'nb_1') {
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Composer threadId="thr_1" parentId="m2" onSend={onSend} notebookId={notebookId} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  return { input: screen.getByLabelText('Message') as HTMLTextAreaElement, onSend };
}

const type = (input: HTMLTextAreaElement, value: string) => fireEvent.change(input, { target: { value } });
const enter = (input: HTMLTextAreaElement) => fireEvent.keyDown(input, { key: 'Enter' });
/** The line clears once the command has done its work: wait for that before typing the next. */
const cleared = (input: HTMLTextAreaElement) => waitFor(() => expect(input.value).toBe(''));
const lastToast = () => useNotify.getState().toasts.at(-1);

beforeEach(() => {
  queryClient.clear();
  useNotify.setState({ toasts: [], history: [] });
  useUi.setState({ demo: false, paletteOpen: false, paletteQuery: '', shortcutsOpen: false });
  useEditors.setState({ open: null });
  usePrefs.getState().set('composer', { menus: true });
  for (const f of [
    compactNow,
    branchHere,
    startFactcheck,
    exportThread,
    router.navigate,
    mocked.patch,
    mocked.get,
  ])
    (f as ReturnType<typeof vi.fn>).mockClear();
  mocked.get.mockResolvedValue([]);
  seed();
});

describe('the menu', () => {
  it('lists every command with what it does, and the argument it takes', async () => {
    const { input } = composer();
    type(input, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands' });
    const names = [...list.querySelectorAll('.composer__cmd')].map((n) => n.textContent);
    expect(names).toEqual([
      '/model',
      '/sources',
      '/keys',
      '/beam',
      '/image',
      '/memory',
      '/compact',
      '/branch',
      '/factcheck',
      '/export',
      '/instructions',
      '/find',
      '/init',
    ]);
    for (const s of SLASH.filter((x) => names.includes(x.cmd))) {
      expect(screen.getByText(s.hint), s.cmd).toBeInTheDocument();
      if (s.arg) expect(screen.getAllByText(s.arg).length, s.cmd).toBeGreaterThan(0);
    }
  });

  it('leaves out what needs a thread or a notebook that is not there', async () => {
    const { input } = composer(undefined, null);
    type(input, '/');
    const names = [...(await screen.findByRole('listbox')).querySelectorAll('.composer__cmd')].map(
      (n) => n.textContent,
    );
    expect(names).not.toContain('/sources');
    expect(names).toContain('/compact');
  });

  it('offers /effort only where the model takes one', async () => {
    seed({ models: [model({ effortLevels: ['low', 'medium', 'high'] })] });
    const { input } = composer();
    type(input, '/ef');
    expect(await screen.findByRole('option', { name: /\/effort/ })).toBeInTheDocument();
  });

  it('shows the argument as ghost text once the command is typed, and not after the first word of it', async () => {
    const { input } = composer();
    type(input, '/memory ');
    await waitFor(() =>
      expect(document.querySelector('.composer__ghost')?.textContent).toBe('/memory [something to remember]'),
    );
    type(input, '/memory I use metric');
    expect(document.querySelector('.composer__ghost')).toBeNull();
    type(input, '/compact ');
    expect(document.querySelector('.composer__ghost')).toBeNull();
  });
});

describe('each command does its work', () => {
  it('/compact compacts the thread up to the last message and clears the line', async () => {
    const { input, onSend } = composer();
    type(input, '/compact');
    enter(input);
    await waitFor(() => expect(compactNow).toHaveBeenCalledWith('thr_1', 'm2'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('/branch branches from the last message, with the name given', async () => {
    const { input, onSend } = composer();
    type(input, '/branch Plan B');
    enter(input);
    await waitFor(() =>
      expect(branchHere).toHaveBeenCalledWith('thr_1', 'm2', { name: 'Plan B', previousHead: 'm2' }),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('/factcheck checks the last finished answer, on the web only when asked', async () => {
    const { input } = composer();
    type(input, '/factcheck');
    enter(input);
    await waitFor(() => expect(startFactcheck).toHaveBeenCalledWith('m2', { web: false }));
    expect(useUi.getState().evidenceMessage).toBe('m2');
    await cleared(input);
    type(input, '/factcheck web');
    enter(input);
    await waitFor(() => expect(startFactcheck).toHaveBeenLastCalledWith('m2', { web: true }));
  });

  it('/factcheck with no answer yet says so and checks nothing', async () => {
    seed({ answer: false });
    const { input } = composer();
    type(input, '/factcheck');
    enter(input);
    await waitFor(() => expect(lastToast()?.title).toBe('No answer to check yet'));
    expect(startFactcheck).not.toHaveBeenCalled();
    expect(input.value).toBe('/factcheck');
  });

  it('/memory opens the memory inbox', async () => {
    const { input, onSend } = composer();
    type(input, '/memory');
    enter(input);
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/admin/$section', params: { section: 'memory' } }),
    );
    expect(useMemoryUi.getState().tab).toBe('inbox');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('/memory with words sends them as the request to remember, for the memory module to save', async () => {
    const { input, onSend } = composer();
    type(input, '/memory I use metric units');
    enter(input);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe('Remember that I use metric units');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('/memory keeps "never ..." and "remember ..." as the person wrote them', async () => {
    const { input, onSend } = composer();
    type(input, '/memory never add a summary');
    enter(input);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe('never add a summary');
  });

  it('/export saves the thread, /instructions opens its editor, /find searches', async () => {
    const { input } = composer();
    type(input, '/export');
    enter(input);
    await waitFor(() => expect(exportThread).toHaveBeenCalledWith('thr_1'));
    await cleared(input);
    type(input, '/instructions');
    enter(input);
    await waitFor(() =>
      expect(useEditors.getState().open).toEqual({ kind: 'instructions', level: 'thread', id: 'thr_1' }),
    );
    await cleared(input);
    type(input, '/find flow rate');
    enter(input);
    await waitFor(() => expect(useUi.getState().paletteQuery).toBe('flow rate'));
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it('/model, /keys and /sources open their pickers', async () => {
    const { input } = composer();
    type(input, '/model opus');
    enter(input);
    await waitFor(() =>
      expect(useUi.getState()).toMatchObject({
        paletteOpen: true,
        paletteScope: 'models',
        paletteQuery: 'opus',
      }),
    );
    await cleared(input);
    type(input, '/keys');
    enter(input);
    await waitFor(() => expect(useUi.getState().shortcutsOpen).toBe(true));
    await cleared(input);
    type(input, '/sources');
    enter(input);
    await waitFor(() => expect(useUi.getState().drawerTab).toBe('sources'));
  });

  it('/init opens the AGENTS.md draft for the thread’s linked repository', async () => {
    mocked.get.mockResolvedValue({ repo: { id: 'rep_1', name: 'web' } });
    const { input } = composer();
    type(input, '/init');
    enter(input);
    await waitFor(() =>
      expect(useEditors.getState().open).toEqual({ kind: 'init-agents', repoId: 'rep_1', repoName: 'web' }),
    );
    expect(mocked.get).toHaveBeenCalledWith('/repos/linked?thread_id=thr_1');
  });

  it('/init with no repository linked says how to link one', async () => {
    mocked.get.mockResolvedValue({ repo: null });
    const { input } = composer();
    type(input, '/init');
    enter(input);
    await waitFor(() => expect(lastToast()?.title).toBe('This thread has no repository linked'));
    expect(useEditors.getState().open).toBeNull();
  });

  it('/effort sets the thread’s effort, and auto puts it back', async () => {
    seed({ models: [model({ effortLevels: ['low', 'medium', 'high'] })] });
    const { input } = composer();
    type(input, '/effort high');
    enter(input);
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { effort: 'high' }));
    expect(queryClient.getQueryData<ThreadView>(keys.thread('thr_1'))?.effort).toBe('high');
    await cleared(input);
    type(input, '/effort auto');
    enter(input);
    await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith('/threads/thr_1', { effort: null }));
    await cleared(input);
    type(input, '/effort extreme');
    enter(input);
    await waitFor(() => expect(lastToast()?.title).toBe('extreme is not an effort this model takes'));
  });

  it('picking a command with nothing to type from the menu runs it', async () => {
    const { input } = composer();
    type(input, '/comp');
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(compactNow).toHaveBeenCalled());
  });

  it('picking one that takes words completes it instead, so a second Enter can run it', async () => {
    const { input } = composer();
    type(input, '/mem');
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/memory ');
  });
});

describe('a command that does not exist', () => {
  it('is explained and not sent, and the text stays', async () => {
    const { input, onSend } = composer();
    type(input, '/compat now');
    enter(input);
    await waitFor(() => expect(lastToast()?.title).toBe('There is no command called /compat'));
    expect(lastToast()?.body).toContain('Did you mean /compact?');
    expect(lastToast()?.body).toContain('start it with //');
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('/compat now');
  });

  it('can still be sent as a message with //', async () => {
    const { input, onSend } = composer();
    type(input, '//compat is a typo of compact');
    enter(input);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe('/compat is a typo of compact');
  });

  it('leaves a path or a URL alone: it is a message', async () => {
    const { input, onSend } = composer();
    type(input, '/usr/bin/env is where it lives');
    enter(input);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });
});

describe('slash.ts', () => {
  const env = { notebook: true, thread: true, offline: false, dev: false, effort: false };

  it('gives every command a description and a command that does something', () => {
    for (const s of SLASH) {
      expect(s.hint.length, s.cmd).toBeGreaterThan(10);
      expect(['text', ...SLASH.map((x) => x.id)]).toContain(s.id);
    }
    // No command is listed that only sends its own name to the model, apart from the ones the model reads.
    expect(SLASH.filter((s) => s.id === 'text').map((s) => s.cmd)).toEqual(['/image']);
  });

  it('hides /say and /slow outside the dev build, and keeps /fail and /tool for the offline model', () => {
    const names = (dev: boolean) => slashFor({ ...env, offline: true, dev }).map((s) => s.cmd);
    expect(names(false)).not.toContain('/say');
    expect(names(false)).not.toContain('/slow');
    expect(names(false)).toContain('/fail 500');
    expect(names(true)).toEqual(expect.arrayContaining(['/say', '/slow']));
    expect(slashFor(env).map((s) => s.cmd)).not.toContain('/fail 500');
    expect(TEST_DIRECTIVES.length).toBeGreaterThan(0);
  });

  it('lets the offline model read its own directives and refuses everything else with a slash', () => {
    const list = slashFor({ ...env, offline: true, dev: false });
    expect(readTyped('/say hello', list, { offline: true }).kind).toBe('plain');
    expect(readTyped('/say hello', slashFor(env), { offline: false })).toMatchObject({
      kind: 'unknown',
      name: 'say',
    });
  });

  it('reads a command, its words, an escape, and plain text', () => {
    const list = slashFor(env);
    expect(readTyped('/branch  Plan B ', list, { offline: false })).toMatchObject({
      kind: 'command',
      arg: 'Plan B',
    });
    expect(readTyped('/image a red pump', list, { offline: false }).kind).toBe('plain');
    expect(readTyped('//branch', list, { offline: false })).toEqual({ kind: 'escaped', text: '/branch' });
    expect(readTyped('what about /compact', list, { offline: false }).kind).toBe('plain');
    expect(ghostFor('/find ', list)).toBe('words to find');
    expect(ghostFor('/find', list)).toBe(' words to find');
    expect(ghostFor('/find x', list)).toBeNull();
  });
});
