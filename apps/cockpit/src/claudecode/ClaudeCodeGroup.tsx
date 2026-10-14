/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Claude Code
 *  Ref      |  docs/claude-code.md · help article "claude-code"
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Works with Claude Code: whether it is installed and
 *           |  signed in, the one action that moves it along, three
 *           |  switches, and the way into its sessions.
 *  How      |  The card reads GET /claude-code/status. The primary
 *           |  action follows the state: install (with live progress
 *           |  from claude_code.changed), update, sign in (Claude
 *           |  Code's own browser window), then simply "Signed in".
 *  Note     |  NVX Ancile never sees the Claude sign-in. The copy says
 *           |  "Claude Code" or "your Claude Code account", never more.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeStatus } from '@nvx/contracts';
import { useContext, useEffect, useState } from 'react';
import { LoadFailed } from '../ops/common';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { useUi } from '../state/ui';
import { Segmented, Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import {
  installClaudeCode,
  signedInWords,
  signOutOfClaudeCode,
  startClaudeCodeSignIn,
  useClaudeCodeStatus,
  useImportProgress,
  useInstallProgress,
  usePatchClaudeCodeSettings,
} from './api';
import { openClaudeCodeSessions } from './SessionsDialog';
import '../styles/claudecode.css';

const KEYWORDS = 'claude code anthropic cli agent sessions import sign in install terminal';
export const NEVER_SEES = 'NVX Ancile never sees your Claude sign-in. Claude Code keeps it.';
export const SIGN_IN_NOTE =
  'A browser window opens from Claude Code itself. Sign in there, and this page updates when you are done.';

const SWITCHES: { key: 'auto_install' | 'auto_import' | 'claude_telemetry'; label: string; desc: string }[] =
  [
    {
      key: 'auto_install',
      label: "Install Claude Code when it's missing",
      desc: "Uses Anthropic's official installer. Nothing else is installed.",
    },
    {
      key: 'auto_import',
      label: 'Bring Claude Code sessions in by themselves',
      desc: 'Every session becomes a thread and stays in step. Off: only the sessions you import.',
    },
    {
      key: 'claude_telemetry',
      label: 'Let Claude Code send usage data to Anthropic',
      desc: "Claude Code's own reporting, not NVX Ancile's. Off sets DISABLE_TELEMETRY for it.",
    },
  ];

/** Fact-check judges Claude Code may answer at once (Settings → Claude Code). */
const JUDGES = ['1', '2', '3', '4'].map((n) => ({ value: n, label: n }));

export type ClaudeCodeStage = 'installing' | 'install' | 'update' | 'sign-in' | 'signed-in';

/** Which single step comes next. */
/** An excluded folder as you read it: "<temp>" (the system's temporary folder) is "Temporary files". */
export function excludedLabel(f: string): string {
  return f.replace(/^<temp>(?=$|[\\/])/, 'Temporary files');
}

export function stageOf(s: ClaudeCodeStatus): ClaudeCodeStage {
  if (!s.installed) return s.install.state === 'installing' ? 'installing' : 'install';
  if (!s.version_ok) return 'update';
  return s.signed_in ? 'signed-in' : 'sign-in';
}

/** While the browser sign-in is open: poll a little, in case an event is missed. Gives up after 3 min. */
function useSignInWait() {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setWaiting(false), 180_000);
    return () => clearTimeout(t);
  }, [waiting]);
  return [waiting, setWaiting] as const;
}

