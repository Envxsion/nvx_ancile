/**
 * Checking a highlighted claim (roadmap FC3): what the highlight is, the
 * card's shape (a verdict line, at most five evidence lines, one closing
 * line, never an essay), guard rail GR24 (a different model family judges,
 * and with none the check says so and does not run), the web (FC4), code
 * through the sandbox and the permission gate, and the record on the message.
 */
import type {
  EvidenceResponse,
  Explain,
  SelectionCheckList,
  StartSelectionCheckResponse,
} from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checksOf,
  clip,
  codeOf,
  detectKind,
  firstLine,
  isEssay,
  locate,
  looksPython,
  type PoolItem,
  type RawSelection,
  shapeSelection,
} from '../../src/factcheck/selection';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

const PASSAGES = [
  'The ZX-4410 pump must be primed before first use.',
  'Error code E-19 means the impeller is blocked; switch off and clear it.',
  'Owls are nocturnal birds of prey.',
];

/** A Knowledge stand-in: passages sharing two or more words with the claim. */
const kn = {
  calls: [] as { path: string; body: unknown }[],
  async post<T>(path: string, body: unknown): Promise<T> {
    kn.calls.push({ path, body });
    const req = body as { claims: string[] };
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const res: EvidenceResponse = {
      mode: 'hybrid',
      embedder: null,
      ms: 1,
      results: req.claims.map((claim) => {
        const cw = words(claim);
        const hits = PASSAGES.filter((p) => [...words(p)].filter((w) => cw.has(w)).length >= 2).map(
          (p, i) => ({
            kind: 'chunk' as const,
            chunk_id: `chk_${i}`,
            source_id: 'src_manual',
            source_title: 'Pump manual',
            page: 2,
            heading_path: ['Pump manual'],
            text: p,
            quote: p,
            quote_start: 100,
            quote_end: 100 + p.length,
            rerank_score: 0.95,
            relevance: 0.95,
          }),
        );
        return { claim, hits, coverage: hits.length ? 1 : 0 };
      }),
    };
    return res as T;
  },
};

let h: Harness;
afterEach(async () => {
  kn.calls = [];
  await h?.close();
});

async function answered(text: string, body: Record<string, unknown> = {}) {
  const thread = await h.newThread(body);
  const sent = await h.send(thread, `/say ${text}`);
  await h.settle(sent.run_id);
  return { thread, message: sent.assistant_message_id, user: sent.user_message_id };
}

const check = (messageId: string, body: Record<string, unknown>) =>
  h.call<StartSelectionCheckResponse>('POST', `/messages/${messageId}/selection-checks`, body);

const raw = (over: Partial<RawSelection> = {}): RawSelection => ({
  verdict: 'doesnt_hold',
  headline: 'The manual says E-19, not E-17.',
  corrected: 'Error code E-19 means the impeller is blocked.',
  evidence: [
    { text: 'The manual lists E-19 for a blocked impeller.', ref: 'E1', stance: 'contradicts' },
    { text: 'No code E-17 appears in the manual.', ref: null, stance: 'supports' },
    { text: 'Switch off and clear the impeller.', ref: 'E1', stance: 'neutral' },
  ],
  closing: 'The advice to look for E-17 would change to E-19.',
  ...over,
});

const pool: PoolItem[] = [
  {
    text: 'Error code E-19 means the impeller is blocked.',
    origin: 'source',
    source_title: 'Pump manual',
    page: 2,
    source_id: 'src_manual',
    url: null,
  },
  {
    text: 'Impellers can block.',
    origin: 'web',
    source_title: 'Pump facts',
    page: null,
    source_id: null,
    url: 'https://example.org/pumps',
  },
];

