/**
 * ------------------------------------------------------------------
 *  Title    |  Memory under concurrent writes
 *  Ref      |  DESIGN.md §6.1, §6.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Many writers hit the memory repository at once (the
 *           |  person approving suggestions, capture learning in the
 *           |  background, explicit "remember this", hand edits). Every
 *           |  acknowledged write must land: none lost, none half
 *           |  written, history linear, and the inbox lists newest first.
 *  How      |  Real git repository, real service, no model. Writers are
 *           |  started together and awaited together; then the files,
 *           |  the commit chain and the derived index are checked.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MemoryProposal } from '@nvx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { entries, parseMemory } from '../../src/memory/format';
import { type IndexSource, MemoryIndex } from '../../src/memory/index';
import { MemoryProposalStore } from '../../src/memory/proposals';
import { GitMemoryProvider } from '../../src/memory/repo';
import { DEFAULT_MEMORY_CONFIG, MemoryService } from '../../src/memory/service';
import { MemorySettings } from '../../src/settings';
import { MEMORY_TEMPLATE } from '../support/harness';

const git = promisify(execFile);
const author = { name: 'NVX Ancile', email: 'memory@ancile.local' };

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A memory repository from the template, with the service and index on top, in a temporary folder. */
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'ancile-mem-stress-'));
  dirs.push(dir);
  const provider = new GitMemoryProvider({ root: join(dir, 'memory'), author, template: MEMORY_TEMPLATE });
  const index = new MemoryIndex(provider);
  const proposals = new MemoryProposalStore();
  const service = new MemoryService({
    provider,
    index,
    proposals,
    config: DEFAULT_MEMORY_CONFIG,
    user: { name: 'You', email: 'you@ancile.local' },
    settings: new MemorySettings(),
    idleMs: 0,
  });
  await service.start();
  return { dir, provider, index, proposals, service };
}

/** Sentences that share no words, so memory's own de-duplication never merges two of them. */
const FACTS = [
  'Drinks espresso before standup.',
  'Cycles to the office on dry mornings.',
  'Reads Portuguese novels on trains.',
  'Keeps a sourdough starter named Gerald.',
  'Plays cello at weekends.',
  'Volunteers at the harbour museum.',
  'Collects vintage fountain pens.',
  'Swims lengths every Tuesday.',
  'Grows tomatoes on the balcony.',
  'Photographs lighthouses abroad.',
  'Studies Norwegian with flashcards.',
  'Repairs mechanical watches slowly.',
  'Brews kombucha beside the window.',
  'Hikes ridgelines near Wellington.',
  'Bakes rye loaves for neighbours.',
  'Sketches bridges during lunch.',
  'Tracks migrating swallows each spring.',
  'Restores wooden canoes in winter.',
  'Composes crossword puzzles quietly.',
  'Sails dinghies off Falmouth.',
];

const userMessage = (text: string, extra: object = {}) => ({
  kind: 'preference' as const,
  targetPath: 'USER.md',
  section: 'Preferences',
  text,
  confidence: 0.97,
  evidence: [],
  provenance: 'user_message' as const,
  ...extra,
});

