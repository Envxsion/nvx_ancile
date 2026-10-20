import { describe, expect, it } from 'vitest';
import { applyPolicy, type CaptureCandidate } from '../../src/memory/capture';
import { detectExplicit } from '../../src/memory/explicit';

describe('explicit memory requests (M2)', () => {
  it.each([
    ['Remember that I use metric units.', 'preference', 'I use metric units.'],
    [
      'remember that the staging server is called Halley',
      'preference',
      'The staging server is called Halley.',
    ],
    ['Please remember: I work in UTC+10', 'preference', 'I work in UTC+10.'],
    ['ok, also remember to double-check dates', 'preference', 'Double-check dates.'],
    ['Never add a summary at the end.', 'restriction', 'Never add a summary at the end.'],
    ['You must never use em dashes in copy', 'restriction', 'Never use em dashes in copy.'],
    ["Don't ever commit to main", 'restriction', 'Never commit to main.'],
    ['Do not ever guess a citation', 'restriction', 'Never guess a citation.'],
    ['From now on answer in British English', 'preference', 'Answer in British English.'],
    ['Thanks. Remember that I prefer tables.\nWhat is next?', 'preference', 'I prefer tables.'],
    ['From now on, never mention the weather', 'restriction', 'Never mention the weather.'],
  ] as const)('saves %j', (text, kind, statement) => {
    expect(detectExplicit(text)).toMatchObject({ kind, statement, scope: 'user' });
  });

  it('knows when it is about this notebook', () => {
    expect(detectExplicit('Remember that we cite APA in this notebook')).toMatchObject({ scope: 'notebook' });
    expect(detectExplicit('Remember that I cite APA')).toMatchObject({ scope: 'user' });
  });

  it.each([
    ['never mind', 'never mind'],
    ['never mind, I found it', 'never mind with a comma'],
    ['Nevermind that, it works now.', 'nevermind'],
    ["Don't remember that.", 'negated'],
    ['Do not remember anything from this chat', 'negated'],
    ['No need to remember that', 'negated'],
    ["I don't remember that either", 'first person'],
    ['You never remember that I use metric', 'about the assistant, not an instruction'],
    ['Can you remember that I use metric?', 'a question'],
    ['Do you remember that? ', 'a question'],
    ['Never again?', 'a question'],
    ['If I say remember that, save it', 'conditional'],
    ['Remember that', 'nothing to keep'],
    ['Remember it', 'points at something else'],
    ['Oh sure, remember that I love typos lol', 'sarcasm'],
    ['Yeah right, never use tables /s', 'sarcasm'],
    ['As if I would ever remember that', 'sarcasm'],
    ['He said: never do that again', 'someone else said it'],
    ['She told me to remember that the bus is late', 'someone else said it'],
    ['The docs say "never use eval" and I wonder why', 'quoted'],
    ['"Remember that I use metric," she said', 'opens with a quote'],
    ['Never remember that I said this', 'asks not to remember'],
    ['', 'empty'],
    ['What is the capital of France?', 'unrelated'],
  ])('leaves %j alone (%s)', (text) => {
    expect(detectExplicit(text)).toBeNull();
  });

  it('ignores quoted lines, pasted blocks and code', () => {
    expect(detectExplicit('> Remember that I use metric.\n\nWhat does this mean?')).toBeNull();
    expect(detectExplicit('```\nnever use eval()\n```\nIs that right?')).toBeNull();
    expect(detectExplicit('~~~\nremember that x is 4\n~~~')).toBeNull();
    // ...but the person's own request next to a quote still counts.
    expect(detectExplicit('> never use eval\n\nRemember that I agree with the above')).toMatchObject({
      kind: 'preference',
    });
  });

  it.each([
    ['[live test 20 Oct] Remember that my manager wants weekly updates.', 'My manager wants weekly updates.'],
    ['(note) remember that I use metric units', 'I use metric units.'],
    ['Note: always remember that deploys go out on Thursdays', 'Deploys go out on Thursdays.'],
    ['ok so remember that I use pnpm', 'I use pnpm.'],
    ['Can you remember that I use pnpm', 'I use pnpm.'],
    ['I need this by Friday, please remember that I use metric units', 'I use metric units.'],
    ['#todo never add a summary at the end', 'Never add a summary at the end.'],
  ])('finds a request behind a tag or a lead-in: %j', (text, statement) => {
    expect(detectExplicit(text)?.statement).toBe(statement);
  });

  it('still leaves reported speech and conditions alone behind a comma', () => {
    expect(detectExplicit('He said, never do that again')).toBeNull();
    expect(detectExplicit('If it fails, remember that I use pnpm')).toBeNull();
  });

  it('stays out of a long paste', () => {
    expect(detectExplicit(`Remember that ${'word '.repeat(80)}`)).toBeNull();
  });
});

describe('GR3: who may write memory without a yes', () => {
  const base: CaptureCandidate = {
    kind: 'preference',
    targetPath: 'USER.md',
    section: 'Preferences',
    text: 'Never add a summary.',
    confidence: 0.97,
    evidence: [],
    provenance: 'user_message',
    explicit: true,
  };
  const add = { op: 'add' as const, text: 'x', rationale: 'r' };

  it('saves the person’s own explicit request in every mode but off, even below the threshold', () => {
    expect(applyPolicy(base, add, 0.99, 'auto_confident')).toBe('auto_apply');
    expect(applyPolicy(base, add, null, 'propose_all')).toBe('auto_apply');
    expect(applyPolicy({ ...base, confidence: 0.1 }, add, 0.99, 'auto_confident')).toBe('auto_apply');
  });

  it('with learning off, an explicit request waits in the inbox rather than vanishing', () => {
    expect(applyPolicy(base, add, 0.85, 'off')).toBe('propose');
  });

  it.each(['tool_output', 'source_content', 'run_outcome'] as const)(
    'ignores the explicit flag on anything that came from %s',
    (provenance) => {
      expect(applyPolicy({ ...base, provenance }, add, 0.99, 'auto_confident')).toBe('propose');
      expect(applyPolicy({ ...base, provenance }, add, 0.1, 'off')).toBe('skip');
    },
  );

  it('still skips a no-op', () => {
    expect(applyPolicy(base, { ...add, op: 'noop' }, 0.85, 'auto_confident')).toBe('skip');
  });
});
