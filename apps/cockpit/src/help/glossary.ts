/**
 * ------------------------------------------------------------------
 *  Title    |  Glossary
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The words NVX Ancile uses that a newcomer would not
 *           |  know, each in one or two plain sentences, with the
 *           |  guide article that says more.
 *  How      |  <Term id> shows an entry where the word appears; the
 *           |  guide's "Words used here" page lists them all; the
 *           |  palette's help scope searches them.
 * ------------------------------------------------------------------
 */

export interface GlossaryEntry {
  id: string;
  term: string;
  plain: string;
  article?: string;
  /** A ### section of that article (its anchor), so "Read more" lands on the place that explains it. */
  section?: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: 'notebook',
    term: 'Notebook',
    plain:
      'One project: its sources, its threads and your notes, kept together. Questions asked in a notebook are answered from its sources.',
    article: 'notebooks',
  },
  {
    id: 'thread',
    term: 'Thread',
    plain: 'One conversation. It can live in a notebook or on its own.',
    article: 'first-thread',
  },
  {
    id: 'source',
    term: 'Source',
    plain:
      'A file, web page or piece of text you added to a notebook. Answers quote it and point to the passage they used.',
    article: 'sources',
  },
  {
    id: 'citation',
    term: 'Citation',
    plain:
      'The small number after a statement. Hover it to read the passage it came from; click it to open the source there.',
    article: 'citations',
  },
  {
    id: 'grounded',
    term: 'Grounded',
    plain:
      'Answered from your sources rather than from what the model already knows. Grounded mode fact-checks every answer against them.',
    article: 'fact-checking',
  },
  {
    id: 'fact-check',
    term: 'Fact-check',
    plain:
      'A second pass that checks each statement in an answer against your sources and marks it supported, unsupported or contradicted.',
    article: 'fact-checking',
  },
  {
    id: 'branch',
    term: 'Branch',
    plain:
      'A second path through a conversation from any message. The original stays as it was, and you can switch between them or compare them.',
    article: 'branches',
  },
  {
    id: 'regenerate',
    term: 'Regenerate',
    plain:
      'Ask for the same answer again, with the same or another model. Each version is kept; the arrows beside an answer move between them.',
    article: 'branches',
  },
  {
    id: 'context',
    term: 'Context',
    plain:
      'Everything a model is shown with your message: the conversation so far, passages from sources and memory. Models can only read so much at once.',
    article: 'context-levels',
  },
  {
    id: 'memory',
    term: 'Memory',
    plain:
      'What NVX Ancile has learned about you and your work, kept as plain files you can read and edit. Nothing is saved without a reason you can see.',
    article: 'memory',
  },
  {
    id: 'memory-proposal',
    term: 'Memory suggestion',
    plain:
      'Something an answer suggests remembering. You keep it or let it go; text from a source or a tool can only ever suggest.',
    article: 'memory-learning',
  },
  {
    id: 'model',
    term: 'Model',
    plain:
      'The AI that writes an answer. You can use several: ones you pay for with an API key, free ones on OpenRouter, or ones on your own machine.',
    article: 'models',
  },
  {
    id: 'api-key',
    term: 'API key',
    plain:
      'A password a provider gives you so apps can use its models, billed per use. It is not the same as a chat subscription such as ChatGPT Plus.',
    article: 'models',
  },
  {
    id: 'flow',
    term: 'Flow',
    plain:
      'A diagram that decides how a message is answered: which models take part, in what order, and what each one sees. Without one, the model you picked answers.',
    article: 'flows',
  },
  {
    id: 'node',
    term: 'Node',
    plain:
      'One box in a flow: a model, a router, a rule, a step that searches sources, and so on. Lines between nodes carry the work from one to the next.',
    article: 'flow-editor',
  },
  {
    id: 'router',
    term: 'Router',
    plain:
      'A node that reads the message and sends it down one of its lines, for example code to a coding model and writing to another.',
    article: 'flows',
  },
  {
    id: 'manager',
    term: 'Manager',
    plain:
      'A node that plans, hands parts of the job to the nodes it is connected to, checks what comes back and writes the answer.',
    article: 'flows',
  },
  {
    id: 'teamwork',
    term: 'Teamwork',
    plain:
      'The fold above an answer from a flow. It shows each step as it happens: who decided what, which model did the work, how long it took and what it cost.',
    article: 'flows',
  },
  {
    id: 'provenance',
    term: 'Receipt',
    plain:
      'The record of how an answer was made: the model, who paid, the cost, the passages and memory it was given and anything that went wrong. Click the line under an answer, or press W.',
    article: 'why',
  },
  {
    id: 'approval',
    term: 'Approval',
    plain:
      'When the AI wants to do something that needs your say, such as running a command, it waits for you. You allow it once, always, or not at all.',
    article: 'approvals',
  },
  {
    id: 'lab',
    term: 'The lab',
    plain:
      'A workspace where the AI can read and write files and run code for you, with every action going through approvals.',
    article: 'lab',
  },
  {
    id: 'gpu-node',
    term: 'GPU node',
    plain:
      'A machine with a graphics card that runs open models for you, such as a RunPod pod or a PC on your network. It can be started and stopped from Compute.',
    article: 'compute',
  },
  {
    id: 'grant',
    term: 'Grant',
    plain:
      'A standing yes to one kind of action, such as "write files in this folder". Remove it any time in Admin.',
    article: 'grants',
  },
  {
    id: 'scope',
    term: 'Scope',
    plain:
      'The places a notebook or thread may reach: its files, its sources, the network. Outside the scope, a call is refused.',
    article: 'grants',
  },
  {
    id: 'permission-tier',
    term: 'Permission tier',
    plain:
      'How careful a tool call needs to be. Reads are low; deletes and sending data are high. Higher tiers ask more.',
    article: 'grants',
  },
  {
    id: 'tier',
    term: 'Model tier',
    plain:
      "How big a job a model is meant for: Frontier, Standard, Small or Tiny. A task asks for a tier and gets the best ready model of it. You can set a model's tier yourself.",
    article: 'models',
    section: 'tiers',
  },
  {
    id: 'pinned',
    term: 'Pinned model',
    plain:
      'A model you chose for a message or a thread. If it cannot answer, only a model that costs the same or less steps in, and the answer says so.',
    article: 'models',
    section: 'when-a-model-cannot-answer',
  },
  {
    id: 'answered-by',
    term: 'Answered by line',
    plain:
      'A short line in an answer that says a different model wrote it than the one you asked for, and why. Nothing is swapped quietly.',
    article: 'models',
    section: 'answered-by-another-model',
  },
  {
    id: 'who-answers',
    term: 'Who answers',
    plain:
      'The one chip in the composer that shows the model, or the flow, that will answer. Open it to pick a model or a flow, or to change one step for this thread.',
    article: 'flow-and-model',
    section: 'what-the-chip-does',
  },
  {
    id: 'fit-line',
    term: 'Fit line',
    plain:
      'The line that appears before you switch to a model whose window cannot hold the thread. It offers to summarise for that model, or to pick another. The full thread always stays.',
    article: 'switching-models',
    section: 'before-you-switch-the-fit-line',
  },
  {
    id: 'summary-level',
    term: 'Summary level',
    plain:
      'A summary is kept as a page, a paragraph and a line. Each model reads the finest size its window holds.',
    article: 'switching-models',
    section: 'summary-levels',
  },
  {
    id: 'decision-model',
    term: 'Decision model',
    plain:
      'A small, fast model that answers a question with a probability instead of writing text. It makes quick choices for Auto mode, flow routers and fact-check sorting.',
    article: 'spend-less-on-decisions',
  },
  {
    id: 'free-allowance',
    term: 'Free allowance',
    plain:
      'The amount a provider lets you use each day at no charge. NVX Ancile counts it, uses it first, and stops before the edge so you are never billed for it.',
    article: 'spend-less-on-decisions',
    section: 'the-free-allowance-in-numbers',
  },
  {
    id: 'private-notebook',
    term: 'Private notebook',
    plain:
      'A notebook whose work stays on this computer. A few extras can be allowed in Settings, and some things are always off.',
    article: 'private-notebooks',
  },
  {
    id: 'verdict-cache',
    term: 'Verdict cache',
    plain:
      'The record of claims already checked. Asking again for the same claim against the same sources is answered from it, with no model call. It can be shared across notebooks.',
    article: 'fact-checking',
    section: 'checked-earlier',
  },
  {
    id: 'triage',
    term: 'Triage',
    plain:
      'Sorting each claim in a fact-check by how much model it needs: tiny for obvious claims, standard or better for numbers and weighty topics, small for the rest.',
    article: 'fact-checking',
    section: 'which-model-checks-each-claim',
  },
  {
    id: 'critical-check',
    term: 'Mission-critical check',
    plain:
      'A fact-check where every claim is judged by two Standard or Frontier models from different companies, and counts only if both agree.',
    article: 'fact-checking',
    section: 'mission-critical-checks',
  },
  {
    id: 'standard',
    term: 'Standard (memory)',
    plain:
      'A short set of rules for what good looks like, learned from an example you show, such as how a manager writes updates. It is always a suggestion until you approve it.',
    article: 'memory-learning',
    section: 'standards-from-examples',
  },
  {
    id: 'passive-memory',
    term: 'Passive memory',
    plain:
      'Remembering things you say in passing. Said once, it waits in the inbox; said again, it is kept with an Undo.',
    article: 'memory-learning',
    section: 'things-you-say-in-passing',
  },
  {
    id: 'inbox',
    term: 'Memory inbox',
    plain:
      'Where suggestions wait for your yes: things noticed once, standards from examples, and lessons that have not been seen twice.',
    article: 'memory-learning',
  },
  {
    id: 'by-purpose',
    term: 'By purpose',
    plain:
      'The part of Usage that says what spend was for: chat answers, fact-checks, memory, decisions, permission checks and more.',
    article: 'usage',
    section: 'by-purpose',
  },
  {
    id: 'shadow',
    term: 'Shadow',
    plain:
      'A second flow that runs beside the live one and only records what it would have done. It never changes an answer.',
    article: 'flow-lab',
  },
  {
    id: 'try-out',
    term: 'Try-out',
    plain: 'A run in the Flow lab on sample messages. Nothing is saved to a thread.',
    article: 'flow-lab',
  },
  {
    id: 'epoch',
    term: 'Epoch',
    plain:
      'A numbered stretch of history. A new one starts when a flow or sync setup changes, so older results stay comparable.',
    article: 'flow-lab',
  },
  {
    id: 'line',
    term: 'Line and latest',
    plain:
      'A name that follows a model family. "Latest" points at whichever model is newest now; the receipt shows which one answered.',
    article: 'receipt',
  },
  {
    id: 'plan-vs-key',
    term: 'Plan and key',
    plain:
      'A plan is a subscription with limits and a flat fee. A key bills each use. Usage shows them apart.',
    article: 'usage',
  },
];

export const glossaryEntry = (id: string) => GLOSSARY.find((g) => g.id === id);
