/**
 * "Connect this browser": Core answers only its owner, so a browser that has
 * not been paired gets 401 auth.local_key_required. The Cockpit shows one quiet
 * screen that says what to do, instead of a workspace full of failed requests,
 * and never asks for or shows a key.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectScreen, useConnectGate } from '../src/app/ConnectScreen';
import { ApiCallError, api } from '../src/lib/api';

const refuse = (code: string, status = 401) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        error: {
          code,
          title: 'This browser or tool is not connected to NVX Ancile',
          hint: 'Run `pnpm pair`.',
          retryable: false,
          trace_id: 'a'.repeat(32),
          attempts: [],
          context: { service: 'core' },
        },
      }),
      { status, headers: { 'content-type': 'application/json', 'x-trace-id': 'a'.repeat(32) } },
    ),
  );

beforeEach(() => useConnectGate.setState({ needed: false }));
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  delete (window as { __NVX_DESKTOP__?: unknown }).__NVX_DESKTOP__;
});

describe('the connect gate', () => {
  it('goes up when Core says this browser is not connected', async () => {
    refuse('auth.local_key_required');
    const err = await api.get('/threads').catch((e) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(useConnectGate.getState().needed).toBe(true);
  });

  it('stays down for any other refusal, including the browser-session one', async () => {
    refuse('auth.browser_session_required', 403);
    await api.post('/approvals/apr_1', { decision: 'approve' }).catch(() => undefined);
    expect(useConnectGate.getState().needed).toBe(false);
    refuse('request.not_found', 404);
    await api.get('/threads/thr_x').catch(() => undefined);
    expect(useConnectGate.getState().needed).toBe(false);
  });
});

describe('the connect screen', () => {
  it('says to run pnpm pair, in plain words, and asks for nothing', () => {
    render(<ConnectScreen />);
    expect(screen.getByRole('heading', { name: 'Connect this browser' })).toBeTruthy();
    expect(screen.getByText('pnpm pair')).toBeTruthy();
    expect(screen.getByText(/desktop app connects itself/i)).toBeTruthy();
    // Nothing to type: the screen never takes a key.
    expect(screen.queryByRole('textbox')).toBeNull();
    // No em dashes in copy.
    expect(document.body.textContent).not.toContain('—');
  });

  it('says a pairing link was spent or has expired when it comes back with pair=failed', () => {
    window.history.replaceState(null, '', '/?pair=failed');
    render(<ConnectScreen />);
    expect(screen.getByRole('status').textContent).toMatch(/used or has expired/i);
  });

  it('tells the desktop app to restart, not to run a command', () => {
    (window as { __NVX_DESKTOP__?: unknown }).__NVX_DESKTOP__ = { version: '0.1.2' };
    render(<ConnectScreen />);
    expect(screen.queryByText('pnpm pair')).toBeNull();
    expect(screen.getByText(/open it again/i)).toBeTruthy();
  });
});
