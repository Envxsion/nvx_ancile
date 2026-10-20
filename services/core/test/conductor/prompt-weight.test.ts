/**
 * ------------------------------------------------------------------
 *  Title    |  What a turn costs before its content
 *  Ref      |  docs/engines.md (Context for each engine) · DESIGN.md §5.2
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A live test found every gateway turn starting at about
 *           |  4,600 input tokens (one line to Haiku: $0.005 before any
 *           |  content), a "no source matched" note for a notebook with
 *           |  no sources that models copied into answers, and Claude
 *           |  Code's own error saved as an answer. Each is held here.
 * ------------------------------------------------------------------
 */

import type { SearchResponse } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { describeFailure } from '../../src/conductor/pipeline';
import { emptyNote, type Retriever } from '../../src/conductor/retrieval';
import { offeredTools } from '../../src/conductor/tool-offer';
import { ChainFailedError } from '../../src/gateway/gateway';
import { approxTokens } from '../../src/memory/inject';
import { repoTools } from '../../src/repos/tools';
import { fsTools } from '../../src/tools/builtin/fs';
import type { ToolSpec } from '../../src/tools/registry';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const asSpec = (t: ToolSpec): ToolSpec => t;
const tokensOf = (tools: ToolSpec[]) =>
  approxTokens(
    JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema }))),
  );
const gitTools = () => repoTools({} as never, {} as never).map(asSpec);

describe('the tools a turn offers', () => {
  const all = () => [...fsTools({ root: '/w' } as never), ...gitTools()];

  it('leaves out the git and GitHub schemas while no repository is registered', () => {
    const none = offeredTools(all(), { hasRepos: false });
    expect(none.some((t) => /^(git|gh)_/.test(t.name))).toBe(false);
    expect(none.map((t) => t.name)).toContain('fs_read');
    // Measured: all 22 repository tools weigh about 1,900 tokens; the four file tools about 330.
    expect(tokensOf(all())).toBeGreaterThan(2_000);
    expect(tokensOf(none)).toBeLessThan(500);
  });

  it('offers every tool once a repository is registered', () => {
    expect(offeredTools(all(), { hasRepos: true })).toHaveLength(all().length);
  });

  it('sends a one-line turn without repository tools until there is a repository', async () => {
    h = await harness({ extraTools: gitTools(), hasRepos: false });
    const t = await h.newThread();
    const sent = await h.send(t, 'Say hello');
    await h.settle(sent.run_id);
    const names = (h.provider.calls.at(-1)?.req.tools ?? []).map((x) => x.name);
    expect(names).toContain('fs_list');
    expect(names.some((n) => n.startsWith('git_'))).toBe(false);
    await h.close();
    h = await harness({ extraTools: gitTools(), hasRepos: true });
    const t2 = await h.newThread();
    const sent2 = await h.send(t2, 'Say hello');
    await h.settle(sent2.run_id);
    expect((h.provider.calls.at(-1)?.req.tools ?? []).some((x) => x.name === 'git_status')).toBe(true);
  });
});

describe('a notebook with no sources', () => {
  const RESP: SearchResponse = { hits: [], mode: 'hybrid', embedder: 'x', ms: 1 };

  it('is not searched, and neither the note nor the chip is made', async () => {
    let searched = 0;
    const retriever: Retriever = {
      search: async () => {
        searched++;
        return RESP;
      },
    };
    h = await harness({ retriever, sourceCount: 0 });
    const t = await h.newThread({ notebook_id: 'nbk_empty' });
    const sent = await h.send(t, 'Say hello');
    await h.settle(sent.run_id);
    expect(searched).toBe(0);
    const req = h.provider.calls.at(-1)?.req;
    const all = `${req?.system ?? ''}\n${(req?.messages ?? []).map((m) => m.content).join('\n')}`;
    expect(all).not.toMatch(/none of its sources|held nothing relevant|searched/i);
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'retrieval.done')).toBe(false);
  });

  it('with sources but no match keeps the chip and a note models have nothing to copy', async () => {
    h = await harness({ retriever: { search: async () => RESP }, sourceCount: 3 });
    const t = await h.newThread({ notebook_id: 'nbk_full' });
    const sent = await h.send(t, 'Say hello');
    await h.settle(sent.run_id);
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'retrieval.done')).toBe(true);
    const note = emptyNote('Pumps');
    expect(note).toMatch(/do not mention/i);
    expect(note).not.toMatch(/say so/i);
  });
});

describe("Claude Code's own limit", () => {
  it('is its own error, not the chain-exhausted one', () => {
    const f = describeFailure(
      new ChainFailedError([
        {
          model: 'claude-code/haiku',
          errorClass: 'permanent',
          detail:
            "Claude Code said its prompt was too long (Prompt is too long). NVX Ancile sent it about 1k tokens; the rest is Claude Code's own setup.",
        },
      ]),
    );
    expect(f?.event.code).toBe('claude_code.prompt_too_long');
    expect(f?.event.title).toMatch(/own setup/);
    expect(f?.event.attempts).toHaveLength(1);
  });
});
