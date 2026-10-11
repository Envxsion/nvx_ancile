/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: the composer's edge
 *  Ref      |  docs/claude-code.md (Live sessions, Commands)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a Claude Code thread adds around the
 *           |  composer: one quiet status line (ready, starting,
 *           |  working, with the model, effort and Claude Code's own
 *           |  context meter and its usage popover), the one notice
 *           |  that needs you (busy elsewhere, signed out, a restart),
 *           |  a queued message, the model and effort pickers, and
 *           |  what NVX Ancile does for the "/" commands it handles.
 *  How      |  Live state from useClaudeCodeLive; choices and notices
 *           |  from the per-thread store (claudecode/store.ts). The
 *           |  pickers are controlled so "/model" and "/effort" can
 *           |  open them.
 *  Note     |  Signal violet is the working dot only. The cost is an
 *           |  estimate at API list prices and says so.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeBinding, ClaudeCodeCommand, ClaudeCodeLiveState } from '@nvx/contracts';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useState } from 'react';
import { branchHere } from '../lib/branching';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { createThread } from '../lib/turns';
import type { MessageView } from '../lib/types';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { useBranchLayer } from '../tree/store';
import { Icon } from '../ui/Icon';
import { startClaudeCodeSignIn } from './api';
import { continueAsBranch, liveWords, modelOptions, tokensShort } from './live';
import { type CcNotice, EFFORTS, type Effort, isEffort, patchCc, useCcThread } from './store';
import { folderName } from './ThreadMarker';
import '../styles/claudecode.css';
import '../styles/cclive.css';

const rise = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6, transition: { duration: 0.12 } },
  transition: { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] as const },
};

const EFFORT_WORDS: Record<Effort, string> = {
  low: 'Quick answers, least thinking',
  medium: 'Some thinking',
  high: 'Thinks it through',
  xhigh: 'Thinks harder',
  max: 'The most thinking Claude Code allows',
  auto: 'Claude Code decides',
};

/* ---- Status line ------------------------------------------------------------ */

/** The last answer Claude Code gave on this path, for the usage popover. */
export function lastTurn(messages: MessageView[]): MessageView | undefined {
  return messages.findLast((m) => m.role === 'assistant' && !m.cc && !!m.usage);
}

