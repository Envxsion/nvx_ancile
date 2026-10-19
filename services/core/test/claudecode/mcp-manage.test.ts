/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's MCP servers: use, add, remove
 *  Ref      |  ROADMAP MC1, MC2
 *  ID       |  core/test/claudecode
 * ------------------------------------------------------------------
 *  Purpose  |  "Use in NVX Ancile" copies a server's settings, moves
 *           |  secrets into the encrypted store, fills ${VAR} and says
 *           |  why a claude.ai connector cannot be copied. Adding,
 *           |  changing and removing a Claude Code server runs
 *           |  `claude mcp` only; the CLI here is a stand-in.
 * ------------------------------------------------------------------
 */

import type { McpServerView } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import type { ProcResult } from '../../src/claudecode/cli';
import {
  ancileNameOf,
  ClaudeCodeMcpManage,
  looksSecret,
  type McpCli,
  parseGet,
} from '../../src/claudecode/mcp-manage';
import { claudeCodeRoutes } from '../../src/claudecode/routes';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { McpManager } from '../../src/mcp/manager';
import { McpService } from '../../src/mcp/service';
import { MemoryMcpServerStore } from '../../src/mcp/store';
import { errorHandler } from '../../src/obs/errors';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { ToolRegistry } from '../../src/tools/registry';

class Bus implements EventBus {
  async publish(_e: GlobalEventInput) {}
  subscribe() {
    return () => undefined;
  }
}

const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

const GET_STDIO = `github:
  Scope: User config (available in all your projects)
  Status: ✓ Connected
  Type: stdio
  Command: npx
  Args: -y @modelcontextprotocol/server-github
  Environment:
    GITHUB_PERSONAL_ACCESS_TOKEN=${TOKEN}
    LOG_LEVEL=debug

To remove this server, run: claude mcp remove "github" -s user
`;
const GET_HTTP = `sentry:
  Scope: Project config (shared via .mcp.json)
  Status: ✓ Connected
  Type: sse
  URL: https://mcp.example.com/sse
  Headers:
    Authorization: Bearer abcdefghijklmnop12345
    X-Team: platform
`;

/** A stand-in for `claude`: what each `mcp get` prints, and every call it saw. */
class FakeCli implements McpCli {
  calls: string[][] = [];
  get: Record<string, string> = { github: GET_STDIO, sentry: GET_HTTP };
  fail: Record<string, ProcResult> = {};
  missing = false;
  async run(args: string[]): Promise<ProcResult & { located: unknown }> {
    this.calls.push(args);
    const res = (r: Partial<ProcResult>): ProcResult & { located: unknown } => ({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      located: this.missing ? null : { path: 'claude' },
      ...r,
    });
    if (this.missing) return res({ code: 127, stderr: 'not installed' });
    const key = args.slice(0, 3).join(' ');
    const forced = this.fail[key] ?? this.fail[args.slice(0, 2).join(' ')];
    if (forced) return res(forced);
    if (args[1] === 'get') {
      const text = this.get[args[2] as string];
      return text
        ? res({ stdout: text })
        : res({ code: 1, stderr: `No MCP server found with name: ${args[2]}` });
    }
    return res({});
  }
}

let cli: FakeCli;
let secrets: MemorySecretStore;
let service: McpService;
let settings: MemorySettings;
let manage: ClaudeCodeMcpManage;
let app: Hono<AppEnv>;
let sources: Record<string, string>;
let changed: number;
let env: Record<string, string>;

