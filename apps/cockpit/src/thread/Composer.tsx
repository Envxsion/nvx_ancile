/**
 * ------------------------------------------------------------------
 *  Title    |  Composer
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where you write. Slash commands, @-mentions that narrow
 *           |  what the answer reads, snippets, files dropped straight
 *           |  into the notebook, and a draft that is never lost.
 *  How      |  The draft saves to localStorage 400 ms after you stop
 *           |  typing, keyed by thread and the message you are
 *           |  replying to, so every branch keeps its own draft, and
 *           |  to Core a second later, so it follows you to another
 *           |  device. It is flushed when the composer goes away or
 *           |  the page hides. A send that fails keeps the text.
 *           |  Mentions are chips, not text: a source narrows the
 *           |  search to it, a notebook grounds a loose thread, a
 *           |  model answers this one message.
 *           |  Commands (thread/slash.ts) each do their work, shown
 *           |  with their argument as ghost text; one that does not
 *           |  exist is explained, never sent. A file is attached to
 *           |  one message (CH6) or, in a notebook, you are asked
 *           |  whether to add it as a source. While an answer streams
 *           |  Enter queues the next message (CH7).
 *  Note     |  Which key sends is a setting (Settings → Composer).
 *           |  Esc leaves the composer for navigate mode, `i` returns.
 *           |  In a Claude Code thread the "/" menu is Claude Code's
 *           |  own list (claudecode/live.ts), grouped and with a
 *           |  second level for a command's values; commands NVX
 *           |  Ancile handles itself are done here, never sent.
 * ------------------------------------------------------------------
 */

