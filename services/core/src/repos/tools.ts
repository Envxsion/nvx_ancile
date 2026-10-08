/**
 * ------------------------------------------------------------------
 *  Title    |  Git and GitHub tools
 *  Ref      |  DESIGN.md §5.2, §17 · config/tools.yaml (git.*, github.*)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What a model may do with a repository, in chat or as a
 *           |  flow's Tool node: read freely, change the work tree with
 *           |  a yes, and reach outside (push, open or merge a pull
 *           |  request, start a workflow) only when you approve that
 *           |  exact call.
 *  How      |  Tiers: reads are AUTO; local changes (stage, commit,
 *           |  switch, pull, stash) are GATED; push, merge and dispatch
 *           |  are CRITICAL, so no standing grant covers them. The
 *           |  resource is `repo:<name>` (`repo:<name>/branch/<b>` for a
 *           |  push), on the repository the call will really act on:
 *           |  the one it names, else the thread's linked one.
 *           |  Approvals show a preview built from the repository
 *           |  itself (files, message, target branch), not the model's
 *           |  description of it.
 *  Note     |  There is no force push and no history rewrite here,
 *           |  except git_push_force_with_lease, a separate CRITICAL
 *           |  tool a model is told to use only when you asked.
 * ------------------------------------------------------------------
 */

import type { Tier } from '@nvx/contracts';
import type { ToolScope, ToolSpec } from '../tools/registry';
import type { GitHubClient } from './github';
import type { RepoService } from './service';

const repoArg = {
  type: 'string',
  description: 'Repository name. Leave it out to use the repository linked to this thread or notebook.',
};

