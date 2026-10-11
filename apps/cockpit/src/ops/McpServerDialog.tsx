/**
 * ------------------------------------------------------------------
 *  Title    |  Add or edit an MCP server
 *  Ref      |  packages/contracts/src/mcp.ts (Create/UpdateMcpServerRequest)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One form for a new server and for changing one: a local
 *           |  command NVX Ancile starts (stdio) or a remote address
 *           |  (http), plain settings, and secrets that are stored
 *           |  encrypted and never shown again. A quick start adds the
 *           |  official GitHub server in one step.
 *  How      |  The draft and the request it becomes live in ./mcp.ts,
 *           |  checked with the contract schema before sending. What
 *           |  Core says back (name taken, a secret missing) shows in
 *           |  the form, next to the field it is about.
 *  Note     |  The transport cannot change on edit: remove the server
 *           |  and add it again.
 * ------------------------------------------------------------------
 */

import type { ApiError, McpServerView } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Check, Segmented } from '../ui/controls';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { reportFailure } from './common';
import {
  createBody,
  type DraftProblems,
  draftFromServer,
  emptyDraft,
  fieldForCode,
  MCP_SERVERS_KEY,
  type McpDraft,
  type PairRow,
  pairRow,
  putServer,
  type SecretRow,
  secretRow,
  serverPath,
  TOOLS_KEY,
  updateBody,
} from './mcp';

