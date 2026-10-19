/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: live sessions
 *  Ref      |  packages/contracts/src/claudecode.ts · docs/claude-code.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Carry a Claude Code session on from a thread: send a
 *           |  turn, stop it, read the session's live state and its
 *           |  own "/" command list, and turn that list into the
 *           |  composer's menu (grouped, fuzzy, with a second level
 *           |  for a command's values).
 *  How      |  Every turn goes through POST /threads/:id/turns (the
 *           |  one front door, docs/engines.md): a `claude-code/…`
 *           |  model carries the session on, any other model answers
 *           |  through the gateway and the thread keeps its session.
 *           |  The answer's id comes back, so the turn streams at
 *           |  once, exactly like chat. Refusals that have
 *           |  a fix (busy elsewhere, signed out, not installed, not
 *           |  verified) become the notice above the composer, not a
 *           |  toast. Live state polls quickly while a turn works and
 *           |  slowly otherwise; commands are cached for ten minutes.
 *  Note     |  A turn that sends this thread's context to Claude Code
 *           |  says so once, in one quiet line (engines/notice.ts).
 * ------------------------------------------------------------------
 */

import type {
  ClaudeCodeCommand,
  ClaudeCodeCommandList,
  ClaudeCodeLiveState,
  Part,
  ResumeCommand,
  SendClaudeCodeResult,
  SendTurnOutcome,
  SendTurnRequest,
  SendTurnResult,
} from '@nvx/contracts';
import { CLAUDE_CODE_MODEL_PREFIX } from '@nvx/contracts/engines';
import { useQuery } from '@tanstack/react-query';
import { showContextNotice } from '../engines/notice';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { attachRun } from '../lib/run';
import type { MessageView, ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import { isThreadBusy, markBusy } from '../thread/busy-store';
import { type CcRetry, type Effort, patchCc } from './store';

export const CC_LIVE_KEYS = {
  live: (threadId: string) => ['claude-code', 'live', threadId] as const,
  commands: (threadId: string) => ['claude-code', 'commands', threadId] as const,
};

/* ---- Queries -------------------------------------------------------------- */

/** The session's live state: quick while it works or starts, slow otherwise. */
export function useClaudeCodeLive(threadId: string | undefined) {
  return useQuery({
    queryKey: CC_LIVE_KEYS.live(threadId ?? ''),
    queryFn: () => api.get<ClaudeCodeLiveState>(`/claude-code/threads/${threadId}/live`),
    enabled: !!threadId,
    staleTime: 2_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d?.state === 'working' || d?.state === 'starting') return 2_500;
      // Open in a terminal, or messages waiting: watch closely, so terminal turns show
      // up as they happen and a waiting message's state stays current (CC6).
      if (d?.locked_elsewhere || d?.queue?.length) return 2_000;
      return 20_000;
    },
  });
}

/** How often a partial "/" list asks again, and for how long. */
const PARTIAL_POLL_MS = 1_500;
const PARTIAL_POLL_TRIES = 40;

/** A list response as a list: the current shape, or the bare array an older Core sends. */
export function commandItems(r: ClaudeCodeCommandList | ClaudeCodeCommand[] | undefined): {
  items: ClaudeCodeCommand[];
  partial: boolean;
} {
  if (Array.isArray(r)) return { items: r, partial: false };
  return { items: Array.isArray(r?.items) ? r.items : [], partial: r?.partial === true };
}

/**
 * Claude Code's own "/" list for the session's folder. Core answers at once
 * with the built-ins while it reads Claude Code's list; this asks again
 * until the whole list is there, so typing never waits on it.
 */
export function useClaudeCodeCommands(threadId: string | undefined) {
  return useQuery({
    queryKey: CC_LIVE_KEYS.commands(threadId ?? ''),
    queryFn: () =>
      api.get<ClaudeCodeCommandList | ClaudeCodeCommand[]>(`/claude-code/threads/${threadId}/commands`),
    enabled: !!threadId,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) =>
      commandItems(q.state.data).partial && q.state.dataUpdateCount < PARTIAL_POLL_TRIES
        ? PARTIAL_POLL_MS
        : false,
    select: (r) => commandItems(r).items,
  });
}

export function refreshLive(threadId: string): void {
  void queryClient.invalidateQueries({ queryKey: CC_LIVE_KEYS.live(threadId) });
}

