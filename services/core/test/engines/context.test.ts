/**
 * Context for each engine: one-line digests, budgets with a reserve for the
 * answer, recall of older turns by relevance, and the digest of other
 * engines' turns that goes to Claude Code. Pure functions, no database.
 */
import {
  CLAUDE_CODE_CONTEXT_NOTICE,
  CLAUDE_CODE_SOURCES_NOTICE,
  claudeCodeContextNotice,
  type Part,
} from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { stripReminders } from '../../src/claudecode/markup';
import {
  assembleForGateway,
  FOREIGN_OPEN,
  isMixed,
  pathTo,
  planClaudeTurn,
  RECALL_HEADER,
} from '../../src/engines/context';
import { digestParts, digestStep } from '../../src/engines/digest';
import { rank } from '../../src/engines/recall';
import type { MessageRecord } from '../../src/threads/repo';

const CWD = 'C:/code/app';
let n = 0;
function msg(
  role: 'user' | 'assistant',
  parent: string | null,
  parts: Part[],
  extra: Partial<MessageRecord> = {},
): MessageRecord {
  n++;
  return {
    id: `m${n}`,
    thread_id: 't',
    parent_id: parent,
    role,
    parts,
    model_id: null,
    requested_model_id: null,
    status: 'complete',
    edit_of_id: null,
    provenance: {},
    usage: null,
    run_id: null,
    trace_id: 'x',
    created_at: new Date(2026, 9, 1, 0, 0, n).toISOString(),
    ...extra,
  };
}
const cc = (session: string, uuid: string) => ({
  provenance: { claude_code: { session_id: session, uuid } },
});
const text = (t: string): Part => ({ type: 'text', text: t });
const BIG = 'x'.repeat(50_000);

describe('digests', () => {
  it('says each tool step in one line, never its output', () => {
    expect(digestStep('Read', { file_path: `${CWD}/src/app.ts` }, { ok: true, result: 'a\nb\nc' }, CWD)).toBe(
      'read src/app.ts (3 lines)',
    );
    expect(
      digestStep('Edit', { file_path: `${CWD}/x.ts`, old_string: 'a\nb', new_string: 'a\nc\nd' }, null, CWD),
    ).toBe('edited x.ts +2 −1');
    expect(digestStep('Bash', { command: 'pnpm test' }, { ok: true, result: 'ok' })).toBe(
      'ran `pnpm test` → exit 0',
    );
    expect(digestStep('Bash', { command: 'pnpm lint' }, { ok: false, result: 'Exit code 2\nboom' })).toBe(
      'ran `pnpm lint` → exit 2',
    );
    expect(
      digestStep(
        'Task',
        { description: 'Find the bug' },
        { ok: true, result: 'The bug is in auth.ts\nmore' },
      ),
    ).toBe('subagent: Find the bug → The bug is in auth.ts');
    expect(digestStep('mcp__github__create_issue', {}, { ok: true, result: '' })).toBe(
      'called github/create_issue',
    );
  });

  it('keeps text, leaves out thinking and the full result', () => {
    const d = digestParts(
      [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool_call', call_id: 'c1', tool: 'Read', args: { file_path: `${CWD}/a.ts` } },
        { type: 'tool_result', call_id: 'c1', ok: true, result: BIG },
        text('Done.'),
      ],
      CWD,
    );
    expect(d.digested).toBe(1);
    expect(d.text).toContain('[tool] read a.ts (1 lines)');
    expect(d.text).toContain('Done.');
    expect(d.text).not.toContain('secret');
    expect(d.text.length).toBeLessThan(200);
  });
});

describe('recall', () => {
  it('ranks the turn that bears on the question first', () => {
    const r = rank('how does the login token refresh', [
      'we talked about colours of the sidebar',
      'the login token refresh happens in auth.ts every hour',
      'database migrations',
    ]);
    expect(r[0]?.index).toBe(1);
    expect(r.some((x) => x.index === 2)).toBe(false);
  });
});

