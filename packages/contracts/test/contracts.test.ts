import { describe, expect, it } from 'vitest';
import { AncileError, ApiError, GlobalEvent, idSchema, license, RunEvent, SendMessageRequest } from '../src';

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