/* ---- Send and stop -------------------------------------------------------- */

const FIXABLE = {
  'claude_code.signed_out': 'signed_out',
  'claude_code.not_installed': 'not_installed',
  'claude_code.unverified': 'unverified',
} as const;

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Your message (and its answer, still empty) on the cached path at once. */
function placeTurn(
  threadId: string,
  parentId: string | null,
  s: Pick<SendTurnResult, 'run_id' | 'user_message_id'> & { assistant_message_id?: string | null },
  text: string,
  other: { id: string; name: string } | null,
): string {
  const now = new Date().toISOString();
  const parts: Part[] = [{ type: 'text', text }];
  const answerId = s.assistant_message_id ?? `cc-pending-${s.run_id}`;
  const rows: MessageView[] = [
    {
      id: s.user_message_id,
      parentId,
      role: 'user',
      blocks: [],
      parts,
      modelId: null,
      createdAt: now,
      status: 'complete',
    },
    {
      id: answerId,
      parentId: s.user_message_id,
      role: 'assistant',
      blocks: [],
      parts: [],
      modelId: other?.id ?? null,
      ...(!other && { modelName: 'Claude Code' }),
      createdAt: now,
      status: 'pending',
      runId: s.run_id,
    },
  ];
  queryClient.setQueryData<ThreadView>(keys.thread(threadId), (t) => {
    if (!t) return t;
    const cut = parentId ? t.messages.findIndex((m) => m.id === parentId) : -1;
    const kept = parentId ? (cut >= 0 ? t.messages.slice(0, cut + 1) : t.messages) : [];
    return { ...t, messages: [...kept, ...rows], activeRun: null };
  });
  return answerId;
}

export interface CcSend {
  threadId: string;
  /**
   * The message this turn answers; Claude Code forks there when it is not
   * the latest. null: the start of the session (editing its first message
   * starts a new session in the same folder, as a branch at the root).
   */
  parentId: string | null;
  text: string;
  model?: string | null;
  effort?: Effort | null;
  sourceIds?: string[];
  /** Images attached to this turn (POST /threads/:id/images). */
  imageIds?: string[];
  asBranch?: boolean;
  /** Another model answers this turn instead of Claude Code; the thread keeps its session. */
  other?: { id: string; name: string } | null;
}

/** What the turn asks for: another model as it is, else Claude Code on the chosen model. */
export function turnModel(o: Pick<CcSend, 'model' | 'other'>): string {
  return o.other?.id ?? `${CLAUDE_CODE_MODEL_PREFIX}${o.model ?? 'default'}`;
}

/** One turn in a Claude Code thread, through POST /threads/:id/turns. Resolves false when nothing was sent. */
export async function sendClaudeCode(o: CcSend): Promise<boolean> {
  const other = o.other ?? null;
  const body: SendTurnRequest = {
    text: o.text,
    parent_id: o.parentId,
    idempotency_key: newKey(),
    model: turnModel(o),
    // "auto" is Claude Code's own choice: send nothing.
    ...(!other && o.effort && o.effort !== 'auto' && { effort: o.effort }),
    ...(o.sourceIds?.length && { source_ids: o.sourceIds }),
    ...(o.imageIds?.length && { image_ids: o.imageIds }),
    ...(!other && o.asBranch && { as_branch: true }),
    // Busy (answering, or open in a terminal): the message waits in Core's queue and goes
    // into the same session when it is free, instead of failing or forking (CC6).
    ...(!other && !o.asBranch && { queue_if_busy: true }),
  };
  let s: SendTurnResult;
  try {
    const out = await api.post<SendTurnOutcome>(`/threads/${o.threadId}/turns`, body);
    if ('queued' in out) {
      refreshLive(o.threadId);
      return true;
    }
    s = out;
  } catch (error) {
    const retry: CcRetry = {
      text: o.text,
      parentId: o.parentId,
      ...(o.sourceIds && { sourceIds: o.sourceIds }),
    };
    // Another window is sending here: offer to send it as a branch (a fork of the session) once it ends.
    if (error instanceof ApiCallError && isThreadBusy(error.body.error.code)) {
      markBusy(o.threadId, () => sendClaudeCode({ ...o, asBranch: !o.other }));
      return false;
    }
    reportSendFailure(o.threadId, error, retry);
    return false;
  }
  patchCc(o.threadId, { notice: null });
  if (s.branched === 'open_in_terminal')
    notify({
      level: 'info',
      title: 'Sent as a branch',
      body: "This session is open in a terminal, so it carries on in a branch here. The terminal's session is left as it is.",
    });
  const answerId = placeTurn(o.threadId, o.parentId, s, o.text, other);
  if (s.context_notice) showContextNotice(o.threadId, s.context_notice, s.assistant_message_id ?? null);
  if (s.assistant_message_id) attachRun({ runId: s.run_id, threadId: o.threadId, messageId: answerId });
  // The refetch brings the saved rows (and, from an older Core, the answer's run).
  void queryClient.invalidateQueries({ queryKey: keys.thread(o.threadId) });
  void queryClient.invalidateQueries({ queryKey: keys.threads });
  refreshLive(o.threadId);
  return true;
}

