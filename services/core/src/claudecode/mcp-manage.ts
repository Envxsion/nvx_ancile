/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's MCP servers: use, add, remove
 *  Ref      |  ROADMAP MC1, MC2 · docs/plugins.md · docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  "Use in NVX Ancile" copies a server you already set up
 *           |  in Claude Code (command or address, arguments, plain
 *           |  settings) into NVX Ancile's own MCP list, moves its
 *           |  secret values into the encrypted store and fills in
 *           |  ${VAR} references. Adding, changing and removing a
 *           |  Claude Code server from here goes through Claude Code.
 *  How      |  Only Claude Code's public `claude mcp` command, as an
 *           |  argv array with a timeout (cli.ts): `get` to read one
 *           |  server, `add-json` and `remove` to write. NVX Ancile
 *           |  never opens or edits ~/.claude.json or .mcp.json for
 *           |  this. What `get` prints is parsed into a config in
 *           |  memory; a value that looks like a secret (by its name,
 *           |  or by its shape) goes to the secret store through
 *           |  McpService.create and nowhere else. A copy records a
 *           |  hash of what it copied, so a later change in Claude Code
 *           |  is noticed. claude.ai connectors cannot be copied: they
 *           |  are tied to your Claude account.
 *  Note     |  `claude mcp add-json` takes the config as an argument, so
 *           |  a secret value is visible in that process's argument
 *           |  list for the moment it runs. Its output is redacted
 *           |  before it is shown or logged. The text `get` prints
 *           |  separates arguments with spaces, so an argument that
 *           |  contains a space is read as two; the preview shows what
 *           |  would be copied before anything is.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import {
  type AddClaudeCodeMcpServerRequest,
  AncileError,
  type ClaudeCodeMcpScope,
  type ClaudeCodeMcpUsePreview,
  type McpServerView,
  type UseClaudeCodeMcpRequest,
} from '@nvx/contracts';
import type { McpService } from '../mcp/service';
import { badRequest } from '../obs/errors';
import { logFor } from '../obs/logger';
import { redactText } from '../obs/redact';
import type { SettingsStore } from '../settings';
import type { ProcResult } from './cli';
import { ANCILE_MCP_SERVER } from './permission-map';

const log = logFor('claude-code-mcp');

/** Where copies are remembered: { [NVX Ancile server name]: { from, hash } }. Hashes only. */
export const MCP_COPIES_SETTING = 'mcp.claude_code_copies';

const TIMEOUT_MS = 30_000;

/** The part of ClaudeCli this needs, so a test can stand in for it. */
export interface McpCli {
  run(args: string[], timeoutMs: number): Promise<ProcResult & { located: unknown }>;
}

/* ---- Errors (docs/errors.md) ----------------------------------------------------- */

const cliMissing = () =>
  new AncileError({
    code: 'mcp.claude_code_unavailable',
    title: 'NVX Ancile cannot reach Claude Code',
    hint: 'Install Claude Code or check it in Settings, Claude Code, then try again.',
    status: 409,
    errorClass: 'permanent',
  });

const notFound = (name: string) =>
  new AncileError({
    code: 'mcp.claude_code_server_not_found',
    title: `Claude Code has no server called ${name}`,
    hint: 'It may have been removed. Refresh the list, then try again.',
    status: 404,
    errorClass: 'permanent',
  });

const notCopyable = (name: string, why: string) =>
  new AncileError({
    code: 'mcp.not_copyable',
    title: `${name} cannot be copied to NVX Ancile`,
    hint: why,
    status: 409,
    errorClass: 'permanent',
  });

const needsValues = (names: string[]) =>
  new AncileError({
    code: 'mcp.needs_values',
    title: `Claude Code reads ${names.join(', ')} from its environment, and NVX Ancile does not have a value`,
    hint: 'Type a value for each, and copy again. They are stored encrypted.',
    status: 400,
    errorClass: 'permanent',
    context: { unresolved: names },
  });

