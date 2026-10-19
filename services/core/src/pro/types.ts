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
  /** The licence clock (never earlier than any time seen before); Date.now when absent. */
  now?: () => number;
  /** Where the Cockpit is served (ANCILE_PUBLIC_URL). */
  publicUrl?: string;
  /**
   * Every origin Core accepts changes from (requestGuard): a page opened
   * anywhere else can read but not write. Absent: not known (tests).
   */
  allowedOrigins?: readonly string[];
}

/** Turning Pro on and keeping it on: Admin → Licence talks to this. */
export interface ProLicense {
  start(): Promise<void>;
  stop(): void;
  status(): license.LicenseStatus;
  /**
   * What the licence holds, as the person asking may use it: `who` is the
   * request's principal (null: nobody signed in). Absent: the install as a
   * whole (the owner's view).
   */
  details(who?: Principal | null): Promise<license.LicenseDetails>;
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
  /**
   * Has a Pro seat: may use the Pro features the licence includes. False
   * for a team member the owner has not given one; Pro's routes and
   * checks then refuse them (pro.seat_required). Absent means true.
   */
  pro?: boolean;
}

export interface ProNotice {
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  body?: string;
  action?: { label: string; href: string };
  category?: 'approvals' | 'runs' | 'sources' | 'health' | 'memory';
}

/**
 * One changed item. A `local` item belongs to a notebook or thread whose
 * scope keeps everything on this machine (docs/scopes.md): it comes without
 * its data, so sync can never carry it.
 */
export type ProSyncChange =
  | { id: string; updatedAt: string; data: unknown; local?: false }
  | { id: string; updatedAt: string; local: true };

/**
 * The parts of the workspace sync can carry. Core owns the data and the
 * scopes; Pro only moves opaque records between devices. A record is the
 * whole current state of one item (last writer wins per record, by hybrid
 * clock). Scopes are read at the moment of asking, never from a cache.
 */
export interface ProSyncSource {
  collections: readonly string[];
  /**
   * Items changed since an ISO time (null = everything), newest state only.
   * One whose place keeps data on this machine comes as `local`, without
   * data. `withdrawn` adds places another device withdrew (keys as from
   * localPlaces): what is in them is treated as local here too.
   */
  changes(collection: string, since: string | null, withdrawn?: readonly string[]): Promise<ProSyncChange[]>;
  /**
   * Write items that arrived from another device. Returns how many were
   * applied. A deleted item carries no content: the copy here, if there is
   * one, is marked deleted.
   */
  apply(collection: string, items: { id: string; data: unknown; deleted: boolean }[]): Promise<number>;
  /** One item as it is here now (null if absent): kept aside when another device's change replaces it. */
  read(collection: string, id: string): Promise<unknown | null>;
  /**
   * The places whose scope keeps everything on this machine now, as
   * "notebook:<id>" and "thread:<id>". A thread in such a notebook is listed
   * too, so moving a thread into one changes the list.
   */
  localPlaces(): Promise<string[]>;
  /** Every item in these places (keys from localPlaces), deleted ones included. */
  itemsIn(places: readonly string[]): Promise<{ collection: string; id: string }[]>;
  /**
   * Which of these arriving items belong to a place that keeps data here (or
   * one of `withdrawn`), by their own data or by the copy here. They are
   * never applied.
   */
  localOnly(
    collection: string,
    items: { id: string; data: unknown }[],
    withdrawn?: readonly string[],
  ): Promise<Set<string>>;
  /**
   * Take away copies another device withdrew (it now keeps them on that
   * machine only): marked deleted, with their content cleared. Returns how
   * many were here.
   */
  remove(collection: string, ids: string[]): Promise<number>;
}

/** A message as Pro's answer features see it: its text, never its raw parts. */
export interface ProMessage {
  id: string;
  thread_id: string;
  parent_id: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  status: string;
  model_id: string | null;
  edit_of_id: string | null;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number } | null;
  provenance: Record<string, unknown>;
  created_at: string;
}

export interface ProModelInfo {
  id: string;
  name: string;
  provider: string;
  /** Can answer now (key present, switched on). */
  ready: boolean;
  problem: string | null;
  price: { input_per_mtok: number; output_per_mtok: number };
  /** Runs on this computer or a node you control (Ollama, local, a GPU node). */
  local?: boolean;
}

export interface ProCompletion {
  text: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ms: number;
}

/** What one off-the-record run of a flow produced (flows/try.ts runFlowOnce). */
export type ProFlowOnce = import('../flows/try').FlowOnceResult;

/**
 * Threads, answers, models and flows, lent to Pro's answer features (Beam,
 * Insights, the Flow lab). Every write goes through Core's own paths, so
 * permissions, memory and the branch tree behave as for any answer.
 */
