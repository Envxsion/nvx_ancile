/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact panel
 *  Ref      |  docs/artifacts.md · DESIGN.md §13
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  An artifact beside the conversation: the preview, its
 *           |  code, every version the thread made of it, copy,
 *           |  download, full size, and the one risky switch (network)
 *           |  behind an explicit, explained step.
 *  How      |  A panel on the right on wide screens and a full-screen
 *           |  sheet on narrow ones; Esc closes it, focus moves in on
 *           |  open and back to the card on close. Previews of HTML,
 *           |  SVG, React and Mermaid run in ArtifactFrame (sandboxed);
 *           |  Markdown and code are drawn by the Cockpit. "Full size"
 *           |  is a Radix Dialog over everything.
 *  Note     |  Offers (copy or download asked by the artifact) wait in
 *           |  a bar until the person accepts or dismisses them.
 * ------------------------------------------------------------------
 */

import { fade, spring } from '@nvx/aperture';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, m as motion } from 'motion/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { relative } from '../lib/format';
import { useReducedMotion } from '../lib/motion';
import { useMediaQuery } from '../lib/useMediaQuery';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { MD_COMPONENTS } from '../thread/Citations';
import { CodeBlock } from '../thread/Code';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Icon } from '../ui/Icon';
import { StaleNotice } from '../ui/LoadFailed';
import { Markdown } from '../ui/Markdown';
import { Tip } from '../ui/primitives';
import { ArtifactFrame, type ArtifactOffer } from './ArtifactFrame';
import { FRAMED, fileName, mimeOf, saveFile, TYPE_ICON, TYPE_LABEL } from './meta';
import { artifactRecord, useArtifacts, useSetNetwork, useThreadArtifacts } from './store';

const CodeView = lazy(() =>
  import('../code/CodeView').then((m) => ({ default: m.CodeView })).catch(() => ({ default: FallbackCode })),
);

function FallbackCode({ value, language }: { value: string; language?: string | null }) {
  return <CodeBlock code={value} lang={language ?? null} numbers clamp={0} />;
}

type Tab = 'preview' | 'code';

function copyText(text: string, what: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => notify({ level: 'success', title: `${what} copied` }))
    .catch(() =>
      notify({ level: 'error', title: 'Could not copy', body: 'Select the text and copy it yourself.' }),
    );
}

function Preview({
  type,
  content,
  title,
  allowNetwork,
  onOffer,
}: {
  type: Parameters<typeof ArtifactFrame>[0]['type'];
  content: string;
  title: string;
  allowNetwork: boolean;
  onOffer: (o: ArtifactOffer) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!FRAMED.has(type))
    return type === 'markdown' ? (
      <div className="artifact-panel__doc">
        <Markdown className="md" controls={false} components={MD_COMPONENTS} plugins="remark">
          {content}
        </Markdown>
      </div>
    ) : null;
  return (
    <>
      <ArtifactFrame
        type={type}
        content={content}
        title={title}
        allowNetwork={allowNetwork}
        onOffer={onOffer}
        onError={setError}
        className="artifact-panel__frame"
      />
      {error ? (
        <p className="artifact-panel__runtime-error" role="status">
          <Icon name="warn" size={12} /> The artifact reported an error: {error.slice(0, 200)}
        </p>
      ) : null}
    </>
  );
}

function NetworkSwitch({
  on,
  changedAt,
  busy,
  onChange,
}: {
  on: boolean;
  changedAt: string | null;
  busy: boolean;
  onChange: (allow: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  if (on)
    return (
      <div className="artifact-net" data-on>
        <span className="artifact-net__state">
          <Icon name="globe" size={12} /> Network on{changedAt ? ` since ${relative(changedAt)}` : ''}
        </span>
        <button type="button" className="link-btn" disabled={busy} onClick={() => onChange(false)}>
          Turn off
        </button>
      </div>
    );
  return (
    <div className="artifact-net" data-asking={asking || undefined}>
      {asking ? (
        <>
          <span className="artifact-net__risk">
            It could send what it shows to any https site. Your files and NVX Ancile stay out of reach.
          </span>
          <span className="artifact-net__actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                onChange(true);
              }}
            >
              Allow network
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="artifact-net__state">
            <Icon name="lock" size={12} /> Network off
          </span>
          <button type="button" className="link-btn" onClick={() => setAsking(true)}>
            Allow network…
          </button>
        </>
      )}
    </div>
  );
}

