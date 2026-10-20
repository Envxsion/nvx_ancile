/**
 * Why a live fact-check once made 54 model calls and no verdict, and why no test saw it:
 *  - the verify prompts ended "Return JSON matching ClaimVerdict" and never named the fields, and the
 *    offline models answered the schema whatever the prompt said. Now every prompt a model must answer
 *    in JSON names every field (checked here against the schemas), and the offline model answers only
 *    what the prompt tells it;
 *  - a reply dressed a little differently ({"claimVerdict": {...}}) was thrown away: it is now read
 *    tolerantly, asked again once on the same model, and only then counts as that model's failure;
 *  - nothing bounded the walk down the chain: every call is now counted against the claim, the
 *    answer, the clock and the spend, and a claim at a limit is "Not checked: <reason>".
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadPrompt, render } from '../../src/conductor/prompt';
import { CheckBudget, CheckLimit, type CheckLimits } from '../../src/factcheck/budget';
import {
  CLAIMS_JSON_SCHEMA,
  CLAIMS_SHAPE,
  checkClaim,
  RawClaims,
  RawVerdict,
  structured,
  VERDICT_JSON_SCHEMA,
  VERDICT_SHAPE,
  verifyClaim,
} from '../../src/factcheck/steps';
import { parseJsonValue, tolerantClaims, tolerantVerdict } from '../../src/factcheck/tolerant';
import { FIELDS, factcheckReply } from '../../src/gateway/fake-factcheck';
import type { Gateway } from '../../src/gateway/gateway';
import type { ModelRequest } from '../../src/gateway/types';

const PROMPTS = join(import.meta.dirname, '../../../../prompts');

const model = (id: string, price = 0): ModelConfig => ({
  id,
  provider: 'openai',
  provider_model: id,
  display_name: id,
  via: 'direct',
  family: 'openai',
  context_window: 100_000,
  max_output: 8_000,
  capabilities: [],
  price: { input_per_mtok: price, output_per_mtok: price },
  enabled: true,
});

/** A gateway that answers each call from a script and remembers what it was asked. */
function scripted(
  reply: (model: string, n: number, req: ModelRequest) => string,
  usage = { inputTokens: 1_000_000, outputTokens: 0 },
) {
  const calls: { model: string; req: ModelRequest }[] = [];
  const gateway = {
    async *stream(chain: ModelConfig[], req: ModelRequest) {
      const m = chain[0] as ModelConfig;
      calls.push({ model: m.id, req });
      yield { type: 'model', modelId: m.id };
      yield { type: 'chunk', chunk: { type: 'text', delta: reply(m.id, calls.length, req) } };
      yield { type: 'chunk', chunk: { type: 'finish', finishReason: 'stop', usage } };
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

const GOOD = JSON.stringify({ stance: 'supported', evidence: [], rationale: 'Fine.', confidence: 0.9 });
const signal = new AbortController().signal;
const limits = (o: Partial<CheckLimits> = {}): CheckLimits => ({
  callsPerClaim: 3,
  callsPerCheck: 20,
  minutes: 6,
  spendUsd: 0.5,
  ...o,
});

describe('prompts name every field a model must fill', () => {
  const verdictFields = [
    ...Object.keys(RawVerdict.shape),
    'ref',
    'quote',
    'supported',
    'contradicted',
    'insufficient',
    'supports',
    'contradicts',
  ];
  const claimFields = ['claims', 'text', 'char_start', 'char_end', 'importance', 'checkable'];

  it.each([
    ['factcheck.verify-claim', verdictFields],
    ['factcheck.verify-general', verdictFields],
    ['factcheck.extract-claims', claimFields],
    [
      'factcheck.check-selection',
      ['verdict', 'headline', 'corrected', 'evidence', 'closing', 'ref', 'stance'],
    ],
  ])('%s', async (id, fields) => {
    const text = await loadPrompt(PROMPTS, id, 'MISSING');
    expect(text).not.toBe('MISSING');
    const rendered = render(text, {
      claim: 'c',
      evidence: 'e',
      message_text: 'm',
      question: 'q',
      claim_block: 'b',
      context: 'x',
    });
    for (const f of fields) expect(rendered, `${id} never names "${f}"`).toContain(f);
  });

  it('the JSON Schema sent to a provider requires exactly the fields the prompt names', () => {
    expect(VERDICT_JSON_SCHEMA.required).toEqual(Object.keys(RawVerdict.shape));
    expect(Object.keys(VERDICT_JSON_SCHEMA.properties)).toEqual(Object.keys(RawVerdict.shape));
    expect(CLAIMS_JSON_SCHEMA.required).toEqual(['claims']);
  });

  it('the example in a repair message is itself a valid reply', () => {
    expect(RawVerdict.safeParse(JSON.parse(VERDICT_SHAPE)).success).toBe(true);
    expect(RawClaims.safeParse(JSON.parse(CLAIMS_SHAPE)).success).toBe(true);
  });
});

describe('the offline model answers only what the prompt tells it', () => {
  const vague = 'Claim:\nThe sky is blue.\n\nEvidence:\n(none)\n\nReturn JSON matching ClaimVerdict.';

  it('a prompt that names no fields gets a reply no reader can use', () => {
    const reply = factcheckReply(vague) as string;
    expect(RawVerdict.safeParse(tolerantVerdict(parseJsonValue(reply))).success).toBe(false);
  });

  it('the same prompt naming the fields gets a verdict', async () => {
    const text = await loadPrompt(PROMPTS, 'factcheck.verify-claim', 'MISSING');
    const prompt = render(text, {
      claim: 'The sky is blue.',
      evidence: '[E1] Atlas\n"""\nThe sky is blue on a clear day.\n"""',
    });
    for (const f of FIELDS.ClaimVerdict) expect(prompt).toContain(f);
    const reply = factcheckReply(prompt) as string;
    expect(RawVerdict.safeParse(JSON.parse(reply)).success).toBe(true);
  });

  it('a verify prompt that does not name the fields fails the check, so the bug cannot hide again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-prompts-'));
    await mkdir(join(dir, 'factcheck'), { recursive: true });
    await writeFile(
      join(dir, 'factcheck', 'verify-claim.md'),
      'Judge the claim.\n\nClaim:\n{{claim}}\n\nEvidence:\n{{evidence}}\n\nReturn JSON matching ClaimVerdict.\n',
    );
    const { gateway } = scripted((_m, _n, req) => factcheckReply(req.messages[0]?.content ?? '') ?? GOOD);
    const evidence = [
      {
        kind: 'chunk' as const,
        ref: 'chk_1',
        source_id: 's',
        source_title: 'Atlas',
        page: null,
        char_start: 0,
        char_end: 10,
        quote: 'The sky is blue on a clear day.',
        stance: 'neutral' as const,
        score: 0.9,
        origin: 'source' as const,
        text: 'The sky is blue on a clear day.',
      },
    ];
    await expect(
      verifyClaim(
        { gateway, registry: registryOf([model('m')]), promptsDir: dir } as never,
        { claim: 'The sky is blue.', evidence, generatorFamily: null, only: [model('m')] },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'factcheck.bad_output' });
  });
});

