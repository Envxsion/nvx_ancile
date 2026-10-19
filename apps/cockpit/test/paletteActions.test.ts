/**
 * KP1: the palette's actions, without a screen. The highlighted result is
 * read from its value; each kind of result has its own actions; every change
 * goes through the app's own functions (Undo, the Trash); a choice previews
 * and is put back; and the settings that are on or off, or a few choices,
 * can be changed in place.
 */
import { DEFAULT_PREFERENCES, type Preferences } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ModelView, NotebookView, ThreadSummary } from '../src/lib/types';
import {
  type ActionDeps,
  actionsFor,
  modelActions,
  notebookActions,
  settingActions,
  targetOf,
  threadActions,
} from '../src/palette/actions';
import {
  announceChange,
  nextState,
  SETTINGS_INDEX,
  settingByKey,
  stateWords,
  type Toggle,
} from '../src/palette/settingsIndex';

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: 't1',
  title: 'Tide tables',
  notebookId: 'n1',
  updatedAt: '2026-10-19',
  branches: 1,
  ...over,
});
const nb = (id: string, title: string, over: Partial<NotebookView> = {}): NotebookView => ({
  id,
  title,
  sources: 0,
  threads: 0,
  updatedAt: '2026-10-19',
  ...over,
});
const model = (over: Partial<ModelView> = {}): ModelView =>
  ({
    id: 'ollama/qwen3',
    name: 'Qwen3',
    provider: 'Ollama',
    hue: 'jade',
    via: 'direct',
    contextWindow: 1,
    ...over,
  }) as ModelView;

function deps(over: Partial<ActionDeps> = {}) {
  let prefs: Preferences = DEFAULT_PREFERENCES;
  const calls: string[] = [];
  const d: ActionDeps = {
    origin: 'http://localhost:7701',
    threadId: undefined,
    threads: [thread(), thread({ id: 't2', title: 'Pinned one', pinned: true, notebookId: null })],
    notebooks: [nb('n1', 'Thesis'), nb('n2', 'Field notes'), nb('n3', 'Old', { archived: true })],
    models: [model(), model({ id: 'anthropic/c', name: 'Claude', status: 'needs_key' })],
    get prefs() {
      return prefs;
    },
    open: (to, params, search) =>
      calls.push(`open ${to} ${JSON.stringify(params ?? {})} ${JSON.stringify(search ?? {})}`),
    openWindow: (url) => calls.push(`window ${url}`),
    copy: (text) => calls.push(`copy ${text}`),
    say: (n) => calls.push(`say ${n.title}`),
    threadsApi: {
      setPinned: vi.fn(async (id: string, pinned: boolean) => void calls.push(`pin ${id} ${pinned}`)),
      setArchived: vi.fn(async (id: string, a: boolean) => void calls.push(`archive ${id} ${a}`)),
      moveThread: vi.fn(async (id: string, to: string | null) => void calls.push(`move ${id} ${to}`)),
      deleteThread: vi.fn((id: string) => void calls.push(`trash ${id}`)),
      exportThread: vi.fn(async (id: string) => void calls.push(`export ${id}`)),
    },
    chooseModel: vi.fn(
      async (m: ModelView, t?: string) => void calls.push(`choose ${m.id} ${t ?? 'default'}`),
    ),
    setPref: (group, patch) => {
      prefs = {
        ...prefs,
        [group]: { ...(prefs as unknown as Record<string, object>)[group], ...patch },
      } as Preferences;
      calls.push(`pref ${group} ${JSON.stringify(patch)}`);
    },
    ...over,
  };
  return { d, calls, prefs: () => prefs };
}