/** A mixed thread: Claude Code read a huge file, then a gateway model answered, then a new question. */
function mixed() {
  n = 0;
  const u1 = msg('user', null, [text('Fix the login bug')], cc('S', 'u1'));
  const a1 = msg(
    'assistant',
    u1.id,
    [
      { type: 'tool_call', call_id: 'c1', tool: 'Read', args: { file_path: `${CWD}/src/auth.ts` } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: BIG },
      text('Fixed the token refresh in auth.ts.'),
    ],
    cc('S', 'a1'),
  );
  const u2 = msg('user', a1.id, [text('Explain the fix simply')]);
  const a2 = msg('assistant', u2.id, [text('The token now refreshes before it expires.')], {
    model_id: 'openai/gpt-5',
  });
  const u3 = msg('user', a2.id, [text('And what about tests?')]);
  return [u1, a1, u2, a2, u3];
}

describe('gateway context for a mixed thread', () => {
  it('never resends a full tool output and keeps a reserve for the answer', () => {
    const all = mixed();
    const path = pathTo(all, 'm5');
    expect(isMixed(path)).toBe(true);
    const out = assembleForGateway({
      path,
      summary: null,
      window: 8_000,
      maxOutput: 1_000,
      fixedTokens: 500,
      cwd: CWD,
    });
    const sent = out.messages.map((m) => m.content).join('\n');
    expect(sent).not.toContain('xxxxxxxxxx');
    expect(sent).toContain('read src/auth.ts');
    expect(out.messages.at(-1)).toEqual({ role: 'user', content: 'And what about tests?' });
    expect(out.report.reserve).toBe(1_000);
    expect(out.report.tokens + out.report.reserve + 500).toBeLessThanOrEqual(8_000);
    expect(out.report.digested).toBeGreaterThan(0);
  });

  it('brings older turns back by relevance when they do not all fit', () => {
    n = 0;
    const all: MessageRecord[] = [];
    let parent: string | null = null;
    const topics = [
      'sidebar colours',
      'the login token refresh lives in auth.ts',
      'pricing page copy',
      'sync over the relay',
    ];
    for (const t of topics) {
      const u = msg(
        'user',
        parent,
        [text(`Tell me about ${t}. ${'filler words here. '.repeat(60)}`)],
        cc('S', `u${n}`),
      );
      const a = msg('assistant', u.id, [text(`About ${t}: ${'more filler. '.repeat(60)}`)], cc('S', `a${n}`));
      all.push(u, a);
      parent = a.id;
    }
    const recent = [
      msg('user', parent, [text('ok')]),
      msg('assistant', `m${n}`, [text('ok')], { model_id: 'openai/gpt-5' }),
    ];
    recent[1] = { ...recent[1], parent_id: recent[0]?.id ?? null } as MessageRecord;
    all.push(...recent);
    const q = msg('user', recent[1]?.id ?? null, [text('Where does the login token refresh happen?')]);
    all.push(q);
    const out = assembleForGateway({
      path: pathTo(all, q.id),
      summary: null,
      window: 2_400,
      maxOutput: 400,
      fixedTokens: 300,
      keepTurns: 2,
      recallTurns: 1,
    });
    expect(out.note).toContain(RECALL_HEADER);
    expect(out.note).toContain('login token refresh lives in auth.ts');
    expect(out.note).not.toContain('pricing page');
    expect(out.report.recalled.length).toBe(2);
    expect(out.report.dropped).toBeGreaterThan(0);
  });

  it('uses the compaction summary in place of the older path', () => {
    const all = mixed();
    const out = assembleForGateway({
      path: pathTo(all, 'm5'),
      summary: { id: 'sum1', uptoMessageId: 'm2', content: 'Earlier: fixed the login bug.' },
      window: 8_000,
      maxOutput: 1_000,
      fixedTokens: 0,
    });
    expect(out.note).toContain('Earlier: fixed the login bug.');
    expect(out.messages[0]?.content).toBe('Explain the fix simply');
    expect(out.report.summary_id).toBe('sum1');
  });
});

