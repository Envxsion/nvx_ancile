/**
 * ------------------------------------------------------------------
 *  Title    |  Activity: the demo's sample rows
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the Activity panel shows on demo data, so the
 *           |  sample workspace has something running to look at.
 *  Note     |  Times are relative to now; ids are the demo's own.
 * ------------------------------------------------------------------
 */

import type { ActivityItem, ActivityResponse } from '@nvx/contracts';

const BUF = 'thr_01J9ZK00000000000000000BUF';
const RST = 'thr_01J9ZK00000000000000000RST';

function row(p: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'kind' | 'title'>): ActivityItem {
  return {
    detail: null,
    state: 'running',
    started_at: null,
    updated_at: null,
    finished_at: null,
    thread_id: null,
    thread_title: null,
    message_id: null,
    run_kind: null,
    run_status: null,
    progress: null,
    session_id: null,
    project: null,
    held: null,
    ...p,
  };
}

export function demoActivity(now = Date.now()): ActivityResponse {
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const items: ActivityItem[] = [
    row({
      id: 'run:demo-fc',
      kind: 'run',
      title: 'Fact-check',
      detail: 'Checking claims',
      started_at: ago(48),
      thread_id: BUF,
      thread_title: 'Sodium-ion or LFP for the depot buffer?',
      run_kind: 'factcheck',
      run_status: 'running',
      progress: { done: 4, total: 9 },
    }),
    row({
      id: 'run:demo-research',
      kind: 'run',
      title: 'Research',
      detail: 'Waiting for your decision',
      state: 'waiting',
      started_at: ago(260),
      thread_id: BUF,
      thread_title: 'Sodium-ion or LFP for the depot buffer?',
      run_kind: 'research',
      run_status: 'waiting_approval',
    }),
    row({
      id: 'cc:demo-term',
      kind: 'claude_session',
      title: 'Lifetimes in the tokeniser rewrite',
      detail: 'Open in a terminal',
      started_at: ago(5_400),
      thread_id: RST,
      thread_title: 'Lifetimes in the tokeniser rewrite',
      session_id: 'demo-term',
      project: 'tokeniser',
      held: 'terminal',
    }),
    row({
      id: 'agent:demo-term:1',
      kind: 'subagent',
      title: 'Find every borrow of the token buffer',
      detail: 'Subagent: Explore',
      started_at: ago(95),
      thread_id: RST,
      thread_title: 'Lifetimes in the tokeniser rewrite',
      session_id: 'demo-term',
      project: 'tokeniser',
    }),
    row({
      id: 'shell:demo-term:1',
      kind: 'shell',
      title: 'cargo watch -x test',
      detail: 'Run the tests on every change',
      started_at: ago(1_900),
      thread_id: RST,
      thread_title: 'Lifetimes in the tokeniser rewrite',
      session_id: 'demo-term',
      project: 'tokeniser',
    }),
    row({
      id: 'shell:demo-term:2',
      kind: 'shell',
      title: 'cargo bench --bench lexer',
      detail: 'Benchmark the lexer',
      state: 'finished',
      started_at: ago(700),
      finished_at: ago(140),
      thread_id: RST,
      thread_title: 'Lifetimes in the tokeniser rewrite',
      session_id: 'demo-term',
      project: 'tokeniser',
    }),
  ];
  return {
    items,
    running: items.filter((i) => i.state === 'running' || i.state === 'waiting').length,
    import: null,
    at: new Date(now).toISOString(),
  };
}