export interface ProAnswers {
  threads: {
    get(id: string): Promise<{
      id: string;
      title: string;
      notebook_id: string | null;
      active_head_id: string | null;
    } | null>;
    create(opts: { notebookId: string | null; title?: string }): Promise<{ id: string }>;
    message(id: string): Promise<ProMessage | null>;
    /** The messages from the root to this one, in order. */
    path(messageId: string): Promise<ProMessage[]>;
    /** An answer is being written in this thread now. */
    busy(threadId: string): Promise<boolean>;
    setHead(threadId: string, messageId: string): Promise<void>;
  };
  turns: {
    /** Core's startTurn: the same checks, memory, grounding and branch tree as any answer. */
    start(req: {
      threadId: string;
      user: { existingId: string } | { parentId: string | null; text: string };
      model?: string | null;
      flowId?: string;
      detached?: boolean;
      instructions?: string;
      provenanceExtra?: Record<string, unknown>;
    }): Promise<{ run_id: string; user_message_id: string; assistant_message_id: string }>;
    /** Resolves with the run's final status. */
    wait(runId: string, signal?: AbortSignal): Promise<{ status: string }>;
  };
  models: {
    list(): ProModelInfo[];
    /** The model a plain chat would use now, or null when none can answer. */
    defaultChat(): string | null;
    /** One answer, not streamed and not saved anywhere. Fallbacks apply. */
    complete(
      model: string | null,
      req: { system?: string; prompt: string; maxOutputTokens?: number; temperature?: number },
      signal?: AbortSignal,
    ): Promise<ProCompletion>;
  };
  flows: {
    get(id: string, version?: number | null): Promise<import('@nvx/contracts').Flow | null>;
    list(): Promise<{ id: string; name: string; active: boolean; scope: string; scope_ref: string | null }[]>;
    /** The flow that answers in this notebook (or the workspace) now. */
    activeFor(notebookId: string | null): Promise<{ id: string; name: string } | null>;
    runOnce(opts: {
      flowId: string;
      version?: number | null;
      text: string;
      threadId?: string | null;
      headId?: string | null;
      notebookId?: string | null;
      mock?: boolean;
      signal: AbortSignal;
    }): Promise<ProFlowOnce>;
    decisions(flowId: string, nodeId?: string): Promise<import('@nvx/contracts').RouteDecisionRecord[]>;
  };
  notebooks: {
    list(): Promise<{ id: string; title: string }[]>;
  };
  /** A quick fact-check of an answer: confidence 0–1 (null: could not tell). */
  factcheck(
    answer: string,
    opts: { question: string; notebookId: string | null; signal: AbortSignal },
  ): Promise<{ confidence: number | null; summary: string }>;
  /** Memory commits, newest first (Insights: how memory grows). */
  memoryHistory(limit: number): Promise<{ at: string }[]>;
}

/**
 * What context packs (Pro) need from Core: sources through the knowledge
 * service, a thread's summary, a place's instructions, and the scope check
 * that decides whether a pack may be attached somewhere. Notes and memory
 * entries Pro reads from Core's tables itself.
 */
export interface ProPackHost {
  /** One source with its extracted text (null when it is gone or not in this workspace). */
  sourceText(
    id: string,
  ): Promise<{ id: string; title: string; kind: string; content_hash: string | null; text: string } | null>;
  /** Notes of a notebook, by id (others are left out). */
  notes(notebookId: string, ids: string[]): Promise<{ id: string; title: string; content_md: string }[]>;
  /** Memory entries by id, as the memory index holds them. */
  memoryEntries(ids: string[]): Promise<{ id: string; path: string; text: string }[]>;
  /** The sources a notebook holds now. */
  notebookSources(notebookId: string): Promise<{ id: string; title: string }[]>;
  /** Add pasted text as a source (an imported pack's source), optionally into a notebook. */
  addTextSource(input: { title: string; text: string; notebookId: string | null }): Promise<{ id: string }>;
  /** A thread's summary, or a digest of its latest turns; null when it has neither. */
  summaryOf(threadId: string): Promise<string | null>;
  /** The instructions and persona set on a notebook or thread. */
  instructionsOf(
    place: import('@nvx/contracts').packs.PackOrigin,
  ): Promise<{ instructions: string; persona: string }>;
  /** A place's title in this workspace, and its notebook (a thread's); null when it is not here. */
  place(
    place: import('@nvx/contracts').packs.PackOrigin,
  ): Promise<{ title: string; notebookId: string | null } | null>;
  /** Nothing may leave this machine here (a private notebook, or data leaving switched off). */
  keepsLocal(place: import('@nvx/contracts').packs.PackOrigin): Promise<boolean>;
  /** May a pack made from these places be attached to `target`? Both scopes, as a context link. */
  checkAttach(
    target: import('@nvx/contracts').packs.PackTarget,
    pack: { name: string; local_only: boolean; origins: import('@nvx/contracts').packs.PackOrigin[] },
  ): Promise<{ ok: true } | { ok: false; code: string; reason: string }>;
}