describe('memory repository under concurrent writers', () => {
  /**
   * A hand edit the way the editor makes one: read, change, save with what it read; if the file
   * moved on meanwhile and the two changes clash, read again and retry. In USER.md the line goes
   * under "Code", where Ancile does not write; in the notes file it goes at the end.
   */
  async function handAppend(service: MemoryService, path: string, line: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const now = await service.file(path).catch(() => null);
      const content = now?.content ?? '# Hand notes\n';
      try {
        await service.save(path, {
          content:
            path === 'USER.md'
              ? content.replace('## Code\n', `## Code\n- ${line}\n`)
              : `${content}- ${line}\n`,
          base_sha: now?.version ?? null,
        });
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== 'memory.conflict') throw err;
      }
    }
    throw new Error(`could not save "${line}" after 60 tries`);
  }

  it('every acknowledged write lands, nothing is lost, history stays in one line', async () => {
    const { provider, index, proposals, service } = await rig();
    const textsIn = async (path: string) =>
      entries(parseMemory((await provider.read(path)).content)).map((e) => e.text);
    const explicit = FACTS.slice(0, 6);
    const toApprove = FACTS.slice(6, 10);
    const lessons = FACTS.slice(10, 16);
    const hand = FACTS.slice(16, 20);
    const before = (await provider.log([], 500)).length;

    // Suggestions that wait for a yes (tool output can only propose).
    const waiting: MemoryProposal[] = [];
    for (const text of toApprove) {
      const p = await service.consider(userMessage(text, { provenance: 'tool_output', confidence: 0.9 }));
      expect(p?.status).toBe('proposed');
      waiting.push(p as MemoryProposal);
    }

    await Promise.all([
      // "Remember that ..." saved at once, in the background of other turns.
      ...explicit.map((t) =>
        service.consider(userMessage(t, { explicit: true })).then((p) => {
          expect(p?.status).toBe('auto_applied');
        }),
      ),
      // The person approving suggestions in the inbox, some with edited words.
      ...waiting.map((p, i) =>
        service
          .decide(p.id, { decision: 'approve', ...(i % 2 ? { text: `${toApprove[i]} (edited)` } : {}) })
          .then((r) => {
            expect(r.status).toBe('applied');
          }),
      ),
      // Lessons that worked twice, two to a topic so some share a file.
      ...lessons.map((t, i) =>
        service
          .consider({
            kind: 'failure_lesson',
            targetPath: `FAILURES/topic-${i % 3}.md`,
            section: 'Lessons',
            text: t,
            confidence: 0.8,
            evidence: [],
            provenance: 'run_outcome',
            verified: true,
          })
          .then((p) => {
            expect(p?.status).toBe('auto_applied');
          }),
      ),
      // Hand edits to a file Ancile also writes, and to one only the person writes.
      ...hand.map((t, i) => handAppend(service, i < 2 ? 'USER.md' : 'PROJECTS/hand-notes.md', t)),
    ]);

    // 1. Every text is in the file it was meant for, exactly once.
    const user = await textsIn('USER.md');
    const everyUser = [
      ...explicit,
      ...toApprove.map((t, i) => (i % 2 ? `${t} (edited)` : t)),
      ...hand.slice(0, 2),
    ];
    for (const t of everyUser)
      expect(
        user.filter((x) => x === t),
        `USER.md: ${t}`,
      ).toHaveLength(1);
    const notes = await provider.read('PROJECTS/hand-notes.md');
    for (const t of hand.slice(2)) expect(notes.content).toContain(t);
    const lessonFiles = await Promise.all([0, 1, 2].map((i) => textsIn(`FAILURES/topic-${i}.md`)));
    for (const [i, t] of lessons.entries())
      expect(lessonFiles[i % 3], `FAILURES/topic-${i % 3}.md: ${t}`).toContain(t);

    // 2. Nothing is left half done: no uncommitted change, no stray lock, a healthy repository.
    const status = await git('git', ['status', '--porcelain'], { cwd: provider.root });
    expect(status.stdout.trim()).toBe('');
    expect(await provider.check()).toEqual({ ok: true, problems: [] });

    // 3. History is one line, one commit per write, and no commit ever took an earlier entry away.
    const merges = await git('git', ['rev-list', '--merges', 'HEAD'], { cwd: provider.root });
    expect(merges.stdout.trim()).toBe('');
    const log = await provider.log([], 500);
    expect(log.length - before).toBe(explicit.length + toApprove.length + lessons.length + hand.length);
    const touched = await Promise.all(
      [...log].reverse().map(async (c) => ({
        c,
        files: await Promise.all(
          (await provider.filesOf(c.version))
            .filter((f) => f.endsWith('.md'))
            .map(async (f) => ({
              f,
              texts: new Set(
                entries(parseMemory((await provider.read(f, c.version)).content)).map((e) => e.text),
              ),
            })),
        ),
      })),
    );
    const seen = new Map<string, Set<string>>();
    for (const { c, files } of touched) {
      for (const { f, texts } of files) {
        for (const t of seen.get(f) ?? [])
          expect(texts.has(t), `${f}@${c.version.slice(0, 7)} dropped "${t}"`).toBe(true);
        seen.set(f, texts);
      }
    }

    // 4. Every applied suggestion names a commit that really holds its words.
    const applied = await proposals.list({ status: ['applied', 'auto_applied'], limit: 200 });
    expect(applied).toHaveLength(explicit.length + toApprove.length + lessons.length);
    await Promise.all(
      applied.map(async (p) => {
        expect(p.commit_sha, p.text).toBeTruthy();
        expect(await provider.filesOf(p.commit_sha as string)).toContain(p.target_path);
        const at = entries(parseMemory((await provider.read(p.target_path, p.commit_sha as string)).content));
        expect(at.map((e) => e.text)).toContain(p.text);
      }),
    );

    // 5. The derived index agrees with the files on disk.
    for (const path of ['USER.md', 'FAILURES/topic-0.md', 'FAILURES/topic-1.md', 'FAILURES/topic-2.md']) {
      const onDisk = (await textsIn(path)).sort();
      const indexed = (index.file(path)?.entries ?? []).map((e) => e.text).sort();
      expect(indexed, `index of ${path}`).toEqual(onDisk);
    }
  }, 120_000);

  it('approving the same suggestion twice at once writes it once', async () => {
    const { provider, service } = await rig();
    const p = (await service.consider(
      userMessage('Prefers tea to coffee in the afternoon.', { provenance: 'tool_output' }),
    )) as MemoryProposal;
    const before = (await provider.log([], 500)).length;
    const both = await Promise.allSettled([
      service.decide(p.id, { decision: 'approve' }),
      service.decide(p.id, { decision: 'approve' }),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'memory.proposal_decided' });
    const texts = entries(parseMemory((await provider.read('USER.md')).content)).map((e) => e.text);
    expect(texts.filter((t) => t === 'Prefers tea to coffee in the afternoon.')).toHaveLength(1);
    expect((await provider.log([], 500)).length - before).toBe(1);
  }, 30_000);

  it('the same lesson seen twice at once counts as seen twice', async () => {
    const { proposals, service } = await rig();
    const lesson = {
      kind: 'failure_lesson' as const,
      targetPath: 'FAILURES/files-read.md',
      section: 'Lessons',
      text: '**fs_read failed, then worked.** Symptom: ENOENT. Cause: the name was typed in the wrong case.',
      confidence: 0.7,
      evidence: [],
      provenance: 'run_outcome' as const,
    };
    await Promise.all([service.consider(lesson), service.consider(lesson)]);
    const all = await proposals.list();
    expect(all.filter((p) => p.status === 'watching')).toHaveLength(0);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'auto_applied', sightings: 2 });
  }, 30_000);
});

