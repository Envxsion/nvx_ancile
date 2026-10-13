/**
 * ------------------------------------------------------------------
 *  Title    |  Tool steps in words
 *  Ref      |  docs/events.md (tool.call title)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One place that says what a tool call is doing, in a
 *           |  person's words, whatever engine made it: Claude Code,
 *           |  an OpenAI-compatible model, Ollama, OpenRouter, a RunPod
 *           |  node, the lab or Core's own tool runner.
 *  How      |  toolKind() maps a tool name to a kind. stepDescription()
 *           |  returns the description the call carries itself (Bash's
 *           |  and Task's `description`, the plan item in progress).
 *           |  stepTitle() is that description, or a phrase made from
 *           |  the input ("Reading src/app.ts", "Searching the web for
 *           |  'x'"). stepCommand() is the raw command or pattern shown
 *           |  under a description as a muted second line.
 *  Note     |  Pure functions over the call's name and arguments: Core
 *           |  puts stepTitle() on every tool.call event, the Cockpit
 *           |  calls the same functions for stored messages.
 * ------------------------------------------------------------------
 */

export type ToolKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'multiedit'
  | 'notebook'
  | 'delete'
  | 'patch'
  | 'shell'
  | 'grep'
  | 'glob'
  | 'list'
  | 'fetch'
  | 'search'
  | 'agent'
  | 'todo'
  | 'skill'
  | 'toolsearch'
  | 'monitor'
  | 'mcp'
  | 'python'
  | 'image'
  | 'other';

const KINDS: Record<string, ToolKind> = {
  read: 'read',
  fs_read: 'read',
  read_file: 'read',
  write: 'write',
  fs_write: 'write',
  write_file: 'write',
  edit: 'edit',
  multiedit: 'multiedit',
  notebookedit: 'notebook',
  fs_delete: 'delete',
  apply_patch: 'patch',
  bash: 'shell',
  powershell: 'shell',
  shell: 'shell',
  grep: 'grep',
  glob: 'glob',
  ls: 'list',
  list: 'list',
  fs_list: 'list',
  webfetch: 'fetch',
  web_fetch: 'fetch',
  fetch_url: 'fetch',
  websearch: 'search',
  web_search: 'search',
  agent: 'agent',
  task: 'agent',
  todowrite: 'todo',
  skill: 'skill',
  toolsearch: 'toolsearch',
  monitor: 'monitor',
  python_run: 'python',
  image_generate: 'image',
};

export function toolKind(tool: string): ToolKind {
  if (tool.startsWith('mcp__')) return 'mcp';
  return KINDS[tool.toLowerCase()] ?? 'other';
}