const secretInPlace = (where: string) =>
  new AncileError({
    code: 'mcp.secret_in_config',
    title: `A secret sits in the ${where}, where it would be stored in plain text`,
    hint: 'Move it into an environment variable or a header in Claude Code, then copy again.',
    status: 409,
    errorClass: 'permanent',
  });

const differs = (name: string) =>
  new AncileError({
    code: 'mcp.name_taken',
    title: `NVX Ancile already has a different server called ${name}`,
    hint: 'Choose another name for the copy, or update the one you have to match Claude Code.',
    status: 409,
    errorClass: 'permanent',
  });

const cliFailed = (what: string, stderr: string, values: string[]) =>
  new AncileError({
    code: 'mcp.claude_code_failed',
    title: `Claude Code did not ${what}`,
    hint: 'Its own message is below. Fix what it names, then try again.',
    status: 502,
    errorClass: 'permanent',
    detail: scrub(stderr, values).slice(0, 500),
  });

const exists = (name: string) =>
  new AncileError({
    code: 'mcp.claude_code_exists',
    title: `Claude Code already has a server called ${name}`,
    hint: 'Choose another name, or change the one it has.',
    status: 409,
    errorClass: 'permanent',
  });

/** Output from Claude Code with every secret value we handed it, and anything that looks like a key, taken out. */
function scrub(text: string, values: string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join('…');
  return redactText(out);
}

/* ---- Reading `claude mcp get` ------------------------------------------------------ */

export interface ParsedServer {
  scope: string | null;
  needsAuth: boolean;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: string[];
  url: string | null;
  /** Environment (stdio) or headers (http, sse), as printed. */
  pairs: Record<string, string>;
}

/**
 * The text `claude mcp get <name>` prints, as a config. Tolerant of the
 * shapes seen across versions; returns null when it holds no server.
 */
export function parseGet(text: string): ParsedServer | null {
  const lines = text.replace(/\r/g, '').split('\n');
  let transport: string | null = null;
  let scope: string | null = null;
  let command: string | null = null;
  let args: string[] = [];
  let url: string | null = null;
  let needsAuth = false;
  const pairs: Record<string, string> = {};
  let section: 'env' | 'headers' | null = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (section && indent >= 4) {
      const eq = line.indexOf('=');
      const colon = line.indexOf(':');
      // Environment prints KEY=value; headers print Name: value.
      const at = section === 'env' ? (eq >= 0 ? eq : colon) : colon >= 0 ? colon : eq;
      if (at > 0) pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      continue;
    }
    section = null;
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).trim().toLowerCase();
    const val = (m[2] as string).trim();
    if (key === 'type') transport = val.toLowerCase();
    else if (key === 'scope') scope = val;
    else if (key === 'status') needsAuth = /auth/i.test(val) && !/authenticated|connected/i.test(val);
    else if (key === 'command') command = val;
    else if (key === 'args') args = val ? val.split(/\s+/) : [];
    else if (key === 'url') url = val;
    else if (key === 'environment') section = 'env';
    else if (key === 'headers') section = 'headers';
  }
  const t = transport === 'stdio' || transport === 'http' || transport === 'sse' ? transport : null;
  if (!t) return null;
  if (t === 'stdio' ? !command : !url) return null;
  return { scope, needsAuth, transport: t, command, args, url, pairs };
}

/* ---- Resolving ${VAR} and finding secrets ------------------------------------------ */

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

const SECRET_NAME =
  /token|secret|password|passwd|api[-_]?key|apikey|auth|bearer|credential|cookie|signature|private/i;

/** A value that is secret by its name or by its shape. */
export function looksSecret(key: string, value: string): boolean {
  return SECRET_NAME.test(key) || redactText(value) !== value;
}

interface Resolved {
  text: string;
  /** Names with no value and no default. */
  missing: string[];
  /** Whether any reference was filled in. */
  filled: boolean;
}

