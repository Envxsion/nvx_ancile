/**
 * ------------------------------------------------------------------
 *  Title    |  The artifact document
 *  Ref      |  docs/artifacts.md (Security)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Build the one HTML document an artifact runs in: its
 *           |  content, the libraries it needs inlined (nothing is
 *           |  fetched), a Content-Security-Policy with the network
 *           |  off unless the person allowed it, and a small bootstrap
 *           |  that reports its height and turns copy and download
 *           |  into requests the Cockpit shows as offers.
 *  How      |  The document goes into <iframe sandbox="allow-scripts"
 *           |  srcdoc>: an opaque origin, so it cannot read the
 *           |  Cockpit's storage, cookies or DOM, and cannot reach
 *           |  Core (CSP connect-src 'none'; with network allowed,
 *           |  https: only, never http://localhost). The CSP meta is
 *           |  the first thing in <head>; CSPs only ever add up, so
 *           |  nothing the artifact writes can loosen it.
 *  Note     |  WebRTC is outside CSP in Chromium: the bootstrap
 *           |  removes it before the artifact's code runs (best
 *           |  effort, documented in docs/artifacts.md).
 * ------------------------------------------------------------------
 */

import type { ArtifactType } from '@nvx/contracts';
import { ARTIFACT_CHANNEL } from '@nvx/contracts/artifacts';

/** The policy for one artifact. `scripts`: whether its own inline scripts may run. */
export function artifactCsp(type: ArtifactType, allowNetwork: boolean): string {
  const net = allowNetwork ? ' https:' : '';
  const scripts =
    type === 'svg'
      ? // The bootstrap is the only script in an SVG artifact's document.
        "'unsafe-inline'"
      : type === 'react'
        ? "'unsafe-inline' 'unsafe-eval'"
        : "'unsafe-inline'";
  return [
    "default-src 'none'",
    `script-src ${scripts}${net}`,
    `style-src 'unsafe-inline'${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    `media-src data: blob:${net}`,
    `connect-src ${allowNetwork ? 'https:' : "'none'"}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Runs first inside the frame. Self-contained (it is serialised with
 * toString), so it may not use anything from this module.
 */
function bootstrap(channel: string, nonce: string) {
  const send = (msg: Record<string, unknown>) => {
    try {
      window.parent.postMessage({ channel, nonce, ...msg }, '*');
    } catch {
      // The parent went away; nothing to tell.
    }
  };
  // WebRTC is not covered by CSP: take it away before the artifact's code runs.
  for (const k of [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCDataChannel',
    'RTCSessionDescription',
  ]) {
    try {
      Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false });
    } catch {
      // Already gone.
    }
  }
  // Links never navigate the frame (that would be a way out without fetch).
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;
      e.preventDefault();
    },
    true,
  );
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  let last = -1;
  const measure = () => {
    const h = Math.ceil(
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    );
    if (Math.abs(h - last) < 2) return;
    last = h;
    send({ kind: 'size', height: h });
  };
  new ResizeObserver(measure).observe(document.documentElement);
  window.addEventListener('load', measure);
  window.addEventListener('error', (e) => send({ kind: 'error', message: String(e.message).slice(0, 2000) }));
  (window as unknown as { ancile: unknown }).ancile = Object.freeze({
    copy: (text: string) => send({ kind: 'copy', text: String(text).slice(0, 1_000_000) }),
    download: (name: string, mime: string, data: string) =>
      send({ kind: 'download', name: String(name), mime: String(mime), data: String(data) }),
  });
}