type Args = Record<string, unknown>;
const argsOf = (v: unknown): Args => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A path short enough for one line: its last three segments. */
export function shortPath(raw: string): string {
  const p = raw.replaceAll('\\', '/');
  const segs = p.split('/').filter(Boolean);
  return segs.length > 3 ? `…/${segs.slice(-3).join('/')}` : p;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const pathOf = (a: Args): string | null =>
  str(a.file_path) ?? str(a.notebook_path) ?? str(a.path) ?? str(a.filePath);

/** The plan item being worked on, from a TodoWrite call. */
function todoNow(a: Args): string | null {
  const todos = Array.isArray(a.todos) ? (a.todos as unknown[]).map(argsOf) : [];
  const now = todos.find((t) => t.status === 'in_progress');
  return now ? (str(now.activeForm) ?? str(now.content)) : null;
}

/** The description a call carries itself, if it has one. */
export function stepDescription(tool: string, args: unknown): string | null {
  const a = argsOf(args);
  switch (toolKind(tool)) {
    case 'shell':
    case 'agent':
    case 'monitor':
      return str(a.description);
    case 'todo':
      return todoNow(a);
    case 'mcp':
    case 'other':
      return str(a.description);
    default:
      return null;
  }
}

/** The raw command, pattern or query behind a step, for a muted second line. */
export function stepCommand(tool: string, args: unknown): string | null {
  const a = argsOf(args);
  switch (toolKind(tool)) {
    case 'shell':
    case 'monitor': {
      const c = str(a.command) ?? str(a.cmd);
      return c ? firstLine(c, 200) : null;
    }
    case 'python': {
      const c = str(a.code);
      return c ? firstLine(c, 200) : null;
    }
    case 'grep':
    case 'glob':
      return str(a.pattern);
    case 'agent':
      return str(a.subagent_type);
    default:
      return null;
  }
}

/** What a step is doing, in present tense: its own description, or one made from its input. */
export function stepTitle(tool: string, args: unknown): string {
  const own = stepDescription(tool, args);
  if (own) return own;
  const a = argsOf(args);
  const path = pathOf(a);
  const short = path ? shortPath(path) : null;
  switch (toolKind(tool)) {
    case 'read':
      return `Reading ${short ?? 'a file'}`;
    case 'write':
      return `Writing ${short ?? 'a file'}`;
    case 'edit':
    case 'multiedit':
    case 'notebook':
    case 'patch':
      return `Editing ${short ?? 'files'}`;
    case 'delete':
      return `Deleting ${short ?? 'a file'}`;
    case 'list':
      return `Listing ${short ?? 'the folder'}`;
    case 'shell': {
      const c = str(a.command) ?? str(a.cmd);
      return c ? `Running ${firstLine(c, 80)}` : 'Running a command';
    }
    case 'grep':
    case 'glob': {
      const p = str(a.pattern) ?? str(a.query);
      return p ? `Searching for '${firstLine(p, 80)}'` : 'Searching files';
    }
    case 'fetch': {
      const u = str(a.url);
      return u ? `Fetching ${hostOf(u)}` : 'Fetching a page';
    }
    case 'search': {
      const q = str(a.query);
      return q ? `Searching the web for '${firstLine(q, 80)}'` : 'Searching the web';
    }
    case 'agent':
      return 'Asking a subagent';
    case 'todo':
      return 'Updating the plan';
    case 'skill': {
      const n = str(a.skill) ?? str(a.command) ?? str(a.name);
      return n ? `Using the ${n} skill` : 'Using a skill';
    }
    case 'toolsearch':
      return 'Looking up tools';
    case 'monitor':
      return 'Watching a process';
    case 'python':
      return 'Running Python';
    case 'image': {
      const p = str(a.prompt);
      return p ? `Making an image of '${firstLine(p, 60)}'` : 'Making an image';
    }
    case 'mcp': {
      const [, server, ...rest] = tool.split('__');
      return `Using ${rest.join('__') || tool}${server ? ` from ${server}` : ''}`;
    }
    default:
      return `Using ${tool}`;
  }
}

/** One search hit, for a list of titles and links. */
export interface WebHit {
  title: string | null;
  url: string;
}

/**
 * The links a web search returned, whatever its shape: Claude Code's text
 * ("Links: [{"title":…,"url":…}]"), the API's web_search_tool_result
 * blocks, a JSON array of {title,url}, or bare URLs.
 */
export function webHits(result: unknown, max = 20): WebHit[] {
  const seen = new Set<string>();
  const out: WebHit[] = [];
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: typeof title === 'string' && title.trim() ? title.trim() : null });
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || out.length >= max) return;
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') {
      const o = v as Args;
      if (typeof o.url === 'string') add(o.url, o.title);
      for (const k of ['content', 'results', 'links', 'text'] as const) if (k in o) walk(o[k], depth + 1);
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (/^[[{]/.test(t))
        try {
          walk(JSON.parse(t), depth + 1);
          return;
        } catch {
          /* not JSON: read it as text */
        }
      for (const m of t.matchAll(/\{"title":"((?:[^"\\]|\\.)*)","url":"((?:[^"\\]|\\.)*)"\}/g)) {
        let title = m[1] as string;
        try {
          title = JSON.parse(`"${title}"`) as string;
        } catch {
          /* keep it as written */
        }
        add(m[2], title);
      }
      if (!out.length) for (const m of t.matchAll(/https?:\/\/[^\s"'<>)\]\\]+/g)) add(m[0], null);
    }
  };
  walk(result, 0);
  return out.slice(0, max);
}
