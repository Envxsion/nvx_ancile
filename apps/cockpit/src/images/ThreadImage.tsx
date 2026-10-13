/**
 * ------------------------------------------------------------------
 *  Title    |  Images in a thread: inline, in a lightbox, by consent
 *  Ref      |  docs/images.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Show every image an answer or a person put in a thread
 *           |  the same way: inline and lazy, with its alt text, and
 *           |  opened full size with zoom, download and copy.
 *  How      |  Local, data: and blob: images load directly. A remote
 *           |  image is a beacon, so it is never loaded by itself: a
 *           |  placeholder offers "Load image from <host>"; the yes is
 *           |  remembered for the notebook in Core, and the image then
 *           |  comes through Core's proxy (the page's CSP allows only
 *           |  'self', data: and blob: images). Outside a thread there
 *           |  is nowhere to keep the yes, so only the link is offered.
 *  Note     |  The lightbox is a Radix dialog: focus moves in and back,
 *           |  Escape closes it, and every control has a name.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { createContext, type ReactNode, type RefObject, useContext, useRef, useState } from 'react';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { allowImageHost, isLocalSrc, remoteImageSrc, useImageHosts } from './api';

/** The thread images are shown in, so a remote image's yes can be kept for its notebook. */
const ImageThread = createContext<string | null>(null);

export function ImageThreadProvider({
  threadId,
  children,
}: {
  threadId: string | null;
  children: ReactNode;
}) {
  return <ImageThread.Provider value={threadId}>{children}</ImageThread.Provider>;
}

const hostOf = (src: string) => {
  try {
    return new URL(src).hostname;
  } catch {
    return null;
  }
};

const fileName = (alt: string, mime = 'image/png') => {
  const base =
    alt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'image';
  return `${base}.${mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`;
};

/** Copy an image as PNG (the one type every clipboard takes). */
async function copyImage(src: string): Promise<void> {
  const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
  let png = blob;
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')?.drawImage(bmp, 0, 0);
    png = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];