/** Text safe inside a <script> element: no "</script", no "<!--". */
export function scriptText(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** JSON safe inside <script type="application/json">. */
export function jsonText(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export interface FrameTheme {
  scheme: 'dark' | 'light';
  bg: string;
  fg: string;
  mute: string;
  edge: string;
  font: string;
  mono: string;
}

export interface Runtime {
  react?: { react: string; reactDom: string };
  mermaid?: string;
}

export interface DocInput {
  type: ArtifactType;
  content: string;
  nonce: string;
  allowNetwork: boolean;
  theme: FrameTheme;
  /** react: the content compiled to plain JavaScript (sucrase). */
  compiled?: string;
  runtime?: Runtime;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function baseStyle(t: FrameTheme, centred: boolean): string {
  return `:root{color-scheme:${t.scheme}}html,body{margin:0}body{background:${t.bg};color:${t.fg};font:14px/1.5 ${t.font};${
    centred ? 'display:flex;align-items:center;justify-content:center;min-height:100vh;' : ''
  }}#ancile-error{font:12px/1.5 ${t.mono};color:${t.fg};border:1px solid ${t.edge};border-radius:8px;padding:12px;margin:16px;white-space:pre-wrap}`;
}

/** The whole srcdoc for one artifact. */
export function buildArtifactDocument(i: DocInput): string {
  const csp = artifactCsp(i.type, i.allowNetwork);
  const boot = `(${bootstrap.toString()})(${JSON.stringify(ARTIFACT_CHANNEL)},${JSON.stringify(i.nonce)});`;
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">`;
  const start = (style: string) =>
    `<!doctype html><html><head>${head}<style>${style}</style><script>${scriptText(boot)}</script>`;

  switch (i.type) {
    case 'html': {
      // The artifact's own document follows our head: a second <html>/<head> is folded into ours by the parser.
      const body = i.content;
      return `${start(baseStyle(i.theme, false))}</head><body>${body}</body></html>`;
    }
    case 'svg':
      return `${start(`${baseStyle(i.theme, true)}svg{max-width:100%;height:auto}`)}</head><body>${i.content}</body></html>`;
    case 'mermaid': {
      const lib = i.runtime?.mermaid ?? '';
      const run = `(function(){var src=JSON.parse(document.getElementById('ancile-src').textContent);try{mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:${JSON.stringify(
        i.theme.scheme === 'dark' ? 'dark' : 'default',
      )},fontFamily:${JSON.stringify(i.theme.font)}});mermaid.render('ancile-diagram',src).then(function(r){document.getElementById('ancile-root').innerHTML=r.svg;}).catch(function(e){var p=document.createElement('pre');p.id='ancile-error';p.textContent='This diagram could not be drawn: '+(e&&e.message||e);document.body.appendChild(p);});}catch(e){var p=document.createElement('pre');p.id='ancile-error';p.textContent=String(e&&e.message||e);document.body.appendChild(p);}})();`;
      return `${start(`${baseStyle(i.theme, true)}#ancile-root{width:100%;padding:24px;box-sizing:border-box}#ancile-root svg{display:block;width:100%;max-width:100%!important;height:auto;max-height:calc(100vh - 48px);margin:auto}`)}<script>${scriptText(
        lib,
      )}</script></head><body><div id="ancile-root"></div><script type="application/json" id="ancile-src">${jsonText(
        i.content,
      )}</script><script>${scriptText(run)}</script></body></html>`;
    }
    case 'react': {
      const r = i.runtime?.react;
      const run = `(function(){var code=JSON.parse(document.getElementById('ancile-src').textContent);var mods={react:React,'react-dom':ReactDOM,'react-dom/client':ReactDOM};var module={exports:{}};function require(n){if(mods[n])return mods[n];throw new Error('This artifact imports '+n+', which is not available here. Only react can be imported.');}function show(e){var p=document.createElement('pre');p.id='ancile-error';p.textContent=String(e&&e.message||e);document.body.appendChild(p);}try{new Function('React','ReactDOM','require','module','exports',code)(React,ReactDOM,require,module,module.exports);var C=module.exports.default||module.exports.App||Object.values(module.exports).find(function(v){return typeof v==='function'});if(!C)throw new Error('The component has no default export.');ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(C));}catch(e){show(e)}})();`;
      return `${start(baseStyle(i.theme, false))}<script>${scriptText(r?.react ?? '')}</script><script>${scriptText(
        r?.reactDom ?? '',
      )}</script></head><body><div id="root"></div><script type="application/json" id="ancile-src">${jsonText(
        i.compiled ?? '',
      )}</script><script>${scriptText(run)}</script></body></html>`;
    }
    default:
      // markdown and code are drawn by the Cockpit itself, never in a frame.
      return `${start(baseStyle(i.theme, false))}</head><body><pre>${escapeHtml(i.content)}</pre></body></html>`;
  }
}

/** A fresh random nonce per frame, to tell frames apart. */
export function newNonce(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
