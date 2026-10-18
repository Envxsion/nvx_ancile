/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: one composer, any model
 *  Ref      |  docs/engines.md · packages/contracts/src/engines.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Which engines can answer now, the model picker's three
 *           |  groups (Claude Code, cloud, local) with the reason an
 *           |  entry is off, the one front door for a turn, and the
 *           |  quiet line that says a turn sends this thread's context
 *           |  to Claude Code.
 *  How      |  GET /engines for availability; the thread's effective
 *           |  scope (scopes/api.ts) for what is allowed; POST
 *           |  /threads/:id/turns for every turn. In a thread bound to
 *           |  a Claude Code session, its Claude Code group lists the
 *           |  session's own models; elsewhere it lists Claude Code as
 *           |  a model (claude-code/…) while it can answer, and a
 *           |  separate "Set up Claude Code" row when it cannot. Only
 *           |  models that can answer now are listed.
 *  Note     |  The context notice lives in engines/notice.ts, which
 *           |  imports nothing, so lib/run.ts can feed it.
 * ------------------------------------------------------------------
 */

import {
  CLAUDE_CODE_MODEL_PREFIX,
  type EngineInfo,
  isClaudeCodeModel,
  type SendTurnRequest,
  type SendTurnResult,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { modelOptions, useClaudeCodeCommands, useClaudeCodeLive } from '../claudecode/live';
import { useCcThread } from '../claudecode/store';
import { api } from '../lib/api';
import { canAnswer, useModels, useThread } from '../lib/data';
import type { Hue, ModelView } from '../lib/types';
import { billingTitle, displayName, modelBadge, sameModelBothWays } from '../models/billing';
import { checkModel, type ModelKind, useThreadScope } from '../scopes/api';
import { useUi } from '../state/ui';

export const ENGINE_KEYS = { list: ['engines'] as const };

export function useEngines() {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: ENGINE_KEYS.list,
    queryFn: () => api.get<{ items: EngineInfo[] }>('/engines').then((r) => r.items),
    enabled: !demo,
    staleTime: 30_000,
    retry: false,
  });
}

