/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code errors
 *  Ref      |  docs/errors.md (Claude Code) · docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every error the Claude Code feature can show, with a
 *           |  plain title and a hint that says what to do.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';

export const ccErrors = {
  notInstalled: () =>
    new AncileError({
      code: 'claude_code.not_installed',
      title: 'Claude Code is not installed on this computer',
      hint: 'Press Install in Settings → Claude Code, or install it from claude.ai/install and press Check again.',
      status: 409,
      errorClass: 'permanent',
    }),
  versionOld: (version: string, min: string) =>
    new AncileError({
      code: 'claude_code.version_old',
      title: `Claude Code ${version} is older than NVX Ancile supports`,
      hint: `Run \`claude update\` in a terminal (NVX Ancile needs ${min} or later), then press Check again.`,
      status: 409,
      errorClass: 'permanent',
    }),
  signedOut: () =>
    new AncileError({
      code: 'claude_code.signed_out',
      title: 'Claude Code is not signed in',
      hint: "Press Sign in to open Claude Code's own sign-in, or run `claude auth login` in a terminal.",
      status: 409,
      errorClass: 'permanent',
    }),
  sdkUnavailable: (why: string) =>
    new AncileError({
      code: 'claude_code.sdk_unavailable',
      title: 'NVX Ancile cannot read Claude Code sessions yet',
      hint: "It needs Anthropic's Agent SDK, fetched from npm the first time. Check this computer can reach registry.npmjs.org, then press Check again.",
      status: 503,
      errorClass: 'transient',
      detail: why.slice(0, 500),
    }),
  installFailed: (why: string) =>
    new AncileError({
      code: 'claude_code.install_failed',
      title: 'Claude Code could not be installed',
      hint: 'Install it yourself from claude.ai/install (it needs no admin rights), then press Check again.',
      status: 502,
      errorClass: 'permanent',
      detail: why.slice(0, 800),
    }),
  signInUnavailable: () =>
    new AncileError({
      code: 'claude_code.sign_in_unavailable',
      title: "Claude Code's sign-in cannot open from here",
      hint: 'Run `claude auth login` in a terminal on this computer, then press Check again.',
      status: 409,
      errorClass: 'permanent',
    }),
  sessionNotFound: (id: string) =>
    new AncileError({
      code: 'claude_code.session_not_found',
      title: 'That Claude Code session is not on this computer',
      hint: 'It may have been deleted or moved. Refresh the list of sessions.',
      status: 404,
      errorClass: 'permanent',
      detail: `session ${id}`,
    }),
  notBound: () =>
    new AncileError({
      code: 'claude_code.not_bound',
      title: 'This thread did not come from Claude Code',
      hint: 'Only threads brought in from Claude Code can be synced. Bring a session in from Claude Code first.',
      status: 409,
      errorClass: 'permanent',
    }),
  cliFailed: (what: string, said: string) =>
    new AncileError({
      code: 'claude_code.cli_failed',
      title: `Claude Code could not ${what}`,
      hint: 'Run the same command in a terminal to see why, then try again.',
      status: 502,
      errorClass: 'transient',
      detail: said.slice(0, 500),
    }),
};
