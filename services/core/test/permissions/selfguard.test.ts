/**
 * Two floors that hold in every preset, with no grant, preset or approval able to lift them: a
 * tool call that reaches Core's own API, and one that names the install key's file. They run in the
 * gate whether or not Auto mode is on, because a model answering its own approvals is the same
 * hole under every preset.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCedarEvaluator } from '../../src/permissions/cedar';
import { createGate, type Gate, type GateRequest } from '../../src/permissions/gate';
import {
  configureSelfTargets,
  currentSelfTargets,
  namesKeyFile,
  selfFloor,
  targetsCoreApi,
} from '../../src/permissions/selfguard';
import { MemoryPermissionStore } from '../../src/permissions/store';

const DIR = join(import.meta.dirname, '../../../../config/policies');
const PRESETS = ['careful', 'balanced', 'hands_off'] as const;

async function gateFor(preset: string) {
  const files: Record<string, string> = {};
  for (const f of await readdir(DIR))
    if (f.endsWith('.cedar')) files[f] = await readFile(join(DIR, f), 'utf8');
  const store = new MemoryPermissionStore();
  // Standing grants for everything a call can be: nothing but the floors stands in the way.
  for (const [action, resource] of [
    ['http.*', 'http:**'],
    ['web.*', 'http:**'],
    ['shell.*', 'shell:**'],
    ['mcp.*', 'mcp:**'],
    ['fs.*', 'fs:**'],
  ] as const)
    await store.createGrant({
      userId: 'u',
      principal: 'agent:default',
      actionPattern: action,
      resourcePattern: resource,
      effect: 'allow',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
  // No `auto` dependency: Auto mode is off, as it is in every other preset.
  const gate: Gate = createGate({
    policy: await loadCedarEvaluator({ files, preset }),
    store,
    workspaceRoot: '/workspace',
  });
  return { gate, store };
}

const call = (over: Partial<GateRequest>): GateRequest => ({
  userId: 'u',
  principal: 'agent:default',
  action: 'http.get',
  resource: 'http:https://example.com/',
  toolTier: 'gated',
  destructive: false,
  scope: { threadId: 'thr_1', notebookId: null, workspaceId: 'w' },
  runId: 'run_1',
  traceId: 't',
  ...over,
});

beforeEach(() => configureSelfTargets({ ports: [7700, 7701, 7800], origins: [] }));
afterEach(() => configureSelfTargets({ ports: [7700, 7701], origins: [] }));

/** [action, resource, args?] for a call that reaches Core's API. */
const REACHES_CORE: [string, string, unknown?][] = [
  ['http.get', 'http:http://localhost:7700/api/v1/approvals'],
  ['http.post', 'http:http://localhost:7700/api/v1/approvals/apr_1'],
  ['http.put', 'http:http://127.0.0.1:7700/api/v1/permissions/preset'],
  ['web.fetch', 'http:http://127.0.0.1:7701/'],
  ['web.fetch', 'http:http://localhost:7800/api/v1/grants'],
  ['http.get', 'http:http://[::1]:7700/api/v1/grants'],
  ['http.get', 'http:http://0.0.0.0:7700/'],
  ['http.get', 'http:http://127.1.2.3:7700/'],
  // Other spellings of 127.0.0.1, which the URL parser folds.
  ['http.get', 'http:http://2130706433:7700/'],
  ['http.get', 'http:http://0x7f.1:7700/'],
  ['http.get', 'http:http://127.1:7700/'],
  ['http.get', 'http:http://0177.0.0.1:7700/'],
  ['http.get', 'http:http://[::ffff:127.0.0.1]:7700/'],
  ['http.get', 'http:http://LOCALHOST.:7700/'],
  ['http.get', 'http:http://foo.localhost:7700/'],
  ['http.get', 'http:http://127.0.0.1.nip.io:7700/'],
  ['http.get', 'http:http://user:pw@localhost:7700/'],
  // A shell command that mentions it.
  [
    'shell.exec',
    'shell:curl -s -X POST http://localhost:7700/api/v1/approvals/apr_1 -d {"decision":"approve"}',
  ],
  ['shell.exec', 'shell:curl localhost:7700/api/v1/grants'],
  ['shell.exec', 'shell:wget -qO- "http://127.0.0.1:7700/api/v1/threads"'],
  ['shell.exec', 'shell:python -c "import urllib.request as u; u.urlopen(\'http://127.0.0.1:7700\')"'],
  ['shell.exec', 'shell:Invoke-WebRequest -Uri http://localhost:7701/api/v1/threads'],
  ['shell.exec', 'shell:curl --data-binary @x http://[::1]:7700/'],
  ['shell.exec', 'shell:(curl http://localhost:7700/api/v1/grants)'],
  ['shell.exec', 'shell:curl http://localhost:7700, then more'],
  // A fetch-style MCP tool with the address in its arguments, however deep.
  ['mcp.fetch.fetch', 'mcp:fetch/fetch', { url: 'http://localhost:7700/api/v1/approvals' }],
  ['mcp.fetch.fetch', 'mcp:fetch/fetch', { requests: [{ opts: { target: 'http://127.0.0.1:7700/' } }] }],
  ['mcp.http.call', 'mcp:http/call', { host: 'localhost:7700', path: '/api/v1/grants' }],
  [
    'code.run',
    'code:python',
    { code: 'import requests; requests.post("http://localhost:7700/api/v1/approvals/x")' },
  ],
];