function reportSendFailure(threadId: string, error: unknown, retry: CcRetry): void {
  if (error instanceof ApiCallError) {
    const { code, title, hint } = error.body.error;
    if (code === 'claude_code.session_busy') {
      patchCc(threadId, { notice: { kind: 'busy', retry } });
      return;
    }
    if (code === 'claude_code.folder_missing') {
      const cwd = queryClient.getQueryData<ThreadView>(keys.thread(threadId))?.claudeCode?.cwd ?? null;
      patchCc(threadId, { notice: { kind: 'folder_missing', cwd, retry } });
      refreshLive(threadId);
      return;
    }
    const kind = FIXABLE[code as keyof typeof FIXABLE];
    if (kind) {
      patchCc(threadId, { notice: { kind, title, hint } });
      return;
    }
    notify({ level: 'error', title, body: hint });
    return;
  }
  notify({
    level: 'error',
    title: "Your message didn't reach Core",
    body: 'Check that NVX Ancile is running, then try again. Your text is kept.',
  });
}

/** "Continue as a branch": the same message, forked so the other session is never written to. */
export function continueAsBranch(
  threadId: string,
  retry: CcRetry,
  opts: { model?: string | null; effort?: Effort | null; other?: CcSend['other'] } = {},
): Promise<boolean> {
  return sendClaudeCode({ threadId, ...retry, ...opts, asBranch: true });
}

/**
 * The model changed while a turn works: any approval it is waiting on was
 * asked under the old choice, so Core withdraws it (never left to answer
 * later). Quiet when nothing was waiting.
 */
export async function withdrawForModelChange(threadId: string): Promise<void> {
  const live = queryClient.getQueryData<ClaudeCodeLiveState>(CC_LIVE_KEYS.live(threadId));
  if (live?.state !== 'working') return;
  try {
    const r = await api.post<{ withdrawn: number }>(`/claude-code/threads/${threadId}/model-changed`);
    if (r.withdrawn > 0)
      notify({
        level: 'info',
        title:
          r.withdrawn === 1 ? 'The waiting request was withdrawn' : 'The waiting requests were withdrawn',
        body: 'They were asked before you changed the model. Claude Code hears they were withdrawn; it can ask again.',
      });
  } catch {
    // Nothing to withdraw, or Core is away: the turn's end withdraws them anyway.
  }
}

/** Stop the running turn: Claude Code's own interrupt. What streamed is kept. */
export async function interruptClaudeCode(threadId: string): Promise<void> {
  try {
    await api.post(`/claude-code/threads/${threadId}/interrupt`);
  } catch (error) {
    // Nothing running any more is not worth a toast.
    if (error instanceof ApiCallError && error.body.error.code === 'claude_code.not_live') return;
    if (error instanceof ApiCallError)
      notify({ level: 'error', title: error.body.error.title, body: error.body.error.hint });
    else
      notify({ level: 'error', title: "Stop didn't reach Core", body: 'Check that NVX Ancile is running.' });
  }
  refreshLive(threadId);
}

/* ---- The "/" menu --------------------------------------------------------- */

export const CC_GROUPS: { source: ClaudeCodeCommand['source']; label: string }[] = [
  { source: 'builtin', label: 'Built-in' },
  { source: 'skill', label: 'Your skills' },
  { source: 'plugin', label: 'Plugins' },
  { source: 'mcp', label: 'MCP prompts' },
  { source: 'custom', label: 'Custom' },
  { source: 'ancile', label: 'NVX Ancile' },
];

