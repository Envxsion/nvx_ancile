/**
 * ------------------------------------------------------------------
 *  Title    |  Flow node kinds
 *  Ref      |  DESIGN.md §16.1 · contracts/flows.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One table that says, for every kind of node, what it
 *           |  is called, how it looks, what it does in a sentence,
 *           |  which ports it has and what a new one starts with. The
 *           |  canvas, the add-node search, the side panel and the
 *           |  lint all read it, so they can never disagree.
 *  Note     |  Hues are identity-ramp names; violet stays for focus
 *           |  and live state, so no kind is violet.
 * ------------------------------------------------------------------
 */

import type { FlowNode, FlowNodeKind } from '@nvx/contracts';
import type { Hue } from '../lib/types';
import type { IconName } from '../ui/Icon';

export interface KindInfo {
  kind: FlowNodeKind;
  name: string;
  /** One line for the add-node search and the empty panel. */
  blurb: string;
  icon: IconName;
  hue: Hue;
  /** Where it sits in the add-node search. */
  family: 'Flow' | 'Models' | 'Routing' | 'Teams' | 'Knowledge' | 'Steps' | 'Canvas';
  /** Has an input port. */
  input: boolean;
  /** Output ports: one unlabelled 'out', or labelled routes taken from params. */
  outputs: 'one' | 'none' | 'routes';
  /** Never runs (canvas furniture). */
  furniture?: boolean;
  words?: string;
}

