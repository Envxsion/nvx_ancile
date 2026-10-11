/**
 * ------------------------------------------------------------------
 *  Title    |  Edit and revoke a grant
 *  Ref      |  DESIGN.md §5.4 · Admin → Permissions
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The "⋯" menu on a remembered permission: narrow its
 *           |  pattern, change where it applies or when it expires,
 *           |  or revoke it.
 *  How      |  PATCH /grants/:id with only what changed; Core refuses
 *           |  a pattern wider than the one granted, and a wider scope
 *           |  under Careful. Revoking asks first, then offers Undo
 *           |  (POST /grants/:id/restore) for ten minutes.
 * ------------------------------------------------------------------
 */

import type { Grant, GrantScope } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { type ConfirmCopy, ConfirmDialog } from '../ui/Confirm';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';

export const GRANT_SCOPE_WORDS: Record<GrantScope, string> = {
  thread: 'In one thread',
  notebook: 'In one notebook',
  workspace: 'In your workspace',
  always: 'Everywhere',
};

const EXPIRY = [
  { id: 'keep', label: 'Keep as it is' },
  { id: '0', label: 'Never' },
  { id: '3600', label: 'In 1 hour' },
  { id: '86400', label: 'In 1 day' },
  { id: '604800', label: 'In 1 week' },
  { id: '2592000', label: 'In 30 days' },
];

function failed(e: unknown, what: string) {
  notify({
    level: 'error',
    title: e instanceof ApiCallError ? e.body.error.title : `${what} failed`,
    body: e instanceof ApiCallError ? e.body.error.hint : 'Check that NVX Ancile is running, then try again.',
  });
}

const refresh = () => queryClient.invalidateQueries({ queryKey: ['grants'] });

/** The body of a PATCH: only what changed. Exported for tests. */
export function grantPatch(
  g: Pick<Grant, 'resource_pattern' | 'scope'>,
  f: { pattern: string; scope: GrantScope; expiry: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pattern = f.pattern.trim();
  if (pattern && pattern !== g.resource_pattern) out.resource_pattern = pattern;
  if (f.scope !== g.scope) out.scope = f.scope;
  if (f.expiry !== 'keep') out.ttl_seconds = f.expiry === '0' ? null : Number(f.expiry);
  return out;
}

/** Undo a revocation. A plain call: the row it came from is gone by now. */
export async function restoreGrant(g: Pick<Grant, 'id'>): Promise<void> {
  try {
    await api.post(`/grants/${g.id}/restore`);
    void refresh();
    notify({
      level: 'success',
      title: 'Grant restored',
      body: 'The agent can do this without asking again.',
    });
  } catch (e) {
    failed(e, 'Undoing the revocation');
  }
}

/** Mounted only while editing, so a background refresh never resets what you typed. */
function EditGrantDialog({ grant, onClose }: { grant: Grant; onClose: () => void }) {
  useLayer(true);
  const [pattern, setPattern] = useState(grant.resource_pattern);
  const [scope, setScope] = useState<GrantScope>(grant.scope);
  const [expiry, setExpiry] = useState('keep');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Grant>(`/grants/${grant.id}`, body),
    onSuccess: () => {
      void refresh();
      notify({ level: 'success', title: 'Grant saved', body: 'It applies from the next check.' });
      onClose();
    },
    onError: (e) => failed(e, 'Saving the grant'),
  });
  const submit = () => {
    const body = grantPatch(grant, { pattern, scope, expiry });
    if (!Object.keys(body).length) return onClose();
    save.mutate(body);
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick edit-grant" aria-describedby="edit-grant-desc">
          <Dialog.Title className="dialog__title">
            Edit {grant.effect === 'deny' ? 'never ' : ''}
            {grant.action_pattern}
          </Dialog.Title>
          <p id="edit-grant-desc" className="dialog__lede">
            A pattern can only be narrowed here. To allow more, revoke this and answer the next request.
          </p>
          <form
            className="edit-grant__form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="field">
              <span>Pattern</span>
              <input
                className="input input--mono"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                spellCheck={false}
                required
                // biome-ignore lint/a11y/noAutofocus: the dialog opens to its first field
                autoFocus
              />
              <span className="field__hint">
                Must sit inside <code>{grant.resource_pattern}</code>. <code>*</code> is one folder level,{' '}
                <code>**</code> is any depth.
              </span>
            </label>
            <label className="field">
              <span>Where</span>
              <select
                className="input"
                value={scope}
                onChange={(e) => setScope(e.target.value as GrantScope)}
              >
                {(Object.keys(GRANT_SCOPE_WORDS) as GrantScope[]).map((s) => (
                  <option key={s} value={s}>
                    {GRANT_SCOPE_WORDS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Expires</span>
              <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="dialog__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={save.isPending}>
                {save.isPending ? 'Saving' : 'Save changes'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The "⋯" on a grant row. */
export function GrantMenu({ grant }: { grant: Grant }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmCopy | null>(null);
  const revoke = useMutation({
    mutationFn: () => api.del(`/grants/${grant.id}`),
    onSuccess: () => {
      void refresh();
      notify({
        level: 'success',
        title: 'Revoked',
        body: 'The agent will ask again next time.',
        undo: () => void restoreGrant(grant),
      });
    },
    onError: (e) => failed(e, 'Revoking'),
  });
  const what = `${grant.action_pattern} on ${grant.resource_pattern}`;
  return (
    <>
      <DropMenu
        items={[
          { label: 'Edit', icon: 'edit', onSelect: () => setEditing(true) },
          { kind: 'separator' },
          {
            label: 'Revoke',
            icon: 'trash',
            danger: true,
            disabled: revoke.isPending,
            onSelect: () =>
              setConfirm({
                title: `Revoke ${grant.effect === 'deny' ? 'never ' : ''}${grant.action_pattern}?`,
                body: (
                  <>
                    The agent will ask again before <code>{what}</code>. You can undo this for ten minutes.
                  </>
                ),
                action: 'Revoke grant',
              }),
          },
        ]}
        trigger={
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for ${what}`}>
            <Icon name="more" size={15} />
          </button>
        }
      />
      {editing ? <EditGrantDialog grant={grant} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog copy={confirm} onConfirm={() => revoke.mutate()} onClose={() => setConfirm(null)} />
    </>
  );
}