/** Which group a model belongs in. GPU nodes and loopback servers are local, as Core counts them. */
export function modelKind(m: Pick<ModelView, 'id' | 'via' | 'local'>): ModelKind {
  if (isClaudeCodeModel(m.id)) return 'claude_code';
  if (m.local !== undefined) return m.local ? 'local' : 'cloud';
  if (m.via === 'controller' || /^(ollama|local|fake|node)\//.test(m.id)) return 'local';
  return 'cloud';
}

export const BADGE: Record<ModelKind, string> = {
  claude_code: 'Claude Code',
  local: 'Local',
  cloud: 'Cloud',
};

export interface ModelEntry {
  /** What a send asks for: a model id, `claude-code/<name>` included. */
  id: string;
  name: string;
  hue: Hue;
  kind: ModelKind;
  /** Who pays: "Plan", "Key", "Local", "GPU node", "Rented", "Test" (the engine's name when Core sent no billing). */
  badge: string;
  /** The badge in words, for its tooltip and accessible label; null when not known. */
  badgeTitle: string | null;
  note: string | null;
  /** Why it cannot be chosen here, in a sentence; null when it can. */
  disabled: string | null;
  current: boolean;
  model?: ModelView;
}

export interface ModelGroup {
  kind: ModelKind;
  label: string;
  /** One line under the label saying how this group's models run; null for none. */
  note: string | null;
  items: ModelEntry[];
}

export const GROUP_LABEL: Record<ModelKind, string> = {
  claude_code: 'Claude Code models',
  cloud: 'Cloud models',
  local: 'Local models',
};

export const GROUP_NOTE: Record<ModelKind, string | null> = {
  claude_code: 'Runs as Claude Code, with its own tools and session.',
  cloud: "Runs through NVX Ancile, with your notebook's tools, memory and sources.",
  local: null,
};

/** The Claude Code model name a `claude-code/…` id asks for; null for the session's default. */
export function ccName(id: string): string | null {
  const n = id.startsWith(CLAUDE_CODE_MODEL_PREFIX) ? id.slice(CLAUDE_CODE_MODEL_PREFIX.length) : id;
  return n && n !== 'default' ? n : null;
}

interface GroupInput {
  models: ModelView[];
  engines: EngineInfo[] | undefined;
  scope: Parameters<typeof checkModel>[0];
  /** A thread bound to a Claude Code session: its own models, and what it uses now. */
  session: { options: { value: string; description: string | null }[]; current: string | null } | null;
  /** The id the next turn goes to. */
  currentId: string | null;
}

/**
 * The picker's groups, in a fixed order: Claude Code, cloud, local. Pure,
 * so the same groups feed the composer's menu, the palette and the tests.
 */
export function modelGroups(input: GroupInput): ModelGroup[] {
  const cc = input.engines?.find((e) => e.kind === 'claude_code');
  const ccOff = cc && !cc.available ? (cc.reason ?? 'Claude Code cannot answer now') : null;
  // The same Claude model on your plan and on an API key: each name says which.
  const dupes = sameModelBothWays(input.models);
  const entry = (m: ModelView): ModelEntry => {
    const kind = modelKind(m);
    return {
      id: m.id,
      name: displayName(m, dupes),
      hue: m.hue,
      kind,
      badge: modelBadge(m) ?? (kind === 'local' && m.via === 'controller' ? 'GPU node' : BADGE[kind]),
      badgeTitle: m.billing ? billingTitle(m.billing, m.price) : null,
      note: m.note ?? null,
      disabled: (kind === 'claude_code' ? ccOff : null) ?? checkModel(input.scope, kind, m.id),
      current: m.id === input.currentId,
      model: m,
    };
  };
  // Only models that can answer now; one that needs its key, is off or is not in Ollama is set up in Admin → Models.
  const chat = input.models.filter(canAnswer);
  let claude: ModelEntry[];
  if (input.session) {
    const opts = input.session.options.length
      ? input.session.options
      : [{ value: 'default', description: 'The session default' }];
    // The session runs on whatever Claude Code is signed in with: plan or key.
    const ccBilling = input.models.find((m) => modelKind(m) === 'claude_code' && m.billing)?.billing;
    claude = opts.map((o) => {
      const id = `${CLAUDE_CODE_MODEL_PREFIX}${o.value}`;
      return {
        id,
        name: o.value === 'default' ? 'Default model' : o.value,
        hue: 'coral',
        kind: 'claude_code',
        badge: ccBilling
          ? modelBadge({ billing: ccBilling, via: 'direct' }) || BADGE.claude_code
          : BADGE.claude_code,
        badgeTitle: ccBilling ? billingTitle(ccBilling) : null,
        note: o.description,
        disabled: ccOff ?? checkModel(input.scope, 'claude_code', id),
        current:
          input.currentId === id ||
          (input.currentId === `${CLAUDE_CODE_MODEL_PREFIX}default` && o.value === input.session?.current),
      };
    });
  } else {
    // Claude Code's models only while it can answer. When it cannot, the picker
    // shows one separate "Set up Claude Code" row instead (claudeCodeSetup), not a model.
    claude = ccOff ? [] : chat.filter((m) => modelKind(m) === 'claude_code').map(entry);
  }
  const rest = chat.filter((m) => modelKind(m) !== 'claude_code').map(entry);
  const groups: ModelGroup[] = [
    { kind: 'claude_code', label: GROUP_LABEL.claude_code, note: GROUP_NOTE.claude_code, items: claude },
    {
      kind: 'cloud',
      label: GROUP_LABEL.cloud,
      note: GROUP_NOTE.cloud,
      items: rest.filter((e) => e.kind === 'cloud'),
    },
    {
      kind: 'local',
      label: GROUP_LABEL.local,
      note: GROUP_NOTE.local,
      items: rest.filter((e) => e.kind === 'local'),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** The picker's row for Claude Code when it cannot answer: an action, never a model. */
export const SET_UP_CLAUDE_CODE = 'Set up Claude Code';

/** Why Claude Code cannot answer, for the "Set up Claude Code" row; null when it can, or when it is not known. */
export function claudeCodeSetup(engines: EngineInfo[] | undefined): string | null {
  const cc = engines?.find((e) => e.kind === 'claude_code');
  return cc && !cc.available ? (cc.reason ?? 'Claude Code cannot answer now') : null;
}

/**
 * The "Set up Claude Code" row's reason for this thread, or null. A thread
 * bound to a Claude Code session has none: its own notice offers the fix.
 */
export function useClaudeCodeSetup(threadId: string | undefined): string | null {
  const engines = useEngines().data;
  const thread = useThread(threadId);
  const demo = useUi((s) => s.demo);
  const bound = !demo && !!thread.data?.claudeCode;
  return bound ? null : claudeCodeSetup(engines);
}

/**
 * The groups for a thread (or for new threads, with no id). In a Claude
 * Code thread, the current entry is the other model chosen for the next
 * turn, else the session's model.
 */
export function useModelGroups(threadId: string | undefined, currentId: string | null): ModelGroup[] {
  const models = useModels().data;
  const engines = useEngines().data;
  const thread = useThread(threadId);
  const demo = useUi((s) => s.demo);
  const bound = !demo && !!thread.data?.claudeCode;
  const scope = useThreadScope(threadId).data?.effective;
  const commands = useClaudeCodeCommands(bound ? threadId : undefined).data;
  const live = useClaudeCodeLive(bound ? threadId : undefined).data;
  const cc = useCcThread(threadId ?? '');
  const ccCurrent = bound
    ? cc.other
      ? cc.other.id
      : `${CLAUDE_CODE_MODEL_PREFIX}${cc.model ?? 'default'}`
    : currentId;
  return useMemo(
    () =>
      modelGroups({
        models: models ?? [],
        engines,
        scope,
        session: bound
          ? { options: modelOptions(commands, live?.model ?? null), current: cc.model ?? live?.model ?? null }
          : null,
        currentId: ccCurrent,
      }),
    [models, engines, scope, bound, commands, live?.model, cc.model, ccCurrent],
  );
}

/* ---- Sending -------------------------------------------------------------- */

export function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** POST /threads/:id/turns: the one front door; the model chooses the engine. */
export function sendTurn(
  threadId: string,
  req: Omit<SendTurnRequest, 'idempotency_key'> & { idempotency_key?: string },
): Promise<SendTurnResult> {
  return api.post<SendTurnResult>(`/threads/${threadId}/turns`, {
    ...req,
    idempotency_key: req.idempotency_key ?? newIdempotencyKey(),
  });
}