/** Points in Core's own work where Pro may take part. Each is optional and may not fail Core. */
export interface ProHooks {
  /** Context packs attached to this thread or its notebook, for one turn. Core checks every scope. */
  turnContext?(q: {
    threadId: string;
    notebookId: string | null;
  }): Promise<import('../links/service').PackTurnContext[]>;
  /** An answer was saved (Flow lab: a shadow flow answers the same question off the record). */
  afterAnswer?(a: import('../conductor/pipeline').AnsweredTurn): Promise<void>;
  /** A router asks whether its route is already known (Flow lab: learned from your choices). */
  routeHint?(
    q: import('../flows/execute').RouteHintQuery,
  ): Promise<import('../flows/execute').RouteHint | null>;
}

/**
 * Approvals, lent to Pro's desktop extras. The answer goes through Core's
 * own route (the gate, the decision log, the run resuming), never around it.
 */
export interface ProApprovals {
  /** One approval as it stands now, or null when it is gone. */
  get(id: string): Promise<{
    id: string;
    status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
    tier: 'gated' | 'critical';
    tool: string;
    resource: string;
    thread_id: string | null;
  } | null>;
  /** Approve or deny one request "just this once": no grant is left behind. */
  decideOnce(id: string, decision: 'approve' | 'deny', reason?: string): Promise<{ status: string }>;
}

/**
 * The desktop app's Pro extras (feature `desktop`). Core asks Pro at the
 * moment of use, and every answer is checked against the licence first, so a
 * lapse takes them away at once. The desktop shell never sees any of this
 * code: it polls Core, and Core asks Pro.
 */
export interface ProDesktop {
  /**
   * The buttons a native notification for this approval may carry. Empty for
   * a critical request, which is only ever answered in the app.
   */
  notificationActions(a: {
    id: string;
    tier: 'gated' | 'critical';
  }): Promise<{ id: 'approve' | 'deny'; label: string }[]>;
  /**
   * A button on a notification was pressed. Refuses a critical request or one
   * that is no longer waiting; otherwise answers it once, on the exact thing
   * asked about (the narrowest pattern there is).
   */
  decideFromNotification(approvalId: string, action: 'approve' | 'deny'): Promise<{ status: string }>;
  /** Scheduled automations and compute idle-stop timers keep going with the window hidden. */
  keepsJobsInBackground(): boolean;
}

/** What Core lends Pro beyond the licence (Phase 6 Pro features). */
export interface ProServices {
  /** Approvals, for the notification buttons. */
  approvals?: ProApprovals;
  /** Threads, turns, models and flows for Beam, Insights and the Flow lab. */
  answers?: ProAnswers;
  db: ProDb;
  controller: ProController;
  notify(n: ProNotice): void;
  /**
   * Read the licence at the moment of use: features are checked when they
   * run, not when they load. With `who`, also that this person has a Pro
   * seat (Principal.pro); without, the install as a whole.
   */
  hasFeature(feature: pro.ProFeature, who?: Principal | null): boolean;
  /** The workspace's own data, for sync. */
  sync?: ProSyncSource;
  /** Sources, summaries, instructions and scope checks for context packs. */
  packs?: ProPackHost;
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
  /**
   * Lowest role that may call it (team workspaces). Defaults to member for
   * writes, viewer for reads. A route may let a viewer write (their own
   * passphrase): Core leaves the role check under /pro to this.
   */
  role?: Principal['role'];
  /** Reachable before sign-in (the sign-in routes themselves). */
  public?: boolean;
  /**
   * false: a member without a Pro seat may call it too (a team's own
   * sign-in, member list and each person's account). Default: a seat is
   * needed (Principal.pro).
   */
  seat?: false;
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
  /** Told about every change made (writes), after it is answered: a team's audit log. */
  record?(principal: Principal, req: { method: string; path: string; status: number }): Promise<void>;
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
  /** Where Pro takes part in answering (shadow flows, a router that learns). */
  hooks?: ProHooks;
  /** The desktop app's extras: notification buttons and background jobs. */
  desktop?: ProDesktop;
}

export type CreatePro = (host: ProHost) => ProModule | Promise<ProModule>;
