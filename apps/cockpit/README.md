# NVX Ancile Cockpit

The keyboard-first workspace UI for NVX Ancile: Vite 7, React 19, TanStack Router and Query, Zustand, Radix primitives, cmdk and Motion. It is styled with plain CSS on the APERTURE tokens (`@nvx/aperture`). There is no Tailwind and no component kit, so nothing looks like a framework default.

```bash
pnpm --filter @nvx/ancile-cockpit dev        # http://localhost:7701, proxies /api to Core on :7700
pnpm --filter @nvx/ancile-cockpit test       # unit + component tests (jsdom)
pnpm --filter @nvx/ancile-cockpit test:boot  # the fast boot suite
pnpm --filter @nvx/ancile-cockpit build      # typecheck, then build to dist/ (Core serves it)
```

## Demo data

You don't need the backend to review the design. When Core isn't reachable (a network failure, or the dev proxy answering 502/504), every hook in `src/lib/data.ts` returns fixtures from `src/fixtures/demo.ts`. The status bar then says **Demo data**. Real API errors are never masked; only "nothing is listening" falls back.

The fixtures are a notebook about a depot battery retrofit. Its suppliers, surveys and figures are fictional. It includes:
- a thread with three answer versions
- citations, and claims in each of the three verdict states
- a model fallback
- an approval that is waiting on you, with the mark in its *ask* state
- health, compute, grants, memory and log data for the admin screens

Sending a message in demo mode shows it on screen with an Undo toast and says plainly that nothing was sent.

## Layout

```
titlebar 44px   mark (live state) · NVX Ancile · breadcrumb · palette · theme · notifications
rail 248px      notebooks → their threads, loose threads, admin       ([ to toggle)
main            raised sheet (--lift) set into the chrome frame (--chrome)
drawer 384px    Sources · Tree · Why · Evidence                       (] to toggle)
status 30px     model · context meter · GPU node · demo flag · decisions waiting · health
```

At 1100 px and below, the drawer becomes a sheet over a scrim. At 820 px and below, the rail becomes an overlay.

## Component inventory

| Area | Files | Notes |
|---|---|---|
| Shell | `app/AppShell.tsx`, `shell/{Titlebar,Rail,Drawer,StatusBar}.tsx` | Grid frame, global bindings, overlays mounted once |
| Thread | `thread/{ThreadView,Message,MessageActions,Composer,Claims}.tsx` | Scroll restored by message id; hover/focus actions; sibling switcher; fallback footnote; claim underlines with icons |
| Drawer panels | `drawer/{SourcesPanel,TreePanel,WhyPanel,EvidencePanel}.tsx` | Context levels; compact branch outline (h/j/k/l when focused); "why" chain; evidence for and against |
| Palette | `palette/Palette.tsx` | `>` commands, `@` models, `#` notebooks; Backspace on an empty query leaves the scope |
| Keys | `keys/{registry,dispatch,ShortcutsOverlay}.ts(x)` | One table of bindings; sequences; paused while typing or under a dialog |
| Trust | `approvals/ApprovalDialog.tsx`, `compute/ConfirmationChain.tsx` | Pattern suggestions narrowest-first and editable; critical actions can't be remembered; four-link chain with failure and fix |
| Feedback | `notify/{Toaster,Center}.tsx`, `state/notify.ts` | At most three toasts, hover pauses, undo; centre keeps history (`g i`) |
| Primitives | `ui/{Icon,primitives,ErrorState}.tsx` | Line icons on a 16 grid; Kbd/Tip read the keymap; chalk-wipe skeletons; ApiError rendering with "Copy debug info" |
| Screens | `routes/{Home,Thread,Notebook,Setup}.tsx`, `routes/admin/*` | Six-step first run; 13 admin sections |
| Plumbing | `lib/{api,sse,query,data,format,types}.ts` | traceparent on every call; resumable SSE (`?after=seq`, jittered backoff); IndexedDB-persisted query cache |

## Keymap

Single keys never fire while you type or while a dialog is open. `mod` means ⌘ on macOS and Ctrl elsewhere. Press `?` in the app for the same table: it's generated from `src/keys/registry.ts`.

| Keys | Action |
|---|---|
| `mod+k` | Command palette |
| `/` | Search |
| `?` | Shortcuts |
| `Esc` | Close the top layer, or leave the composer |
| `[` / `]` | Toggle sidebar / side panel |
| `mod+shift+o` | New thread |
| `m` | Change model |
| `mod+shift+l` | Switch theme (system → dark → light) |
| `g n` `g t` `g b` `g a` `g l` `g i` | Notebooks, threads, branch tree, admin, logs, notifications |
| `j` / `k` / `Enter` | Move and open in lists |
| `i` | Back to the composer |
| `e` `r` `b` `f` `w` `c` `s` | Edit, regenerate, branch, fact-check, why, copy, sources (on the message you're on) |
| `alt+[` / `alt+]` | Previous / next version of a message |
| `h` `j` `k` `l` | Walk the branch tree when it has focus |

The boot suite fails if two bindings that can be live at the same time share a key or a sequence prefix.

## Design rules this app keeps

- Signal violet is spent only on focus, the primary action, live state and the active path. It's never decoration and never a status colour.
- Depth comes from the lift ladder and hairlines. Only raised objects (popovers, dialogs, toasts) cast a shadow.
- Archivo for words, Martian Mono only for data: ids, costs, counts, times, patterns.
- Copy is sentence case, plain and specific, in British spelling. Errors say what happened and what to do, and never apologise.
- Claim states are never shown by colour alone.
- Reduced motion is honoured, and every control is reachable by keyboard.
- The theme follows the OS until you choose, and the inline boot script prevents a flash of the wrong ground. The boot test checks that it matches `@nvx/aperture`.

## What's next

`TODO(phase-N)` markers show where the API lands:
- Phase 2: send, stream, regenerate and edit; approvals POST; onboarding writes config.
- Phase 3: sources upload, the source viewer, @-mentions resolved server-side.
- Phase 4: branch, compare, merge; memory editor; live fact-check and the "why" view.
- Phase 5: diagnostics, replay, compute actions over the Controller's SSE.
