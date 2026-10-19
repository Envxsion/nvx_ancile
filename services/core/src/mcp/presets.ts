/**
 * ------------------------------------------------------------------
 *  Title    |  MCP presets: the "Add server" catalogue
 *  Ref      |  ROADMAP MC2 · docs/plugins.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One-click servers people reach for first (Filesystem,
 *           |  Playwright, Linear, Sentry, Supabase and more), each with only the fields it
 *           |  needs, checked before anything is saved, and a
 *           |  connection test on the way in.
 *  How      |  A preset is data: a command or address, fixed arguments
 *           |  and fields that become arguments, environment variables
 *           |  or request headers. A field marked secret is stored
 *           |  encrypted under a name and never returned. Adding goes
 *           |  through McpService.create, so the name rules, the
 *           |  rug-pull guard and the tool registry apply as for any
 *           |  server. A server that needs Node (npx) or Python (uvx)
 *           |  says so in plain words when it is not installed.
 *  Note     |  Remote servers that only sign in with OAuth are not
 *           |  offered with a token field they do not accept; their
 *           |  presets take the access token the vendor documents.
 *           |  TODO(phase-5): OAuth sign-in for remote servers.
 *           |  Adding a server mid-thread reaches the assistant through
 *           |  the mcp_call bridge until the next prompt epoch
 *           |  (docs/prompt-caching.md); nothing here rewrites a
 *           |  request in flight.
 * ------------------------------------------------------------------
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  AncileError,
  type CreateMcpServerRequest,
  type McpPreset,
  type McpPresetField,
  type McpRuntime,
  type McpServerView,
} from '@nvx/contracts';
import { logFor } from '../obs/logger';
import type { McpService } from './service';

const log = logFor('mcp');

type Target = McpPresetField['target'];
interface Field extends McpPresetField {
  /** Put in front of a header's value ("Bearer "). */
  prefix?: string;
}

interface Def {
  id: string;
  name: string;
  description: string;
  transport: McpPreset['transport'];
  runtime: McpRuntime | null;
  command?: string;
  args?: string[];
  url?: string;
  fields: Field[];
  docs_url: string | null;
}

const field = (
  key: string,
  label: string,
  target: Target,
  o: Partial<Pick<Field, 'help' | 'placeholder' | 'required' | 'secret' | 'prefix'>> = {},
): Field => ({
  key,
  label,
  target,
  help: o.help ?? '',
  placeholder: o.placeholder ?? '',
  required: o.required ?? true,
  secret: o.secret ?? false,
  ...(o.prefix && { prefix: o.prefix }),
});
const npx = (pkg: string, ...rest: string[]) => ({
  runtime: 'node' as const,
  command: 'npx',
  args: ['-y', pkg, ...rest],
});
const uvx = (pkg: string, ...rest: string[]) => ({
  runtime: 'python' as const,
  command: 'uvx',
  args: [pkg, ...rest],
});

/**
 * The catalogue. Order is the order shown.
 * Removed 19 Oct 2026 for want of a maintained, officially sourced, token-based server:
 * Postgres (the reference server is archived with no security fixes; postgres-mcp is a
 * third-party project), Slack (archived; the vendor server is OAuth only), Notion (the npm
 * server is no longer supported; the remote one is OAuth only) and Vercel (OAuth only,
 * approved clients only). Add those by hand, or wait for TODO(phase-5) OAuth sign-in.
 */
