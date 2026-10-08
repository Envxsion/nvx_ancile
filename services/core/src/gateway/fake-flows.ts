/**
 * ------------------------------------------------------------------
 *  Title    |  The offline test model's flow decisions
 *  Ref      |  gateway/fake-structured.ts · flows/execute.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let every flow template run with no keys: the offline
 *           |  models answer router, manager, judge and loop prompts
 *           |  with deterministic JSON.
 *  How      |  router   intent by keywords (code, maths, writing) and
 *           |           the route whose label or description names it;
 *           |           otherwise the route that says "general" or
 *           |           "else", at low confidence
 *           |  manager  asks each worker once, in the order listed,
 *           |           then finishes with the last result
 *           |  judge    the candidate sharing most words with the request
 *           |  loop     done from the second iteration
 * ------------------------------------------------------------------
 */

const INTENTS: [string, RegExp][] = [
  [
    'code',
    /```|\b(code|coding|program|function|bug|debug|regex|sql|python|typescript|javascript|script|compile|api|refactor|class|implement)\b/i,
  ],
  [
    'maths',
    /\b(maths?|equation|integral|derivative|physics|calculate|probability|solve|algebra|proof|theorem|velocity)\b|\d+\s*[-+*/^]\s*\d+/i,
  ],
  ['writing', /\b(write|essay|poem|email|story|draft|rewrite|blog|letter|tone|edit my)\b/i],
];

const ALIASES: Record<string, RegExp> = {
  code: /\b(code|coder|coding|engineer|program|developer)\b/i,
  maths: /\b(maths?|physics|calculation|numbers)\b/i,
  writing: /\b(writ|prose|copy|editor|essay|draft)\w*/i,
};

function section(prompt: string, start: string, end?: RegExp): string {
  const i = prompt.indexOf(start);
  if (i < 0) return '';
  const rest = prompt.slice(i + start.length);
  const m = end ? end.exec(rest) : null;
  return (m ? rest.slice(0, m.index) : rest).trim();
}

function request(prompt: string): string {
  return section(
    prompt,
    'Request:\n',
    /\n+(?:Choose |Round \d|Candidates:|Earlier steps:|Results so far:|Return JSON|Iteration:)/,
  );
}

function routeChoice(prompt: string) {
  const routes = [...section(prompt, 'Routes:\n', /\n(?!- )/).matchAll(/^- ([^:\n]+): ?(.*)$/gm)].map(
    (m) => ({
      label: (m[1] ?? '').trim(),
      when: m[2] ?? '',
    }),
  );
  const req = request(prompt);
  const intent = INTENTS.find(([, re]) => re.test(req))?.[0];
  const scores: Record<string, number> = {};
  let chosen: string | undefined;
  for (const r of routes) {
    const hit =
      intent !== undefined &&
      (r.label.toLowerCase().includes(intent) || ALIASES[intent]?.test(`${r.label} ${r.when}`) === true);
    scores[r.label] = hit ? 0.9 : 0.1;
    if (hit && !chosen) chosen = r.label;
  }
  if (chosen) return { routes: [chosen], reason: `The request is about ${intent}.`, confidence: 0.9, scores };
  const general =
    routes.find((r) => /general|else|other|default|chat/i.test(`${r.label} ${r.when}`)) ?? routes[0];
  if (general) scores[general.label] = 0.6;
  return {
    routes: general ? [general.label] : [],
    reason: 'Nothing specific stood out, so the general route.',
    confidence: 0.6,
    scores,
  };
}

function managerTurn(prompt: string) {
  const workers = [...section(prompt, 'Workers:\n', /\n(?!- )/).matchAll(/^- ([^:\n]+):/gm)].map((m) =>
    (m[1] ?? '').trim(),
  );
  const results = section(prompt, 'Results so far:\n', /\n+Round \d/);
  const asked = new Set(
    [...results.matchAll(/^\[\d+\] ([^(\n]+) \(asked:/gm)].map((m) => (m[1] ?? '').trim()),
  );
  const next = workers.find((w) => !asked.has(w));
  const req = request(prompt);
  if (next) {
    const last = [...results.matchAll(/\[\d+\] [^\n]*\n([\s\S]*?)(?=\n\n\[\d+\] |$)/g)].at(-1)?.[1]?.trim();
    const task = last
      ? `Using this from the team:\n${last.slice(0, 2_000)}\n\nDo your part of: ${req}`
      : `Do your part of: ${req}`;
    return { done: false, answer: '', calls: [{ worker: next, task }], reason: `Asking ${next} next.` };
  }
  const last =
    [...results.matchAll(/\[\d+\] [^\n]*\n([\s\S]*?)(?=\n\n\[\d+\] |$)/g)].at(-1)?.[1]?.trim() ?? '';
  return {
    done: true,
    answer: `Here is what the team produced:\n\n${last}`,
    calls: [],
    reason: 'Every worker has answered.',
  };
}

function judgeChoice(prompt: string) {
  const req = new Set(
    request(prompt)
      .toLowerCase()
      .match(/[a-z]{3,}/g) ?? [],
  );
  const cands = [
    ...section(prompt, 'Candidates:\n', /\n+Return JSON/).matchAll(
      /^\[(\d+)\][^\n]*\n([\s\S]*?)(?=\n\[\d+\]|$)/gm,
    ),
  ];
  let best = 1;
  let bestScore = -1;
  for (const c of cands) {
    const words = new Set((c[2] ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const score = [...req].filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = Number(c[1]);
      bestScore = score;
    }
  }
  return { best, reason: `Candidate ${best} covers more of the request.` };
}

function loopVerdict(prompt: string) {
  const i = Number(/Iteration: (\d+)/.exec(prompt)?.[1] ?? '1');
  return i >= 2
    ? { done: true, reason: 'Two passes are enough.' }
    : { done: false, reason: 'One more pass.' };
}

/** JSON for a flow prompt, or undefined when the prompt is something else. */
export function flowReply(prompt: string): string | undefined {
  const name = /Return JSON matching (\w+)/.exec(prompt)?.[1];
  switch (name) {
    case 'RouteChoice':
      return JSON.stringify(routeChoice(prompt));
    case 'ManagerTurn':
      return JSON.stringify(managerTurn(prompt));
    case 'JudgeChoice':
      return JSON.stringify(judgeChoice(prompt));
    case 'LoopVerdict':
      return JSON.stringify(loopVerdict(prompt));
    default:
      return undefined;
  }
}
