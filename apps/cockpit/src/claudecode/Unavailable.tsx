/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: not on this machine
 *  Ref      |  docs/claude-code.md (Live sessions, On a machine
 *           |  without Claude Code)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A Claude Code thread opened where Claude Code is not
 *           |  installed or not signed in (a synced notebook, or after
 *           |  uninstalling) reads as it is and is read-only for Claude
 *           |  Code, with one line and the action that fixes it,
 *           |  instead of errors. Choosing another model in the picker
 *           |  still lets you write.
 *  How      |  ClaudeCodeLiveState.availability from Core; the actions
 *           |  are the same as Settings → Claude Code's.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeLiveState } from '@nvx/contracts';
import { useNavigate } from '@tanstack/react-router';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { installClaudeCode, startClaudeCodeSignIn } from './api';
import { refreshLive } from './live';
import '../styles/cclive.css';

type Missing = Exclude<NonNullable<ClaudeCodeLiveState['availability']>, 'ready'>;

const LINE: Record<Missing, string> = {
  not_installed: 'Install Claude Code to continue',
  signed_out: 'Sign in to Claude Code to continue',
  unverified: 'Check Claude Code to continue',
};

/** The one line, when Claude Code cannot carry this thread on here; null when it can. */
export function unavailableLine(live: ClaudeCodeLiveState | undefined): string | null {
  const a = live?.availability;
  return a && a !== 'ready' ? LINE[a] : null;
}

export function ClaudeCodeUnavailable({
  threadId,
  live,
}: {
  threadId: string;
  live: ClaudeCodeLiveState | undefined;
}) {
  const navigate = useNavigate();
  const a = live?.availability;
  if (!a || a === 'ready') return null;
  const settings = () => void navigate({ to: '/settings/$group', params: { group: 'claude-code' } });
  return (
    <div className="cc-notice" data-kind={a} role="status">
      <Icon name="lock" size={14} className="cc-notice__icon" />
      <div className="cc-notice__text">
        <p>
          <strong>{LINE[a]}</strong> This thread reads as it is. Choose another model to write here now.
        </p>
      </div>
      <div className="cc-notice__acts">
        {a === 'not_installed' ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={async () => {
              await installClaudeCode();
              refreshLive(threadId);
            }}
          >
            Install Claude Code
          </button>
        ) : a === 'signed_out' ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={async () => {
              if (await startClaudeCodeSignIn())
                notify({
                  level: 'info',
                  title: 'Claude Code sign-in opened in your browser',
                  body: 'Sign in there; this thread opens for Claude Code by itself.',
                });
              refreshLive(threadId);
            }}
          >
            Sign in to Claude Code
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--sm" onClick={settings}>
            Open Claude Code settings
          </button>
        )}
      </div>
    </div>
  );
}
