/**
 * ------------------------------------------------------------------
 *  Title    |  Use in NVX Ancile
 *  Ref      |  ROADMAP MC1 · packages/contracts/src/mcp.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Copy a server you set up in Claude Code into NVX
 *           |  Ancile's own MCP list, after showing exactly what will
 *           |  be copied. Secret values move into the encrypted store
 *           |  and are never shown; ${VAR} references Claude Code
 *           |  reads from its environment are asked for here.
 *  How      |  POST .../use/preview (no write), then POST .../use.
 *           |  A claude.ai connector says why it cannot be copied.
 *           |  Remove from Claude Code runs `claude mcp remove`
 *           |  through Core, after a confirmation.
 *  Note     |  Nothing here edits Claude Code's files. The copy is
 *           |  its own server: changing it later does not change
 *           |  Claude Code, and the other way round.
 * ------------------------------------------------------------------
 */

import type { ApiError, ClaudeCodeMcpServer, ClaudeCodeMcpUsePreview, McpServerView } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { ErrorState } from '../ui/ErrorState';
import { reportFailure } from './common';
import { MCP_SERVERS_KEY, putServer, TOOLS_KEY } from './mcp';

const path = (name: string, rest: string) => `/claude-code/mcp-servers/${encodeURIComponent(name)}${rest}`;

/** Why a server cannot be copied, or null when it can be tried. */
export function cannotCopy(s: ClaudeCodeMcpServer): string | null {
  if (s.source === 'claudeai')
    return 'claude.ai connectors are tied to your Claude account, so they cannot be copied. Add the same service with Add server.';
  return null;
}

export function UseInAncileDialog({
  server,
  onOpenChange,
}: {
  server: ClaudeCodeMcpServer;
  onOpenChange: (open: boolean) => void;
}) {
  useLayer(true);
  const [preview, setPreview] = useState<ClaudeCodeMcpUsePreview | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [name, setName] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const look = async (n: string | undefined, v: Record<string, string>) => {
    setFailure(null);
    try {
      setPreview(
        await api.post<ClaudeCodeMcpUsePreview>(path(server.name, '/use/preview'), {
          ...(n && { ancile_name: n }),
          values: v,
        }),
      );
    } catch (err) {
      setPreview(null);
      if (err instanceof ApiCallError) setFailure(err.body);
      else reportFailure(err, 'Reading the server from Claude Code');
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once when the dialog opens
  useEffect(() => {
    void look(undefined, {});
  }, []);

  const copy = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const saved = await api.post<McpServerView>(path(server.name, '/use'), {
        ancile_name: name ?? preview.ancile_name,
        values,
        update: preview.existing === 'different' && preview.changed_since_copy,
      });
      if (saved && typeof saved === 'object' && 'id' in saved) putServer(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      void queryClient.invalidateQueries({ queryKey: TOOLS_KEY });
      notify({
        level: saved.status === 'error' ? 'warn' : 'success',
        title: `${saved.name} is in NVX Ancile`,
        body:
          saved.status === 'error'
            ? (saved.last_error ?? 'It did not connect. Open it in the list and press Test.')
            : 'Its secrets are in the encrypted store. Claude Code was not changed.',
      });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiCallError) setFailure(err.body);
      else reportFailure(err, 'Copying the server');
    } finally {
      setBusy(false);
    }
  };

  const missing = preview?.unresolved.filter((k) => !values[k]) ?? [];
  const verb =
    preview?.existing === 'same'
      ? 'Already copied'
      : preview?.existing === 'different' && preview.changed_since_copy
        ? 'Update the copy'
        : 'Copy to NVX Ancile';
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog mcp-dialog" aria-describedby="use-lede">
          <Dialog.Title className="dialog__title">Use {server.name} in NVX Ancile</Dialog.Title>
          <p id="use-lede" className="dialog__lede">
            This copies the server's settings into NVX Ancile's own list. Secret values move into the
            encrypted store and are not shown. Claude Code keeps its own copy, unchanged.
          </p>
          {failure ? <ErrorState error={failure} compact /> : null}
          {preview ? (
            <form className="mcp-form" onSubmit={(e) => void copy(e)}>
              <dl className="use-summary">
                <dt>Runs as</dt>
                <dd>
                  {preview.transport === 'stdio'
                    ? [preview.command, ...preview.args].filter(Boolean).join(' ')
                    : `${preview.url} (${preview.transport === 'sse' ? 'SSE' : 'remote'})`}
                </dd>
                {Object.keys(preview.plain).length ? (
                  <>
                    <dt>Plain settings</dt>
                    <dd>
                      {Object.entries(preview.plain)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')}
                    </dd>
                  </>
                ) : null}
                {preview.secret_keys.length ? (
                  <>
                    <dt>Moves to the encrypted store</dt>
                    <dd>{preview.secret_keys.join(', ')}</dd>
                  </>
                ) : null}
              </dl>
              {preview.unresolved.map((k) => (
                <label key={k} className="field">
                  <span>{k}</span>
                  <input
                    className="input input--mono"
                    type="password"
                    autoComplete="off"
                    value={values[k] ?? ''}
                    placeholder="Claude Code reads this from its environment"
                    onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                    onBlur={() => void look(name, values)}
                  />
                  <span className="field__hint">
                    Stored encrypted. Needed because NVX Ancile has no value for it.
                  </span>
                </label>
              ))}
              <label className="field">
                <span>Name in NVX Ancile</span>
                <input
                  className="input input--mono"
                  value={name ?? preview.ancile_name}
                  maxLength={40}
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => void look(name, values)}
                />
                {preview.existing === 'same' ? (
                  <span className="field__hint">NVX Ancile already has this server with these settings.</span>
                ) : preview.existing === 'different' ? (
                  <span className="field__error" role="alert">
                    {preview.changed_since_copy
                      ? 'Claude Code changed this server since you copied it. Update the copy to match.'
                      : 'NVX Ancile has a different server with this name. Choose another name.'}
                  </span>
                ) : null}
              </label>
              <div className="dialog__actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn--ghost">
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={
                    busy ||
                    missing.length > 0 ||
                    preview.existing === 'same' ||
                    (preview.existing === 'different' && !preview.changed_since_copy)
                  }
                  data-busy={busy || undefined}
                >
                  {busy ? 'Copying…' : verb}
                </button>
              </div>
            </form>
          ) : failure ? (
            <div className="dialog__actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn--ghost">
                  Close
                </button>
              </Dialog.Close>
            </div>
          ) : (
            <p className="mute">Reading the server from Claude Code…</p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
