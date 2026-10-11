#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  Third-party licences
 *  Ref      |  NOTICE.md · apps/desktop/scripts/bundle.mjs
 *  ID       |  desktop
 * ------------------------------------------------------------------
 *  Purpose  |  Write THIRD_PARTY_LICENSES.txt for everything the
 *           |  desktop installer ships, and stop the release when a
 *           |  shipped package has a licence we cannot ship or cannot
 *           |  identify.
 *  How      |  Reads the built sidecars, not the lockfiles:
 *           |  core       every package in sidecars/core/node_modules
 *           |             (Core's `pnpm deploy`).
 *           |  controller the production dependency closure of
 *           |  cockpit    services/controller and apps/cockpit, resolved
 *           |             in the workspace's node_modules (both are
 *           |             bundles with their packages inlined).
 *           |  lab        the closure of vendor/opencode/packages/opencode
 *           |             in the engine's own (Bun) node_modules.
 *           |  knowledge  every *.dist-info in the bundled CPython's
 *           |             site-packages: METADATA for the licence,
 *           |             dist-info licence files and licence files the
 *           |             package installs (RECORD) for the text.
 *           |  components Node.js, CPython, pg0 (PostgreSQL, pgvector),
 *           |             opencode, Open Notebook, the Aperture fonts.
 *           |  Each licence (an SPDX expression) is checked against
 *           |  ALLOW and DENY; anything denied or unknown is listed and
 *           |  the script exits 1. Packages whose distribution has no
 *           |  licence file get the standard text from licence-texts/
 *           |  (or a curated override below) with their copyright line.
 *           |  node scripts/third-party-licenses.mjs [--sidecars DIR]
 *           |    [--out FILE] [--root DIR] [--opencode DIR]
 *           |  ANCILE_SIDECARS also sets the sidecars folder.
 *  Note     |  Run by bundle.mjs after every sidecar build (full or
 *           |  partial), so the file always matches what is shipped.
 *           |  It lands in sidecars/, which Tauri bundles as resources.
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEXTS = join(here, 'licence-texts');

// --- Policy -------------------------------------------------------------------

/** Licences we ship (SPDX ids, compared case-insensitively). */
const ALLOWED_IDS = [
  '0BSD',
  'AFL-2.1',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'HPND',
  'ISC',
  'LGPL-2.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MIT-CMU',
  'MPL-2.0',
  'OFL-1.1',
  'PostgreSQL',
  'PSF-2.0',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'W3C',
  'WTFPL',
  'X11',
  'Zlib',
];
export const ALLOW = new Set(ALLOWED_IDS.map((s) => s.toLowerCase()));
const CANONICAL = new Map(ALLOWED_IDS.map((s) => [s.toLowerCase(), s]));

/** Licences that must never ship. Matched against each id and the raw string. */
export const DENY = [
  /\bAGPL/i,
  /\bSSPL/i,
  /\bBUSL/i,
  /^Elastic-2\.0$/i,
  /Commons[- ]Clause/i,
  /^UNLICENSED$/i,
  /proprietary/i,
  /SEE LICEN[CS]E IN/i,
  /CC-BY-NC/i,
  /non-?commercial/i,
];

/** Free-text licence names (package metadata, Python classifiers) → SPDX. */
const ALIASES = {
  mit: 'MIT',
  'mit license': 'MIT',
  'mit licence': 'MIT',
  'the mit license': 'MIT',
  'expat (mit/x11)': 'MIT',
  isc: 'ISC',
  'isc license': 'ISC',
  'isc license (iscl)': 'ISC',
  'apache 2.0': 'Apache-2.0',
  'apache-2': 'Apache-2.0',
  'apache 2': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0',
  'apache software license': 'Apache-2.0',
  'apache software license 2.0': 'Apache-2.0',
  '3-clause bsd license': 'BSD-3-Clause',
  'new bsd license': 'BSD-3-Clause',
  'bsd-3': 'BSD-3-Clause',
  'bsd 3-clause': 'BSD-3-Clause',
  'bsd-2': 'BSD-2-Clause',
  'simplified bsd': 'BSD-2-Clause',
  psfl: 'PSF-2.0',
  'python software foundation license': 'PSF-2.0',
  'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0',
  'gnu lesser general public license v2 or later (lgplv2+)': 'LGPL-2.0-or-later',
  'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only',
  'gnu library or lesser general public license (lgpl)': 'LGPL-2.0-or-later',
  'the unlicense (unlicense)': 'Unlicense',
  'public domain': 'Unlicense',
  'zlib/libpng license': 'Zlib',
};