describe('what was highlighted', () => {
  it('tells prose, code, LaTeX and links apart', () => {
    expect(detectKind('Owls are nocturnal birds of prey.')).toBe('prose');
    expect(detectKind('def total(xs):\n    return sum(xs)')).toBe('code');
    expect(detectKind('```python\nprint(1 + 1)\n```')).toBe('code');
    expect(detectKind('const x = 4;\nconsole.log(x)')).toBe('code');
    expect(detectKind('$\\frac{d}{dx} x^2 = 2x$')).toBe('math');
    expect(detectKind('The sum is \\sum_{i=1}^{n} i = n(n+1)/2')).toBe('math');
    expect(detectKind('https://example.org/docs/pumps')).toBe('link');
    expect(detectKind('[the manual](https://example.org/manual)')).toBe('link');
  });

  it('takes the Cockpit hint for what it saw, and lets a strong sign in the text win', () => {
    expect(detectKind('total = a + b', 'code')).toBe('code');
    expect(detectKind('x squared plus one', 'math')).toBe('math');
    // Said to be prose-ish, but it is plainly a link.
    expect(detectKind('https://example.org/a', 'code')).toBe('link');
    // A hint of a link on text with no address is just text.
    expect(detectKind('see the docs', 'link')).toBe('prose');
  });

  it('runs only Python, and only code that looks like it', () => {
    expect(looksPython('print(sum([1, 2, 3]))')).toBe(true);
    expect(looksPython('import math\nx = math.sqrt(4)')).toBe(true);
    expect(looksPython('def f(x):\n    return x * 2')).toBe(true);
    expect(looksPython('const x = 4;\nconsole.log(x);')).toBe(false);
    expect(looksPython('#include <stdio.h>\nint main() { return 0; }')).toBe(false);
    expect(codeOf('```python\nprint(1)\n```')).toBe('print(1)');
    expect(codeOf('`x = 1`')).toBe('x = 1');
  });

  it('finds the highlight in the message, by the offsets given or by its words', () => {
    const full = 'First sentence. Owls are nocturnal. Last.';
    expect(locate(full, 'Owls are nocturnal.', 16, 35)).toEqual({ start: 16, end: 35 });
    expect(locate(full, 'Owls are nocturnal.')).toEqual({ start: 16, end: 35 });
    expect(locate(full, 'Not in there')).toBeNull();
  });
});

describe('the card is never an essay', () => {
  it('keeps at most five evidence lines, your sources first, each with its source', () => {
    const many = raw({
      evidence: [
        { text: 'A web page agrees.', ref: 'E2' },
        { text: 'The model remembers it too.', ref: null },
        { text: 'The manual says E-19.', ref: 'E1', stance: 'contradicts' },
        { text: 'Line four.', ref: null },
        { text: 'Line five.', ref: null },
        { text: 'Line six, cut.', ref: null },
        { text: 'Line seven, cut.', ref: null },
      ],
    });
    const s = shapeSelection(many, pool);
    if ('reject' in s) throw new Error(s.reject);
    expect(s.evidence).toHaveLength(5);
    expect(s.evidence.map((e) => e.origin)).toEqual(['source', 'web', 'model', 'model', 'model']);
    expect(s.evidence[0]).toMatchObject({
      source: 'Pump manual, p. 2',
      source_id: 'src_manual',
      stance: 'contradicts',
    });
    expect(s.evidence[1]).toMatchObject({ source: 'Pump facts', url: 'https://example.org/pumps' });
    expect(s.evidence[2]).toMatchObject({ source: 'Model knowledge', url: null });
  });

  it('trims every field to one short line and holds the closing to one sentence', () => {
    const long = 'word '.repeat(80).trim();
    const s = shapeSelection(
      raw({
        headline: `${long}. A second sentence.`,
        closing: 'The answer would change here. It would also change there.\nAnd on another line.',
        evidence: [{ text: `${long}\nsecond line`, ref: 'E1' }],
      }),
      pool,
    );
    if ('reject' in s) throw new Error(s.reject);
    expect(s.headline.length).toBeLessThanOrEqual(140);
    expect(s.closing).toBe('The answer would change here.');
    expect(s.evidence[0]?.text.length).toBeLessThanOrEqual(220);
    expect(s.evidence[0]?.text).not.toContain('\n');
  });

  it('rejects an essay, an empty reply, and a verdict that does not correct the claim', () => {
    const essay = 'This is a long paragraph. '.repeat(40);
    expect(isEssay(raw({ headline: essay }))).toBe(true);
    expect(shapeSelection(raw({ headline: essay }), pool)).toEqual({ reject: 'it ran to an essay' });
    expect(
      shapeSelection(raw({ evidence: Array.from({ length: 12 }, (_, i) => ({ text: `Line ${i}.` })) }), pool),
    ).toEqual({ reject: 'it ran to an essay' });
    expect(shapeSelection(raw({ evidence: [] }), pool)).toEqual({ reject: 'it gave no evidence' });
    expect(shapeSelection(raw({ headline: ' ' }), pool)).toEqual({ reject: 'it gave no reason' });
    expect(shapeSelection(raw({ corrected: null }), pool)).toEqual({
      reject: 'it did not correct the claim',
    });
  });

  it('gives a closing line even when the model left it out, and none of the corrected claim when it holds', () => {
    const holds = shapeSelection(raw({ verdict: 'holds', corrected: null, closing: null }), pool);
    if ('reject' in holds) throw new Error(holds.reject);
    expect(holds.corrected).toBeNull();
    expect(holds.closing).toBe('The surrounding answer stands as written.');
    const not = shapeSelection(raw({ closing: '' }), pool);
    if ('reject' in not) throw new Error(not.reject);
    expect(not.closing).toMatch(/corrected claim/);
  });

  it('cuts at a word, with an ellipsis', () => {
    expect(clip('one two three four five', 14)).toBe('one two three…');
    expect(firstLine('Short one. Another.', 100)).toBe('Short one.');
  });
});

