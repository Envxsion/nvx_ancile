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
    term: 'Why',
    plain:
      'The record of how an answer was made: the model, the passages and memory it was given, the route through a flow and the cost. Open it with W on any answer.',
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
];

export const glossaryEntry = (id: string) => GLOSSARY.find((g) => g.id === id);
