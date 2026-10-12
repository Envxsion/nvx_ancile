/**
 * The mapping and what it does not know: entries of a kind a newer Claude
 * Code writes and content blocks it has no part for are never dropped
 * silently, whichever way they arrive (the transcript reader or the SDK).
 */
import { describe, expect, it } from 'vitest';
import type { CcSessionMessage } from '../../src/claudecode/bridge-protocol';
import {
  applyToMirror,
  classify,
  LOOSE_UUID_PREFIX,
  type MirrorState,
  placeOf,
  planSync,
  provenanceOf,
  unknownText,
} from '../../src/claudecode/map';

const S = 'sess-map-0001';
const empty = (): MirrorState => ({ byUuid: new Map(), messages: new Map() });
let n = 0;
const ids = () => `m${n++}`;

const entry = (uuid: string, type: string, message: unknown, extra: Partial<CcSessionMessage> = {}) =>
  ({ type, uuid, session_id: S, message, parent_tool_use_id: null, ...extra }) as CcSessionMessage;

describe('what the mapping does not know', () => {
  it('reads an SDK entry of a new kind as unknown, not as your prompt', () => {
    expect(classify(entry('x', 'progress', { content: 'tick' }))).toEqual({
      kind: 'unknown',
      type: 'progress',
    });
    expect(classify(entry('y', 'user', { role: 'user', content: 42 }))).toEqual({
      kind: 'unknown',
      type: 'user_content',
    });
    // A user entry with no message at all is still nothing to show.
    expect(classify(entry('z', 'user', undefined))).toEqual({ kind: 'skip' });
  });

  it('counts unknown blocks on the message that holds them, with the entry kept raw', () => {
    n = 0;
    const answer = entry('a1', 'assistant', {
      id: 'api1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here.' },
        { type: 'hologram', frames: 2 },
      ],
    });
    const plan = planSync([entry('u1', 'user', { role: 'user', content: 'Go' }), answer], empty(), ids, null);
    const a = plan.planned.find((p) => p.role === 'assistant');
    expect(a?.parts).toEqual([{ type: 'text', text: 'Here.' }]);
    expect(a?.unknown).toEqual({ count: 1, types: ['hologram'] });
    expect(a?.raws?.[0]).toMatchObject({ uuid: 'a1', type: 'hologram' });
    expect(JSON.parse(a?.raws?.[0]?.raw ?? '{}')).toMatchObject({ uuid: 'a1' });
    expect(provenanceOf(S, a as NonNullable<typeof a>).unknown).toEqual({ count: 1, types: ['hologram'] });
  });

  it('gives a run of unknown entries between turns one marker, and a later sync adds nothing', () => {
    n = 0;
    const chain = [
      entry('u1', 'user', { role: 'user', content: 'Go' }),
      entry('k1', 'unknown', undefined, { unknown: { type: 'ledger', raw: '{"type":"ledger"}' } }),
      entry('k2', 'heartbeat', { beat: 1 }),
      entry('a1', 'assistant', { id: 'api1', role: 'assistant', content: [{ type: 'text', text: 'Ok' }] }),
    ];
    const plan = planSync(chain, empty(), ids, null);
    const marker = plan.planned.filter((p) => p.kind === 'unknown');
    expect(marker).toHaveLength(1);
    expect(marker[0]).toMatchObject({
      role: 'system',
      uuids: ['k1', 'k2'],
      unknown: { count: 2, types: ['ledger', 'heartbeat'] },
      parts: [{ type: 'text', text: unknownText(2) }],
    });
    expect(marker[0]?.raws?.map((r) => r.raw)[0]).toBe('{"type":"ledger"}');
    // The answer hangs off the marker, so the conversation reads in order.
    expect(plan.planned.find((p) => p.role === 'assistant')?.parent_id).toBe(marker[0]?.id);
    expect(unknownText(1)).toBe("1 entry this version of NVX Ancile can't show yet");
  });

  it('never starts a branch for an entry an older version skipped, and never goes on from a line with no uuid', () => {
    n = 0;
    const u1 = entry('u1', 'user', { role: 'user', content: 'Go' });
    const a1 = entry('a1', 'assistant', {
      id: 'api1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Ok' }],
    });
    const u2 = entry('u2', 'user', { role: 'user', content: 'More' });
    const first = planSync([u1, a1, u2], empty(), ids, null);
    const mirror = empty();
    applyToMirror(mirror, first);
    // A later read finds an entry between a1 and u2 that was skipped before, and a loose line after u2.
    const old = entry('k1', 'tool-progress', { x: 1 });
    const loose = entry(`${LOOSE_UUID_PREFIX}abc`, 'unknown', undefined, {
      unknown: { type: 'not_json', raw: 'oops' },
    });
    const again = planSync([u1, a1, old, u2, loose], mirror, ids, null);
    expect(again.planned.every((p) => p.extends)).toBe(true);
    const onAnswer = again.planned.find((p) => p.id === mirror.byUuid.get('a1'));
    expect(onAnswer).toMatchObject({ uuids: ['k1'], parts: [], unknown: { count: 1 } });
    const onPrompt = again.planned.find((p) => p.id === mirror.byUuid.get('u2'));
    expect(onPrompt).toMatchObject({ uuids: [loose.uuid], unknown: { count: 1, types: ['not_json'] } });
    // The prompt's place in the session is still its own entry.
    expect(placeOf([u2.uuid, loose.uuid])).toBe('u2');
    expect(again.head).toBe(mirror.byUuid.get('u2'));
  });
});