export const MCP_PRESETS: Def[] = [
  {
    // Verified 19 Oct 2026 against https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md (npx -y @modelcontextprotocol/server-filesystem <dirs>).
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files in folders you choose, and nowhere else.',
    transport: 'stdio',
    ...npx('@modelcontextprotocol/server-filesystem'),
    fields: [
      field('folders', 'Folders it may use', 'args', {
        help: 'One folder per line. It cannot reach anything outside these.',
        placeholder: 'C:\\Users\\you\\Documents',
      }),
    ],
    docs_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/microsoft/playwright-mcp (npx @playwright/mcp@latest; the docs use @latest).
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a real browser: open pages, click, fill in forms and read what is there.',
    transport: 'stdio',
    ...npx('@playwright/mcp@latest'),
    fields: [],
    docs_url: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/modelcontextprotocol/servers/blob/main/src/fetch/README.md (uvx mcp-server-fetch).
    id: 'fetch',
    name: 'Fetch',
    description: 'Read a web page and turn it into text for the assistant.',
    transport: 'stdio',
    ...uvx('mcp-server-fetch'),
    fields: [],
    docs_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/modelcontextprotocol/servers/blob/main/src/git/README.md (uvx mcp-server-git --repository <path>).
    id: 'git',
    name: 'Git',
    description: 'Read the history, diffs and branches of a repository on this machine.',
    transport: 'stdio',
    ...uvx('mcp-server-git', '--repository'),
    fields: [
      field('repository', 'Repository folder', 'args', {
        help: 'The folder that holds the .git directory.',
        placeholder: 'C:\\Users\\you\\code\\project',
      }),
    ],
    docs_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    // Verified 19 Oct 2026 against https://linear.app/docs/mcp (Streamable HTTP at /mcp; /sse is legacy; API key as Bearer is supported).
    id: 'linear',
    name: 'Linear',
    description: 'Find, create and update Linear issues and projects.',
    transport: 'http',
    runtime: null,
    url: 'https://mcp.linear.app/mcp',
    fields: [
      field('Authorization', 'API key', 'header', {
        secret: true,
        prefix: 'Bearer ',
        help: 'A personal API key from Linear, under Settings, then Security and access.',
        placeholder: 'lin_api_…',
      }),
    ],
    docs_url: 'https://linear.app/docs/mcp',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/getsentry/sentry-mcp (npx @sentry/mcp-server@latest, env SENTRY_ACCESS_TOKEN).
    id: 'sentry',
    name: 'Sentry',
    description: 'Look into errors, releases and traces in Sentry.',
    transport: 'stdio',
    ...npx('@sentry/mcp-server@latest'),
    fields: [
      field('SENTRY_ACCESS_TOKEN', 'Access token', 'env', {
        secret: true,
        help: 'A user auth token with the project, event and organisation read scopes.',
        placeholder: 'sntryu_…',
      }),
    ],
    docs_url: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    // Verified 19 Oct 2026 against https://supabase.com/docs/guides/getting-started/mcp (hosted, read_only=true query, PAT as Bearer header).
    id: 'supabase',
    name: 'Supabase',
    description: 'Look at a Supabase project: tables, logs and settings. Starts read-only.',
    transport: 'http',
    runtime: null,
    url: 'https://mcp.supabase.com/mcp?read_only=true',
    fields: [
      field('Authorization', 'Access token', 'header', {
        secret: true,
        prefix: 'Bearer ',
        help: 'A personal access token from your Supabase account settings.',
        placeholder: 'sbp_…',
      }),
    ],
    docs_url: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/upstash/context7 (remote https://mcp.context7.com/mcp, Authorization: Bearer key; the key is optional).
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date documentation for libraries, on request.',
    transport: 'http',
    runtime: null,
    url: 'https://mcp.context7.com/mcp',
    fields: [
      field('Authorization', 'API key', 'header', {
        secret: true,
        required: false,
        prefix: 'Bearer ',
        help: 'Optional. A free key from context7.com/dashboard raises the rate limits.',
        placeholder: 'ctx7sk-…',
      }),
    ],
    docs_url: 'https://github.com/upstash/context7',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/brave/brave-search-mcp-server (Brave's own server; the modelcontextprotocol one is archived).
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web, news and local places with Brave.',
    transport: 'stdio',
    ...npx('@brave/brave-search-mcp-server', '--transport', 'stdio'),
    fields: [
      field('BRAVE_API_KEY', 'API key', 'env', {
        secret: true,
        help: 'From brave.com/search/api.',
        placeholder: 'BSA…',
      }),
    ],
    docs_url: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    // Verified 19 Oct 2026 against https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/README.md.
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    description: 'A scratchpad that lets the assistant work through a problem in steps.',
    transport: 'stdio',
    ...npx('@modelcontextprotocol/server-sequential-thinking'),
    fields: [],
    docs_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
];

/* ---- Is the runtime installed? --------------------------------------------------- */

/** Whether a program is on PATH. Injectable for tests. */
export type Which = (program: string) => Promise<boolean>;

export const findOnPath: Which = async (program) => {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs)
    for (const ext of exts)
      try {
        await access(join(dir, program + ext.toLowerCase()), constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
  return false;
};

const RUNTIME: Record<McpRuntime, { program: string; missing: string }> = {
  node: {
    program: 'npx',
    missing:
      'This server runs with Node.js, and npx was not found on this machine. Install Node.js from nodejs.org, then open this list again.',
  },
  python: {
    program: 'uvx',
    missing:
      'This server runs with uv, a Python tool, and uvx was not found on this machine. Install uv from docs.astral.sh/uv, then open this list again.',
  },
};

/* ---- Errors ------------------------------------------------------------------------ */

const unknownPreset = (id: string) =>
  new AncileError({
    code: 'mcp.preset_unknown',
    title: `There is no server preset called ${id}`,
    hint: 'Pick one from the Add server list, or add a server by hand.',
    status: 404,
    errorClass: 'permanent',
  });

const fieldProblem = (f: Field, why: string) =>
  new AncileError({
    code: 'mcp.preset_field',
    title: `${f.label}: ${why}`,
    hint: f.help || 'Fill it in and press Add again.',
    status: 400,
    errorClass: 'permanent',
    context: { field: f.key },
  });

const runtimeMissing = (name: string, why: string) =>
  new AncileError({
    code: 'mcp.runtime_missing',
    title: `${name} cannot start on this machine`,
    hint: why,
    status: 409,
    errorClass: 'permanent',
  });

/* ---- The service ------------------------------------------------------------------- */

export class McpPresets {
  constructor(
    private readonly servers: Pick<McpService, 'list' | 'create'>,
    private readonly which: Which = findOnPath,
  ) {}

  private async runtimeMissingFor(d: Def): Promise<string | null> {
    if (!d.runtime) return null;
    const r = RUNTIME[d.runtime];
    return (await this.which(r.program)) ? null : r.missing;
  }

  async list(): Promise<McpPreset[]> {
    const have = new Set((await this.servers.list()).map((s) => s.name));
    return Promise.all(
      MCP_PRESETS.map(async (d) => {
        const missing = await this.runtimeMissingFor(d);
        return {
          id: d.id,
          name: d.name,
          description: d.description,
          transport: d.transport,
          runtime: d.runtime,
          fields: d.fields.map(({ prefix: _p, ...f }) => f),
          docs_url: d.docs_url,
          available: missing === null,
          missing,
          added: have.has(d.id),
        };
      }),
    );
  }

  /** Turn a preset and what was typed into the request the server list takes. Throws in plain words. */
  build(d: Def, values: Record<string, string>, name: string): CreateMcpServerRequest {
    const args = [...(d.args ?? [])];
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const secrets: { key: string; value: string }[] = [];
    for (const f of d.fields) {
      const raw = (values[f.key] ?? '').trim();
      if (!raw) {
        if (f.required) throw fieldProblem(f, 'this is needed');
        continue;
      }
      if (/[\r\n]/.test(raw) && f.target !== 'args') throw fieldProblem(f, 'use a single line');
      const value = `${f.prefix ?? ''}${raw}`;
      if (f.target === 'args') {
        const parts = raw
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (!parts.length) throw fieldProblem(f, 'this is needed');
        args.push(...parts);
      } else if (f.secret) secrets.push({ key: f.key, value });
      else if (f.target === 'env') env[f.key] = value;
      else headers[f.key] = value;
    }
    if (d.transport === 'stdio')
      return { name, enabled: true, transport: 'stdio', command: d.command as string, args, env, secrets };
    return {
      name,
      enabled: true,
      transport: d.transport,
      url: d.url as string,
      headers,
      secrets,
    } as CreateMcpServerRequest;
  }

  /** Add a preset as a server and wait for its first connection attempt: the view says how it went. */
  async add(
    id: string,
    req: { fields: Record<string, string>; name?: string | undefined },
  ): Promise<McpServerView> {
    const d = MCP_PRESETS.find((p) => p.id === id);
    if (!d) throw unknownPreset(id);
    const missing = await this.runtimeMissingFor(d);
    if (missing) throw runtimeMissing(d.name, missing);
    const body = this.build(d, req.fields, req.name ?? d.id);
    const view = await this.servers.create(body, { wait: true });
    log.info({ preset: d.id, server: view.name, status: view.status }, 'MCP server added from a preset');
    return view;
  }
}