function StatusCard({
  s,
  waiting,
  onSignIn,
  onCheck,
}: {
  s: ClaudeCodeStatus;
  waiting: boolean;
  onSignIn: () => void;
  onCheck: () => void;
}) {
  const stage = stageOf(s);
  const progress = useInstallProgress((p) => p.detail);
  return (
    <section className="cc-card m-raised" aria-labelledby="cc-card-title" data-stage={stage}>
      <header className="cc-card__head">
        <span className="cc-card__glyph" aria-hidden="true">
          <Icon name="command" size={16} />
        </span>
        <div className="cc-card__words">
          <h3 id="cc-card-title" className="cc-card__title">
            {s.installed ? `Claude Code ${s.version ?? ''}`.trim() : 'Not installed'}
          </h3>
          <p className="cc-card__line">
            {s.installed
              ? s.signed_in
                ? signedInWords(s)
                : 'Not signed in.'
              : 'Claude Code is not on this computer.'}
          </p>
          {s.path ? (
            <p className="cc-card__path mute" data-num title="The Claude Code NVX Ancile runs">
              {s.path}
            </p>
          ) : null}
        </div>
      </header>

      <div className="cc-card__action">
        {stage === 'install' ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void installClaudeCode()}
            >
              <Icon name="download" size={13} />
              Install Claude Code
            </button>
            {s.install.state === 'failed' ? (
              <p className="cc-card__fail" role="alert">
                Installing did not finish{s.install.error ? `: ${s.install.error}` : '.'} Try again, or
                install it yourself from Anthropic's site and press Check again.
              </p>
            ) : (
              <p className="mute">Uses Anthropic's official installer. It takes a minute or two.</p>
            )}
          </>
        ) : null}

        {stage === 'installing' ? (
          <>
            <button type="button" className="btn btn--primary btn--sm" disabled data-busy>
              <span className="cc-spin" aria-hidden="true" />
              Installing Claude Code
            </button>
            <p className="cc-card__progress mute" aria-live="polite">
              {progress ?? 'Starting the installer.'}
            </p>
          </>
        ) : null}

        {stage === 'update' ? (
          <div className="cc-card__update">
            <p>
              NVX Ancile needs Claude Code {s.min_version} or later. This computer has{' '}
              {s.version ?? 'an older one'}. Run <code>claude update</code> in a terminal, then check again.
            </p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onCheck}>
              <Icon name="regenerate" size={13} />
              Check again
            </button>
          </div>
        ) : null}

        {stage === 'sign-in' ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={onSignIn}
              disabled={waiting}
              data-busy={waiting || undefined}
            >
              {waiting ? <span className="cc-spin" aria-hidden="true" /> : <Icon name="ext" size={13} />}
              {waiting ? 'Waiting for Claude Code' : 'Sign in to Claude Code'}
            </button>
            <p className="mute" aria-live="polite">
              {waiting ? 'Finish signing in in the browser window Claude Code opened.' : SIGN_IN_NOTE}
            </p>
          </>
        ) : null}

        {stage === 'signed-in' ? (
          <div className="cc-card__done">
            <span className="cc-card__ok">
              <Icon name="check" size={13} />
              Signed in
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => void signOutOfClaudeCode()}
            >
              Sign out of Claude Code
            </button>
          </div>
        ) : null}
      </div>

      {s.installed && s.verification?.state === 'failed' ? (
        <p className="cc-card__sdk" role="alert">
          <Icon name="warn" size={13} />
          <span>
            This Claude Code install could not be verified, so NVX Ancile will not run it.{' '}
            {s.verification.error ?? 'Reinstall Claude Code with the official installer, then check again.'}
          </span>
        </p>
      ) : null}

      {s.installed && s.version_ok && !s.sdk.ready ? (
        <p className="cc-card__sdk" role="status">
          <Icon name="warn" size={13} />
          <span>
            Sessions cannot run from NVX Ancile yet.{' '}
            {s.sdk.error ?? 'Restart NVX Ancile, and if it stays, check Admin → Health.'}
          </span>
        </p>
      ) : null}

      <p className="cc-card__privacy mute">
        <Icon name="lock" size={12} />
        {NEVER_SEES}
      </p>
    </section>
  );
}