function registryOf(ready: ModelConfig[]) {
  return {
    get: (id: string) => ready.find((m) => m.id === id),
    tierOf: () => 'fast' as const,
    resolveWant: () => ({ chain: ready, degraded: [], unmet: null, refused: [] }),
  };
}

describe('reading a reply tolerantly', () => {
  it('unwraps one wrapper key, as gpt-oss answered', () => {
    const v = tolerantVerdict(
      parseJsonValue('{"claimVerdict":{"stance":"supported","rationale":"ok","confidence":0.8}}'),
    );
    expect(RawVerdict.parse(v)).toMatchObject({ stance: 'supported', confidence: 0.8 });
  });

  it('reads fenced JSON, any case, and a confidence given as a percentage', () => {
    const v = tolerantVerdict(
      parseJsonValue(
        '```json\n{"stance":"SUPPORTED","evidence":[{"ref":"E1","stance":"Supports"}],"rationale":"ok","confidence":"85%"}\n```',
      ),
    );
    expect(RawVerdict.parse(v)).toMatchObject({
      stance: 'supported',
      confidence: 0.85,
      evidence: [{ ref: 'E1', stance: 'supports' }],
    });
  });

  it('accepts the usual synonyms for the stance, and never invents one', () => {
    const word = (w: string) => RawVerdict.safeParse(tolerantVerdict({ verdict: w, rationale: 'r' }));
    expect(word('True')).toMatchObject({ success: true, data: { stance: 'supported' } });
    expect(word('refuted')).toMatchObject({ success: true, data: { stance: 'contradicted' } });
    expect(word('Not enough information')).toMatchObject({ success: true, data: { stance: 'insufficient' } });
    expect(word('banana').success).toBe(false);
  });

  it('reads a bare list of claims, or one under another name', () => {
    const one = { text: 'A claim here.', char_start: 0, char_end: 13 };
    expect(RawClaims.parse(tolerantClaims(parseJsonValue(JSON.stringify([one]))))).toMatchObject({
      claims: [one],
    });
    expect(RawClaims.parse(tolerantClaims({ result: { items: [one] } })).claims).toHaveLength(1);
  });
});

