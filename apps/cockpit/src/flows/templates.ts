/**
 * ------------------------------------------------------------------
 *  Title    |  Starter flows
 *  Ref      |  DESIGN.md §16.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes people reach for first, ready to adapt:
 *           |  one model; a router to specialists; rules, then a
 *           |  router; a manager with a planner and a coder; several
 *           |  models and a judge; draft, critique, revise; cheap
 *           |  first, escalate when unsure.
 *  How      |  Core serves its own templates when it has them; these
 *           |  are the same shapes, used when it does not, so the
 *           |  gallery is never empty. Models default to the offline
 *           |  test model so a template runs before any key is added.
 * ------------------------------------------------------------------
 */

import type { FlowEdge, FlowGraph, FlowNode, FlowTemplate } from '@nvx/contracts';
import { emptyGraph } from './graph';
import { newNode } from './kinds';

const X = 330;
const Y = 150;

function g(nodes: FlowNode[], edges: [string, string, string?][]): FlowGraph {
  return {
    ...emptyGraph(),
    nodes,
    edges: edges.map(
      ([from, to, label], i): FlowEdge => ({ id: `e${i + 1}`, from, to, ...(label && { label }) }),
    ),
  };
}

const at = (col: number, row: number) => ({ x: col * X, y: row * Y });

function model(id: string, col: number, row: number, label: string, role: string, speaks = false): FlowNode {
  const n = newNode('model', id, at(col, row));
  return { ...n, label, params: { ...(n.params as object), role, speaks } } as FlowNode;
}

