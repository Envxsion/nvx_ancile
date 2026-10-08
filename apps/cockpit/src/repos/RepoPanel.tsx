/**
 * ------------------------------------------------------------------
 *  Title    |  Repo panel
 *  Ref      |  DESIGN.md §17 · docs/repos.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The repository this thread works in, beside the
 *           |  conversation: branch, what changed, the diff, a commit
 *           |  box, pull and push, and the GitHub side (pull requests,
 *           |  Actions runs).
 *  How      |  Drawer tab. Buttons here are you acting, so they run at
 *           |  once; the assistant's own git tools still ask first.
 *           |  With nothing linked it offers your repositories, or a
 *           |  folder to add.
 *  Note     |  Commit messages are drafted from the staged files in the
 *           |  repository's own style; you edit before committing.
 * ------------------------------------------------------------------
 */

import type { RepoFile, RepoInfo, RepoStatus } from '@nvx/contracts';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { reportFailure } from '../ops/common';
import { notify } from '../state/notify';
import { Check } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton, StatusDot } from '../ui/primitives';
import {
  addRepo,
  linkRepo,
  refreshRepo,
  repoAction,
  repoKeys,
  useGitHubAccess,
  useLinkedRepo,
  usePulls,
  useRepoBranches,
  useRepoDiff,
  useRepoLog,
  useRepoScope,
  useRepoStatus,
  useRepos,
  useRuns,
} from './data';

const LETTER: Record<string, string> = {
  M: 'Changed',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Conflict',
  '?': 'New',
  T: 'Type changed',
};

const isStaged = (f: RepoFile) => f.staged !== '.' && f.staged !== '?' && f.staged !== 'U';
const letterOf = (f: RepoFile) => (f.staged === '?' ? '?' : f.staged !== '.' ? f.staged : f.unstaged);

export function RepoPanel() {
  const scope = useRepoScope();
  const linked = useLinkedRepo(scope);
  if (!scope.threadId && !scope.notebookId)
    return (
      <EmptyState
        icon="branch"
        title="Open a thread or notebook"
        body="A repository belongs to a notebook or a thread. Open one to link it."
      />
    );
  if (linked.isPending) return <Skeleton lines={4} label="Loading the repository" />;
  if (!linked.data) return <LinkRepo scope={scope} />;
  return <Linked repo={linked.data} scope={scope} />;
}

/* ---- Nothing linked yet ------------------------------------------------ */