describe('what the highlighted result stands for', () => {
  it('reads thread, notebook, model, setting and command values, and Recent ones', () => {
    expect(targetOf('thread t1 Tide tables')).toEqual({ kind: 'thread', id: 't1' });
    expect(targetOf('notebook n1 Thesis')).toEqual({ kind: 'notebook', id: 'n1' });
    expect(targetOf('model anthropic/c Claude Key')).toEqual({ kind: 'model', id: 'anthropic/c' });
    expect(targetOf('setting grain Film grain noise')).toEqual({ kind: 'setting', id: 'grain' });
    expect(targetOf('command pin Pin this thread')).toEqual({ kind: 'command', id: 'pin' });
    expect(targetOf('recent thread:t9 Old chat')).toEqual({ kind: 'thread', id: 't9' });
  });
  it('reads nothing from a message hit, a guide article or a Start here row', () => {
    expect(targetOf('message m1 query title')).toBeNull();
    expect(targetOf('help abc Title')).toBeNull();
    expect(targetOf('start New thread')).toBeNull();
  });
});

describe('thread actions', () => {
  it('open, open in a new window, pin, move, copy a link, export, archive and move to the Trash', () => {
    const { d } = deps();
    const ids = threadActions('t1', d).map((a) => a.id);
    expect(ids).toEqual([
      'open',
      'open-window',
      'pin',
      'move:n2',
      'move:none',
      'copy-link',
      'export',
      'archive',
      'delete',
    ]);
  });

  it('moves to every notebook but its own and the archived ones, or out of its notebook', () => {
    const { d } = deps();
    const a = threadActions('t1', d);
    expect(a.map((x) => x.label).filter((l) => /^Move (to (?!the Trash)|out)/.test(l))).toEqual([
      'Move to Field notes',
      'Move out of its notebook',
    ]);
    // A thread in no notebook has nothing to move out of.
    expect(threadActions('t2', d).some((x) => x.id === 'move:none')).toBe(false);
  });

  it('runs each through the app, with a link that names the thread', async () => {
    const { d, calls } = deps();
    const by = (id: string) =>
      threadActions('t1', d).find((a) => a.id === id) as NonNullable<
        ReturnType<typeof threadActions>[number]
      >;
    by('open').run();
    by('open-window').run();
    await by('pin').run();
    await by('move:n2').run();
    await by('move:none').run();
    by('copy-link').run();
    await by('export').run();
    await by('archive').run();
    by('delete').run();
    expect(calls).toEqual([
      'open /t/$threadId {"threadId":"t1"} {}',
      'window http://localhost:7701/t/t1',
      'pin t1 true',
      'move t1 n2',
      'move t1 null',
      'copy http://localhost:7701/t/t1',
      'say Link copied',
      'export t1',
      'archive t1 true',
      'trash t1',
    ]);
  });

  it('says pinned threads can be unpinned, and the Trash keeps what it takes', () => {
    const { d } = deps();
    const pin = threadActions('t2', d).find((a) => a.id === 'pin');
    expect(pin?.label).toBe('Unpin');
    const del = threadActions('t1', d).find((a) => a.id === 'delete');
    expect(del).toMatchObject({ danger: true, hint: 'Kept for 30 days', label: 'Move to the Trash' });
    expect(threadActions('t1', d).find((a) => a.id === 'archive')?.hint).toMatch(/Undo/);
  });

  it('has nothing for a thread that is gone', () => {
    expect(threadActions('t404', deps().d)).toEqual([]);
  });
});

describe('notebook and model actions', () => {
  it('a notebook can be opened, started in, opened in a window and linked', () => {
    const { d, calls } = deps();
    const a = notebookActions('n1', d);
    expect(a.map((x) => x.id)).toEqual(['open', 'new-thread', 'open-window', 'copy-link']);
    a.find((x) => x.id === 'new-thread')?.run();
    expect(calls[0]).toBe('open / {} {"notebook":"n1"}');
  });

  it('a model that can answer can be made the default, and used in this thread when one is open', async () => {
    const { d, calls } = deps({ threadId: 't1' });
    const a = modelActions('ollama/qwen3', d);
    expect(a.map((x) => x.id)).toEqual(['use-here', 'make-default']);
    await a.find((x) => x.id === 'make-default')?.run();
    await a.find((x) => x.id === 'use-here')?.run();
    expect(calls).toContain('choose ollama/qwen3 default');
    expect(calls).toContain('choose ollama/qwen3 t1');
    expect(calls).toContain('say New threads use Qwen3');
  });

  it('a model that needs its key has no actions', () => {
    expect(modelActions('anthropic/c', deps().d)).toEqual([]);
  });

  it('only the kinds of result with actions get a panel', () => {
    const { d } = deps();
    expect(actionsFor(null, d)).toEqual([]);
    expect(actionsFor({ kind: 'command', id: 'pin' }, d)).toEqual([]);
    expect(actionsFor({ kind: 'thread', id: 't1' }, d).length).toBeGreaterThan(0);
  });
});