export function ClaudeCodeGroup() {
  const q = useContext(SearchContext);
  const [waiting, setWaiting] = useSignInWait();
  const status = useClaudeCodeStatus({ poll: waiting });
  const patch = usePatchClaudeCodeSettings();
  const s = status.data;
  const importing = useImportProgress((p) => p.line);
  const autoImport = s?.settings.auto_import ?? true;

  useEffect(() => {
    if (s?.signed_in) setWaiting(false);
  }, [s?.signed_in, setWaiting]);

  if (!matches(q, 'Claude Code', KEYWORDS, ...SWITCHES.flatMap((x) => [x.label, x.desc]))) return null;

  const signIn = async () => {
    if (await startClaudeCodeSignIn()) setWaiting(true);
  };

  return (
    <>
      <Block
        title="Claude Code"
        lede="Use the Claude Code installed on this computer, signed in to your Claude Code account."
      >
        <div className="setting" data-stack>
          {status.isPending ? (
            <Skeleton lines={3} label="Checking Claude Code" />
          ) : !s ? (
            <LoadFailed
              error={status.error}
              what="Claude Code's status"
              onRetry={() => void status.refetch()}
            />
          ) : (
            <StatusCard
              s={s}
              waiting={waiting}
              onSignIn={() => void signIn()}
              onCheck={() => void status.refetch()}
            />
          )}
        </div>
      </Block>

      {s ? (
        <Block title="How it behaves">
          {SWITCHES.map((x) => (
            <div className="setting" key={x.key}>
              <div className="setting__words">
                <div className="setting__label">
                  <span>{x.label}</span>
                </div>
                <p className="setting__desc">{x.desc}</p>
              </div>
              <div className="setting__control">
                <Switch
                  label={x.label}
                  checked={s.settings[x.key]}
                  onChange={(v) => patch.mutate({ [x.key]: v })}
                />
              </div>
            </div>
          ))}
          <div className="setting">
            <div className="setting__words">
              <div className="setting__label">
                <span>Fact-check judges at once</span>
              </div>
              <p className="setting__desc">
                When Claude Code checks an answer's claims, each judge is a Claude Code session on your Claude
                plan. More at once finishes sooner and uses your plan's limits faster.
              </p>
            </div>
            <div className="setting__control">
              <Segmented
                label="Fact-check judges at once"
                value={String(s.settings.factcheck_judges ?? 1)}
                options={JUDGES}
                onChange={(v) => patch.mutate({ factcheck_judges: Number(v) })}
                size="sm"
              />
            </div>
          </div>
        </Block>
      ) : null}

      {s ? (
        <Block title="Excluded folders">
          <div className="setting cc-excluded">
            <div className="setting__words">
              <p className="setting__desc">
                Sessions from these folders never come in. "~" is your home folder.
              </p>
              {s.settings.exclude_folders.length ? (
                <ul className="cc-excluded__list" aria-label="Excluded folders">
                  {s.settings.exclude_folders.map((f) => (
                    <li key={f}>
                      <Icon name="folder" size={13} />
                      <span className="cc-excluded__path" data-num title={excludedLabel(f)}>
                        {excludedLabel(f)}
                      </span>
                      <button
                        type="button"
                        className="icon-btn icon-btn--xs"
                        aria-label={`Bring in ${excludedLabel(f)} again`}
                        title="Bring its sessions in again"
                        onClick={() =>
                          patch.mutate({ exclude_folders: s.settings.exclude_folders.filter((x) => x !== f) })
                        }
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="setting__desc mute">None. Every folder's sessions come in.</p>
              )}
            </div>
          </div>
        </Block>
      ) : null}

      <Block title="Sessions">
        <div className="setting cc-sessions-row">
          <div className="setting__words">
            <p className="setting__desc">
              {autoImport
                ? 'Every Claude Code session on this computer comes in as a thread, in a notebook named after its folder, and stays in step.'
                : 'Sessions come in only when you import them. Each one keeps in step once it is in.'}{' '}
              Usage counts against the account Claude Code is signed in to.
            </p>
            {importing ? (
              <p className="cc-progress" role="status">
                <span className="cc-spin" aria-hidden="true" />
                {importing}
              </p>
            ) : null}
          </div>
          <div className="setting__control">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => openClaudeCodeSessions()}>
              <Icon name="folder" size={13} />
              See sessions
            </button>
            <button
              type="button"
              className="link-btn link-btn--quiet"
              onClick={() => useUi.getState().setHelp(true, 'claude-code')}
            >
              How this works
            </button>
          </div>
        </div>
      </Block>
    </>
  );
}