describe('Claude Code turn plan', () => {
  it('goes on from its own last message, with a digest of what other models said since', () => {
    const all = mixed();
    const p = planClaudeTurn({
      messages: all,
      parentId: 'm4',
      threadSessionId: 'S',
      summary: null,
      seen: () => false,
      names: (id) => (id === 'openai/gpt-5' ? 'GPT-5' : null),
    });
    expect(p.anchor?.id).toBe('m2');
    expect(p.sessionId).toBe('S');
    expect(p.resumeAt).toBe('a1');
    expect(p.goneOn).toBe(false);
    expect(p.seed).toBeNull();
    expect(p.prefix).toContain(FOREIGN_OPEN);
    expect(p.prefix).toContain('User: Explain the fix simply');
    expect(p.prefix).toContain('GPT-5: The token now refreshes');
    // Its own history is never sent again.
    expect(p.prefix).not.toContain('Fixed the token refresh');
    expect(p.report.foreign_turns).toBe(2);
  });

  it('sends nothing extra when its own message is the parent', () => {
    const all = mixed();
    const p = planClaudeTurn({
      messages: all,
      parentId: 'm2',
      threadSessionId: 'S',
      summary: null,
      seen: () => false,
    });
    expect(p.prefix).toBeNull();
    expect(p.seed).toBeNull();
  });

  it('says when all it sends is a note on the sources: no turns, and the notice reads so', () => {
    const p = planClaudeTurn({
      messages: mixed(),
      parentId: 'm2',
      threadSessionId: 'S',
      summary: null,
      seen: () => false,
      notes: ['1 source added since your last turn: Spec'],
    });
    expect(p.prefix).toContain('Notebook: 1 source added');
    expect(p.report).toMatchObject({ foreign_turns: 0, source_notes: 1 });
    expect(claudeCodeContextNotice(p.report)).toBe(CLAUDE_CODE_SOURCES_NOTICE);
    expect(claudeCodeContextNotice({ ...p.report, foreign_turns: 2 })).toBe(CLAUDE_CODE_CONTEXT_NOTICE);
  });

  it('gives a new session (the folder changed) the whole thread so far, its own turns included', () => {
    const all = mixed();
    const p = planClaudeTurn({
      messages: all,
      parentId: 'm2',
      threadSessionId: 'S',
      summary: null,
      seen: () => false,
      fresh: true,
    });
    expect(p.prefix).toContain('before you joined it');
    expect(p.prefix).toContain('Fixed the token refresh');
  });

  it('keeps the digest within its budget, newest first', () => {
    const all = mixed();
    all[2] = { ...(all[2] as MessageRecord), parts: [text('long question '.repeat(2_000))] };
    const p = planClaudeTurn({
      messages: all,
      parentId: 'm4',
      threadSessionId: 'S',
      summary: null,
      seen: () => false,
      budget: 200,
    });
    expect(p.tokens).toBeLessThan(400);
    expect(p.prefix).toContain('The token now refreshes');
  });

  it('seeds a fresh session from a compaction the session has not seen, once', () => {
    const all = mixed();
    const summary = { id: 'sum1', uptoMessageId: 'm2', content: 'Fixed the login bug in auth.ts.' };
    const p = planClaudeTurn({
      messages: all,
      parentId: 'm4',
      threadSessionId: 'S',
      summary,
      seen: () => false,
    });
    expect(p.seed).toEqual({ summaryId: 'sum1' });
    expect(p.prefix).toContain('Fixed the login bug in auth.ts.');
    expect(p.prefix).toContain('The token now refreshes');
    expect(p.report.seeded_from_summary).toBe(true);
    const again = planClaudeTurn({
      messages: all,
      parentId: 'm4',
      threadSessionId: 'S',
      summary,
      seen: (s, id) => s === 'S' && id === 'sum1',
    });
    expect(again.seed).toBeNull();
  });

  it("puts a fresh session's seed inside the context block, so the echoed prompt is adopted", () => {
    const all = mixed();
    // A summary that itself mentions the block's tags (a thread about this very feature).
    const summary = {
      id: 'sum1',
      uptoMessageId: 'm2',
      content: 'We wrapped the digest in <ancile-context> and </ancile-context> tags.',
    };
    const p = planClaudeTurn({
      messages: all,
      parentId: 'm4',
      threadSessionId: 'S',
      summary,
      seen: () => false,
    });
    expect(p.seed).toEqual({ summaryId: 'sum1' });
    const prefix = p.prefix as string;
    expect(prefix.startsWith(FOREIGN_OPEN)).toBe(true);
    expect(prefix.trimEnd().endsWith('</ancile-context>')).toBe(true);
    // What live.ts sends, and what the mapper leaves once the block is taken out: the person's words.
    const sent = `${prefix}\n\nAnd what about tests?`;
    expect(stripReminders(sent).trim()).toBe('And what about tests?');
    expect(prefix).toContain('wrapped the digest in');
  });
});
