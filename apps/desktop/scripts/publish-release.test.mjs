/**
 * Publishing to nvx.sh against a fake server: the three calls in order,
 * the file going straight to storage, a retry of the same build passing,
 * and a different build under a published version failing clearly.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  channelOf,
  githubAssetUrl,
  pickBundle,
  platform,
  publish,
  publishExternal,
} from './publish-release.mjs';

let server;
let base;
const calls = [];
/** version → the size it was published with */
const published = new Map();
const stored = new Map();
const externals = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/releases/upload') {
      const meta = JSON.parse(raw.toString());
      if (published.has(meta.version)) return json(409, { error: { code: 'release.exists' } });
      return json(200, { upload_url: `${base}/storage/${meta.filename}`, token: 't', path: meta.filename });
    }
    if (req.url?.startsWith('/storage/')) {
      stored.set(decodeURIComponent(req.url), raw.length);
      res.writeHead(200);
      return res.end();
    }
    if (req.url?.startsWith('/repos/Envxsion/nvx_ancile/releases/tags/')) {
      const tag = decodeURIComponent(req.url.split('/').pop());
      if (tag === 'v9.9.9') return json(404, {});
      return json(200, {
        draft: tag === 'v0.0.1-draft',
        assets: [
          {
            name: 'NVX.Ancile_1.1.0_x64-setup.exe',
            browser_download_url: `https://github.example/${tag}/NVX.Ancile_1.1.0_x64-setup.exe`,
          },
        ],
      });
    }
    if (req.url === '/api/releases/publish') {
      const meta = JSON.parse(raw.toString());
      if (meta.external_url) {
        externals.push(meta.external_url);
        const prior = published.get(meta.version);
        if (prior !== undefined)
          return prior === meta.size_bytes ? json(200, {}) : json(409, { error: { code: 'release.exists' } });
        published.set(meta.version, meta.size_bytes);
        return json(201, {});
      }
      const prior = published.get(meta.version);
      if (prior !== undefined)
        return prior === meta.size_bytes ? json(200, {}) : json(409, { error: { code: 'release.exists' } });
      if (stored.get(`/storage/${meta.filename}`) !== meta.size_bytes)
        return json(409, { error: { code: 'release.no_file' } });
      published.set(meta.version, meta.size_bytes);
      return json(201, {});
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function build(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'nvx-publish-'));
  const file = join(dir, 'NVX Ancile_1.0.0_x64-setup.exe');
  writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

const metaFor = (file, size, version = '1.0.0') => ({
  product: 'ancile',
  version,
  edition: 'pro',
  channel: channelOf(version),
  target: 'windows',
  arch: 'x86_64',
  signature: 'sig',
  notes: 'test',
  size_bytes: size,
  filename: file.split(/[\\/]/).pop(),
});

describe('publish to nvx.sh', () => {
  it('uploads, sends the file to storage, then publishes', async () => {
    const file = build(1024);
    const r = await publish({ file, meta: metaFor(file, 1024), token: 'rel_test', base });
    assert.equal(r, 'published');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.startsWith('/storage/') ? '/storage' : c.url}`),
      ['POST /api/releases/upload', 'PUT /storage', 'POST /api/releases/publish'],
    );
    assert.equal(calls[0].auth, 'Bearer rel_test');
    assert.equal(calls[1].auth, null, 'the storage link carries no release token');
  });

  it('treats the same build again as already done', async () => {
    const file = build(1024);
    assert.equal(await publish({ file, meta: metaFor(file, 1024), token: 'rel_test', base }), 'already');
  });

  it('fails clearly for a different build under a published version', async () => {
    const file = build(2048);
    await assert.rejects(
      publish({ file, meta: metaFor(file, 2048), token: 'rel_test', base }),
      /raise the version/,
    );
  });
});

describe('release details', () => {
  it('names the platform as Tauri does', () => {
    assert.deepEqual(platform('win32', 'x64'), { target: 'windows', arch: 'x86_64' });
    assert.deepEqual(platform('darwin', 'arm64'), { target: 'darwin', arch: 'aarch64' });
    assert.deepEqual(platform('linux', 'x64'), { target: 'linux', arch: 'x86_64' });
  });

  it('calls a pre-release beta', () => {
    assert.equal(channelOf('1.2.0-beta.1'), 'beta');
    assert.equal(channelOf('1.2.0'), 'stable');
  });

  it('picks the one updater bundle per platform', () => {
    const files = [
      'a/msi/X.msi',
      'a/nsis/X_x64-setup.exe',
      'a/dmg/X.dmg',
      'a/macos/X.app.tar.gz',
      'a/appimage/X.AppImage',
      'a/deb/X.deb',
    ];
    assert.equal(pickBundle(files, 'windows'), 'a/nsis/X_x64-setup.exe');
    assert.equal(pickBundle(files, 'darwin'), 'a/macos/X.app.tar.gz');
    assert.equal(pickBundle(files, 'linux'), 'a/appimage/X.AppImage');
    assert.equal(pickBundle(['a/X.msi'], 'windows'), 'a/X.msi');
    assert.equal(pickBundle([], 'linux'), null);
  });
});

describe('free builds published from their GitHub release', () => {
  const name = 'NVX Ancile_1.1.0_x64-setup.exe';

  it('finds the public asset, matching a name GitHub stored with dots', async () => {
    const url = await githubAssetUrl({
      repo: 'Envxsion/nvx_ancile',
      tag: 'v1.1.0',
      filename: name,
      api: base,
    });
    assert.equal(url, 'https://github.example/v1.1.0/NVX.Ancile_1.1.0_x64-setup.exe');
  });

  it('refuses a draft release, whose files are not public', async () => {
    await assert.rejects(
      githubAssetUrl({ repo: 'Envxsion/nvx_ancile', tag: 'v0.0.1-draft', filename: name, api: base }),
      /draft/,
    );
    await assert.rejects(
      githubAssetUrl({ repo: 'Envxsion/nvx_ancile', tag: 'v9.9.9', filename: name, api: base }),
      /no release/,
    );
  });

  it('publishes with external_url and no upload, and a retry of the same build passes', async () => {
    const meta = { ...metaFor(`x/${name}`, 4096, '1.1.0'), edition: 'free', filename: name };
    const before = calls.length;
    await publishExternal({ meta, externalUrl: 'https://github.example/a.exe', token: 'rel_test', base });
    assert.deepEqual(
      calls.slice(before).map((c) => c.url),
      ['/api/releases/publish'],
    );
    assert.equal(externals.at(-1), 'https://github.example/a.exe');
    await publishExternal({ meta, externalUrl: 'https://github.example/a.exe', token: 'rel_test', base });
    await assert.rejects(
      publishExternal({
        meta: { ...meta, size_bytes: 1 },
        externalUrl: 'https://github.example/b.exe',
        token: 'rel_test',
        base,
      }),
      /raise the version/,
    );
  });
});