function resolveRefs(
  text: string,
  env: (n: string) => string | undefined,
  values: Record<string, string>,
): Resolved {
  const missing: string[] = [];
  let filled = false;
  const out = text.replace(VAR, (_all, name: string, dflt: string | undefined) => {
    const v = values[name] ?? env(name) ?? dflt;
    if (v === undefined) {
      missing.push(name);
      return '';
    }
    filled = true;
    return v;
  });
  return { text: out, missing, filled };
}

/** Claude Code names to the name NVX Ancile allows: lower-case, 1 to 40 of a-z 0-9 - _. */
export function ancileNameOf(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/^plugin:/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
  return base || 'claude-code-server';
}

/* ---- The service ----------------------------------------------------------------- */

export interface McpManageDeps {
  cli: McpCli;
  servers: Pick<McpService, 'list' | 'create' | 'update'>;
  settings: SettingsStore;
  /** Where a server is set up (claudeai, plugin, user, ...), from the list; null when unknown. */
  sourceOf?: (name: string) => Promise<string | null>;
  /** Told after Claude Code's config changed, so the read-only list is asked again. */
  changed?: () => void;
  env?: (name: string) => string | undefined;
}

interface Built {
  parsed: ParsedServer;
  /** Plain environment or headers. */
  plain: Record<string, string>;
  /** Secret environment or headers, with values. */
  secrets: { key: string; value: string }[];
  command: string | null;
  args: string[];
  url: string | null;
  unresolved: string[];
  hash: string;
}

export class ClaudeCodeMcpManage {
  constructor(private readonly deps: McpManageDeps) {}

  private env = (n: string) => (this.deps.env ?? ((x: string) => process.env[x]))(n);

  private async run(args: string[], values: string[] = []): Promise<ProcResult> {
    let r: ProcResult & { located: unknown };
    try {
      r = await this.deps.cli.run(args, TIMEOUT_MS);
    } catch (err) {
      log.warn({ err: scrub((err as Error).message, values) }, 'Claude Code could not be run');
      throw cliMissing();
    }
    if (r.code === 127 || !r.located) throw cliMissing();
    return r;
  }

  private async read(name: string): Promise<ParsedServer> {
    const r = await this.run(['mcp', 'get', name]);
    if (r.code !== 0) {
      if (/no mcp server found|not found/i.test(`${r.stdout}${r.stderr}`)) throw notFound(name);
      throw cliFailed('show that server', r.stderr || r.stdout, []);
    }
    const p = parseGet(r.stdout);
    if (!p) throw cliFailed('show that server in a form NVX Ancile can read', r.stdout.slice(0, 200), []);
    return p;
  }

