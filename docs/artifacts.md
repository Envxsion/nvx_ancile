# Artifacts

An artifact is something an answer made for you to view or reuse on its own: a web page, an SVG image, a React component, a Mermaid diagram, a Markdown document, or a program. In the thread it reads as one card; it opens in a panel beside the conversation with its preview, its code, every version the thread made of it, copy, download and full size.

## How an answer makes one

Two forms are recognised, in Claude Code and gateway answers alike (`parseArtifacts` in `packages/contracts/src/artifacts.ts`, shared by Core and the Cockpit):

````
```html artifact id="pricing" title="Pricing table"
<table>…</table>
```
````

```
<antArtifact identifier="pricing" type="text/html" title="Pricing table">…</antArtifact>
```

Languages map to types: `html` → web page, `svg` → image, `jsx`/`tsx` → React, `mermaid` → diagram, `md` → document, anything else → code. `type="…"` overrides. The key is the id, else the title's slug: the same key in a later or regenerated answer is the next version. Gateway models are told the fenced form in `prompts/system/base.md`. Two near misses are taken too: `artifact id=… title=…` on its own line right after a ```html (or any language) fence, and a finished bare ```html block that is a whole HTML document (its first line `<!doctype html>` or `<html>`, ending `</html>`), titled from its `<title>`. A fragment, an unfinished document or a document inside another fence stays an ordinary code block.

## Security

These are nvx_folio's conditions; none may be relaxed without a security review.

- **Opaque origin.** HTML, SVG, React and Mermaid run in `<iframe sandbox="allow-scripts">` on the frame host (`/frame.html`, an empty page). Never `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`. The content is never served from Core: the Cockpit posts it to the frame host once, when that frame (origin `null`) says it is ready, and the host writes it into itself. It is not `srcdoc` because a `srcdoc` frame inherits the Cockpit's own policy, whose `script-src` allows no inline script (docs/desktop.md, Content Security Policy). The host does nothing unless it is a sandboxed frame, and Core sends it with `Content-Security-Policy: sandbox allow-scripts`, so even opened on its own its origin is opaque. `referrerpolicy="no-referrer"`, and an `allow` list that denies camera, microphone, clipboard and other powerful features.
- **Network off.** The document's first `<head>` element is a CSP: `default-src 'none'`, `connect-src 'none'`, `img-src data: blob:`, `frame-src 'none'`, `worker-src 'none'`, `form-action 'none'`, `base-uri 'none'`, inline scripts only. Libraries are inlined (React 18's UMD build, Mermaid's single-file build), never fetched. CSPs only add up, so nothing the artifact writes can loosen it.
- **Allow network, explicitly.** A switch in the panel, behind a one-line risk statement ("It could send what it shows to any https site. Your files and NVX Ancile stay out of reach."). It is recorded per artifact (`core.artifact_settings`, thread and key, with the time) and only adds `https:`: plain `http:`, so `http://127.0.0.1` and Core, stays unreachable.
- **No navigation.** The Cockpit's page allows frames to load the frame host's exact URL and nothing else (`frame-src http://<host>/frame.html`, the header Core and the dev server add; the page's own `<meta>` says `frame-src 'self'`), so no frame can be navigated anywhere else, including an artifact navigating itself (a way out that CSP inside the frame cannot stop). An artifact that navigates itself back to the frame host gets an empty page: the Cockpit fills each frame once. The bootstrap also cancels link clicks and form submits.
- **The frame host's policy is the ceiling.** `/frame.html` carries `FRAME_HOST_CSP`, the widest any document written into it may need (eval for React, WebAssembly and a Blob worker for Python, `https:` for an artifact allowed online). Each document's own policy comes first in its `<head>` and is narrower; policies only add up.
- **A narrow channel back.** The frame may post only `size`, `copy`, `download` and `error` (`ArtifactFrameMessage`), accepted only from that frame's window, with origin `null`, with its nonce, and only when the schema matches. Copy and download are never done for the artifact: they become offers the person accepts with a click.
- **JSX is compiled outside, run inside.** Sucrase rewrites JSX/TSX to JavaScript in the Cockpit (it never runs the code); the result runs only in the sandbox.
- **Residual risk: WebRTC.** Chromium does not apply CSP to WebRTC. The bootstrap removes `RTCPeerConnection` and its relatives before the artifact's code runs; a determined artifact could look for them elsewhere. It still cannot reach Core (WebRTC carries no HTTP) or read anything of the Cockpit.

`tests/e2e/artifacts.spec.ts` proves it: a probe artifact tries fetch (http and https), XHR, a WebSocket, images, CSS images, prefetch, beacons, EventSource, scripts, nested frames, workers, forms, popups, top and self navigation, `localStorage`, cookies and the parent's DOM, against a local server standing in for Core. No request reaches it, with the network off or on, and nothing of the parent is readable; a control request from the page itself does reach it.

## Bundle

Lazy chunks, loaded only when such an artifact opens: Sucrase (about 200 KB), React 18 UMD (about 140 KB, inlined as text), Mermaid 11 single-file build (about 3 MB). Mermaid 12 was not used: its build bundles elkjs 0.9 (EPL-2.0), which the licence script does not allow.
