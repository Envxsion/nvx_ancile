/**
 * ------------------------------------------------------------------
 *  Title    |  Approval dialog
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The agent is paused and waiting on you. Say exactly
 *           |  what it wants to do, and let one answer cover the
 *           |  similar requests that will follow (DESIGN.md §5).
 *  How      |  Gated: pick how wide the permission is (the narrowest
 *           |  pattern is pre-selected and editable) and how long it
 *           |  lasts. Critical: no remember option at all; the button
 *           |  says "Approve once" because that is all it can do.
 *  Note     |  The answer goes to POST /approvals/:id; the run picks
 *           |  up in the thread at once. Core enforces the same rules
 *           |  (a critical approval cannot be remembered, a pattern
 *           |  must cover what was asked), so the dialog only guides.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys, useNotebooks, useThreads } from '../lib/data';
import { queryClient } from '../lib/query';
import type { PendingApproval } from '../lib/types';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { TierBadge } from '../ui/primitives';

const SCOPES = [
  { id: 'once', label: 'Just this once', hint: 'Ask again next time' },
  { id: 'thread', label: 'In this thread', hint: 'Until the thread ends' },
  { id: 'notebook', label: 'In this notebook', hint: 'For every thread in this notebook' },
  { id: 'always', label: 'Always', hint: 'Everywhere, until you revoke it' },
] as const;

const EXPIRY = [
  { id: '0', label: 'No expiry' },
  { id: '3600', label: '1 hour' },
  { id: '86400', label: '1 day' },
  { id: '604800', label: '1 week' },
];

function describePattern(p: string, i: number, total: number): string {
  if (i === 0) return 'This file only';
  if (i === total - 1) return 'Anything in the workspace';
  return p.endsWith('/**') ? `Anything under ${p.replace(/^fs:/, '').replace(/\/\*\*$/, '/')}` : p;
}

export function ApprovalDialog({ approval }: { approval: PendingApproval }) {
  const open = useUi((s) => s.approvalOpen);
  const setOpen = useUi((s) => s.setApproval);
  const setMark = useUi((s) => s.setMark);
  const demo = useUi((s) => s.demo);
  const critical = approval.tier === 'critical';
  const threads = useThreads();
  const notebooks = useNotebooks();
  const thread = threads.data?.find((t) => t.id === approval.threadId);
  const notebookId = thread?.notebookId ?? null;
  const notebookTitle = notebooks.data?.find((n) => n.id === notebookId)?.title;
  const scopes = SCOPES.filter((s) =>
    s.id === 'notebook' ? !!notebookId : s.id === 'thread' ? !!approval.threadId : true,
  );
  const [busy, setBusy] = useState(false);
  const [pattern, setPattern] = useState(approval.suggestions[0] ?? approval.resource);
  const [custom, setCustom] = useState(false);
  const [scope, setScope] = useState<(typeof SCOPES)[number]['id']>('once');
  const [ttl, setTtl] = useState('0');
  useLayer(open);
  // Focus goes back where it was when the dialog opened, not to the page body.
  const returnTo = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);

  // State starts fresh per approval: AppShell keys this dialog by approval id.
  // (Resetting in an effect on open raced a quick first click.)

  const decide = async (decision: 'approve' | 'deny') => {
    const remembered = !critical && scope !== 'once';
    if (!demo) {
      setBusy(true);
      try {
        await api.post(`/approvals/${approval.id}`, {
          decision,
          scope: critical ? 'once' : scope,
          ...(remembered && { pattern }),
          ...(remembered && ttl !== '0' && { ttl_seconds: Number(ttl) }),
        });
      } catch (error) {
        notify({
          level: 'error',
          title: error instanceof ApiCallError ? error.body.error.title : 'Your answer did not reach Core',
          body:
            error instanceof ApiCallError
              ? error.body.error.hint
              : 'Check that NVX Ancile is running, then answer again.',
        });
        return;
      } finally {
        setBusy(false);
      }
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
    }
    setOpen(false);
    setMark('idle');
    notify({
      level: decision === 'approve' ? 'success' : 'info',
      title:
        decision === 'approve' ? 'Approved. The agent is carrying on.' : 'Declined. The agent has been told.',
      body: remembered
        ? `${decision === 'approve' ? 'Allowed' : 'Blocked'} ${SCOPES.find((s) => s.id === scope)?.label.toLowerCase()}: ${pattern}`
        : undefined,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content
          className="dialog approval"
          data-tier={approval.tier}
          aria-describedby="approval-desc"
          // Land on the question itself: neither answer should be one keypress away.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            const el = returnTo.current;
            if (el instanceof HTMLElement && el.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
          tabIndex={-1}
        >
          <div className="approval__head">
            <TierBadge tier={approval.tier} />
            <Dialog.Close className="icon-btn icon-btn--sm" aria-label="Decide later">
              <Icon name="close" size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Title className="dialog__title">
            {critical ? 'NVX Ancile needs your go-ahead for this' : 'Allow the agent to do this?'}
          </Dialog.Title>
          <p id="approval-desc" className="dialog__lede">
            {approval.reason}
          </p>

          <dl className="approval__facts">
            {approval.threadId ? (
              <>
                <dt>Thread</dt>
                <dd>
                  <Link
                    to="/t/$threadId"
                    params={{ threadId: approval.threadId }}
                    className="approval__thread"
                    onClick={() => setOpen(false)}
                  >
                    {thread?.title || 'Untitled thread'}
                  </Link>
                </dd>
              </>
            ) : null}
            <dt>Tool</dt>
            <dd data-num>{approval.tool}</dd>
            <dt>Action</dt>
            <dd data-num>{approval.action}</dd>
            <dt>On</dt>
            <dd data-num className="approval__resource">
              {approval.resource}
            </dd>
          </dl>
          <pre className="approval__preview">{approval.argsPreview}</pre>

          {critical ? (
            <p className="approval__critical">
              <Icon name="warn" size={14} />
              Critical actions are never remembered. NVX Ancile will ask every time.
            </p>
          ) : (
            <>
              <fieldset className="field">
                <legend>Allow</legend>
                <RadioGroup.Root
                  className="choices"
                  value={custom ? '__custom' : pattern}
                  onValueChange={(v) => {
                    if (v === '__custom') setCustom(true);
                    else {
                      setCustom(false);
                      setPattern(v);
                    }
                  }}
                >
                  {approval.suggestions.map((p, i) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: the Radix radio inside is the control
                    <label key={p} className="choice">
                      <RadioGroup.Item value={p} className="radio">
                        <RadioGroup.Indicator className="radio__dot" />
                      </RadioGroup.Item>
                      <span className="choice__text">
                        <span>{describePattern(p, i, approval.suggestions.length)}</span>
                        <span data-num className="mute choice__mono">
                          {p}
                        </span>
                      </span>
                    </label>
                  ))}
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the Radix radio inside is the control */}
                  <label className="choice">
                    <RadioGroup.Item value="__custom" className="radio">
                      <RadioGroup.Indicator className="radio__dot" />
                    </RadioGroup.Item>
                    <span className="choice__text">
                      <span>A pattern of my own</span>
                      {custom ? (
                        <input
                          className="input input--mono"
                          value={pattern}
                          onChange={(e) => setPattern(e.target.value)}
                          aria-label="Custom pattern"
                          spellCheck={false}
                        />
                      ) : null}
                    </span>
                  </label>
                </RadioGroup.Root>
              </fieldset>

              <div className="approval__row">
                <fieldset className="field">
                  <legend>Remember</legend>
                  <RadioGroup.Root
                    className="segmented"
                    value={scope}
                    onValueChange={(v) => setScope(v as typeof scope)}
                    aria-label="Remember this decision"
                  >
                    {scopes.map((s) => (
                      <RadioGroup.Item
                        key={s.id}
                        value={s.id}
                        className="segmented__opt"
                        title={
                          s.id === 'notebook' && notebookTitle
                            ? `For every thread in ${notebookTitle}`
                            : s.hint
                        }
                      >
                        {s.label}
                      </RadioGroup.Item>
                    ))}
                  </RadioGroup.Root>
                </fieldset>
                <label className="field field--inline">
                  <span>Expires</span>
                  <select
                    className="input"
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    disabled={scope === 'once'}
                  >
                    {EXPIRY.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}

          <div className="dialog__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void decide('deny')}
              disabled={busy}
            >
              {critical || scope === 'once' ? 'Decline' : 'Decline and remember'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void decide('approve')}
              disabled={busy}
              data-autofocus
            >
              {critical || scope === 'once' ? 'Approve once' : 'Approve and remember'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