describe('the repository write queue', () => {
  it('a write that git refuses leaves the files as they were, and the next write is clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-mem-lock-'));
    dirs.push(dir);
    const p = new GitMemoryProvider({ root: join(dir, 'memory'), author });
    await p.write({
      path: 'USER.md',
      content: '# One\n',
      baseVersion: null,
      message: 'memory(user): one',
      author,
    });
    const file = join(p.root, 'USER.md');
    const lock = join(p.root, '.git', 'index.lock');

    // Another program holds git's lock.
    await writeFile(lock, '');
    await expect(
      p.update('USER.md', ({ content }) => `${content}- two\n`, 'memory(user): two', author),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('# One\n');
    const head = (await p.read('USER.md')).version;
    await expect(
      p.write({
        path: 'USER.md',
        content: '# One\n- three\n',
        baseVersion: head,
        message: 'memory(user): three',
        author,
      }),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('# One\n');
    await expect(
      p.writeMany(
        ['USER.md', 'AGENTS.md'],
        () =>
          new Map([
            ['USER.md', '# x\n'],
            ['AGENTS.md', '# y\n'],
          ]),
        'memory: both',
        author,
      ),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('# One\n');
    expect(await p.exists('AGENTS.md')).toBe(false);

    // The lock goes; the next write commits only its own change.
    await rm(lock);
    await p.update('USER.md', ({ content }) => `${content}- four\n`, 'memory(user): four', author);
    expect((await p.read('USER.md')).content).toBe('# One\n- four\n');
    expect((await git('git', ['status', '--porcelain'], { cwd: p.root })).stdout.trim()).toBe('');
    expect((await p.log(['--', 'USER.md'])).map((c) => c.message)).toEqual([
      'memory(user): four',
      'memory(user): one',
    ]);
  }, 30_000);

  it('update builds on the file as it is when its turn comes, however many are waiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-mem-update-'));
    dirs.push(dir);
    const p = new GitMemoryProvider({ root: join(dir, 'memory'), author });
    await p.write({
      path: 'USER.md',
      content: '# List\n',
      baseVersion: null,
      message: 'memory(user): start',
      author,
    });
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        p.update('USER.md', ({ content }) => `${content}- line ${i}\n`, `memory(user): line ${i}`, author),
      ),
    );
    const lines = (await p.read('USER.md')).content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.sort()).toEqual(Array.from({ length: n }, (_, i) => `- line ${i}`).sort());
    expect((await p.log(['--', 'USER.md'], 100)).length).toBe(n + 1);
  }, 60_000);

  it('removing or reverting on a repository nobody has opened yet does not wait on itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-mem-fresh-'));
    dirs.push(dir);
    const p = new GitMemoryProvider({ root: join(dir, 'memory'), author, template: MEMORY_TEMPLATE });
    await expect(p.remove('PROJECTS/nothing.md', 'memory: remove', author)).rejects.toMatchObject({
      code: 'memory.not_found',
    });
    const q = new GitMemoryProvider({ root: join(dir, 'other'), author, template: MEMORY_TEMPLATE });
    await expect(q.revert('0123456789abcdef', author)).rejects.toMatchObject({
      code: 'memory.revert_conflict',
    });
  }, 15_000);
});

