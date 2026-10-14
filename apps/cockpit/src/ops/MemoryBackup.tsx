/**
 * ------------------------------------------------------------------
 *  Title    |  Memory backup setup
 *  Ref      |  services/core/src/automations/jobs.ts (testMemoryPush)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The part of Back up memory's dialog that gives it a git
 *           |  remote, and Test push, which asks the remote to take a
 *           |  dry-run push: nothing changes there.
 *  How      |  Not set up: a remote to type, required, saved to
 *           |  Settings → API keys (memory_remote) when the dialog is
 *           |  saved, which also turns the backup on. Set up: Test push
 *           |  tries the remote in use.
 * ------------------------------------------------------------------
 */

import { useId, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../ui/Icon';
import { reportFailure } from './common';

export interface TestResult {
  ok: boolean;
  detail: string;
}

export function MemoryBackupSetup({
  needsRemote,
  remote,
  onRemote,
}: {
  /** No remote yet: one must be typed before the dialog can save. */
  needsRemote: boolean;
  remote: string;
  onRemote: (v: string) => void;
}) {
  const id = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(
        await api.post<TestResult>('/automations/memory_backup/test', {
          ...(remote.trim() && { remote: remote.trim() }),
        }),
      );
    } catch (err) {
      reportFailure(err, 'Testing the push');
    } finally {
      setTesting(false);
    }
  };
  return (
    <fieldset className="field auto-opts">
      <legend>Remote</legend>
      {needsRemote ? (
        <div className="auto-opt">
          <label htmlFor={`${id}-remote`}>Git remote</label>
          <input
            id={`${id}-remote`}
            className="input input--mono"
            value={remote}
            onChange={(e) => {
              onRemote(e.target.value);
              setResult(null);
            }}
            placeholder="git@github.com:you/memory.git"
            spellCheck={false}
            autoComplete="off"
            aria-describedby={`${id}-hint`}
          />
          <span id={`${id}-hint`} className="field__hint">
            A private repository. It is kept with your keys in Settings → API keys.
          </span>
        </div>
      ) : (
        <p className="field__hint">It pushes to the remote set in Settings → API keys or the environment.</p>
      )}
      <div className="auto-test">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={testing || (needsRemote && !remote.trim())}
          onClick={() => void test()}
        >
          <Icon name="upload" size={13} />
          {testing ? 'Testing…' : 'Test push'}
        </button>
        {result ? (
          <span className="auto-test__result" data-ok={result.ok} role="status">
            <Icon name={result.ok ? 'check' : 'warn'} size={13} />
            {result.detail}
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}
