/**
 * ------------------------------------------------------------------
 *  Title    |  Flow templates
 *  Ref      |  DESIGN.md §16.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Good starting points, so a new flow is never a blank
 *           |  canvas: one model, a router to specialists, rules then
 *           |  a router, a manager with planner and coder, parallel
 *           |  answers with a judge, draft-critique-revise, and cheap
 *           |  first with escalation when unsure.
 *  How      |  Each template is built from the models you actually
 *           |  have ready (main, cheap, deep), so it runs as made.
 * ------------------------------------------------------------------
 */

import {
  type ContextPolicy,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  FlowSettings,
  type FlowTemplate,
  ModelParams,
} from '@nvx/contracts';

export interface TemplateModels {
  /** The everyday chat model. */
  main: string;
  /** A fast, cheap model (routers, judges, drafts). */
  cheap: string;
  /** The strongest model available. */
  deep: string;
}

const settings = FlowSettings.parse({});
const at = (x: number, y: number) => ({ x, y });
const model = (
  id: string,
  label: string,
  pos: { x: number; y: number },
  params: Partial<ModelParams> & { model: string },
): FlowNode => ({ id, kind: 'model', label, position: pos, params: ModelParams.parse(params) });
const edge = (from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge => ({
  id: `${from}-${to}${extra.label ? `-${extra.label}` : ''}`,
  from,
  to,
  ...extra,
});
const io = (inX: number, outX: number, y = 200): FlowNode[] => [
  { id: 'input', kind: 'input', label: 'Your message', position: at(inX, y), params: {} },
  { id: 'output', kind: 'output', label: 'Answer', position: at(outX, y), params: { template: '' } },
];
const planOnly: ContextPolicy = {
  conversation: { mode: 'none' },
  sources: { mode: 'none' },
  memory: 'none',
  upstream: 'plan',
};

export function templates(m: TemplateModels): FlowTemplate[] {
  const g = (nodes: FlowNode[], edges: FlowEdge[]): FlowGraph => ({ nodes, edges, settings });
  return [
    {
      id: 'tpl_single',
      name: 'One model',
      description:
        'Every message goes to one model, with the whole branch, your sources and memory. The plain chat, as a flow.',
      graph: g(
        [...io(0, 640), model('answer', 'Answer', at(320, 200), { model: m.main, speaks: true })],
        [edge('input', 'answer'), edge('answer', 'output')],
      ),
    },
    {
      id: 'tpl_router',
      name: 'Router to specialists',
      description:
        'A fast router reads each message and sends it to the right specialist: code, maths, or everything else.',
      graph: g(
        [
          ...io(0, 960, 240),
          {
            id: 'router',
            kind: 'router',
            label: 'Router',
            position: at(260, 240),
            params: {
              model: m.cheap,
              instructions: 'Choose who should answer. Prefer "general" when unsure.',
              routes: [
                {
                  label: 'code',
                  when: 'Writing, fixing, reviewing or explaining code, scripts, regex or SQL.',
                },
                { label: 'maths', when: 'Maths, physics, statistics, calculations and proofs.' },
                { label: 'general', when: 'Everything else: writing, planning, questions, chat.' },
              ],
              default_route: 'general',
              min_confidence: 0.5,
              multi: false,
            },
          },
          model('coder', 'Coder', at(580, 80), {
            model: m.deep,
            role: 'You are a senior engineer. Answer with working code and a short explanation.',
            speaks: true,
          }),
          model('maths', 'Maths and physics', at(580, 240), {
            model: m.deep,
            role: 'You are a careful mathematician. Show the working, then the result.',
            speaks: true,
          }),
          model('general', 'Generalist', at(580, 400), { model: m.main, speaks: true }),
        ],
        [
          edge('input', 'router'),
          edge('router', 'coder', { label: 'code' }),
          edge('router', 'maths', { label: 'maths' }),
          edge('router', 'general', { label: 'general' }),
          edge('coder', 'output'),
          edge('maths', 'output'),
          edge('general', 'output'),
        ],
      ),
    },
    {
      id: 'tpl_rules_router',
      name: 'Rules, then a router',
      description:
        'Fixed rules decide first and cost nothing; the router only judges what the rules do not cover.',
      graph: g(
        [
          ...io(0, 1180, 240),
          {
            id: 'rules',
            kind: 'rule',
            label: 'Rules',
            position: at(240, 240),
            params: {
              rules: [
                {
                  label: 'code',
                  all: [{ field: 'text', op: 'matches', value: '```|\\bfunction\\b|\\bdef\\b|\\bclass\\b' }],
                },
              ],
              default_route: 'decide',
            },
          },
          {
            id: 'router',
            kind: 'router',
            label: 'Router',
            position: at(500, 340),
            params: {
              model: m.cheap,
              instructions: 'The rules did not decide. Choose who should answer.',
              routes: [
                { label: 'code', when: 'Anything about code.' },
                { label: 'general', when: 'Everything else.' },
              ],
              default_route: 'general',
              min_confidence: 0.5,
              multi: false,
            },
          },
          model('coder', 'Coder', at(800, 140), { model: m.deep, speaks: true }),
          model('general', 'Generalist', at(800, 380), { model: m.main, speaks: true }),
        ],
        [
          edge('input', 'rules'),
          edge('rules', 'coder', { label: 'code' }),
          edge('rules', 'router', { label: 'decide' }),
          edge('router', 'coder', { label: 'code', id: 'router-coder-code' }),
          edge('router', 'general', { label: 'general' }),
          edge('coder', 'output'),
          edge('general', 'output'),
        ],
      ),
    },
    {
      id: 'tpl_manager',
      name: 'Manager with planner and coder',
      description:
        'A manager plans, hands the plan to a coder that sees only the plan, checks the result and writes the answer.',
      graph: g(
        [
          ...io(0, 880, 160),
          {
            id: 'manager',
            kind: 'manager',
            label: 'Manager',
            position: at(300, 160),
            params: {
              ...ModelParams.parse({ model: m.main, speaks: true }),
              instructions:
                'Break the request into a plan. Ask the planner for a plan when the task is large, then give the coder one clear task. Check what comes back before you answer.',
              max_rounds: 3,
            },
          },
          model('planner', 'Planner', at(180, 400), {
            model: m.cheap,
            role: 'You write short, numbered implementation plans. No code.',
          }),
          model('coder', 'Coder', at(460, 400), {
            model: m.deep,
            role: 'You implement exactly the task you are given. Return only the code and a one-line note.',
          }),
        ],
        [
          edge('input', 'manager'),
          edge('manager', 'planner', { label: 'planner' }),
          edge('manager', 'coder', { label: 'coder', context: planOnly }),
          edge('planner', 'manager', { id: 'planner-back' }),
          edge('coder', 'manager', { id: 'coder-back' }),
          edge('manager', 'output'),
        ],
      ),
    },
    {
      id: 'tpl_parallel_judge',
      name: 'Two answers and a judge',
      description: 'Two models answer at once; a judge picks the better answer and says why.',
      graph: g(
        [
          ...io(0, 1000, 220),
          { id: 'fan', kind: 'parallel', label: 'Both at once', position: at(200, 220), params: {} },
          model('a', 'Answer A', at(420, 100), { model: m.main }),
          model('b', 'Answer B', at(420, 340), { model: m.deep }),
          {
            id: 'judge',
            kind: 'join',
            label: 'Judge',
            position: at(720, 220),
            params: {
              mode: 'judge',
              judge_model: m.cheap,
              judge_instructions: 'Pick the answer that is more correct, then more useful.',
            },
          },
        ],
        [
          edge('input', 'fan'),
          edge('fan', 'a'),
          edge('fan', 'b'),
          edge('a', 'judge'),
          edge('b', 'judge'),
          edge('judge', 'output'),
        ],
      ),
    },
    {
      id: 'tpl_critique',
      name: 'Draft, critique, revise',
      description: 'A draft, a critique of it, then a revision that answers the critique.',
      graph: g(
        [
          ...io(0, 1160),
          model('draft', 'Draft', at(220, 200), { model: m.main }),
          model('critic', 'Critic', at(500, 200), {
            model: m.cheap,
            role: 'List the three biggest problems with the draft you are given. Be specific. Do not rewrite it.',
          }),
          model('revise', 'Revise', at(800, 200), {
            model: m.deep,
            role: 'Rewrite the draft so it fixes every problem in the critique. Answer with the final text only.',
            speaks: true,
          }),
        ],
        [
          edge('input', 'draft'),
          edge('draft', 'critic'),
          edge('critic', 'revise', {
            context: { ...planOnly, conversation: { mode: 'last_n', n: 1 }, upstream: 'all' },
          }),
          edge('revise', 'output'),
        ],
      ),
    },
    {
      id: 'tpl_escalate',
      name: 'Cheap first, escalate when unsure',
      description:
        'A fast model answers; a fact-check of that answer sends anything doubtful to the strongest model.',
      graph: g(
        [
          ...io(0, 1100, 200),
          model('quick', 'Quick answer', at(220, 200), { model: m.cheap }),
          {
            id: 'check',
            kind: 'factcheck',
            label: 'Check it',
            position: at(480, 200),
            params: { min_confidence: 0.7, caveat: false },
          },
          model('deep', 'Strong model', at(760, 320), {
            model: m.deep,
            role: 'A quicker model was not sure of its answer. Answer the question properly.',
            speaks: true,
          }),
          {
            id: 'pass',
            kind: 'template',
            label: 'Keep it',
            position: at(760, 80),
            params: { template: '{{quick}}' },
          },
        ],
        [
          edge('input', 'quick'),
          edge('quick', 'check'),
          edge('check', 'pass', { label: 'ok' }),
          edge('check', 'deep', { label: 'unsure' }),
          edge('pass', 'output'),
          edge('deep', 'output'),
        ],
      ),
    },
  ];
}
