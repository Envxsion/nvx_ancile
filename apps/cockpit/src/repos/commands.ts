/**
 * ------------------------------------------------------------------
 *  Title    |  Repo commands
 *  Ref      |  DESIGN.md §17
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Commit, push, pull, switch branch and open a pull
 *           |  request from the command palette, for the repository
 *           |  this thread or notebook works in.
 *  How      |  Pull and push run at once with a toast; the others open
 *           |  the Repo panel where you write the message or pick the
 *           |  branch. Hidden when nothing is linked.
 * ------------------------------------------------------------------
 */

import { reportFailure } from '../ops/common';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import type { IconName } from '../ui/Icon';
import { repoAction, useLinkedRepo, useRepoScope } from './data';

export interface RepoCmd {
  id: string;
  label: string;
  icon: IconName;
  words?: string;
  run: () => void;
  when?: boolean;
}

export function useRepoCommands(): RepoCmd[] {
  const scope = useRepoScope();
  const repo = useLinkedRepo(scope).data;
  const panel = () => useUi.getState().openDrawer('repo');
  const linkable = !!(scope.threadId || scope.notebookId);
  if (!repo)
    return [
      {
        id: 'repo-link',
        label: 'Link a repository',
        icon: 'branch',
        words: 'git github folder code project',
        run: panel,
        when: linkable,
      },
    ];
  const s = repo.status;
  const act = (label: string, op: Parameters<typeof repoAction>[1], done: string) => () =>
    void repoAction(repo.id, op).then(
      () => notify({ level: 'success', title: done }),
      (e) => reportFailure(e, label),
    );
  return [
    {
      id: 'repo-commit',
      label: `Commit in ${repo.name}`,
      icon: 'check',
      words: 'git commit save changes',
      run: panel,
    },
    {
      id: 'repo-push',
      label: s?.upstream ? `Push ${s.branch ?? ''}` : `Publish ${s?.branch ?? 'branch'}`,
      icon: 'arrowUp',
      words: 'git push upload',
      run: act('Pushing', { op: 'push' }, `Pushed ${s?.branch ?? ''}`),
      when: !!s?.branch,
    },
    {
      id: 'repo-pull',
      label: `Pull ${s?.branch ?? ''}`,
      icon: 'arrowDown',
      words: 'git pull update fetch',
      run: act('Pulling', { op: 'pull' }, 'Pulled'),
      when: !!s?.upstream,
    },
    { id: 'repo-switch', label: 'Switch branch', icon: 'branch', words: 'git checkout branch', run: panel },
    {
      id: 'repo-pr',
      label: 'Open a pull request',
      icon: 'merge',
      words: 'github pr pull request review',
      run: panel,
      when: !!s?.github,
    },
  ];
}