describe('highlighting a claim (end to end, offline models)', () => {
  it('judges a claim against the notebook sources and records the card on the message', async () => {
    h = await harness({ kn });
    const answer = 'Error code E-17 means the impeller is blocked. Owls are nocturnal birds of prey.';
    const { message, thread } = await answered(answer, { notebook_id: 'nbk_1' });

    const res = await check(message, { text: 'Error code E-17 means the impeller is blocked.' });
    expect(res.status).toBe(200);
    const c = res.body.check;
    expect(res.body.cached).toBe(false);
    expect(c).toMatchObject({
      message_id: message,
      kind: 'prose',
      verdict: 'doesnt_hold',
      char_start: 0,
      char_end: 46,
      // GR24: the writer was the offline test model; another family judged.
      written_by_family: 'offline',
      checker_model_id: 'offline/echo',
      checker_family: 'offline-echo',
      billed: 'free',
      cost_usd: 0,
      web: { used: false, note: null },
    });
    expect(c.corrected).toMatch(/E-19/);
    expect(c.evidence.length).toBeGreaterThanOrEqual(1);
    expect(c.evidence.length).toBeLessThanOrEqual(5);
    expect(c.evidence[0]).toMatchObject({
      origin: 'source',
      source: 'Pump manual, p. 2',
      stance: 'contradicts',
    });
    expect(c.closing).toBeTruthy();
    // Only the notebook's sources were searched.
    expect(kn.calls[0]).toMatchObject({ path: '/evidence', body: { notebook_id: 'nbk_1' } });

    // It survives a reload: on the message, in the list, in the explain document.
    const stored = checksOf((await h.repo.getMessage(message)) as never);
    expect(stored.map((s) => s.id)).toEqual([c.id]);
    const list = await h.call<SelectionCheckList>('GET', `/messages/${message}/selection-checks`);
    expect(list.body.checks.map((s) => s.id)).toEqual([c.id]);
    const why = await h.call<Explain>('GET', `/messages/${message}/explain`);
    expect(why.body.selection_checks.map((s) => s.id)).toEqual([c.id]);
    void thread;
  });

  it('holds a claim the sources state, and names the source', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const c = (await check(message, { text: 'Owls are nocturnal birds of prey.' })).body.check;
    expect(c.verdict).toBe('holds');
    expect(c.corrected).toBeNull();
    expect(c.closing).toBe('The surrounding answer stands as written.');
  });

  it('says it cannot tell when nothing settles it, and uses no sources outside a notebook', async () => {
    h = await harness({ kn });
    const { message } = await answered('Sourdough starters need feeding with flour every single day.');
    const c = (await check(message, { text: 'Sourdough starters need feeding every single day.' })).body
      .check;
    expect(c.verdict).toBe('cant_tell');
    // A thread outside a notebook has no sources to search: never the whole workspace.
    expect(kn.calls).toEqual([]);
  });

  it('answers the same highlight from the record, and checks again when asked', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const first = (await check(message, { text: 'Owls are nocturnal birds of prey.' })).body;
    const calls = h.provider.calls.length;
    const again = (await check(message, { text: '  Owls are  nocturnal birds of prey. ' })).body;
    expect(again.cached).toBe(true);
    expect(again.check.id).toBe(first.check.id);
    expect(h.provider.calls.length).toBe(calls);
    const fresh = (await check(message, { text: 'Owls are nocturnal birds of prey.', again: true })).body;
    expect(fresh.cached).toBe(false);
    expect(fresh.check.id).not.toBe(first.check.id);
    expect(checksOf((await h.repo.getMessage(message)) as never)).toHaveLength(2);
  });

  it('checks the words of your own message, with any family judging', async () => {
    h = await harness({ kn });
    const { user } = await answered('ok', { notebook_id: 'nbk_1' });
    // Your own message is a message like any other; /say is its text.
    const c = (await check(user, { text: 'say ok' })).body.check;
    expect(c.written_by_family).toBeNull();
    expect(c.checker_model_id).toBeTruthy();
  });

  it('waits for an answer that is still being written', async () => {
    h = await harness({ kn });
    const thread = await h.newThread();
    const sent = await h.send(thread, '/slow /say one two three four five six');
    const res = await h.call<{ error: { code: string } }>(
      'POST',
      `/messages/${sent.assistant_message_id}/selection-checks`,
      { text: 'one two' },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toMatch(/factcheck\.(still_writing|not_answer)/);
  });

  it('refuses an empty or overlong highlight with a plain error', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.');
    const empty = await h.call<{ error: { code: string } }>('POST', `/messages/${message}/selection-checks`, {
      text: ' ',
    });
    expect(empty.status).toBe(400);
    const big = await h.call<{ error: { code: string; hint: string } }>(
      'POST',
      `/messages/${message}/selection-checks`,
      { text: 'owl '.repeat(700) },
    );
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('factcheck.selection_too_long');
  });
});