function LinkRepo({ scope }: { scope: { threadId: string | null; notebookId: string | null } }) {
  const repos = useRepos();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const target = scope.threadId ? ('thread' as const) : ('notebook' as const);
  const ref = (scope.threadId ?? scope.notebookId) as string;

  const link = async (r: RepoInfo, where: 'thread' | 'notebook') => {
    const at = where === 'thread' ? scope.threadId : scope.notebookId;
    if (!at) return;
    try {
      await linkRepo(where, at, r.id);
      notify({ level: 'success', title: `This ${where} works in ${r.name}` });
    } catch (e) {
      reportFailure(e, 'Linking');
    }
  };

  const add = async () => {
    if (!path.trim()) return;
    setBusy(true);
    try {
      const r = await addRepo(path.trim());
      await linkRepo(target, ref, r.id);
      setPath('');
      notify({
        level: 'success',
        title: `Added ${r.name}`,
        body: r.status?.branch ? `On ${r.status.branch}.` : undefined,
      });
    } catch (e) {
      reportFailure(e, 'Adding the repository');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel repo">
      <p className="mute repo__lede">
        Link a git repository and the assistant can read its status, diffs and history, and commit, push or
        open a pull request when you approve each step.
      </p>
      {(repos.data ?? []).length > 0 ? (
        <section className="repo__section">
          <h3 className="repo__h">Your repositories</h3>
          <ul className="repo__list">
            {(repos.data ?? []).map((r) => (
              <li key={r.id} className="repo__pick">
                <span className="repo__pick-name">
                  <Icon name="folder" size={13} />
                  {r.name}
                  {r.status?.branch ? <span className="mute"> on {r.status.branch}</span> : null}
                </span>
                <span className="repo__pick-acts">
                  {scope.threadId ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void link(r, 'thread')}
                    >
                      Use in this thread
                    </button>
                  ) : null}
                  {scope.notebookId ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void link(r, 'notebook')}
                    >
                      Use in this notebook
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="repo__section">
        <h3 className="repo__h">Add a folder</h3>
        <form
          className="repo__add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className="input input--sm"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\Users\you\code\project or ~/code/project"
            aria-label="Folder of the repository"
            spellCheck={false}
          />
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={!path.trim() || busy}
            data-busy={busy || undefined}
          >
            Add and link
          </button>
        </form>
        <p className="mute repo__hint">
          Any folder inside the repository works. Your git sign-in stays with git.
        </p>
      </section>
    </div>
  );
}

/* ---- A linked repository ----------------------------------------------- */

function Linked({
  repo,
  scope,
}: {
  repo: RepoInfo;
  scope: { threadId: string | null; notebookId: string | null };
}) {
  const status = useRepoStatus(repo.id);
  const s = status.data ?? repo.status;
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, op: Parameters<typeof repoAction>[1], done?: string) => {
    setBusy(label);
    try {
      await repoAction(repo.id, op);
      if (done) notify({ level: 'success', title: done });
    } catch (e) {
      reportFailure(e, label);
    } finally {
      setBusy(null);
    }
  };

  if (!s)
    return (
      <EmptyState
        icon="alert"
        title={`${repo.name} cannot be read`}
        body={repo.error ?? 'The folder may have moved. Remove it and add it again.'}
      />
    );

  return (
    <div className="panel repo">
      <header className="repo__head">
        <div className="repo__title">
          <strong>{repo.name}</strong>
          <span className="mute repo__root" title={repo.root}>
            {repo.root}
          </span>
        </div>
        <button
          type="button"
          className="link-btn link-btn--quiet"
          onClick={() => {
            const where = scope.threadId ? 'thread' : 'notebook';
            const at = scope.threadId ?? scope.notebookId;
            if (at) void linkRepo(where, at, null).catch((e) => reportFailure(e, 'Unlinking'));
          }}
        >
          Unlink
        </button>
      </header>

      <BranchBar repoId={repo.id} status={s} busy={busy} run={run} />
      {s.operation ? (
        <p className="repo__warn">
          <Icon name="warn" size={13} /> A {s.operation} is in progress. Finish or abort it in a terminal
          first.
        </p>
      ) : null}

      <Changes repoId={repo.id} status={s} run={run} />
      <CommitBox repoId={repo.id} status={s} busy={busy} run={run} />
      <History repoId={repo.id} />
      {s.github ? <GitHubSection repoId={repo.id} status={s} /> : null}
    </div>
  );
}

type Run = (label: string, op: Parameters<typeof repoAction>[1], done?: string) => Promise<void>;

function BranchBar({
  repoId,
  status,
  busy,
  run,
}: {
  repoId: string;
  status: RepoStatus;
  busy: string | null;
  run: Run;
}) {
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState('');
  const branches = useRepoBranches(repoId, picking);
  const locals = (branches.data ?? []).filter((b) => !b.remote);
  return (
    <section className="repo__section repo__branchbar">
      <div className="repo__branch">
        <Icon name="branch" size={14} />
        <button
          type="button"
          className="repo__branch-name"
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
          title="Switch branch"
        >
          {status.branch ?? `detached at ${status.head?.slice(0, 7) ?? '?'}`}
          <Icon name="chevronDown" size={11} />
        </button>
        <span className="repo__ab mute" data-num>
          {status.upstream ? (
            <>
              <span title="Commits to push">↑{status.ahead}</span>{' '}
              <span title="Commits to pull">↓{status.behind}</span>
            </>
          ) : (
            'not pushed yet'
          )}
        </span>
      </div>
      <div className="repo__acts">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!!busy}
          data-busy={busy === 'Fetching' || undefined}
          onClick={() => void run('Fetching', { op: 'fetch' })}
        >
          Fetch
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!!busy || !status.upstream}
          data-busy={busy === 'Pulling' || undefined}
          onClick={() => void run('Pulling', { op: 'pull' }, 'Pulled')}
        >
          <Icon name="arrowDown" size={12} /> Pull
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!!busy || !status.branch || (!!status.upstream && status.ahead === 0)}
          data-busy={busy === 'Pushing' || undefined}
          onClick={() =>
            void run(
              'Pushing',
              { op: 'push' },
              status.upstream ? `Pushed ${status.branch}` : `Published ${status.branch}`,
            )
          }
        >
          <Icon name="arrowUp" size={12} /> {status.upstream ? 'Push' : 'Publish branch'}
        </button>
      </div>
      {picking ? (
        <div className="repo__picker">
          {branches.isPending ? (
            <Skeleton lines={2} label="Loading branches" />
          ) : (
            <ul className="repo__branches">
              {locals.map((b) => (
                <li key={b.name}>
                  <button
                    type="button"
                    className="repo__branch-opt"
                    data-current={b.current || undefined}
                    disabled={b.current || !!busy}
                    onClick={() =>
                      void run('Switching', { op: 'switch', branch: b.name }, `On ${b.name}`).then(() =>
                        setPicking(false),
                      )
                    }
                  >
                    {b.current ? <Icon name="check" size={12} /> : <span className="repo__spacer" />}
                    {b.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="repo__add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void run(
                'Creating the branch',
                { op: 'switch', branch: name.trim(), create: true },
                `On ${name.trim()}`,
              ).then(() => {
                setName('');
                setPicking(false);
              });
            }}
          >
            <input
              className="input input--sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="new-branch-name"
              aria-label="New branch name"
              spellCheck={false}
            />
            <button type="submit" className="btn btn--ghost btn--sm" disabled={!name.trim() || !!busy}>
              Create and switch
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function Changes({ repoId, status, run }: { repoId: string; status: RepoStatus; run: Run }) {
  const [open, setOpen] = useState<{ path: string; staged: boolean } | null>(null);
  const diff = useRepoDiff(repoId, open?.path ?? null, open?.staged ?? false);
  const staged = status.files.filter(isStaged);
  if (status.files.length === 0)
    return (
      <section className="repo__section">
        <h3 className="repo__h">Changes</h3>
        <p className="mute">Nothing changed since the last commit.</p>
      </section>
    );
  return (
    <section className="repo__section">
      <div className="repo__row-head">
        <h3 className="repo__h">
          Changes{' '}
          <span className="mute" data-num>
            {status.files.length}
          </span>
        </h3>
        <button
          type="button"
          className="link-btn"
          onClick={() =>
            void run(
              'Staging',
              staged.length === status.files.length
                ? { op: 'unstage', paths: staged.map((f) => f.path) }
                : { op: 'stage', paths: status.files.filter((f) => !isStaged(f)).map((f) => f.path) },
            )
          }
        >
          {staged.length === status.files.length ? 'Unstage all' : 'Stage all'}
        </button>
      </div>
      <ul className="repo__files">
        {status.files.slice(0, 200).map((f) => {
          const st = isStaged(f);
          const l = letterOf(f);
          return (
            <li
              key={`${f.path}:${f.staged}`}
              className="repo__file"
              data-open={open?.path === f.path || undefined}
            >
              <Check
                checked={st}
                label={st ? `Unstage ${f.path}` : `Stage ${f.path}`}
                onChange={(next) => void run('Staging', { op: next ? 'stage' : 'unstage', paths: [f.path] })}
              />
              <button
                type="button"
                className="repo__file-name"
                title={f.from ? `${f.from} → ${f.path}` : f.path}
                onClick={() => setOpen((o) => (o?.path === f.path ? null : { path: f.path, staged: st }))}
              >
                {f.path}
              </button>
              <span className="repo__letter" data-kind={l} title={LETTER[l] ?? l}>
                {l === '?' ? 'N' : l}
              </span>
            </li>
          );
        })}
      </ul>
      {open ? (
        <div className="repo__diff-wrap">
          {diff.isPending ? (
            <Skeleton lines={3} label="Loading the diff" />
          ) : (
            <Diff text={diff.data?.diff ?? ''} truncated={diff.data?.truncated ?? false} />
          )}
        </div>
      ) : null}
    </section>
  );
}

function Diff({ text, truncated }: { text: string; truncated: boolean }) {
  const lines = useMemo(() => text.split('\n').slice(0, 1_500), [text]);
  if (!text.trim()) return <p className="mute">No text changes (a binary file, or only its mode changed).</p>;
  return (
    <pre className="repo__diff" data-scrollable>
      {lines.map((l, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          key={i}
          className="repo__dl"
          data-kind={
            l.startsWith('+++') || l.startsWith('---')
              ? 'meta'
              : l.startsWith('+')
                ? 'add'
                : l.startsWith('-')
                  ? 'del'
                  : l.startsWith('@@')
                    ? 'hunk'
                    : undefined
          }
        >
          {l || ' '}
          {'\n'}
        </span>
      ))}
      {truncated || text.split('\n').length > 1_500 ? (
        <span className="repo__dl mute">The diff is longer; open the file to see the rest.</span>
      ) : null}
    </pre>
  );
}

function CommitBox({
  repoId,
  status,
  busy,
  run,
}: {
  repoId: string;
  status: RepoStatus;
  busy: string | null;
  run: Run;
}) {
  const [message, setMessage] = useState('');
  const staged = status.files.filter(isStaged).length;
  const draft = async () => {
    try {
      const r = await api.get<{ message: string }>(`/repos/${repoId}/suggest-message`);
      if (r.message) setMessage(r.message);
      else
        notify({
          level: 'info',
          title: 'Stage something first',
          body: 'The draft is written from the staged files.',
        });
    } catch (e) {
      reportFailure(e, 'Drafting a message');
    }
  };
  if (status.files.length === 0) return null;
  return (
    <section className="repo__section repo__commit">
      <label className="repo__h" htmlFor="repo-commit-msg">
        Commit
      </label>
      <textarea
        id="repo-commit-msg"
        className="input repo__msg"
        rows={3}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={staged ? 'What changed, and why' : 'Stage files to commit them'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && message.trim() && staged) {
            e.preventDefault();
            void run('Committing', { op: 'commit', message }, 'Committed').then(() => setMessage(''));
          }
        }}
      />
      <div className="repo__acts">
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          onClick={() => void draft()}
          disabled={!staged}
        >
          <Icon name="sparkle" size={12} /> Draft a message
        </button>
        <span className="statusbar__spacer" />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!message.trim() || !staged || !!busy}
          data-busy={busy === 'Committing' || undefined}
          onClick={() =>
            void run(
              'Committing',
              { op: 'commit', message },
              `Committed ${staged} ${staged === 1 ? 'file' : 'files'}`,
            ).then(() => setMessage(''))
          }
        >
          Commit {staged ? `${staged} ${staged === 1 ? 'file' : 'files'}` : ''}
        </button>
      </div>
    </section>
  );
}

function History({ repoId }: { repoId: string }) {
  const log = useRepoLog(repoId);
  const items = (log.data ?? []).slice(0, 8);
  if (!items.length) return null;
  return (
    <section className="repo__section">
      <h3 className="repo__h">Recent commits</h3>
      <ul className="repo__log">
        {items.map((c) => (
          <li key={c.sha}>
            <code>{c.short}</code>
            <span className="repo__subject" title={c.subject}>
              {c.subject}
            </span>
            <span className="mute" data-num>
              {relative(c.at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---- GitHub ------------------------------------------------------------ */

function GitHubSection({ repoId, status }: { repoId: string; status: RepoStatus }) {
  const access = useGitHubAccess();
  const connected = !!access.data && access.data.via !== 'none';
  const pulls = usePulls(repoId, connected);
  const runs = useRuns(repoId, connected);
  const [log, setLog] = useState<{ id: number; text: string } | null>(null);
  const mine = (pulls.data ?? []).find((p) => p.head === status.branch);

  return (
    <section className="repo__section repo__gh">
      <div className="repo__row-head">
        <h3 className="repo__h">
          GitHub{' '}
          <span className="mute">{status.github ? `${status.github.owner}/${status.github.repo}` : ''}</span>
        </h3>
        {access.data?.via !== 'none' && access.data?.login ? (
          <span className="mute repo__who">
            {access.data.via === 'gh' ? 'via gh' : 'via token'} as {access.data.login}
          </span>
        ) : null}
      </div>
      {access.isPending ? (
        <Skeleton lines={2} label="Checking GitHub" />
      ) : !connected ? (
        <ConnectGitHub detail={access.data?.detail ?? null} />
      ) : (
        <>
          {status.branch && !mine && status.upstream ? (
            <OpenPr repoId={repoId} branch={status.branch} />
          ) : null}
          <h4 className="repo__h4">Pull requests</h4>
          {pulls.isError ? (
            <p className="mute">{(pulls.error as Error).message}</p>
          ) : (pulls.data ?? []).length === 0 ? (
            <p className="mute">No open pull requests.</p>
          ) : (
            <ul className="repo__prs">
              {(pulls.data ?? []).slice(0, 10).map((p) => (
                <li key={p.number} data-mine={p.head === status.branch || undefined}>
                  <StatusDot
                    status={
                      p.checks === 'failing'
                        ? 'down'
                        : p.checks === 'pending'
                          ? 'degraded'
                          : p.checks === 'passing'
                            ? 'ok'
                            : 'idle'
                    }
                    label={`Checks ${p.checks ?? 'none'}`}
                  />
                  <a href={p.url} target="_blank" rel="noreferrer" className="repo__pr-title">
                    #{p.number} {p.title}
                  </a>
                  <span className="mute">{p.draft ? 'draft' : p.head}</span>
                </li>
              ))}
            </ul>
          )}
          <h4 className="repo__h4">Actions</h4>
          {runs.isError ? (
            <p className="mute">{(runs.error as Error).message}</p>
          ) : (runs.data ?? []).length === 0 ? (
            <p className="mute">No workflow runs yet.</p>
          ) : (
            <ul className="repo__runs">
              {(runs.data ?? []).slice(0, 8).map((r) => {
                const failed = r.conclusion === 'failure' || r.conclusion === 'timed_out';
                return (
                  <li key={r.id}>
                    <StatusDot
                      status={
                        r.status !== 'completed'
                          ? 'restarting'
                          : failed
                            ? 'down'
                            : r.conclusion === 'success'
                              ? 'ok'
                              : 'idle'
                      }
                      label={r.status !== 'completed' ? r.status : (r.conclusion ?? 'done')}
                    />
                    <a href={r.url} target="_blank" rel="noreferrer" className="repo__pr-title">
                      {r.name}
                    </a>
                    <span className="mute">{r.branch}</span>
                    {failed ? (
                      <span className="repo__run-acts">
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            void api
                              .get<{ log: string }>(`/repos/${repoId}/runs/${r.id}/log`)
                              .then((x) => setLog({ id: r.id, text: x.log }))
                              .catch((e) => reportFailure(e, 'Reading the log'))
                          }
                        >
                          Log
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            void api
                              .post(`/repos/${repoId}/runs/${r.id}/rerun?failed=true`, {})
                              .then(() => {
                                notify({
                                  level: 'success',
                                  title: `Running the failed jobs of ${r.name} again`,
                                });
                                return queryClient.invalidateQueries({ queryKey: repoKeys.runs(repoId) });
                              })
                              .catch((e) => reportFailure(e, 'Re-running'))
                          }
                        >
                          Run failed jobs again
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {log ? (
            <div className="repo__diff-wrap">
              <div className="repo__row-head">
                <span className="mute">Log of run {log.id}</span>
                <button type="button" className="link-btn link-btn--quiet" onClick={() => setLog(null)}>
                  Close
                </button>
              </div>
              <pre className="repo__diff" data-scrollable>
                {log.text}
              </pre>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function ConnectGitHub({ detail }: { detail: string | null }) {
  const [token, setToken] = useState('');
  const save = async () => {
    try {
      const a = await api.put<{ via: string; login: string | null }>('/github/token', {
        token: token.trim(),
      });
      setToken('');
      await queryClient.invalidateQueries({ queryKey: repoKeys.access });
      notify(
        a.via === 'token'
          ? { level: 'success', title: `Connected to GitHub as ${a.login ?? 'you'}` }
          : {
              level: 'warn',
              title: 'GitHub did not accept that token',
              body: 'Check it has access to this repository.',
            },
      );
    } catch (e) {
      reportFailure(e, 'Saving the token');
    }
  };
  return (
    <div className="repo__connect">
      <p className="mute">
        {detail ? `${detail} ` : ''}Sign in with the GitHub CLI (<code>gh auth login</code>) and NVX Ancile
        uses that, or paste a fine-grained token with access to this repository. It is kept encrypted and
        never shown again.
      </p>
      <form
        className="repo__add"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          className="input input--sm"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="github_pat_…"
          aria-label="GitHub token"
        />
        <button type="submit" className="btn btn--ghost btn--sm" disabled={token.trim().length < 10}>
          Save token
        </button>
      </form>
    </div>
  );
}

function OpenPr({ repoId, branch }: { repoId: string; branch: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn--ghost btn--sm repo__open-pr" onClick={() => setOpen(true)}>
        <Icon name="merge" size={12} /> Open a pull request from {branch}
      </button>
    );
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ number: number | null; url: string }>(`/repos/${repoId}/pulls`, {
        title: title.trim(),
        ...(body.trim() && { body: body.trim() }),
        ...(draft && { draft: true }),
      });
      notify({
        level: 'success',
        title: r.number ? `Opened #${r.number}` : 'Pull request opened',
        body: r.url,
      });
      setOpen(false);
      await refreshRepo(repoId);
    } catch (e) {
      reportFailure(e, 'Opening the pull request');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="repo__pr-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        className="input input--sm"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        aria-label="Pull request title"
      />
      <textarea
        className="input repo__msg"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What it changes and how to check it"
        aria-label="Pull request description"
      />
      <div className="repo__acts">
        <span className="repo__inline">
          <Check checked={draft} onChange={setDraft} label="Open as a draft" /> Draft
        </span>
        <span className="statusbar__spacer" />
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={!title.trim() || busy}
          data-busy={busy || undefined}
        >
          Open pull request
        </button>
      </div>
    </form>
  );
}