/**
 * Packages whose distribution has no licence file, or whose metadata does not
 * say the licence plainly. Each entry is checked against the project's own
 * LICENSE upstream (the date says when); `copyright` fills the standard text.
 */
export const OVERRIDES = {
  python: {
    markitdown: {
      licence: 'MIT',
      copyright: 'Microsoft Corporation.',
      note: 'The wheel ships no licence file. Text and copyright line as in https://github.com/microsoft/markitdown/blob/main/LICENSE (checked 2026-10-11).',
    },
    loguru: {
      licence: 'MIT',
      copyright: '2017',
      note: 'The wheel ships no licence file. Text as in https://github.com/Delgan/loguru/blob/master/LICENSE (checked 2026-10-11), which names no holder; the author is Delgan.',
    },
    flatbuffers: {
      licence: 'Apache-2.0',
      note: 'The wheel ships no licence file. https://github.com/google/flatbuffers/blob/master/LICENSE is the standard Apache-2.0 text (checked 2026-10-11). Copyright Google Inc.',
    },
    magika: {
      licence: 'Apache-2.0',
      note: 'The wheel ships no licence file. https://github.com/google/magika/blob/main/LICENSE is the standard Apache-2.0 text (checked 2026-10-11). Copyright Google LLC.',
    },
    tokenizers: {
      licence: 'Apache-2.0',
      note: 'The wheel ships no licence file. https://github.com/huggingface/tokenizers/blob/main/LICENSE is the standard Apache-2.0 text (checked 2026-10-11). Copyright Hugging Face.',
    },
    'opentelemetry-util-http': {
      licence: 'Apache-2.0',
      note: 'The wheel ships no licence file. https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/LICENSE is the standard Apache-2.0 text (checked 2026-10-11). Copyright The OpenTelemetry Authors.',
    },
    pypdfium2: {
      licence: '(Apache-2.0 OR BSD-3-Clause) AND BSD-3-Clause AND CC-BY-4.0',
      note: 'pypdfium2 is Apache-2.0 or BSD-3-Clause at the licensee\'s choice, with CC-BY-4.0 for some data files. It carries a PDFium binary (BSD-3-Clause, "Copyright 2014 The PDFium Authors") built with the libraries whose licences follow (BUILD_LICENSES).',
    },
  },
  npm: {
    '@openauthjs/openauth': {
      licence: 'MIT',
      copyright: '2024 SST',
      note: 'package.json declares no licence and the package ships no licence file. Text and copyright line as in https://github.com/toolbeam/openauth/blob/master/LICENSE (checked 2026-10-11).',
    },
    'poe-oauth': {
      licence: 'MIT',
      copyright: '2026 Poe Platform',
      note: 'package.json declares no licence and the package ships no licence file. Text and copyright line as in https://github.com/poe-platform/poe-code/blob/main/packages/poe-oauth/LICENSE (checked 2026-10-11).',
    },
    'spdx-exceptions': {
      text: 'The SPDX license exception list, by the SPDX Workgroup (https://spdx.org/licenses/exceptions-index.html), is licensed under Creative Commons Attribution 3.0 Unported: https://creativecommons.org/licenses/by/3.0/legalcode',
    },
    'spdx-license-ids': {
      text: 'The SPDX license list identifiers (https://spdx.org/licenses/) are dedicated to the public domain under Creative Commons CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/legalcode',
    },
  },
};

// --- Licence expressions ----------------------------------------------------------

