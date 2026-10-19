/**
 * ------------------------------------------------------------------
 *  Title    |  Starter flows
 *  Ref      |  DESIGN.md §16.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes people reach for first, ready to adapt.
 *  How      |  Core owns the list (services/core/src/flows/templates.ts,
 *           |  built from the models you have ready). This file holds
 *           |  no copy of it: only "One model", for a Core that cannot
 *           |  be reached, and the hook both pages read the list with,
 *           |  so the two cannot drift.
 * ------------------------------------------------------------------
 */

import type { FlowEdge, FlowGraph, FlowNode, FlowTemplate } from '@nvx/contracts';
import { useTemplates } from './api';
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

/** The one shape that needs no Core to describe. */
export const FALLBACK_TEMPLATES: FlowTemplate[] = [
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
];

/** Core's starting shapes, or the single fallback while Core cannot be reached. */
export function useStarterTemplates(): { templates: FlowTemplate[]; fromCore: boolean } {
  const remote = useTemplates();
  const fromCore = !!remote.data?.length;
  return { templates: fromCore ? (remote.data ?? []) : FALLBACK_TEMPLATES, fromCore };
}
