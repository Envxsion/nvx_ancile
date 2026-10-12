/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact sandbox testbed
 *  Ref      |  tests/e2e/artifacts.spec.ts · docs/artifacts.md
 *  ID       |  cockpit (dev server only, never built)
 * ------------------------------------------------------------------
 *  Purpose  |  Mount the real ArtifactFrame with a probe artifact that
 *           |  tries every way out it can think of (fetch, XHR, a
 *           |  WebSocket, images, prefetch, beacons, nested frames,
 *           |  navigation, storage, cookies, the parent's DOM) and
 *           |  reports what happened through the one channel it has:
 *           |  a copy offer. The e2e test reads the report and counts
 *           |  hits on a local server standing in for Core.
 *  How      |  ?port=N the local server; ?net=1 with the network
 *           |  allowed; ?type=react|svg|mermaid to check those types
 *           |  draw. The parent first sets a cookie and localStorage
 *           |  so the probe can try to read them.
 * ------------------------------------------------------------------
 */

import { createRoot } from 'react-dom/client';
import { ArtifactFrame, type ArtifactOffer } from '../src/artifacts/ArtifactFrame';

const q = new URLSearchParams(location.search);
const port = q.get('port') ?? '9';
const net = q.get('net') === '1';
const type = (q.get('type') ?? 'html') as 'html' | 'react' | 'svg' | 'mermaid';
const target = `http://127.0.0.1:${port}`;

try {
  localStorage.setItem('ancile-secret', 'parent-storage-secret');
  document.cookie = 'ancile_cookie=parent-cookie-secret; path=/';
} catch {
  // A browser without storage: the probe reports what it can.
}

const PROBE = `<p id="state">probing</p>
<script>
(async () => {
  const T = ${JSON.stringify(target)};
  const r = {};
  const settle = (p, ms = 1500) => Promise.race([p, new Promise((res) => setTimeout(() => res('timeout'), ms))]);
  const attempt = async (k, fn) => { try { r[k] = await settle(fn()); } catch (e) { r[k] = 'blocked: ' + (e && e.name || e); } };
  await attempt('fetch', async () => { const x = await fetch(T + '/hit?k=fetch', { mode: 'no-cors' }); return 'reached ' + x.type; });
  await attempt('fetch_https', async () => { await fetch('https://127.0.0.1:' + ${JSON.stringify(port)} + '/hit?k=https', { mode: 'no-cors' }); return 'reached'; });
  await attempt('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', T + '/hit?k=xhr'); x.onload = () => res('reached'); x.onerror = () => rej(new Error('error')); x.send(); }));
  await attempt('websocket', () => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:' + ${JSON.stringify(port)} + '/hit?k=ws'); w.onopen = () => res('reached'); w.onerror = () => rej(new Error('error')); }));
  await attempt('image', () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => rej(new Error('error')); i.src = T + '/hit?k=img'; }));
  await attempt('css_image', async () => { const d = document.createElement('div'); d.style.backgroundImage = 'url(' + T + '/hit?k=css)'; document.body.appendChild(d); getComputedStyle(d).backgroundImage; await new Promise((s) => setTimeout(s, 300)); return 'tried'; });
  await attempt('prefetch', async () => { const l = document.createElement('link'); l.rel = 'prefetch'; l.href = T + '/hit?k=prefetch'; document.head.appendChild(l); await new Promise((s) => setTimeout(s, 300)); return 'tried'; });
  await attempt('beacon', async () => navigator.sendBeacon(T + '/hit?k=beacon', 'x') ? 'queued' : 'refused');
  await attempt('eventsource', () => new Promise((res, rej) => { const e = new EventSource(T + '/hit?k=sse'); e.onopen = () => res('reached'); e.onerror = () => { e.close(); rej(new Error('error')); }; }));
  await attempt('script', () => new Promise((res, rej) => { const s = document.createElement('script'); s.src = T + '/hit?k=script'; s.onload = () => res('reached'); s.onerror = () => rej(new Error('error')); document.head.appendChild(s); }));
  await attempt('nested_frame', async () => { const f = document.createElement('iframe'); f.src = T + '/hit?k=frame'; document.body.appendChild(f); await new Promise((s) => setTimeout(s, 400)); return 'tried'; });
  await attempt('worker', async () => { new Worker(T + '/hit?k=worker'); await new Promise((s) => setTimeout(s, 300)); return 'tried'; });
  await attempt('rtc', async () => (typeof RTCPeerConnection === 'undefined' ? 'absent' : 'present'));
  await attempt('local_storage', async () => 'read: ' + localStorage.getItem('ancile-secret'));
  await attempt('cookie', async () => 'read: ' + document.cookie);
  await attempt('parent_dom', async () => 'read: ' + parent.document.title);
  await attempt('parent_storage', async () => 'read: ' + parent.localStorage.getItem('ancile-secret'));
  await attempt('top_navigation', async () => { top.location.href = T + '/hit?k=top'; return 'navigated'; });
  await attempt('popup', async () => (window.open(T + '/hit?k=popup') ? 'opened' : 'blocked: null'));
  await attempt('form', async () => { const f = document.createElement('form'); f.action = T + '/hit?k=form'; f.method = 'post'; document.body.appendChild(f); f.submit(); await new Promise((s) => setTimeout(s, 300)); return 'tried'; });
  await attempt('origin', async () => 'origin: ' + self.origin);
  document.getElementById('state').textContent = 'done';
  window.ancile.copy(JSON.stringify(r));
  // Last, a way out without fetch: navigating this frame itself.
  setTimeout(() => { location.href = T + '/hit?k=self_navigation'; }, 300);
})();
</script>`;

const SAMPLES: Record<string, string> = {
  react:
    'import { useState } from \'react\';\nexport default function App() {\n  const [n, setN] = useState(2);\n  return <button id="b" onClick={() => setN(n + 1)}>Count {n}</button>;\n}',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="currentColor"/></svg>',
  mermaid: 'graph TD; A[Question] --> B[Answer]',
};

function Bed() {
  const onOffer = (o: ArtifactOffer) => {
    if (o.kind !== 'copy') return;
    const out = document.createElement('pre');
    out.id = 'report';
    out.textContent = o.text;
    document.body.appendChild(out);
  };
  return (
    <div style={{ width: 640, height: 420 }}>
      <ArtifactFrame
        type={type}
        content={type === 'html' ? PROBE : (SAMPLES[type] ?? '')}
        title="Probe"
        allowNetwork={net}
        onOffer={onOffer}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Bed />);