export const KINDS: Record<FlowNodeKind, KindInfo> = {
  input: {
    kind: 'input',
    name: 'Message in',
    blurb: 'Where your message enters the flow, with its branch and notebook.',
    icon: 'arrowRight',
    hue: 'chalk',
    family: 'Flow',
    input: false,
    outputs: 'one',
    words: 'start entry input',
  },
  output: {
    kind: 'output',
    name: 'Answer',
    blurb: 'What you see as the reply. Pass one output through, or compose several.',
    icon: 'send',
    hue: 'chalk',
    family: 'Flow',
    input: true,
    outputs: 'none',
    words: 'end output reply final',
  },
  model: {
    kind: 'model',
    name: 'Model',
    blurb: 'One call to one model on any provider, OpenRouter, Ollama or a GPU node.',
    icon: 'model',
    hue: 'azure',
    family: 'Models',
    input: true,
    outputs: 'one',
    words: 'llm ai claude gpt llama qwen runpod openrouter',
  },
  router: {
    kind: 'router',
    name: 'Router',
    blurb: 'A model reads the request and picks the route that fits, with a reason.',
    icon: 'branch',
    hue: 'amber',
    family: 'Routing',
    input: true,
    outputs: 'routes',
    words: 'classify intent route jev dispatch',
  },
  rule: {
    kind: 'rule',
    name: 'Rules',
    blurb: 'Fixed conditions, no model call: notebook, words, length, time, budget.',
    icon: 'filter',
    hue: 'amber',
    family: 'Routing',
    input: true,
    outputs: 'routes',
    words: 'if condition regex switch',
  },
  manager: {
    kind: 'manager',
    name: 'Manager',
    blurb: 'Plans, hands sub-tasks to the models below it, checks their work, writes the answer.',
    icon: 'user',
    hue: 'magenta',
    family: 'Teams',
    input: true,
    outputs: 'routes',
    words: 'team lead planner orchestrator supervisor',
  },
  parallel: {
    kind: 'parallel',
    name: 'Fan out',
    blurb: 'Sends the same work to every node it connects to, all at once.',
    icon: 'grid',
    hue: 'magenta',
    family: 'Teams',
    input: true,
    outputs: 'one',
    words: 'parallel split broadcast',
  },
  join: {
    kind: 'join',
    name: 'Join',
    blurb: 'Brings parallel work back together: keep all, the first, a vote, or a judge’s pick.',
    icon: 'merge',
    hue: 'magenta',
    family: 'Teams',
    input: true,
    outputs: 'one',
    words: 'merge judge vote best combine',
  },
  loop: {
    kind: 'loop',
    name: 'Loop',
    blurb: 'Repeats the steps on its body route until a check says done, with a hard cap.',
    icon: 'regenerate',
    hue: 'magenta',
    family: 'Teams',
    input: true,
    outputs: 'routes',
    words: 'repeat iterate refine until',
  },
  context: {
    kind: 'context',
    name: 'Context',
    blurb: 'Decides what the next step sees: conversation, sources, memory, earlier work.',
    icon: 'eye',
    hue: 'cyan',
    family: 'Knowledge',
    input: true,
    outputs: 'one',
    words: 'window budget history memory sources tokens',
  },
  retrieve: {
    kind: 'retrieve',
    name: 'Search sources',
    blurb: 'Finds the passages in this notebook that best match, with citation markers.',
    icon: 'search',
    hue: 'cyan',
    family: 'Knowledge',
    input: true,
    outputs: 'one',
    words: 'rag retrieval knowledge passages',
  },
  factcheck: {
    kind: 'factcheck',
    name: 'Fact-check',
    blurb: 'Checks the claims against your sources; unsure answers take the other route.',
    icon: 'factcheck',
    hue: 'jade',
    family: 'Knowledge',
    input: true,
    outputs: 'routes',
    words: 'verify claims grounded caveat',
  },
  tool: {
    kind: 'tool',
    name: 'Tool',
    blurb: 'Runs a tool or MCP call as a step. Asks first when the tool needs it.',
    icon: 'command',
    hue: 'coral',
    family: 'Steps',
    input: true,
    outputs: 'one',
    words: 'mcp function action',
  },
  template: {
    kind: 'template',
    name: 'Template',
    blurb: 'Writes text from a template, with {{input}} and earlier outputs filled in.',
    icon: 'type',
    hue: 'coral',
    family: 'Steps',
    input: true,
    outputs: 'one',
    words: 'format prompt text transform',
  },
  human: {
    kind: 'human',
    name: 'Ask me',
    blurb: 'Pauses and asks you; your answer carries on down the flow.',
    icon: 'user',
    hue: 'coral',
    family: 'Steps',
    input: true,
    outputs: 'one',
    words: 'human approval pause review gate',
  },
  subflow: {
    kind: 'subflow',
    name: 'Subflow',
    blurb: 'Runs another flow (or a saved team block) as one step.',
    icon: 'layout',
    hue: 'chalk',
    family: 'Steps',
    input: true,
    outputs: 'one',
    words: 'block reuse nested team',
  },
  note: {
    kind: 'note',
    name: 'Note',
    blurb: 'A sticky note for the canvas. Never sent to a model.',
    icon: 'note',
    hue: 'amber',
    family: 'Canvas',
    input: false,
    outputs: 'none',
    furniture: true,
    words: 'comment sticky annotation',
  },
  group: {
    kind: 'group',
    name: 'Group',
    blurb: 'A coloured frame around related nodes; collapse it to a chip.',
    icon: 'folder',
    hue: 'chalk',
    family: 'Canvas',
    input: false,
    outputs: 'none',
    furniture: true,
    words: 'frame section box',
  },
};

export const FAMILIES: KindInfo['family'][] = [
  'Models',
  'Routing',
  'Teams',
  'Knowledge',
  'Steps',
  'Flow',
  'Canvas',
];

/** Output port labels for a node: route labels, the manager's workers, or the single 'out'. */
export function outputPorts(n: FlowNode): string[] {
  switch (n.kind) {
    case 'router':
      return n.params.routes.map((r) => r.label);
    case 'rule':
      return [...n.params.rules.map((r) => r.label), ...(n.params.default_route ? [] : ['otherwise'])];
    case 'factcheck':
      return ['sure', 'unsure'];
    case 'loop':
      return ['body', 'done'];
    case 'manager':
      // Sub-tasks go down 'workers'; the finished answer leaves by 'answer'.
      return ['workers', 'answer'];
    default:
      return KINDS[n.kind].outputs === 'none' ? [] : ['out'];
  }
}