const groupLabel = (s: ClaudeCodeCommand['source']) =>
  CC_GROUPS.find((g) => g.source === s)?.label ?? 'Custom';
const groupRank = (s: ClaudeCodeCommand['source']) => {
  const i = CC_GROUPS.findIndex((g) => g.source === s);
  return i < 0 ? CC_GROUPS.length : i;
};

/** NVX Ancile's own commands that make sense in any thread; Claude Code's win on a clash. */
export interface AncileExtra {
  name: string;
  description: string;
  run: 'sources' | 'shortcuts';
}

export interface CcMenuItem {
  /** What the row shows: "/compact", or a value at the second level. */
  label: string;
  hint: string;
  group: string;
  argHint: string | null;
  /** "Terminal only", "Opens in NVX Ancile". */
  tag: string | null;
  command?: ClaudeCodeCommand;
  /** Second level: the value picked for `command`. */
  arg?: string;
  extra?: AncileExtra;
}

/**
 * Higher is better; null: no match. Prefix beats substring beats letters
 * in order; the description counts only a little.
 */
export function fuzzyScore(query: string, name: string, description = ''): number | null {
  const q = query.toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) return 700 - at;
  let j = 0;
  let gaps = 0;
  for (let i = 0; i < n.length && j < q.length; i++) {
    if (n[i] === q[j]) j++;
    else if (j > 0) gaps++;
  }
  if (j === q.length) return 400 - gaps;
  if (description.toLowerCase().includes(q)) return 100;
  return null;
}

function tagOf(c: ClaudeCodeCommand): string | null {
  if (c.ancile_action === 'unsupported') return 'Terminal only';
  if (c.handled_by === 'ancile' && c.ancile_action !== 'set_model' && c.ancile_action !== 'set_effort')
    return 'Opens in NVX Ancile';
  return null;
}

/** The command a typed "/name …" refers to, if Claude Code (or NVX Ancile) knows it. */
export function findCommand(commands: ClaudeCodeCommand[], name: string): ClaudeCodeCommand | undefined {
  const n = name.toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === n);
}

/**
 * The composer's menu for a Claude Code thread. First level while you type
 * "/name"; second level once a command with known values is followed by a
 * space ("/effort h").
 */
export function ccMenu(
  text: string,
  commands: ClaudeCodeCommand[],
  extras: AncileExtra[] = [],
): { level: 1 | 2; items: CcMenuItem[]; command?: ClaudeCodeCommand } | null {
  const first = /^\/(\S*)$/.exec(text);
  if (first) {
    const q = first[1] ?? '';
    const taken = new Set(commands.map((c) => c.name.toLowerCase()));
    const rows: { item: CcMenuItem; score: number; rank: number; order: number }[] = [];
    commands.forEach((c, order) => {
      const score = fuzzyScore(q, c.name, c.description);
      if (score === null) return;
      rows.push({
        item: {
          label: `/${c.name}`,
          hint: c.description,
          group: groupLabel(c.source),
          argHint: c.argument_hint,
          tag: tagOf(c),
          command: c,
        },
        score,
        rank: groupRank(c.source),
        order,
      });
    });
    extras.forEach((x, i) => {
      if (taken.has(x.name.toLowerCase())) return;
      const score = fuzzyScore(q, x.name, x.description);
      if (score === null) return;
      rows.push({
        item: {
          label: `/${x.name}`,
          hint: x.description,
          group: 'NVX Ancile',
          argHint: null,
          tag: null,
          extra: x,
        },
        score,
        rank: groupRank('ancile'),
        order: commands.length + i,
      });
    });
    rows.sort((a, b) => (q ? b.score - a.score : 0) || a.rank - b.rank || a.order - b.order);
    return { level: 1, items: rows.map((r) => r.item) };
  }
  const second = /^\/(\S+) (\S*)$/.exec(text);
  if (second) {
    const c = findCommand(commands, second[1] ?? '');
    if (!c || c.arguments.length === 0) return null;
    const q = second[2] ?? '';
    const items = c.arguments
      .map((a, order) => ({ a, order, score: fuzzyScore(q, a.value, a.description ?? '') }))
      .filter((r): r is typeof r & { score: number } => r.score !== null && r.a.value !== q)
      .sort((x, y) => (q ? y.score - x.score : 0) || x.order - y.order)
      .map(
        ({ a }): CcMenuItem => ({
          label: a.value,
          hint: a.description ?? '',
          group: `/${c.name}`,
          argHint: null,
          tag: null,
          command: c,
          arg: a.value,
        }),
      );
    return { level: 2, items, command: c };
  }
  return null;
}