beforeEach(() => {
  cli = new FakeCli();
  sources = {};
  changed = 0;
  env = {};
  secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 9).toString('base64')));
  settings = new MemorySettings();
  const mcp = new McpManager(new ToolRegistry(), {
    secrets,
    events: new Bus(),
    // Nothing connects in these tests: a refused transport is recorded as an error.
    transport: () => {
      throw new Error('not connecting here');
    },
  });
  service = new McpService({ store: new MemoryMcpServerStore(), secrets, settings, manager: mcp, files: [] });
  manage = new ClaudeCodeMcpManage({
    cli,
    servers: service,
    settings,
    sourceOf: async (n) => sources[n] ?? null,
    changed: () => {
      changed += 1;
    },
    env: (n) => env[n],
  });
  app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', claudeCodeRoutes({ service: () => ({}) as never, mcpManage: () => manage }));
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('reading what Claude Code prints', () => {
  it('parses a stdio and an sse server, with environment and headers', () => {
    expect(parseGet(GET_STDIO)).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      pairs: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN, LOG_LEVEL: 'debug' },
    });
    expect(parseGet(GET_HTTP)).toMatchObject({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      pairs: { Authorization: 'Bearer abcdefghijklmnop12345', 'X-Team': 'platform' },
    });
    expect(parseGet('nothing useful here')).toBeNull();
  });

  it('tells a secret by its name or its shape, and names a copy for NVX Ancile', () => {
    expect(looksSecret('API_TOKEN', 'x')).toBe(true);
    expect(looksSecret('Authorization', 'x')).toBe(true);
    expect(looksSecret('LOG_LEVEL', 'debug')).toBe(false);
    expect(looksSecret('ANYTHING', TOKEN)).toBe(true);
    expect(ancileNameOf('plugin:design:linear')).toBe('design-linear');
    expect(ancileNameOf('My Server!')).toBe('my-server');
  });
});

