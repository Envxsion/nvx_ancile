/**
 * ------------------------------------------------------------------
 *  Title    |  MCP servers: data and drafts
 *  Ref      |  packages/contracts/src/mcp.ts · docs/plugins.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything Admin → Plugins needs to manage the MCP
 *           |  servers NVX Ancile uses, kept out of the components so
 *           |  it can be tested plainly: the query, what the live
 *           |  event does to it, and the add/edit form as a draft that
 *           |  turns into exactly the request the contract asks for.
 *  How      |  A draft holds what the form shows. createBody/updateBody
 *           |  build the request and check it with the contract schema;
 *           |  problems come back per field, in words.
 *  Note     |  Secrets: a saved one shows as "Saved" and is sent back
 *           |  without a value (keep). Replacing it sends the new value.
 *           |  A removed row is left out of the list, which deletes it.
 * ------------------------------------------------------------------
 */

import {
  CreateMcpServerRequest,
  type GlobalEvent,
  type McpServerView,
  type McpToolView,
  type Tier,
  UpdateMcpServerRequest,
} from '@nvx/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export const MCP_SERVERS_KEY = ['ops', 'mcp-servers'] as const;
export const TOOLS_KEY = ['ops', 'tools'] as const;

/** GET /mcp/servers. Takes the bare list or the usual `{ items }` page. */
export function fetchMcpServers(): Promise<McpServerView[]> {
  return api
    .get<McpServerView[] | { items: McpServerView[] }>('/mcp/servers')
    .then((r) => (Array.isArray(r) ? r : (r.items ?? [])));
}

export const serverPath = (id: string) => `/mcp/servers/${encodeURIComponent(id)}`;
export const toolPath = (id: string, tool: string) => `${serverPath(id)}/tools/${encodeURIComponent(tool)}`;

/** Put one server, as Core returned it, into the cached list. */
export function putServer(qc: QueryClient, s: McpServerView): void {
  qc.setQueryData<McpServerView[]>(MCP_SERVERS_KEY, (list) =>
    list ? (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]) : list,
  );
}

type McpChanged = Extract<GlobalEvent, { type: 'mcp.server_changed' }>;

/**
 * `mcp.server_changed`: move the dot now, then refetch the servers (and
 * the assistant's tool list, which their tools are part of).
 */
export function onMcpServerChanged(e: McpChanged, qc: QueryClient): void {
  qc.setQueryData<McpServerView[]>(MCP_SERVERS_KEY, (list) => {
    if (!list) return list;
    const status = e.status;
    if (status === 'removed') return list.filter((s) => s.id !== e.server_id);
    return list.map((s) =>
      s.id === e.server_id
        ? {
            ...s,
            status,
            last_error: status === 'error' ? (e.detail ?? s.last_error) : null,
          }
        : s,
    );
  });
  void qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
  void qc.invalidateQueries({ queryKey: TOOLS_KEY });
}

/* ---- Words ------------------------------------------------------------------ */

export const STATUS_WORDS: Record<McpServerView['status'], string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Not connected',
  disabled: 'Off',
};

export const STATUS_DOT = {
  connecting: 'restarting',
  connected: 'ok',
  error: 'down',
  disabled: 'idle',
} as const satisfies Record<McpServerView['status'], string>;

/** The same names TierBadge and the Approvals help use. */
export const TIER_WORDS: Record<Tier, string> = {
  auto: 'Auto',
  gated: 'Asks once',
  critical: 'Asks every time',
};

export interface TierOption {
  value: Tier | '';
  label: string;
  disabled: boolean;
}

/** The tier picker for one tool. Auto is not offered for a tool that changes things. */
export function tierOptions(t: Pick<McpToolView, 'default_tier' | 'destructive'>): TierOption[] {
  return [
    { value: '', label: `Server's default (${TIER_WORDS[t.default_tier]})`, disabled: false },
    {
      value: 'auto',
      label: t.destructive ? 'Auto (not for tools that change things)' : 'Auto',
      disabled: t.destructive,
    },
    { value: 'gated', label: TIER_WORDS.gated, disabled: false },
    { value: 'critical', label: TIER_WORDS.critical, disabled: false },
  ];
}

/* ---- The add/edit draft ------------------------------------------------------- */

let seq = 0;
const uid = () => `r${++seq}`;

export interface PairRow {
  uid: string;
  key: string;
  value: string;
}

export interface SecretRow extends PairRow {
  /** Stored on the server: its value is never shown. */
  saved: boolean;
  /** A saved secret whose value is being replaced. */
  replacing: boolean;
}

export interface McpDraft {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  /** One argument per line. */
  args: string;
  env: PairRow[];
  url: string;
  headers: PairRow[];
  secrets: SecretRow[];
}

export const pairRow = (key = '', value = ''): PairRow => ({ uid: uid(), key, value });
export const secretRow = (key = '', saved = false): SecretRow => ({
  uid: uid(),
  key,
  value: '',
  saved,
  replacing: false,
});

export function emptyDraft(): McpDraft {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: [],
    url: '',
    headers: [],
    secrets: [],
  };
}

