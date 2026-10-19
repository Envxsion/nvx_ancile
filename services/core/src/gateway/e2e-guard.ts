/**
 * ------------------------------------------------------------------
 *  Title    |  Test-profile send guard
 *  Ref      |  docs/errors.md (e2e.real_model_blocked) · scripts/boot.mjs
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
 *  Note     |  Process-wide on purpose: a client built anywhere is
 *           |  covered. Off unless installed, so dev and prod are
 *           |  untouched.
 * ------------------------------------------------------------------
 */

import { AncileError, type ModelConfig } from '@nvx/contracts';

let active = false;

/** Turn the guard on for this process (the test profile). */
export function installSendGuard(profile: string | undefined): boolean {
  active = profile === 'e2e';
  return active;
}

export const sendGuardActive = (): boolean => active;

/** Tests only: back to off. */
export function resetSendGuard(): void {
  active = false;
}

export function realModelBlocked(what: string): AncileError {
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

/** Throws when the guard is on and the model is a real one. No network or CLI is touched before this. */
export function assertSendAllowed(m: Pick<ModelConfig, 'id' | 'provider' | 'via'>): void {
  if (active && !modelAllowedInTestProfile(m)) throw realModelBlocked(`a call to ${m.id}`);
}

/** Throws when the guard is on: Claude Code (its bridge, its CLI) is never driven by the test profile. */
export function assertClaudeCodeAllowed(): void {
  if (active) throw realModelBlocked('Claude Code');
}
