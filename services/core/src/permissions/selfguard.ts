/**
 * ------------------------------------------------------------------
 *  Title    |  Floors that hold in every preset: Core's own API and key
 *  Ref      |  DESIGN.md §5.3, §5.8 · docs/permissions.md (Floors in
 *           |  every preset) · docs/api.md (Calling the API)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Core's API answers its owner, and the install key
 *           |  (local-api.key) is what proves it. A tool call that
 *           |  reaches that API, or names that file, is a model trying
 *           |  to answer its own questions or change its own
 *           |  permissions, so no grant, preset or approval can allow
 *           |  it. These two floors run on every call, in every
 *           |  preset, not only in Auto mode.
 *  How      |  selfFloor() is pure. It reads the call's action, its
 *           |  normalised resource and its real arguments:
 *           |    floor.core_api     an address on this machine
 *           |        (localhost, 127.0.0.0/8, [::1], 0.0.0.0, the other
 *           |        spellings the URL parser folds to those) on a port
 *           |        Core or the Cockpit listens on, or the public URL,
 *           |        in a web, http, shell, mcp or code call: its
 *           |        resource, a shell command, or any string in a
 *           |        fetch-style tool's arguments
 *           |    floor.install_key  the key file's name, in a file path
 *           |        or in a call that runs or reaches something
 *           |  The ports and origins are set once at start-up
 *           |  (configureSelfTargets); until then 7700 and 7701.
 *  Note     |  A file's own text (a README that says "localhost:7700")
 *           |  is not scanned: only paths, commands and the arguments
 *           |  of calls that reach out. Static text cannot see through
 *           |  a variable or a name that resolves to loopback, so this
 *           |  is a floor under the real defence, which is that the API
 *           |  refuses a caller without the key.
 * ------------------------------------------------------------------
 */

import { LOCAL_KEY_FILE } from '@nvx/contracts';
import { type FloorHit, fold, textOf } from './auto/floors';
import { scheme } from './normalize';

export interface SelfTargets {
  /** Ports Core and the Cockpit listen on, on any loopback address. */
  ports: ReadonlySet<number>;
  /** Where people reach NVX Ancile from outside: the public URL and any other allowed origin (host and port). */
  origins: readonly { host: string; port: number }[];
}

const DEFAULTS: SelfTargets = { ports: new Set([7700, 7701]), origins: [] };
let current: SelfTargets = DEFAULTS;

const defaultPort = (protocol: string) => (protocol === 'https:' || protocol === 'wss:' ? 443 : 80);

/** Set once at start: Core's and the Cockpit's ports, and the origins NVX Ancile is served from. */
export function configureSelfTargets(opts: { ports: number[]; origins: string[] }): void {
  const origins: { host: string; port: number }[] = [];
  for (const o of opts.origins) {
    try {
      const u = new URL(o);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      origins.push({ host: u.hostname.toLowerCase(), port: Number(u.port) || defaultPort(u.protocol) });
    } catch {
      /* not an address: the environment check rejects a bad public URL */
    }
  }
  current = { ports: new Set([...DEFAULTS.ports, ...opts.ports]), origins };
}

export const currentSelfTargets = (): SelfTargets => current;

/* ---- is this address Core? ---------------------------------------------------- */

/** Names and shapes that mean "this machine", after the URL parser has folded the numeric spellings. */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'host.docker.internal') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h) || h === '0.0.0.0') return true;
  if (h === '[::1]' || h === '[::]') return true;
  // IPv4-mapped IPv6 (the parser writes 127.0.0.1 as [::ffff:7f00:1]).
  if (/^\[::ffff:(7f[0-9a-f]{2}|0{1,4}):[0-9a-f]{1,4}\]$/.test(h)) return true;
  // Public names that point at loopback.
  if (h === 'localtest.me' || h.endsWith('.localtest.me') || h === 'lvh.me' || h.endsWith('.lvh.me'))
    return true;
  if (/(^|\.)(nip|sslip|xip)\.io$/.test(h) && /(^|[.-])127[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}/.test(h))
    return true;
  return false;
}

