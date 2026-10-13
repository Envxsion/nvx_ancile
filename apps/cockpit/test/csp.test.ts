/**
 * The Cockpit's Content Security Policy (packages/contracts/src/csp.ts):
 * strict for the window, the frame host's page carries exactly its own
 * policy, and a frame is filled once, only when its own host asks.
 */
import { readFileSync } from 'node:fs';
import { cockpitCsp, FRAME_HOST_CHANNEL, FRAME_HOST_CSP } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedFrame } from '../src/lib/frameHost';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the Cockpit policy', () => {
  it('runs only its own scripts and the hashed inline ones, and talks only to its origin', () => {
    const csp = cockpitCsp(['sha256-abc=']);
    const script = csp.split('; ').find((d) => d.startsWith('script-src'));
    expect(script).toBe("script-src 'self' 'sha256-abc='");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('index.html has its policy <meta> before the inline theme script, for the build to fill', () => {
    const html = read('../index.html');
    const meta = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(0);
    expect(meta).toBeLessThan(html.indexOf('<script>'));
  });

  it('the frame host page carries exactly FRAME_HOST_CSP', () => {
    const html = read('../public/frame.html');
    const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
    expect(m?.[1]).toBe(FRAME_HOST_CSP);
  });
});

describe('feeding a frame', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function frameWithWindow() {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const win = frame.contentWindow as Window;
    const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    return { frame, win, post };
  }
  const ready = (
    source: Window,
    origin = 'null',
    data: unknown = { channel: FRAME_HOST_CHANNEL, ready: true },
  ) => window.dispatchEvent(new MessageEvent('message', { source, origin, data }));

  it('sends the document once, when its own frame at an opaque origin says it is ready', () => {
    const { frame, win, post } = frameWithWindow();
    const stop = feedFrame(frame, '<p>doc</p>');
    ready(win, 'http://evil.example');
    ready(window);
    ready(win, 'null', { channel: 'other', ready: true });
    expect(post).not.toHaveBeenCalled();
    ready(win);
    ready(win);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ channel: FRAME_HOST_CHANNEL, doc: '<p>doc</p>' }, '*');
    stop();
  });

  it('after cleanup a ready frame gets nothing', () => {
    const { frame, win, post } = frameWithWindow();
    feedFrame(frame, 'x')();
    ready(win);
    expect(post).not.toHaveBeenCalled();
  });
});