/** Map a free-text or SPDX-ish licence name to an SPDX id where we can. */
export function normaliseId(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^License :: (OSI Approved :: )?/, '');
  if (!s) return '';
  const alias = ALIASES[s.toLowerCase()];
  if (alias) return alias;
  const canonical = CANONICAL.get(s.toLowerCase());
  if (canonical) return canonical;
  if (s.endsWith('+') && !s.includes(' ')) return normaliseId(`${s.slice(0, -1)}-or-later`);
  return s;
}

function idStatus(id) {
  if (DENY.some((re) => re.test(id))) return 'denied';
  if (ALLOW.has(normaliseId(id).toLowerCase())) return 'allowed';
  return 'unknown';
}

const RANK = { denied: 0, unknown: 1, allowed: 2 };

/**
 * Check an SPDX expression: OR takes the best alternative, AND the worst part,
 * `X WITH exception` counts as X. Returns { status: allowed|denied|unknown, ids }.
 */
export function classify(expression) {
  const raw = String(expression ?? '').trim();
  if (!raw) return { status: 'unknown', ids: [] };
  // Not expressions at all: npm's "no licence" and "look in this file".
  if (/^UNLICENSED$|SEE LICEN[CS]E IN/i.test(raw)) return { status: 'denied', ids: [raw] };
  const tokens = raw.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  const ids = [];
  let i = 0;
  const peek = () => tokens[i];
  const atom = () => {
    if (peek() === '(') {
      i++;
      const v = or();
      if (peek() !== ')') throw new Error('unbalanced');
      i++;
      return v;
    }
    const id = tokens[i++];
    if (!id || /^(AND|OR|WITH|\))$/i.test(id)) throw new Error('bad token');
    if (peek() && /^WITH$/i.test(peek())) i += 2;
    ids.push(id);
    return idStatus(id);
  };
  const and = () => {
    let v = atom();
    while (peek() && /^AND$/i.test(peek())) {
      i++;
      const w = atom();
      if (RANK[w] < RANK[v]) v = w;
    }
    return v;
  };
  function or() {
    let v = and();
    while (peek() && /^OR$/i.test(peek())) {
      i++;
      const w = and();
      if (RANK[w] > RANK[v]) v = w;
    }
    return v;
  }
  try {
    const status = or();
    if (i !== tokens.length) return { status: idStatus(normaliseId(raw)), ids: [raw] };
    return { status, ids };
  } catch {
    return { status: idStatus(normaliseId(raw)), ids: [raw] };
  }
}

/** Guess the licence from its text, for packages that do not declare one. */
export function detectFromText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  if (/Apache License,? Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return 'MIT';
  if (/Mozilla Public License,? (Version|v\.?) ?2\.0/i.test(t)) return 'MPL-2.0';
  if (
    /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted, provided that/i.test(
      t,
    )
  )
    return 'ISC';
  if (
    /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\./i.test(
      t,
    )
  )
    return '0BSD';
  if (/Redistribution and use in source and binary forms/i.test(t))
    return /Neither the name|names of (its|the) contributors may be used/i.test(t)
      ? 'BSD-3-Clause'
      : 'BSD-2-Clause';
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  return null;
}

/** The licence a package.json declares, as one SPDX expression. */
export function licenceOfPackageJson(pkg) {
  const one = (l) => (typeof l === 'string' ? l : l && typeof l === 'object' ? l.type : '');
  if (pkg.license) return normaliseId(one(pkg.license));
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const ids = pkg.licenses.map((l) => normaliseId(one(l))).filter(Boolean);
    return ids.length > 1 ? `(${ids.join(' OR ')})` : (ids[0] ?? '');
  }
  return '';
}

// --- Python metadata ----------------------------------------------------------

/** The header fields of a METADATA file (RFC 822 style), as name → values. */
export function parseMetadata(text) {
  const head = String(text).replace(/\r\n/g, '\n').split(/\n\n/)[0];
  const out = {};
  let last = null;
  for (const line of head.split('\n')) {
    if (/^\s/.test(line) && last) {
      const v = out[last];
      v[v.length - 1] += `\n${line.replace(/^ {7}\|?/, '').trimStart()}`;
      continue;
    }
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    last = m[1];
    if (!out[last]) out[last] = [];
    out[last].push(m[2]);
  }
  return out;
}

