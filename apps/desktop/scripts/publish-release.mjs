#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  Publish a release to nvx.sh
 *  Ref      |  NVX licensing and updates v2 §7 · docs/desktop.md
 *  ID       |  desktop
 * ------------------------------------------------------------------
 *  Purpose  |  Make this platform's build available to the updater at
 *           |  ancile.nvx.sh. Pro builds go only here, never to a
 *           |  public address.
 *  How      |  `node scripts/publish-release.mjs --edition free|pro
 *           |  --version 1.2.3 [--notes "…"] (--github-release v1.2.3
 *           |  | --upload)`. Picks this platform's updater bundle
 *           |  (Windows NSIS setup, macOS .app.tar.gz, Linux AppImage)
 *           |  and its .sig.
 *           |  --github-release TAG (free builds): the file is already a
 *           |  public asset of that GitHub release; one call,
 *           |  POST /api/releases/publish with external_url set to it.
 *           |  --upload (kept for later; not for 175 MB installers):
 *           |    1. POST /api/releases/upload  (JSON metadata)
 *           |       → {upload_url}; 409 release.exists: go to 3
 *           |    2. PUT the file to upload_url (straight to storage:
 *           |       Vercel refuses bodies over 4.5 MB)
 *           |    3. POST /api/releases/publish (same metadata)
 *           |       200: live (also for the identical build again);
 *           |       409: a different build under a published version,
 *           |       which fails the job.
 *  Note     |  NVX_RELEASE_TOKEN unset: nothing is sent. NVX_RELEASE_
 *           |  BASE overrides https://nvx.sh (tests use a fake server).
 * ------------------------------------------------------------------
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BUNDLE = join(here, '..', 'src-tauri', 'target', 'release', 'bundle');

/** Tauri's {{target}} and {{arch}} for a machine. */
export function platform(p = process.platform, a = process.arch) {
  const target = p === 'win32' ? 'windows' : p === 'darwin' ? 'darwin' : 'linux';
  const arch = a === 'arm64' ? 'aarch64' : a === 'ia32' ? 'i686' : a === 'arm' ? 'armv7' : 'x86_64';
  return { target, arch };
}

export const channelOf = (version) => (version.includes('-') ? 'beta' : 'stable');

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name.endsWith('.app') ? [] : walk(p);
    return [p];
  });
}

/** The one updater bundle for this target, in order of preference. */
export function pickBundle(files, target) {
  const prefer = {
    windows: [/-setup\.exe$/i, /\.msi$/i],
    darwin: [/\.app\.tar\.gz$/],
    linux: [/\.AppImage$/],
  }[target];
  for (const re of prefer ?? []) {
    const hit = files.find((f) => re.test(f));
    if (hit) return hit;
  }
  return null;
}

class Failed extends Error {}

async function call(fetchImpl, base, path, token, meta) {
  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(meta),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const codeOf = (body) => (typeof body?.error === 'object' ? body.error?.code : body?.error) ?? '';

/**
 * Publish one file. Returns 'published' or 'already'. Throws with a clear
 * message on anything else.
 */
/**
 * The public download address of a release asset, from the GitHub API. GitHub
 * stores a name with spaces as dots, so both spellings are matched.
 */
export async function githubAssetUrl({
  repo,
  tag,
  filename,
  token,
  api = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { accept: 'application/vnd.github+json', ...(token && { authorization: `Bearer ${token}` }) },
  });
  if (!res.ok) throw new Failed(`GitHub has no release ${tag} in ${repo} (${res.status}).`);
  const release = await res.json();
  if (release.draft) throw new Failed(`GitHub release ${tag} is a draft, so its files are not public yet.`);
  const names = new Set([filename, filename.replace(/ /g, '.')]);
  const asset = (release.assets ?? []).find((a) => names.has(a.name));
  if (!asset) throw new Failed(`GitHub release ${tag} has no asset named ${filename}.`);
  return asset.browser_download_url;
}

/** Publish a build that is already public elsewhere (a GitHub release asset). */
export async function publishExternal({
  meta,
  externalUrl,
  token,
  base = 'https://nvx.sh',
  fetchImpl = fetch,
}) {
  const pub = await call(fetchImpl, base, '/api/releases/publish', token, {
    ...meta,
    external_url: externalUrl,
  });
  if (pub.status === 200) return 'already-or-published';
  if (pub.status === 201) return 'published';
  if (pub.status === 409)
    throw new Failed(
      `${meta.version} (${meta.edition}, ${meta.target}/${meta.arch}) is already published as a different build (${codeOf(pub.body) || 'conflict'}). Releases are never replaced: raise the version.`,
    );
  throw new Failed(`nvx.sh did not publish ${meta.filename}: ${pub.status} ${codeOf(pub.body)}`);
}