describe('use in NVX Ancile', () => {
  it('previews without a secret value, then copies: the token goes to the encrypted store only', async () => {
    const preview = await post('/claude-code/mcp-servers/github/use/preview', {});
    const text = await preview.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({
      ancile_name: 'github',
      transport: 'stdio',
      command: 'npx',
      plain: { LOG_LEVEL: 'debug' },
      secret_keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      unresolved: [],
      existing: 'none',
      changed_since_copy: false,
    });
    const res = await post('/claude-code/mcp-servers/github/use', {});
    expect(res.status).toBe(201);
    const body = await res.text();
    expect(body).not.toContain(TOKEN);
    const view = JSON.parse(body) as McpServerView;
    expect(view).toMatchObject({
      name: 'github',
      source: 'app',
      env: { LOG_LEVEL: 'debug' },
      secrets: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', set: true }],
    });
    expect(await secrets.names()).toContain(`mcp.${view.id}.GITHUB_PERSONAL_ACCESS_TOKEN`);
    // Only reads: `mcp get`. Nothing in Claude Code changed.
    expect(cli.calls.every((c) => c[0] === 'mcp' && c[1] === 'get')).toBe(true);
  });

  it('copies an sse server with its Authorization header as a secret', async () => {
    const view = (await (await post('/claude-code/mcp-servers/sentry/use', {})).json()) as McpServerView;
    expect(view).toMatchObject({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { 'X-Team': 'platform' },
      secrets: [{ key: 'Authorization', set: true }],
    });
  });

  it('fills variable references from the environment, a default, or what you type, and asks for what is missing', async () => {
    cli.get.pg = `pg:
  Type: stdio
  Command: uvx
  Args: postgres-mcp --path \${PGDIR:-/data}
  Environment:
    DATABASE_URI=\${DATABASE_URI}
    REGION=\${REGION}
`;
    const need = await post('/claude-code/mcp-servers/pg/use', {});
    expect(need.status).toBe(400);
    const err = (await need.json()) as { error: { code: string; context: { unresolved: string[] } } };
    expect(err.error.code).toBe('mcp.needs_values');
    expect(err.error.context.unresolved.sort()).toEqual(['DATABASE_URI', 'REGION']);

    env = { REGION: 'eu-west-1' };
    const preview = (await (
      await post('/claude-code/mcp-servers/pg/use/preview', { values: {} })
    ).json()) as { unresolved: string[]; args: string[] };
    expect(preview.unresolved).toEqual(['DATABASE_URI']);
    expect(preview.args).toEqual(['postgres-mcp', '--path', '/data']);

    const ok = await post('/claude-code/mcp-servers/pg/use', {
      values: { DATABASE_URI: 'postgresql://u:p@h/db' },
    });
    expect(ok.status).toBe(201);
    const view = (await ok.json()) as McpServerView;
    expect(JSON.stringify(view)).not.toContain('postgresql://u:p@h/db');
    expect(view.secrets.map((s) => s.key).sort()).toEqual(['DATABASE_URI', 'REGION']);
  });

  it('says a claude.ai connector cannot be copied, and why', async () => {
    sources['claude.ai Vercel'] = 'claudeai';
    const res = await post(`/claude-code/mcp-servers/${encodeURIComponent('claude.ai Vercel')}/use`, {});
    expect(res.status).toBe(409);
    const e = (await res.json()) as { error: { code: string; hint: string } };
    expect(e.error.code).toBe('mcp.not_copyable');
    expect(e.error.hint).toMatch(/tied to your Claude account/);
    expect(cli.calls).toEqual([]);
  });

  it('copies a plugin server once you give the plugin folder it refers to', async () => {
    sources['plugin:design:linear'] = 'plugin';
    cli.get['plugin:design:linear'] = `plugin:design:linear:
  Type: stdio
  Command: node
  Args: \${CLAUDE_PLUGIN_ROOT}/server.js
`;
    const need = await post(`/claude-code/mcp-servers/${encodeURIComponent('plugin:design:linear')}/use`, {});
    expect(await codeOf(need)).toBe('mcp.needs_values');
    const ok = await post(`/claude-code/mcp-servers/${encodeURIComponent('plugin:design:linear')}/use`, {
      values: { CLAUDE_PLUGIN_ROOT: '/plugins/design' },
    });
    expect(((await ok.json()) as McpServerView).args).toEqual(['/plugins/design/server.js']);
  });

  it('refuses a secret in the command line or address, and a server that needs browser sign-in', async () => {
    cli.get.leaky = `leaky:
  Type: stdio
  Command: tool
  Args: --token ${TOKEN}
`;
    expect(await codeOf(await post('/claude-code/mcp-servers/leaky/use', {}))).toBe('mcp.secret_in_config');
    cli.get.oauth = `oauth:
  Status: ! Needs authentication
  Type: http
  URL: https://mcp.example.com/mcp
`;
    expect(await codeOf(await post('/claude-code/mcp-servers/oauth/use', {}))).toBe('mcp.not_copyable');
  });

  it('is a no-op when the same server is already copied, and refuses a different one under the name', async () => {
    const first = (await (await post('/claude-code/mcp-servers/github/use', {})).json()) as McpServerView;
    const again = await post('/claude-code/mcp-servers/github/use', {});
    expect(((await again.json()) as McpServerView).id).toBe(first.id);
    expect((await service.list()).length).toBe(1);

    cli.get.github = GET_STDIO.replace('LOG_LEVEL=debug', 'LOG_LEVEL=trace');
    const preview = (await (await post('/claude-code/mcp-servers/github/use/preview', {})).json()) as {
      existing: string;
      changed_since_copy: boolean;
    };
    expect(preview).toMatchObject({ existing: 'different', changed_since_copy: true });
    expect(await codeOf(await post('/claude-code/mcp-servers/github/use', {}))).toBe('mcp.name_taken');
    // Another name keeps both; update brings the copy in line.
    const other = await post('/claude-code/mcp-servers/github/use', { ancile_name: 'github-two' });
    expect(other.status).toBe(201);
    const updated = (await (
      await post('/claude-code/mcp-servers/github/use', { update: true })
    ).json()) as McpServerView;
    expect(updated.env).toEqual({ LOG_LEVEL: 'trace' });
    const after = (await (await post('/claude-code/mcp-servers/github/use/preview', {})).json()) as {
      changed_since_copy: boolean;
    };
    expect(after.changed_since_copy).toBe(false);
  });

  it('says so when the server is gone from Claude Code, and when Claude Code is not there', async () => {
    expect(await codeOf(await post('/claude-code/mcp-servers/ghost/use', {}))).toBe(
      'mcp.claude_code_server_not_found',
    );
    cli.missing = true;
    expect(await codeOf(await post('/claude-code/mcp-servers/github/use', {}))).toBe(
      'mcp.claude_code_unavailable',
    );
  });
});