/**
 * A Python distribution's licence from its METADATA: License-Expression, then a
 * short License field, then the License classifiers, then the licence text.
 */
export function pythonLicence(meta, licenceText = '') {
  const expr = meta['License-Expression']?.[0]?.trim();
  if (expr) return { licence: expr, from: 'License-Expression' };
  const field = meta.License?.[0]?.trim();
  if (field && !field.includes('\n') && field.length <= 80) {
    const id = normaliseId(field);
    if (classify(id).status !== 'unknown') return { licence: id, from: 'License' };
  }
  const classifiers = (meta.Classifier ?? [])
    .filter((c) => c.startsWith('License ::'))
    .map((c) => normaliseId(c.split(' :: ').pop()))
    .filter((c) => c && !/^BSD License$/i.test(c) && !/^OSI Approved$/i.test(c));
  const generic = (meta.Classifier ?? []).some((c) => /:: BSD License$/.test(c));
  if (classifiers.length && !generic)
    return {
      licence: classifiers.length > 1 ? classifiers.join(' OR ') : classifiers[0],
      from: 'Classifier',
    };
  const detected = detectFromText(licenceText);
  if (detected) return { licence: detected, from: 'licence text' };
  if (classifiers.length) return { licence: classifiers.join(' OR '), from: 'Classifier' };
  return { licence: field && field.length <= 80 ? field : '', from: 'none' };
}

/** PEP 503 name: lower case, runs of -_. as one dash. */
export const pep503 = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[-_.]+/g, '-');

// --- Files --------------------------------------------------------------------

const LICENCE_FILE =
  /^(licen[cs]e|copying|notice|thirdpartynotices|third_party_notices|unlicense)([-._].*)?$/i;
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd();

function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/** Licence files at the top of a package folder. */
function topLicenceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => LICENCE_FILE.test(n) && statSync(join(dir, n)).isFile())
    .sort()
    .map((n) => ({ name: n, text: read(join(dir, n)) }));
}

const standardTexts = new Map();
/** The standard text of a licence, with its copyright line filled, or null. */
export function standardText(id, copyright) {
  const file = join(TEXTS, `${id}.txt`);
  if (!existsSync(file)) return null;
  if (!standardTexts.has(id)) standardTexts.set(id, read(file));
  return standardTexts.get(id).replace('<copyright>', copyright || 'the authors');
}

/** First alternative of an expression that has a standard text. */
function standardFor(expression, copyright) {
  for (const id of classify(expression).ids) {
    const t = standardText(normaliseId(id), copyright);
    if (t) return { id: normaliseId(id), text: t };
  }
  return null;
}

// --- Node packages ------------------------------------------------------------

const hasNodeModules = (p) => p.split(sep).includes('node_modules') || p.split('/').includes('node_modules');

function npmEntry(dir, usedBy) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const override = OVERRIDES.npm[pkg.name];
  return {
    kind: 'npm',
    name: pkg.name,
    version: pkg.version,
    licence: override?.licence ?? licenceOfPackageJson(pkg),
    author: author?.replace(/\s*[<(].*$/, '').trim(),
    copyright: override?.copyright,
    note: override?.note,
    standard: override?.text ? { id: 'licence notice', text: override.text } : undefined,
    source: pkg.homepage || repo?.replace(/^git\+/, ''),
    files: topLicenceFiles(dir),
    usedBy: new Set([usedBy]),
  };
}

/** Every package in a deployed node_modules tree (nested ones included). */
export function packagesIn(nodeModules) {
  const dirs = [];
  if (!existsSync(nodeModules)) return dirs;
  for (const name of readdirSync(nodeModules)) {
    if (name.startsWith('.')) continue;
    const p = join(nodeModules, name);
    if (!statSync(p).isDirectory()) continue;
    const pkgs = name.startsWith('@') ? readdirSync(p).map((n) => join(p, n)) : [p];
    for (const d of pkgs) {
      if (!existsSync(join(d, 'package.json'))) continue;
      dirs.push(d);
      dirs.push(...packagesIn(join(d, 'node_modules')));
    }
  }
  return dirs;
}

