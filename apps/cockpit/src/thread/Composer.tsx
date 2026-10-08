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
 *  Note     |  Which key sends is a setting (Settings → Composer).
 *           |  Esc leaves the composer for navigate mode, `i` returns.
 * ------------------------------------------------------------------
 */

import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as demo from '../fixtures/demo';
import { useBinding } from '../keys/dispatch';
import { api } from '../lib/api';
import { useModels, useNotebooks, useSources } from '../lib/data';
import { hueVar } from '../lib/format';
import { useCurrentModel } from '../lib/models';
import type { Hue } from '../lib/types';
import { useUploads } from '../sources/uploads';
import { usePref } from '../state/prefs';
import { useUi } from '../state/ui';
import { Icon, type IconName } from '../ui/Icon';
import { HueChip, Kbd, Tip } from '../ui/primitives';
import { FlowChip } from './FlowChip';
import { useFlowList, useResolvedFlow } from './flowActions';
import { ModelChoiceDialog, useModelChoice } from './ModelChoice';

interface Slash {
  cmd: string;
  hint: string;
  /** Runs here instead of being sent. */
  run?: 'models' | 'sources' | 'shortcuts';
}

// Only commands that work today. TODO(phase-4): /memory, /compact, /branch, /factcheck.
const SLASH: Slash[] = [
  { cmd: '/model', hint: 'Choose the model for this thread', run: 'models' },
  { cmd: '/sources', hint: "Open this notebook's sources", run: 'sources' },
  { cmd: '/keys', hint: 'Show keyboard shortcuts', run: 'shortcuts' },
];

/** What the offline test model obeys; listed only while it is the model. */
const TEST_DIRECTIVES: Slash[] = [
  { cmd: '/say', hint: 'Answer with exactly the text that follows' },
  { cmd: '/slow', hint: 'Write one word every 150 ms, so you can watch it stream' },
  { cmd: '/fail 500', hint: 'Fail on purpose and watch NVX Ancile switch to the backup model' },
  { cmd: '/fail refusal', hint: 'Decline on purpose; NVX Ancile asks the backup model instead' },
  { cmd: '/fail auth', hint: 'Fail as if the API key were wrong' },
  { cmd: '/tool fs_write', hint: 'Write a file, e.g. {"path":"note.md","content":"hi"}. Asks first' },
  { cmd: '/tool fs_list', hint: 'List the workspace, e.g. {"path":"/workspace"}' },
];

export interface Mention {
  kind: 'source' | 'model' | 'notebook' | 'flow';
  id: string;
  label: string;
  hue?: Hue | null;
}

export interface SendExtras {
  mentions: { kind: 'source' | 'notebook'; id: string }[];
  /** A model @-mentioned for this one message. */
  model: string | null;
  /** A flow @-mentioned for this one message (DESIGN §16.3). */
  flowId: string | null;
}

const MENTION_ICON: Record<Mention['kind'], IconName> = {
  source: 'sources',
  model: 'model',
  notebook: 'notebook',
  flow: 'tree',
};

const serverParent = (parentId: string | null) => parentId ?? '_';

export const draftKey = (threadId: string, parentId: string | null) =>
  `nvx.ancile.draft:${threadId}:${parentId ?? 'root'}`;

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