function isSelf(host: string, port: number, t: SelfTargets): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isLoopback(h) && t.ports.has(port)) return true;
  return t.origins.some((o) => o.host === h && o.port === port);
}

/** `scheme://host…` addresses in free text (a shell command, a tool's argument). */
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>\\^|;]+/gi;

/** An address cut out of prose or a command: without the bracket, comma or full stop that closed it. */
function trimAddress(token: string): string {
  let t = token;
  while (/[)}\],.]$/.test(t)) {
    // The closing bracket of an IPv6 literal belongs to it.
    if (t.endsWith(']') && (t.match(/\[/g)?.length ?? 0) >= (t.match(/\]/g)?.length ?? 0)) break;
    t = t.slice(0, -1);
  }
  return t;
}
/** `host:port` with no scheme (`curl localhost:7700`), a name, an IPv4 in any spelling, or a bracketed IPv6. */
const HOST_PORT = /(?<![\w.:@/%-])(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*):(\d{1,5})(?![\w])/gi;

/** Does any address in this text point at Core or the Cockpit? */
export function targetsCoreApi(text: string, t: SelfTargets = current): boolean {
  const folded = fold(text);
  for (const m of folded.matchAll(URL_TOKEN)) {
    try {
      const u = new URL(trimAddress(m[0]));
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) continue;
      if (isSelf(u.hostname, Number(u.port) || defaultPort(u.protocol), t)) return true;
    } catch {
      /* not an address */
    }
  }
  for (const m of folded.matchAll(HOST_PORT)) {
    const port = Number(m[2]);
    if (!m[1] || port < 1 || port > 65535) continue;
    try {
      if (isSelf(new URL(`http://${m[1]}`).hostname, port, t)) return true;
    } catch {
      /* not a host */
    }
  }
  return false;
}

/* ---- the key file's name ------------------------------------------------------- */

/**
 * The key file's name, with the ways a shell or a glob spells it: quotes and carets inside the
 * word are dropped, backslashes are slashes, and `local-api.k*`, `local-api*` and `local-api.?ey` still count.
 */
export function namesKeyFile(text: string): boolean {
  const t = fold(text)
    .replace(/[\\]/g, '/')
    .replace(/["'`^]/g, '');
  const stem = LOCAL_KEY_FILE.split('.')[0] ?? 'local-api';
  return new RegExp(`${stem}(\\.k|[.*?[])`).test(t) || t.includes(LOCAL_KEY_FILE);
}

/* ---- the floors ------------------------------------------------------------------ */

/** Actions that run something or reach out, where a string in the arguments can be a target. */
const REACHES = /^(shell|http|web|mcp|code|exec)\./;

export interface SelfCall {
  action: string;
  /** The normalised resource the permission decision used. */
  resource: string;
  /** The real arguments, as data. Scanned, never logged. */
  args?: unknown;
}

/** Block a call that reaches Core's API or names its key file; null when it does neither. */
export function selfFloor(call: SelfCall, t: SelfTargets = current): FloorHit | null {
  const kind = scheme(call.resource);
  const reaches =
    (REACHES.test(call.action) && call.action !== 'web.search') || kind === 'shell' || kind === 'http';
  const argsText = reaches && call.args !== undefined ? textOf(call.args) : '';
  // A file is named by its path; a call that reaches out, by its resource and everything it carries.
  const text = reaches ? `${call.resource}\n${argsText}` : call.resource;
  if (namesKeyFile(text))
    return {
      verdict: 'block',
      rule: 'floor.install_key',
      reason: "It names the file that holds NVX Ancile's install key, which no tool may read",
    };
  if (reaches && targetsCoreApi(text, t))
    return {
      verdict: 'block',
      rule: 'floor.core_api',
      reason:
        "It reaches NVX Ancile's own API, which no tool may call: it would let a model answer its own approvals or change its own permissions",
    };
  return null;
}