/**
 * The production dependency closure of a package, resolved the way Node does
 * (walking up node_modules from each package's real folder, so pnpm's and
 * Bun's linked layouts both work). Folders outside any node_modules are
 * first-party (workspace packages): followed, not listed.
 */
export function closure(entry, { fallbacks = [] } = {}) {
  const found = new Map();
  const unresolved = [];
  const seen = new Set();
  const resolve = (name, from) => {
    let d = from;
    for (;;) {
      const c = join(d, 'node_modules', name);
      if (existsSync(join(c, 'package.json'))) return realpathSync(c);
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    for (const f of fallbacks) {
      const c = join(f, name);
      if (existsSync(join(c, 'package.json'))) return realpathSync(c);
    }
    return null;
  };
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (hasNodeModules(dir)) found.set(`${pkg.name}@${pkg.version}`, dir);
    const optional = pkg.optionalDependencies ?? {};
    for (const name of Object.keys({ ...pkg.dependencies, ...optional })) {
      const d = resolve(name, dir);
      if (d) visit(d);
      else if (!(name in optional)) unresolved.push(`${name} (from ${pkg.name})`);
    }
  };
  visit(realpathSync(entry));
  return { dirs: [...found.values()], unresolved };
}

// --- Python packages ----------------------------------------------------------

function sitePackages(python) {
  const win = join(python, 'Lib', 'site-packages');
  if (existsSync(win)) return win;
  const lib = join(python, 'lib');
  if (!existsSync(lib)) return null;
  const v = readdirSync(lib).find((d) => /^python3\.\d+$/.test(d));
  return v ? join(lib, v, 'site-packages') : null;
}

function pythonEntries(sp) {
  const out = [];
  for (const d of readdirSync(sp).filter((n) => n.endsWith('.dist-info'))) {
    const info = join(sp, d);
    const meta = parseMetadata(readFileSync(join(info, 'METADATA'), 'utf8'));
    const name = meta.Name?.[0] ?? d;
    if (pep503(name) === 'ancile-knowledge') continue;
    const files = [];
    const seenFiles = new Set();
    const add = (rel, abs) => {
      const key = rel.replace(/\\/g, '/');
      if (seenFiles.has(key) || !existsSync(abs)) return;
      seenFiles.add(key);
      files.push({ name: key, text: read(abs) });
    };
    for (const rel of listFiles(join(info, 'licenses')).sort())
      add(`licenses/${rel}`, join(info, 'licenses', rel));
    for (const n of readdirSync(info)) if (LICENCE_FILE.test(n)) add(n, join(info, n));
    // Licence files the package installs beside its code (RECORD lists them).
    const record = join(info, 'RECORD');
    if (existsSync(record))
      for (const line of read(record).split('\n')) {
        const rel = line.split(',')[0];
        if (!rel || rel.includes('.dist-info/') || rel.startsWith('..')) continue;
        if (LICENCE_FILE.test(basename(rel))) add(rel, join(sp, rel));
      }
    const override = OVERRIDES.python[pep503(name)];
    const { licence, from } = override
      ? { licence: override.licence, from: 'override' }
      : pythonLicence(meta, files.map((f) => f.text).join('\n'));
    const author = meta.Author?.[0] || meta['Author-email']?.[0]?.replace(/\s*<.*$/, '');
    out.push({
      kind: 'python',
      name,
      version: meta.Version?.[0] ?? '',
      licence,
      from,
      author,
      copyright: override?.copyright,
      note: override?.note,
      source: meta['Home-page']?.[0] || meta['Project-URL']?.[0]?.split(', ').pop(),
      files,
      usedBy: new Set(['knowledge']),
    });
  }
  return out;
}

// --- Components ---------------------------------------------------------------

function nodeRuntime(sidecars) {
  const dir = join(sidecars, 'node');
  const bin = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  return { dir, version };
}

