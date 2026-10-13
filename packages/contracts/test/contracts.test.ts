import { describe, expect, it } from 'vitest';
import {
  AncileError,
  ApiError,
  ClaudeCodeBinding,
  claudeCodeLean,
  claudeCodeSetupLine,
  GlobalEvent,
  idSchema,
  license,
  PatchThreadRequest,
  RunEvent,
  SendMessageRequest,
} from '../src';

describe('ids', () => {
  it('accepts prefixed ULIDs and rejects the wrong kind', () => {
    const thread = idSchema('thread');
    expect(thread.safeParse('thr_01J9Z3K8Q4V6W2X5Y7Z9A1B3C4').success).toBe(true);
    expect(thread.safeParse('msg_01J9Z3K8Q4V6W2X5Y7Z9A1B3C4').success).toBe(false);
    expect(thread.safeParse('thr_01J9Z3K8Q4V6W2X5Y7Z9A1B3CU').success).toBe(false); // U is not Crockford
  });
});

describe('errors', () => {
  it('serialises AncileError to the one ApiError shape', () => {
    const err = new AncileError({
      code: 'provider.auth_failed',
      title: 'Key refused',
      hint: 'Update the key',
      status: 401,
    });
    const body = err.toJSON('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ApiError.parse(body).error.code).toBe('provider.auth_failed');
    expect(body.error.retryable).toBe(false);
  });
});

describe('events', () => {
  it('parses run and global events by discriminant', () => {
    const delta = RunEvent.parse({
      seq: 3,
      at: '2026-10-07T00:00:00Z',
      type: 'text.delta',
      message_id: 'msg_x',
      delta: 'Hi',
    });
    expect(delta.type).toBe('text.delta');
    expect(() => RunEvent.parse({ seq: 1, at: 'x', type: 'nope' })).toThrow();
    const op = GlobalEvent.parse({
      seq: 1,
      at: 'x',
      type: 'node.operation',
      operation_id: 'opn_x',
      node_id: 'nod_x',
      action: 'start',
      status: 'acknowledged',
      detail: 'Pod accepted the request',
    });
    expect(op.type).toBe('node.operation');
  });
});

describe('api', () => {
  it('rejects unknown keys on send', () => {
    const ok = SendMessageRequest.safeParse({ parent_id: null, parts: [{ type: 'text', text: 'hello' }] });
    expect(ok.success).toBe(true);
    const bad = SendMessageRequest.safeParse({
      parent_id: null,
      parts: [{ type: 'text', text: 'x' }],
      sneaky: 1,
    });
    expect(bad.success).toBe(false);
  });
});

describe('licence', () => {
  it('validates claim keys in the family format', () => {
    expect(license.ClaimKey.safeParse('NVX-7K2M-Q9PX-4HTV').success).toBe(true);
    expect(license.ClaimKey.safeParse('NVX-7K2M-Q9PX-4HTU').success).toBe(false); // U excluded
  });
});

describe('lean Claude Code sessions', () => {
  const base = { session_id: 's', cwd: 'C:/app', last_uuid: null, synced_at: '2026-10-13T00:00:00Z' };

  it('defaults lean on for threads started in NVX Ancile and off for imported ones', () => {
    expect(claudeCodeLean(ClaudeCodeBinding.parse({ ...base, started_in: 'ancile' }))).toBe(true);
    expect(claudeCodeLean(ClaudeCodeBinding.parse({ ...base, started_in: 'import' }))).toBe(false);
    expect(claudeCodeLean(ClaudeCodeBinding.parse(base))).toBe(false); // from before the marker: imported
    expect(claudeCodeLean({ started_in: 'ancile', lean: false })).toBe(false);
    expect(claudeCodeLean({ started_in: 'import', lean: true })).toBe(true);
    expect(ClaudeCodeBinding.safeParse({ ...base, started_in: 'elsewhere' }).success).toBe(false);
  });

  it('takes the toggle on PATCH /threads/:id', () => {
    expect(PatchThreadRequest.parse({ claude_code_lean: true })).toEqual({ claude_code_lean: true });
    expect(PatchThreadRequest.safeParse({ claude_code_lean: 'yes' }).success).toBe(false);
  });

  it('says what a lean first turn saved, or just that it is lean', () => {
    const r = { lean: true, first_turn: true, full_first_turn_tokens: 162_000 };
    expect(claudeCodeSetupLine(r, 20_000)).toContain('142,000 fewer');
    expect(claudeCodeSetupLine({ ...r, full_first_turn_tokens: null }, 20_000)).toMatch(
      /^Lean session: only/,
    );
    expect(claudeCodeSetupLine({ ...r, first_turn: false }, 20_000)).toBeNull();
    expect(claudeCodeSetupLine({ ...r, lean: false }, 20_000)).toBeNull();
    expect(claudeCodeSetupLine(r, 20_000)).not.toMatch(/\u2014/);
  });
});
