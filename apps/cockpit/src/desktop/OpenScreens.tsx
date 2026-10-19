/**
 * ------------------------------------------------------------------
 *  Title    |  Where an ancile:// link lands
 *  Ref      |  ROADMAP row DL1 · docs/desktop.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A link opens a place and stops. These are the places
 *           |  that need a little work to open: a request waiting for
 *           |  your answer, a message to start, a help topic, and (Pro)
 *           |  a flow to run.
 *  How      |  /open/approval/<id> shows the approval's own dialog;
 *           |  it never answers. /open/new?text=&notebook= puts the
 *           |  text in the new-thread box as a draft; it never sends.
 *           |  /open/help?topic= opens the help centre.
 *           |  /open/flow/<id>/run asks Pro's dialog, which asks
 *           |  first to allow links from this app and then shows a
 *           |  Run button: nothing starts until it is pressed.
 *           |  An id that is not here (deleted, another workspace, a
 *           |  team member's) gets a plain "not found" with the way on.
 *  Note     |  Whatever else the link said, none of these acts. The
 *           |  Run button, Send and the approval buttons are clicks.
 * ------------------------------------------------------------------
 */

import type { Approval } from '@nvx/contracts';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Suspense, useEffect, useState } from 'react';
import { ARTICLES } from '../help/articles';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { ProUpsell, useProFeature } from '../pro/slot';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { draftKey } from '../thread/Composer';
import { EmptyState, Skeleton } from '../ui/primitives';

function NotHere({ what, body }: { what: string; body: string }) {
  return (
    <div className="link-screen">
      <EmptyState icon="search" title={`${what} is not here`} body={body} />
      <div className="link-screen__actions">
        <Link to="/" className="btn btn--primary btn--sm">
          Go to the start page
        </Link>
      </div>
    </div>
  );
}

/** ancile://approval/<id>: open the dialog for that request. It never answers it. */
export function OpenApprovalScreen() {
  const { approvalId } = useParams({ strict: false }) as { approvalId: string };
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const a = await api.get<Approval>(`/approvals/${encodeURIComponent(approvalId)}`);
        if (cancelled) return;
        const where = a.thread_id
          ? { to: '/t/$threadId' as const, params: { threadId: a.thread_id } }
          : { to: '/' as const };
        await navigate({ ...where, replace: true });
        if (a.status === 'pending') {
          await queryClient.invalidateQueries({ queryKey: keys.approvals });
          useUi.getState().setApproval(true, a.id);
        } else {
          notify({
            level: 'info',
            title: 'That request was already answered',
            body: 'Nothing more to do.',
          });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiCallError && err.status === 404) setMissing(true);
        else {
          notify({
            level: 'error',
            title: 'Could not open that request',
            body: 'Check that NVX Ancile is running, then try the link again.',
          });
          void navigate({ to: '/', replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [approvalId, navigate]);
  if (missing)
    return (
      <NotHere
        what="That request"
        body="It may have been answered already, or it belongs to another workspace or person."
      />
    );
  return (
    <div className="link-screen">
      <Skeleton lines={2} label="Opening the request" />
    </div>
  );
}

/** Add the text to the new-thread draft, keeping what is already there. Never sends. */
export function addToDraft(text: string, existing: string): string {
  const current = existing.trim();
  if (!current) return text;
  if (current.includes(text.trim())) return existing;
  return `${existing.replace(/\s+$/, '')}\n\n${text}`;
}

/** ancile://new?text=…&notebook=<id>: a draft in the new-thread box. Never sent. */
export function OpenNewScreen() {
  const search = useSearch({ strict: false }) as { text?: string; notebook?: string };
  const navigate = useNavigate();
  useEffect(() => {
    const text = typeof search.text === 'string' ? search.text.slice(0, 4000) : '';
    if (text) {
      const key = draftKey('new', null);
      try {
        localStorage.setItem(key, addToDraft(text, localStorage.getItem(key) ?? ''));
      } catch {
        notify({ level: 'info', title: 'The text could not be put in the box', body: text.slice(0, 300) });
      }
    }
    void navigate({
      to: '/',
      search: typeof search.notebook === 'string' && search.notebook ? { notebook: search.notebook } : {},
      replace: true,
    });
  }, [search.text, search.notebook, navigate]);
  return null;
}

/** ancile://help[/<topic>]: the help centre, on the topic if there is one. */
export function OpenHelpScreen() {
  const search = useSearch({ strict: false }) as { topic?: string };
  const navigate = useNavigate();
  useEffect(() => {
    const topic = typeof search.topic === 'string' ? search.topic : null;
    const article = topic ? ARTICLES.find((a) => a.id === topic)?.id : undefined;
    useUi.getState().setHelp(true, article ?? null);
    void navigate({ to: '/', replace: true });
  }, [search.topic, navigate]);
  return null;
}

/** ancile://flow/<id>/run (Pro): a confirm with a Run button. Never runs by itself. */
export function OpenFlowRunScreen() {
  const { flowId } = useParams({ strict: false }) as { flowId: string };
  const navigate = useNavigate();
  const pro = useProFeature('desktop');
  if (pro.loading)
    return (
      <div className="link-screen">
        <Skeleton lines={2} label="Opening the flow" />
      </div>
    );
  const Dialog = pro.unlocked ? pro.ui?.parts?.FlowLinkDialog : undefined;
  if (Dialog)
    return (
      <div className="link-screen">
        <Suspense fallback={null}>
          <Dialog
            flowId={flowId}
            onClose={() => void navigate({ to: '/', replace: true })}
            onStarted={(threadId) =>
              void navigate({ to: '/t/$threadId', params: { threadId }, replace: true })
            }
          />
        </Suspense>
      </div>
    );
  return (
    <div className="link-screen">
      <ProUpsell feature="desktop" build={pro.build} />
      <div className="link-screen__actions">
        <Link to="/flows/$flowId" params={{ flowId }} className="btn btn--ghost btn--sm">
          Open the flow instead
        </Link>
      </div>
    </div>
  );
}