describe('guard rail GR24: a different family judges', () => {
  const only = (family: string) => ({
    offline: false,
    models: [fakeModel('writer', 'script', family)],
    taskClasses: { 'chat.default': ['fake/writer'], 'factcheck.verify': ['fake/writer'] },
  });

  it('still checks an answer when only the writer family is ready: no listed model is ever required', async () => {
    h = await harness({ kn, ...only('famA') });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const res = await h.call<{ check: { written_by_family: string | null; checker_family: string | null } }>(
      'POST',
      `/messages/${message}/selection-checks`,
      { text: 'Owls are nocturnal birds of prey.' },
    );
    expect(res.status).toBe(200);
    expect(res.body.check.written_by_family).toBe('famA');
    expect(res.body.check.checker_family).toBe('famA');
  });

  it('starts a whole-answer check the same way', async () => {
    h = await harness({ kn, ...only('famA') });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const res = await h.call<{ run_id: string }>('POST', `/messages/${message}/factcheck`);
    expect(res.status).toBe(202);
    await h.settle(res.body.run_id);
    expect((await h.factchecks.latestFor(message))?.status).toBe('done');
  });

  it('finishes a started whole-answer check (grounded mode) and says the writer family checked it', async () => {
    h = await harness({ kn, ...only('famA') });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const { startFactcheck } = await import('../../src/factcheck/handler');
    const started = await startFactcheck(
      {
        repo: h.repo,
        runs: h.runs,
        store: h.factchecks,
        worker: h.worker,
        familyOf: (id) => (id ? (h.registry.get(id)?.family ?? null) : null),
      },
      message,
      { workspaceId: 'wsp_test', notebookId: 'nbk_1' },
    );
    await h.settle(started.record.run_id as string);
    const f = await h.factchecks.latestFor(message);
    expect(f?.status).toBe('done');
    const notes = f?.claims.flatMap((c) => c.check?.degraded ?? []).join(' ');
    expect(notes).toMatch(/writer's family/);
  });

  it('lets any family judge your own words', async () => {
    h = await harness({ kn, ...only('famA') });
    const { user } = await answered('ok', { notebook_id: 'nbk_1' });
    const res = await check(user, { text: 'say ok' });
    expect(res.status).toBe(200);
    expect(res.body.check.written_by_family).toBeNull();
    expect(res.body.check.checker_family).toBe('famA');
  });

  it('judges with the other family when there is one', async () => {
    h = await harness({
      kn,
      offline: false,
      models: [fakeModel('writer', 'script', 'famA'), fakeModel('judge', 'script', 'famB')],
      taskClasses: {
        'chat.default': ['fake/writer'],
        'factcheck.verify': ['fake/writer', 'fake/judge'],
      },
    });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const c = (await check(message, { text: 'Owls are nocturnal birds of prey.' })).body.check;
    expect(c.checker_model_id).toBe('fake/judge');
    expect(c.checker_family).toBe('famB');
    expect(c.written_by_family).toBe('famA');
  });

  it('keeps the writer family out even when its model is listed first and asked for', async () => {
    h = await harness({
      kn,
      offline: false,
      models: [fakeModel('writer', 'script', 'famA'), fakeModel('judge', 'script', 'famB')],
      taskClasses: { 'chat.default': ['fake/writer'], 'factcheck.verify': ['fake/writer', 'fake/judge'] },
    });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    const before = h.provider.calls.length;
    await check(message, { text: 'Owls are nocturnal birds of prey.' });
    const asked = h.provider.calls.slice(before).map((c) => c.model);
    expect(asked).toEqual(['fake/judge']);
  });
});

describe('keep-local notebooks and the web (FC4)', () => {
  const sandboxed = (over: Record<string, unknown> = {}) => ({ scope: over });
  void sandboxed;

  it('a private notebook is judged by a local model only, and says so when there is none', async () => {
    const { scopeAllow } = await import('../../src/factcheck/allow');
    const scope = {
      private: true,
      scope: { data_leaves_machine: false, engines: null, models_allow: null, models_deny: [] },
    };
    const allow = scopeAllow(scope as never);
    const cloud = fakeModel('c', 'script', 'famB');
    const local = { ...fakeModel('l', 'script', 'famB'), provider: 'ollama' };
    expect(allow?.({ ...cloud, provider: 'openai' })).toMatch(/private|stay|local/i);
    expect(allow?.(local)).toBeNull();
  });
});