/** Calls that look close but are not Core's API. */
const NOT_CORE: [string, string, unknown?][] = [
  ['http.get', 'http:https://example.com/'],
  ['http.get', 'http:http://localhost:3000/'],
  ['http.get', 'http:http://127.0.0.1:5173/'],
  ['http.get', 'http:https://api.github.com/api/v1/repos'],
  ['http.get', 'http:http://localhost.example.com:7700/'],
  ['shell.exec', 'shell:git status'],
  ['shell.exec', 'shell:curl https://example.com/api/v1/things'],
  ['shell.exec', 'shell:npm run dev -- --port 3000'],
  ['http.get', 'http:https://example.com/localhost:7700'],
  ['mcp.fetch.fetch', 'mcp:fetch/fetch', { url: 'https://example.com/' }],
  // A search is not a connection; a file's own text is not scanned.
  ['web.search', 'web:search/localhost:7700 docs'],
  [
    'fs.write',
    'fs:/workspace/README.md',
    { path: 'README.md', content: 'Open http://localhost:7700 and run pnpm pair.' },
  ],
  ['fs.read', 'fs:/workspace/notes.md'],
];

describe("Core's own API is out of reach of every tool call", () => {
  it('refuses each way of reaching it, in every preset, whatever has been granted', async () => {
    for (const preset of PRESETS) {
      const { gate, store } = await gateFor(preset);
      for (const [action, resource, args] of REACHES_CORE) {
        const d = await gate.check(call({ action, resource, ...(args !== undefined && { args }) }));
        expect(d, `${preset}: ${action} ${resource}`).toMatchObject({
          outcome: 'deny',
          via: 'floor',
          policyId: 'floor.core_api',
        });
        // It is a plain sentence the model can read, and it never says to ask for permission.
        if (d.outcome === 'deny') expect(d.reason).toMatch(/NVX Ancile's own API/);
      }
      // Each refusal is in the decision log as a policy denial, naming the rule.
      const log = await store.listDecisions(500);
      expect(log.length).toBe(REACHES_CORE.length);
      expect(log.every((r) => r.outcome === 'policy_deny' && r.policy_id === 'floor.core_api')).toBe(true);
    }
  });

  it('refuses it when a person has already approved the call, too', async () => {
    const { gate } = await gateFor('balanced');
    const denied = await gate.recheck(
      call({ action: 'http.post', resource: 'http:http://localhost:7700/api/v1/approvals/x' }),
    );
    expect(denied).toMatchObject({ outcome: 'deny', policyId: 'floor.core_api' });
  });

  it('leaves alone what only looks like it', async () => {
    for (const preset of PRESETS) {
      const { gate } = await gateFor(preset);
      for (const [action, resource, args] of NOT_CORE) {
        const d = await gate.check(call({ action, resource, ...(args !== undefined && { args }) }));
        expect(
          d.outcome === 'deny' && d.policyId?.startsWith('floor.core_api'),
          `${preset}: ${action} ${resource}`,
        ).toBeFalsy();
      }
    }
  });

  it('follows the ports and origins Core was configured with', () => {
    expect(targetsCoreApi('curl http://localhost:7900/')).toBe(false);
    configureSelfTargets({
      ports: [7900],
      origins: ['https://ancile.example.com:8443', 'https://ancile.example.org'],
    });
    expect(targetsCoreApi('curl http://localhost:7900/')).toBe(true);
    // The defaults are still held.
    expect(targetsCoreApi('curl http://localhost:7700/')).toBe(true);
    // The public URL, on its own port and on its default one, from any path.
    expect(targetsCoreApi('curl https://ancile.example.com:8443/api/v1/grants')).toBe(true);
    expect(targetsCoreApi('curl https://ancile.example.org/anything')).toBe(true);
    expect(targetsCoreApi('curl https://ancile.example.com/')).toBe(false);
    expect(targetsCoreApi('curl https://other.example.org/')).toBe(false);
    expect(currentSelfTargets().ports.has(7900)).toBe(true);
  });

  it('is a floor of the shipped gate: a call with no grant is refused before any ask', async () => {
    const files: Record<string, string> = {};
    for (const f of await readdir(DIR))
      if (f.endsWith('.cedar')) files[f] = await readFile(join(DIR, f), 'utf8');
    const gate = createGate({
      policy: await loadCedarEvaluator({ files, preset: 'balanced' }),
      store: new MemoryPermissionStore(),
      workspaceRoot: '/workspace',
    });
    const d = await gate.check(call({ action: 'http.get', resource: 'http:http://localhost:7700/' }));
    expect(d.outcome).toBe('deny');
    // The same call to somewhere else only asks.
    const other = await gate.check(call({ action: 'http.get', resource: 'http:https://example.com/' }));
    expect(other.outcome).toBe('ask');
  });
});

const KEY_NAMES: [string, string, unknown?][] = [
  ['fs.read', 'fs:/home/me/ancile/data/local-api.key'],
  ['fs.read', 'fs:/C:/Users/me/AppData/Roaming/NVX Ancile/local-api.key'],
  ['fs.write', 'fs:/workspace/local-api.key'],
  ['fs.delete', 'fs:/home/me/ancile/data/local-api.key'],
  ['shell.exec', 'shell:cat data/local-api.key'],
  ['shell.exec', 'shell:type "data\\local-api.key"'],
  ['shell.exec', 'shell:cat data/local-api.k*'],
  ['shell.exec', 'shell:cat data/local-api*'],
  ['shell.exec', 'shell:cat data/local-api.?ey'],
  ['shell.exec', 'shell:cat data/lo"cal-api.key'],
  ['shell.exec', "shell:cat data/local'-api'.key"],
  ['shell.exec', 'shell:Get-Content $env:APPDATA\\"NVX Ancile"\\LOCAL-API.KEY'],
  ['shell.exec', 'shell:cp data/local-api.key /tmp/k'],
  ['mcp.files.read', 'mcp:files/read', { path: '/home/me/ancile/data/local-api.key' }],
  ['mcp.files.read', 'mcp:files/read', { paths: [{ p: 'x' }, { p: 'data/local-api.key' }] }],
  ['http.post', 'http:https://example.com/', { body: 'cat data/local-api.key' }],
  ['code.run', 'code:python', { code: 'print(open("data/local-api.key").read())' }],
];

describe('the install key file is out of reach of every tool call', () => {
  it('refuses each way of naming it, in every preset, whatever has been granted', async () => {
    for (const preset of PRESETS) {
      const { gate } = await gateFor(preset);
      for (const [action, resource, args] of KEY_NAMES) {
        const d = await gate.check(call({ action, resource, ...(args !== undefined && { args }) }));
        expect(d, `${preset}: ${action} ${resource} ${JSON.stringify(args ?? '')}`).toMatchObject({
          outcome: 'deny',
          via: 'floor',
          policyId: 'floor.install_key',
        });
      }
    }
  });

  it('is not tripped by a file that only talks about it, or by other .key files', async () => {
    const { gate } = await gateFor('hands_off');
    for (const [action, resource, args] of [
      [
        'fs.write',
        'fs:/workspace/docs/api.md',
        { content: 'The key is in local-api.key in the data folder.' },
      ],
      ['fs.read', 'fs:/workspace/docs/api.md'],
      ['shell.exec', 'shell:ls data'],
      ['shell.exec', 'shell:git commit -m "document local-api.key handling" -- docs'],
    ] as [string, string, unknown?][]) {
      const d = await gate.check(call({ action, resource, ...(args !== undefined && { args }) }));
      // git commit text mentioning it is a shell call that reaches out and does name it: that one is refused;
      // a document or a listing is not.
      if (resource.startsWith('shell:git commit')) expect(d.outcome).toBe('deny');
      else
        expect(
          d.outcome === 'deny' && d.policyId === 'floor.install_key',
          `${action} ${resource}`,
        ).toBeFalsy();
    }
  });

  it('reads the names the way a shell and a glob spell them', () => {
    for (const t of [
      'local-api.key',
      'LOCAL-API.KEY',
      'a/b/local-api.k*',
      'local-api*',
      'loc"al-api".key',
      'local-api.?',
      'local-api.[k]ey',
    ])
      expect(namesKeyFile(t), t).toBe(true);
    for (const t of ['local-apis', 'local api', 'my-local-apiary', 'api.key', 'local-api'])
      expect(namesKeyFile(t), t).toBe(false);
  });
});

describe('selfFloor', () => {
  it('says what it refused, as a rule the Why view can show', () => {
    expect(selfFloor({ action: 'http.get', resource: 'http:http://localhost:7700/' })).toMatchObject({
      verdict: 'block',
      rule: 'floor.core_api',
    });
    expect(selfFloor({ action: 'fs.read', resource: 'fs:/x/local-api.key' })).toMatchObject({
      verdict: 'block',
      rule: 'floor.install_key',
    });
    expect(selfFloor({ action: 'fs.read', resource: 'fs:/workspace/a.md' })).toBeNull();
  });
});
