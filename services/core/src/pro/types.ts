/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the contract
 *  Ref      |  DESIGN.md §9, packages/contracts/src/pro.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What Core hands Pro (ProHost) and what Pro gives back
 *           |  (ProModule). Public, so the free build and the private
 *           |  pro/ repository agree on one shape.
 *  How      |  Pro is given everything it needs: it imports no npm
 *           |  package and no Core internals at run time, so a change
 *           |  inside Core cannot break it silently.
 * ------------------------------------------------------------------
 */

import type { AncileError, license, pro } from '@nvx/contracts';
import type { KeyMap, Verified } from '../license/verify';
import type { SecretStore } from '../secrets';
import type { SettingsStore } from '../settings';

export interface ProLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** What Core lends Pro. */
export interface ProHost {
  settings: SettingsStore;
  /** Encrypted at rest (the claim key lives here, never in settings). */
  secrets: SecretStore;
  log: ProLog;
  fetch: typeof fetch;
  AncileError: typeof AncileError;
  /** Offline token check (public: services/core/src/license/verify.ts). */
  verify: (token: string, deviceId: string) => Verified;
  keys: KeyMap;
  /** The free edition's status, and how each Pro feature is described. */
  freeStatus: license.LicenseStatus;
  featureList: (status: license.LicenseStatus) => license.LicenseDetails['features'];
  licenseUrl: string;
  /** A name for this computer the licence server can show ("Ana's laptop"). */
  deviceLabel: string;
  version: string;
}

/** Turning Pro on and keeping it on: Admin → Licence talks to this. */
export interface ProLicense {
  start(): Promise<void>;
  stop(): void;
  status(): license.LicenseStatus;
  details(): Promise<license.LicenseDetails>;
  activate(key: string, opts?: { transfer?: boolean }): Promise<license.LicenseDetails>;
  refresh(): Promise<license.LicenseDetails>;
  deactivate(): Promise<license.LicenseDetails>;
}

/** A tiny SQL surface (postgres.js underneath): Pro keeps its own tables in the `pro` schema. */
export interface ProDb {
  /** Parameters are $1, $2…; rows come back as plain objects. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Several statements, all or nothing. */
  transaction<T>(fn: (tx: Pick<ProDb, 'query'>) => Promise<T>): Promise<T>;
}

/** The Controller's control plane (/control/v1/*), already authenticated. */
export interface ProController {
  configured: boolean;
  get<T>(path: string): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

/** Who is asking. The free build always answers with the one owner. */
export interface Principal {
  userId: string;
  workspaceId: string;
  /** owner | admin | member | viewer. The free owner is "owner". */
  role: 'owner' | 'admin' | 'member' | 'viewer';
  name: string;
  /** How they signed in: the free build's single owner, a session, or a service. */
  via: 'owner' | 'session' | 'service';
}

export interface ProNotice {
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  body?: string;
  action?: { label: string; href: string };
  category?: 'approvals' | 'runs' | 'sources' | 'health' | 'memory';
}

/**
 * The parts of the workspace sync can carry. Core owns the data; Pro only
 * moves opaque records between devices. A record is the whole current
 * state of one item (last writer wins per record, by hybrid clock).
 */
export interface ProSyncSource {
  collections: readonly string[];
  /** Items changed since an ISO time (null = everything), newest state only. */
  changes(
    collection: string,
    since: string | null,
  ): Promise<{ id: string; updatedAt: string; data: unknown }[]>;
  /** Write items that arrived from another device. Returns how many were applied. */
  apply(collection: string, items: { id: string; data: unknown; deleted: boolean }[]): Promise<number>;
}

/** What Core lends Pro beyond the licence (Phase 6 Pro features). */
export interface ProServices {
  db: ProDb;
  controller: ProController;
  notify(n: ProNotice): void;
  /** Read the licence at the moment of use: features are checked when they run, not when they load. */
  hasFeature(feature: pro.ProFeature): boolean;
  /** The workspace's own data, for sync. */
  sync?: ProSyncSource;
  /** The single owner of a free install: Teams starts from them. */
  owner: { userId: string; workspaceId: string };
  now(): Date;
}

/** One HTTP route Pro serves under /api/v1/pro, behind a feature. */
export interface ProRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Hono-style path under /api/v1/pro, e.g. "/fleet/groups/:id". */
  path: string;
  feature: pro.ProFeature;
  /** Lowest role that may call it (team workspaces). Defaults to member for writes, viewer for reads. */
  role?: Principal['role'];
  /** Reachable before sign-in (the sign-in routes themselves). */
  public?: boolean;
  handler(req: ProRequest): Promise<ProResponse>;
}

export interface ProRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  principal: Principal | null;
  headers: Record<string, string>;
}

export interface ProResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Who is asking, for every /api/v1 request. The free build's provider
 * always answers with the single owner; Teams (Pro) answers from a
 * session and may say nobody (sign in first).
 */
export interface IdentityProvider {
  resolve(headers: Record<string, string>): Promise<Principal | null>;
  /** Paths (under /api/v1) reachable without a principal, e.g. sign-in. */
  open?: (path: string) => boolean;
}

/** The private module's default export: `createPro(host)`. */
export interface ProModule {
  build: 'pro';
  license: ProLicense;
  /** Start Pro's background work (migrations, schedules, sync) once Core is up. */
  start?(services: ProServices): Promise<void>;
  stop?(): void;
  routes?: ProRoute[];
  /** Teams replaces the single-owner identity while it is turned on. */
  identity?: IdentityProvider;
}

export type CreatePro = (host: ProHost) => ProModule | Promise<ProModule>;