export function Composer({
  threadId,
  parentId,
  onSend,
  busy = false,
  notebookId = null,
  scope,
  placeholder,
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
  const ref = useRef<HTMLTextAreaElement>(null);
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
  const allUploads = useUploads((s) => s.items);
  const addUploads = useUploads((s) => s.add);
  const cancelUpload = useUploads((s) => s.cancel);
  const uploads = useMemo(
    () => (notebookId ? allUploads.filter((u) => u.notebookId === notebookId) : []),
    [allUploads, notebookId],
  );
  const synced = realThread && !isDemo;
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

  const commands = useMemo(() => {
    const base = SLASH.filter((s) => s.run !== 'sources' || notebookId);
    return model?.id === 'offline/test' ? [...base, ...TEST_DIRECTIVES] : base;
  }, [model?.id, notebookId]);

  const mentions: Mention[] = useMemo(() => {
    const src = isDemo
      ? demo.sources.map((s) => ({ kind: 'source' as const, id: s.id, label: s.title }))
      : notebookId
        ? (sources ?? [])
            .filter((s) => s.contextLevel !== 'off')
            .map((s) => ({ kind: 'source' as const, id: s.id, label: s.title }))
        : [];
    // A notebook mention only means something in a thread that has none.
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
    return [...src, ...nbs, ...fl, ...mdl];
  }, [isDemo, notebookId, sources, notebooks, models, model?.id, flows]);

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
          }, 1_200)
        : undefined;
    return () => {
      clearTimeout(t);
      clearTimeout(remote);
    };
  }, [text, key, synced, threadId, parentId]);

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
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useBinding('composer.focus', () => ref.current?.focus());
  // Esc leaves the composer for navigate mode; only while it has focus, so
  // it never steals Esc from a sheet or panel.
  useBinding('layer.close', () => ref.current?.blur(), focused);

  // Menus: a slash command at the very start, an @ or ; token at the caret.
  const menu = useMemo(() => {
    if (dismissedMenu || !prefs.menus) return null;
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
  }, [text, dismissedMenu, mentions, commands, picked, prefs.menus, prefs.snippets]);

  const menuOpen = !!menu && menu.items.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight when the menu changes shape
  useEffect(() => setMenuIndex(0), [menu?.kind, menu?.items.length]);

  const pick = (i: number) => {
    if (!menu) return;
    if (menu.kind === 'slash') {
      const item = menu.items[i];
      if (item?.run) {
        setText('');
        if (item.run === 'models') openPalette('models');
        else if (item.run === 'sources') openDrawer('sources');
        else setShortcuts(true);
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
          ...p.filter((x) => !((item.kind === 'model' || item.kind === 'flow') && x.kind === item.kind)),
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

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const extras: SendExtras = {
      mentions: picked
        .filter(
          (p): p is Mention & { kind: 'source' | 'notebook' } => p.kind === 'source' || p.kind === 'notebook',
        )
        .map((p) => ({ kind: p.kind, id: p.id })),
      model: picked.find((p) => p.kind === 'model')?.id ?? null,
      flowId: picked.find((p) => p.kind === 'flow')?.id ?? null,
    };
    const ok = await Promise.resolve(onSend(value, extras)).finally(() => setSending(false));
    if (ok === false) return;
    setText('');
    setPicked([]);
    saveLocal(key, '');
    if (synced) {
      latest.current.sent = '';
      void api.put(`/drafts/${threadId}/${serverParent(parentId)}`, { text: '' }).catch(() => undefined);
    }
  };

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
        pick(menuIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedMenu(true);
        return;
      }
    }
    // Backspace at the very start takes the last chip back.
    if (e.key === 'Backspace' && picked.length && e.currentTarget.selectionEnd === 0) {
      setPicked((p) => p.slice(0, -1));
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (sendOnEnter || mod) {
      e.preventDefault();
      void send();
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0 || !notebookId) return;
    addUploads(notebookId, list);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0 && notebookId) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const canSend = !!text.trim() && !sending && !busy;
  const modelPick = picked.find((p) => p.kind === 'model');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the textarea and buttons inside are the controls
    <div
      className="composer m-glass-thick"
      data-tour="composer"
      data-dragging={dragging || undefined}
      data-focused={focused || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = notebookId ? 'copy' : 'none';
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {menuOpen && menu ? (
        <div
          className="composer__menu m-glass"
          id="composer-menu"
          role="listbox"
          aria-label={menu.kind === 'slash' ? 'Commands' : menu.kind === 'snippet' ? 'Snippets' : 'Mention'}
        >
          {menu.kind === 'mention' ? (
            <div className="composer__menu-head mute" aria-hidden="true">
              {notebookId
                ? 'Answer from a source, or ask another model'
                : 'Ground in a notebook, or ask another model'}
            </div>
          ) : null}
          {menu.kind === 'slash'
            ? menu.items.map((s, i) => (
                <MenuOption key={s.cmd} i={i} active={i === menuIndex} onPick={pick}>
                  <span className="composer__cmd" data-num>
                    {s.cmd}
                  </span>
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

      {picked.length > 0 || uploads.length > 0 ? (
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
      <textarea
        id="composer-input"
        ref={ref}
        className="composer__input"
        rows={1}
        value={text}
        spellCheck={prefs.spellcheck}
        placeholder={
          placeholder ??
          (notebookId
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
      />

      <div className="composer__bar">
        {scope}
        <Tip
          label={notebookId ? 'Add files to this notebook' : 'Files go into a notebook. Choose one first.'}
        >
          <label className="icon-btn icon-btn--sm composer__attach" data-disabled={!notebookId || undefined}>
            <Icon name="attach" size={14} />
            <span className="sr-only">Add files to this notebook</span>
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={!notebookId}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </Tip>
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
            {modelPick ? (
              <HueChip hue={modelPick.hue ?? model?.hue ?? 'chalk'}>{modelPick.label}</HueChip>
            ) : model ? (
              <HueChip hue={model.hue}>{model.name}</HueChip>
            ) : (
              'Choose a model'
            )}
          </button>
        </Tip>
        {synced ? <ModelChoiceDialog /> : null}
        {synced ? <FlowChip threadId={threadId} notebookId={notebookId} /> : null}
        <span className="composer__hint mute" aria-live="polite">
          {uploading ? (
            'Adding files. You can send now; they join the answer once read.'
          ) : sendOnEnter ? (
            <>
              <Kbd keys="enter" /> to send, <Kbd keys="shift+enter" /> for a new line
            </>
          ) : (
            <>
              <Kbd keys={isMac ? 'meta+enter' : 'ctrl+enter'} /> to send
            </>
          )}
        </span>
        <button
          type="button"
          className="send"
          data-ready={canSend || undefined}
          onClick={() => void send()}
          disabled={!canSend}
          aria-label={busy ? 'Wait for the answer to finish' : 'Send'}
        >
          <Icon name="send" size={16} />
        </button>
      </div>

      {dragging ? (
        <div className="composer__drop" data-blocked={!notebookId || undefined} aria-hidden="true">
          <Icon name={notebookId ? 'upload' : 'notebook'} size={20} />
          <span>
            {notebookId
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

function saveLocal(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    /* storage full or blocked: the draft lives for this session only */
  }
}
