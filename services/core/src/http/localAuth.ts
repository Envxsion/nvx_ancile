/**
 * ------------------------------------------------------------------
 *  Title    |  Local caller authentication
 *  Ref      |  DESIGN.md §4.1, §5.8 · docs/api.md (Calling the API)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Core listens on localhost, so any process on the machine
 *           |  can reach /api/v1, including a command an agent runs
 *           |  through Ancile's own tools. Prove the caller is the
 *           |  owner before any route answers, reads included.
 *  How      |  An install key (32 random bytes, base64url) is made the
 *           |  first time Core starts and kept in Core's data folder as
 *           |  local-api.key, mode 0600. Two ways to present it:
 *           |    - `Authorization: Bearer <key>` for scripts and tools
 *           |    - an HttpOnly, SameSite=Strict session cookie for a
 *           |      browser, minted by the pairing route from a
 *           |      one-time code (60 s, single use), so the key itself
 *           |      never goes into an address or a history
 *           |  The cookie holds an HMAC of the key, not the key. Every
 *           |  comparison hashes both sides first and is constant time.
 *           |  accessFor() sorts routes into open (the pairing route),
 *           |  key (mint a code), session (approvals, grants,
 *           |  permissions, scopes, privacy and the other routes that
 *           |  decide what an agent may do) and any (the rest).
 *  Note     |  The key is never logged, never put in an error, and
 *           |  never put in a child process's environment: Core holds
 *           |  only a hash of it after start-up. Rotate it by deleting
 *           |  local-api.key and restarting Core (every script and
 *           |  browser then pairs again).
 * ------------------------------------------------------------------
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_KEY_FILE, PAIR_CODE_TTL_S, type PairCode, sessionCookieName } from '@nvx/contracts';

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** How long a paired browser stays paired. */
const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60;
/** Codes waiting to be redeemed; the oldest goes when this many are out. */
const MAX_OPEN_CODES = 20;

const sha = (s: string) => createHash('sha256').update(s).digest();
/** Equal secrets, compared as hashes so neither length nor content leaks through timing. */
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export const localKeyPath = (dataDir: string) => join(dataDir, LOCAL_KEY_FILE);

async function readKey(path: string): Promise<string | null> {
  try {
    const key = (await readFile(path, 'utf8')).trim();
    return KEY_SHAPE.test(key) ? key : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Owner-only on POSIX. On Windows the file inherits the user profile folder's access, which is enough. */
async function ownerOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) await chmod(path, 0o600);
}

export interface LocalKey {
  key: string;
  path: string;
  /** Made by this call (the first start), not read. */
  created: boolean;
}

/**
 * The install key: read it, or make it the first time. Two Cores starting at once end up with
 * the same key (the file is made whole under a temporary name and linked into place, which
 * never replaces a key that is already there). A file that is not a key is replaced.
 */