  /** Read a server and turn it into what would be copied; no write. */
  private async build(name: string, values: Record<string, string>): Promise<Built> {
    const source = (await this.deps.sourceOf?.(name).catch(() => null)) ?? null;
    if (source === 'claudeai' || name.startsWith('claude.ai '))
      throw notCopyable(
        name,
        'claude.ai connectors are tied to your Claude account and sign in through it. Add the same service with Add server instead.',
      );
    if (name === ANCILE_MCP_SERVER) throw notCopyable(name, 'That is NVX Ancile’s own server.');
    const parsed = await this.read(name);
    if (parsed.needsAuth)
      throw notCopyable(
        name,
        'It signs in through your browser (OAuth), which NVX Ancile cannot do for a remote server yet. Add it with an access token in Add server.',
      );
    const unresolved = new Set<string>();
    const fill = (text: string, label: string) => {
      const r = resolveRefs(text, this.env, values);
      for (const m of r.missing) unresolved.add(m);
      return { ...r, label };
    };
    const command = parsed.command ? fill(parsed.command, 'command') : null;
    const args = parsed.args.map((a) => fill(a, 'arguments'));
    const url = parsed.url ? fill(parsed.url, 'address') : null;
    const plain: Record<string, string> = {};
    const secrets: { key: string; value: string }[] = [];
    for (const [k, v] of Object.entries(parsed.pairs)) {
      const r = fill(v, k);
      // Claude Code's printed value for a variable it expands is the reference itself.
      if (looksSecret(k, r.text) || r.filled) {
        if (r.text) secrets.push({ key: k, value: r.text });
        else if (!r.missing.length) continue;
      } else plain[k] = r.text;
    }
    if (!unresolved.size) {
      // A secret in the command line or the address would be stored and shown in plain text.
      for (const a of args) if (a.filled && looksSecret('', a.text)) throw secretInPlace('arguments');
      if (args.some((a) => redactText(a.text) !== a.text)) throw secretInPlace('arguments');
      if (
        url &&
        (redactText(url.text) !== url.text || /[?&][^=]*(token|key|secret|auth)[^=]*=/i.test(url.text))
      )
        throw secretInPlace('address');
    }
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          parsed.transport,
          parsed.command,
          parsed.args,
          parsed.url,
          Object.entries(parsed.pairs).sort(),
        ]),
      )
      .digest('hex');
    return {
      parsed,
      plain,
      secrets,
      command: command?.text ?? null,
      args: args.map((a) => a.text),
      url: url?.text ?? null,
      unresolved: [...unresolved],
      hash,
    };
  }

  private async copies(): Promise<Record<string, { from: string; hash: string }>> {
    return (
      (await this.deps.settings.get<Record<string, { from: string; hash: string }>>(MCP_COPIES_SETTING)) ?? {}
    );
  }

  private static same(b: Built, s: McpServerView): boolean {
    const keys = (xs: { key: string }[]) =>
      xs
        .map((x) => x.key)
        .sort()
        .join('\n');
    const plainSame =
      JSON.stringify(Object.entries(b.plain).sort()) ===
      JSON.stringify(Object.entries(b.parsed.transport === 'stdio' ? s.env : s.headers).sort());
    return (
      b.parsed.transport === s.transport &&
      b.command === s.command &&
      JSON.stringify(b.args) === JSON.stringify(s.args) &&
      b.url === s.url &&
      plainSame &&
      keys(b.secrets) === keys(s.secrets)
    );
  }

  async preview(
    name: string,
    req: { ancile_name?: string | undefined; values?: Record<string, string> } = {},
  ): Promise<ClaudeCodeMcpUsePreview> {
    const b = await this.build(name, req.values ?? {});
    const ancile = req.ancile_name ?? ancileNameOf(name);
    const have = (await this.deps.servers.list()).find((s) => s.name === ancile);
    const copy = (await this.copies())[ancile];
    return {
      name,
      ancile_name: ancile,
      transport: b.parsed.transport,
      command: b.command,
      args: b.args,
      url: b.url,
      plain: b.plain,
      secret_keys: b.secrets.map((s) => s.key),
      unresolved: b.unresolved,
      existing: !have ? 'none' : ClaudeCodeMcpManage.same(b, have) ? 'same' : 'different',
      changed_since_copy: !!copy && copy.from === name && copy.hash !== b.hash,
    };
  }

  /** Copy a server into NVX Ancile's list. Nothing in Claude Code changes. */
  async use(name: string, req: UseClaudeCodeMcpRequest): Promise<McpServerView> {
    const b = await this.build(name, req.values);
    if (b.unresolved.length) throw needsValues(b.unresolved);
    const ancile = req.ancile_name ?? ancileNameOf(name);
    const have = (await this.deps.servers.list()).find((s) => s.name === ancile);
    let view: McpServerView;
    if (have) {
      if (ClaudeCodeMcpManage.same(b, have) && !req.update) return have;
      if (!req.update) throw differs(ancile);
      if (have.source !== 'app') throw differs(ancile);
      view = await this.deps.servers.update(have.id, {
        ...(b.parsed.transport === 'stdio'
          ? { command: b.command as string, args: b.args, env: b.plain }
          : { url: b.url as string, headers: b.plain }),
        secrets: b.secrets,
      });
    } else {
      const base = { name: ancile, enabled: true, secrets: b.secrets };
      view = await this.deps.servers.create(
        b.parsed.transport === 'stdio'
          ? { ...base, transport: 'stdio', command: b.command as string, args: b.args, env: b.plain }
          : { ...base, transport: b.parsed.transport, url: b.url as string, headers: b.plain },
        { wait: true },
      );
    }
    await this.deps.settings.set(MCP_COPIES_SETTING, {
      ...(await this.copies()),
      [ancile]: { from: name, hash: b.hash },
    });
    log.info({ from: name, server: ancile, secrets: b.secrets.length }, 'copied a Claude Code MCP server');
    return view;
  }

  /* ---- Writes to Claude Code, through its own command ---- */

  private static json(req: AddClaudeCodeMcpServerRequest): { json: string; secretValues: string[] } {
    const secretValues = req.secrets.flatMap((s) => (s.value ? [s.value] : []));
    const merged = (plain: Record<string, string>) => {
      const out = { ...plain };
      for (const s of req.secrets) if (s.value) out[s.key] = s.value;
      return out;
    };
    const cfg =
      req.transport === 'stdio'
        ? { type: 'stdio', command: req.command, args: req.args, env: merged(req.env) }
        : { type: req.transport, url: req.url, headers: merged(req.headers) };
    return { json: JSON.stringify(cfg), secretValues };
  }

  /** Add a server to Claude Code; with `replace`, change the one it has. */
  async add(req: AddClaudeCodeMcpServerRequest): Promise<{ name: string; scope: ClaudeCodeMcpScope }> {
    if (req.name === ANCILE_MCP_SERVER) throw exists(req.name);
    for (const s of req.secrets) if (!s.value) throw badRequest(`secrets: type a value for ${s.key}`);
    const { json, secretValues } = ClaudeCodeMcpManage.json(req);
    let previous: ParsedServer | null = null;
    if (req.replace) {
      previous = await this.read(req.name).catch(() => null);
      await this.remove(req.name, req.scope, true);
    }
    const r = await this.run(['mcp', 'add-json', req.name, json, '--scope', req.scope], secretValues);
    if (r.code !== 0) {
      // A change that failed puts the old server back, so nothing is lost.
      if (previous) await this.restore(req.name, req.scope, previous).catch(() => undefined);
      const text = `${r.stderr}${r.stdout}`;
      if (/already exists/i.test(text)) throw exists(req.name);
      throw cliFailed('add that server', text, secretValues);
    }
    this.deps.changed?.();
    log.info(
      { server: req.name, scope: req.scope, transport: req.transport },
      'added a Claude Code MCP server',
    );
    return { name: req.name, scope: req.scope };
  }

  private async restore(name: string, scope: ClaudeCodeMcpScope, p: ParsedServer): Promise<void> {
    const cfg =
      p.transport === 'stdio'
        ? { type: 'stdio', command: p.command, args: p.args, env: p.pairs }
        : { type: p.transport, url: p.url, headers: p.pairs };
    await this.run(['mcp', 'add-json', name, JSON.stringify(cfg), '--scope', scope], Object.values(p.pairs));
  }

  /** Remove a server from Claude Code. */
  async remove(name: string, scope: ClaudeCodeMcpScope, quiet = false): Promise<void> {
    if (name === ANCILE_MCP_SERVER) throw notCopyable(name, 'That is NVX Ancile’s own server.');
    const source = (await this.deps.sourceOf?.(name).catch(() => null)) ?? null;
    if (
      source === 'claudeai' ||
      source === 'plugin' ||
      name.startsWith('claude.ai ') ||
      name.startsWith('plugin:')
    )
      throw notCopyable(
        name,
        source === 'plugin' || name.startsWith('plugin:')
          ? 'A plugin provides this server. Turn the plugin off in Claude Code instead.'
          : 'claude.ai connectors are managed in your Claude account.',
      );
    const r = await this.run(['mcp', 'remove', name, '--scope', scope]);
    if (r.code !== 0) {
      const text = `${r.stderr}${r.stdout}`;
      if (/no mcp server found|not found/i.test(text)) {
        if (quiet) return;
        throw notFound(name);
      }
      throw cliFailed('remove that server', text, []);
    }
    if (!quiet) this.deps.changed?.();
    log.info({ server: name, scope }, 'removed a Claude Code MCP server');
  }
}
