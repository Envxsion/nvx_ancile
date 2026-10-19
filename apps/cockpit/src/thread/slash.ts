/**
 * ------------------------------------------------------------------
 *  Title    |  Slash commands of the composer
 *  Ref      |  ROADMAP.md CH1, CH5 · DESIGN.md §8
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The list of "/" commands a model thread offers, which of
 *           |  them show where you are, and how typed text is read: a
 *           |  command, a command that does not exist, text that only
 *           |  starts with a slash, or a "//" escape.
 *  How      |  Pure. The menu, the ghost text (a command's argument
 *           |  hint after the command) and the send path all read this
 *           |  one table. What a command does is in slashActions.ts,
 *           |  loaded the first time one runs, so an idle composer
 *           |  carries none of it.
 *  Note     |  A command that is not here is never sent as a message
 *           |  by accident: the composer says so and offers "//". The
 *           |  offline test model is the exception, because it reads
 *           |  directives such as /say itself. /say and /slow are for
 *           |  the dev build only (ROADMAP TO2).
 * ------------------------------------------------------------------
 */

export type SlashId =
  | 'models'
  | 'sources'
  | 'shortcuts'
  | 'beam'
  | 'memory'
  | 'compact'
  | 'branch'
  | 'factcheck'
  | 'export'
  | 'instructions'
  | 'find'
  | 'init'
  | 'effort'
  /** Sent as text: the model or the send path reads it (/image, the test directives). */
  | 'text';

export interface Slash {
  cmd: string;
  hint: string;
  /** Ghost text shown after the command, and in the menu. */
  arg?: string;
  id: SlashId;
  /** Picking it from the menu runs it, even though it takes an optional argument. */
  runOnPick?: boolean;
  /** Needs a real thread (not Home) to act on. */
  thread?: boolean;
  /** Needs a notebook. */
  notebook?: boolean;
  /** Only where the model takes a reasoning effort. */
  effort?: boolean;
}

export const SLASH: Slash[] = [
  { cmd: '/model', hint: 'Choose the model for this thread', arg: '[name]', id: 'models', runOnPick: true },
  {
    cmd: '/effort',
    hint: 'Choose how hard the model thinks',
    arg: 'low | medium | high | auto',
    id: 'effort',
    effort: true,
  },
  { cmd: '/sources', hint: "Open this notebook's sources", id: 'sources', notebook: true },
  { cmd: '/keys', hint: 'Show keyboard shortcuts', id: 'shortcuts' },
  {
    cmd: '/beam',
    hint: 'Ask several models at once, then fuse their answers',
    arg: '[question]',
    id: 'beam',
    runOnPick: true,
  },
  { cmd: '/image', hint: 'Make an image from a description', arg: 'a description', id: 'text' },
  {
    cmd: '/memory',
    hint: 'Open the memory inbox, or remember something',
    arg: '[something to remember]',
    id: 'memory',
  },
  {
    cmd: '/compact',
    hint: 'Summarise the older part of this thread to free up space',
    id: 'compact',
    thread: true,
  },
  {
    cmd: '/branch',
    hint: 'Branch from the last message and keep both paths',
    arg: '[name]',
    id: 'branch',
    runOnPick: true,
    thread: true,
  },
  {
    cmd: '/factcheck',
    hint: 'Check every claim in the last answer',
    arg: '[web]',
    id: 'factcheck',
    runOnPick: true,
    thread: true,
  },
  { cmd: '/export', hint: 'Save this thread as a markdown file', id: 'export', thread: true },
  {
    cmd: '/instructions',
    hint: "Edit this thread's instructions and persona",
    id: 'instructions',
    thread: true,
  },
  { cmd: '/find', hint: 'Search every thread for words', arg: 'words to find', id: 'find' },
  { cmd: '/init', hint: "Draft an AGENTS.md for this thread's repository", id: 'init', thread: true },
];

