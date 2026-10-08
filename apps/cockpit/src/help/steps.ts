/**
 * ------------------------------------------------------------------
 *  Title    |  First steps
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The eight things that make NVX Ancile click, in the
 *           |  order they build on each other, and whether each one
 *           |  is done. Shared by the rail's checklist and Home.
 *  How      |  A step is done when this person did it here (helpDone,
 *           |  called where the action happens) or when the workspace
 *           |  already shows it happened: a thread exists, a notebook
 *           |  has sources, a thread has more than one branch. So an
 *           |  existing workspace never asks you to do what you did.
 *  Note     |  Each step names a tour that walks you through it, or
 *           |  the palette scope that does it, plus the guide article.
 * ------------------------------------------------------------------
 */

import { useNotebooks, useThreads } from '../lib/data';
import type { PaletteScope } from '../state/ui';
import { type ChecklistStep, useHelp } from './store';

export interface FirstStep {
  id: ChecklistStep;
  label: string;
  /** One line on why it is worth doing. */
  why: string;
  /** The button on Home. */
  action: string;
  article: string;
  tour?: string;
  palette?: PaletteScope;
}

export const STEPS: readonly FirstStep[] = [
  {
    id: 'first-thread',
    label: 'Ask your first question',
    why: 'Type anything and press Enter. Every answer shows which model wrote it and what it cost.',
    action: 'Show me',
    article: 'first-thread',
    tour: 'first-thread',
  },
  {
    id: 'notebook',
    label: 'Start a notebook',
    why: 'A notebook is one project: its files, threads and notes, kept together.',
    action: 'Show me',
    article: 'notebooks',
    tour: 'notebook',
  },
  {
    id: 'source',
    label: 'Add a source',
    why: 'Drop in a PDF, a link or some text. Questions in that notebook are answered from it.',
    action: 'Show me',
    article: 'sources',
    tour: 'notebook',
  },
  {
    id: 'cite',
    label: 'Open a citation',
    why: 'Click a numbered marker in an answer to see the exact passage it came from.',
    action: 'Show me',
    article: 'citations',
    tour: 'cite',
  },
  {
    id: 'branch',
    label: 'Branch or regenerate an answer',
    why: 'Try another wording or another model without losing the first. Both stay in the tree.',
    action: 'Show me',
    article: 'branches',
    tour: 'branching',
  },
  {
    id: 'switch-model',
    label: 'Change the model',
    why: 'Press M anywhere. The conversation so far carries over to the new model.',
    action: 'Pick a model',
    article: 'models',
    palette: 'models',
  },
  {
    id: 'flow',
    label: 'Try a flow',
    why: 'A flow decides which models answer and what each one sees. Start from a ready-made one.',
    action: 'Show me',
    article: 'flows',
    tour: 'flows',
  },
  {
    id: 'palette',
    label: 'Open the palette (Ctrl K)',
    why: 'Every thread, notebook, model, setting and guide page is one search away.',
    action: 'Open it',
    article: 'palette',
    palette: 'all',
  },
];

/** Steps the workspace itself proves are done. */
export function useDerivedSteps(): Partial<Record<ChecklistStep, boolean>> {
  const threads = useThreads().data ?? [];
  const notebooks = useNotebooks().data ?? [];
  return {
    'first-thread': threads.length > 0,
    notebook: notebooks.length > 0,
    source: notebooks.some((n) => n.sources > 0),
    branch: threads.some((t) => t.branches > 1),
  };
}

export function useFirstSteps() {
  const checklist = useHelp((s) => s.checklist);
  const derived = useDerivedSteps();
  const isDone = (id: ChecklistStep) => !!checklist[id] || !!derived[id];
  const done = STEPS.filter((s) => isDone(s.id)).length;
  return {
    isDone,
    done,
    total: STEPS.length,
    complete: done === STEPS.length,
    dismissed: !!checklist.dismissed,
    next: STEPS.filter((s) => !isDone(s.id)),
  };
}