export const LOCAL_TEMPLATES: FlowTemplate[] = [
  {
    id: 'single',
    name: 'One model',
    description: 'Every message goes to one model. The plain chat, made explicit.',
    graph: g(
      [
        newNode('input', 'input', at(0, 0)),
        model('model_1', 1, 0, 'Assistant', '', true),
        newNode('output', 'output', at(2, 0)),
      ],
      [
        ['input', 'model_1'],
        ['model_1', 'output'],
      ],
    ),
  },
  {
    id: 'router',
    name: 'Router to specialists',
    description: 'A small router reads each message and sends it to the model that suits it best.',
    graph: g(
      [
        newNode('input', 'input', at(0, 1)),
        { ...newNode('router', 'router_1', at(1, 1)), label: 'Router' } as FlowNode,
        model('model_1', 2, 0.4, 'Coder', 'You write and explain code. Show complete, working code.', true),
        model('model_2', 2, 1.6, 'Writer', 'You write clear, well-structured prose.', true),
        newNode('output', 'output', at(3, 1)),
      ],
      [
        ['input', 'router_1'],
        ['router_1', 'model_1', 'code'],
        ['router_1', 'model_2', 'writing'],
        ['model_1', 'output'],
        ['model_2', 'output'],
      ],
    ),
  },
  {
    id: 'rules-router',
    name: 'Rules, then a router',
    description: 'Fixed rules catch the obvious cases for free; a router decides the rest.',
    graph: g(
      [
        newNode('input', 'input', at(0, 1)),
        {
          ...newNode('rule', 'rule_1', at(1, 1)),
          label: 'Obvious cases',
          params: {
            rules: [
              {
                label: 'code',
                all: [{ field: 'text', op: 'matches', value: '```|\\bdef |\\bfunction\\b|\\bclass ' }],
              },
            ],
            default_route: 'decide',
          },
        } as FlowNode,
        { ...newNode('router', 'router_1', at(2, 1.6)), label: 'Router' } as FlowNode,
        model('model_1', 3, 0.4, 'Coder', 'You write and explain code.', true),
        model('model_2', 3, 1.8, 'Writer', 'You write clear prose.', true),
        newNode('output', 'output', at(4, 1)),
      ],
      [
        ['input', 'rule_1'],
        ['rule_1', 'model_1', 'code'],
        ['rule_1', 'router_1', 'decide'],
        ['router_1', 'model_1', 'code'],
        ['router_1', 'model_2', 'writing'],
        ['model_1', 'output'],
        ['model_2', 'output'],
      ],
    ),
  },
  {
    id: 'manager',
    name: 'Manager with a planner and a coder',
    description: 'A manager plans, hands the plan to a coder, checks the result and writes the answer.',
    graph: g(
      [
        newNode('input', 'input', at(0, 1)),
        { ...newNode('manager', 'manager_1', at(1, 1)), label: 'Manager' } as FlowNode,
        model(
          'model_1',
          2,
          0.4,
          'Planner',
          'You break the request into small, ordered steps. Plan only; no code.',
        ),
        model(
          'model_2',
          2,
          1.6,
          'Coder',
          'You implement the plan you are given, exactly. Return only the code and a short note.',
        ),
        newNode('output', 'output', at(3, 1)),
      ],
      [
        ['input', 'manager_1'],
        ['manager_1', 'model_1', 'workers'],
        ['manager_1', 'model_2', 'workers'],
        ['manager_1', 'output'],
      ],
    ),
  },
  {
    id: 'judge',
    name: 'Several models and a judge',
    description: 'Ask three models at once and let a judge keep the best answer.',
    graph: g(
      [
        newNode('input', 'input', at(0, 1)),
        newNode('parallel', 'parallel_1', at(1, 1)),
        model('model_1', 2, 0, 'First opinion', ''),
        model('model_2', 2, 1, 'Second opinion', ''),
        model('model_3', 2, 2, 'Third opinion', ''),
        {
          ...newNode('join', 'join_1', at(3, 1)),
          label: 'Judge',
          params: {
            mode: 'judge',
            judge_model: 'offline/test',
            judge_instructions: 'Keep the answer that is correct, complete and shortest.',
          },
        } as FlowNode,
        newNode('output', 'output', at(4, 1)),
      ],
      [
        ['input', 'parallel_1'],
        ['parallel_1', 'model_1'],
        ['parallel_1', 'model_2'],
        ['parallel_1', 'model_3'],
        ['model_1', 'join_1'],
        ['model_2', 'join_1'],
        ['model_3', 'join_1'],
        ['join_1', 'output'],
      ],
    ),
  },
  {
    id: 'refine',
    name: 'Draft, critique, revise',
    description:
      'One model drafts, another criticises, the first revises, until it is good or three rounds pass.',
    graph: g(
      [
        newNode('input', 'input', at(0, 1)),
        model('model_1', 1, 1, 'Drafter', 'Write the best first draft you can.'),
        { ...newNode('loop', 'loop_1', at(2, 1)), label: 'Until it is good' } as FlowNode,
        model(
          'model_2',
          3,
          0.3,
          'Critic',
          'List the three most important problems with this draft. Be specific.',
        ),
        model('model_3', 3, 1.7, 'Reviser', 'Revise the draft to fix every problem listed.', true),
        newNode('output', 'output', at(4, 1)),
      ],
      [
        ['input', 'model_1'],
        ['model_1', 'loop_1'],
        ['loop_1', 'model_2', 'body'],
        ['model_2', 'model_3'],
        ['model_3', 'loop_1'],
        ['loop_1', 'output', 'done'],
      ],
    ),
  },
  {
    id: 'escalate',
    name: 'Cheap first, escalate when unsure',
    description: 'A fast model answers; a fact-check sends doubtful answers to a stronger model.',
    graph: g(
      [
        newNode('input', 'input', at(0, 1)),
        model('model_1', 1, 1, 'Fast model', '', false),
        newNode('factcheck', 'factcheck_1', at(2, 1)),
        newNode('output', 'output', at(4, 0.5)),
        model('model_2', 3, 1.7, 'Strong model', 'Answer carefully and cite your sources.', true),
      ],
      [
        ['input', 'model_1'],
        ['model_1', 'factcheck_1'],
        ['factcheck_1', 'output', 'sure'],
        ['factcheck_1', 'model_2', 'unsure'],
        ['model_2', 'output'],
      ],
    ),
  },
];
