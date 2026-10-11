/**
 * ------------------------------------------------------------------
 *  Title    |  Your own automations
 *  Ref      |  docs/configuration.md#automations · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the automations you make in Admin do: ask a model,
 *           |  run a flow, re-check a notebook's web sources, remind
 *           |  you. Each is built on something Core already does.
 *  How      |  Ask and flow open a new thread and start a turn there
 *           |  through startTurn(), exactly as sending a message does,
 *           |  marked `automation`: every tool call it makes still goes
 *           |  through permissions/decide, and base.cedar raises
 *           |  anything with side effects to critical, so it waits for
 *           |  you. The run is not awaited: the automation's record
 *           |  says it started and links the thread; the thread shows
 *           |  how the answer went. Re-check calls Knowledge's stale
 *           |  check on the notebook's links; remind publishes a
 *           |  notification.
 * ------------------------------------------------------------------
 */

import type {
  AskModelConfig,
  NotifyConfig,
  RecheckSourcesConfig,
  RunFlowConfig,
  UserAutomationKind,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import type { EventBus } from '../events/bus';
import type { KnowledgeClient } from '../knowledge/client';
import { startTurn, type TurnDeps } from '../threads/service';
import type { JobContext, JobHandler, JobResult } from './runner';

export interface UserJobDeps {
  turn: TurnDeps;
  workspaceId: string;
  kn?: Pick<KnowledgeClient, 'get' | 'post'>;
  bus?: Pick<EventBus, 'publish'>;
  /** The flow still exists (a deleted flow fails the run with a reason). */
  flowExists?: (id: string) => Promise<boolean>;
  /** A notebook's title, or null when it is gone. */
  notebookTitle?: (id: string) => Promise<string | null>;
  now?: () => Date;
}

const enc = encodeURIComponent;

function gone(what: string, fix: string): Error {
  return new Error(`${what} no longer exists. ${fix}`);
}

export function userJobs(deps: UserJobDeps): Record<UserAutomationKind, JobHandler> {
  const now = deps.now ?? (() => new Date());
  const day = () => now().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const checkNotebook = async (id: string | null) => {
    if (!id || !deps.notebookTitle) return;
    if ((await deps.notebookTitle(id)) === null)
      throw gone('The notebook it uses', 'Edit the automation and pick another notebook.');
  };

  /** A new thread with the prompt sent in it, answered unattended. */
  const ask = async (
    ctx: JobContext,
    c: { prompt: string; notebook_id: string | null; model?: string | null; flow_id?: string },
  ): Promise<JobResult> => {
    await checkNotebook(c.notebook_id);
    const thread = await deps.turn.repo.createThread({
      id: `thr_${ulid()}`,
      workspace_id: deps.workspaceId,
      title: `${ctx.title}, ${day()}`,
      notebook_id: c.notebook_id,
      settings: { model: null },
    });
    await startTurn(deps.turn, {
      thread,
      user: { parentId: null, parts: [{ type: 'text', text: c.prompt }] },
      ...(c.model && { model: c.model }),
      ...(c.flow_id && { flowId: c.flow_id }),
      taskClass: 'chat.default',
      automation: true,
      provenanceExtra: { automation_id: ctx.id },
    });
    return {
      status: 'succeeded',
      detail: `Started an answer in "${thread.title}".`,
      href: `/t/${thread.id}`,
    };
  };

  return {
    ask_model: async (config, _signal, ctx) => {
      const c = config as AskModelConfig;
      return ask(ctx, { prompt: c.prompt, notebook_id: c.notebook_id ?? null, model: c.model ?? null });
    },

    run_flow: async (config, _signal, ctx) => {
      const c = config as RunFlowConfig;
      if (deps.flowExists && !(await deps.flowExists(c.flow_id)))
        throw gone('The flow it runs', 'Edit the automation and pick another flow.');
      return ask(ctx, { prompt: c.prompt, notebook_id: c.notebook_id ?? null, flow_id: c.flow_id });
    },

    recheck_sources: async (config) => {
      const c = config as RecheckSourcesConfig;
      if (!deps.kn) return { status: 'skipped', detail: 'The Knowledge service is not connected.' };
      await checkNotebook(c.notebook_id);
      const sources = await deps.kn.get<
        { id: string; kind: string }[] | { items: { id: string; kind: string }[] }
      >(`/notebooks/${enc(c.notebook_id)}/sources`);
      const list = Array.isArray(sources) ? sources : sources.items;
      const links = list.filter((s) => s.kind === 'url').map((s) => s.id);
      const href = `/n/${c.notebook_id}`;
      if (!links.length) return { status: 'skipped', detail: 'The notebook has no web sources.', href };
      const r = await deps.kn.post<Record<string, unknown>>('/maintenance/stale-check', {
        source_ids: links,
        force: true,
      });
      const checked = typeof r.checked === 'number' ? r.checked : links.length;
      const stale = typeof r.stale === 'number' ? r.stale : 0;
      return {
        status: 'succeeded',
        detail: `Checked ${checked} ${checked === 1 ? 'link' : 'links'}; ${stale} changed.`,
        href,
      };
    },

    notify: async (config, _signal, ctx) => {
      const c = config as NotifyConfig;
      if (!deps.bus) return { status: 'skipped', detail: 'Notifications are not available here.' };
      await deps.bus.publish({
        type: 'notification',
        id: `ntf_${ctx.id}_${now().getTime()}`,
        level: 'info',
        title: c.title,
        ...(c.body && { body: c.body }),
        action: { label: 'Open automations', href: '/admin/automations' },
      });
      return { status: 'succeeded', detail: 'Sent the reminder.' };
    },
  };
}
