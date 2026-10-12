/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's slash commands, in NVX Ancile
 *  Ref      |  docs/claude-code.md (Commands) · contracts ClaudeCodeCommand
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The composer's "/" list for a Claude Code thread: what
 *           |  Claude Code itself offers in that folder (built-ins,
 *           |  skills, plugins, MCP prompts, custom commands), with the
 *           |  built-ins that NVX Ancile does itself pointed at its own
 *           |  screens, so nothing clashes.
 *  How      |  Claude Code's list comes from a session opened without a
 *           |  prompt and without a transcript (claudecode/live.ts);
 *           |  it spends no tokens. This file merges it with a curated
 *           |  table: /mcp opens MCP servers, /model and /effort change
 *           |  the live session, /branch branches the thread, and the
 *           |  commands that only work in a terminal say where to do
 *           |  them. Anything Claude Code lists that the table does not
 *           |  know is sent to Claude Code as typed.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeCommand } from '@nvx/contracts';

type Action = NonNullable<ClaudeCodeCommand['ancile_action']>;

interface Curated {
  action: Action | null;
  description: string;
  argument_hint?: string | null;
  arguments?: { value: string; description: string | null }[];
  /** Offer it even when Claude Code does not list it (NVX Ancile does it itself). */
  always?: boolean;
}

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

const ancile = (action: Action, description: string, extra: Partial<Curated> = {}): Curated => ({
  action,
  description,
  always: true,
  ...extra,
});
const terminalOnly = (description: string): Curated => ({ action: 'unsupported', description });

/** What NVX Ancile does with Claude Code's built-in commands. */
export const CURATED: Record<string, Curated> = {
  mcp: ancile('open_mcp', 'Manage MCP servers in NVX Ancile', {
    argument_hint: '[reconnect|enable|disable] [server]',
  }),
  permissions: ancile('open_permissions', 'See and change what Claude Code may do, in Admin → Permissions'),
  'allowed-tools': ancile(
    'open_permissions',
    'See and change what Claude Code may do, in Admin → Permissions',
    {
      always: false,
    },
  ),
  cost: ancile('open_usage', 'Tokens and estimated cost of this session', { always: false }),
  usage: ancile('open_usage', 'Tokens, estimated cost and plan limits'),
  stats: ancile('open_usage', 'Tokens, estimated cost and plan limits', { always: false }),
  context: ancile('open_usage', "How full Claude Code's context is"),
  branch: ancile('branch', 'Branch the thread here (Claude Code forks the session)'),
  fork: ancile('branch', 'Branch the thread here (Claude Code forks the session)', { always: false }),
  rewind: ancile('rewind', 'Go back to an earlier message and branch from it'),
  checkpoint: ancile('rewind', 'Go back to an earlier message and branch from it', { always: false }),
  clear: ancile('new_thread', 'Start a new thread in this folder'),
  new: ancile('new_thread', 'Start a new thread in this folder', { always: false }),
  reset: ancile('new_thread', 'Start a new thread in this folder', { always: false }),
  resume: ancile('open_threads', "Open another of this folder's sessions"),
  continue: ancile('open_threads', "Open another of this folder's sessions", { always: false }),
  login: ancile('sign_in', "Sign in with Claude Code's own sign-in"),
  memory: ancile('open_memory', "Open NVX Ancile's memory (Claude Code's CLAUDE.md files still apply)"),
  config: ancile('open_settings', 'Open Settings → Claude Code'),
  settings: ancile('open_settings', 'Open Settings → Claude Code', { always: false }),
  model: ancile('set_model', 'Choose the model for this session', { argument_hint: '[model]' }),
  effort: ancile('set_effort', 'Choose how hard Claude thinks', {
    argument_hint: EFFORT.join('|'),
    arguments: EFFORT.map((value) => ({ value, description: null })),
  }),
  compact: {
    action: null,
    description: 'Compact the conversation, keeping a summary',
    argument_hint: '[instructions]',
  },
  logout: terminalOnly('Sign out in Settings → Claude Code'),
  theme: terminalOnly('Works in a terminal only. NVX Ancile follows its own theme in Settings.'),
  vim: terminalOnly('Works in a terminal only: it changes how the terminal prompt edits text.'),
  'terminal-setup': terminalOnly('Works in a terminal only: run it in the terminal you use Claude Code in.'),
  doctor: terminalOnly('Run `claude doctor` in a terminal to check the install.'),
  exit: terminalOnly('Nothing to exit here: close the thread or press Stop.'),
  quit: terminalOnly('Nothing to quit here: close the thread or press Stop.'),
  ide: terminalOnly('Works in a terminal only: it connects the terminal to an editor.'),
  keybindings: terminalOnly("Works in a terminal only: it changes the terminal's keys."),
  statusline: terminalOnly("Works in a terminal only: it sets the terminal's status line."),
  upgrade: terminalOnly('Run `claude update` in a terminal.'),
  'install-github-app': terminalOnly('Run it in Claude Code in a terminal: it opens a browser flow there.'),
  'migrate-installer': terminalOnly('Run it in Claude Code in a terminal.'),
  hooks: terminalOnly('Edit hooks in Claude Code in a terminal, or in its settings.json.'),
  'output-style': terminalOnly('Works in a terminal only.'),
  'privacy-settings': terminalOnly('Change it in Claude Code in a terminal.'),
};