import {
  ATTACHMENT_LIMITS,
  type AttachmentRecord,
  type ClaudeCodeCommand,
  IMAGE_LIMITS,
  IMAGE_MIMES,
  type ImageProviders,
  type ImageRecord,
} from '@nvx/contracts';
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type AncileExtra, ccMenu, parseTyped } from '../claudecode/live';
import * as demo from '../fixtures/demo';
import { attachImage, imageKeys } from '../images/api';
import { useBinding } from '../keys/dispatch';
import { api } from '../lib/api';
import { useModels, useNotebooks, useSources } from '../lib/data';
import { hueVar } from '../lib/format';
import { useCurrentModel } from '../lib/models';
import { queryClient } from '../lib/query';
import type { Hue } from '../lib/types';
import { draftAutosave, useAutomations } from '../ops/builtins';
import { openBeam } from '../pro/beam';
import { useRepos } from '../repos/data';
import { useUploads } from '../sources/uploads';
import { notify } from '../state/notify';
import { usePref, usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { Icon, type IconName } from '../ui/Icon';
import { lazyHost } from '../ui/lazyHost';
import { BarLabel, HueChip, Kbd, Tip } from '../ui/primitives';
import type { DropAsk, PendingFile } from './AttachPanel';
import { shortModelName, useComposerBar } from './composerBar';
import { FlowChip } from './FlowChip';
import { useFlowList, useResolvedFlow } from './flowActions';
import { ModelChoiceDialog, useModelChoice } from './ModelChoice';
import { htmlToMarkdown } from './pasteMarkdown';
import type { Slash } from './slash';

// The command table (names, descriptions, how typed text is read) loads the first time a line starts
// with a slash, so an idle composer does not carry it.
const loadSlash = () => import('./slash');
type SlashModule = Awaited<ReturnType<typeof loadSlash>>;

// The effort chip belongs to reasoning models only: its code loads when one is the model.
export const loadEffortChip = () => import('./EffortChip');

// Reading a file for a message is rare: its client loads the first time a file is involved.
const loadAttachLib = () => import('./attach');
// Files are rare: the question and the chips load the first time one is dropped or chosen.
const loadAttach = () => import('./AttachPanel');
const AskDrop = lazyHost(loadAttach, 'AskDrop');
const FileChips = lazyHost(loadAttach, 'FileChips');
const EffortChip = lazyHost(loadEffortChip, 'EffortChip');

export interface Mention {
  kind: 'source' | 'model' | 'notebook' | 'flow' | 'repo';
  id: string;
  label: string;
  hue?: Hue | null;
}

/** What a Claude Code thread gives the composer (ThreadView). */
export interface ClaudeCodeComposer {
  /** Claude Code's own "/" list for the session's folder. */
  commands: ClaudeCodeCommand[];
  /** Do what NVX Ancile does for a command it handles (handled_by "ancile"). */
  act: (command: ClaudeCodeCommand, arg: string | null) => void;
  /** The model and effort pickers, in place of the model and flow chips. */
  bar: ReactNode;
  /** How many chips `bar` holds, so the bar can fit them (composerBar.ts). */
  chips?: number;
  /** A turn is running: Send queues, and an empty composer offers Stop. */
  working: boolean;
  onStop: () => void;
  /**
   * Claude Code cannot carry the session on from this computer (not
   * installed, signed out): the one line to show instead of a composer
   * that would fail. null when it can, or when another model answers next.
   */
  readOnly?: string | null;
}

export interface SendExtras {
  mentions: { kind: 'source' | 'notebook' | 'repo'; id: string }[];
  /** A model @-mentioned for this one message. */
  model: string | null;
  /** A flow @-mentioned for this one message (DESIGN §16.3). */
  flowId: string | null;
  /** Images attached to this message (docs/images.md). */
  images?: ImageRecord[];
  /** Files attached to this message only (CH6); their text is on Core. */
  attachments?: AttachmentRecord[];
  /** Stop the answer that is streaming and send this now (CH7). */
  now?: boolean;
}

/** CH7: what the composer needs to know about the message waiting behind a running answer. */
export interface ComposerQueue {
  /** A message is already waiting (Free keeps one). */
  queued: boolean;
  /** Take it out of the queue; its words come back to the composer. */
  remove: () => void;
}

const MENTION_ICON: Record<Mention['kind'], IconName> = {
  source: 'sources',
  model: 'model',
  notebook: 'notebook',
  flow: 'tree',
  repo: 'branch',
};

const serverParent = (parentId: string | null) => parentId ?? '_';

/** An image on its way to the next message: uploading, then ready with its stored record. */
interface PendingImage {
  key: string;
  name: string;
  preview: string;
  state: 'sending' | 'ready';
  record?: ImageRecord;
}

const isAttachableImage = (f: File) => (IMAGE_MIMES as readonly string[]).includes(f.type);

export const draftKey = (threadId: string, parentId: string | null) =>
  `nvx.ancile.draft:${threadId}:${parentId ?? 'root'}`;

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

function ComposerImpl({
  threadId,
  parentId,
  onSend,
  busy = false,
  notebookId = null,
  scope,
  placeholder,
  claudeCode,
  replaceText,
  queue,
}: {
  threadId: string;
  parentId: string | null;
  /** Resolve false to keep the text (the send did not happen). */
  onSend: (text: string, extras: SendExtras) => Promise<boolean> | boolean | undefined;
  /** An answer is being written; sending waits. */
  busy?: boolean;
  /** Where dropped files go and which sources can be mentioned. */
  notebookId?: string | null;
  /** Extra control at the start of the bar (Home's notebook picker). */
  scope?: ReactNode;
  placeholder?: string;
  /** This thread carries a Claude Code session on. */
  claudeCode?: ClaudeCodeComposer;
  /** Put this text in the composer whenever `n` changes ("" clears it). */
  replaceText?: { text: string; n: number };
  /** Sending while an answer streams queues the message (CH7); Esc takes it back out. */
  queue?: ComposerQueue;
}) {
  const key = draftKey(threadId, parentId);
  const prefs = usePref('composer');
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const [picked, setPicked] = useState<Mention[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissedMenu, setDismissedMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [ask, setAsk] = useState<DropAsk | null>(null);
  const running = useRef(false);
  const sentOk = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const isDemo = useUi((s) => s.demo);
  const openPalette = useUi((s) => s.openPalette);
  const openDrawer = useUi((s) => s.openDrawer);
  const setShortcuts = useUi((s) => s.setShortcuts);
  // Home and the notebook ask box compose for a thread that does not exist yet.
  const realThread = threadId.startsWith('thr_');
  const model = useCurrentModel(realThread ? threadId : undefined);
  const models = useModels().data;
  const notebooks = useNotebooks().data;
  const sources = useSources(notebookId).data;
  const flows = useFlowList(prefs.menus).data;
  const repos = useRepos().data;
  const allUploads = useUploads((s) => s.items);
  const addUploads = useUploads((s) => s.add);
  const cancelUpload = useUploads((s) => s.cancel);
  const uploads = useMemo(
    () => (notebookId ? allUploads.filter((u) => u.notebookId === notebookId) : []),
    [allUploads, notebookId],
  );
  // Save drafts (Admin → Automations): off keeps a draft on this device only.
  const autosave = draftAutosave(useAutomations(realThread && !isDemo).data);
  const synced = realThread && !isDemo && autosave.on;
  // Which flow answers here, so the model chip can say when it is not the one answering.
  const resolved = useResolvedFlow(synced ? threadId : undefined).data;
  // Before a thread exists (Home, a notebook page): the flow its notebook,
  // or the workspace, would use, so the chip can say so before you send.
  const allFlows = useFlowList(!synced && !isDemo).data;
  const upcoming = synced
    ? undefined
    : ((notebookId
        ? allFlows?.find((f) => f.active && f.scope === 'notebook' && f.scope_ref === notebookId)
        : undefined) ?? allFlows?.find((f) => f.active && f.scope === 'workspace'));
  const flowAnswers: { name: string } | null = resolved?.flow ?? upcoming ?? null;
  // "Just the next message" from the model choice: the model rides on this
  // message as an @model chip, and answers instead of the flow, once.
  const nextModel = useModelChoice((s) => (synced ? s.next[threadId] : undefined));
  useEffect(() => {
    if (!nextModel) return;
    const m = useModelChoice.getState().takeNext(threadId);
    if (!m) return;
    setPicked((p) => [
      ...p.filter((x) => x.kind !== 'model' && x.kind !== 'flow'),
      { kind: 'model', id: m.id, label: m.name, hue: m.hue },
    ]);
    ref.current?.focus();
  }, [nextModel, threadId]);
  const sendOnEnter = prefs.send === 'enter';

  // NVX Ancile's own commands that still make sense next to Claude Code's.
  const extras: AncileExtra[] = useMemo(
    () => [
      ...(notebookId
        ? [{ name: 'sources', description: "Open this notebook's sources", run: 'sources' as const }]
        : []),
      { name: 'keys', description: 'Show keyboard shortcuts', run: 'shortcuts' as const },
    ],
    [notebookId],
  );

  const effortLevels = model?.effortLevels;
  const offline = model?.id === 'offline/test';
  const [slash, setSlash] = useState<SlashModule | null>(null);
  const wantsSlash = text.startsWith('/') && !claudeCode;
  useEffect(() => {
    if (wantsSlash && !slash) void loadSlash().then(setSlash);
  }, [wantsSlash, slash]);
  const commands = useMemo(
    () =>
      slash?.slashFor({
        notebook: !!notebookId,
        thread: realThread,
        offline,
        dev: import.meta.env.DEV,
        effort: !!effortLevels?.length,
      }) ?? [],
    [slash, notebookId, realThread, offline, effortLevels],
  );

  const mentions: Mention[] = useMemo(() => {
    const src = isDemo
      ? demo.sources.map((s) => ({ kind: 'source' as const, id: s.id, label: s.title }))
      : notebookId
        ? (sources ?? [])
            .filter((s) => s.contextLevel !== 'off')
            .map((s) => ({ kind: 'source' as const, id: s.id, label: s.title }))
        : [];
    // A notebook mention only means something in a thread that has none.
    // Claude Code answers with its own model; only sources narrow a turn there.
    if (claudeCode) return src;
    const nbs = notebookId
      ? []
      : (notebooks ?? []).map((n) => ({
          kind: 'notebook' as const,
          id: n.id,
          label: n.title,
          hue: (n.color ?? null) as Hue | null,
        }));
    const mdl = (models ?? [])
      .filter((m) => m.chat !== false && m.id !== model?.id)
      .map((m) => ({ kind: 'model' as const, id: m.id, label: m.name, hue: m.hue }));
    const fl = (flows ?? []).map((f) => ({ kind: 'flow' as const, id: f.id, label: f.name }));
    const rp = (repos ?? []).map((r) => ({ kind: 'repo' as const, id: r.id, label: r.name }));
    return [...src, ...nbs, ...fl, ...rp, ...mdl];
  }, [isDemo, notebookId, sources, notebooks, models, model?.id, flows, repos, claudeCode]);

  // The latest values for the flush on unmount, without re-subscribing.
  const latest = useRef({ text, key, synced, threadId, parentId, sent: '' });
  latest.current = { ...latest.current, text, key, synced, threadId, parentId };

  // Restore the right draft when the thread or reply target changes: this
  // device first, then Core (a draft started somewhere else).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the draft key only
  useEffect(() => {
    let local = '';
    try {
      local = localStorage.getItem(key) ?? '';
    } catch {
      /* storage blocked */
    }
    setText(local);
    setPicked([]);
    latest.current.sent = local;
    if (local || !synced) return;
    let cancelled = false;
    api
      .get<{ text: string }>(`/drafts/${threadId}/${serverParent(parentId)}`)
      .then((d) => {
        if (cancelled || !d.text) return;
        latest.current.sent = d.text;
        setText((t) => t || d.text);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Autosave, debounced: this device at once, Core a little later, and only
  // when the text differs from what Core already has.
  useEffect(() => {
    const t = setTimeout(() => saveLocal(key, text), 400);
    const remote =
      synced && text !== latest.current.sent
        ? setTimeout(() => {
            latest.current.sent = text;
            void api.put(`/drafts/${threadId}/${serverParent(parentId)}`, { text }).catch(() => undefined);
          }, autosave.afterMs)
        : undefined;
    return () => {
      clearTimeout(t);
      clearTimeout(remote);
    };
  }, [text, key, synced, threadId, parentId, autosave.afterMs]);

  // Flush when the composer goes away or the tab hides, so a quick switch
  // never loses the last few words.
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      saveLocal(l.key, l.text);
      if (l.synced && l.text !== l.sent) {
        l.sent = l.text;
        void api
          .put(`/drafts/${l.threadId}/${serverParent(l.parentId)}`, { text: l.text })
          .catch(() => undefined);
      }
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, []);

  // Grow with the text up to 40% of the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight is rounded down while the line height is fractional, so a
    // one-line box came out a pixel short and showed scroll arrows. Scroll
    // only once the box reaches its cap.
    const max = window.innerHeight * 0.4;
    const want = el.scrollHeight + 2;
    el.style.height = `${Math.min(want, max)}px`;
    el.style.overflowY = want > max ? 'auto' : 'hidden';
  }, [text]);

  useBinding('composer.focus', () => ref.current?.focus());
  // Esc leaves the composer for navigate mode; only while it has focus, so
  // it never steals Esc from a sheet or panel.
  useBinding('layer.close', () => ref.current?.blur(), focused);

  // Menus: a slash command at the very start, an @ or ; token at the caret.
  const menu = useMemo(() => {
    if (dismissedMenu || !prefs.menus) return null;
    if (claudeCode) {
      const cc = ccMenu(text, claudeCode.commands, extras);
      if (cc) return { kind: 'cc' as const, items: cc.items, level: cc.level, query: text };
    }
    // "/fa" and "/fail " both offer the /fail variants; a second space means
    // the command is chosen and the rest is its argument.
    if (/^\/[^\n]*$/.test(text) && !/\s\S*\s/.test(text)) {
      const q = text.toLowerCase().trimEnd();
      const items = commands.filter((s) => s.cmd.startsWith(q) && s.cmd !== q);
      return { kind: 'slash' as const, items };
    }
    const at = /(?:^|\s)@([^\s@]*)$/.exec(text);
    if (at) {
      const q = (at[1] ?? '').toLowerCase();
      const taken = new Set(picked.map((p) => `${p.kind}:${p.id}`));
      return {
        kind: 'mention' as const,
        items: mentions
          .filter((m) => !taken.has(`${m.kind}:${m.id}`) && m.label.toLowerCase().includes(q))
          .slice(0, 8),
      };
    }
    const semi = /(?:^|\s)(;[a-z0-9-]*)$/.exec(text);
    if (semi && prefs.snippets.length) {
      const q = semi[1] ?? ';';
      return {
        kind: 'snippet' as const,
        items: prefs.snippets.filter((s) => s.trigger.startsWith(q)).slice(0, 8),
      };
    }
    return null;
  }, [text, dismissedMenu, mentions, commands, picked, prefs.menus, prefs.snippets, claudeCode, extras]);

  const menuOpen = !!menu && menu.items.length > 0;
  // With Slash and @ menus off, typing / or @ would do nothing visible: say why, once per draft.
  const menusOff =
    !prefs.menus && !dismissedMenu && (/^\/[^\s]*$/.test(text) || /(?:^|\s)@[^\s@]*$/.test(text));

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight when the menu changes shape
  useEffect(() => setMenuIndex(0), [menu?.kind, menu?.items.length]);

  // Keep the highlighted command in view in a long list.
  useEffect(() => {
    if (!menuOpen) return;
    document.getElementById(`composer-opt-${menuIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [menuIndex, menuOpen]);

  const runExtra = (run: AncileExtra['run']) => {
    if (run === 'sources') openDrawer('sources');
    else setShortcuts(true);
  };

  const pick = (i: number, how: 'tab' | 'enter' = 'tab') => {
    if (!menu) return;
    if (menu.kind === 'cc') {
      const item = menu.items[i];
      if (!item) return;
      if (item.extra) {
        clearDraft();
        runExtra(item.extra.run);
        return;
      }
      const c = item.command;
      if (!c || !claudeCode) return;
      if (item.arg !== undefined) {
        // A value picked for a command NVX Ancile handles (/effort high): done here.
        if (c.handled_by === 'ancile') {
          clearDraft();
          claudeCode.act(c, item.arg);
        } else setText(`/${c.name} ${item.arg} `);
      } else if (c.arguments.length > 0) {
        setText(`/${c.name} `);
      } else if (c.handled_by === 'ancile') {
        clearDraft();
        claudeCode.act(c, null);
      } else if (how === 'enter' && !c.argument_hint) {
        // Nothing more to type: Enter runs it, as in the terminal.
        void send(`/${c.name}`);
        return;
      } else setText(`/${c.name} `);
      ref.current?.focus();
      return;
    }
    if (menu.kind === 'slash') {
      const item = menu.items[i];
      // A command with nothing more to type runs at once; one that takes words completes, and a
      // second Enter runs it as it stands.
      if (item && item.id !== 'text' && (item.runOnPick || !item.arg)) {
        void runCommand(item, '');
        return;
      }
      if (item) setText(`${item.cmd} `);
    } else if (menu.kind === 'mention') {
      const item = menu.items[i];
      if (item) {
        setText((t) => t.replace(/(^|\s)@[^\s@]*$/, '$1'));
        // One model at a time: a second model mention replaces the first.
        // One model and one flow at a time: a second mention of either replaces the first.
        setPicked((p) => [
          ...p.filter(
            (x) =>
              !(
                (item.kind === 'model' || item.kind === 'flow' || item.kind === 'repo') &&
                x.kind === item.kind
              ),
          ),
          item,
        ]);
      }
    } else {
      const item = menu.items[i];
      if (item) setText((t) => t.replace(/;[a-z0-9-]*$/, item.text));
    }
    ref.current?.focus();
  };

  const uploading = uploads.some((u) => u.state === 'waiting' || u.state === 'sending');

  // A "/" command (CH5): what it does is loaded the first time one runs, so an idle composer
  // carries none of it. The line clears only when the command did its work.
  const runCommand = async (s: Slash, arg: string) => {
    if (running.current) return;
    running.current = true;
    try {
      const { runSlash } = await import('./slashActions');
      const done = await runSlash(s.id, {
        threadId,
        realThread,
        notebookId,
        parentId,
        arg,
        send: async (t) => {
          sentOk.current = false;
          await send(t, { plain: true });
          return sentOk.current;
        },
        efforts: effortLevels ?? [],
      });
      if (done) clearDraft();
      ref.current?.focus();
    } finally {
      running.current = false;
    }
  };

  const clearDraft = () => {
    setText('');
    setPicked([]);
    saveLocal(key, '');
    if (synced) {
      latest.current.sent = '';
      void api.put(`/drafts/${threadId}/${serverParent(parentId)}`, { text: '' }).catch(() => undefined);
    }
  };

  // Compare models (Beam): the draft is the question; it leaves the composer once the beam has started.
  // In a Claude Code thread too, where / opens Claude Code's own commands and so has no /beam.
  const compareModels = () => {
    const draft = text.trim();
    openBeam({
      threadId: realThread ? threadId : null,
      notebookId,
      parentId,
      text: draft,
      ...(draft && { onStarted: clearDraft }),
    });
  };

  const send = async (override?: string, how: { now?: boolean; plain?: boolean } = {}) => {
    let value = (override ?? text).trim();
    if (!value || sending || claudeCode?.readOnly) return;
    if (images.some((i) => i.state === 'sending')) {
      notify({ level: 'info', title: 'An image is still being attached', body: 'Send again in a moment.' });
      return;
    }
    if (files.some((f) => f.state === 'sending')) {
      notify({ level: 'info', title: 'A file is still being read', body: 'Send again in a moment.' });
      return;
    }
    // Busy and nothing can queue (a message already waits): say so rather than lose the text.
    if (busy && !how.now && queue?.queued) {
      notify({
        level: 'info',
        title: 'A message is already queued',
        body: 'It sends when this turn ends. Press Esc to take it back, or Stop to send it now.',
      });
      return;
    }
    // "/image <description>": the model makes it with image_generate (docs/images.md).
    const image = !claudeCode ? /^\/image(?:\s+([\s\S]*))?$/.exec(value) : null;
    if (image) {
      const prompt = (image[1] ?? '').trim();
      if (!prompt) {
        notify({
          level: 'info',
          title: 'Describe the image after /image',
          body: 'For example: /image a red pump on a white bench',
        });
        return;
      }
      const providers = await queryClient
        .fetchQuery({
          queryKey: imageKeys.providers,
          queryFn: () => api.get<ImageProviders>('/images/providers'),
          staleTime: 60_000,
        })
        .catch(() => null);
      if (providers?.empty_hint) {
        notify({ level: 'info', title: 'Images need a provider', body: providers.empty_hint });
        return;
      }
      value = `Make an image: ${prompt}`;
    }
    // A "/" command is run, never sent; one that does not exist is explained; "//" sends a slash (CH5).
    if (!claudeCode && !how.plain && value.startsWith('/')) {
      const { readTyped, slashFor, unknownWords } = slash ?? (await loadSlash());
      const list = slashFor({
        notebook: !!notebookId,
        thread: realThread,
        offline,
        dev: import.meta.env.DEV,
        effort: !!effortLevels?.length,
      });
      const typed = readTyped(value, list, { offline });
      if (typed.kind === 'command') {
        await runCommand(typed.slash, typed.arg);
        return;
      }
      if (typed.kind === 'unknown') {
        notify({ level: 'info', ...unknownWords(typed.name, list) });
        return;
      }
      if (typed.kind === 'escaped') value = typed.text;
    }
    // A command NVX Ancile does itself is never sent to Claude Code.
    if (claudeCode && value.startsWith('/')) {
      const typed = parseTyped(value, claudeCode.commands);
      if (typed?.command.handled_by === 'ancile') {
        clearDraft();
        claudeCode.act(typed.command, typed.arg);
        return;
      }
      const extra = typed ? undefined : extras.find((x) => value === `/${x.name}`);
      if (extra) {
        clearDraft();
        runExtra(extra.run);
        return;
      }
    }
    // Ctrl+Enter while Claude Code works: stop it, and the message goes in after (CC6's queue).
    if (how.now && claudeCode?.working) claudeCode.onStop();
    setSending(true);
    const ready = files.flatMap((f) => (f.state === 'ready' && f.record ? [f.record] : []));
    const keep = files.filter((f) => f.keep && f.state === 'ready').map((f) => f.file);
    const sendExtras: SendExtras = {
      mentions: picked
        .filter(
          (p): p is Mention & { kind: 'source' | 'notebook' | 'repo' } =>
            p.kind === 'source' || p.kind === 'notebook' || p.kind === 'repo',
        )
        .map((p) => ({ kind: p.kind, id: p.id })),
      model: picked.find((p) => p.kind === 'model')?.id ?? null,
      flowId: picked.find((p) => p.kind === 'flow')?.id ?? null,
      ...(images.length && {
        images: images.flatMap((i) => (i.state === 'ready' && i.record ? [i.record] : [])),
      }),
      ...(ready.length && { attachments: ready }),
      ...(how.now && { now: true }),
    };
    const ok = await Promise.resolve(onSend(value, sendExtras)).finally(() => setSending(false));
    if (ok === false) return;
    sentOk.current = true;
    clearDraft();
    clearImages();
    setFiles([]);
    // "Keep in notebook" is a source you asked for, added once the message is on its way.
    if (keep.length && notebookId) addUploads(notebookId, keep);
  };

  // Something outside the composer put text back (a queued message) or sent it.
  const replaced = useRef(replaceText?.n ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the signal changes only
  useEffect(() => {
    if (!replaceText || replaceText.n === replaced.current) return;
    replaced.current = replaceText.n;
    if (replaceText.text) setText(replaceText.text);
    else clearDraft();
  }, [replaceText?.n]);

  // "Use the corrected claim" (a fact-check card) writes a follow-up here. It joins what is already
  // written, never replaces it, and is never sent: sending stays your choice.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const d = (e as CustomEvent<{ threadId?: string; text?: string }>).detail;
      if (!d?.text || d.threadId !== threadId) return;
      const add = d.text;
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${add}` : add));
      ref.current?.focus();
    };
    window.addEventListener('ancile:composer-insert', onInsert);
    return () => window.removeEventListener('ancile:composer-insert', onInsert);
  }, [threadId]);

  const onChange = (value: string) => {
    // A snippet trigger followed by a space becomes its text.
    const m = /(?:^|\s)(;[a-z0-9-]{1,24}) $/.exec(value);
    const snip = m ? prefs.snippets.find((s) => s.trigger === m[1]) : undefined;
    if (snip && m) {
      setText(`${value.slice(0, value.length - (m[1]?.length ?? 0) - 1)}${snip.text}`);
    } else setText(value);
    setDismissedMenu(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menusOff && e.key === 'Escape') {
      e.preventDefault();
      setDismissedMenu(true);
      return;
    }
    if (menuOpen && menu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menu.items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menu.items.length) % menu.items.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pick(menuIndex, e.key === 'Enter' ? 'enter' : 'tab');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedMenu(true);
        return;
      }
    }
    // CH7: Esc takes the queued message back out (and stays in the composer).
    if (e.key === 'Escape' && queue?.queued && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      queue.remove();
      return;
    }
    // Backspace at the very start takes the last chip back.
    if (e.key === 'Backspace' && picked.length && e.currentTarget.selectionEnd === 0) {
      setPicked((p) => p.slice(0, -1));
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const working = busy || !!claudeCode?.working;
    // CH7: while an answer streams, Ctrl+Enter (Ctrl+Shift+Enter when Ctrl+Enter is your send key)
    // stops it and sends this now. Enter queues.
    if (working && mod && (sendOnEnter ? !e.shiftKey : e.shiftKey)) {
      e.preventDefault();
      void send(undefined, { now: true });
      return;
    }
    if (e.shiftKey) return;
    if (sendOnEnter || mod) {
      e.preventDefault();
      void send();
    }
  };

  const clearImages = () =>
    setImages((list) => {
      for (const i of list) URL.revokeObjectURL(i.preview);
      return [];
    });

  /** Images go with the next message of a real thread; anything else into the notebook. */
  const addImages = (files: File[]) => {
    const room = Math.max(0, IMAGE_LIMITS.perTurn - images.length);
    if (files.length > room)
      notify({
        level: 'info',
        title: `Up to ${IMAGE_LIMITS.perTurn} images go with one message`,
        body: 'Send these, then attach the rest to the next message.',
      });
    for (const file of files.slice(0, room)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const pending: PendingImage = {
        key,
        name: file.name || 'Pasted image',
        preview: URL.createObjectURL(file),
        state: 'sending',
      };
      setImages((l) => [...l, pending]);
      attachImage(threadId, file).then(
        (record) => setImages((l) => l.map((i) => (i.key === key ? { ...i, state: 'ready', record } : i))),
        (e: Error & { hint?: string }) => {
          setImages((l) => l.filter((i) => i.key !== key));
          URL.revokeObjectURL(pending.preview);
          notify({ level: 'error', title: e.message, body: e.hint ?? 'Try another image.' });
        },
      );
    }
  };

  /** Read these files for the next message only (CH6). */
  const attachFiles = (list: File[]) => {
    const room = Math.max(0, ATTACHMENT_LIMITS.perTurn - files.length);
    if (list.length > room)
      notify({
        level: 'info',
        title: `Up to ${ATTACHMENT_LIMITS.perTurn} files go with one message`,
        body: 'Send this one, then attach the rest to the next message.',
      });
    for (const file of list.slice(0, room)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setFiles((l) => [...l, { key, file, state: 'sending', keep: false }]);
      void loadAttachLib()
        .then(({ attachFile }) => attachFile(threadId, file))
        .then(
          (record) => setFiles((l) => l.map((f) => (f.key === key ? { ...f, state: 'ready', record } : f))),
          (e: Error & { hint?: string }) => {
            setFiles((l) => l.filter((f) => f.key !== key));
            notify({ level: 'error', title: e.message, body: e.hint ?? 'Try another file.' });
          },
        );
    }
  };

  const haveSource = (name: string) =>
    !!sources?.some((s) => s.title.trim().toLowerCase() === name.trim().toLowerCase());

  /** Add these to the notebook's sources: only ever on the person's say-so. */
  const addAsSources = (list: File[]) => {
    if (!notebookId) return;
    const fresh = list.filter((f) => !haveSource(f.name));
    const dup = list.filter((f) => haveSource(f.name));
    if (dup.length)
      notify({
        level: 'info',
        title:
          dup.length === 1 ? `${dup[0]?.name} is already a source here` : 'Some are already sources here',
        body: 'It was not added again.',
      });
    if (fresh.length) addUploads(notebookId, fresh);
  };

  const addFiles = async (incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length === 0) return;
    const pics = synced ? list.filter(isAttachableImage) : [];
    const rest = list.filter((f) => !pics.includes(f));
    if (pics.length) addImages(pics);
    if (rest.length === 0) return;
    const { isAttachableFile } = await loadAttachLib();
    const attachable = synced && !claudeCode ? rest.filter(isAttachableFile) : [];
    if (notebookId) {
      // A notebook: never a silent permanent source. Ask what the file is for.
      setAsk({ files: rest, attachable, have: rest.filter((f) => haveSource(f.name)).map((f) => f.name) });
      return;
    }
    if (claudeCode) {
      notify({
        level: 'info',
        title: 'Claude Code reads files from its folder',
        body: 'Put the file in the session folder and name its path in your message.',
      });
      return;
    }
    if (attachable.length) attachFiles(attachable);
    const left = rest.length - attachable.length;
    if (left > 0)
      notify({
        level: 'info',
        title: left === 1 ? 'That file cannot go with a message' : `${left} files cannot go with a message`,
        body: 'A message takes PDF, text, code and CSV files, and images. Add other files to a notebook as sources.',
      });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0 && (notebookId || synced)) {
      e.preventDefault();
      void addFiles(e.clipboardData.files);
      return;
    }
    // Formatting comes in as markdown, unless "Paste as plain text" is on.
    if (prefs.pastePlain) return;
    const md = htmlToMarkdown(e.clipboardData.getData('text/html'));
    if (!md) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = el.selectionStart + md.length;
    onChange(`${text.slice(0, el.selectionStart)}${md}${text.slice(el.selectionEnd)}`);
    requestAnimationFrame(() => el.setSelectionRange(at, at));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  // While an answer streams a model thread queues one message (CH7); with one already waiting, Send waits.
  const canQueue = busy && !!queue && !queue.queued;
  const canSend = !!text.trim() && !sending && (!busy || canQueue) && !claudeCode?.readOnly;
  const ghost = !claudeCode && prefs.menus && slash ? slash.ghostFor(text, commands) : null;
  const hasEffort = synced && !claudeCode && !!effortLevels?.length;
  const modelPick = picked.find((p) => p.kind === 'model');
  // Chips fit the width: whole labels, short ones, then icons with a tooltip.
  const chips = claudeCode
    ? (claudeCode.chips ?? 3)
    : 1 + (synced ? 1 : 0) + (scope ? 1 : 0) + (hasEffort ? 1 : 0);
  const bar = useComposerBar(root, chips);
  const sendKeys = sendOnEnter ? 'enter' : isMac ? 'meta+enter' : 'ctrl+enter';
  const modelName = modelPick?.label ?? model?.name ?? null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the textarea and buttons inside are the controls
    <div
      ref={root}
      className="composer m-glass-thick"
      data-tour="composer"
      data-bar={bar.fit}
      data-working={claudeCode?.working || busy || undefined}
      data-dragging={dragging || undefined}
      data-focused={focused || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = notebookId || synced ? 'copy' : 'none';
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {menusOff ? (
        <p className="composer__menu composer__menu-off m-glass" role="status">
          <span>Slash and @ menus are off, so / and @ are plain text.</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              usePrefs.getState().set('composer', { menus: true });
              ref.current?.focus();
            }}
          >
            Turn menus on
          </button>
        </p>
      ) : null}
      {menuOpen && menu ? (
        <div
          className="composer__menu m-glass"
          id="composer-menu"
          role="listbox"
          aria-label={
            menu.kind === 'cc'
              ? menu.level === 2
                ? 'Values'
                : 'Claude Code commands'
              : menu.kind === 'slash'
                ? 'Commands'
                : menu.kind === 'snippet'
                  ? 'Snippets'
                  : 'Mention'
          }
          data-kind={menu.kind}
        >
          {menu.kind === 'mention' ? (
            <div className="composer__menu-head mute" aria-hidden="true">
              {notebookId
                ? 'Answer from a source, or ask another model'
                : 'Ground in a notebook, or ask another model'}
            </div>
          ) : null}
          {menu.kind === 'cc'
            ? menu.items.map((s, i) => {
                // Headings while browsing; with a query the best match leads and the group is a tag.
                const browsing = menu.level === 2 || menu.query === '/';
                const head = browsing && s.group !== menu.items[i - 1]?.group ? s.group : null;
                return (
                  <CcOption
                    key={`${s.group}-${s.label}`}
                    head={head}
                    i={i}
                    active={i === menuIndex}
                    onPick={pick}
                  >
                    <span className="composer__cmd" data-num>
                      {s.label}
                    </span>
                    {s.argHint ? (
                      <span className="composer__arghint mute" data-num>
                        {s.argHint}
                      </span>
                    ) : null}
                    <span className="mute composer__opt-hint">{s.hint}</span>
                    {s.tag ? (
                      <span
                        className="composer__tag"
                        data-tone={s.tag === 'Terminal only' ? 'mute' : undefined}
                      >
                        {s.tag}
                      </span>
                    ) : !browsing ? (
                      <span className="mute composer__kind">{s.group}</span>
                    ) : null}
                  </CcOption>
                );
              })
            : menu.kind === 'slash'
              ? menu.items.map((s, i) => (
                  <MenuOption key={s.cmd} i={i} active={i === menuIndex} onPick={pick}>
                    <span className="composer__cmd" data-num>
                      {s.cmd}
                    </span>
                    {s.arg ? (
                      <span className="composer__arghint mute" data-num>
                        {s.arg}
                      </span>
                    ) : null}
                    <span className="mute composer__opt-hint">{s.hint}</span>
                  </MenuOption>
                ))
              : menu.kind === 'snippet'
                ? menu.items.map((s, i) => (
                    <MenuOption key={s.trigger} i={i} active={i === menuIndex} onPick={pick}>
                      <span className="composer__cmd" data-num>
                        {s.trigger}
                      </span>
                      <span className="mute composer__opt-hint">{s.text.slice(0, 80)}</span>
                    </MenuOption>
                  ))
                : menu.items.map((m, i) => (
                    <MenuOption key={`${m.kind}-${m.id}`} i={i} active={i === menuIndex} onPick={pick}>
                      <Icon name={MENTION_ICON[m.kind]} size={13} />
                      <span className="composer__opt-label">{m.label}</span>
                      <span className="mute composer__kind">{m.kind}</span>
                    </MenuOption>
                  ))}
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul className="composer__images" aria-label="Images going with this message">
          {images.map((i) => (
            <li key={i.key} className="composer__image" data-state={i.state}>
              <img src={i.preview} alt={i.name} />
              {i.state === 'sending' ? (
                <span className="composer__image-busy">
                  <span className="sr-only">Attaching {i.name}</span>
                </span>
              ) : null}
              <button
                type="button"
                className="icon-btn icon-btn--xs composer__image-remove"
                aria-label={`Remove ${i.name}`}
                onClick={() => {
                  URL.revokeObjectURL(i.preview);
                  setImages((l) => l.filter((x) => x.key !== i.key));
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {ask ? (
        <AskDrop
          ask={ask}
          synced={synced}
          claudeCode={!!claudeCode}
          onAttach={() => {
            attachFiles(ask.attachable);
            const others = ask.files.filter((f) => !ask.attachable.includes(f));
            if (others.length) addAsSources(others);
            setAsk(null);
            ref.current?.focus();
          }}
          onSource={() => {
            addAsSources(ask.files);
            setAsk(null);
            ref.current?.focus();
          }}
          onCancel={() => {
            setAsk(null);
            ref.current?.focus();
          }}
        />
      ) : null}

      {picked.length > 0 || uploads.length > 0 || files.length > 0 ? (
        <ul className="composer__chips" aria-label="Attached to this message">
          {picked.map((p) => (
            <li
              key={`${p.kind}-${p.id}`}
              className="mention-chip"
              data-kind={p.kind}
              style={p.hue ? ({ '--hue': hueVar(p.hue) } as CSSProperties) : undefined}
            >
              <Icon name={MENTION_ICON[p.kind]} size={12} />
              <span className="mention-chip__label">
                {p.kind === 'model'
                  ? `Answer with ${p.label}`
                  : p.kind === 'flow'
                    ? `Through ${p.label}`
                    : p.kind === 'repo'
                      ? `Git in ${p.label}`
                      : p.label}
              </span>
              <button
                type="button"
                className="icon-btn icon-btn--xs"
                aria-label={`Remove ${p.label}`}
                onClick={() => setPicked((x) => x.filter((y) => y !== p))}
              >
                <Icon name="close" size={10} />
              </button>
            </li>
          ))}
          {files.length > 0 ? (
            <FileChips
              files={files}
              inNotebook={!!notebookId}
              onKeep={(f) => {
                if (!f.keep && haveSource(f.file.name)) {
                  notify({
                    level: 'info',
                    title: `${f.file.name} is already a source here`,
                    body: 'It stays attached to this message only.',
                  });
                  return;
                }
                setFiles((l) => l.map((x) => (x.key === f.key ? { ...x, keep: !x.keep } : x)));
              }}
              onRemove={(f) => {
                const id = f.record?.id;
                if (id) void loadAttachLib().then((m) => m.discardAttachment(threadId, id));
                setFiles((l) => l.filter((x) => x.key !== f.key));
              }}
            />
          ) : null}
          {uploads.map((u) => (
            <li
              key={u.id}
              className="file-chip"
              data-state={u.state}
              style={{ '--p': u.progress } as CSSProperties}
              title={u.state === 'failed' ? `${u.name} was not added` : undefined}
            >
              <Icon
                name={u.state === 'done' ? 'check' : u.state === 'failed' ? 'alert' : 'upload'}
                size={12}
              />
              <span className="file-chip__name">{u.name}</span>
              <span data-num className="mute">
                {u.state === 'sending'
                  ? `${Math.round(u.progress * 100)}%`
                  : u.state === 'done'
                    ? 'added'
                    : u.state === 'failed'
                      ? 'failed'
                      : 'waiting'}
              </span>
              {u.state === 'waiting' || u.state === 'sending' || u.state === 'failed' ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--xs"
                  aria-label={u.state === 'failed' ? `Dismiss ${u.name}` : `Stop uploading ${u.name}`}
                  onClick={() => cancelUpload(u.id)}
                >
                  <Icon name="close" size={10} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <label className="sr-only" htmlFor="composer-input">
        Message
      </label>
      <div className="composer__field">
        {ghost ? (
          <div className="composer__ghost" aria-hidden="true">
            <span className="composer__ghost-typed">{text}</span>
            {ghost}
          </div>
        ) : null}
        <textarea
          id="composer-input"
          ref={ref}
          className="composer__input"
          rows={1}
          value={text}
          readOnly={!!claudeCode?.readOnly}
          aria-readonly={claudeCode?.readOnly ? true : undefined}
          spellCheck={prefs.spellcheck}
          placeholder={
            claudeCode?.readOnly ??
            placeholder ??
            (claudeCode
              ? notebookId
                ? 'Message Claude Code. / for its commands, @ to focus on a source'
                : 'Message Claude Code. / for its commands'
              : notebookId
                ? 'Ask this notebook. / for commands, @ to focus on a source'
                : 'Ask anything. / for commands, @ to bring in a notebook')
          }
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-autocomplete="list"
          aria-controls={menuOpen ? 'composer-menu' : undefined}
          aria-activedescendant={menuOpen ? `composer-opt-${menuIndex}` : undefined}
          aria-describedby={ghost ? 'composer-ghost-hint' : undefined}
        />
        {ghost ? (
          <span id="composer-ghost-hint" className="sr-only">
            Then type: {ghost.trim()}
          </span>
        ) : null}
      </div>

      <div className="composer__bar">
        {scope}
        <Tip
          label={
            synced
              ? notebookId
                ? 'Attach files, or add them to this notebook'
                : 'Attach PDF, text, code or CSV files to this message'
              : notebookId
                ? 'Add files to this notebook'
                : 'Files go with a message once a thread exists. Choose a notebook to add them as sources.'
          }
        >
          <label
            className="icon-btn icon-btn--sm composer__attach"
            data-disabled={(!notebookId && !synced) || undefined}
          >
            <Icon name="attach" size={14} />
            <span className="sr-only">{synced ? 'Attach files' : 'Add files to this notebook'}</span>
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={!notebookId && !synced}
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </Tip>
        {synced ? (
          <Tip label="Attach images to this message">
            <label className="icon-btn icon-btn--sm composer__attach">
              <Icon name="image" size={14} />
              <span className="sr-only">Attach images to this message</span>
              <input
                type="file"
                multiple
                accept={IMAGE_MIMES.join(',')}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files) addImages(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
            </label>
          </Tip>
        ) : null}
        <Tip label="Compare models: ask several at once, side by side">
          <button
            type="button"
            className="icon-btn icon-btn--sm composer__beam"
            aria-label="Compare models"
            onClick={compareModels}
          >
            <Icon name="compare" size={14} />
          </button>
        </Tip>
        {claudeCode ? (
          claudeCode.bar
        ) : (
          <>
            <Tip
              label={
                modelPick
                  ? `${modelPick.label} answers this message${flowAnswers ? `, instead of ${flowAnswers.name}` : ''}`
                  : flowAnswers
                    ? `${flowAnswers.name} answers here. This model answers when no flow does`
                    : 'Change model'
              }
              binding="model.switch"
            >
              <button
                type="button"
                className="composer__model"
                data-tour="model-chip"
                data-overridden={modelPick ? true : undefined}
                data-idle={!modelPick && flowAnswers ? true : undefined}
                aria-label={
                  modelPick
                    ? `${modelPick.label} for this message. Change model`
                    : flowAnswers
                      ? `${model?.name ?? 'No model'}, not used while ${flowAnswers.name} answers. Change model`
                      : `${model?.name ?? 'No model'}. Change model`
                }
                onClick={() => openPalette('models')}
              >
                {modelName ? (
                  <HueChip hue={modelPick?.hue ?? model?.hue ?? 'chalk'}>
                    <BarLabel full={modelName} short={shortModelName(modelName)} />
                  </HueChip>
                ) : (
                  <>
                    <Icon name="model" size={12} />
                    <BarLabel full="Choose a model" short="Model" />
                  </>
                )}
              </button>
            </Tip>
            {synced ? <ModelChoiceDialog /> : null}
            {synced ? <FlowChip threadId={threadId} notebookId={notebookId} /> : null}
            {hasEffort && effortLevels ? <EffortChip threadId={threadId} levels={effortLevels} /> : null}
          </>
        )}
        <span className="composer__hint mute" aria-live="polite" data-room={bar.hint || undefined}>
          {uploading ? (
            bar.hint ? (
              'Adding files. You can send now; they join the answer once read.'
            ) : (
              'Adding files'
            )
          ) : !bar.hint ? null : sendOnEnter ? (
            <>
              <Kbd keys="enter" /> to send, <Kbd keys="shift+enter" /> new line
            </>
          ) : (
            <>
              <Kbd keys={sendKeys} /> to send
            </>
          )}
        </span>
        {claudeCode?.working && !text.trim() ? (
          <Tip label="Stop Claude Code. What it wrote so far is kept">
            <button
              type="button"
              className="send send--stop"
              data-ready
              onClick={claudeCode.onStop}
              aria-label="Stop"
            >
              <Icon name="stop" size={14} />
            </button>
          </Tip>
        ) : (
          <Tip
            label={
              busy
                ? queue
                  ? queue.queued
                    ? 'One message is queued. Esc takes it back'
                    : `Queue for after this answer. ${isMac ? 'Cmd' : 'Ctrl'}+${sendOnEnter ? '' : 'Shift+'}Enter stops it and sends now`
                  : 'Wait for the answer to finish'
                : claudeCode?.working
                  ? 'Queue for after this turn'
                  : sendOnEnter && !bar.hint
                    ? 'Send. Shift+Enter for a new line'
                    : 'Send'
            }
            keys={sendKeys}
          >
            {/* A disabled button gets no pointer events: the span carries the tooltip. */}
            <span className="send-wrap">
              <button
                type="button"
                className="send"
                data-ready={canSend || undefined}
                onClick={() => void send()}
                disabled={!canSend}
                aria-label={
                  busy
                    ? queue
                      ? queue.queued
                        ? 'A message is already queued'
                        : 'Queue for after this answer'
                      : 'Wait for the answer to finish'
                    : claudeCode?.working
                      ? 'Queue for after this turn'
                      : 'Send'
                }
              >
                <Icon name="send" size={16} />
              </button>
            </span>
          </Tip>
        )}
      </div>

      {dragging ? (
        <div
          className="composer__drop"
          data-blocked={(!notebookId && !synced) || undefined}
          aria-hidden="true"
        >
          <Icon name={notebookId || synced ? 'upload' : 'notebook'} size={20} />
          <span>
            {synced
              ? notebookId
                ? 'Drop to attach to this message, or add as a source'
                : 'Drop to attach to this message'
              : notebookId
                ? "Drop to add to this notebook's sources"
                : 'Files go into a notebook. Choose one first.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function MenuOption({
  i,
  active,
  onPick,
  children,
}: {
  i: number;
  active: boolean;
  onPick: (i: number) => void;
  children: ReactNode;
}) {
  return (
    <div
      id={`composer-opt-${i}`}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(i);
      }}
    >
      {children}
    </div>
  );
}

/** A row of the Claude Code menu, under its group's heading when it starts one. */
function CcOption({
  head,
  i,
  active,
  onPick,
  children,
}: {
  head: string | null;
  i: number;
  active: boolean;
  onPick: (i: number) => void;
  children: ReactNode;
}) {
  return (
    <>
      {head ? (
        <div className="composer__menu-head composer__group mute" aria-hidden="true">
          {head}
        </div>
      ) : null}
      <MenuOption i={i} active={active} onPick={onPick}>
        {children}
      </MenuOption>
    </>
  );
}

function saveLocal(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    /* storage full or blocked: the draft lives for this session only */
  }
}

/**
 * Memoised: the thread screen hands it stable props, so a token arriving, or
 * anything else that redraws the screen around it, leaves the box you are
 * typing in alone (ROADMAP P2).
 */
export const Composer = memo(ComposerImpl);
