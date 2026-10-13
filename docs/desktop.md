# The desktop app

NVX Ancile for Windows, macOS and Linux: one installer, one window. It runs every service for you (the database, Core, sources and search) on your own machine, so there is no Node, Python or Docker to install.

## Install

Download the installer for your system from the [releases](https://github.com/Envxsion/nvx_ancile/releases):

| System | File | Notes |
|---|---|---|
| Windows 10 and 11 | `NVX Ancile_<version>_x64-setup.exe` | Installs for your account only, no administrator rights needed. An `.msi` is there too for managed machines. |
| macOS 13 and later | `NVX Ancile_<version>_aarch64.dmg` | Drag it to Applications. |
| Linux | `.AppImage` or `.deb` | The AppImage runs anywhere: make it executable and open it. |

The first start takes about half a minute while the database is created. After that, NVX Ancile is ready in a few seconds. The first time you add a source, the search models (about 130 MB) are downloaded once.

## Where your things are

| What | Windows | macOS | Linux |
|---|---|---|---|
| Your data: database, memory, sources, settings | `%APPDATA%\NVX Ancile` | `~/Library/Application Support/NVX Ancile` | `~/.local/share/NVX Ancile` |
| Logs, one file per service | the `logs` folder inside it | same | same |
| Secrets (the key that protects your provider keys, the services' tokens, the database password) | Windows Credential Manager, under "NVX Ancile" | Keychain | the Secret Service (GNOME Keyring, KWallet) |

The secrets are made the first time NVX Ancile starts and never written to a file. If you delete them, your data is still there, but the database will not open with a new password and any provider keys you saved must be entered again. Keep them, or back up the data folder together with them.

The tray icon shows whether NVX Ancile is ready, opens the logs folder, and quits. Closing the window quits too: every service stops, the database last and cleanly.

## Updates and your data

**A backup before every update.** Before anything changes the shape of the database, NVX Ancile backs it up: on start, Core's preflight (`node dist/main.js --preflight`) looks for migrations this build would apply, to Core's schema, Knowledge's or the Controller's, and takes a backup with `pg_dump` from the Postgres pg0 installed, before Knowledge migrates and before Core starts. A brand-new, empty database needs none. The newest five are kept in the `backups` folder inside your data folder (`ancile-<date>-<time>-before-migration.dump`, with a `.json` beside it saying which NVX Ancile took it and at which schema), with up to two safety copies taken before a restore or before an older version is installed. Each migration then runs in one transaction: one that fails half way is undone, and the start-up screen says so.

**When something stops the update,** NVX Ancile starts only Core, which shows a start-up screen in the window instead of the app, and nothing touches the database:

| What happened | What you can do |
|---|---|
| The backup failed | Try again, or update without a backup if you keep your own copy (once). |
| The disk is too full (`Not enough free disk space: needs ~X, Y free on drive Z`) | Free space, then Try again. |
| An update failed and was undone | Try again, or restore the last backup. |
| Your data was updated by a newer NVX Ancile | Restore the backup taken before that update, or install the newer version again. |

The last one happens when an older version starts on data a newer one updated: an update was rolled back, or an older installer was run. NVX Ancile never runs a migration backwards. It knows which schema it expects (the newest migration it carries, Knowledge's newest revision, and the Controller's migrations) and refuses one it has never heard of. Restoring replaces your data with the backup, after taking a safety backup of what is there now; then every service starts again. Disk space is checked the same way before a source is added.

**Installing an older version.** When nvx.sh offers a build older than the one installed (a release was pulled), the tray says so first ("NVX Ancile x.y.z is older than this version: read before installing"). The second click backs up your data, then installs; if the backup fails, nothing is installed. That older version then offers the backup from before your last update.

**Restoring by hand:** see [the restore runbook](runbooks/restore-backup.md).

**When Pro ends,** what Pro made (context packs, insights, fleet settings, sync state) stays in its own tables, readable and never deleted: Admin → Licence offers **Export Pro data** (`GET /api/v1/system/pro-data/export`, one JSON file) in the free edition and with a lapsed licence, and turning Pro on again brings it all back.

**A wrong clock.** Licence checks allow ten minutes of clock skew either way. When this computer's clock is further out than that, from a clock set ahead (which would otherwise end a licence early) or one clearly behind, the time nvx.sh gave at the last check, moved on by the time since, is used instead.

**Sleep.** When the computer wakes, Core notices the gap in its heartbeat: runs it was working on keep their place (their leases are renewed before anything else looks at them), runs left by a worker that is gone resume, the Claude bridge is checked and reconnected if it stopped answering, and the services are checked at once.

## Licence links

An `ancile://activate?key=NVX-XXXX-XXXX-XXXX` link (from your nvx.sh account) opens Admin → Licence with the key filled in. It never activates by itself: you press the button.

## Links

A web link (`http`, `https`) or an email link (`mailto`) in the Cockpit opens in your system browser or mail client, never inside the app window. Links to NVX Ancile pages open in the app. Any other scheme (`file`, `javascript`, a custom protocol) does nothing. The shell enforces this in Rust (`src-tauri/src/links.rs`, through the webview's navigation and new-window handlers, opening links with `tauri-plugin-opener` from Rust); the Cockpit still has no native APIs, and the content security policy is unchanged.

## Keyboard

Inside the desktop app there is no browser around NVX Ancile, so every shortcut reaches it, including ones a browser keeps for itself (Ctrl+N, Ctrl+T, Ctrl+W).

## Uninstall

- **Windows:** Settings → Apps → NVX Ancile → Uninstall.
- **macOS:** move NVX Ancile from Applications to the Bin.
- **Linux:** delete the AppImage, or `sudo apt remove nvx-ancile`.

Uninstalling keeps your data. To remove it too, delete the data folder above and the "NVX Ancile" entries in your keychain.

## Building it yourself

You need what a development checkout needs (Node 22.12+, pnpm, uv) plus Rust 1.88 or later. On Linux, also `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libsecret-1-dev`.

```bash
pnpm install
pnpm --filter @nvx/ancile-desktop sidecars   # build every service into apps/desktop/src-tauri/sidecars
pnpm --filter @nvx/ancile-desktop tauri build
```

The installers land in `apps/desktop/src-tauri/target/release/bundle/`.

What `sidecars` builds, and roughly how big each part is on Windows:

| Part | What it is | Size |
|---|---|---|
| `pg0` | Embedded Postgres 18 with pgvector, one binary | 57 MB |
| `node` | The Node runtime Core runs on | 80 MB |
| `core` | Core, bundled with esbuild, with its production dependencies (flat, without type definitions or source maps) | 51 MB |
| `cockpit` | The Cockpit's production build, served by Core (no source maps in a Pro build) | 4 MB |
| `controller` | The Controller (GPU nodes) as one esbuild bundle with its migrations; it migrates its own schema at start | 1 MB |
| `lab` | The agent engine (opencode, unchanged) compiled to one binary by `scripts/build-lab.ts` with a pinned Bun from npm | 138 MB |
| `knowledge` | A standalone CPython 3.12 with the locked dependencies and the Knowledge service | 371 MB |
| `share` | Configuration, prompts, the memory template and the database setup | under 1 MB |

Add `--with-models` to include the search models, so the first source needs no download. Rebuild one part with, for example, `pnpm --filter @nvx/ancile-desktop sidecars core`.

Core is not a Node single-executable application: that format takes one CommonJS file and cannot load Core's WebAssembly policy engine from disk, so the app ships the Node runtime next to an esbuild bundle instead. The lab and the Controller are optional: if either is missing or fails to start, the rest of the app still starts.

The lab runs commands a model chose, so the desktop gives it an environment built from nothing, as `agentEnv()` does in development: system basics, its own server password, a gateway token that can only ask Core for model calls, and its injected config. It never sees the service token, the database or any provider key (`lab_env_for` in `supervisor.rs`, with a test).

The Controller starts with RunPod and no key, which means sample nodes until you choose **Connect RunPod** in Admin → Compute.

### Trying a build without touching your workspace

`cargo run` in `apps/desktop/src-tauri` starts a debug build. Three variables keep it apart from your everyday data:

```bash
ANCILE_DESKTOP_DATA_DIR=/tmp/ancile-try \
ANCILE_DESKTOP_PORT_BASE=18700 \
ANCILE_DESKTOP_PROFILE=try \
cargo run
```

The profile name keeps its keychain entries separate too. By default the app uses ports from 17700, away from a development stack (7700) and the test stack (7800).

## Content Security Policy

The app has two kinds of page, and each has its own policy.

**The start-up screen** (`apps/desktop/splash`) is served by Tauri. Its policy is in `tauri.conf.json` (`app.security.csp`): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. Tauri adds the hashes of the page's inline script and style when it builds, and the `ipc:` sources (`http://ipc.localhost` on Windows) are how the screen hears the supervisor's status events. It is the only page with a capability.

**The Cockpit** is served by Core on `http://127.0.0.1:<port>` (17700, or a free port when that is taken); the window moves there when the services are up. Core is the Cockpit's own origin, so `'self'` covers every request it makes: REST, the event streams (SSE) and, in development, the dev server's socket. The Cockpit has no Tauri capability and makes no IPC call, so its policy has no `ipc:`. The policy lives in `packages/contracts/src/csp.ts` and reaches the page twice; policies only ever add up, so each part can only narrow the other:

- A `<meta>` in every page the build writes (`vite.config.ts` fills it, with the hash of each inline script):

  ```
  default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
  worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

- A header from Core (and from the dev server), for what a `<meta>` cannot say: `frame-ancestors 'none'; frame-src http://<host>/frame.html`, the frame host's exact URL at the address the browser used. The frame host itself is sent with `sandbox allow-scripts`.

The exceptions, and why each is there:

| Directive | Exception | Why |
|---|---|---|
| `script-src` | `'sha256-…'` | The theme script in `<head>` (`BOOT_SCRIPT`), so the first paint has the right theme; the dev server's React refresh preamble in development. Hashes are computed at build time, so a changed script that is not rebuilt does not run. No `'unsafe-inline'`, no `'unsafe-eval'` (zod runs jitless for this, `src/lib/strict.ts`). |
| `style-src` | `'unsafe-inline'` | `<style>` elements made at run time: a person's own CSS (Settings → Advanced), Radix's scroll lock, the dev server's CSS. Styles cannot fetch past `img-src` and `font-src`. |
| `img-src` | `data: blob:` | Pictures Python and artifacts draw (`data:`) and files offered for download (`blob:`). A remote picture the person chose to load comes through Core's image proxy, so no remote host is allowed (docs/images.md). |
| `font-src` | `data:` | Fonts pdf.js embeds from a PDF. |
| `frame-src` | `'self'`, narrowed by the header to `/frame.html` | Artifacts and the Python sandbox (below). |

**The frame host.** Artifacts and the Python sandbox used to be `srcdoc` frames. A `srcdoc` frame (or a `data:` or `blob:` one) inherits its parent's policy, so with the strict `script-src` above, no artifact could run a script. They now load `/frame.html`, an empty page with its own policy (`FRAME_HOST_CSP`, the widest any of them needs), and the Cockpit posts the document to it once; the host writes it into itself. The content still never comes from Core, the frame is still `sandbox="allow-scripts"` with an opaque origin, each document still carries its own narrower policy first, and no frame can be navigated anywhere but the frame host. docs/artifacts.md has the details.

Checked by `tests/e2e/csp.spec.ts` (every route, no violation, an injected inline script does not run), the artifact and Python sandbox suites (which now run under the policy), `apps/cockpit/test/csp.test.ts` and `services/core/test/http/csp.test.ts`.

## Signing and updates

Release builds are made by `.github/workflows/release.yml` on Windows, macOS and Linux. Signing and auto-update turn on only when their secrets are set in the repository's settings; none is in the code.

| Secret | For |
|---|---|
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Signing the Windows installers (a base64 `.pfx`) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Signing and notarising the macOS app |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `UPDATER_PUBKEY` | Signed update bundles; turns the updater on in the build |
| `NVX_RELEASE_TOKEN` | Publishing each release on nvx.sh so the updater offers it (the product's release token) |
| `PRO_REPO_TOKEN` | Building the Pro edition (the private `pro/` submodule). Pro builds are never published to GitHub. |

Make the update key pair once with `pnpm --filter @nvx/ancile-desktop tauri signer generate`, keep the private key in the secret store, and put the public key in `UPDATER_PUBKEY`.

### How updates reach people

Once its services are up, then every 6 hours, and whenever "Check for updates" is chosen in the tray menu, the app asks
`https://ancile.nvx.sh/api/updates/{target}/{arch}/{version}?edition=free|pro&installed=free|pro&channel=stable|beta`.
`installed` is this build (the Pro edition carries Pro beside Core). `edition` asks for Pro when Pro is installed or a licence token is held. The channel is a setting (`PUT /api/v1/system/updates {"channel":"beta"}`, stable by default). The token, when one is held, goes in the Authorization header: Core hands the host `license.token`, or else `license.last_token`, the last token this install was given, which survives a revocation (only "Move to another computer" clears it) because nvx.sh measures the 90 days from it and holds a Pro install that sends no token as a fresh reinstall.

Pro arrives and leaves only by update; there is no separate Pro download to install over the free edition.

- **Pro arrives.** The free edition takes a key in Admin → Licence: it claims a seat with nvx.sh and keeps the token (nothing is unlocked in the free build). The next check is answered with the Pro build of the same version or newer (`"edition": "pro"`); the tray line reads "Pro is ready. Install", and one click installs it and restarts.
- **Pro lapses.** For under 90 days after a licence ends or is paused, or when the seat moved, nvx.sh answers 204: Pro stays installed, and its features stop when the held token expires. Admin → Licence offers renewal ("Pro licence lapsed: renew to keep updates").
- **Pro leaves.** After 90 days, on revocation, or with an unreadable token, nvx.sh answers with the newest free build and `"downgrade": true`. The tray line reads "Pro ended: switching to the free edition (your data stays)" and one click installs it. Nothing is lost: Pro's tables stay on disk (migrations only add), readable and exportable from Admin → Licence (Export Pro data), Pro's screens give way to their upsell cards, and turning Pro on again brings everything back as it was.
- **A 503, or no answer:** the app tries again at the next check.

Any 200 from nvx.sh is an offer (204 means nothing to install), so the other edition of the same version, or an older build after a release was pulled, is offered too; an older one is warned about and backed up first (see Updates and your data). What the tray is offering is reported to Core (`POST /internal/v1/desktop/update-offer` with `older` for a rollback, service token; `DELETE` when there is nothing), and Admin → Licence reads it from `GET /api/v1/system/update-offer` to say Pro is ready, or that Pro ended. Nothing installs on its own: every install is a click in the tray menu. A plain update reads "Install NVX Ancile x.y.z and restart".

To reinstall Pro on a new computer, the Pro installer is at https://ancile.nvx.sh/pro/download (linked at the foot of Admin → Licence).

Publishing: a version tag builds the installers. The free edition becomes a public asset of the GitHub release, then `apps/desktop/scripts/publish-release.mjs --github-release <tag>` tells nvx.sh about it (`POST /api/releases/publish` with `external_url`), so the updater can offer it. One updater bundle per platform is published: the Windows NSIS setup, the macOS `.app.tar.gz`, the Linux AppImage. A version is never replaced: publishing a different build under a published version fails the job. The Pro edition is never put on GitHub: `publish-release.mjs --edition pro --upload` sends it to nvx.sh's private storage (Cloudflare R2) through a one-hour upload link and then publishes it, and the updater gets a 15-minute download link only for a current licence. Until R2 is set up the script skips Pro rather than use smaller fallback storage.

Which edition a build is: `NVX_TIER=free` at build time makes a free build even when `pro/` is on disk. Core gets no `pro.js` and the Cockpit build leaves Pro's screens out entirely. Without it, and with `pro/` present, both carry Pro, and the Cockpit ships without source maps so Pro's source is never in an installer.
