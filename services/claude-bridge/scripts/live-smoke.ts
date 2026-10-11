/**
 * ------------------------------------------------------------------
 *  Title    |  Live-session smoke run (development only)
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · docs/claude-code.md
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Check the real wiring of a live session against the
 *           |  installed Claude Code, in a THROWAWAY temporary folder:
 *           |  the command list without a prompt, one trivial turn,
 *           |  then a fork of that turn. Never touches an existing
 *           |  session.
 *  How      |  CLAUDE_PATH=<verified claude> pnpm --filter
 *           |  @nvx/claude-bridge exec tsx scripts/live-smoke.ts
 *  Note     |  Prints shapes and counts only (message types, whether
 *           |  uuids match the transcript), never message content or
 *           |  account details. It uses the person's Claude Code
 *           |  account for two tiny turns. Not run by any test.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkLoader } from '../src/sdk';
import type { ClaudeAgentSdkLive, SdkQuery } from '../src/sdk-types';
import { type InputQueue, inputQueue } from '../src/session';

const cli = process.env.CLAUDE_PATH;
if (!cli) throw new Error('Set CLAUDE_PATH to the verified Claude Code executable');
const dataDir = await mkdtemp(join(tmpdir(), 'ancile-live-smoke-sdk-'));
const cwd = await mkdtemp(join(tmpdir(), 'ancile-live-smoke-cwd-'));

const sdk = (await new ClaudeSdkLoader({ dataDir }).load()) as unknown as ClaudeAgentSdkLive;

function transcript(sessionId: string): Record<string, unknown>[] {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f))
      return readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  return [];
}

async function turn(
  label: string,
  q: SdkQuery,
  input: InputQueue,
  text: string,
): Promise<{ sessionId: string; assistant: string[]; prompt: string; types: Record<string, number> }> {
  const prompt = randomUUID();
  input.push({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: prompt,
    session_id: '',
  });
  const types: Record<string, number> = {};
  const assistant: string[] = [];
  let sessionId = '';
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    const k = `${m.type}${m.subtype ? `/${m.subtype}` : ''}`;
    types[k] = (types[k] ?? 0) + 1;
    if (typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id;
    if (m.type === 'assistant' && typeof m.uuid === 'string') assistant.push(m.uuid);
    if (m.type === 'result') {
      console.log(`${label}: result`, {
        is_error: m.is_error,
        has_cost: typeof m.total_cost_usd === 'number',
        num_turns: m.num_turns,
        result_chars: typeof m.result === 'string' ? m.result.length : null,
      });
      break;
    }
  }
  console.log(`${label}: message types`, types);
  return { sessionId, assistant, prompt, types };
}

try {
  // 1. A session opened with no prompt: the command list, without spending tokens.
  {
    const input = inputQueue();
    const q = sdk.query({
      prompt: input.iterable,
      options: {
        cwd,
        pathToClaudeCodeExecutable: cli,
        persistSession: false,
        permissionMode: 'default',
        settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
        env: { ...process.env, DISABLE_TELEMETRY: '1' },
      },
    });
    const t0 = Date.now();
    const cmds = await q.supportedCommands();
    const models = await q.supportedModels();
    const mcp = await q.mcpServerStatus();
    console.log('no-prompt session:', {
      commands: cmds.length,
      builtin: cmds.filter((c) => c.builtin).length,
      sample_names: cmds.slice(0, 8).map((c) => c.name),
      models: models.length,
      mcp: mcp.length,
      ms: Date.now() - t0,
    });
    for (const detail of ['summary', 'full'] as const) {
      const u = await q
        .getContextUsage({ detail })
        .then((r) => ({ ok: true, keys: Object.keys(r).length, max: r.maxTokens }))
        .catch((e: Error) => ({ ok: false, error: e.message.slice(0, 200) }));
      console.log(`context usage (${detail}, no prompt):`, u);
    }
    input.end();
    q.close();
  }
  if (process.env.SMOKE_ONLY === 'commands') process.exit(0);

  // 2. One trivial turn in the throwaway folder.
  const asked: string[] = [];
  const opts = {
    cwd,
    pathToClaudeCodeExecutable: cli,
    permissionMode: 'default',
    includePartialMessages: true,
    settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
    env: { ...process.env, DISABLE_TELEMETRY: '1' },
    canUseTool: async (name: string) => {
      asked.push(name);
      return { behavior: 'deny' as const, message: 'smoke run: no tools' };
    },
  };
  const input1 = inputQueue();
  const q1 = sdk.query({ prompt: input1.iterable, options: opts });
  const a = await turn('turn 1', q1, input1, 'Reply with the word ok');
  const ctx = await q1.getContextUsage({ detail: 'summary' }).catch((e: Error) => ({ error: e.message }));
  console.log('context usage keys', Object.keys(ctx as object).slice(0, 8));
  input1.end();
  q1.close();
  const t1 = transcript(a.sessionId);
  const users = t1.filter((e) => e.type === 'user').map((e) => e.uuid);
  const asst = new Set(t1.filter((e) => e.type === 'assistant').map((e) => e.uuid));
  console.log('turn 1 transcript:', {
    entries: t1.length,
    prompt_uuid_kept: users.includes(a.prompt),
    assistant_uuids_match: a.assistant.every((u) => asst.has(u)),
    asked_tools: asked.length,
  });

  // 3. A fork from the first answer.
  const input2 = inputQueue();
  const q2 = sdk.query({
    prompt: input2.iterable,
    options: { ...opts, resume: a.sessionId, forkSession: true, resumeSessionAt: a.assistant.at(-1) },
  });
  const b = await turn('fork', q2, input2, 'Reply with the word yes');
  input2.end();
  q2.close();
  const t2 = transcript(b.sessionId);
  const shared = t2.filter((e) => typeof e.uuid === 'string' && t1.some((x) => x.uuid === e.uuid)).length;
  const keys = new Set<string>();
  for (const e of t2) for (const k of Object.keys(e)) keys.add(k);
  console.log('fork transcript:', {
    new_session: b.sessionId !== a.sessionId,
    entries: t2.length,
    uuids_shared_with_original: shared,
    keys: [...keys].sort(),
    prompt_uuid_kept: t2.some((e) => e.uuid === b.prompt),
  });
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
}
