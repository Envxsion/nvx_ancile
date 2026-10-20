/**
 * ------------------------------------------------------------------
 *  Title    |  Test-profile and live-test send guard
 *  Ref      |  docs/errors.md (e2e.real_model_blocked, live.cap_reached) · scripts/boot.mjs · docs/testing.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  In the test profile (ANCILE_PROFILE=e2e, `pnpm start:e2e`)
 *           |  nothing may reach a real model, key, plan or paid node.
 *           |  The suite types into real composers, so a stray default
 *           |  must fail loudly instead of spending money.
 *  How      |  main.ts installs the guard once at boot. The two lowest
 *           |  points every model call passes through ask it first:
 *           |  RoutingClient.stream (the gateway, Claude Code as a model,
 *           |  engines, flows, fact-check, memory, auto-review, lab) and
 *           |  languageModelFor (the AI SDK client and "test this key").
 *           |  The Claude bridge and the Claude CLI ask too. Allowed:
 *           |  the built-in fake provider (fake/*, offline/*) and models
 *           |  on the Controller, which the profile forces to its fake
 *           |  provider (scripts/runtime.mjs).
 *           |
 *           |  Live mode (LT1, `pnpm test:live`): with ANCILE_LIVE_ALLOW
 *           |  (a comma list of model ids) the same two points refuse every
 *           |  model but those ids and the fake provider; the Claude bridge
 *           |  and CLI stay refused; and the direct calls that bypass the
 *           |  gateway (image providers, the Jev reviewers) are refused too.
 *           |  ANCILE_LIVE_CAP_USD (default 2) caps the spend: Core adds up
 *           |  what every call billed, and refuses with live.cap_reached
 *           |  once the total plus an estimate of the next call would pass it.
 *  Note     |  Process-wide on purpose: a client built anywhere is
 *           |  covered. Off unless installed, so dev and prod are
 *           |  untouched. The test profile wins if both are set.
 * ------------------------------------------------------------------
 */

import { AncileError, type ModelConfig } from '@nvx/contracts';
import type { ModelRequest } from './types';
import { priceOf } from './usage';

let active = false;

/** Turn the guard on for this process (the test profile). */
export function installSendGuard(profile: string | undefined): boolean {
  active = profile === 'e2e';
  return active;
}

/** Is any guard on: the test profile, or a live test run? */
export const sendGuardActive = (): boolean => active || live !== null;

/** Is it the test profile (nothing real may be called, whatever a live list says)? */
export const testProfileActive = (): boolean => active;

/** Tests only: back to off. */
export function resetSendGuard(): void {
  active = false;
  live = null;
}

/* ---- live mode ---------------------------------------------------------------- */

/** The default cap on a live run's spend, US dollars. */
export const LIVE_CAP_DEFAULT_USD = 2;

interface LiveState {
  allow: ReadonlySet<string>;
  capUsd: number;
  /** What finished calls billed, in this process. */
  spentUsd: number;
  /** The estimates of calls still running, so two at once cannot both pass the cap. */
  pendingUsd: number;
}

let live: LiveState | null = null;