describe('settings in place', () => {
  it('Enter flips a toggle and steps a choice to the next, wrapping round', () => {
    const grain = settingByKey('grain') as Toggle;
    expect(nextState(DEFAULT_PREFERENCES, grain)).toEqual({ group: 'appearance', patch: { grain: true } });
    const theme = settingByKey('theme');
    if (theme?.kind !== 'choice') throw new Error('theme is a choice');
    let prefs = DEFAULT_PREFERENCES;
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const n = nextState(prefs, theme);
      seen.push(n.patch.theme);
      prefs = { ...prefs, appearance: { ...prefs.appearance, ...n.patch } } as Preferences;
    }
    expect(seen).toEqual(['dark', 'light', 'system', 'dark']);
  });

  it('shows the state in words beside the row, and announces a change', () => {
    const grain = settingByKey('grain') as Toggle;
    expect(stateWords(DEFAULT_PREFERENCES, grain)).toBe('Off');
    const on = { ...DEFAULT_PREFERENCES, appearance: { ...DEFAULT_PREFERENCES.appearance, grain: true } };
    expect(stateWords(on, grain)).toBe('On');
    expect(announceChange(grain, on)).toBe('Film grain: on.');
    expect(stateWords(DEFAULT_PREFERENCES, settingByKey('zoom') as never)).toBeNull();
  });

  it('every in-place setting names a preference that exists, with an option that is its current value', () => {
    for (const def of SETTINGS_INDEX) {
      if (def.kind === 'opens') continue;
      const group = DEFAULT_PREFERENCES[def.prefGroup] as unknown as Record<string, unknown>;
      expect(def.pref in group, `${def.key} -> ${def.prefGroup}.${def.pref}`).toBe(true);
      if (def.kind === 'choice')
        expect(
          def.options.map((o) => o.value),
          def.key,
        ).toContain(group[def.pref]);
      else expect(typeof group[def.pref], def.key).toBe('boolean');
    }
    // Every row can still be found by the words it always had.
    expect(SETTINGS_INDEX.find((s) => s.key === 'css')?.words).toContain('css');
  });

  it('a choice previews as it is highlighted and comes back to the current one', () => {
    const { d, prefs } = deps();
    const theme = settingByKey('theme') as never;
    const a = settingActions(theme, d);
    expect(a.map((x) => [x.id, x.current])).toEqual([
      ['system', true],
      ['dark', false],
      ['light', false],
    ]);
    a.find((x) => x.id === 'dark')?.preview?.apply();
    expect(prefs().appearance.theme).toBe('dark');
    a.find((x) => x.id === 'light')?.preview?.apply();
    expect(prefs().appearance.theme).toBe('light');
    a.find((x) => x.id === 'system')?.preview?.apply();
    expect(prefs().appearance.theme).toBe('system');
    // Choosing keeps the panel open, so another can be tried.
    expect(a.every((x) => x.keepOpen)).toBe(true);
  });

  it('a toggle offers On and Off', () => {
    const { d } = deps();
    const a = settingActions(settingByKey('grain') as never, d);
    expect(a.map((x) => x.label)).toEqual(['On', 'Off']);
    expect(a.find((x) => x.id === 'off')?.current).toBe(true);
  });

  it('a setting that needs a page of its own has no panel', () => {
    expect(settingActions(settingByKey('zoom') as never, deps().d)).toEqual([]);
  });
});