describe('the derived index', () => {
  it('ends up with the newest text when two refreshes of a file overlap', async () => {
    let reads = 0;
    const source: IndexSource = {
      list: async () => [],
      read: async () => {
        const n = ++reads;
        // The first read is slow, as one made while another process holds the disk would be.
        if (n === 1) {
          await new Promise((r) => setTimeout(r, 60));
          return { content: '- Old line.\n', version: 'v1' };
        }
        return { content: '- New line.\n', version: 'v2' };
      },
    };
    const index = new MemoryIndex(source);
    await Promise.all([index.refresh('USER.md'), index.refresh('USER.md')]);
    expect(index.file('USER.md')?.entries.map((e) => e.text)).toEqual(['New line.']);
    expect(index.file('USER.md')?.commit).toBe('v2');
  });
});

describe('the inbox order', () => {
  it('lists the newest suggestion first even when several are made in the same millisecond', async () => {
    const store = new MemoryProposalStore();
    const made: string[] = [];
    for (let i = 0; i < 300; i++) {
      const p = await store.create({
        kind: 'preference',
        target_path: 'USER.md',
        op: 'add',
        section: 'Preferences',
        text: `Suggestion ${i}.`,
        target_key: null,
        target_text: null,
        rationale: '',
        confidence: 0.9,
        provenance: 'user_message',
        evidence: [],
        status: 'proposed',
      });
      made.push(p.id);
    }
    expect((await store.list({ limit: 500 })).map((p) => p.id)).toEqual(made.reverse());
  });
});