export function CcLiveLine({
  threadId,
  binding,
  live,
  last,
}: {
  threadId: string;
  binding: ClaudeCodeBinding;
  live: ClaudeCodeLiveState | undefined;
  last: MessageView | undefined;
}) {
  const st = useCcThread(threadId);
  const folder = folderName(live?.cwd ?? binding.cwd);
  const ctx = live?.context ?? null;
  const pct = ctx ? Math.max(0, Math.min(100, ctx.percent)) : null;
  const effort = st.effort ?? (isEffort(live?.effort) ? live.effort : null);
  const model = st.model ?? live?.model ?? null;
  const state = live?.locked_elsewhere ? 'elsewhere' : (live?.state ?? 'idle');
  const tone = pct === null ? 'calm' : pct >= 90 ? 'over' : pct >= 75 ? 'high' : 'calm';

  return (
    <div className="cc-live" data-state={state}>
      <span className="cc-live__dot" aria-hidden="true" />
      <span className="cc-live__text" aria-live="polite">
        {liveWords(live, folder)}
      </span>
      {model || effort ? (
        <span className="cc-live__meta" data-num>
          {[model, effort ? `${effort} effort` : null].filter(Boolean).join(' · ')}
        </span>
      ) : null}
      <Popover.Root open={st.usageOpen} onOpenChange={(o) => patchCc(threadId, { usageOpen: o })}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="cc-live__usage"
            data-tone={tone}
            aria-label={
              pct === null
                ? 'Claude Code usage'
                : `Claude Code's context: ${Math.round(pct)}% used. Show usage`
            }
          >
            {pct === null ? (
              <Icon name="pulse" size={12} />
            ) : (
              <>
                <span
                  className="cc-live__meter"
                  role="meter"
                  aria-label="Claude Code's context used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                >
                  <span style={{ transform: `scaleX(${pct / 100})` }} />
                </span>
                <span data-num>{Math.round(pct)}%</span>
              </>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="cc-usage m-glass-thick"
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
          >
            <UsageBody live={live} last={last} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function UsageBody({
  live,
  last,
}: {
  live: ClaudeCodeLiveState | undefined;
  last: MessageView | undefined;
}) {
  const ctx = live?.context ?? null;
  const cost = last?.usage?.costUsd ?? 0;
  return (
    <div className="cc-usage__body">
      <p className="cc-usage__title">Claude Code usage</p>
      <dl className="cc-usage__facts">
        <dt>Context</dt>
        <dd data-num>
          {ctx
            ? `${tokensShort(ctx.used_tokens)} of ${tokensShort(ctx.max_tokens)} tokens (${Math.round(ctx.percent)}%)`
            : 'Shown once the session is open'}
        </dd>
        <dt>Last turn</dt>
        <dd data-num>
          {last?.usage ? `${last.usage.tokens.toLocaleString('en-GB')} tokens` : 'No turn yet'}
        </dd>
        {cost > 0 ? (
          <>
            <dt>Cost</dt>
            <dd>
              <span data-num>${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}</span>
              <span className="cc-usage__note">estimate at API list prices, not your bill</span>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="cc-usage__foot">
        Claude Code counts its own context and compacts it by itself. Type <code>/compact</code> to do it now.
      </p>
    </div>
  );
}

/* ---- Pickers ---------------------------------------------------------------- */

export function CcPickers({
  threadId,
  live,
  commands,
}: {
  threadId: string;
  live: ClaudeCodeLiveState | undefined;
  commands: ClaudeCodeCommand[] | undefined;
}) {
  const st = useCcThread(threadId);
  const currentModel = st.model ?? live?.model ?? null;
  const currentEffort: Effort = st.effort ?? (isEffort(live?.effort) ? live.effort : 'auto');
  const models = modelOptions(commands, live?.model ?? null);
  const setOpen = (which: 'model' | 'effort') => (o: boolean) =>
    patchCc(threadId, { picker: o ? which : null });

  return (
    <>
      <DM.Root modal={false} open={st.picker === 'model'} onOpenChange={setOpen('model')}>
        <DM.Trigger asChild>
          <button
            type="button"
            className="cc-pick"
            aria-label={`Claude Code model: ${currentModel ?? 'the session default'}. Change model`}
          >
            <Icon name="model" size={12} />
            <span className="cc-pick__label">{currentModel ?? 'Default model'}</span>
            <Icon name="chevronDown" size={10} />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content
            className="menu cc-pick__menu"
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
          >
            <DM.Label className="menu__label">Model for the next message</DM.Label>
            {models.length === 0 ? (
              <DM.Item className="menu__item" disabled>
                <span className="menu__noicon" />
                <span className="menu__text">Claude Code lists no models here</span>
              </DM.Item>
            ) : (
              models.map((m) => (
                <DM.Item
                  key={m.value}
                  className="menu__item"
                  onSelect={() => patchCc(threadId, { model: m.value })}
                >
                  {m.value === currentModel ? (
                    <Icon name="check" size={14} />
                  ) : (
                    <span className="menu__noicon" />
                  )}
                  <span className="menu__text">
                    {m.value}
                    {m.description ? <span className="cc-pick__desc">{m.description}</span> : null}
                  </span>
                </DM.Item>
              ))
            )}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      <DM.Root modal={false} open={st.picker === 'effort'} onOpenChange={setOpen('effort')}>
        <DM.Trigger asChild>
          <button type="button" className="cc-pick" aria-label={`Effort: ${currentEffort}. Change effort`}>
            <Icon name="zap" size={12} />
            <span className="cc-pick__label">{currentEffort === 'auto' ? 'Auto effort' : currentEffort}</span>
            <Icon name="chevronDown" size={10} />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content
            className="menu cc-pick__menu"
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
          >
            <DM.Label className="menu__label">Effort for the next message</DM.Label>
            {EFFORTS.map((e) => (
              <DM.Item key={e} className="menu__item" onSelect={() => patchCc(threadId, { effort: e })}>
                {e === currentEffort ? <Icon name="check" size={14} /> : <span className="menu__noicon" />}
                <span className="menu__text">
                  {e}
                  <span className="cc-pick__desc">{EFFORT_WORDS[e]}</span>
                </span>
              </DM.Item>
            ))}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </>
  );
}

/* ---- Notices ---------------------------------------------------------------- */

const FIX_WORDS: Record<'signed_out' | 'not_installed' | 'unverified', string> = {
  signed_out: 'Sign in to Claude Code',
  not_installed: 'Open Claude Code settings',
  unverified: 'Open Claude Code settings',
};

export function CcNotices({ threadId }: { threadId: string }) {
  const st = useCcThread(threadId);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const n = st.notice;
  const close = () => patchCc(threadId, { notice: null });

  const branch = async (notice: Extract<CcNotice, { kind: 'busy' }>) => {
    setBusy(true);
    await continueAsBranch(threadId, notice.retry, { model: st.model, effort: st.effort });
    setBusy(false);
  };

  return (
    <div className="cc-notices" aria-live="polite">
      <AnimatePresence initial={false}>
        {st.queued ? (
          <motion.div key="queued" className="hint-line cc-queued" {...rise}>
            <Icon name="clock" size={12} className="hint-line__icon" />
            <span className="hint-line__text">
              <strong>Queued</strong> {st.queued.text}
            </span>
            <span className="mute cc-queued__when">Sends when this turn ends</span>
            <button
              type="button"
              className="icon-btn icon-btn--xs hint-line__close"
              aria-label="Remove the queued message"
              onClick={() => patchCc(threadId, { queued: null })}
            >
              <Icon name="close" size={11} />
            </button>
          </motion.div>
        ) : null}
        {n ? (
          <motion.div
            key={n.kind}
            className="cc-notice"
            data-kind={n.kind}
            role={n.kind === 'recovered' ? 'status' : 'alert'}
            {...rise}
          >
            <Icon
              name={
                n.kind === 'busy'
                  ? 'branch'
                  : n.kind === 'recovered'
                    ? 'regenerate'
                    : n.kind === 'unsupported'
                      ? 'terminal'
                      : 'alert'
              }
              size={14}
              className="cc-notice__icon"
            />
            <div className="cc-notice__text">
              {n.kind === 'busy' ? (
                <p>
                  This session is open in Claude Code somewhere else. Close it there, or continue here as a
                  branch.
                </p>
              ) : n.kind === 'recovered' ? (
                <p>NVX Ancile restarted during this turn; what Claude Code wrote has been brought in.</p>
              ) : n.kind === 'unsupported' ? (
                <p>
                  <strong>/{n.name}</strong> works in the Claude Code terminal only. {n.description}
                </p>
              ) : (
                <p>
                  <strong>{n.title}</strong> {n.hint}
                </p>
              )}
            </div>
            <div className="cc-notice__acts">
              {n.kind === 'busy' ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={busy}
                  onClick={() => void branch(n)}
                >
                  Continue as a branch
                </button>
              ) : n.kind === 'signed_out' ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={async () => {
                    if (await startClaudeCodeSignIn())
                      notify({
                        level: 'info',
                        title: 'Claude Code sign-in opened in your browser',
                        body: 'Sign in there, then send again.',
                      });
                    void navigate({ to: '/settings/$group', params: { group: 'claude-code' } });
                  }}
                >
                  {FIX_WORDS.signed_out}
                </button>
              ) : n.kind === 'not_installed' || n.kind === 'unverified' ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void navigate({ to: '/settings/$group', params: { group: 'claude-code' } })}
                >
                  {FIX_WORDS[n.kind]}
                </button>
              ) : null}
              <button type="button" className="icon-btn icon-btn--xs" aria-label="Dismiss" onClick={close}>
                <Icon name="close" size={11} />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ---- What NVX Ancile does for its "/" commands ------------------------------ */

export function useCcActions(opts: {
  threadId: string;
  notebookId: string | null;
  headId: string | null;
}): (c: ClaudeCodeCommand, arg: string | null) => void {
  const navigate = useNavigate();
  const { threadId, notebookId, headId } = opts;
  return useCallback(
    (c: ClaudeCodeCommand, arg: string | null) => {
      const ui = useUi.getState();
      switch (c.ancile_action) {
        case 'open_mcp':
          return void navigate({ to: '/admin/$section', params: { section: 'plugins' } });
        case 'open_permissions':
          return void navigate({ to: '/admin/$section', params: { section: 'grants' } });
        case 'open_usage':
          return patchCc(threadId, { usageOpen: true });
        case 'branch':
          if (!headId) return;
          // A fork in Claude Code: the next message carries on in a new session from here.
          patchCc(threadId, { forkNext: true });
          return void branchHere(threadId, headId, { previousHead: headId }).then((b) => {
            if (b)
              notify({
                level: 'info',
                title: 'Branched here',
                body: 'Your next message forks the Claude Code session, so the original carries on unchanged.',
              });
          });
        case 'rewind':
          return useBranchLayer.getState().setFull(true);
        case 'new_thread':
          return void newThreadHere(notebookId).then((id) => {
            if (id) void navigate({ to: '/t/$threadId', params: { threadId: id } });
          });
        case 'open_threads':
          return ui.openPalette('all');
        case 'sign_in':
        case 'open_settings':
          return void navigate({ to: '/settings/$group', params: { group: 'claude-code' } });
        case 'open_memory':
          return void navigate({ to: '/admin/$section', params: { section: 'memory' } });
        case 'set_model':
          return arg ? patchCc(threadId, { model: arg }) : patchCc(threadId, { picker: 'model' });
        case 'set_effort':
          return isEffort(arg) ? patchCc(threadId, { effort: arg }) : patchCc(threadId, { picker: 'effort' });
        default:
          return patchCc(threadId, {
            notice: { kind: 'unsupported', name: c.name, description: c.description },
          });
      }
    },
    [navigate, threadId, notebookId, headId],
  );
}

/**
 * "/clear", "/new": a new thread in the same notebook. TODO(phase-3): Core
 * has no route yet for a fresh Claude Code session in a folder, so the new
 * thread answers with your models until it has one.
 */
async function newThreadHere(notebookId: string | null): Promise<string | null> {
  const id = await createThread(null, notebookId);
  if (id) {
    notify({
      level: 'info',
      title: 'New thread in this notebook',
      body: 'Starting a fresh Claude Code session from NVX Ancile is not possible yet, so this thread answers with your models.',
    });
    void queryClient.invalidateQueries({ queryKey: keys.threads });
  }
  return id;
}
