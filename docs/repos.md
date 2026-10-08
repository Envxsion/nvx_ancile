# Repositories: git and GitHub

A notebook or a thread can work in a git repository on your computer. NVX Ancile then knows which branch you are on, what changed, and what is waiting to be pushed or pulled, and the assistant can read, commit, push and open pull requests, asking you first for anything that changes something.

## Link a repository

1. Open a thread or notebook, open the side panel (`]`), and choose the **Repo** tab. (Or press `Ctrl K` and pick **Link a repository**.)
2. Paste the path of any folder inside the repository and press **Add and link**. NVX Ancile finds the repository's root itself.
3. A repository you have added once is offered in every other thread and notebook: **Use in this thread** or **Use in this notebook**.

A thread's own link wins over its notebook's. **Unlink** at the top of the panel removes the link; the repository stays in your list.

## What you see

- **The status bar** shows the branch, commits to push (↑) and to pull (↓), and how many files changed (•). It follows you: switch branch in a terminal or your editor and it changes within a few seconds, with a notice.
- **The Repo tab**:
  - the branch, with a picker to switch or create one
  - **Fetch**, **Pull** (fast-forward only, never a surprise merge commit) and **Push** (or **Publish branch** the first time)
  - every changed file: tick to stage, click the name to see the diff
  - a commit box: **Draft a message** writes a first draft from the staged files, in the style of your recent commits (`feat:`, `fix(scope):` and so on when your history uses them); `Ctrl Enter` commits
  - recent commits
  - for a github.com remote: pull requests with their checks, **Open a pull request** from your branch, and Actions runs with the failing log and **Run failed jobs again**

Buttons in the panel are you acting, so they run at once. Your git sign-in stays with git: NVX Ancile never sees passwords or SSH keys.

## What the assistant can do

Ask in plain words: "what changed?", "commit the parser fix", "push it", "open a PR", "why did CI fail?". The assistant uses these tools, each through your permissions:

| Asks first? | Tools |
|---|---|
| Never (reading) | `git_status`, `git_diff`, `git_log`, `git_branches`, `gh_pr_list`, `gh_pr_view`, `gh_runs_list`, `gh_run_logs` |
| Once, then as you grant | `git_add`, `git_commit`, `git_switch`, `git_pull`, `git_stash`, `gh_pr_create`, `gh_run_rerun` |
| Every time | `git_push`, `gh_pr_merge`, `gh_workflow_dispatch`, `git_push_force_with_lease` |

The approval shows what will really happen, read from the repository: the files and message of a commit, the commits and the branch a push goes to, the branches of a pull request. There is no force push unless you ask for one, and even then it is `--force-with-lease` and asks every time. Grants can name one repository (`repo:my-app`, `repo:my-app/push`).

The same tools work in a flow's Tool node, so a flow can, for example, have a reviewer read `git_diff` before a writer drafts the commit message.

## Connect GitHub

Pull requests and Actions need GitHub access. Two ways:

- **The GitHub CLI (recommended).** Install `gh` and run `gh auth login` once. NVX Ancile uses that sign-in and never sees the token. For workflows and re-runs, `gh auth refresh -s repo,workflow`.
- **A token.** In the Repo tab's GitHub section, paste a fine-grained personal access token with access to the repository (Contents, Pull requests, Actions). It is kept encrypted and never shown again. Logs are fuller with gh: with a token you see which steps failed and a link to the run.

## The GitHub MCP server

For everything else GitHub offers (issues, code search, discussions, notifications), add the official GitHub MCP server in **Admin → Plugins → Add GitHub**. It runs with your gh sign-in or a token you paste, through the `github-mcp-server` binary if it is on your PATH, otherwise in Docker. It starts read-only; untick **Read-only tools** to let it change things. Its tools appear in the tool list and follow your grants like any other.

## When something goes wrong

Errors quote git and say what to do: sign in to the remote, pull before pushing, resolve conflicts, commit or stash first. The codes are in [errors](errors.md#repositories-and-github).