export interface CliCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

function sourceOf(c: CliCommand): ClaudeCodeCommand['source'] {
  if (c.builtin) return 'builtin';
  if (c.name.startsWith('mcp__') || /\(MCP\)/.test(c.description)) return 'mcp';
  if (c.name.includes(':')) return 'plugin';
  return 'skill';
}

/**
 * Claude Code's list for a session, merged with the curated table.
 * `models`: values for /model; `mcp`: server names for /mcp.
 */
export function mergeCommands(
  cli: CliCommand[],
  extra: { models?: { value: string; displayName?: string }[]; mcp?: string[] } = {},
): ClaudeCodeCommand[] {
  const out = new Map<string, ClaudeCodeCommand>();
  const make = (name: string, c: CliCommand | null): ClaudeCodeCommand => {
    const cur = CURATED[name];
    // A skill or plugin with a built-in's name is Claude Code's to run.
    const useCurated = !!cur && (!c || c.builtin === true);
    const hint = useCurated && cur?.argument_hint !== undefined ? cur.argument_hint : c?.argumentHint || null;
    let args = useCurated ? (cur?.arguments ?? []) : [];
    if (useCurated && name === 'model' && extra.models?.length)
      args = extra.models.map((m) => ({ value: m.value, description: m.displayName ?? null }));
    if (useCurated && name === 'mcp')
      args = [
        { value: 'reconnect', description: 'Reconnect a server' },
        { value: 'enable', description: 'Turn a server on' },
        { value: 'disable', description: 'Turn a server off' },
        ...(extra.mcp ?? []).map((s) => ({ value: s, description: 'MCP server' })),
      ];
    return {
      name,
      description: useCurated && cur ? cur.description : (c?.description ?? ''),
      argument_hint: hint || null,
      arguments: args,
      source: c ? sourceOf(c) : 'ancile',
      handled_by: useCurated && cur?.action ? 'ancile' : 'claude',
      ancile_action: useCurated ? (cur?.action ?? null) : null,
    };
  };
  for (const c of cli) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    const name = c.name.replace(/^\//, '');
    // A marked built-in wins over a user command of the same name.
    if (out.has(name) && !c.builtin) continue;
    out.set(name, make(name, c));
  }
  for (const [name, cur] of Object.entries(CURATED))
    if (cur.always && !out.has(name)) out.set(name, make(name, null));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- The catalogue: never makes the composer wait -------------------------- */

/** How long Claude Code's own list is trusted before it is read again. */
export const COMMANDS_TTL_MS = 10 * 60_000;

/** Claude Code's well-known built-ins, for the list shown before its own arrives. */
const KNOWN_BUILTINS: CliCommand[] = [
  ...Object.keys(CURATED).map((name) => ({ name, description: '', builtin: true })),
  { name: 'init', description: 'Write a CLAUDE.md that describes this folder', builtin: true },
  { name: 'review', description: 'Review a pull request', builtin: true },
];

/** The list NVX Ancile can offer at once: the curated table and Claude Code's known built-ins. */
export function builtinCommands(): ClaudeCodeCommand[] {
  return mergeCommands(KNOWN_BUILTINS);
}

export interface CommandList {
  items: ClaudeCodeCommand[];
  /** True while Claude Code's own list (skills, plugins, MCP prompts) is still being read. */
  partial: boolean;
}

/**
 * Claude Code's "/" list per Claude Code version and folder. Reading it opens
 * a session (seconds), so `read` answers at once: the cached list, or the
 * built-ins marked partial while the real list is read in the background.
 * One read per key at a time; a failed read leaves the built-ins and is
 * tried again on the next ask.
 */
export class CommandCatalogue {
  private readonly cache = new Map<string, { at: number; items: ClaudeCodeCommand[] }>();
  private readonly inflight = new Map<string, Promise<ClaudeCodeCommand[] | null>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onError: (key: string, err: unknown) => void = () => {},
  ) {}

  read(key: string, load: () => Promise<ClaudeCodeCommand[]>): CommandList {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < COMMANDS_TTL_MS) return { items: hit.items, partial: false };
    void this.warm(key, load);
    // A stale list is still better than the built-ins while it refreshes.
    return hit ? { items: hit.items, partial: true } : { items: builtinCommands(), partial: true };
  }

  /** Read the list for `key` unless it is fresh or already being read. Never throws. */
  warm(key: string, load: () => Promise<ClaudeCodeCommand[]>): Promise<ClaudeCodeCommand[] | null> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < COMMANDS_TTL_MS) return Promise.resolve(hit.items);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = load()
      .then((items) => {
        this.cache.set(key, { at: this.now(), items });
        return items;
      })
      .catch((err: unknown) => {
        this.onError(key, err);
        return null;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