/**
 * Upload to nvx.sh's storage, then publish. `requireStore` refuses any
 * store but the one named (Pro installers go only to Cloudflare R2: before
 * R2 is set up nvx.sh offers Supabase, capped at 50 MB) and returns
 * 'skipped' without sending anything.
 */
export async function publish({ file, meta, token, base = 'https://nvx.sh', fetchImpl = fetch, requireStore }) {
  const up = await call(fetchImpl, base, '/api/releases/upload', token, meta);
  if (up.status === 409 && codeOf(up.body) === 'release.exists') {
    // Already published: the same build again is a harmless retry; another build fails below.
  } else if (up.status >= 200 && up.status < 300 && up.body?.upload_url) {
    if (requireStore && up.body.store !== requireStore) return 'skipped';
    // A presigned PUT signs only the host: any other header breaks the signature.
    const put = await fetchImpl(up.body.upload_url, {
      method: up.body.method ?? 'PUT',
      body: readFileSync(file),
    });
    if (!put.ok) throw new Failed(`Storage refused ${meta.filename}: ${put.status}`);
  } else {
    throw new Failed(`nvx.sh refused the upload of ${meta.filename}: ${up.status} ${codeOf(up.body)}`);
  }
  const pub = await call(fetchImpl, base, '/api/releases/publish', token, meta);
  if (pub.status === 200 || pub.status === 201) return up.status === 409 ? 'already' : 'published';
  if (pub.status === 409 && codeOf(pub.body) === 'release.no_file')
    throw new Failed(`${meta.filename} did not reach storage (release.no_file). Run the job again.`);
  if (pub.status === 409)
    throw new Failed(
      `${meta.version} (${meta.edition}, ${meta.target}/${meta.arch}) is already published as a different build (${codeOf(pub.body) || 'conflict'}). Releases are never replaced: raise the version.`,
    );
  throw new Failed(`nvx.sh did not publish ${meta.filename}: ${pub.status} ${codeOf(pub.body)}`);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const token = process.env.NVX_RELEASE_TOKEN;
  if (!token) {
    console.log('NVX_RELEASE_TOKEN is not set: nothing published.');
    return;
  }
  const edition = arg('edition');
  const version = arg('version');
  if (!['free', 'pro'].includes(edition ?? '') || !version) {
    console.error('Usage: publish-release.mjs --edition free|pro --version 1.2.3 [--notes "…"]');
    process.exit(2);
  }
  const { target, arch } = platform();
  const file = pickBundle(walk(BUNDLE), target);
  if (!file) {
    console.error(`No updater bundle for ${target} under ${BUNDLE}. Build the installers first.`);
    process.exit(1);
  }
  const sig = `${file}.sig`;
  if (!existsSync(sig)) {
    console.error(`${basename(file)} has no .sig: set the updater signing key (TAURI_SIGNING_PRIVATE_KEY).`);
    process.exit(1);
  }
  const meta = {
    product: 'ancile',
    version,
    edition,
    channel: channelOf(version),
    target,
    arch,
    signature: readFileSync(sig, 'utf8').trim(),
    notes: arg('notes') ?? `NVX Ancile ${version}`,
    size_bytes: statSync(file).size,
    filename: basename(file),
  };
  const base = process.env.NVX_RELEASE_BASE ?? 'https://nvx.sh';
  const tag = arg('github-release');
  try {
    if (tag) {
      const externalUrl = await githubAssetUrl({
        repo: process.env.GITHUB_REPOSITORY ?? 'Envxsion/nvx_ancile',
        tag,
        filename: meta.filename,
        token: process.env.GITHUB_TOKEN,
      });
      await publishExternal({ meta, externalUrl, token, base });
      console.log(
        `Published on nvx.sh from GitHub: ${meta.filename} (${edition}, ${target}/${arch}, ${meta.channel})`,
      );
    } else if (process.argv.includes('--upload')) {
      // Pro installers live only in R2 (no download fees); never in the 50 MB Supabase fallback.
      const r = await publish({ file, meta, token, base, ...(edition === 'pro' && { requireStore: 'r2' }) });
      if (r === 'skipped') {
        console.log(
          `Not published: nvx.sh's release storage is not Cloudflare R2 yet, and Pro installers go only there (${meta.filename}).`,
        );
        return;
      }
      console.log(
        `${r === 'already' ? 'Already published' : 'Published'}: ${meta.filename} (${edition}, ${target}/${arch}, ${meta.channel})`,
      );
    } else {
      console.error(
        'Say where the file is: --github-release <tag> (public asset) or --upload (send it to nvx.sh).',
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Failed ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