export function McpServerDialog({
  open,
  server,
  offerGitHub,
  onOpenChange,
}: {
  open: boolean;
  /** The one being changed; null adds a new one. */
  server: McpServerView | null;
  /** Show the GitHub quick start (not when GitHub is already added). */
  offerGitHub: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useLayer(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick mcp-dialog" aria-describedby="mcp-dialog-desc">
          {open ? (
            <ServerForm
              key={server?.id ?? 'new'}
              server={server}
              offerGitHub={offerGitHub && server === null}
              onDone={() => onOpenChange(false)}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ServerForm({
  server,
  offerGitHub,
  onDone,
}: {
  server: McpServerView | null;
  offerGitHub: boolean;
  onDone: () => void;
}) {
  const isNew = server === null;
  const [mode, setMode] = useState<'form' | 'github'>('form');
  const [d, setD] = useState<McpDraft>(() => (server ? draftFromServer(server) : emptyDraft()));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [serverProblems, setServerProblems] = useState<DraftProblems>({});
  const set = (patch: Partial<McpDraft>) => {
    setD((prev) => ({ ...prev, ...patch }));
    setServerProblems({});
  };

  const built = isNew ? createBody(d) : updateBody(d);
  const problems: DraftProblems = { ...(tried && !built.ok ? built.problems : {}), ...serverProblems };
  const stdio = d.transport === 'stdio';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!built.ok || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const saved = isNew
        ? await api.post<McpServerView>('/mcp/servers', built.body)
        : await api.patch<McpServerView>(serverPath(server.id), built.body);
      if (saved && typeof saved === 'object' && 'id' in saved) putServer(queryClient, saved);
      notify(
        isNew
          ? {
              level: 'success',
              title: `${d.name.trim()} is added`,
              body: 'It connects now; its tools show here when it does.',
            }
          : { level: 'success', title: 'Changes saved' },
      );
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      void queryClient.invalidateQueries({ queryKey: TOOLS_KEY });
      onDone();
    } catch (err) {
      if (err instanceof ApiCallError) {
        const field = fieldForCode(err.body.error.code);
        if (field) setServerProblems({ [field]: `${err.body.error.title}. ${err.body.error.hint}` });
        else setFailure(err.body);
      } else reportFailure(err, isNew ? 'Adding the server' : 'Saving the server');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'github') return <GitHubQuickStart onBack={() => setMode('form')} onDone={onDone} />;

  return (
    <>
      <Dialog.Title className="dialog__title">{isNew ? 'Add server' : `Edit ${server.name}`}</Dialog.Title>
      <p id="mcp-dialog-desc" className="dialog__lede">
        {isNew
          ? 'A server gives the assistant more tools. NVX Ancile can start one on this computer, or connect to one at an address.'
          : 'Changes take effect at once: the server reconnects with the new settings.'}
      </p>

      {offerGitHub ? (
        <div className="mcp-quick">
          <span className="mute">Quick start</span>
          <button type="button" className="chip mcp-quick__btn" onClick={() => setMode('github')}>
            <Icon name="branch" size={13} />
            GitHub
          </button>
        </div>
      ) : null}

      <form className="mcp-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Name"
          error={problems.name}
          hint="Lower-case letters, digits, - or _. Its tools show as name__tool."
        >
          {(a) => (
            <input
              {...a}
              className="input"
              value={d.name}
              maxLength={40}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="notes"
              spellCheck={false}
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: the dialog opens to its first field
              autoFocus
            />
          )}
        </Field>

        {isNew ? (
          <Segmented
            label="How it connects"
            value={d.transport}
            onChange={(transport) => set({ transport })}
            options={[
              { value: 'stdio', label: 'Local command', icon: 'command' },
              { value: 'http', label: 'Remote', icon: 'globe' },
            ]}
          />
        ) : (
          <p className="field__hint">
            {stdio ? 'Runs as a local command.' : 'Connects to a remote address.'} To change that, remove the
            server and add it again.
          </p>
        )}

        {stdio ? (
          <>
            <Field label="Command" error={problems.command} hint="The program that starts the server.">
              {(a) => (
                <input
                  {...a}
                  className="input input--mono"
                  value={d.command}
                  onChange={(e) => set({ command: e.target.value })}
                  placeholder="npx"
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Arguments" error={problems.args} hint="One per line.">
              {(a) => (
                <textarea
                  {...a}
                  className="input input--mono"
                  rows={3}
                  value={d.args}
                  onChange={(e) => set({ args: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/me/notes'}
                  spellCheck={false}
                />
              )}
            </Field>
            <PairsEditor
              legend="Environment variables"
              hint="Plain settings such as LOG_LEVEL. Put keys and tokens in secrets below."
              what="variable"
              keyPlaceholder="LOG_LEVEL"
              valuePlaceholder="info"
              rows={d.env}
              error={problems.env}
              onChange={(env) => set({ env })}
            />
          </>
        ) : (
          <>
            <Field label="Address" error={problems.url}>
              {(a) => (
                <input
                  {...a}
                  className="input input--mono"
                  type="url"
                  value={d.url}
                  onChange={(e) => set({ url: e.target.value })}
                  placeholder="https://example.com/mcp"
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </Field>
            <PairsEditor
              legend="Headers"
              hint="Plain request headers. Put Authorization and other tokens in secrets below."
              what="header"
              keyPlaceholder="X-Workspace"
              valuePlaceholder="research"
              rows={d.headers}
              error={problems.headers}
              onChange={(headers) => set({ headers })}
            />
          </>
        )}

        <SecretsEditor
          legend={stdio ? 'Secret environment variables' : 'Secret headers'}
          keyPlaceholder={stdio ? 'API_KEY' : 'Authorization'}
          valuePlaceholder={stdio ? 'The key' : 'Bearer …'}
          rows={d.secrets}
          error={problems.secrets}
          onChange={(secrets) => set({ secrets })}
        />

        {failure ? <ErrorState error={failure} compact /> : null}

        <div className="dialog__actions">
          <Dialog.Close asChild>
            <button type="button" className="btn btn--ghost">
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" className="btn btn--primary" disabled={busy} data-busy={busy || undefined}>
            {isNew ? (busy ? 'Adding…' : 'Add server') : busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </>
  );
}

function FieldNote({
  id,
  error,
  hint,
}: {
  id?: string;
  error?: string | undefined;
  hint?: string | undefined;
}) {
  if (error)
    return (
      <span id={id} className="field__error" role="alert">
        {error}
      </span>
    );
  return hint ? (
    <span id={id} className="field__hint">
      {hint}
    </span>
  ) : null;
}

/** A labelled control with its hint, or what is wrong with it, read out with it. */
function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: (a: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode;
}) {
  const id = useId();
  const control = useId();
  return (
    <div className="mcp-field">
      <label className="field" htmlFor={control}>
        <span>{label}</span>
        {children({
          id: control,
          ...((error || hint) && { 'aria-describedby': id }),
          ...(error && { 'aria-invalid': true as const }),
        })}
      </label>
      <FieldNote id={id} error={error} hint={hint} />
    </div>
  );
}

/* ---- Plain settings: name and value, one row each ------------------------------ */

function PairsEditor({
  legend,
  hint,
  what,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  error,
  onChange,
}: {
  legend: string;
  hint: string;
  what: 'variable' | 'header';
  keyPlaceholder: string;
  valuePlaceholder: string;
  rows: PairRow[];
  error?: string | undefined;
  onChange: (rows: PairRow[]) => void;
}) {
  const edit = (uid: string, patch: Partial<PairRow>) =>
    onChange(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  return (
    <fieldset className="field mcp-pairs">
      <legend>{legend}</legend>
      {rows.map((r, i) => (
        <div key={r.uid} className="mcp-pair">
          <input
            className="input input--sm input--mono"
            value={r.key}
            aria-label={`Name of ${what} ${i + 1}`}
            placeholder={keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => edit(r.uid, { key: e.target.value })}
          />
          <input
            className="input input--sm input--mono"
            value={r.value}
            aria-label={`Value of ${r.key || `${what} ${i + 1}`}`}
            placeholder={valuePlaceholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => edit(r.uid, { value: e.target.value })}
          />
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Remove ${r.key || `${what} ${i + 1}`}`}
            onClick={() => onChange(rows.filter((x) => x.uid !== r.uid))}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--quiet btn--sm mcp-pairs__add"
        onClick={() => onChange([...rows, pairRow()])}
      >
        <Icon name="plus" size={13} />
        Add {what}
      </button>
      <FieldNote error={error} hint={hint} />
    </fieldset>
  );
}

/* ---- Secrets: masked, and never shown again once saved -------------------------- */

function SecretsEditor({
  legend,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  error,
  onChange,
}: {
  legend: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  rows: SecretRow[];
  error?: string | undefined;
  onChange: (rows: SecretRow[]) => void;
}) {
  const edit = (uid: string, patch: Partial<SecretRow>) =>
    onChange(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  return (
    <fieldset className="field mcp-pairs mcp-secrets">
      <legend>
        <Icon name="lock" size={12} /> {legend}
      </legend>
      {rows.map((r, i) => (
        <div key={r.uid} className="mcp-pair" data-saved={r.saved || undefined}>
          {r.saved ? (
            <code className="mcp-pair__key">{r.key}</code>
          ) : (
            <input
              className="input input--sm input--mono"
              value={r.key}
              aria-label={`Name of secret ${i + 1}`}
              placeholder={keyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => edit(r.uid, { key: e.target.value })}
            />
          )}
          {r.saved && !r.replacing ? (
            <span className="mcp-pair__saved">
              <span className="mcp-saved">
                <Icon name="check" size={12} />
                Saved
              </span>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                aria-label={`Replace ${r.key}`}
                onClick={() => edit(r.uid, { replacing: true })}
              >
                Replace
              </button>
            </span>
          ) : (
            <span className="mcp-pair__saved">
              <input
                className="input input--sm input--mono"
                type="password"
                value={r.value}
                aria-label={`Value of ${r.key || `secret ${i + 1}`}`}
                placeholder={r.saved ? 'New value' : valuePlaceholder}
                autoComplete="new-password"
                // biome-ignore lint/a11y/noAutofocus: Replace opens straight into the new value
                autoFocus={r.replacing}
                onChange={(e) => edit(r.uid, { value: e.target.value })}
              />
              {r.replacing ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => edit(r.uid, { replacing: false, value: '' })}
                >
                  Keep saved
                </button>
              ) : null}
            </span>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Remove ${r.key || `secret ${i + 1}`}`}
            onClick={() => onChange(rows.filter((x) => x.uid !== r.uid))}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--quiet btn--sm mcp-pairs__add"
        onClick={() => onChange([...rows, secretRow()])}
      >
        <Icon name="plus" size={13} />
        Add secret
      </button>
      <FieldNote
        error={error}
        hint="Stored encrypted. After saving, a secret shows only as Saved; removing a row deletes it."
      />
    </fieldset>
  );
}

/* ---- Quick start: GitHub ---------------------------------------------------------- */

interface PresetAnswer {
  runner?: string;
  health?: { connected: boolean; tools: number; lastError: string | null };
  status?: McpServerView['status'];
  tools?: unknown[];
  last_error?: string | null;
}

/**
 * The official GitHub MCP server in one step: issues, pull requests, code
 * search and more as tools, under your grants like any other. It runs
 * with your gh sign-in or a token you paste (kept encrypted), in Docker
 * or as the github-mcp-server binary, whichever is installed.
 */
function GitHubQuickStart({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [token, setToken] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const r = await api.post<PresetAnswer>('/mcp/presets/github', {
        ...(token.trim() && { token: token.trim() }),
        read_only: readOnly,
      });
      // Older Core answers with `health`; newer with the server itself.
      const connected = r.health ? r.health.connected : r.status === 'connected';
      const tools = r.health ? r.health.tools : (r.tools?.length ?? 0);
      const problem = r.health ? r.health.lastError : (r.last_error ?? null);
      notify(
        connected
          ? {
              level: 'success',
              title: `GitHub added with ${tools} tools`,
              ...(r.runner && { body: `Running through ${r.runner}.` }),
            }
          : {
              level: 'warn',
              title: 'GitHub was added but is not connected yet',
              ...(problem && { body: problem }),
            },
      );
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      void queryClient.invalidateQueries({ queryKey: TOOLS_KEY });
      onDone();
    } catch (err) {
      if (err instanceof ApiCallError) setFailure(err.body);
      else reportFailure(err, 'Adding GitHub');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog.Title className="dialog__title">Add GitHub</Dialog.Title>
      <p id="mcp-dialog-desc" className="dialog__lede">
        The official GitHub MCP server: issues, pull requests and code search as tools. Leave the token empty
        to use your GitHub CLI sign-in (<code>gh auth login</code>).
      </p>
      <form className="mcp-form" onSubmit={(e) => void submit(e)}>
        <Field label="GitHub token (optional)" hint="Stored encrypted.">
          {(a) => (
            <input
              {...a}
              className="input input--mono"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_…"
              // biome-ignore lint/a11y/noAutofocus: the step opens to its only field
              autoFocus
            />
          )}
        </Field>
        <div className="mcp-check">
          <Check checked={readOnly} onChange={setReadOnly} label="Read-only tools" />
          <span>Read-only tools (it can look, not change)</span>
        </div>
        {failure ? <ErrorState error={failure} compact /> : null}
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost mcp-form__back" onClick={onBack}>
            Back
          </button>
          <Dialog.Close asChild>
            <button type="button" className="btn btn--ghost">
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" className="btn btn--primary" disabled={busy} data-busy={busy || undefined}>
            {busy ? 'Adding…' : 'Add GitHub'}
          </button>
        </div>
      </form>
    </>
  );
}