/** The full-size view: zoom, download, copy, close. */
export function Lightbox({
  src,
  alt,
  caption,
  open,
  onOpenChange,
  returnFocus,
}: {
  src: string;
  alt: string;
  caption?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes back to when it closes: the image that opened it. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // null: fit to the window.
  const [zoom, setZoom] = useState<number | null>(null);
  const step = (dir: 1 | -1) => {
    const at = zoom ?? 1;
    const next = dir > 0 ? ZOOMS.find((z) => z > at) : [...ZOOMS].reverse().find((z) => z < at);
    setZoom(next ?? at);
  };
  const copy = async () => {
    try {
      await copyImage(src);
      notify({ level: 'success', title: 'Image copied' });
    } catch {
      notify({
        level: 'error',
        title: 'The image could not be copied',
        body: 'Your browser did not allow it. Download it instead.',
      });
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) setZoom(null);
        onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="scrim lightbox__scrim" />
        <Dialog.Content
          className="lightbox"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (!returnFocus?.current) return;
            e.preventDefault();
            returnFocus.current.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === '+' || e.key === '=') step(1);
            else if (e.key === '-') step(-1);
            else if (e.key === '0') setZoom(null);
          }}
        >
          <div className="lightbox__bar">
            <Dialog.Title className="lightbox__title">{alt || 'Image'}</Dialog.Title>
            <div className="lightbox__tools">
              <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => step(-1)}>
                <Icon name="minus" size={14} />
              </button>
              <button
                type="button"
                className="lightbox__zoom"
                aria-label={zoom === null ? 'Fitted to the window. Show actual size' : 'Fit to the window'}
                onClick={() => setZoom(zoom === null ? 1 : null)}
              >
                <span data-num>{zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
              </button>
              <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => step(1)}>
                <Icon name="plus" size={14} />
              </button>
              <button type="button" className="icon-btn" aria-label="Copy image" onClick={() => void copy()}>
                <Icon name="copy" size={14} />
              </button>
              <a className="icon-btn" href={src} download={fileName(alt)} aria-label="Download image">
                <Icon name="download" size={14} />
              </a>
              <Dialog.Close className="icon-btn" aria-label="Close">
                <Icon name="close" size={14} />
              </Dialog.Close>
            </div>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a zoomed image scrolls and must take focus */}
          <div className="lightbox__stage" data-fit={zoom === null || undefined} tabIndex={0}>
            <img
              src={src}
              alt={alt}
              style={zoom === null ? undefined : { width: `${zoom * 100}%`, maxWidth: 'none' }}
            />
          </div>
          {caption ? <div className="lightbox__caption">{caption}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** An image shown inline that opens in the lightbox. */
export function ImageFrame({
  src,
  alt,
  width,
  height,
  caption,
  className,
}: {
  src: string;
  alt: string;
  width?: number | null | undefined;
  height?: number | null | undefined;
  caption?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (broken)
    return (
      <span className="img-missing" role="img" aria-label={alt || 'Image'}>
        <Icon name="image" size={14} />
        <span>{alt ? `${alt}: ` : ''}this image could not be shown.</span>
      </span>
    );
  return (
    <>
      <button
        ref={opener}
        type="button"
        className={`img-frame${className ? ` ${className}` : ''}`}
        onClick={() => setOpen(true)}
        aria-label={alt ? `Open image: ${alt}` : 'Open image'}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          {...(width ? { width } : {})}
          {...(height ? { height } : {})}
          onError={() => setBroken(true)}
        />
        <span className="img-frame__open" aria-hidden="true">
          <Icon name="expand" size={12} />
        </span>
      </button>
      <Lightbox
        src={src}
        alt={alt}
        caption={caption}
        open={open}
        onOpenChange={setOpen}
        returnFocus={opener}
      />
    </>
  );
}

/** A remote image, behind its "Load image from <host>" placeholder. */
function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const threadId = useContext(ImageThread);
  const hosts = useImageHosts(threadId);
  const [busy, setBusy] = useState(false);
  const host = hostOf(src);
  if (!host || !/^https?:$/.test(new URL(src).protocol))
    return (
      <span className="img-missing">
        <Icon name="image" size={14} />
        <span>{alt || 'An image'} with an address that cannot be shown.</span>
      </span>
    );
  const allowed = hosts.data?.hosts.includes(host.toLowerCase());
  if (threadId && allowed) return <ImageFrame src={remoteImageSrc(threadId, src)} alt={alt} />;
  const where = hosts.data?.remembered_in === 'thread' ? 'thread' : 'notebook';
  if (!threadId || hosts.data?.allowed === false)
    return (
      <span className="img-blocked" data-locked>
        <Icon name={threadId ? 'lock' : 'image'} size={14} />
        <span>
          {threadId
            ? `An image from ${host} is not loaded: nothing leaves this machine here.`
            : `An image from ${host} is not loaded here.`}{' '}
          <a href={src} target="_blank" rel="noopener noreferrer">
            Open link
          </a>
        </span>
      </span>
    );
  return (
    <span className="img-blocked">
      <Icon name="image" size={14} />
      <span className="img-blocked__text">
        {alt ? <span className="img-blocked__alt">{alt}</span> : null}
        <span>
          Loading it would tell {host} you read this. Remembered for this {where}.
        </span>
      </span>
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        onClick={async () => {
          if (!threadId) return;
          setBusy(true);
          try {
            await allowImageHost(threadId, host.toLowerCase());
          } catch (e) {
            const err = e as { body?: { error?: { title?: string; hint?: string } } };
            notify({
              level: 'error',
              title: err.body?.error?.title ?? `Images from ${host} could not be allowed`,
              body: err.body?.error?.hint ?? 'Try again in a moment.',
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        Load image from {host}
      </button>
    </span>
  );
}

/** Any image in a thread's prose: Markdown images and image parts. */
export function ThreadImage({
  src,
  alt,
  width,
  height,
}: {
  src: string;
  alt?: string | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
}) {
  const label = alt ?? '';
  if (!src) return null;
  if (isLocalSrc(src)) return <ImageFrame src={src} alt={label} width={width} height={height} />;
  return <RemoteImage src={src} alt={label} />;
}
