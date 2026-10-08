/**
 * ------------------------------------------------------------------
 *  Title    |  Add sources
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Four ways in, one dialog: files (drop or browse), links
 *           |  (one per line), pasted text, and past threads. It
 *           |  closes as soon as the work is handed over; progress
 *           |  shows on the sources themselves.
 *  How      |  Radix Dialog with a sliding tab plate. Files go through
 *           |  the upload queue, everything else straight to Core.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import * as Dialog from '@radix-ui/react-dialog';
import { motion } from 'motion/react';
import { type DragEvent, useMemo, useRef, useState } from 'react';
import { helpDone } from '../help/store';
import { tourEvent } from '../help/tours';
import { useLayer } from '../keys/dispatch';
import { useThreads } from '../lib/data';
import { relative } from '../lib/format';
import { addLink, addText, addThread } from '../lib/notebooks';
import { notify } from '../state/notify';
import { Icon, type IconName } from '../ui/Icon';
import { useUploads } from './uploads';

type Tab = 'files' | 'link' | 'text' | 'thread';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'files', label: 'Files', icon: 'upload' },
  { id: 'link', label: 'Links', icon: 'link' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'thread', label: 'Past thread', icon: 'thread' },
];

const ACCEPT =
  '.pdf,.docx,.doc,.pptx,.xlsx,.csv,.md,.markdown,.txt,.html,.htm,.json,.rtf,.epub,.py,.ts,.tsx,.js,.go,.rs,.java,.c,.cpp,.rb,.sql,.yaml,.yml,.toml';

const isUrl = (s: string) => /^https?:\/\/\S+\.\S+/i.test(s.trim());

export function AddSources({
  notebookId,
  open,
  onOpenChange,
  initialTab = 'files',
}: {
  notebookId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [links, setLinks] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const add = useUploads((s) => s.add);
  const threads = useThreads();
  useLayer(open);

  const urls = useMemo(() => links.split(/\s+/).filter(isUrl), [links]);
  const done = () => {
    setLinks('');
    setText('');
    setTitle('');
    onOpenChange(false);
  };

  const sendFiles = (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    add(notebookId, arr);
    notify({
      level: 'info',
      title: arr.length === 1 ? `Adding ${arr[0]?.name}` : `Adding ${arr.length} files`,
      body: 'You can keep working; each one shows its progress in Sources.',
    });
    done();
  };

  const sendLinks = async () => {
    setBusy(true);
    const results = await Promise.all(urls.map((u) => addLink(notebookId, u)));
    setBusy(false);
    if (results.some(Boolean)) {
      helpDone('source');
      tourEvent('source-added');
      done();
    }
  };

  const sendText = async () => {
    setBusy(true);
    const s = await addText(notebookId, text, title.trim() || undefined);
    setBusy(false);
    if (s) {
      helpDone('source');
      tourEvent('source-added');
      done();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
  };

  const pickable = (threads.data ?? [])
    .filter((t) => !filter || t.title.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 40);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog add-sources m-glass-thick" aria-describedby="add-sources-desc">
          <header className="dialog__head">
            <Dialog.Title className="dialog__title">Add sources</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn icon-btn--sm" aria-label="Close">
                <Icon name="close" size={14} />
              </button>
            </Dialog.Close>
          </header>
          <p id="add-sources-desc" className="dialog__lede">
            Answers in this notebook cite what you add here, down to the passage.
          </p>

          <div className="add-sources__tabs" role="tablist" aria-label="Kind of source">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className="add-sources__tab"
                onClick={() => setTab(t.id)}
              >
                {tab === t.id ? (
                  <motion.span
                    className="add-sources__plate"
                    layoutId="add-sources-tab"
                    transition={spring.snappy}
                  />
                ) : null}
                <Icon name={t.icon} size={14} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>

          <div className="add-sources__body" role="tabpanel">
            {tab === 'files' ? (
              // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the control
              <div
                className="dropzone"
                data-over={over || undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
              >
                <span className="dropzone__glyph">
                  <Icon name="upload" size={22} />
                </span>
                <p className="dropzone__title">Drop files here</p>
                <p className="mute">
                  PDF, Word, PowerPoint, Excel, web pages, markdown, text and code. Up to 200 MB each.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  hidden
                  onChange={(e) => e.target.files && sendFiles(e.target.files)}
                />
                <button type="button" className="btn btn--primary" onClick={() => fileRef.current?.click()}>
                  Choose files
                </button>
              </div>
            ) : null}

            {tab === 'link' ? (
              <form
                className="add-sources__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (urls.length) void sendLinks();
                }}
              >
                <label className="field">
                  <span>Links, one per line</span>
                  <textarea
                    className="input"
                    rows={5}
                    value={links}
                    onChange={(e) => setLinks(e.target.value)}
                    placeholder="https://"
                    // biome-ignore lint/a11y/noAutofocus: the person just chose this tab
                    autoFocus
                  />
                  <span className="field__hint">
                    NVX Ancile fetches each page, keeps its text, and checks now and then whether it has
                    changed.
                  </span>
                </label>
                <footer className="add-sources__foot">
                  <span className="mute" data-num>
                    {urls.length} {urls.length === 1 ? 'link' : 'links'}
                  </span>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={!urls.length || busy}
                    data-busy={busy || undefined}
                  >
                    Add {urls.length > 1 ? `${urls.length} links` : 'link'}
                  </button>
                </footer>
              </form>
            ) : null}

            {tab === 'text' ? (
              <form
                className="add-sources__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) void sendText();
                }}
              >
                <label className="field">
                  <span>Title</span>
                  <input
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Taken from the first line if empty"
                  />
                </label>
                <label className="field">
                  <span>Text</span>
                  <textarea
                    className="input"
                    rows={8}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Paste notes, an email, a transcript, anything in words. Markdown is kept."
                  />
                </label>
                <footer className="add-sources__foot">
                  <span className="mute" data-num>
                    {text.trim() ? `${text.trim().split(/\s+/).length.toLocaleString('en-GB')} words` : ''}
                  </span>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={!text.trim() || busy}
                    data-busy={busy || undefined}
                  >
                    Add text
                  </button>
                </footer>
              </form>
            ) : null}

            {tab === 'thread' ? (
              <div className="add-sources__threads">
                <label className="add-sources__filter">
                  <Icon name="search" size={13} />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Find a thread"
                    aria-label="Find a thread"
                  />
                </label>
                <ul>
                  {pickable.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="add-sources__thread"
                        onClick={async () => {
                          setBusy(true);
                          const s = await addThread(notebookId, t.id);
                          setBusy(false);
                          if (s) {
                            helpDone('source');
                            tourEvent('source-added');
                            done();
                          }
                        }}
                        disabled={busy}
                      >
                        <Icon name="thread" size={14} />
                        <span className="add-sources__thread-title" dir="auto">
                          {t.title}
                        </span>
                        <span className="mute">{relative(t.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                  {pickable.length === 0 ? (
                    <li className="mute add-sources__none">No threads match.</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
