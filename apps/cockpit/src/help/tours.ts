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
 *           |  Every tour declares where it starts (`start`) and a
 *           |  step may move on (`at`); the overlay takes you there
 *           |  and waits for the target before it shows the step
 *           |  (tourPlace.ts). test/tours.test.ts checks every route
 *           |  exists and every target is drawn by that route.
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

/** What a route's one parameter is filled with when the tour has to pick. */
export type TourNeed = 'notebook' | 'thread' | 'flow';

/** A screen: a route pattern from router.tsx, and what fills its parameter. */
export interface TourPlace {
  route: string;
  needs?: TourNeed;
}

export interface TourStep {
  /** The [data-tour] it lights. None: a card in the middle, on purpose. */
  target?: string;
  title: string;
  body: string;
  waitFor?: TourEvent;
  /** Moves to another screen from this step on. */
  at?: TourPlace;
  /** Open the sidebar first: its target lives there. */
  reveal?: 'rail';
  /** Said when the target is not there, instead of the general line. */
  absent?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export interface Tour {
  id: string;
  title: string;
  minutes: number;
  /** Where step 1 happens; null when every step is in the frame around every screen. */
  start: TourPlace | null;
  steps: TourStep[];
}

export const TOURS: Record<string, Tour> = {
  'first-thread': {
    id: 'first-thread',
    title: 'Your first thread',
    minutes: 1,
    start: { route: '/' },
    steps: [
      {
        target: 'composer',
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
    start: null,
    steps: [
      {
        target: 'new-notebook',
        reveal: 'rail',
        title: 'Start a notebook',
        body: 'A notebook holds one project: its sources, threads and notes. Make one with this button.',
        waitFor: 'notebook-created',
        placement: 'right',
      },
      {
        target: 'add-sources',
        at: { route: '/n/$notebookId', needs: 'notebook' },
        absent: 'Make a notebook first, then this step shows where its sources go.',
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
    start: { route: '/t/$threadId', needs: 'thread' },
    steps: [
      {
        target: 'citation',
        absent:
          'This thread has no citations yet. Ask a question in a notebook with sources, then try again.',
        title: 'Where a statement came from',
        body: 'Hover a number to read the passage. Click it to open the source with the passage highlighted.',
        waitFor: 'citation-opened',
        placement: 'top',
      },
      {
        target: 'viewer',
        absent: 'The source opens here once you click a citation number.',
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
    start: null,
    steps: [
      {
        target: 'approvals',
        absent: 'Nothing is waiting for a decision right now. This shows in the status bar when the AI asks.',
        title: 'Decisions waiting',
        body: 'When the AI wants to do something that needs your say, it waits here. The mark in the top-left closes like a shield too.',
        waitFor: 'approval-opened',
        placement: 'top',
      },
      {
        target: 'approval-choices',
        absent: 'The choices appear once a decision is open.',
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
    start: { route: '/t/$threadId', needs: 'thread' },
    steps: [
      {
        target: 'branch-here',
        absent: 'This thread has no answers to branch from yet. Ask something first.',
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
    start: null,
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
        reveal: 'rail',
        title: 'G, then a letter',
        body: 'G T jumps to threads, G N to notebooks, G F filters the sidebar, G S opens settings. J and K move, Enter opens.',
        placement: 'right',
      },
      {
        // No button to light: the ? key is the way in.
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
    start: { route: '/flows' },
    steps: [
      {
        target: 'flows-new',
        title: 'Your flows live here',
        body: 'A flow decides which models answer, in what order, and what each one sees. Make one here, or from a notebook’s Flow button.',
        placement: 'bottom',
      },
      {
        target: 'flow-canvas',
        at: { route: '/flows/$flowId', needs: 'flow' },
        absent: 'You have no flows yet. Make one with New flow, then run this tour again.',
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
  'flow-lab': {
    id: 'flow-lab',
    title: 'Try a flow',
    minutes: 1,
    start: { route: '/flows/$flowId', needs: 'flow' },
    steps: [
      {
        target: 'flow-try',
        absent: 'You have no flows yet. Make one on the Flows page, then run this tour again.',
        title: 'Try it before it answers for real',
        body: 'Run a message through the flow and watch each step light up, with its time and cost. A try-out never writes to a thread.',
        placement: 'bottom',
      },
    ],
  },
};

/** Called where the real action happens, so a waiting tour step moves on. */
export function tourEvent(name: TourEvent): void {
  window.dispatchEvent(new CustomEvent(`ancile:tour:${name}`));
}