interface Def {
  name: string;
  description: string;
  properties?: Record<string, unknown>;
  required?: string[];
  action: string;
  tier: Tier;
  destructive?: boolean;
  readOnly?: boolean;
  resource?: (repo: string, args: Record<string, unknown>) => string;
  run: (repoId: string, args: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown>;
  preview?: (repoId: string, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

export function repoTools(repos: RepoService, github: GitHubClient): ToolSpec[] {
  const slugOf = async (id: string) => {
    const s = await repos.status(id);
    if (!s.github) throw new Error('This repository has no GitHub remote (origin is not on github.com).');
    return s.github;
  };

  const defs: Def[] = [
    {
      name: 'git_status',
      description:
        'The current branch, how far it is ahead of or behind its upstream, and every changed file.',
      action: 'git.status',
      tier: 'auto',
      readOnly: true,
      run: async (id) => {
        const s = await repos.status(id);
        return {
          branch: s.branch,
          upstream: s.upstream,
          ahead: s.ahead,
          behind: s.behind,
          operation: s.operation,
          files: s.files.slice(0, 300),
          github: s.github,
        };
      },
    },
    {
      name: 'git_diff',
      description:
        'The diff of uncommitted changes, for one file or all. Set staged to see what the next commit contains.',
      properties: {
        path: { type: 'string', description: 'A file path relative to the repository root.' },
        staged: { type: 'boolean' },
      },
      action: 'git.diff',
      tier: 'auto',
      readOnly: true,
      run: (id, a) =>
        repos.diff(id, { ...(str(a.path) && { path: str(a.path) }), staged: a.staged === true }),
    },
    {
      name: 'git_log',
      description: 'Recent commits on the current branch.',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      action: 'git.log',
      tier: 'auto',
      readOnly: true,
      run: (id, a) => repos.log(id, a.limit ? num(a.limit) : 20),
    },
    {
      name: 'git_branches',
      description: 'Local and remote branches, and which one is checked out.',
      action: 'git.branches',
      tier: 'auto',
      readOnly: true,
      run: (id) => repos.branches(id),
    },
    {
      name: 'git_add',
      description: 'Stage files for the next commit.',
      properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['paths'],
      action: 'git.add',
      tier: 'gated',
      run: (id, a) => repos.act(id, { op: 'stage', paths: (a.paths as string[]) ?? [] }),
    },
    {
      name: 'git_commit',
      description:
        "Commit what is staged, with this message. Set all to stage every change first. Write the message in the repository's own style.",
      properties: { message: { type: 'string', minLength: 1 }, all: { type: 'boolean' } },
      required: ['message'],
      action: 'git.commit',
      tier: 'gated',
      run: (id, a, ctx) =>
        repos.act(id, { op: 'commit', message: str(a.message), all: a.all === true }, ctx.signal),
      preview: async (id, a) => {
        const s = await repos.status(id);
        const staged =
          a.all === true
            ? s.files.map((f) => f.path)
            : s.files.filter((f) => f.staged !== '.' && f.staged !== '?').map((f) => f.path);
        return {
          repository: repos.nameOf(id),
          branch: s.branch,
          message: str(a.message),
          files: staged.slice(0, 100),
          file_count: staged.length,
        };
      },
    },
    {
      name: 'git_switch',
      description: 'Switch to another branch, or create it from the current one.',
      properties: { branch: { type: 'string' }, create: { type: 'boolean' } },
      required: ['branch'],
      action: 'git.switch',
      tier: 'gated',
      resource: (repo, a) => `repo:${repo}/branch/${str(a.branch)}`,
      run: (id, a) => repos.act(id, { op: 'switch', branch: str(a.branch), create: a.create === true }),
    },
    {
      name: 'git_pull',
      description: "Bring in the upstream branch's new commits (fast-forward only, never a surprise merge).",
      action: 'git.pull',
      tier: 'gated',
      run: (id, _a, ctx) => repos.act(id, { op: 'pull' }, ctx.signal),
    },
    {
      name: 'git_stash',
      description: 'Put uncommitted changes aside (pop to bring them back).',
      properties: { pop: { type: 'boolean' }, message: { type: 'string' } },
      action: 'git.stash',
      tier: 'gated',
      run: (id, a) =>
        repos.act(
          id,
          a.pop === true
            ? { op: 'stash_pop' }
            : { op: 'stash', ...(str(a.message) && { message: str(a.message) }) },
        ),
    },
    {
      name: 'git_push',
      description:
        'Push the current branch to its remote (setting the upstream if it has none). Never forces.',
      action: 'git.push',
      tier: 'critical',
      resource: (repo) => `repo:${repo}/push`,
      run: (id, _a, ctx) => repos.act(id, { op: 'push' }, ctx.signal),
      preview: async (id) => {
        const s = await repos.status(id);
        const commits = (await repos.log(id, Math.min(Math.max(s.ahead, 1), 20))).map(
          (c) => `${c.short} ${c.subject}`,
        );
        const pushing = s.upstream ? commits.slice(0, s.ahead) : commits;
        return {
          repository: repos.nameOf(id),
          branch: s.branch,
          to: s.upstream ?? `origin/${s.branch ?? ''} (new branch on the remote)`,
          commits: pushing.length ? pushing : 'Nothing new to push',
        };
      },
    },
    {
      name: 'git_push_force_with_lease',
      description:
        'Overwrite the remote branch with yours (--force-with-lease). Only when the person explicitly asked for a force push.',
      action: 'git.push_force',
      tier: 'critical',
      destructive: true,
      resource: (repo) => `repo:${repo}/push`,
      run: async (id, _a, ctx) => ({ output: await repos.forcePushWithLease(id, ctx.signal) }),
      preview: async (id) => {
        const s = await repos.status(id);
        return {
          repository: repos.nameOf(id),
          branch: s.branch,
          overwrites: s.upstream,
          warning: 'Commits on the remote that you do not have will be lost.',
        };
      },
    },
    {
      name: 'gh_pr_list',
      description: 'Pull requests on GitHub for this repository, with their checks.',
      properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      action: 'github.pr_list',
      tier: 'auto',
      readOnly: true,
      run: async (id, a) => github.prs(await slugOf(id), { state: (str(a.state) || 'open') as 'open' }),
    },
    {
      name: 'gh_pr_view',
      description: 'One pull request: title, branches, description and checks.',
      properties: { number: { type: 'integer' } },
      required: ['number'],
      action: 'github.pr_view',
      tier: 'auto',
      readOnly: true,
      run: async (id, a) => github.pr(await slugOf(id), num(a.number)),
    },
    {
      name: 'gh_pr_create',
      description: 'Open a pull request from the current branch (push it first).',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string', description: 'Target branch; the default branch if left out.' },
        draft: { type: 'boolean' },
      },
      required: ['title'],
      action: 'github.pr_create',
      tier: 'gated',
      run: async (id, a) => {
        const s = await repos.status(id);
        if (!s.branch) throw new Error('Switch to a branch before opening a pull request.');
        return github.createPr(
          await slugOf(id),
          {
            title: str(a.title),
            body: str(a.body),
            ...(str(a.base) && { base: str(a.base) }),
            head: s.branch,
            draft: a.draft === true,
          },
          await repos.root(id),
        );
      },
      preview: async (id, a) => {
        const s = await repos.status(id);
        return {
          repository: repos.nameOf(id),
          from: s.branch,
          into: str(a.base) || 'the default branch',
          title: str(a.title),
          draft: a.draft === true,
          body: str(a.body).slice(0, 1_500),
        };
      },
    },
    {
      name: 'gh_pr_merge',
      description: 'Merge a pull request on GitHub.',
      properties: {
        number: { type: 'integer' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['number'],
      action: 'github.pr_merge',
      tier: 'critical',
      resource: (repo, a) => `repo:${repo}/pr/${num(a.number)}`,
      run: async (id, a) =>
        github.mergePr(await slugOf(id), num(a.number), (str(a.method) || 'squash') as 'squash'),
    },
    {
      name: 'gh_runs_list',
      description: 'Recent GitHub Actions runs, optionally for one branch.',
      properties: { branch: { type: 'string' } },
      action: 'github.runs_list',
      tier: 'auto',
      readOnly: true,
      run: async (id, a) =>
        github.runs(await slugOf(id), { ...(str(a.branch) && { branch: str(a.branch) }) }),
    },
    {
      name: 'gh_run_logs',
      description: 'The log of a failed GitHub Actions run (the failing steps).',
      properties: { run_id: { type: 'integer' } },
      required: ['run_id'],
      action: 'github.run_logs',
      tier: 'auto',
      readOnly: true,
      run: async (id, a) => github.runLog(await slugOf(id), num(a.run_id)),
    },
    {
      name: 'gh_run_rerun',
      description: 'Run a GitHub Actions run again, all jobs or only the failed ones.',
      properties: { run_id: { type: 'integer' }, failed_only: { type: 'boolean' } },
      required: ['run_id'],
      action: 'github.run_rerun',
      tier: 'gated',
      run: async (id, a) => {
        await github.rerun(await slugOf(id), num(a.run_id), a.failed_only !== false);
        return { started: true };
      },
    },
    {
      name: 'gh_workflow_dispatch',
      description: 'Start a workflow that has a manual trigger (workflow_dispatch).',
      properties: {
        workflow: { type: 'string', description: 'The workflow file name, like deploy.yml.' },
        ref: { type: 'string', description: 'Branch or tag to run on; the current branch if left out.' },
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['workflow'],
      action: 'github.workflow_dispatch',
      tier: 'critical',
      resource: (repo, a) => `repo:${repo}/workflow/${str(a.workflow)}`,
      run: async (id, a) => {
        const s = await repos.status(id);
        const ref = str(a.ref) || s.branch;
        if (!ref) throw new Error('Name a branch to run the workflow on.');
        await github.dispatch(
          await slugOf(id),
          str(a.workflow),
          ref,
          (a.inputs as Record<string, string>) ?? {},
        );
        return { started: true, ref };
      },
    },
  ];

  return defs.map((d) => {
    const argsOf = (args: unknown) =>
      args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    const resolveId = async (args: unknown, scope?: ToolScope) =>
      (await repos.resolve(argsOf(args).repo, scope)).id;
    const spec: ToolSpec = {
      name: d.name,
      description: d.description,
      inputSchema: {
        type: 'object',
        properties: { repo: repoArg, ...d.properties },
        ...(d.required && { required: d.required }),
        additionalProperties: false,
      },
      action: d.action,
      tier: d.tier,
      destructive: d.destructive ?? false,
      ...(d.readOnly && { readOnly: true }),
      source: { kind: 'builtin' },
      resource: (args, scope) => {
        const name = repos.resourceName(argsOf(args).repo, scope);
        return d.resource ? d.resource(name, argsOf(args)) : `repo:${name}`;
      },
      execute: async (args, ctx) =>
        d.run(await resolveId(args, ctx.scope), argsOf(args), { signal: ctx.signal }),
      ...(d.preview && {
        preview: async (args: unknown, scope?: ToolScope) =>
          (d.preview as NonNullable<Def['preview']>)(await resolveId(args, scope), argsOf(args)),
      }),
    };
    return spec;
  });
}
