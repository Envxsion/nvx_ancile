import type { Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { toSdkMessages } from '../../src/gateway/convert';

describe('parts → provider messages', () => {
  it('splits one assistant turn into assistant and tool messages in order', () => {
    const parts: Part[] = [
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_call', call_id: 'c1', tool: 'fs_read', args: { path: 'a.md' } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: { content: 'A' } },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'It says A.' },
    ];
    const out = toSdkMessages([
      { role: 'user', content: 'what is in a.md?' },
      { role: 'assistant', content: '', parts },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'fs_read', input: { path: 'a.md' } },
      ],
    });
    expect(out[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'fs_read',
          output: { type: 'json', value: { content: 'A' } },
        },
      ],
    });
    expect(out[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'It says A.' }] });
  });

  it('tells the model plainly when a call was declined', () => {
    const out = toSdkMessages([
      {
        role: 'assistant',
        content: '',
        parts: [
          { type: 'tool_call', call_id: 'c1', tool: 'fs_write', args: {} },
          { type: 'tool_result', call_id: 'c1', ok: false, result: 'declined', declined_reason: 'not now' },
        ],
      },
    ]);
    expect(out[1]).toMatchObject({
      role: 'tool',
      content: [{ output: { type: 'error-text', value: 'The user declined this call: not now' } }],
    });
  });

  it('drops a tool call that never got a result, which every provider would reject', () => {
    const out = toSdkMessages([
      {
        role: 'assistant',
        content: '',
        parts: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_call', call_id: 'c9', tool: 'x', args: {} },
        ],
      },
    ]);
    expect(out).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] }]);
  });

  it('keeps plain-text messages as they are', () => {
    expect(
      toSdkMessages([
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ]),
    ).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
  });
});