describe('a bad reply costs one more ask on the same model, then that model has failed', () => {
  const verdict = z.object({ stance: z.string() });

  it('a wrapped reply is read, not rejected: one call', async () => {
    const { gateway, calls } = scripted(() => '{"claimVerdict":{"stance":"supported","rationale":"ok"}}');
    const out = await structured({ gateway }, [model('a'), model('b')], 'p', RawVerdict, signal, {
      normalize: tolerantVerdict,
    });
    expect(out.value.stance).toBe('supported');
    expect(calls).toHaveLength(1);
  });

  it('an unusable reply is asked again once, saying what was wrong, on the same model', async () => {
    const { gateway, calls } = scripted((_m, n) => (n === 1 ? '{"result":"done"}' : GOOD));
    const out = await structured({ gateway }, [model('a'), model('b')], 'p', RawVerdict, signal, {
      normalize: tolerantVerdict,
      shape: VERDICT_SHAPE,
    });
    expect(out.modelId).toBe('a');
    expect(calls.map((c) => c.model)).toEqual(['a', 'a']);
    const again = calls[1]?.req.messages ?? [];
    expect(again.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(again[2]?.content).toContain('could not be used');
    expect(again[2]?.content).toContain(VERDICT_SHAPE);
  });

  it('a reply that fails twice fails that model; the next one is asked', async () => {
    const { gateway, calls } = scripted((m) => (m === 'a' ? 'not json' : GOOD));
    const out = await structured({ gateway }, [model('a'), model('b')], 'p', verdict, signal, {});
    expect(out.modelId).toBe('b');
    expect(calls.map((c) => c.model)).toEqual(['a', 'a', 'b']);
  });

  it('asks the provider for JSON mode with the schema', async () => {
    const { gateway, calls } = scripted(() => GOOD);
    await structured({ gateway }, [model('a')], 'p', RawVerdict, signal, { jsonSchema: VERDICT_JSON_SCHEMA });
    expect(calls[0]?.req.json?.schema).toBe(VERDICT_JSON_SCHEMA);
  });
});

describe('limits', () => {
  it('one claim makes at most three calls, however many models are ready and however they answer', async () => {
    const { gateway, calls } = scripted(() => 'nonsense');
    const budget = new CheckBudget(limits());
    const chain = Array.from({ length: 17 }, (_, i) => model(`m${i}`));
    await expect(
      structured({ gateway }, chain, 'p', RawVerdict, signal, { budget: budget.forClaim(0) }),
    ).rejects.toBeInstanceOf(CheckLimit);
    expect(calls).toHaveLength(3);
  });

  it('five claims that nothing can answer stay within the whole-answer limit', async () => {
    const { gateway, calls } = scripted(() => 'nonsense');
    const budget = new CheckBudget(limits({ callsPerCheck: 8 }));
    const chain = Array.from({ length: 17 }, (_, i) => model(`m${i}`));
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        await structured({ gateway }, chain, 'p', RawVerdict, signal, { budget: budget.forClaim(i) });
      } catch (err) {
        outcomes.push(err instanceof CheckLimit ? err.reason : 'other');
      }
    }
    expect(calls).toHaveLength(8);
    expect(outcomes).toEqual(['claim_calls', 'claim_calls', 'check_calls', 'check_calls', 'check_calls']);
  });

  it('stops at the spend ceiling', async () => {
    // $1 per call (1M tokens at $1 per Mtok), a ceiling of $1.50: the second call is the last.
    const { gateway, calls } = scripted(() => 'nonsense');
    const budget = new CheckBudget(limits({ spendUsd: 1.5, callsPerClaim: 10, callsPerCheck: 50 }));
    const chain = Array.from({ length: 10 }, (_, i) => model(`m${i}`, 1));
    await expect(
      structured({ gateway }, chain, 'p', RawVerdict, signal, { budget: budget.forClaim(0) }),
    ).rejects.toMatchObject({ reason: 'spend' });
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(budget.state.spendUsd).toBeGreaterThanOrEqual(1.5);
  });

  it('stops at the time limit', async () => {
    let t = 0;
    const budget = new CheckBudget(limits({ minutes: 1 }), undefined, () => t);
    const { gateway, calls } = scripted(() => {
      t += 40_000;
      return 'nonsense';
    });
    const chain = Array.from({ length: 10 }, (_, i) => model(`m${i}`));
    await expect(
      structured({ gateway }, chain, 'p', RawVerdict, signal, { budget: budget.forClaim(0) }),
    ).rejects.toMatchObject({ reason: 'time' });
    expect(calls).toHaveLength(2);
  });

  it('the state survives a resume: a second budget built from it holds the same count', () => {
    const a = new CheckBudget(limits());
    a.take(0);
    a.take(0);
    const b = new CheckBudget(limits(), structuredClone(a.state));
    b.take(0);
    expect(() => b.take(0)).toThrow(CheckLimit);
  });

  it('a gateway that falls through models is charged for each one', async () => {
    const gateway = {
      async *stream(chain: ModelConfig[]) {
        yield { type: 'fallback', from: 'a', to: 'b', reason: 'transient', detail: '' };
        yield { type: 'fallback', from: 'b', to: 'c', reason: 'transient', detail: '' };
        yield { type: 'model', modelId: (chain[2] ?? chain[0])?.id };
        yield { type: 'chunk', chunk: { type: 'text', delta: GOOD } };
      },
    } as unknown as Gateway;
    const budget = new CheckBudget(limits());
    await structured({ gateway }, [model('a'), model('b'), model('c')], 'p', RawVerdict, signal, {
      budget: budget.forClaim(0),
    });
    expect(budget.state.perClaim[0]).toBe(3);
  });
});

describe('small things', () => {
  it('critical mode with no source says "Nothing in your sources mentions this." once', async () => {
    const a = model('a');
    const b = model('b');
    const { gateway, calls } = scripted(() => GOOD);
    const out = await checkClaim(
      { gateway, registry: registryOf([a, b]), promptsDir: '/none' } as never,
      {
        claim: 'The sky is blue.',
        evidence: [],
        triage: { tier: 'balanced', floor: 'balanced', obvious: false, critical: true } as never,
        critical: true,
        generatorFamily: null,
        chosen: [a, b],
        notebookId: null,
        sharing: false,
      },
      signal,
    );
    expect(out.rationale).toBe('Nothing in your sources mentions this.');
    expect(calls).toHaveLength(0);
  });
});
