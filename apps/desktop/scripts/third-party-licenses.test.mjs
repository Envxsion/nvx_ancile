/**
 * The licence gate: SPDX expressions judged against the allow and deny
 * lists, free-text and classifier names mapped to SPDX, Python METADATA
 * parsed, licences detected from text, and a dependency closure walked
 * through a node_modules tree the way Node resolves it.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classify,
  closure,
  detectFromText,
  licenceOfPackageJson,
  normaliseId,
  parseMetadata,
  pythonLicence,
  standardText,
} from './third-party-licenses.mjs';

describe('classify', () => {
  it('allows permissive and weak-copyleft licences', () => {
    for (const e of ['MIT', 'apache-2.0', 'BSD-3-Clause', 'ISC', 'LGPL-3.0-only', 'PSF-2.0', 'MPL-2.0'])
      assert.equal(classify(e).status, 'allowed', e);
  });
  it('denies AGPL, SSPL, UNLICENSED, proprietary and "SEE LICENSE IN"', () => {
    for (const e of [
      'AGPL-3.0-or-later',
      'SSPL-1.0',
      'UNLICENSED',
      'SEE LICENSE IN LICENSE.md',
      'LicenseRef-NVX-Proprietary',
      'Proprietary licence',
      'MIT AND (SSPL-1.0)',
      'BUSL-1.1',
      'Elastic-2.0',
    ])
      assert.equal(classify(e).status, 'denied', e);
  });
  it('treats anything it does not know as unknown, including nothing', () => {
    assert.equal(classify('').status, 'unknown');
    assert.equal(classify('Some-Custom-Licence').status, 'unknown');
    assert.equal(classify('LicenseRef-Whatever').status, 'unknown');
  });
  it('OR takes the best alternative, AND the worst part', () => {
    assert.equal(classify('EPL-2.0 OR GPL-3.0-or-later').status, 'allowed');
    assert.equal(classify('(MIT OR AGPL-3.0-only)').status, 'allowed');
    assert.equal(classify('MIT AND AGPL-3.0-only').status, 'denied');
    assert.equal(classify('MIT AND Foo-1.0').status, 'unknown');
    assert.equal(classify('(Apache-2.0 OR BSD-3-Clause) AND BSD-3-Clause AND CC-BY-4.0').status, 'allowed');
    assert.equal(classify('Apache-2.0 WITH LLVM-exception').status, 'allowed');
  });
  it('reports the ids it saw', () => {
    assert.deepEqual(classify('(MIT OR CC0-1.0)').ids, ['MIT', 'CC0-1.0']);
  });
});

describe('normaliseId', () => {
  it('maps free text and classifier names to SPDX', () => {
    assert.equal(normaliseId('MIT License'), 'MIT');
    assert.equal(normaliseId('License :: OSI Approved :: Apache Software License'), 'Apache-2.0');
    assert.equal(normaliseId('3-Clause BSD License'), 'BSD-3-Clause');
    assert.equal(normaliseId('PSFL'), 'PSF-2.0');
    assert.equal(normaliseId('apache-2.0'), 'Apache-2.0');
    assert.equal(normaliseId('LGPL-2.1+'), 'LGPL-2.1-or-later');
  });
});

describe('licenceOfPackageJson', () => {
  it('reads string, object and legacy array forms', () => {
    assert.equal(licenceOfPackageJson({ license: 'MIT' }), 'MIT');
    assert.equal(licenceOfPackageJson({ license: { type: 'ISC' } }), 'ISC');
    assert.equal(
      licenceOfPackageJson({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
      '(MIT OR Apache-2.0)',
    );
    assert.equal(licenceOfPackageJson({}), '');
  });
});

describe('Python metadata', () => {
  const META = [
    'Metadata-Version: 2.4',
    'Name: example',
    'Version: 1.0',
    'License: Copyright (c) 2001 Someone',
    '        All rights reserved.',
    'Classifier: License :: OSI Approved :: BSD License',
    'Classifier: Programming Language :: Python',
    '',
    'License: in the body, ignored',
  ].join('\n');

  it('parses header fields and continuation lines, not the body', () => {
    const m = parseMetadata(META);
    assert.equal(m.Name[0], 'example');
    assert.equal(m.License.length, 1);
    assert.match(m.License[0], /All rights reserved/);
    assert.equal(m.Classifier.length, 2);
  });
  it('prefers License-Expression', () => {
    assert.deepEqual(pythonLicence({ 'License-Expression': ['MIT'], License: ['BSD'] }), {
      licence: 'MIT',
      from: 'License-Expression',
    });
  });
  it('uses a short License field when it names a licence', () => {
    assert.equal(pythonLicence({ License: ['MIT License'] }).licence, 'MIT');
  });
  it('resolves a generic "BSD License" classifier from the licence text', () => {
    const r = pythonLicence(
      parseMetadata(META),
      'Redistribution and use in source and binary forms ... Neither the name of',
    );
    assert.deepEqual(r, { licence: 'BSD-3-Clause', from: 'licence text' });
  });
  it('maps specific classifiers, several as OR', () => {
    const r = pythonLicence({
      Classifier: [
        'License :: OSI Approved :: MIT License',
        'License :: OSI Approved :: Apache Software License',
      ],
    });
    assert.equal(r.licence, 'MIT OR Apache-2.0');
  });
  it('gives nothing (so the gate fails) when nothing says', () => {
    assert.equal(classify(pythonLicence({}).licence).status, 'unknown');
  });
});

describe('detectFromText', () => {
  it('recognises the common texts', () => {
    assert.equal(detectFromText(standardText('MIT', 'x')), 'MIT');
    assert.equal(detectFromText(standardText('ISC', 'x')), 'ISC');
    assert.equal(detectFromText(standardText('0BSD', 'x')), '0BSD');
    assert.equal(detectFromText(standardText('BSD-2-Clause', 'x')), 'BSD-2-Clause');
    assert.equal(detectFromText(standardText('BSD-3-Clause', 'x')), 'BSD-3-Clause');
    assert.equal(detectFromText(standardText('Apache-2.0')), 'Apache-2.0');
    assert.equal(detectFromText('All rights reserved.'), null);
  });
  it('fills the copyright line of a standard text', () => {
    assert.match(standardText('MIT', 'Microsoft Corporation.'), /^Copyright \(c\) Microsoft Corporation\.$/m);
    assert.equal(standardText('No-Such-Licence'), null);
  });
});

describe('closure', () => {
  it('follows production and installed optional dependencies through node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'tpl-'));
    const pkg = (dir, json) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
    };
    const app = join(root, 'app');
    pkg(app, {
      name: 'app',
      version: '1.0.0',
      dependencies: { a: '1', ws: '1' },
      devDependencies: { dev: '1' },
      optionalDependencies: { missing: '1' },
    });
    // A workspace package (outside node_modules): followed, not listed.
    pkg(join(root, 'ws'), { name: 'ws', version: '0.0.0', dependencies: { c: '1' } });
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    pkg(join(app, 'node_modules', 'a'), { name: 'a', version: '1.0.0', dependencies: { b: '1' } });
    pkg(join(app, 'node_modules', 'a', 'node_modules', 'b'), { name: 'b', version: '2.0.0' });
    pkg(join(root, 'node_modules', 'c'), { name: 'c', version: '3.0.0' });
    pkg(join(app, 'node_modules', 'dev'), { name: 'dev', version: '9.9.9' });
    // Resolve "ws" through a fallback folder standing in for a linked layout.
    const fallback = join(root, 'links');
    mkdirSync(fallback, { recursive: true });
    cpSync(join(root, 'ws'), join(fallback, 'ws'), { recursive: true });
    const { dirs, unresolved } = closure(app, { fallbacks: [fallback] });
    const names = dirs.map((d) => d.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ['a', 'b', 'c']);
    assert.deepEqual(unresolved, []);
  });
});
