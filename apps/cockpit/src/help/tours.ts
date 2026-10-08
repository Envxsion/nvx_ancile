/**
 * ------------------------------------------------------------------
 *  Title    |  Tours
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Short guided walks over the real screen. Each step
 *           |  lights one control and says what it is for; where it
 *           |  can, it waits for you to use it rather than for "Next",
 *           |  because doing is how a shortcut sticks.
 *  How      |  A step points at [data-tour="…"]. `waitFor` names a
 *           |  window event the app dispatches when the real action
 *           |  happens (tourEvent()); Next is always there too.
 * ------------------------------------------------------------------
 */

export type TourEvent =
  | 'sent'
  | 'model-changed'
  | 'palette-opened'
  | 'notebook-created'
  | 'source-added'
  | 'citation-opened'
  | 'approval-opened'
  | 'shortcuts-opened'
  | 'branched';

export interface TourStep {
  target: string;
  title: string;
  body: string;
  waitFor?: TourEvent;
  /** Where the step needs you to be; the tour takes you there. */
  route?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export interface Tour {
  id: string;
  title: string;
  minutes: number;
  steps: TourStep[];
}

export const TOURS: Record<string, Tour> = {
  'first-thread': {
    id: 'first-thread',
    title: 'Your first thread',
    minutes: 1,
    steps: [
      {
        target: 'composer',
        route: '/',
        title: 'Ask anything',
        body: 'Type a question and press Enter. Shift Enter starts a new line. Try it now.',
        waitFor: 'sent',
        placement: 'top',
      },
      {
        target: 'model-chip',
        title: 'Choose who answers',
        body: 'This is the model for this thread. Press M anywhere to change it; the conversation so far carries over.',
        placement: 'top',
      },
      {
        target: 'palette',
        title: 'Everything is one search away',
        body: 'Ctrl K opens the palette: threads, notebooks, models, commands, settings and this guide. Open it now.',
        waitFor: 'palette-opened',
        placement: 'bottom',
      },
    ],
  },
  notebook: {
    id: 'notebook',
    title: 'Build a notebook',
    minutes: 2,
    steps: [
      {
        target: 'new-notebook',
        title: 'Start a notebook',
        body: 'A notebook holds one project: its sources, threads and notes. Make one with this button.',
        waitFor: 'notebook-created',
        placement: 'right',
      },
      {
        target: 'add-sources',
        title: 'Give it sources',
        body: 'Drop files anywhere on the notebook, paste a link or text, or add a past thread.',
        waitFor: 'source-added',
        placement: 'bottom',
      },
      {
        target: 'notebook-ask',
        title: 'Ask the notebook',
        body: 'Questions asked here are answered from your sources, with numbered citations you can open.',
        placement: 'top',
      },
    ],
  },
  cite: {
    id: 'cite',
    title: 'Check a citation',
    minutes: 1,
    steps: [
      {
        target: 'citation',
        title: 'Where a statement came from',
        body: 'Hover a number to read the passage. Click it to open the source with the passage highlighted.',
        waitFor: 'citation-opened',
        placement: 'top',
      },
      {
        target: 'viewer',
        title: 'The exact span',
        body: 'The viewer scrolls to the passage the answer used, with its page for PDFs. Read around it before you trust it.',
        placement: 'left',
      },
    ],
  },
  approve: {
    id: 'approve',
    title: 'Approve a tool call',
    minutes: 1,
    steps: [
      {
        target: 'approvals',
        title: 'Decisions waiting',
        body: 'When the AI wants to do something that needs your say, it waits here. The mark in the top-left closes like a shield too.',
        waitFor: 'approval-opened',
        placement: 'top',
      },
      {
        target: 'approval-choices',
        title: 'Once, always, or not at all',
        body: 'Approve it once, or always for a pattern you choose. Risky actions only ever offer once. Everything you allow is listed in Admin, and can be taken back.',
        placement: 'left',
      },
    ],
  },
  branching: {
    id: 'branching',
    title: 'Branch without losing your place',
    minutes: 1,
    steps: [
      {
        target: 'branch-here',
        title: 'Branch from any message',
        body: 'Hover a message and press B, or use this button. The thread opens there and your next message starts the new branch. Try it.',
        waitFor: 'branched',
        placement: 'bottom',
      },
      {
        target: 'context-meter',
        title: 'How full this branch is',
        body: "Each branch uses only its own history. When it fills the model's context, compact it from here or from the chip above the composer.",
        placement: 'top',
      },
    ],
  },
  keyboard: {
    id: 'keyboard',
    title: 'Keyboard in 60 seconds',
    minutes: 1,
    steps: [
      {
        target: 'palette',
        title: 'Ctrl K',
        body: 'The palette shows the key for every command, so it teaches you as you go. Open it.',
        waitFor: 'palette-opened',
        placement: 'bottom',
      },
      {
        target: 'rail',
        title: 'G, then a letter',
        body: 'G T jumps to threads, G N to notebooks, G F filters the sidebar, G S opens settings. J and K move, Enter opens.',
        placement: 'right',
      },
      {
        target: 'shortcuts',
        title: 'Every key, any time',
        body: 'Press ? to see them all. Any of them can be changed in Settings → Keyboard.',
        waitFor: 'shortcuts-opened',
        placement: 'bottom',
      },
    ],
  },
  flows: {
    id: 'flows',
    title: 'Draw a flow',
    minutes: 2,
    steps: [
      {
        target: 'notebook-flow',
        title: 'Every notebook can answer its own way',
        body: 'Its Flow decides which models answer, in what order, and what each one sees. Open it.',
        placement: 'bottom',
      },
      {
        target: 'flow-canvas',
        title: 'The canvas',
        body: 'Press Tab to add a node, or drag from a port into empty space. Type a model’s name to drop it in, set up. Hover any connection to see exactly what crosses it.',
        placement: 'top',
      },
      {
        target: 'flow-try',
        title: 'Try it before it answers for real',
        body: 'Run a message through the flow and watch each step light up, with its time and cost. Nothing is written to a thread.',
        placement: 'bottom',
      },
    ],
  },
};

/** Called where the real action happens, so a waiting tour step moves on. */
export function tourEvent(name: TourEvent): void {
  window.dispatchEvent(new CustomEvent(`ancile:tour:${name}`));
}