/** What the offline test model obeys; listed only while it is the model. */
export const TEST_DIRECTIVES: Slash[] = [
  { cmd: '/say', hint: 'Answer with exactly the text that follows', arg: 'text', id: 'text' },
  { cmd: '/slow', hint: 'Write one word every 150 ms, so you can watch it stream', arg: 'text', id: 'text' },
  { cmd: '/fail 500', hint: 'Fail on purpose and watch NVX Ancile switch to the backup model', id: 'text' },
  { cmd: '/fail refusal', hint: 'Decline on purpose; NVX Ancile asks the backup model instead', id: 'text' },
  { cmd: '/fail auth', hint: 'Fail as if the API key were wrong', id: 'text' },
  {
    cmd: '/tool fs_write',
    hint: 'Write a file, e.g. {"path":"note.md","content":"hi"}. Asks first',
    id: 'text',
  },
  { cmd: '/tool fs_list', hint: 'List the workspace, e.g. {"path":"/workspace"}', id: 'text' },
];

/** Hidden outside the dev build (ROADMAP TO2); /fail and /tool stay with the offline model. */
const DEV_ONLY = new Set(['/say', '/slow']);

export interface SlashEnv {
  /** The thread is in a notebook. */
  notebook: boolean;
  /** A real thread exists (Home composes for one that does not). */
  thread: boolean;
  /** The offline test model is the one answering. */
  offline: boolean;
  /** The dev build. */
  dev: boolean;
  /** The model takes a reasoning effort. */
  effort: boolean;
}

/** The commands to offer here. */
export function slashFor(env: SlashEnv): Slash[] {
  const base = SLASH.filter(
    (s) =>
      (!s.notebook || env.notebook) && (!s.thread || env.thread) && (!s.effort || (env.effort && env.thread)),
  );
  if (!env.offline) return base;
  return [...base, ...TEST_DIRECTIVES.filter((s) => env.dev || !DEV_ONLY.has(s.cmd))];
}

export type Typed =
  | { kind: 'plain' }
  /** "//text" is sent as "/text". */
  | { kind: 'escaped'; text: string }
  | { kind: 'command'; slash: Slash; arg: string }
  | { kind: 'unknown'; name: string };

const NAME = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

/** How the text about to be sent reads: a command to run, one that does not exist, or a message. */
export function readTyped(value: string, list: readonly Slash[], env: Pick<SlashEnv, 'offline'>): Typed {
  if (value.startsWith('//')) return { kind: 'escaped', text: value.slice(1) };
  const m = NAME.exec(value);
  if (!m) return { kind: 'plain' };
  const name = (m[1] ?? '').toLowerCase();
  const arg = (m[2] ?? '').trim();
  const hit = list.find((s) => s.cmd.slice(1).split(' ')[0] === name);
  if (hit) return hit.id === 'text' ? { kind: 'plain' } : { kind: 'command', slash: hit, arg };
  // The offline test model reads its own directives; anything else with a slash is not a message.
  if (env.offline) return { kind: 'plain' };
  return { kind: 'unknown', name };
}

/** The ghost text to show after `text`: the command's argument hint, once it is typed in full. */
export function ghostFor(text: string, list: readonly Slash[]): string | null {
  const m = /^(\/[a-z][a-z0-9-]*)( ?)$/i.exec(text);
  if (!m) return null;
  const hit = list.find((s) => s.cmd === (m[1] ?? '').toLowerCase() && s.arg);
  return hit?.arg ? `${m[2] ? '' : ' '}${hit.arg}` : null;
}

/** A line that says what a command that does not exist can be. */
export function unknownWords(name: string, list: readonly Slash[]): { title: string; body: string } {
  const near = list.find((s) => s.cmd.slice(1).startsWith(name.slice(0, 2)) && s.id !== 'text');
  return {
    title: `There is no command called /${name}`,
    body: `${near ? `Did you mean ${near.cmd.split(' ')[0]}? ` : ''}Type / to see the commands. To send it as a message, start it with //.`,
  };
}