/** The ids in ANCILE_LIVE_ALLOW: split on commas, trimmed, empty ones dropped. */
export function parseLiveAllow(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

/** ANCILE_LIVE_CAP_USD: a positive number, else the default. */
export function parseLiveCap(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : LIVE_CAP_DEFAULT_USD;
}

/**
 * Turn live mode on for this process. Unset or empty `allow` leaves everything as it was. The test profile
 * wins: it allows nothing real, so a list beside it is ignored. Returns whether live mode is on.
 */
export function installLiveGuard(allow: string | undefined, cap: string | undefined): boolean {
  const ids = parseLiveAllow(allow);
  live =
    ids.length > 0 && !active
      ? { allow: new Set(ids), capUsd: parseLiveCap(cap), spentUsd: 0, pendingUsd: 0 }
      : null;
  return live !== null;
}

export const liveGuardActive = (): boolean => live !== null;

/** What live mode allows and has spent, for the boot log; null when it is off. */
export function liveStatus(): { allow: string[]; cap_usd: number; spent_usd: number } | null {
  return live ? { allow: [...live.allow], cap_usd: live.capUsd, spent_usd: live.spentUsd } : null;
}

/** Live mode: running total of what calls billed in this process. */
export const liveSpentUsd = (): number => live?.spentUsd ?? 0;

const money = (n: number) => `$${n.toFixed(4)}`;

export function liveCapReached(spent: number, estimate: number, cap: number, what: string): AncileError {
  return new AncileError({
    code: 'live.cap_reached',
    title: `The live test cap was reached before ${what}`,
    hint: `This run may spend at most ${money(cap)} (ANCILE_LIVE_CAP_USD). It has spent ${money(spent)} and the next call is estimated at ${money(estimate)}. Nothing was sent. Raise the cap on purpose, or stop here.`,
    status: 403,
    // Not fallbackable: the chain stops here instead of spending on another model.
    errorClass: 'bug',
    retryable: false,
    context: { spent_usd: spent, estimate_usd: estimate, cap_usd: cap },
  });
}

/** Tokens in a request, roughly (four characters each): for the estimate before a call, not for the receipt. */
function requestTokens(req: ModelRequest): number {
  let chars = 0;
  try {
    chars = JSON.stringify({ s: req.system, b: req.systemBlocks, m: req.messages, t: req.tools }).length;
  } catch {
    chars = 0;
  }
  return Math.ceil(chars / 4);
}

/** The most this call could cost: the whole prompt at the fresh input price, and a full answer. */
export function estimateCallUsd(m: ModelConfig, req: ModelRequest): number {
  return priceOf(m, {
    inputTokens: requestTokens(req),
    outputTokens: req.maxOutputTokens ?? m.max_output ?? 4_096,
  });
}

/**
 * Live mode: set aside the estimate for a call about to go out, or refuse it with live.cap_reached when the
 * total so far, plus every call in flight, plus this one would pass the cap. Returns what was set aside, to
 * hand back to settleLive. Off, or the fake provider: 0.
 */
export function reserveLive(m: Pick<ModelConfig, 'id' | 'provider'>, estimateUsd: number): number {
  if (!live || m.provider === 'fake') return 0;
  if (live.spentUsd + live.pendingUsd + estimateUsd > live.capUsd)
    throw liveCapReached(live.spentUsd + live.pendingUsd, estimateUsd, live.capUsd, `a call to ${m.id}`);
  live.pendingUsd += estimateUsd;
  return estimateUsd;
}

/** Live mode: a call ended. Give back what was set aside and count what it billed (billed_usd, else cost_usd). */
export function settleLive(reserved: number, billedUsd: number): void {
  if (!live) return;
  live.pendingUsd = Math.max(0, live.pendingUsd - reserved);
  live.spentUsd += Math.max(0, billedUsd);
}

/**
 * Live mode: a direct call that does not go through the gateway (an image provider, a Jev reviewer) is
 * refused outright, whatever the list says: none of them can be priced or capped here.
 */
export function assertDirectCallAllowed(what: string): void {
  if (live) throw realModelBlocked(what, true);
}

export function realModelBlocked(what: string, inLive = false): AncileError {
  if (inLive)
    return new AncileError({
      code: 'e2e.real_model_blocked',
      title: `The live test run blocked ${what}`,
      hint: `A live test run (ANCILE_LIVE_ALLOW) may only call the models it lists${live ? ` (${[...live.allow].join(', ')})` : ''} and the offline ones. Nothing was sent. Restart the stack normally (pnpm start) for everyday use.`,
      status: 403,
      // Not fallbackable, as in the test profile.
      errorClass: 'bug',
      retryable: false,
    });
  return new AncileError({
    code: 'e2e.real_model_blocked',
    title: `The test profile blocked ${what}`,
    hint: 'Tests may only use the offline models (offline/echo, offline/test). Nothing was sent. Pick an offline model, or run the everyday stack (pnpm start) for real models.',
    status: 403,
    // Not fallbackable: a chain must stop here, not quietly move on to something else.
    errorClass: 'bug',
    retryable: false,
  });
}

/** Is this model one the test profile may call? The fake provider, and models on the (fake) Controller. */
export function modelAllowedInTestProfile(m: Pick<ModelConfig, 'provider' | 'via'>): boolean {
  return m.provider === 'fake' || m.via === 'controller';
}

/** Live mode: the fake provider, and the ids the run listed. */
export function modelAllowedInLive(m: Pick<ModelConfig, 'id' | 'provider'>): boolean {
  return m.provider === 'fake' || (live?.allow.has(m.id) ?? false);
}

/** Throws when a guard is on and the model is one it does not allow. No network or CLI is touched before this. */
export function assertSendAllowed(m: Pick<ModelConfig, 'id' | 'provider' | 'via'>): void {
  if (active && !modelAllowedInTestProfile(m)) throw realModelBlocked(`a call to ${m.id}`);
  if (live && !modelAllowedInLive(m)) throw realModelBlocked(`a call to ${m.id}`, true);
}

/** Is Claude Code (its bridge, its CLI) kept out of this process? Always, in the test profile and in live mode. */
export const claudeCodeBlocked = (): boolean => active || live !== null;

/** Throws when a guard is on: Claude Code (its bridge, its CLI) is never driven by a test run, Mode A or B. */
export function assertClaudeCodeAllowed(): void {
  if (active) throw realModelBlocked('Claude Code');
  if (live) throw realModelBlocked('Claude Code', true);
}