function Offers({ offers, onDone }: { offers: ArtifactOffer[]; onDone: (i: number) => void }) {
  if (!offers.length) return null;
  const o = offers[0] as ArtifactOffer;
  const size =
    o.kind === 'copy'
      ? `${o.text.length.toLocaleString('en-GB')} characters`
      : `${Math.max(1, Math.round(o.data.length / 1024)).toLocaleString('en-GB')} KB`;
  return (
    <div className="artifact-offer" role="status">
      <Icon name={o.kind === 'copy' ? 'copy' : 'download'} size={13} />
      <span className="artifact-offer__text">
        {o.kind === 'copy'
          ? `The artifact wants to copy ${size}.`
          : `The artifact offers ${o.name} (${size}).`}
        {offers.length > 1 ? <span className="mute"> {offers.length - 1} more waiting.</span> : null}
      </span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => onDone(0)}>
        Dismiss
      </button>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={() => {
          if (o.kind === 'copy') copyText(o.text, 'Text');
          else saveFile(o.name, o.mime, o.data, o.mime === 'image/png');
          onDone(0);
        }}
      >
        {o.kind === 'copy' ? 'Copy' : 'Download'}
      </button>
    </div>
  );
}

export function ArtifactPanel() {
  const open = useArtifacts((s) => s.open);
  const full = useArtifacts((s) => s.full);
  const setFull = useArtifacts((s) => s.setFull);
  const pick = useArtifacts((s) => s.pick);
  const close = useArtifacts((s) => s.close);
  const demo = useUi((s) => s.demo);
  const narrow = useMediaQuery('(max-width: 760px)');
  const reduce = useReducedMotion();
  const list = useThreadArtifacts(open && !demo ? open.threadId : null);
  const setNetwork = useSetNetwork(open?.threadId ?? null);
  const [tab, setTab] = useState<Tab>('preview');
  const [offers, setOffers] = useState<ArtifactOffer[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const key = open ? `${open.threadId}:${open.artifact.key}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per artifact
  useEffect(() => {
    if (!key) return;
    opener.current = document.activeElement as HTMLElement | null;
    setTab(
      open && FRAMED.has(open.artifact.type)
        ? 'preview'
        : open?.artifact.type === 'code'
          ? 'code'
          : 'preview',
    );
    setOffers([]);
    // Focus lands on the title, so a screen reader announces what opened.
    requestAnimationFrame(() => (titleRef.current ?? panelRef.current)?.focus());
    return () => opener.current?.focus?.();
  }, [key]);

  useEffect(() => {
    if (!open || full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, full, close]);

  const record = open ? artifactRecord(open, list.data) : null;
  const versions = record?.versions ?? [];
  const latestForMessage = versions.findLast((v) => v.message_id === open?.messageId)?.version;
  const current =
    versions.find((v) => v.version === (open?.version ?? latestForMessage ?? versions.length)) ??
    versions[versions.length - 1];
  const at = current ? versions.indexOf(current) : 0;
  const offer = (o: ArtifactOffer) => setOffers((list) => [...list, o].slice(-5));

  const body = (where: 'panel' | 'full') =>
    current ? (
      tab === 'code' || !(FRAMED.has(current.type) || current.type === 'markdown') ? (
        <div className="artifact-panel__code">
          <ErrorBoundary scope="artifact" key={`c-${where}-${current.version}`}>
            <Suspense fallback={<FallbackCode value={current.content} language={current.language} />}>
              <CodeView value={current.content} language={current.language ?? current.type} readOnly />
            </Suspense>
          </ErrorBoundary>
        </div>
      ) : (
        <ErrorBoundary scope="artifact" key={`p-${where}-${current.version}`}>
          <Preview
            key={`${where}-${current.version}`}
            type={current.type}
            content={current.content}
            title={`${current.title}, version ${current.version}`}
            allowNetwork={record?.allow_network ?? false}
            onOffer={offer}
          />
        </ErrorBoundary>
      )
    ) : null;

  return (
    <>
      <AnimatePresence>
        {open && record && current ? (
          <motion.aside
            key="artifact-panel"
            ref={panelRef}
            tabIndex={-1}
            className="artifact-panel m-glass-thick"
            data-narrow={narrow || undefined}
            aria-label={`Artifact: ${current.title}`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            transition={reduce ? fade : spring.snappy}
          >
            <header className="artifact-panel__head">
              <span className="artifact-panel__tile" aria-hidden="true">
                <Icon name={TYPE_ICON[current.type]} size={15} />
              </span>
              <div className="artifact-panel__titles">
                <h2 className="artifact-panel__title" dir="auto" ref={titleRef} tabIndex={-1}>
                  {current.title}
                </h2>
                <p className="artifact-panel__sub">
                  {TYPE_LABEL[current.type]}
                  {current.language && current.type === 'code' ? ` · ${current.language}` : ''}
                  {record.local ? '' : ` · ${relative(current.created_at)}`}
                  {current.on_path === false ? ' · from another branch' : ''}
                </p>
              </div>
              <div className="artifact-panel__tools">
                <Tip label="Copy the code">
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Copy the code"
                    onClick={() => copyText(current.content, 'Code')}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </Tip>
                <Tip label="Download">
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Download"
                    onClick={() =>
                      saveFile(
                        fileName(current.type, record.key, current.language),
                        mimeOf(current.type),
                        current.content,
                      )
                    }
                  >
                    <Icon name="download" size={14} />
                  </button>
                </Tip>
                <Tip label="Open full size">
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Open full size"
                    onClick={() => setFull(true)}
                  >
                    <Icon name="expand" size={14} />
                  </button>
                </Tip>
                <Tip label="Close" binding={undefined}>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Close the artifact"
                    onClick={close}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </Tip>
              </div>
            </header>

            <div className="artifact-panel__bar">
              {FRAMED.has(current.type) || current.type === 'markdown' ? (
                <div className="segmented" role="radiogroup" aria-label="Show">
                  {(['preview', 'code'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={tab === t}
                      className="segmented__opt"
                      onClick={() => setTab(t)}
                    >
                      {t === 'preview' ? 'Preview' : 'Code'}
                    </button>
                  ))}
                </div>
              ) : (
                <span />
              )}
              {versions.length > 1 ? (
                <div className="artifact-versions" role="group" aria-label="Versions">
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Earlier version"
                    disabled={at === 0}
                    onClick={() => pick(versions[at - 1]?.version ?? null)}
                  >
                    <Icon name="chevronLeft" size={13} />
                  </button>
                  <span className="artifact-versions__label" aria-live="polite">
                    Version {current.version} of {versions.length}
                  </span>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Later version"
                    disabled={at === versions.length - 1}
                    onClick={() => pick(versions[at + 1]?.version ?? null)}
                  >
                    <Icon name="chevronRight" size={13} />
                  </button>
                </div>
              ) : null}
            </div>

            {FRAMED.has(current.type) && current.type !== 'svg' ? (
              <NetworkSwitch
                on={record.allow_network}
                changedAt={record.network_changed_at}
                busy={setNetwork.isPending}
                onChange={(allow) => {
                  if (record.local || !open.threadId) {
                    notify({
                      level: 'info',
                      title: 'Network stays off here',
                      body: 'Only artifacts in a saved thread can be allowed the network.',
                    });
                    return;
                  }
                  setNetwork.mutate(
                    { key: record.key, allow },
                    {
                      onError: () =>
                        notify({
                          level: 'error',
                          title: 'The setting was not saved',
                          body: 'The network stays off. Check NVX Ancile is running and try again.',
                        }),
                    },
                  );
                }}
              />
            ) : null}

            {/* The card's own copy stays on screen; say the thread's versions did not load. */}
            {list.isError ? (
              <StaleNotice
                error={list.error}
                what="This artifact's versions"
                note={list.data ? undefined : 'This is the copy in the answer.'}
                onRetry={() => list.refetch()}
              />
            ) : null}

            <Offers offers={offers} onDone={(i) => setOffers((l) => l.filter((_, k) => k !== i))} />

            <div className="artifact-panel__body" data-tab={tab}>
              {body('panel')}
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>

      <Dialog.Root open={Boolean(open && full)} onOpenChange={(o) => !o && setFull(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="sheet-scrim" />
          <Dialog.Content className="artifact-full" aria-describedby={undefined}>
            <div className="artifact-full__head">
              <Dialog.Title className="artifact-full__title">{current?.title ?? 'Artifact'}</Dialog.Title>
              <Dialog.Close className="icon-btn icon-btn--sm" aria-label="Close full size">
                <Icon name="close" size={14} />
              </Dialog.Close>
            </div>
            <div className="artifact-full__body">{full ? body('full') : null}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
