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

## Licence links

An `ancile://activate?key=NVX-XXXX-XXXX-XXXX` link (from your nvx.sh account) opens Admin → Licence with the key filled in. It never activates by itself: you press the button.

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
| `core` | Core, bundled with esbuild, with its production dependencies (flat, without type definitions or source maps) | 49 MB |
| `cockpit` | The Cockpit's production build, served by Core | 17 MB |
| `knowledge` | A standalone CPython 3.12 with the locked dependencies and the Knowledge service | 371 MB |
| `share` | Configuration, prompts, the memory template and the database setup | under 1 MB |

Add `--with-models` to include the search models, so the first source needs no download. Rebuild one part with, for example, `pnpm --filter @nvx/ancile-desktop sidecars core`.

Core is not a Node single-executable application: that format takes one CommonJS file and cannot load Core's WebAssembly policy engine from disk, so the app ships the Node runtime next to an esbuild bundle instead. The lab (the agent engine) and the Controller (GPU nodes) are not bundled yet; the desktop app runs them when their folders are present.

### Trying a build without touching your workspace

`cargo run` in `apps/desktop/src-tauri` starts a debug build. Three variables keep it apart from your everyday data:

```bash
ANCILE_DESKTOP_DATA_DIR=/tmp/ancile-try \
ANCILE_DESKTOP_PORT_BASE=18700 \
ANCILE_DESKTOP_PROFILE=try \
cargo run
```

The profile name keeps its keychain entries separate too. By default the app uses ports from 17700, away from a development stack (7700) and the test stack (7800).

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

Once its services are up, and then every 24 hours, the app asks
`https://ancile.nvx.sh/api/updates/{target}/{arch}/{version}?edition=free|pro&channel=stable|beta`.
The edition is what was installed (the Pro edition carries Pro beside Core); the channel is a setting (`PUT /api/v1/system/updates {"channel":"beta"}`, stable by default). A Pro install sends its licence token, so nvx.sh offers Pro builds only to a licence that is current; a lapsed one is offered the free build. Nothing installs on its own: an update appears in the tray menu as "Install NVX Ancile x.y.z and restart". With no network, or no answer, the app tries again the next day.

Publishing: a version tag builds the installers. The free edition becomes a public asset of the GitHub release, then `apps/desktop/scripts/publish-release.mjs --github-release <tag>` tells nvx.sh about it (`POST /api/releases/publish` with `external_url`), so the updater can offer it. One updater bundle per platform is published: the Windows NSIS setup, the macOS `.app.tar.gz`, the Linux AppImage. A version is never replaced: publishing a different build under a published version fails the job. The Pro edition is never put on GitHub: `publish-release.mjs --edition pro --upload` sends it to nvx.sh's private storage (Cloudflare R2) through a one-hour upload link and then publishes it, and the updater gets a 15-minute download link only for a current licence. Until R2 is set up the script skips Pro rather than use smaller fallback storage.

Which edition a build is: `NVX_TIER=free` at build time makes a free build even when `pro/` is on disk. Core gets no `pro.js` and the Cockpit build leaves Pro's screens out entirely. Without it, and with `pro/` present, both carry Pro, and the Cockpit ships without source maps so Pro's source is never in an installer.
