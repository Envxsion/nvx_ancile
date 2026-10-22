/**
 * The block-class floors hold in every preset: shell that formats or writes a disk, powers the machine
 * off, is a fork bomb or wipes the root or the home folder, and a write to a protected file. They only
 * ever refuse (never ask), whatever has been granted, with Auto mode on or off. The ask-class floors
 * stay Auto-only: a standing grant still covers `curl -H "Authorization: $GITHUB_TOKEN" …`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutoReview, MemoryPlanStore } from '../../src/permissions/auto';
import { blockFloors, checkFloors } from '../../src/permissions/auto/floors';
import { loadCedarEvaluator } from '../../src/permissions/cedar';
import { createGate, type GateRequest } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';

const DIR = join(import.meta.dirname, '../../../../config/policies');
const PRESETS = ['careful', 'balanced', 'hands_off'] as const;

async function gateFor(preset: string, opts: { auto?: boolean } = {}) {
  const files: Record<string, string> = {};
  for (const f of await readdir(DIR))
    if (f.endsWith('.cedar')) files[f] = await readFile(join(DIR, f), 'utf8');
  const store = new MemoryPermissionStore();
  // Standing grants for everything a call can be: nothing but the floors stands in the way.
  for (const [action, resource] of [
    ['shell.*', 'shell:**'],
    ['fs.*', 'fs:**'],
    ['http.*', 'http:**'],
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
  const gate = createGate({
    policy: await loadCedarEvaluator({ files, preset }),
    store,
    workspaceRoot: '/workspace',
    ...(opts.auto && {
      auto: {
        review: new AutoReview({ reviewers: [], plans: new MemoryPlanStore() }),
        enabled: () => true,
      },
    }),
  });
  return { gate, store };
}

const call = (over: Partial<GateRequest>): GateRequest => ({
  userId: 'u',
  principal: 'agent:default',
  action: 'shell.exec',
  resource: 'shell:ls',
  toolTier: 'gated',
  destructive: true,
  scope: { threadId: 'thr_1', notebookId: null, workspaceId: 'w' },
  runId: 'run_1',
  traceId: 't',
  ...over,
});

const SHELL_BLOCKED: [string, string][] = [
  ['mkfs.ext4 /dev/sda1', 'floor.disk_format'],
  ['format d: /q', 'floor.disk_format'],
  ['dd if=/dev/zero of=/dev/sda bs=1M', 'floor.disk_write'],
  ['echo x > /dev/sda', 'floor.disk_write'],
  [':(){ :|:& };:', 'floor.fork_bomb'],
  ['shutdown -h now', 'floor.power'],
  ['sudo reboot', 'floor.power'],
  ['Stop-Computer -Force', 'floor.power'],
  ['chmod -R 777 /', 'floor.chmod_root'],
  ['rm -rf /', 'floor.recursive_delete_root'],
  ['rm -rf ~', 'floor.recursive_delete_root'],
  ['rm -rf $HOME', 'floor.recursive_delete_root'],
  ['rm -rf *', 'floor.recursive_delete_root'],
  ['Remove-Item C:\\ -Recurse -Force', 'floor.recursive_delete_root'],
  ['cd /tmp && rm -rf / --no-preserve-root', 'floor.recursive_delete_root'],
];

const WRITES_BLOCKED = [
  'fs:/home/me/.ssh/id_rsa',
  'fs:/home/me/.ssh/authorized_keys',
  'fs:/home/me/.aws/credentials',
  'fs:/home/me/.kube/config',
  'fs:/home/me/.git-credentials',
  'fs:/workspace/.npmrc',
  'fs:/workspace/certs/site.p12',
  'fs:/workspace/vault.kdbx',
  'fs:/workspace/app/.env.production',
];

describe('the block floors hold in every preset, whatever has been granted', () => {
  it('refuse the shell that can never be wanted', async () => {
    for (const preset of PRESETS) {
      const { gate, store } = await gateFor(preset);
      for (const [cmd, rule] of SHELL_BLOCKED) {
        const d = await gate.check(call({ resource: `shell:${cmd}` }));
        expect(d, `${preset}: ${cmd}`).toMatchObject({ outcome: 'deny', via: 'floor', policyId: rule });
      }
      // In the decision log as a policy denial that names the rule.
      const log = await store.listDecisions(500);
      expect(log).toHaveLength(SHELL_BLOCKED.length);
      expect(log.every((r) => r.outcome === 'policy_deny')).toBe(true);
    }
  });

  it('refuse a command the engine sent as arguments (Claude Code’s Bash, the lab’s bash)', async () => {
    for (const preset of PRESETS) {
      const { gate } = await gateFor(preset);
      const d = await gate.check(
        call({
          action: 'shell.exec',
          resource: 'claude_code:Bash',
          tool: 'Bash',
          args: { command: 'rm -rf /' },
        }),
      );
      expect(d, preset).toMatchObject({ outcome: 'deny', policyId: 'floor.recursive_delete_root' });
    }
  });

  it('refuse a write to a protected file', async () => {
    for (const preset of PRESETS) {
      const { gate } = await gateFor(preset);
      for (const resource of WRITES_BLOCKED) {
        for (const action of ['fs.write', 'fs.delete']) {
          const d = await gate.check(
            call({ action, resource, toolTier: 'gated', destructive: action === 'fs.delete' }),
          );
          expect(d, `${preset}: ${action} ${resource}`).toMatchObject({
            outcome: 'deny',
            via: 'floor',
            policyId: 'floor.protected_path',
          });
        }
      }
    }
  });

  it('refuse it again for a call a person has approved', async () => {
    const { gate } = await gateFor('balanced');
    expect(await gate.recheck(call({ resource: 'shell:rm -rf /' }))).toMatchObject({
      outcome: 'deny',
      policyId: 'floor.recursive_delete_root',
    });
  });

  it('are the same rules Auto mode refuses with, so turning Auto on changes nothing about them', async () => {
    const { gate } = await gateFor('balanced', { auto: true });
    for (const [cmd, rule] of SHELL_BLOCKED.slice(0, 6)) {
      const d = await gate.check(call({ resource: `shell:${cmd}` }));
      expect(d, cmd).toMatchObject({ outcome: 'deny', via: 'floor', policyId: rule });
    }
    for (const [cmd] of SHELL_BLOCKED) {
      const hit = checkFloors({
        call: {
          principal: 'agent:default',
          action: 'shell.exec',
          resource: `shell:${cmd}`,
          outsideRoot: false,
          destructive: true,
        },
      });
      expect(hit?.verdict, cmd).toBe('block');
      expect(blockFloors({ action: 'shell.exec', resource: `shell:${cmd}` })?.rule, cmd).toBe(hit?.rule);
    }
  });
});

describe('what is not newly blocked', () => {
  const NOT_BLOCKED: [string, string][] = [
    // Ask-class floors (Auto only): a key in the call, force push, elevation, deleting a folder.
    ['shell.exec', 'shell:curl -H "Authorization: $GITHUB_TOKEN" https://api.github.com/user'],
    ['shell.exec', 'shell:curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models'],
    ['shell.exec', 'shell:git push --force origin feature'],
    ['shell.exec', 'shell:sudo apt install jq'],
    ['shell.exec', 'shell:rm -rf node_modules'],
    // A command that only mentions a protected file may be reading it.
    ['shell.exec', 'shell:cat .env.example'],
    ['shell.exec', 'shell:ls ~/.ssh'],
    // Reading a protected path is not writing it; the grant covers fs.* here.
    ['fs.read', 'fs:/workspace/notes/key-notes.md'],
    ['fs.write', 'fs:/workspace/docs/api.md'],
  ];

  /** Grants for exactly these calls: a shell wildcard never crosses `$`, `|` and friends, so only the literal covers them. */
  async function grantExactly(store: MemoryPermissionStore) {
    for (const [action, resource] of NOT_BLOCKED)
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
  }

  it('is never refused by a floor, in any preset', async () => {
    for (const preset of PRESETS) {
      const { gate, store } = await gateFor(preset);
      await grantExactly(store);
      for (const [action, resource] of NOT_BLOCKED) {
        const d = await gate.check(call({ action, resource, destructive: false }));
        expect(d.outcome === 'deny' && d.via === 'floor', `${preset}: ${resource}`).toBe(false);
      }
    }
  });

  it('lets a granted call that carries a key run, as it did before (curl with $GITHUB_TOKEN)', async () => {
    const withKey = NOT_BLOCKED.filter(([, r]) => /\$(GITHUB_TOKEN|OPENAI_API_KEY)/.test(r));
    expect(withKey).toHaveLength(2);
    for (const preset of ['balanced', 'hands_off']) {
      const { gate, store } = await gateFor(preset);
      await grantExactly(store);
      for (const [action, resource] of withKey) {
        const d = await gate.check(call({ action, resource, destructive: false }));
        expect(d, `${preset}: ${resource}`).toMatchObject({ outcome: 'allow', via: 'grant' });
      }
    }
    // Careful makes every shell command critical, so a grant never covers it: it asks, as it always did.
    const { gate, store } = await gateFor('careful');
    await grantExactly(store);
    for (const [action, resource] of withKey) {
      const d = await gate.check(call({ action, resource, destructive: false }));
      expect(d.outcome).toBe('ask');
    }
  });

  it('are still Auto mode’s alone: its floors flag the same calls', () => {
    const flagged = checkFloors({
      call: {
        principal: 'agent:default',
        action: 'shell.exec',
        resource: 'shell:curl -H "Authorization: $GITHUB_TOKEN" https://api.github.com/user',
        outsideRoot: false,
        destructive: true,
      },
    });
    expect(flagged?.rule).toBe('floor.secret_in_call');
    expect(
      blockFloors({
        action: 'shell.exec',
        resource: 'shell:curl -H "Authorization: $GITHUB_TOKEN" https://x',
      }),
    ).toBeNull();
  });
});