/** A sensible new node of a kind, ready to drop on the canvas. */
export function newNode(
  kind: FlowNodeKind,
  id: string,
  position: { x: number; y: number },
  model?: string,
): FlowNode {
  const m = model ?? 'offline/test';
  const base = { id, position };
  switch (kind) {
    case 'input':
      return { ...base, kind, params: {} };
    case 'output':
      return { ...base, kind, params: { template: '' } };
    case 'model':
      return {
        ...base,
        kind,
        params: { model: m, role: '', tools: [], fallbacks: [], speaks: false },
      };
    case 'router':
      return {
        ...base,
        kind,
        params: {
          model: m,
          instructions: 'Pick the route that best fits what I am asking for.',
          routes: [
            { label: 'code', when: 'Writing, fixing or explaining code.' },
            { label: 'writing', when: 'Drafting or editing prose.' },
          ],
          default_route: 'writing',
          min_confidence: 0.5,
          multi: false,
        },
      };
    case 'rule':
      return {
        ...base,
        kind,
        params: { rules: [{ label: 'long', all: [{ field: 'length', op: 'gt', value: 4000 }] }] },
      };
    case 'manager':
      return {
        ...base,
        kind,
        params: {
          model: m,
          role: '',
          tools: [],
          fallbacks: [],
          speaks: true,
          instructions: 'Plan the work, give each worker one clear task, check what comes back, then answer.',
          max_rounds: 3,
        },
      };
    case 'parallel':
      return { ...base, kind, params: {} };
    case 'join':
      return { ...base, kind, params: { mode: 'all', judge_instructions: '' } };
    case 'loop':
      return {
        ...base,
        kind,
        params: { max_iterations: 3, until: 'The answer fully meets the request.' },
      };
    case 'context':
      return {
        ...base,
        kind,
        params: {
          conversation: { mode: 'branch' },
          sources: { mode: 'retrieved', k: 8 },
          memory: 'pack',
          upstream: 'previous',
        },
      };
    case 'retrieve':
      return { ...base, kind, params: { query: '{{input}}', k: 8, rerank: true } };
    case 'factcheck':
      return { ...base, kind, params: { min_confidence: 0.7, caveat: true } };
    case 'tool':
      return { ...base, kind, params: { tool: '', args: '{}' } };
    case 'template':
      return { ...base, kind, params: { template: '{{input}}' } };
    case 'human':
      return {
        ...base,
        kind,
        params: { question: 'Does this look right before I carry on?', show_upstream: true },
      };
    case 'subflow':
      return { ...base, kind, params: { flow_id: '' } };
    case 'note':
      return {
        ...base,
        kind,
        params: { text: 'A note for whoever reads this flow next.' },
        size: { w: 220, h: 120 },
      };
    case 'group':
      return { ...base, kind, params: { collapsed: false }, size: { w: 420, h: 260 }, label: 'Group' };
  }
}

/** The model a node calls, if any (for chips, estimates and lint). */
export function modelOf(n: FlowNode): string | null {
  if (n.kind === 'model' || n.kind === 'manager' || n.kind === 'router') return n.params.model;
  if (n.kind === 'join') return n.params.judge_model ?? null;
  if (n.kind === 'loop') return n.params.until_model ?? null;
  if (n.kind === 'factcheck') return n.params.verifier ?? null;
  return null;
}

/** Provider word from a registry id: "openrouter/meta/llama…" → "openrouter". */
export function providerOf(modelId: string): string {
  return modelId.split('/')[0] ?? modelId;
}

export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  controller: 'GPU node',
  offline: 'Offline',
  local: 'Local',
};