/** "/effort high" → the command and its first word, when it is one Claude Code knows. */
export function parseTyped(
  text: string,
  commands: ClaudeCodeCommand[],
): { command: ClaudeCodeCommand; arg: string | null } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const command = findCommand(commands, m[1] ?? '');
  if (!command) return null;
  return { command, arg: m[2]?.trim() || null };
}

/* ---- Words ------------------------------------------------------------------ */

/** "Claude Code ready in cyberfolio", "Starting Claude Code…", "Working…". */
export function liveWords(live: ClaudeCodeLiveState | undefined, folder: string | null): string {
  const where = live?.no_files ? ' without files' : folder ? ` in ${folder}` : '';
  if (!live) return `Claude Code${where}`;
  if (live.folder_missing && !live.no_files) return "This session's folder has moved or been deleted";
  if (live.open_in_terminal) return 'Open in a terminal: messages wait here until it closes';
  if (live.locked_elsewhere) return 'Written from somewhere else just now: messages wait a moment';
  switch (live.state) {
    case 'starting':
      return 'Starting Claude Code…';
    case 'working':
      return 'Working…';
    case 'ready':
      return `Claude Code ready${where}`;
    default:
      return `Claude Code${where}, starts when you send`;
  }
}

/** 12400 → "12.4k"; 200000 → "200k". */
export function tokensShort(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

/** The models /model offers (its values), with the session's own first when it is not among them. */
export function modelOptions(
  commands: ClaudeCodeCommand[] | undefined,
  current: string | null,
): { value: string; description: string | null }[] {
  const cmd =
    commands?.find((c) => c.ancile_action === 'set_model') ?? commands?.find((c) => c.name === 'model');
  const opts = cmd?.arguments ?? [];
  return current && !opts.some((o) => o.value === current)
    ? [{ value: current, description: 'What the session uses now' }, ...opts]
    : opts;
}

/* ---- Waiting messages and the terminal (CC6) -------------------------------- */

const queueFailed = (error: unknown) =>
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : 'NVX Ancile did not answer',
    body: error instanceof ApiCallError ? error.body.error.hint : 'Check that it is running, then try again.',
  });

/** Take a waiting message off the queue; Undo puts its words back in the composer's hands. */
export async function removeQueued(threadId: string, id: string): Promise<boolean> {
  try {
    await api.del(`/claude-code/threads/${threadId}/queue/${id}`);
    refreshLive(threadId);
    return true;
  } catch (error) {
    queueFailed(error);
    return false;
  }
}

/** A message that failed to send: try it again once the session is free. */
export async function retryQueued(threadId: string, id: string): Promise<void> {
  try {
    await api.post(`/claude-code/threads/${threadId}/queue/${id}/retry`, {});
    refreshLive(threadId);
  } catch (error) {
    queueFailed(error);
  }
}

/** Don't wait: send a waiting message now, as a branch of the session (the terminal's line is left alone). */
export async function branchQueued(threadId: string, id: string): Promise<void> {
  try {
    const r = await api.post<SendClaudeCodeResult>(`/claude-code/threads/${threadId}/queue/${id}/branch`, {});
    attachRun({ runId: r.run_id, threadId, messageId: r.assistant_message_id });
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    refreshLive(threadId);
  } catch (error) {
    queueFailed(error);
  }
}

/** Copy what carries this session on in a terminal (folder, then `claude --resume <id>`). */
export async function copyResume(resume: ResumeCommand): Promise<void> {
  try {
    await navigator.clipboard.writeText(resume.shell);
    notify({
      level: 'success',
      title: 'Command copied',
      body: 'Paste it into a terminal to carry this session on there. Messages sent here meanwhile wait for it to close.',
    });
  } catch {
    notify({ level: 'info', title: 'Copy this into a terminal', body: resume.shell });
  }
}