export async function ensureLocalKey(dataDir: string): Promise<LocalKey> {
  const path = localKeyPath(dataDir);
  await mkdir(dataDir, { recursive: true });
  const existing = await readKey(path);
  if (existing) {
    await ownerOnly(path);
    return { key: existing, path, created: false };
  }
  const key = randomBytes(32).toString('base64url');
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${key}\n`, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(tmp, path);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          // No hard links here (some file systems): a rename is the next best atomic step.
          await rename(tmp, path);
          break;
        }
        const theirs = await readKey(path);
        if (theirs) return { key: theirs, path, created: false };
        // Something is there that is not a key: clear it away and try again.
        if (attempt >= 3) {
          await rename(tmp, path);
          break;
        }
        await unlink(path).catch(() => undefined);
      }
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  await ownerOnly(path);
  return { key, path, created: true };
}

/** What a request presented. */
export interface Presented {
  /** `Authorization: Bearer <key>` with the right key. */
  bearer: boolean;
  /** The session cookie of a paired browser. */
  cookie: boolean;
}

export interface LocalAuthOptions {
  key: string;
  /** Core's port: it names the session cookie, so the dev and test profiles do not overwrite each other's. */
  port: number;
  now?: () => number;
}

export class LocalAuth {
  readonly cookieName: string;
  private readonly keyHash: Buffer;
  private readonly sessionToken: string;
  private readonly sessionHash: Buffer;
  /** sha256(code) → expiry. Hashed, so a lookup never depends on the code's content. */
  private readonly codes = new Map<string, number>();
  private readonly now: () => number;

  constructor(opts: LocalAuthOptions) {
    if (!KEY_SHAPE.test(opts.key)) throw new Error('The local API key is not 32 bytes of base64url.');
    this.cookieName = sessionCookieName(opts.port);
    this.keyHash = sha(opts.key);
    // The cookie is a different value from the key, so a copy of the cookie jar is not the key.
    this.sessionToken = createHmac('sha256', opts.key)
      .update('ancile.browser-session.v1')
      .digest('base64url');
    this.sessionHash = sha(this.sessionToken);
    this.now = opts.now ?? Date.now;
  }

  /** Which credentials this request carries. Never throws on malformed headers. */
  inspect(headers: { authorization?: string | undefined; cookie?: string | undefined }): Presented {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? '')?.[1];
    return {
      bearer: bearer !== undefined && same(sha(bearer), this.keyHash),
      cookie: this.cookieValues(headers.cookie).some((v) => same(sha(v), this.sessionHash)),
    };
  }

  private cookieValues(header: string | undefined): string[] {
    if (!header) return [];
    const out: string[] = [];
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      if (part.slice(0, eq).trim() === this.cookieName) out.push(part.slice(eq + 1).trim());
    }
    return out;
  }

  /** A single-use code that pairs one browser (POST /session/pair-codes). */
  mintPairCode(): PairCode {
    const at = this.now();
    for (const [h, exp] of this.codes) if (exp <= at) this.codes.delete(h);
    while (this.codes.size >= MAX_OPEN_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = randomBytes(32).toString('base64url');
    this.codes.set(sha(code).toString('hex'), at + PAIR_CODE_TTL_S * 1000);
    return { code, expires_in_s: PAIR_CODE_TTL_S };
  }

  /** Spend a code: true once, while it is fresh. */
  redeemPairCode(code: string): boolean {
    const h = sha(code).toString('hex');
    const exp = this.codes.get(h);
    this.codes.delete(h);
    return exp !== undefined && exp > this.now();
  }

  /** The Set-Cookie value that pairs a browser. */
  setCookie(secure: boolean): string {
    return [
      `${this.cookieName}=${this.sessionToken}`,
      `Max-Age=${SESSION_MAX_AGE_S}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }
}

/* ---- which routes need what ---------------------------------------------------- */

export type Access = 'open' | 'key' | 'session' | 'any';

export const isMutating = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

/** Routes the paired browser alone may use, whatever the method: they list or answer what agents asked. */
const SESSION_ALWAYS: RegExp[] = [/^\/approvals(\/|$)/, /^\/grants(\/|$)/, /^\/auto(\/|$)/];

/**
 * Routes where changing anything is the paired browser's alone (reading them is open to a
 * script with the key). The rule: a change to what agents may do, to where data goes, to what
 * runs unattended, or that deletes in bulk or cannot be taken back.
 *
 * What agents may do: permissions, scopes and tool presets, the privacy policy, MCP servers and
 * the apps allowed into Ancile's own MCP server, Claude Code's MCP servers, projects and session
 * folders, and answers to memory proposals and imports.
 *
 * Where data goes: API keys (and the GitHub token), models and providers (custom endpoints and
 * gateways can send prompts elsewhere), routing chains, OpenRouter routing, the compute provider,
 * testing a key against an address, finishing setup (it sets the permission preset).
 *
 * What runs unattended or beyond the window: automations (create, edit, enable, run now, delete),
 * Claude Code settings, sign-in and install, the lab's settings, the interpreter's claim and result
 * (only the window runs Python).
 *
 * Licence, sync and data safety: licence activation and refresh, Pro's sync (devices, settings;
 * also by feature, see pro/routes.ts), restoring a backup, tidying storage, emptying the Trash.
 * Deleting a notebook with everything in it is the same (see BULK_DELETE below).
 */
