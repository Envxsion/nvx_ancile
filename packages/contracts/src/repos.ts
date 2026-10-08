/**
 * ------------------------------------------------------------------
 *  Title    |  Repositories
 *  Ref      |  DESIGN.md §17 · docs/repos.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Git folders NVX Ancile knows about, what state they are
 *           |  in (branch, ahead and behind, changed files), and the
 *           |  GitHub side of them (pull requests, Actions runs).
 *  How      |  Core reads git itself; GitHub through the gh CLI when it
 *           |  is signed in, otherwise a token kept in the secret store.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const RepoFile = z.object({
  path: z.string(),
  /** Index (staged) and work tree states as git prints them: M, A, D, R, ?, U or '.' */
  staged: z.string(),
  unstaged: z.string(),
  /** For a rename, where it came from. */
  from: z.string().optional(),
});
export type RepoFile = z.infer<typeof RepoFile>;

export const GitHubRemote = z.object({ owner: z.string(), repo: z.string() });

export const RepoStatus = z.object({
  /** null while detached, with `head` set to the commit. */
  branch: z.string().nullable(),
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  files: z.array(RepoFile),
  /** Merge, rebase, cherry-pick or revert in progress. */
  operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']).nullable(),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  github: GitHubRemote.nullable(),
  checked_at: z.string(),
});
export type RepoStatus = z.infer<typeof RepoStatus>;

export const RepoInfo = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute path of the repository root on this machine. */
  root: z.string(),
  created_at: z.string(),
  /** Last known state; null when the folder is no longer a repository. */
  status: RepoStatus.nullable(),
  error: z.string().nullable(),
});
export type RepoInfo = z.infer<typeof RepoInfo>;

export const AddRepoRequest = z
  .object({ path: z.string().min(1).max(1024), name: z.string().min(1).max(80).optional() })
  .strict();

export const LinkRepoRequest = z
  .object({
    scope: z.enum(['notebook', 'thread']),
    scope_ref: z.string().min(1),
    /** null removes the link. */
    repo_id: z.string().nullable(),
  })
  .strict();

export const CommitInfo = z.object({
  sha: z.string(),
  short: z.string(),
  subject: z.string(),
  author: z.string(),
  at: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfo>;

export const BranchInfo = z.object({
  name: z.string(),
  current: z.boolean(),
  upstream: z.string().nullable(),
  remote: z.boolean(),
});
export type BranchInfo = z.infer<typeof BranchInfo>;

export const RepoActionRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('stage'), paths: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('unstage'), paths: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('commit'), message: z.string().min(1).max(10_000), all: z.boolean().optional() }),
  z.object({ op: z.literal('switch'), branch: z.string().min(1), create: z.boolean().optional() }),
  z.object({ op: z.literal('pull') }),
  z.object({ op: z.literal('push'), set_upstream: z.boolean().optional() }),
  z.object({ op: z.literal('fetch') }),
  z.object({ op: z.literal('stash'), message: z.string().max(200).optional() }),
  z.object({ op: z.literal('stash_pop') }),
]);
export type RepoActionRequest = z.infer<typeof RepoActionRequest>;

export const PullRequestInfo = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  head: z.string(),
  base: z.string(),
  author: z.string(),
  url: z.string(),
  updated_at: z.string(),
  checks: z.enum(['passing', 'failing', 'pending', 'none']).optional(),
});
export type PullRequestInfo = z.infer<typeof PullRequestInfo>;

export const WorkflowRunInfo = z.object({
  id: z.number().int(),
  name: z.string(),
  branch: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string(),
  created_at: z.string(),
});
export type WorkflowRunInfo = z.infer<typeof WorkflowRunInfo>;

export const GitHubAccess = z.object({
  /** How GitHub is reached: the gh CLI's own sign-in, a token you saved, or not at all. */
  via: z.enum(['gh', 'token', 'none']),
  login: z.string().nullable(),
  detail: z.string().nullable(),
});
export type GitHubAccess = z.infer<typeof GitHubAccess>;

export const SaveGitHubTokenRequest = z.object({ token: z.string().min(10).max(400).nullable() }).strict();

export const CreatePullRequest = z
  .object({
    title: z.string().min(1).max(256),
    body: z.string().max(60_000).optional(),
    base: z.string().min(1).optional(),
    draft: z.boolean().optional(),
  })
  .strict();

export const GitHubMcpPresetRequest = z
  .object({
    /** A token for the server; omit to use the gh CLI's sign-in or the saved token. */
    token: z.string().min(10).max(400).optional(),
    read_only: z.boolean().optional(),
  })
  .strict();
