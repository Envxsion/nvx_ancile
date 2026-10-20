/**
 * Bugs found by a live test of dynamic memory (20 Oct), each held in place with the offline model:
 * plain pasted examples, a said-so note when nothing was learned, the comparison that always
 * failed, reversals, and passive memory that repeated itself.
 */
import type { MemoryFileContent, MemoryProposal, MemoryProposalList } from '@nvx/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assembleExplain, relevantFirst } from '../../src/explain/assemble';
import { reversalSignal, reversalStatement } from '../../src/memory/capture';
import { CompareResult, detectExample, plainSections, StandardRubric } from '../../src/memory/examples';
import { CAPTURE_NOTE } from '../../src/memory/inject';
import { extractJson, type UtilityOutcome, utilityFrom } from '../../src/memory/llm';
import { type Harness, harness } from '../support/harness';

vi.setConfig({ testTimeout: 20_000 });

let h: Harness;
const notebooks = new Map([['nbk_pub', { id: 'nbk_pub', slug: 'plain', title: 'Plain' }]]);

beforeAll(async () => {
  h = await harness({ memory: true, memoryNotebook: async (id) => notebooks.get(id) ?? null });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const mem = () => h.memory as NonNullable<Harness['memory']>;
const list = async () => (await h.call<MemoryProposalList>('GET', '/memory/proposals')).body.items;
const view = async (path: string) => (await h.call<MemoryFileContent>('GET', `/memory/files/${path}`)).body;
const last = new Map<string, string>();
async function chat(thread: string, text: string) {
  const r = await h.send(thread, text, { parent_id: last.get(thread) ?? null });
  await h.settle(r.run_id);
  await mem().settled();
  last.set(thread, r.assistant_message_id);
  return r;
}
type Note = { type: string; message_id: string; [k: string]: unknown };
function listen() {
  const seen: Note[] = [];
  const off = h.bus.subscribe(0, (e) => {
    if (e.type === 'memory.note' || e.type === 'memory.unchanged') seen.push(e as unknown as Note);
  });
  return { seen, off };
}

const managerText =
  'Weekly update, 14 Oct. Shipped: the invoice export is live for all customers. Next: Priya owns the retry work, due Friday. Risk: the vendor has not confirmed the new rate limit.';
const mineText =
  'Hi all, I hope you are well. This week was a busy one for the team and I wanted to write down everything that happened, starting with the background before getting to the outcome right at the end.';

describe('F5: examples pasted as plain paragraphs', () => {
  it('finds the two pieces after "this is X\'s" and "this is mine"', () => {
    const text = `This is my manager's weekly update:\n${managerText}\n\nAnd this is mine:\n${mineText}\n\nCan you compare them?`;
    const secs = plainSections(text);
    expect(secs.map((s) => s.label)).toEqual(['theirs', 'mine']);
    expect(secs[0]?.text).toContain('Priya owns');
    expect(secs[1]?.text).toContain('busy one');
    expect(secs[1]?.text).not.toContain('compare them');
    const ex = detectExample(text);
    expect(ex?.role).toBe('manager');
    expect(ex?.theirs).toHaveLength(1);
    expect(ex?.mine).toHaveLength(1);
  });

  it('takes the text on the same line after a colon, and one piece alone', () => {
    const ex = detectExample(`Learn from how my lead writes: ${managerText}`);
    expect(ex).toBeNull(); // no "this is" line to say whose it is
    const one = detectExample(`This is how my senior dev writes pull requests:\n${managerText}`);
    expect(one?.role).toBe('senior dev');
    expect(one?.mine).toEqual([]);
  });

  it('does not take ordinary talk for an example', () => {
    expect(detectExample("This is my manager's idea, what do you think about it overall?")).toBeNull();
  });

  it('proposes a standard from plain paragraphs and says so', async () => {
    const { seen, off } = listen();
    const t = await h.newThread();
    const u = await chat(
      t,
      `This is my manager's weekly update:\n${managerText}\n\nThis is mine:\n${mineText}`,
    );
    off();
    const items = (await list()).filter((p) => p.target_path === 'STANDARDS/manager.md');
    expect(items.length).toBe(2);
    expect(items.every((p) => p.status === 'proposed')).toBe(true);
    const note = seen.find((e) => e.type === 'memory.note' && e.message_id === u.user_message_id);
    expect(note).toMatchObject({ outcome: 'learned', title: "Learned your manager's standard" });
    expect(String(note?.body)).toContain('waiting in Memory');
  });

  it('says why when nothing could be learned', async () => {
    const spy = vi.spyOn(
      (mem() as unknown as { deps: { utility: { json: (...a: unknown[]) => unknown } } }).deps.utility,
      'json',
    );
    spy.mockImplementation(async (...a: unknown[]) => {
      const opts = a[3] as { outcome?: (o: UtilityOutcome) => void };
      opts.outcome?.({
        ok: false,
        reason: 'the reply could not be read (rules: invalid_type)',
        inputTokens: 5,
        outputTokens: 9,
      });
      return null;
    });
    const { seen, off } = listen();
    const t = await h.newThread();
    const u = await chat(t, `This is how my director writes updates:\n\`\`\`\n${managerText}\n\`\`\``);
    off();
    spy.mockRestore();
    const note = seen.find((e) => e.type === 'memory.note' && e.message_id === u.user_message_id);
    expect(note).toMatchObject({ outcome: 'not_learned', title: "Couldn't learn your director's standard" });
    expect(String(note?.body)).toContain('could not be read');
    expect((await list()).some((p) => p.target_path === 'STANDARDS/director.md')).toBe(false);
  });

  it('tries the cheap tier first and the default model only if that fails', async () => {
    const spy = vi.spyOn(
      (mem() as unknown as { deps: { utility: { json: (...a: unknown[]) => unknown } } }).deps.utility,
      'json',
    );
    const t = await h.newThread();
    await chat(t, `This is how my mentor writes updates:\n\`\`\`\n${managerText}\n\`\`\``);
    const calls = spy.mock.calls.filter((c) => (c[0] as { id: string }).id === 'memory.distil-standard');
    spy.mockRestore();
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.[3] as { taskClasses: string[] } | undefined;
    expect(opts?.taskClasses).toEqual(['memory.detector']);
  });
});

describe('F2: comparing with a standard', () => {
  it('keeps a long answer, cut with a marker, instead of rejecting it', () => {
    const long = 'x'.repeat(900);
    const r = CompareResult.parse({
      summary: long,
      differences: Array.from({ length: 12 }, () => ({ point: long, yours: long })),
      suggestions: Array.from({ length: 9 }, () => long),
    });
    expect(r.summary.length).toBe(600);
    expect(r.summary.endsWith('…')).toBe(true);
    expect(r.differences).toHaveLength(8);
    expect(r.differences[0]?.standard).toBe('');
    expect(r.suggestions).toHaveLength(6);
    expect(StandardRubric.parse({ title: long, rules: [long], confidence: 'high' }).confidence).toBe(0.7);
  });

  it('repairs a reply it could not read with one more call, and says why when it still fails', async () => {
    const replies = ['not json at all', '{"summary": 5}', '{"summary": "ok"}'];
    let n = 0;
    const prompts: string[] = [];
    const util = utilityFrom({
      gateway: {
        stream: async function* (_m: unknown, req: { messages: { content: string }[] }) {
          prompts.push(req.messages[0]?.content ?? '');
          const text = replies[n++] ?? '';
          yield { type: 'model', modelId: 'm1' };
          yield { type: 'chunk', modelId: 'm1', chunk: { type: 'text', delta: text } };
          yield {
            type: 'chunk',
            modelId: 'm1',
            chunk: { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 4 } },
          };
        },
      } as never,
      registry: { chain: () => [{ id: 'm1' }] } as never,
      promptsDir: '/nowhere',
    });
    const fine = await util.json(
      { id: 'x.y', fallback: 'Say hi.', output: 'CompareResult' },
      {},
      CompareResult,
      { outcome: (o) => outcomes.push(o) },
    );
    expect(fine).toBeNull();
    // Both attempts failed: the second said which field was wrong, never what it held.
    expect(prompts[1]).toContain('could not be used');
    expect(outcomes[0]?.reason).toMatch(/summary: invalid_type/);
    expect(outcomes[0]?.inputTokens).toBe(20);
    // A repair that works.
    const ok = await util.json(
      { id: 'x.y', fallback: 'Say hi.', output: 'CompareResult' },
      {},
      CompareResult,
    );
    expect(ok?.summary).toBe('ok');
  });

  it('reads JSON out of chatter', () => {
    expect(extractJson('Sure! {"a": 1} Hope that helps')).toEqual({ a: 1 });
  });
});
const outcomes: UtilityOutcome[] = [];

describe('F6: taking something back', () => {
  it('knows a plain contrast and cuts the take-back words off', () => {
    expect(reversalSignal('Actually no, scrap that: I drink oolong now, not mint tea.')).toBe(true);
    expect(reversalStatement('Actually no, scrap that: I drink oolong now, not mint tea.')).toBe(
      'Drinks oolong now, not mint tea.',
    );
    expect(reversalStatement('Actually no, scrap that.')).toBe('');
    expect(reversalStatement('Ignore what I said earlier. We deploy on Fridays now.')).toBe(
      'We deploy on Fridays now.',
    );
    expect(reversalStatement('I have moved to US-style dates.')).toBe('Now uses US-style dates.');
  });

  it('proposes a replacement for the entry it contradicts', async () => {
    const t0 = await h.newThread();
    await chat(t0, 'Remember that I drink mint tea in the afternoon.');
    const t = await h.newThread();
    await chat(t, 'What should I make this afternoon?');
    await chat(t, 'Actually no, scrap that: I drink oolong now, not mint tea.');
    const p = (await list()).find((x) => /oolong/.test(x.text));
    expect(p).toBeTruthy();
    expect(p?.op).toBe('supersede');
    expect(p?.target_text).toMatch(/mint tea/);
    expect(p?.provenance).toBe('user_message');
  });

  it('supersedes the USER.md entry from a notebook thread instead of filing a project note', async () => {
    await chat(await h.newThread(), 'Remember that I use DD/MM/YYYY dates everywhere.');
    const t = await h.newThread({ notebook_id: 'nbk_pub' });
    await chat(t, 'Format the date for the invoice.');
    await chat(t, 'Actually no, scrap that. I have moved to US-style dates in this notebook.');
    const user = await view('USER.md');
    const now = user.entries.find((e) => e.text.includes('US-style dates'));
    expect(now).toBeTruthy();
    expect(user.entries.find((e) => e.text.includes('DD/MM/YYYY'))?.superseded).toBe(true);
    const projects = (await list()).filter(
      (p) => p.target_path.startsWith('PROJECTS/') && /US-style/.test(p.text),
    );
    expect(projects).toHaveLength(0);
  });

  it('always says when it changed nothing', async () => {
    const { seen, off } = listen();
    const t = await h.newThread();
    await chat(t, 'List the deploy days.');
    const u = await chat(t, 'Actually no, scrap that.');
    off();
    expect(
      seen.find((e) => e.type === 'memory.unchanged' && e.message_id === u.user_message_id),
    ).toBeTruthy();
  });
});

describe('F8: passive memory and explicit remembers', () => {
  it('labels an explicit remember as asked, not as a correction', async () => {
    await chat(await h.newThread(), 'Remember that my team stand-up is at half past nine.');
    const log = (await h.call<{ items: { body?: string }[] }>('GET', '/memory/history/USER.md')).body.items;
    expect(log[0]?.body).toContain('You asked me to remember this');
    expect(log[0]?.body).not.toContain('Detected: correction');
  });

  it('does not re-propose what an entry already says', async () => {
    await chat(await h.newThread(), 'Remember that I use pnpm for every project.');
    const before = (await list()).length;
    const t = await h.newThread();
    await chat(t, 'I use pnpm for every project.');
    const r = await mem().passiveSweep(t);
    expect(r.filed + r.saved).toBe(0);
    expect((await list()).length).toBe(before);
  });

  it('withdraws a pending proposal about an entry that was just replaced', async () => {
    await chat(await h.newThread(), 'Remember that the release train leaves on Tuesdays.');
    const entry = (await view('USER.md')).entries.find((e) => e.text.includes('release train'));
    expect(entry).toBeTruthy();
    // A suggestion to change that entry, waiting for a yes.
    const stale = await mem().consider({
      kind: 'preference',
      targetPath: 'USER.md',
      section: 'Preferences',
      text: 'The release train leaves on Tuesdays and Thursdays.',
      confidence: 0.6,
      evidence: [],
      provenance: 'source_content',
    });
    expect(stale?.status).toBe('proposed');
    expect(stale?.target_key).toBe(entry?.key);
    // The person replaces the entry another way.
    const t = await h.newThread();
    const u = await chat(t, 'Ignore what I said. The release train leaves on Mondays now.');
    await h.call('POST', '/memory/update-from', { message_id: u.user_message_id });
    const after = (await list()).find((p) => p.id === stale?.id) as MemoryProposal;
    expect(after.status).toBe('rejected');
  });
});

describe('the one-line note and the Used line', () => {
  it('tells the model about capture in the pinned memory, once, while capture is on', async () => {
    const pack = await mem().pack({
      notebookId: null,
      modelId: 'fake',
      contextWindow: 100_000,
      query: 'x',
      part: 'pinned',
    });
    expect(pack.text).toContain(CAPTURE_NOTE);
    expect(pack.text.split(CAPTURE_NOTE).length).toBe(2);
    const ranked = await mem().pack({
      notebookId: null,
      modelId: 'fake',
      contextWindow: 100_000,
      query: 'x',
      part: 'ranked',
    });
    expect(ranked.text).not.toContain(CAPTURE_NOTE);
  });

  it('lists the entries that bear on the answer first', () => {
    const used = [
      { text: 'Drinks mint tea.' },
      { text: 'Stand-up is at nine.' },
      { text: 'Uses pnpm for installs.' },
    ];
    expect(relevantFirst(used, 'Run pnpm install now.').map((u) => u.text)).toEqual([
      'Uses pnpm for installs.',
      'Drinks mint tea.',
      'Stand-up is at nine.',
    ]);
    expect(relevantFirst(used, 'Nothing in common here.')).toEqual(used);
    expect(typeof assembleExplain).toBe('function');
  });
});
