/**
 * ------------------------------------------------------------------
 *  Title    |  The global event stream
 *  Ref      |  DESIGN.md §4.1 (/events)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One resumable stream per tab for everything that is not
 *           |  a single run: approvals waiting anywhere, threads that
 *           |  started or finished answering, health changes, and
 *           |  notifications from any service.
 *  How      |  Events invalidate the queries they make stale, so the
 *           |  screens stay plain React Query consumers. Notifications
 *           |  become toasts. The last seq survives reconnects.
 * ------------------------------------------------------------------
 */

import { GlobalEvent } from '@nvx/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { onMemoryProposal } from '../memory/api';
import { decisionChime } from '../notify/chime';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { useMemoryTray } from '../thread/MemoryTray';
import { branchKeys, useSuggestions } from './branching';
import { keys } from './data';
import { queryClient } from './query';
import { openStream } from './sse';
import type { SourceView } from './types';

export function useGlobalEvents(): void {
  const demo = useUi((s) => s.demo);
  const navigate = useNavigate();

  useEffect(() => {
    if (demo) return;
    return openStream({
      url: '/api/v1/events',
      schema: GlobalEvent,
      onEvent: (e) => {
        switch (e.type) {
          case 'approval.requested':
            decisionChime();
            void queryClient.invalidateQueries({ queryKey: keys.approvals });
            break;
          case 'approval.resolved':
            void queryClient.invalidateQueries({ queryKey: keys.approvals });
            break;
          case 'run.updated':
            void queryClient.invalidateQueries({ queryKey: keys.threads });
            if (e.thread_id) {
              void queryClient.invalidateQueries({ queryKey: branchKeys.tree(e.thread_id) });
              void queryClient.invalidateQueries({ queryKey: branchKeys.budget(e.thread_id) });
            }
            break;
          case 'suggestion':
            if (e.kind === 'branch' && e.thread_id)
              useSuggestions.getState().offer({
                threadId: e.thread_id,
                messageId: e.ref,
                title: e.title ?? 'A new topic',
                message: e.message,
              });
            break;
          case 'repo.changed':
            void queryClient.invalidateQueries({ queryKey: ['repos', e.repo_id] });
            void queryClient.invalidateQueries({ queryKey: ['repos', 'linked'] });
            break;
          case 'health.changed':
            void queryClient.invalidateQueries({ queryKey: ['system-health'] });
            break;
          case 'source.progress': {
            // Move the bar now; refetch the lists when a source settles.
            const settled = e.status === 'ready' || e.status === 'failed';
            for (const [key, list] of queryClient.getQueriesData<SourceView[]>({ queryKey: ['sources'] })) {
              if (!list?.some((s) => s.id === e.source_id)) continue;
              queryClient.setQueryData<SourceView[]>(
                key,
                list.map((s) =>
                  s.id === e.source_id
                    ? {
                        ...s,
                        status: e.status as SourceView['status'],
                        detail: e.message || s.detail,
                        progress: e.total ? Math.min(1, (e.done ?? 0) / e.total) : null,
                      }
                    : s,
                ),
              );
            }
            if (settled) {
              const title = queryClient
                .getQueriesData<SourceView[]>({ queryKey: ['sources'] })
                .flatMap(([, list]) => list ?? [])
                .find((s) => s.id === e.source_id)?.title;
              if (title)
                notify({
                  id: `src-${e.source_id}-${e.status}`,
                  category: 'sources',
                  level: e.status === 'ready' ? 'success' : 'error',
                  title: e.status === 'ready' ? `${title} is ready` : `${title} could not be read`,
                  ...(e.status === 'failed' && e.message && { body: e.message }),
                });
              void queryClient.invalidateQueries({ queryKey: ['sources'] });
              void queryClient.invalidateQueries({ queryKey: keys.notebooks });
            }
            break;
          }
          case 'memory.proposal':
            onMemoryProposal(e, (to) => void navigate({ to }));
            // Proposals (not auto-kept) wait under the flow answer that made them.
            if (!e.auto_applied && e.text)
              useMemoryTray.getState().add({
                id: e.proposal_id,
                text: e.text,
                target: e.target_path,
                at: Date.parse(e.at) || Date.now(),
                ...(e.run_id && { runId: e.run_id }),
              });
            break;
          case 'notification':
            notify({
              id: e.id,
              level: e.level,
              title: e.title,
              ...(e.body !== undefined && { body: e.body }),
              ...(e.category && { category: e.category }),
              ...(e.action && {
                action: { label: e.action.label, run: () => void navigate({ to: e.action?.href ?? '/' }) },
              }),
            });
            break;
          default:
            break;
        }
      },
    });
  }, [demo, navigate]);
}