export function draftFromServer(s: McpServerView): McpDraft {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    args: s.args.join('\n'),
    env: Object.entries(s.env).map(([k, v]) => pairRow(k, v)),
    url: s.url ?? '',
    headers: Object.entries(s.headers).map(([k, v]) => pairRow(k, v)),
    secrets: s.secrets.map((x) => secretRow(x.key, x.set)),
  };
}

/** Field name → what is wrong with it. */
export type DraftProblems = Partial<
  Record<'name' | 'command' | 'args' | 'url' | 'env' | 'headers' | 'secrets', string>
>;

const argsOf = (text: string) =>
  text
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean);

const recordOf = (rows: PairRow[]) =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

/** Problems the schema cannot see: a row with a value and no name, a name used twice. */
function rowProblems(d: McpDraft): DraftProblems {
  const out: DraftProblems = {};
  const plain = d.transport === 'stdio' ? d.env : d.headers;
  const plainField = d.transport === 'stdio' ? 'env' : 'headers';
  const what = d.transport === 'stdio' ? 'variable' : 'header';
  const named = (rows: PairRow[]) => rows.map((r) => r.key.trim()).filter(Boolean);
  if (plain.some((r) => !r.key.trim() && r.value)) out[plainField] = `Give every ${what} a name.`;
  if (d.secrets.some((r) => !r.key.trim() && (r.value || r.saved))) out.secrets = 'Give every secret a name.';
  const all = [...named(plain), ...named(d.secrets)];
  const fold = (k: string) => (d.transport === 'http' ? k.toLowerCase() : k);
  const dup = all.find((k, i) => all.findIndex((x) => fold(x) === fold(k)) !== i);
  if (dup) {
    const inSecrets = named(d.secrets).some((k) => fold(k) === fold(dup));
    out[inSecrets ? 'secrets' : plainField] = `${dup} is used twice. Use each name once.`;
  }
  if (d.secrets.some((r) => r.key.trim() && !r.saved && !r.value))
    out.secrets ??= 'Enter a value for each new secret, or remove the row.';
  return out;
}

function schemaProblems(issues: { path: PropertyKey[]; message: string }[]): DraftProblems {
  const out: DraftProblems = {};
  for (const i of issues) {
    const field = String(i.path[0] ?? 'name') as keyof DraftProblems;
    const words =
      field === 'url' && /invalid url/i.test(i.message)
        ? 'Enter a full address, such as https://example.com/mcp.'
        : field === 'command' && /at least|too small/i.test(i.message)
          ? 'Enter the command that starts the server.'
          : field === 'name' && /at least|too small/i.test(i.message)
            ? 'Give the server a name.'
            : i.message;
    out[field] ??= words;
  }
  return out;
}

type Built<T> = { ok: true; body: T } | { ok: false; problems: DraftProblems };

/** POST /mcp/servers. */
export function createBody(d: McpDraft): Built<CreateMcpServerRequest> {
  const secrets = d.secrets
    .filter((r) => r.key.trim())
    .map((r) => ({ key: r.key.trim(), ...(r.value && { value: r.value }) }));
  const raw =
    d.transport === 'stdio'
      ? {
          name: d.name.trim(),
          transport: 'stdio' as const,
          command: d.command.trim(),
          args: argsOf(d.args),
          env: recordOf(d.env),
          secrets,
        }
      : {
          name: d.name.trim(),
          transport: 'http' as const,
          url: d.url.trim(),
          headers: recordOf(d.headers),
          secrets,
        };
  const parsed = CreateMcpServerRequest.safeParse(raw);
  const problems = { ...(parsed.success ? {} : schemaProblems(parsed.error.issues)), ...rowProblems(d) };
  if (!d.name.trim()) problems.name = 'Give the server a name.';
  if (!parsed.success || Object.keys(problems).length) return { ok: false, problems };
  return { ok: true, body: parsed.data };
}

/**
 * PATCH /mcp/servers/:id. Sends the whole secrets list: saved and left
 * alone goes without a value (keep), replaced or new goes with one,
 * removed is not in it (delete).
 */
export function updateBody(d: McpDraft): Built<UpdateMcpServerRequest> {
  // The create schema checks the fields the same way (and names in their own syntax).
  const asCreate = createBody(d);
  if (!asCreate.ok) return asCreate;
  const secrets = d.secrets
    .filter((r) => r.key.trim())
    .map((r) =>
      r.saved && !(r.replacing && r.value) ? { key: r.key.trim() } : { key: r.key.trim(), value: r.value },
    );
  const c = asCreate.body;
  const raw =
    c.transport === 'stdio'
      ? { name: c.name, command: c.command, args: c.args, env: c.env, secrets }
      : { name: c.name, url: c.url, headers: c.headers, secrets };
  const parsed = UpdateMcpServerRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: schemaProblems(parsed.error.issues) };
  return { ok: true, body: parsed.data };
}

/** Which form field a server-side error belongs to, if any. */
export function fieldForCode(code: string): keyof DraftProblems | null {
  if (code === 'mcp.name_taken') return 'name';
  if (code === 'mcp.secret_missing') return 'secrets';
  return null;
}