const SESSION_WRITES: RegExp[] = [
  // what agents may do
  /^\/permissions(\/|$)/,
  /^\/(notebooks|threads)\/[^/]+\/scope\/?$/,
  /^\/tool-presets(\/|$)/,
  /^\/privacy(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/claude-code\/(mcp-servers|projects)(\/|$)/,
  /^\/claude-code\/threads\/[^/]+\/folder\/?$/,
  /^\/memory\/proposals\/[^/]+\/?$/,
  /^\/memory\/imports\/[^/]+\/decide\/?$/,
  // where data goes
  /^\/credentials(\/|$)/,
  /^\/github\/token\/?$/,
  /^\/models(\/|$)/,
  /^\/routing(\/|$)/,
  /^\/openrouter\/routing\/?$/,
  /^\/compute\/provider\/?$/,
  /^\/setup\/(complete|providers\/test)\/?$/,
  // what runs unattended, and what only the window does
  /^\/automations(\/|$)/,
  /^\/claude-code\/(settings|sign-in|sign-out|install)\/?$/,
  /^\/lab\/settings\/?$/,
  /^\/interpreter\/requests\/[^/]+\/(claim|result)\/?$/,
  // licence, sync, data safety
  /^\/license(\/|$)/,
  /^\/pro\/(sync|licen[cs]e)(\/|$)/,
  /^\/system\/restore(\/|$)/,
  /^\/system\/startup\/restore\/?$/,
  /^\/system\/tidy\/?$/,
  /^\/threads\/trash\/empty\/?$/,
];

/**
 * Deleting a notebook is the Trash's gentle path; `?contents=delete` (or the older `?sources=delete`)
 * deletes it with everything in it. That form is the paired browser's alone.
 */
const NOTEBOOK_ID = /^\/notebooks\/[^/]+\/?$/;
const bulkDelete = (q: Record<string, string | undefined> | undefined) =>
  /^delete$/i.test(q?.contents ?? '') || /^delete$/i.test(q?.sources ?? '');

/** The pairing route and the route that mints its codes, as paths under /api/v1. */
const PAIR = /^\/session\/pair\/?$/;
const PAIR_CODES = /^\/session\/pair-codes\/?$/;

/** Collapse the ways one path can be written, so a rule cannot be walked around with `//` or `./`. */
export function cleanPath(path: string): string {
  const p = path
    .replace(/^\/api\/v1(?=\/|$)/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/\.(?=\/|$)/g, '');
  return p === '' ? '/' : p;
}

/**
 * What a route needs, given its method and its path (with or without the /api/v1 prefix) and, for the
 * few routes whose danger is in a query parameter, its query.
 */
export function accessFor(
  method: string,
  rawPath: string,
  query?: Record<string, string | undefined>,
): Access {
  const path = cleanPath(rawPath);
  const m = method.toUpperCase();
  if (PAIR.test(path) && m === 'GET') return 'open';
  if (PAIR_CODES.test(path)) return 'key';
  if (SESSION_ALWAYS.some((re) => re.test(path))) return 'session';
  if (isMutating(m) && SESSION_WRITES.some((re) => re.test(path))) return 'session';
  if (m === 'DELETE' && NOTEBOOK_ID.test(path) && bulkDelete(query)) return 'session';
  return 'any';
}

/** A next-page path that stays on this origin: `/` or `/something`, never `//host` or a scheme. */
export function safeNext(raw: string | undefined): string {
  if (!raw || !/^\/(?![/\\])[^\r\n\\]*$/.test(raw) || PAIR.test(cleanPath(raw.split('?')[0] ?? '')))
    return '/';
  return raw;
}
