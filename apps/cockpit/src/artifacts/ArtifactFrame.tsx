/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact frame
 *  Ref      |  docs/artifacts.md (Security)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Run one HTML, SVG, React or Mermaid artifact where it
 *           |  can do no harm, and listen to it only for the few
 *           |  things it may ask: its height, and offers to copy or
 *           |  download something.
 *  How      |  <iframe sandbox="allow-scripts"> on the frame host
 *           |  (lib/frameHost.ts), which writes the document it is
 *           |  posted: an opaque
 *           |  origin (never allow-same-origin), no top navigation,
 *           |  no popups, no forms. The document (document.ts) carries
 *           |  the CSP. Messages are accepted only from this frame's
 *           |  own window, with this frame's nonce, and only when they
 *           |  match ArtifactFrameMessage; everything else is dropped.
 *  Note     |  Copy and download are never done for the artifact: they
 *           |  become offers the person accepts with a click.
 * ------------------------------------------------------------------
 */

import { ARTIFACT_CHANNEL, ArtifactFrameMessage, type ArtifactType } from '@nvx/contracts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FRAME_HOST_URL, feedFrame } from '../lib/frameHost';
import { buildArtifactDocument, type FrameTheme, newNonce, type Runtime } from './document';
import { compileComponent, mermaidRuntime, reactRuntime } from './runtime';

/** The sandbox flags. Exactly these: see docs/artifacts.md before changing them. */
export const ARTIFACT_SANDBOX = 'allow-scripts';
/** Powerful features the frame may never ask for. */
export const ARTIFACT_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; fullscreen 'none'";

export type ArtifactOffer =
  | { kind: 'copy'; text: string }
  | { kind: 'download'; name: string; mime: string; data: string };

export function frameTheme(): FrameTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    scheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    bg: v('--lift', 'Canvas'),
    fg: v('--fg', 'CanvasText'),
    mute: v('--mute', 'GrayText'),
    edge: v('--edge', 'GrayText'),
    font: v('--font-sans', 'system-ui, sans-serif'),
    mono: v('--font-mono', 'ui-monospace, monospace'),
  };
}

type Prepared = { state: 'loading' } | { state: 'ready'; doc: string } | { state: 'error'; message: string };

/** Build the document, loading what this type needs. */
function usePrepared(
  type: ArtifactType,
  content: string,
  allowNetwork: boolean,
  nonce: string,
  theme: FrameTheme,
) {
  const [prepared, setPrepared] = useState<Prepared>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setPrepared({ state: 'loading' });
    (async () => {
      const runtime: Runtime = {};
      let compiled: string | undefined;
      if (type === 'react') {
        const [rt, js] = await Promise.all([reactRuntime(), compileComponent(content)]);
        runtime.react = rt;
        compiled = js;
      }
      if (type === 'mermaid') runtime.mermaid = await mermaidRuntime();
      return buildArtifactDocument({
        type,
        content,
        nonce,
        allowNetwork,
        theme,
        runtime,
        ...(compiled !== undefined && { compiled }),
      });
    })().then(
      (doc) => live && setPrepared({ state: 'ready', doc }),
      (err: unknown) =>
        live &&
        setPrepared({
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        }),
    );
    return () => {
      live = false;
    };
  }, [type, content, allowNetwork, nonce, theme]);
  return prepared;
}

export function ArtifactFrame({
  type,
  content,
  title,
  allowNetwork,
  onOffer,
  onError,
  fit = false,
  className,
}: {
  type: ArtifactType;
  content: string;
  title: string;
  allowNetwork: boolean;
  onOffer?: (o: ArtifactOffer) => void;
  onError?: (message: string) => void;
  /** Grow to the content's height instead of filling the box. */
  fit?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // A new frame (and nonce) for every new content or network decision.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce is per document
  const nonce = useMemo(() => newNonce(), [content, allowNetwork, type]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read the theme once per document
  const theme = useMemo(() => frameTheme(), [content, allowNetwork, type]);
  const prepared = usePrepared(type, content, allowNetwork, nonce, theme);
  const [height, setHeight] = useState<number | null>(null);
  const offerRef = useRef(onOffer);
  const errorRef = useRef(onError);
  offerRef.current = onOffer;
  errorRef.current = onError;

  // Before the frame host can load: it says ready, and gets this document once.
  const doc = prepared.state === 'ready' ? prepared.doc : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new frame per nonce
  useLayoutEffect(() => {
    if (doc === null || !ref.current) return;
    return feedFrame(ref.current, doc);
  }, [doc, nonce]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this frame's own window, and only an opaque origin (a sandboxed frame says "null").
      if (!ref.current || e.source !== ref.current.contentWindow || e.origin !== 'null') return;
      const data = e.data as { channel?: unknown } | null;
      if (!data || typeof data !== 'object' || data.channel !== ARTIFACT_CHANNEL) return;
      const msg = ArtifactFrameMessage.safeParse(data);
      if (!msg.success || msg.data.nonce !== nonce) return;
      const m = msg.data;
      if (m.kind === 'size') setHeight(Math.min(Math.max(m.height, 48), 20_000));
      else if (m.kind === 'copy') offerRef.current?.({ kind: 'copy', text: m.text });
      else if (m.kind === 'download')
        offerRef.current?.({ kind: 'download', name: m.name, mime: m.mime, data: m.data });
      else if (m.kind === 'error') errorRef.current?.(m.message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [nonce]);

  if (prepared.state === 'error')
    return (
      <div className="artifact-frame__error" role="alert">
        <p className="artifact-frame__error-title">This artifact could not be prepared.</p>
        <pre>{prepared.message}</pre>
        <p className="mute">Ask for a corrected version, or open the Code tab to read it.</p>
      </div>
    );
  return (
    <div
      className={`artifact-frame ${className ?? ''}`}
      data-state={prepared.state}
      data-fit={fit || undefined}
    >
      {prepared.state === 'loading' ? (
        <div className="artifact-frame__loading" aria-live="polite">
          <span className="artifact-frame__shimmer" aria-hidden="true" />
          {type === 'mermaid'
            ? 'Preparing the diagram'
            : type === 'react'
              ? 'Compiling the component'
              : 'Loading'}
        </div>
      ) : (
        <iframe
          ref={ref}
          key={nonce}
          title={title}
          className="artifact-frame__iframe"
          sandbox={ARTIFACT_SANDBOX}
          allow={ARTIFACT_ALLOW}
          referrerPolicy="no-referrer"
          src={FRAME_HOST_URL}
          style={fit && height ? { height } : undefined}
          data-network={allowNetwork ? 'on' : 'off'}
        />
      )}
    </div>
  );
}