describe('adding, changing and removing in Claude Code', () => {
  const add = (over: Record<string, unknown> = {}) =>
    post('/claude-code/mcp-servers', {
      name: 'notes',
      transport: 'stdio',
      command: 'notes-server',
      args: ['--fast'],
      env: { LOG_LEVEL: 'info' },
      secrets: [{ key: 'NOTES_TOKEN', value: 'tok_0123456789abcdef' }],
      ...over,
    });

  it('runs claude mcp add-json with the scope, and nothing else', async () => {
    const res = await add({ scope: 'project' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'notes', scope: 'project' });
    expect(cli.calls).toHaveLength(1);
    const [call] = cli.calls;
    expect(call?.slice(0, 3)).toEqual(['mcp', 'add-json', 'notes']);
    expect(call?.slice(4)).toEqual(['--scope', 'project']);
    expect(JSON.parse(call?.[3] as string)).toEqual({
      type: 'stdio',
      command: 'notes-server',
      args: ['--fast'],
      env: { LOG_LEVEL: 'info', NOTES_TOKEN: 'tok_0123456789abcdef' },
    });
    expect(changed).toBe(1);
  });

  it('adds an sse server with a header secret', async () => {
    const res = await post('/claude-code/mcp-servers', {
      name: 'events',
      transport: 'sse',
      url: 'https://example.com/sse',
      secrets: [{ key: 'Authorization', value: 'Bearer abcdef0123456789' }],
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(cli.calls[0]?.[3] as string)).toMatchObject({
      type: 'sse',
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer abcdef0123456789' },
    });
  });

  it('checks the request before running anything', async () => {
    expect((await add({ name: 'bad name!' })).status).toBe(400);
    expect((await add({ command: '' })).status).toBe(400);
    expect((await add({ secrets: [{ key: 'NOTES_TOKEN' }] })).status).toBe(400);
    expect((await add({ scope: 'global' })).status).toBe(400);
    expect((await add({ name: 'ancile' })).status).toBe(409);
    expect(
      (await post('/claude-code/mcp-servers', { name: 'x', transport: 'sse', url: 'ftp://x' })).status,
    ).toBe(400);
    expect(cli.calls).toEqual([]);
  });

  it('keeps a secret out of the error it shows when Claude Code refuses', async () => {
    cli.fail['mcp add-json'] = {
      code: 1,
      stdout: '',
      stderr: 'Invalid config: NOTES_TOKEN=tok_0123456789abcdef is not allowed',
      timedOut: false,
    };
    const res = await add();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('tok_0123456789abcdef');
    expect(JSON.parse(text).error.code).toBe('mcp.claude_code_failed');
  });

  it('changes a server by removing and adding it, and puts the old one back if the add fails', async () => {
    cli.get.notes = `notes:
  Type: stdio
  Command: old-server
  Args: -v
  Environment:
    OLD_KEY=oldvalue12345
`;
    const ok = await add({ replace: true });
    expect(ok.status).toBe(201);
    expect(cli.calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'mcp get notes',
      'mcp remove notes',
      'mcp add-json notes',
    ]);

    cli.calls = [];
    let addCalls = 0;
    const run = cli.run.bind(cli);
    cli.run = async (args) => {
      if (args[1] === 'add-json' && addCalls++ === 0) {
        cli.calls.push(args);
        return { code: 1, stdout: '', stderr: 'boom', timedOut: false, located: {} };
      }
      return run(args);
    };
    const failed = await add({ replace: true });
    expect(failed.status).toBe(502);
    const adds = cli.calls.filter((c) => c[1] === 'add-json');
    expect(adds).toHaveLength(2);
    expect(JSON.parse(adds[1]?.[3] as string)).toMatchObject({ command: 'old-server', args: ['-v'] });
  });

  it('removes a server by name and scope, and not claude.ai connectors or plugin servers', async () => {
    const res = await app.request('/claude-code/mcp-servers/notes?scope=local', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(cli.calls[0]).toEqual(['mcp', 'remove', 'notes', '--scope', 'local']);
    sources.vercel = 'claudeai';
    sources['plugin:a:b'] = 'plugin';
    const a = await app.request('/claude-code/mcp-servers/vercel', { method: 'DELETE' });
    expect(await codeOf(a)).toBe('mcp.not_copyable');
    const b = await app.request(`/claude-code/mcp-servers/${encodeURIComponent('plugin:a:b')}`, {
      method: 'DELETE',
    });
    expect(((await b.json()) as { error: { hint: string } }).error.hint).toMatch(/Turn the plugin off/);
    expect(
      (await app.request('/claude-code/mcp-servers/notes?scope=elsewhere', { method: 'DELETE' })).status,
    ).toBe(400);
  });
});
