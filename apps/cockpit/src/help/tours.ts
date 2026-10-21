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

import type { TourEvent } from './tourEvent';

export type { TourEvent };

/** What a route's one parameter is filled with when the tour has to pick. */
export type TourNeed = 'notebook' | 'thread' | 'flow';

/** A screen: a route pattern from router.tsx, and what fills its parameter. */
export interface TourPlace {
  route: string;
  needs?: TourNeed;
  /** A fixed address on a route with a parameter, such as the Decisions group of Settings. */
  exact?: string;
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
  'whats-new': {
    id: 'whats-new',
    title: 'What is new in 0.1.1',
    minutes: 3,
    start: { route: '/' },
    steps: [
      {
        target: 'model-chip',
        title: 'One chip says who answers',
        body: 'It shows the model, or the flow when one answers. Press M to pick a model or a flow. With a flow, the menu lists its model steps, and you can change one for this thread only.',
        placement: 'top',
      },
      {
        target: 'fit-line',
        at: { route: '/t/$threadId', needs: 'thread' },
        absent:
          'This line appears only when you pick a model whose window cannot hold the thread. It offers Switch and summarise or Pick another, and the full thread always stays.',
        title: 'Told before a switch, not after',
        body: 'If the thread will not fit the model you picked, this line says so, with the size before and after. Nothing is summarised until you choose.',
        placement: 'top',
      },
      {
        target: 'factcheck-chip',
        absent:
          'Press F on an answer to check it. The score appears here. Hover a claim to see which tier and model checked it.',
        title: 'Each claim gets the model it needs',
        body: 'Obvious claims go to a tiny model, numbers and weighty topics to a standard one. A claim your sources miss is looked up on the web by default, and one that could not be settled says Not checked, and why.',
        placement: 'top',
      },
      {
        target: 'memory-used',
        absent:
          'Open the receipt on an answer (press W). When memory shaped the answer, a Used: line says which entries.',
        title: 'What memory shaped this answer',
        body: 'The Used: line says in words which memory entries went into the answer. Each links to its file.',
        placement: 'top',
      },
      {
        target: 'decisions-free',
        at: { route: '/settings/$group', exact: '/settings/decisions' },
        title: 'Small models make the quick choices',
        body: 'Decision models pick routes and sort checks. Free allowances are used first, each with a meter, and the app stops before the edge so you are never billed for it.',
        placement: 'bottom',
      },
      {
        target: 'decisions-caps',
        title: 'A daily cap on every paid route',
        body: 'Paid routes stop at the cap you set, $1 a day if you leave it blank. A decision costs a few millionths of a dollar, so this is a safety net.',
        placement: 'top',
      },
      {
        target: 'private-switches',
        at: { route: '/settings/$group', exact: '/settings/private-notebooks' },
        title: 'What a private notebook may use',
        body: 'Four switches, all off to begin with: hosted decision models, learning from passing remarks, sharing fact-check verdicts and fact-checking on the web. The ones below them are always off.',
        placement: 'bottom',
      },
      {
        target: 'usage-purpose',
        at: { route: '/settings/$group', exact: '/settings/usage' },
        absent:
          'By purpose appears once something besides chat has spent tokens: a fact-check, memory learning or a decision.',
        title: 'What the spend was for',
        body: 'Every model call is counted under its purpose: chat, fact-checks, memory, decisions, permission checks and more.',
        placement: 'top',
      },
      {
        target: 'fc-web',
        at: { route: '/n/$notebookId', needs: 'notebook' },
        absent:
          'Open the Sources panel (Alt 1) of a notebook that has sources. The fact-check switches sit above them.',
        title: 'Fact-check switches live with the sources',
        body: 'Use the web when sources do not cover a claim, Mission-critical checks (two standard or frontier checkers), and Share checks with other notebooks, which you can undo.',
        placement: 'left',
      },
      {
        target: 'memory-passive',
        at: { route: '/admin/$section', exact: '/admin/memory' },
        title: 'It learns from what you say in passing',
        body: 'Said once, it waits in the inbox. Said again, it is kept, with Undo. Switch it off here. Private notebooks follow their own setting.',
        placement: 'bottom',
      },
      {
        target: 'memory-inbox',
        title: 'Suggestions wait for your yes',
        body: 'Standards learned from examples, such as how your manager writes updates, always wait here. Use Compare with a standard, in the menu beside Copy, to see how your work differs.',
        placement: 'bottom',
      },
    ],
  },
  decisions: {
    id: 'decisions',
    title: 'Decision models',
    minutes: 1,
    start: { route: '/settings/$group', exact: '/settings/decisions' },
    steps: [
      {
        target: 'decisions-free',
        title: 'Free first',
        body: 'Small models pick routes and sort checks. With this on, a route with free allowance left is tried before any paid one. Each meter counts today’s use and when it resets.',
        placement: 'bottom',
      },
      {
        target: 'decisions-routes',
        title: 'Routes, in words',
        body: 'Each route says whether it is ready, resting or out of allowance. Up and Down set which is preferred when prices tie. Add Cloudflare in Settings → API keys.',
        placement: 'top',
      },
      {
        target: 'decisions-local',
        title: 'On this computer',
        body: 'A decision server you run counts as private and costs nothing. It goes first in private notebooks.',
        placement: 'top',
      },
      {
        target: 'decisions-caps',
        title: 'A cap for each paid provider',
        body: 'The most each may cost in a day (UTC). Leave it blank for $1.',
        placement: 'top',
      },
    ],
  },
  'private-notebooks': {
    id: 'private-notebooks',
    title: 'Private notebooks',
    minutes: 1,
    start: { route: '/settings/$group', exact: '/settings/private-notebooks' },
    steps: [
      {
        target: 'private-switches',
        title: 'Allow a little, for every private notebook',
        body: 'Each switch is off to begin with. A model on this computer, or on a GPU node you run, counts as private, so it can do these jobs without a switch. A search server on this computer counts as leaving.',
        placement: 'bottom',
      },
      {
        target: 'private-fixed',
        title: 'Always off',
        body: 'Cloud models, Claude Code, web search and hosted Auto reviewers are fixed. To use them, turn off Private on that notebook.',
        placement: 'top',
      },
      {
        target: 'decisions-local',
        at: { route: '/settings/$group', exact: '/settings/decisions' },
        title: 'A local decision server counts as private',
        body: 'Point this at a server you run, such as Clef-flash with vLLM, and private notebooks can use decision models without any switch.',
        placement: 'top',
      },
    ],
  },
  'fact-check': {
    id: 'fact-check',
    title: 'Fact-check an answer',
    minutes: 2,
    start: { route: '/n/$notebookId', needs: 'notebook' },
    steps: [
      {
        target: 'fc-grounded',
        absent: 'Open the Sources panel (Alt 1) of a notebook that has sources.',
        title: 'Check every answer',
        body: 'Grounded mode checks each answer in this notebook when it finishes. Or press F on any one answer.',
        placement: 'left',
      },
      {
        target: 'fc-web',
        title: 'The web, when sources miss',
        body: 'On by default. Only the claim’s words are searched, and the evidence is marked Web. Under Strict permissions it waits for one yes per check.',
        placement: 'left',
      },
      {
        target: 'fc-critical',
        title: 'Two checkers for every claim',
        body: 'Mission-critical checks use two standard or frontier models from different companies. If two are not ready, you choose which to use.',
        placement: 'left',
      },
      {
        target: 'fc-share',
        title: 'Share what was checked',
        body: 'A claim checked without your own sources can answer the same claim in other notebooks. A notice offers Undo. Checks against your sources never leave.',
        placement: 'left',
      },
      {
        target: 'factcheck-chip',
        at: { route: '/t/$threadId', needs: 'thread' },
        absent: 'Press F on an answer to check it. The score appears here.',
        title: 'The score, and why',
        body: 'Click it for the evidence. Hover a claim to see its tier, the model and where the evidence came from. A claim that could not be settled says Not checked, with the reason.',
        placement: 'top',
      },
    ],
  },
  memory: {
    id: 'memory',
    title: 'How memory learns',
    minutes: 1,
    start: { route: '/admin/$section', exact: '/admin/memory' },
    steps: [
      {
        target: 'memory-capture',
        title: 'How freely it learns',
        body: 'Learn when sure keeps what it is confident about, with Undo. Always ask sends everything to the inbox. Do not learn leaves memory to you.',
        placement: 'bottom',
      },
      {
        target: 'memory-passive',
        title: 'Things said in passing',
        body: 'Said once, it waits in the inbox. Said a second time, it is kept. Nothing from a web page or a file is ever kept without your yes.',
        placement: 'bottom',
      },
      {
        target: 'memory-inbox',
        title: 'The inbox',
        body: 'Suggestions, standards learned from examples and lessons not yet seen twice wait here. Approve to keep one, choosing where.',
        placement: 'bottom',
      },
      {
        target: 'memory-used',
        at: { route: '/t/$threadId', needs: 'thread' },
        absent: 'Open the receipt on an answer (press W). When memory shaped it, the Used: line appears.',
        title: 'What an answer used',
        body: 'The Used: line in the receipt says which entries shaped the answer, each linked to its file.',
        placement: 'top',
      },
    ],
  },
};