async function nodeLicence(dir, version) {
  const local = join(dir, 'LICENSE');
  if (existsSync(local)) return read(local);
  // Not every Node install carries its LICENSE (the Windows MSI does not).
  const url = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Node.js ${version} LICENSE: ${url} answered ${res.status}`);
  return (await res.text()).replace(/\r\n/g, '\n').trimEnd();
}

function pg0Version(root) {
  const src = existsSync(join(root, 'scripts', 'runtime.mjs'))
    ? read(join(root, 'scripts', 'runtime.mjs'))
    : '';
  return /pg0:\s*\{\s*version:\s*'([^']+)'/.exec(src)?.[1] ?? 'unknown';
}

// --- Output -------------------------------------------------------------------

const RULE = '-'.repeat(78);
const HEAVY = '='.repeat(78);

function entryText(e) {
  const lines = [
    RULE,
    `${e.name}${e.version ? ` ${e.version}` : ''}`,
    `Licence: ${e.licence || 'not declared'}`,
  ];
  if (e.usedBy?.size) lines.push(`Shipped in: ${[...e.usedBy].sort().join(', ')}`);
  if (e.source) lines.push(`Source: ${e.source}`);
  if (e.note) lines.push(`Note: ${e.note}`);
  lines.push('');
  if (e.files.length) {
    for (const f of e.files) lines.push(`--- ${f.name} ---`, f.text, '');
  } else if (e.standard) {
    lines.push(
      `--- ${e.standard.id} (standard text; the distribution carries no licence file) ---`,
      e.standard.text,
      '',
    );
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = get('root') ?? join(here, '..', '..', '..');
  const sidecars =
    get('sidecars') ?? process.env.ANCILE_SIDECARS ?? join(here, '..', 'src-tauri', 'sidecars');
  return {
    root,
    sidecars,
    opencode: get('opencode') ?? join(root, 'vendor', 'opencode'),
    out: get('out') ?? join(sidecars, 'THIRD_PARTY_LICENSES.txt'),
  };
}

export async function generate({ root, sidecars, opencode, out }) {
  if (!existsSync(sidecars)) throw new Error(`No sidecars at ${sidecars}: build them first (pnpm sidecars).`);
  const has = (part) => existsSync(join(sidecars, part));
  const npm = new Map();
  const warnings = [];
  const addNpm = (dir, usedBy) => {
    const e = npmEntry(dir, usedBy);
    if (!e.name || e.name.startsWith('@nvx/')) return;
    const key = `${e.name}@${e.version}`;
    if (npm.has(key)) npm.get(key).usedBy.add(usedBy);
    else npm.set(key, e);
  };
  const workspace = (part, pkgDir) => {
    if (!existsSync(join(root, 'node_modules')))
      throw new Error(
        `The ${part} is shipped but the workspace has no node_modules: run pnpm install first.`,
      );
    const { dirs, unresolved } = closure(pkgDir);
    for (const d of dirs) addNpm(d, part);
    for (const u of unresolved) warnings.push(`${part}: could not resolve ${u}`);
  };

  if (has('core')) {
    for (const d of packagesIn(join(sidecars, 'core', 'node_modules'))) addNpm(d, 'core');
    const proPkg = join(root, 'pro', 'package.json');
    if (has(join('core', 'dist', 'pro.js')) && existsSync(proPkg)) {
      const pro = JSON.parse(readFileSync(proPkg, 'utf8'));
      if (Object.keys(pro.dependencies ?? {}).length) workspace('core', join(root, 'pro'));
    }
  }
  if (has('controller')) workspace('controller', join(root, 'services', 'controller'));
  if (has('cockpit')) workspace('cockpit', join(root, 'apps', 'cockpit'));
  if (has('lab')) {
    const engine = join(opencode, 'packages', 'opencode');
    if (!existsSync(join(opencode, 'node_modules')))
      throw new Error(
        `The lab is shipped but ${opencode} has no node_modules, so its packages cannot be listed. Run the lab build (pnpm sidecars lab) or pass --opencode.`,
      );
    const { dirs, unresolved } = closure(engine, {
      fallbacks: [join(opencode, 'node_modules', '.bun', 'node_modules')],
    });
    for (const d of dirs) addNpm(d, 'lab');
    for (const u of unresolved) warnings.push(`lab: could not resolve ${u}`);
  }

  let python = [];
  if (has('knowledge')) {
    const sp = sitePackages(join(sidecars, 'knowledge', 'python'));
    if (!sp) throw new Error('The Knowledge sidecar has no site-packages.');
    python = pythonEntries(sp);
  }

  // Components: runtimes and binaries that are not packages.
  const components = [];
  const component = (c) => components.push({ files: [], usedBy: new Set(), ...c });
  if (has('node')) {
    const { dir, version } = nodeRuntime(sidecars);
    component({
      name: 'Node.js',
      version,
      licence: 'MIT',
      source: 'https://nodejs.org',
      note: 'The runtime for Core and the Controller. Its LICENSE includes the licences of the libraries built into it.',
      usedBy: new Set(['node']),
      files: [{ name: 'LICENSE', text: await nodeLicence(dir, version) }],
    });
  }
  if (has('knowledge')) {
    const py = join(sidecars, 'knowledge', 'python');
    const candidates = [join(py, 'LICENSE.txt')];
    const lib = join(py, 'lib');
    if (existsSync(lib))
      for (const d of readdirSync(lib))
        if (/^python3\.\d+$/.test(d)) candidates.push(join(lib, d, 'LICENSE.txt'));
    const files = candidates
      .filter(existsSync)
      .map((p) => ({ name: relative(py, p).replace(/\\/g, '/'), text: read(p) }));
    for (const rel of listFiles(py)
      .filter((f) => basename(f) === 'license.terms')
      .sort())
      files.push({ name: rel.replace(/\\/g, '/'), text: read(join(py, rel)) });
    component({
      name: 'CPython (python-build-standalone)',
      version: basename(dirname(sitePackages(py) ?? '')) || '',
      licence: 'PSF-2.0',
      source: 'https://www.python.org · https://github.com/astral-sh/python-build-standalone',
      note: 'The Knowledge service runtime. The licence text covers the interpreter and the libraries in the build (Tcl/Tk, OpenSSL, SQLite, libffi and others).',
      usedBy: new Set(['knowledge']),
      files,
    });
  }
  if (has('pg0')) {
    const v = pg0Version(root);
    component({
      name: 'pg0',
      version: v,
      licence: 'MIT',
      source: 'https://github.com/vectorize-io/pg0',
      note: 'The embedded database runner. pg0 declares MIT in its Cargo.toml and publishes no LICENSE file, so the standard MIT text is given with its authors as holder. Its Linux builds also carry libxml2 (MIT) and ICU (Unicode-3.0).',
      usedBy: new Set(['pg0']),
      standard: { id: 'MIT', text: standardText('MIT', 'the pg0 authors (vectorize-io)') },
    });
    component({
      name: 'PostgreSQL',
      version: '18 (bundled by pg0)',
      licence: 'PostgreSQL',
      source: 'https://www.postgresql.org',
      usedBy: new Set(['pg0']),
      files: [{ name: 'COPYRIGHT', text: read(join(TEXTS, 'PostgreSQL.txt')) }],
    });
    component({
      name: 'pgvector',
      version: '0.8.5 (bundled by pg0)',
      licence: 'PostgreSQL',
      source: 'https://github.com/pgvector/pgvector',
      usedBy: new Set(['pg0']),
      files: [{ name: 'LICENSE', text: read(join(TEXTS, 'pgvector.txt')) }],
    });
  }
  if (has('lab')) {
    component({
      name: 'opencode',
      version: JSON.parse(readFileSync(join(opencode, 'packages', 'opencode', 'package.json'), 'utf8'))
        .version,
      licence: 'MIT',
      source: 'https://github.com/sst/opencode',
      note: 'The lab agent engine (vendor/opencode), compiled with Bun into one binary that also contains the Bun runtime (MIT) and the packages listed under "Lab".',
      usedBy: new Set(['lab']),
      files: [{ name: 'LICENSE', text: read(join(opencode, 'LICENSE')) }],
    });
  }
  const openNotebook = join(root, 'services', 'knowledge', 'LICENSE.open-notebook');
  if (has('knowledge') && existsSync(openNotebook))
    component({
      name: 'Open Notebook',
      licence: 'MIT',
      source: 'https://github.com/lfnovo/open-notebook',
      note: 'The Knowledge service reimplements parts of its model.',
      usedBy: new Set(['knowledge']),
      files: [{ name: 'LICENSE', text: read(openNotebook) }],
    });
  const fonts = join(root, 'packages', 'aperture', 'src', 'fonts', 'LICENSE.txt');
  if (has('cockpit') && existsSync(fonts))
    component({
      name: 'Archivo and Martian Mono fonts',
      licence: 'OFL-1.1',
      note: 'The interface typefaces, bundled with the Cockpit.',
      usedBy: new Set(['cockpit']),
      files: [{ name: 'LICENSE.txt', text: read(fonts) }],
    });

  // Fill missing texts from the standard ones, then judge every entry.
  const problems = [];
  const all = [...components, ...npm.values(), ...python];
  for (const e of all) {
    const verdict = classify(e.licence);
    e.status = verdict.status;
    if (verdict.status !== 'allowed')
      problems.push(
        `${e.name}@${e.version ?? ''}: ${verdict.status} licence "${e.licence || 'none'}" (${[...e.usedBy].join(', ')})`,
      );
    if (!e.files.length && !e.standard) {
      const s = standardFor(e.licence, e.copyright ?? e.author ?? `the ${e.name} authors`);
      if (s) e.standard = s;
      else
        problems.push(
          `${e.name}@${e.version ?? ''}: no licence text in the distribution and none on file for "${e.licence}"`,
        );
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version));
  const npmList = [...npm.values()].sort(byName);
  const sections = [
    ['Runtimes and components', components],
    [
      'Node packages (Core, Cockpit, Controller)',
      npmList.filter((e) => [...e.usedBy].some((u) => u !== 'lab')),
    ],
    [
      'Lab engine packages (inside the lab binary)',
      npmList.filter((e) => [...e.usedBy].every((u) => u === 'lab')),
    ],
    ['Python packages (Knowledge service)', python.sort(byName)],
  ];
  const counts = {};
  for (const e of all) counts[e.licence || 'none'] = (counts[e.licence || 'none'] ?? 0) + 1;
  const now = new Date().toISOString().slice(0, 10);
  const header = [
    HEAVY,
    'NVX Ancile: third-party software',
    HEAVY,
    '',
    'NVX Ancile is free software under the GNU General Public License, version 3',
    'or later (see LICENSE). The installed app also contains the software below,',
    'each under its own licence, reproduced in full. Generated by',
    `apps/desktop/scripts/third-party-licenses.mjs on ${now} for ${process.platform}-${process.arch}.`,
    '',
    'Contents',
    ...sections.map(([title, list]) => `  ${title}: ${list.length}`),
    '',
  ].join('\n');
  const body = sections
    .filter(([, list]) => list.length)
    .map(([title, list]) => [HEAVY, title.toUpperCase(), HEAVY, '', ...list.map(entryText)].join('\n'))
    .join('\n\n');
  writeFileSync(out, `${header}\n${body}\n`);

  const notice = join(root, 'NOTICE.md');
  if (existsSync(notice)) copyFileSync(notice, join(dirname(out), 'NOTICE.md'));
  else warnings.push('NOTICE.md is not in this checkout, so it is not shipped beside the licences.');

  return {
    out,
    counts,
    sections: sections.map(([t, l]) => [t, l.length]),
    problems,
    warnings,
    total: all.length,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = await generate(opts);
  console.log(`Third-party licences: ${r.total} entries → ${r.out}`);
  for (const [t, n] of r.sections) console.log(`  ${t.padEnd(46)} ${n}`);
  console.log('By licence:');
  for (const [id, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${id}`);
  for (const w of r.warnings) console.warn(`Warning: ${w}`);
  if (r.problems.length) {
    console.error(`\n${r.problems.length} shipped package(s) need attention before a release:`);
    for (const p of r.problems) console.error(`  ${p}`);
    console.error(
      'Fix: drop or replace the package, or, after checking its real licence upstream, add it to OVERRIDES in apps/desktop/scripts/third-party-licenses.mjs.',
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
