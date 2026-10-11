/**
 * ------------------------------------------------------------------
 *  Title    |  The help guide
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a person needs to use NVX Ancile well, in
 *           |  the app, offline, and searchable from the palette.
 *  How      |  Chapters of short articles in markdown. Each article
 *           |  may name a tour that shows it on the real screen, and
 *           |  error codes from docs/errors.md point at the article
 *           |  that explains them (ERROR_ARTICLES).
 *  Note     |  Copy rules: plain, sentence case, British spelling, no
 *           |  em dashes, "NVX Ancile" in full where it names the app.
 * ------------------------------------------------------------------
 */

import { GLOSSARY } from './glossary';

export interface Article {
  id: string;
  title: string;
  summary: string;
  body: string;
  keywords?: string;
  tour?: string;
}

export interface Chapter {
  id: string;
  title: string;
  articles: Article[];
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'start',
    title: 'Getting started',
    articles: [
      {
        id: 'welcome',
        title: 'What NVX Ancile is',
        summary: 'A private workspace for thinking with AI, on your own machine.',
        keywords: 'about overview introduction private local',
        body: `NVX Ancile is a workspace for serious work with AI models. Everything it keeps stays on this computer: your threads, your notebooks and their sources, your notes, and the record of every decision the AI asked you to make.

It has four parts you will use most:

- **Threads** are conversations. Each answer can be regenerated, edited or continued by another model, and every version is kept.
- **Notebooks** gather sources (files, links, pasted text, past threads). Questions asked inside a notebook are answered from those sources, with numbered citations that open the exact passage.
- **The lab** hands a message to an agent that can read and change files in its own folder, asking you before anything risky.
- **Approvals** are how the AI asks permission. You decide once, always, or every time, and you can take any decision back in Admin.

Press **Ctrl K** (⌘K on a Mac) at any time to search everything or run any command.`,
      },
      {
        id: 'glossary',
        title: 'Words used here',
        summary: 'Notebook, branch, flow, router, grounded and the rest, in plain words.',
        keywords: 'glossary terms jargon meaning definitions what is',
        body: `Words with a dotted underline explain themselves when you point at them. Here they all are.

${GLOSSARY.map((g) => `- **${g.term}**: ${g.plain}`).join('\n')}`,
      },
      {
        id: 'first-thread',
        title: 'Your first thread',
        summary: 'Ask a question, watch it stream, and keep what you need.',
        keywords: 'chat message send new thread start',
        tour: 'first-thread',
        body: `Press **N** or choose **New thread**, type your question and press **Enter**. **Shift Enter** starts a new line.

While the answer is written you can keep reading, scroll away or close the window: the answer finishes on its own and is waiting when you come back. **Stop** keeps what was written so far.

Hover an answer (or select it and use its key) to:

- **R** regenerate it, keeping the old version one click away
- **E** edit your message and send it again as a new version
- **C** copy it
- **X** run your message in the lab

The arrows above a message move between its versions.`,
      },
      {
        id: 'branches',
        title: 'Branches and the tree',
        summary: 'Try another direction without losing the one you were on.',
        keywords: 'branch tree fork version compare merge compact context sibling delete undo',
        tour: 'branching',
        body: `A thread is a tree. Every edit, every regenerate and every branch starts a new path from an earlier point, and the old path stays exactly as it was. Each path remembers only its own history, so a branch never sees what was said on another.

**Branch from here.** Hover a message and press **B** (or right-click it). The thread opens at that message; the next thing you send starts the new branch. Branches you name follow their newest message.

**Versions.** The arrows above a message, or **Alt [** and **Alt ]**, step through the versions of the selected message.

**The tree.** **Alt 3** shows it beside the thread; **G B** opens it full screen. Straight stretches of conversation fold into one node with a count. Click the tree, then **J** and **K** walk it, **H** and **L** move between versions, **Enter** jumps the conversation there. Right-click a node to branch, rename or delete from it.

**Compare and merge.** Press **C** on a node to compare it with where you are, or shift-click two nodes. You see both sides from where they split, turn by turn, with a short account of how they differ. **Merge** makes a new thread from the best of both: pick the messages yourself, or let a model write one combined answer that marks each point A or B. Nothing in the original thread changes.

**Context.** The meter in the status bar shows how much of the model's context this path uses. Past 80% a chip above the composer offers **Compact now**: older messages become a summary and the latest turns stay word for word. Every branch through that point reuses the same summary. At 95% it happens before the next answer by itself, and the answer says so.

**Deleting.** **Delete from here** removes a message and everything that grew from it. It tells you how many messages go first, and **Undo** brings them back for 30 seconds.

When a message starts a clearly different topic, a quiet chip offers to name the branch. It never branches on its own.`,
      },
      {
        id: 'models',
        title: 'Adding models',
        summary: 'Paste a key, test it, and choose which model answers.',
        keywords: 'api key provider anthropic openai google ollama openrouter model setup',
        body: `Open **Settings → API keys** and press **Add API key** beside a provider. The key is checked with one tiny call before it is saved, so you know it works before you rely on it. Keys are encrypted on this computer and never shown again. Admin → Models lists every model and switches each one on or off.

Ollama on this computer is found from the setup screen: press **Find it**. If it isn't installed, **Get Ollama** opens the download page, and NVX Ancile notices it by itself once it is running.

Press **M** anywhere to change the model for the thread you are in. The next message uses it, and the conversation so far carries over.

If a model fails or declines, NVX Ancile asks the next one in its chain without interrupting you. The answer says which model wrote it, and **Why** shows every attempt.`,
      },
      {
        id: 'offline-model',
        title: 'The try-out models',
        summary: 'Try everything before you add a key. They do not use AI.',
        keywords: 'test offline fake say fail tool slow directive echo try-out tryout',
        body: `Until you add a model, threads are answered by the built-in **Offline test model**, marked **Try-out** in the model switcher. It doesn't use AI and needs nothing installed, but it can stream, call tools and fail on request, so you can see how NVX Ancile behaves. Type **/** in the composer to see its commands:

- **/say** *text*: answer with exactly that text
- **/slow** *text*: write one word every 150 ms
- **/fail 500**, **/fail refusal**, **/fail auth**: fail on purpose, and watch NVX Ancile switch to the backup model (Offline echo) and say so
- **/tool fs_write** *{"path":"note.md","content":"hi"}*: call a tool, which asks for your approval first

Offline echo, the backup, only repeats what you wrote.

Once a real model is ready, the try-out models leave the model switcher and the flow pickers. To keep them, turn on **Settings → Advanced → Show try-out models**.`,
      },
      {
        id: 'api-keys',
        title: 'API keys',
        summary: 'Add, replace and remove every key NVX Ancile uses.',
        keywords:
          'api key token secret runpod hugging face github memory backup remote environment replace remove',
        body: `**Settings → API keys** lists every credential: the model providers, RunPod, Hugging Face, GitHub and the memory backup remote.

- **Add** or **Replace** opens a field (press **Show** to check what you pasted). The value is checked with the service before it is saved, then encrypted on this computer.
- A saved value is never shown again: the row says **Saved** and its last four characters, so you can tell keys apart.
- **Remove** asks first and says what stops working.
- **Get a key** opens the provider's own page for making one.

A row marked **Set in the environment** comes from a variable where NVX Ancile is started (for example in \`.env\`). It wins over anything saved here, so it is read-only: change it there and restart.`,
      },
    ],
  },
  {
    id: 'notebooks',
    title: 'Notebooks and citations',
    articles: [
      {
        id: 'notebooks',
        title: 'Notebooks',
        summary: 'A place for one project: its sources, its threads, its notes.',
        keywords: 'notebook project create folder',
        tour: 'notebook',
        body: `A notebook holds everything for one piece of work. Create one from the **+** beside Notebooks in the sidebar, or from the palette.

Threads started inside a notebook are **grounded**: before the model answers, NVX Ancile finds the passages in the notebook's sources that best match the question and gives them to the model, which cites them by number.

Move an existing thread into a notebook from its menu (right-click it in the sidebar).`,
      },
      {
        id: 'sources',
        title: 'Adding sources',
        summary: 'Files, links, pasted text and past threads.',
        keywords: 'source upload file pdf docx url link paste text drop import',
        body: `Drop files anywhere on a notebook, or use **Add sources**. NVX Ancile reads PDFs (page by page), Word, PowerPoint and Excel files, web pages, markdown and plain text, and code.

Each source shows what is happening to it: reading, cutting it into passages, indexing. A source is ready when its passages can be found by meaning as well as by words.

You can also paste a link, paste text, or add a past thread as a source, so a long conversation becomes something a later question can cite.

If you add something that is already there, NVX Ancile offers to **merge** the two.`,
      },
      {
        id: 'context-levels',
        title: 'What a question can use',
        summary: 'Full, summary only, or off, per source.',
        keywords: 'context level off insights summary full exclude include',
        body: `Every source in a notebook has a setting for how much a question may draw from it:

- **Full**: any passage can be found and cited.
- **Summary**: only the source's summary is used. Good for background reading.
- **Off**: ignored, but kept in the notebook.

Change it from the source's row in the Sources panel. **Why** on an answer shows which passages were found, which were cited, and how each scored.`,
      },
      {
        id: 'citations',
        title: 'Citations',
        summary: 'Numbers in an answer that open the exact passage.',
        keywords: 'citation cite reference footnote source passage quote verify',
        tour: 'cite',
        body: `In a grounded answer, numbers like **[1]** mark where a statement came from. Hover one to see the passage. Click it to open the source with the passage highlighted, scrolled into view, with its page for PDFs.

A citation the model made up (a number that matches no passage it was given) is removed before you see the answer, and **Why** counts how many were removed.

When every statement in an answer is backed by a citation, it carries a small gilt seal.`,
      },
      {
        id: 'fact-checking',
        title: 'Fact-checking an answer',
        summary: 'Check each claim against your sources, with an independent model.',
        keywords: 'fact check verify claim evidence contradicted confidence grounded mode seal true false',
        body: `Press **F** on an answer, or choose **Fact-check** under it. NVX Ancile splits the answer into claims that can be checked, finds passages in your sources for each, and asks a second model, from a different family than the one that answered where one is ready, to judge each claim against them.

Each claim is then underlined where it sits in the answer:

- a faint dotted line in green: **verified**, your sources state it
- a dotted grey line: **unverified**, there is not enough evidence either way
- a wavy red line: **contradicted**, your sources say otherwise, and both sides are shown

Opinions, advice and predictions are left alone: there is nothing to check them against.

Hover or focus a claim to see the passage behind its verdict, and open it in the source. The score under the answer is a weighted mean of every claim's confidence; hover it for the breakdown in words. An answer whose every checkable claim is verified earns the gilt seal.

**Grounded mode** fact-checks every answer in a notebook as soon as it finishes. Turn it on from the Sources panel.`,
      },
      {
        id: 'why',
        title: 'Why did it say this?',
        summary: 'The model, memory, passages, tools and cost behind one answer.',
        keywords: 'why explain provenance trace attempts fallback memory retrieval tools decisions cost',
        body: `Press **W** on an answer, or choose **Why** under it, to open the full story of how it was made:

- which model answered, and every model tried before it with the reason it was passed over
- the memory it was given: each file, the commit it was read at, and the entries that fitted
- the passages retrieved from your sources, how each ranked before and after reranking, and which it cited
- each tool it used and the permission decision that let it run, or stopped it
- whether older turns were compacted into a summary to make room
- tokens, cost and the latest fact-check

Nothing here is reconstructed after the fact: it is what Core recorded while the answer was written.`,
      },
      {
        id: 'notes',
        title: 'Notes',
        summary: 'Keep answers and your own writing beside the sources.',
        keywords: 'note save answer write markdown',
        body: `**Save as note** on any answer keeps it in the notebook, with a link back to where it came from. You can also write notes of your own in markdown from the Notes panel (**Alt 2**).

Notes are yours: they are not sources, so questions do not cite them unless you add one as a source.`,
      },
    ],
  },
  {
    id: 'lab',
    title: 'The lab and approvals',
    articles: [
      {
        id: 'lab',
        title: 'Running in the lab',
        summary: 'An agent that works on files, asking before anything risky.',
        keywords: 'lab agent opencode files code run undo',
        body: `**Run in the lab** (key **X** on one of your messages) hands it to an agent that works in its own folder for this thread. It can read, write and run commands there.

The agent asks before anything that changes files or runs a command, through the same approval dialog as every other tool.

Under the answer, **What the lab changed** lists every file it added, changed or deleted, with the differences. **Undo these changes** puts the folder back exactly as it was before the run.`,
      },
      {
        id: 'approvals',
        title: 'Approvals',
        summary: 'Once, always, or every time: you decide what the AI may do.',
        keywords: 'approval permission allow deny grant always once tier critical gated',
        tour: 'approve',
        body: `Every tool call is checked at the moment it runs, on its real arguments. There are three tiers:

- **Auto**: reading inside the workspace. It just happens.
- **Asks once**: writing, fetching, running something reversible. Approve it **once**, or **always** for a pattern you choose (for example, every file under one folder).
- **Asks every time**: deleting, writing outside the workspace, running shell commands. There is no "always" for these.

While the AI waits, the mark in the top-left closes like a shield and the status bar counts the decisions waiting. You can leave and come back: the run waits for you, even across a restart.

Admin → Grants lists everything you have allowed, and any grant can be revoked.`,
      },
      {
        id: 'presets',
        title: 'Careful, Balanced, Hands-off',
        summary: 'The starting point for what is asked.',
        keywords: 'preset careful balanced hands off policy',
        body: `The preset you chose in setup decides the defaults:

- **Careful** asks for everything that is not reading, every shell command and network write asks every time, and an answer is remembered for this thread at most.
- **Balanced** asks once for reversible actions, until you remember the answer, and every time for risky ones.
- **Hands-off** writes files in your workspace without asking, and still asks for the risky ones.

Whatever the preset, deleting, sending, spending and writing outside your workspace ask every time.

Change it in Admin → Permissions. Policies an administrator writes in Cedar always win over the preset.`,
      },
    ],
  },
  {
    id: 'compute',
    title: 'Your GPU nodes',
    articles: [
      {
        id: 'compute',
        title: 'Running models on your own GPU',
        summary: 'A RunPod pod or a machine on your network, started when you need it.',
        keywords:
          'compute gpu node runpod pod ollama vllm local network start stop wake cost connect api key',
        body: `Admin → Compute lists the GPU nodes NVX Ancile manages for you: pods in your RunPod account, or machines on your own network running Ollama, vLLM or any OpenAI-compatible server.

Every model a node serves appears in the model switcher as "*model* on *node*". Ask it something while the node is stopped and NVX Ancile wakes it: the answer shows **Waking your GPU node** with roughly how long it takes, then streams in as soon as the node is up. **Use a cloud model instead** answers at once with your next model.

**Start** and **Stop** walk a four-link chain you can watch: requested, acknowledged, in progress, confirmed. If the provider says no, its own words appear under the failed link with what to do about it.

Each card shows the hourly rate, the hours and money spent this month, and the projection if things stay as they are. A machine on your network costs nothing per hour; NVX Ancile cannot switch it on or off, but notices within a minute when you do.

Until you connect a provider, two **sample** nodes show how it all works. They start, stop and answer, and cost nothing.

**Connect RunPod** takes an API key from RunPod (Settings → API Keys, with read and write access to pods). It is checked with RunPod before anything changes and kept encrypted on this computer; the sample nodes then go. To set a pod up yourself, **Add a node** → *Setting the pod up yourself?* has the exact start command and settings to copy.`,
      },
      {
        id: 'compute-rules',
        title: 'Rules: idle stop, cap, schedule',
        summary: 'Keep GPU bills where you want them, automatically.',
        keywords: 'rules idle timeout cost cap budget schedule nightly stop automatic',
        body: `Three kinds of rule keep nodes in check. Each acts through the same confirmation chain as your own clicks, and is listed on the node it acted on.

- **Stop idle nodes**: a running node that has answered nothing for the minutes you choose is stopped. Its disk is kept.
- **Monthly cap**: when this month's spend reaches the amount, NVX Ancile either answers with your cloud models instead, stops the nodes, or just tells you. You are warned before you get there.
- **Stop on a schedule**: every day at a time you choose, in your time zone. Handy for "never leave it running overnight".

Turn any rule off with its switch; change a number and it saves when you leave the field.`,
      },
    ],
  },
  {
    id: 'keys',
    title: 'Keyboard and palette',
    articles: [
      {
        id: 'palette',
        title: 'The command palette',
        summary: 'Ctrl K reaches everything.',
        keywords: 'palette command search ctrl k find',
        tour: 'keyboard',
        body: `**Ctrl K** (⌘K on a Mac) opens the palette. Type to search threads, notebooks, models, commands, settings and this guide all at once, or start with a prefix:

- **>** commands
- **@** models
- **#** notebooks
- **?** help
- **,** settings

Search finds words inside messages too, not only titles. The palette shows the key for every command, so it teaches you the shortcuts as you go.`,
      },
      {
        id: 'navigate',
        title: 'Moving around without the mouse',
        summary: 'Single keys, sequences, and navigate mode.',
        keywords: 'keyboard shortcuts navigate vim keys g sequence',
        body: `Single keys work whenever you are not typing. **Esc** leaves the composer for navigate mode; **I** comes back.

- **G** then a letter goes somewhere: **G N** notebooks, **G T** threads, **G F** filter the sidebar, **G S** settings, **G H** this guide, **G A** admin
- **J** and **K** move through a list once it has focus, **Enter** opens
- **[** and **]** hide or show the sidebar and side panel
- **Ctrl .** focus mode, **Ctrl =** and **Ctrl -** zoom
- **?** shows every shortcut

Any key can be changed in Settings → Keyboard.`,
      },
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    articles: [
      {
        id: 'memory',
        title: 'What NVX Ancile remembers',
        summary: 'Plain files you can read, edit and roll back.',
        keywords: 'memory remember learn preferences forget git files',
        body: `NVX Ancile keeps a small set of markdown files and gives the relevant parts to every model it calls, so you do not have to repeat yourself.

- **House rules** (AGENTS.md) apply to every model. Only you change them.
- **About you** (USER.md) holds preferences, mostly learned from your corrections.
- **Notebooks** each get a file of decisions and findings.
- **Lessons** record what went wrong once and what fixed it. Only the lessons that look relevant to your request are given to the model.
- **Models** hold quirks of a particular model, given only to that model.

Open it in **Admin → Memory**. Every change is a commit: **History** shows who changed what and when, and **Undo this change** takes any of it back.

To see exactly what a thread's next answer will be given, open **Why** on any answer: the memory it used is listed with the version of each file.`,
      },
      {
        id: 'memory-learning',
        title: 'How it learns',
        summary: 'Corrections become preferences; a failure then a fix becomes a lesson.',
        keywords: 'memory learn correction capture inbox propose auto undo',
        body: `After each answer, NVX Ancile looks for two things, without slowing the answer down:

- **A correction in your own words.** "No, use British spelling" or "always give metric units" becomes a preference. A one-off fix ("the second number is wrong") does not.
- **A tool that failed and then worked.** The lesson goes in Lessons so the same mistake is spotted sooner next time.

Before anything is written, it is compared with what is already remembered: the same thing said again is ignored, a better wording replaces the old one, and a change of mind keeps the old belief under Superseded so you can see what changed.

How freely it learns is your choice, at the top of **Admin → Memory** (Settings → Advanced links there):

- **Learn when sure** keeps what it is confident about and shows a toast with **Undo**. Anything less certain waits in the inbox.
- **Always ask** sends every suggestion to the inbox.
- **Do not learn** leaves memory to you.

Whatever you choose, something that came from a web page, a file or a tool's output is never kept without your yes. That is how memory stays yours.`,
      },
      {
        id: 'memory-editing',
        title: 'Editing memory by hand',
        summary: 'One idea per bullet; review before saving.',
        keywords: 'memory edit file markdown conflict merge bullet',
        body: `In Admin → Memory, pick a file and choose **Edit**. Write each memory as one bullet with one idea. The comments at the end of learned lines (\`<!-- m:… -->\`) keep track of where each entry came from; leave them, or delete them if you like, it does no harm.

**Review changes** (or **Ctrl S**) shows exactly what will change before it is committed. If NVX Ancile learned something in the same file while you were typing, the two are merged for you. If they touched the same lines, both versions are shown side by side so you can keep what you want.`,
      },
    ],
  },
  {
    id: 'running',
    title: 'Keeping it running',
    articles: [
      {
        id: 'health',
        title: 'Health and self-healing',
        summary: 'Every service is checked every 15 seconds and brought back when it stops.',
        keywords: 'health restart down service supervisor heal knowledge controller database attention',
        body: `**Admin → Health** shows each part of NVX Ancile: the database, Knowledge, the Controller, the lab and disk space, with how fast each answers.

A service that stops answering turns red at once, and is checked every 5 seconds until it is well. After three failed checks in a row NVX Ancile restarts it on its own (when started with \`pnpm start\`) and tells you. If it keeps falling over, it stops trying and marks the service **Needs attention** with the last error and what to do.

**Restart** on a card brings a service back by hand. **Check now** checks everything at once instead of waiting.`,
      },
      {
        id: 'diagnostics',
        title: 'The self-check',
        summary: 'One press checks everything, with a fix for anything wrong.',
        keywords: 'diagnostics self check test boot fix problem',
        body: `**Admin → Diagnostics → Run the self-check** checks the database, every service and model, your memory files, stored keys, disk space and the boot tests, about 20 checks in 20 seconds. Results arrive as they finish.

Anything wrong is listed at the top with its fix, ready to copy. Earlier checks are kept below, so you can see whether something changed.`,
      },
      {
        id: 'logs',
        title: 'Reading the logs',
        summary: 'Every service in one list: filter, follow live, export.',
        keywords: 'logs log errors warnings follow live export csv json trace filter search',
        body: `**Admin → Logs** shows what every service wrote, newest first. Narrow it by level, service, component, words and time. **Live** (or \`l\`) follows new lines as they are written; scroll down and new lines wait behind a button instead of moving what you are reading. \`/\` searches.

Open a line to see everything it carried. **Only this trace** shows every line written while doing the same thing, across services; **Open trace** shows it as a timeline.

**JSON** and **CSV** download exactly what the filters show.`,
      },
      {
        id: 'traces',
        title: 'Traces and replay',
        summary: 'See what happened, in order; re-run an answer with another model.',
        keywords: 'trace traces waterfall replay rerun re-run step model timeline span',
        body: `**Admin → Traces** lists what NVX Ancile did, newest first: each message, upload or change. Open one to see it as a waterfall: every step, model attempt and call to another service, with how long it took and the log lines it wrote.

For an answer, **Replay the run** steps through it like a recording: \`←\` and \`→\` move a step, \`Space\` plays.

**Re-run from here** asks again from the chosen step, with the same model or another. Everything before that step is kept, and any tool the model asks for is answered from the original recording: nothing is written, deleted or sent a second time. The new answer appears beside the original in its thread, so you can compare them.`,
      },
      {
        id: 'automations',
        title: 'Automations',
        summary: 'What NVX Ancile does on its own, and when.',
        keywords: 'automations schedule cron cleanup backup stale links run now',
        body: `**Admin → Automations** lists the work NVX Ancile does by itself. Scheduled jobs (clean-up, memory backup, checking links for changes, model statistics) show when they last ran, how it went, and when they run next. **Run now** runs one straight away; the switch stops its schedule.

The jobs that run on events, like naming a new thread or learning from a correction, are listed too, so nothing happens out of sight.`,
      },
      {
        id: 'connect-apps',
        title: 'Using NVX Ancile from other apps',
        summary: 'Connect an editor or assistant over MCP, with only the access you choose.',
        keywords: 'mcp connect app editor token plugin search server grant',
        body: `Apps that speak MCP (editors, desktop assistants) can search your sources and memory. In **Admin → Plugins → Connect an app**, name the app and tick what it may do. You get a token and a ready-made config to paste into the app, shown once.

Every call the app makes is checked like the assistant's own and recorded in **Decisions**. **Disconnect** stops its token at once; you can also take back one kind of access in **Grants**.

For apps that only start commands, run the stdio bridge with your token in \`ANCILE_MCP_TOKEN\`.`,
      },
      {
        id: 'licence',
        title: 'Free and Pro',
        summary: 'Everything you need is free; Pro adds scale.',
        keywords: 'licence license pro key activate free edition features',
        body: `Everything for working with your own models, sources and memory is in the free edition and stays there. Pro adds GPU pools, asking several models at once, teams, encrypted sync, long research and smart routing.

To turn Pro on, paste the key from your nvx.sh account (NVX-XXXX-XXXX-XXXX) in **Admin → Licence**. The licence is checked on this computer, so Pro keeps working offline. **Move to another computer** frees the key for use elsewhere.`,
      },
    ],
  },
  {
    id: 'yours',
    title: 'Making it yours',
    articles: [
      {
        id: 'settings',
        title: 'Settings',
        summary: 'Appearance, layout, reading, composer, keys and more.',
        keywords:
          'settings preferences customise theme accent density font timestamps cost paste plain developer gilt focus sound',
        body: `Open Settings with **Ctrl ,** or **G S**. Every change applies at once and follows you to other devices. A dot marks anything you have changed; **Reset** puts one setting, a group, or everything back.

- **Appearance**: theme, accent colour, ground tint, contrast, glass or solid surfaces, grain, the gilt details, corners, fonts, heading width and zoom. The accent row shows it at work: the main button, a focus ring and a live dot, the only three places it appears. Gilt can be on, subtle (muted brass, no glow) or off.
- **Layout**: density (row height in the sidebar, lists, tables and menus), sidebar and panel widths, the tab the side panel opens on, and what the status bar shows. The GPU node appears there only while one is running.
- **Reading**: text size and code size in answers, line spacing, reading width, whether answers show as they are written or all at once, citations, message times, tokens and cost under answers, and whether tool steps start folded.
- **Composer**: the send key, spellcheck, paste as plain text (off keeps links and lists from a web page as markdown), the / and @ menus, snippets.
- **Keyboard**: change any key, and whether single keys work at all.
- **Notifications**: where toasts appear, for how long, which kinds, and a soft sound when a decision waits for you.
- **Accessibility**: motion, transparency, focus rings (every ring, thicker), underlined links, larger targets, and how often a screen reader hears an answer as it arrives.
- **Advanced**: effects, help hints, developer details (a menu under each message to copy its ids and raw JSON), your own CSS.

The theme button in the title bar always switches to the other theme; when that is the one your system uses, it goes back to following the system.

**Export settings** saves everything to one file; **Import** shows what would change before applying it.`,
      },
      {
        id: 'snippets',
        title: 'Snippets',
        summary: 'Type ;sig and get your signature.',
        keywords: 'snippet abbreviation text expansion template',
        body: `In Settings → Composer, give a snippet a trigger that starts with a semicolon (for example **;brief**) and the text it stands for. Typing the trigger followed by a space in the composer replaces it with the text.`,
      },
    ],
  },
  {
    id: 'trouble',
    title: 'When something goes wrong',
    articles: [
      {
        id: 'offline',
        title: 'Core is not answering',
        summary: 'What the banner means and what to do.',
        keywords: 'offline core down not answering connection banner',
        body: `NVX Ancile is two programs: the window you see, and **Core**, which keeps your data and talks to models. If Core stops answering, a banner says so and everything you had loaded stays on screen.

Core restarts on its own when it can. If the banner stays, restart NVX Ancile. Nothing you sent is lost: answers that were being written finish when Core is back.`,
      },
      {
        id: 'errors',
        title: 'Reading an error',
        summary: 'Every error says what happened and what to do.',
        keywords: 'error code trace debug copy',
        body: `Errors in NVX Ancile always say what happened and what to do next. **Copy debug info** puts the error's code and trace id on the clipboard; the trace id finds every log line for that action in Admin → Logs.

If a model fails, NVX Ancile has usually already tried the next one: the answer says which model wrote it.`,
      },
      {
        id: 'source-failed',
        title: 'A source could not be added',
        summary: 'Scanned PDFs, pages that will not load, and other cases.',
        keywords: 'source failed scanned pdf ocr fetch failed embedding',
        body: `A source that fails says why on its row, with **Retry**:

- **Looks scanned**: the PDF is images of pages with no text. Turn on OCR in Settings, then retry.
- **Could not be fetched**: the link did not load, or points somewhere NVX Ancile will not go (private addresses are refused on purpose). Check the link, or paste the text instead.
- **Indexing unavailable**: the local embedding model could not run. Text search still works; retry later.`,
      },
    ],
  },
  {
    id: 'flows',
    title: 'Flows: how answers are made',
    articles: [
      {
        id: 'flows',
        title: 'What a flow is',
        summary: 'A graph you draw that decides which models answer, in what order, and what each one sees.',
        keywords: 'routing router graph canvas pipeline team specialist jev openrouter runpod',
        tour: 'flows',
        body: `A **flow** answers your messages with more than one model. You draw it: the message comes in on the left, the answer leaves on the right, and in between are the models and the decisions that pick between them.

**Where flows apply**, most specific first:
- a single message, with \`@flow\` in the composer
- a model picked for a single message (\`@model\`) answers alone, instead of any flow
- a thread's own flow, or flows turned off for the thread
- its notebook's flow (open the notebook and choose **Flow**)
- the workspace default (Flows in the palette)

With no flow at all, answers come from the model you pick, as in a plain chat. See **Models and flows together** for what changing the model does while a flow answers.

**What you can draw**
- **Model**: one call to any model you have: an API key, OpenRouter, Ollama, or a model on your GPU node.
- **Router**: a model reads the request and picks a route, with a reason and a confidence. Describe each route in plain words.
- **Rules**: fixed conditions, no model call: the notebook, words in the message, its length, the time, the budget left, whether a GPU node is awake.
- **Manager**: plans, hands sub-tasks to the models below it, checks their work and writes the answer.
- **Fan out** and **Join**: ask several models at once, then keep all, the first, a vote, or a judge's pick.
- **Loop**: repeat steps until a check says done, with a hard cap.
- **Context**, **Search sources**, **Fact-check**, **Tool**, **Template**, **Ask me** and **Subflow**.
- **Notes** and **Groups** keep a big canvas readable.

Every answer records which flow and path made it. Open **Why** on the answer to see each step.`,
      },
      {
        id: 'flow-and-model',
        title: 'Models and flows together',
        summary: 'What changing the model does while a flow answers, and the other cases where they meet.',
        keywords: 'change model switch flow paused override step regenerate which answers precedence',
        body: `When a flow answers a thread and you pick a model (M, the model chip or the status bar), NVX Ancile asks how the model should take part:
- **Just the next message**: it answers your next message alone, then the flow answers again.
- **This thread instead of the flow**: the flow is paused in this thread only. The flow chip reads **Flow paused**; choose **Turn it back on** there.
- **Inside the flow**: open the flow and choose which step uses the model. For one thread only, the flow chip's **Change one step here only** leaves the notebook's flow untouched.

While a flow answers, the model chip is dimmed: it is the model for plain chat.

**Other cases**
- **Regenerate** goes through the flow that made the answer. **Regenerate with another model** answers alone, without the flow.
- **Moving a thread** to another notebook switches it to that notebook's flow; steps you changed for the thread stay with the old flow.
- **Deleting a notebook or thread** keeps its flows as switched-off drafts.
- If a thread's model loses its key, your default answers instead, and **Why** says so.

**Why** on any answer says what answered, who chose it, and any flow that was set aside.`,
      },
      {
        id: 'flow-editor',
        title: 'Drawing on the canvas',
        summary: 'Adding nodes, connecting them, and the keys that make it fast.',
        keywords: 'canvas shortcuts tab add node copy paste group subflow layout align',
        body: `- **Add a node**: press **Tab**, or double-click the canvas. Type what you want; typing a model's name drops a Model node already set to it.
- **Connect**: drag from a port on the right of a node to the left of another. Drop on empty canvas to add what comes next, already connected.
- **Select several**: drag across the canvas, or Shift-click. Align, space out, group, duplicate or bypass them from the bar that appears.
- **Collapse into a subflow** (Ctrl Alt G): a team of nodes becomes one node you can reuse. **Save as a team block** keeps it for any flow.
- **Tidy** (L) lays the flow out left to right. **Zoom to fit** is F.
- **Undo** and **Redo** step back through every edit. Copy and paste work between flows.
- **Bypass** (B) skips a node without deleting it. **Pin** (P) fixes a model's output so you can work on the rest without paying for it.

Your changes autosave in this browser until you press **Save**, so closing the tab loses nothing.`,
      },
      {
        id: 'flow-context',
        title: 'What each model sees',
        summary:
          'Context on every connection: conversation, sources, memory and earlier work, with a token budget.',
        keywords: 'context window tokens budget payload lens edge memory sources plan',
        body: `Every connection decides what crosses it. Hover the dot on a connection to see it in words, with the tokens and cost; click it to set exactly what passes, or to read the literal payload.

- **Conversation**: none, the last few turns, this branch (compacted), this branch and what its siblings tried, or a summary of the whole tree.
- **Sources**: none, the passages found for this message, or named sources.
- **Memory**: none, this project's memory, or all of it.
- **Earlier work**: none, just the plan, the previous step, or everything so far.
- **Token budget**: a cap for the whole payload, trimmed in that order.

Giving a specialist only the plan keeps it fast, cheap, and focused. The checker warns when a payload will not fit the model's window.`,
      },
      {
        id: 'flow-debug',
        title: 'Trying, debugging and publishing',
        summary: 'Try a message, watch each step, run one node, compare versions, publish.',
        keywords: 'try run debug last run pin publish version diff restore yaml close calls lint',
        body: `- **Try** (Ctrl Enter) runs a message through the flow without writing to a thread. Each step lights up with its time and cost, and routers show what they chose and why. Turn on **Mock models** to check the wiring for free.
- Select a node to see its **last run**: exactly what it was given and what it said. **Run only this** or **Run to here** reuse the earlier steps' outputs.
- **What to fix** (I) lists problems as you draw: nodes nothing reaches, routes that go nowhere, models without a key, payloads too big for a window.
- **Versions** (V): every save is a version. **Publish** decides which one answers; later saves stay drafts. **Compare** shows what changed, on the canvas. **Restore** brings an old one back as a new version. Export and import flows as YAML.
- **Close calls**: messages where a router nearly chose differently. Say which route was right with one click.`,
      },
    ],
  },
];

export const ARTICLES: Article[] = CHAPTERS.flatMap((c) => c.articles);

export function articleById(id: string): { chapter: Chapter; article: Article } | null {
  for (const chapter of CHAPTERS) {
    const article = chapter.articles.find((a) => a.id === id);
    if (article) return { chapter, article };
  }
  return null;
}

/** Error codes (docs/errors.md) → the article that explains them. */
export const ERROR_ARTICLES: Record<string, string> = {
  'factcheck.no_model': 'fact-checking',
  'factcheck.bad_output': 'fact-checking',
  'factcheck.evidence_unavailable': 'fact-checking',
  'model.needs_key': 'models',
  'model.not_chat': 'models',
  'run.already_running': 'first-thread',
  'permission.denied': 'approvals',
  'permission.pattern_too_broad': 'approvals',
  'lab.unavailable': 'lab',
  'lab.failed': 'lab',
  'lab.undo_unavailable': 'lab',
  'extract.scanned_pdf': 'source-failed',
  'extract.fetch_failed': 'source-failed',
  'embed.unavailable': 'source-failed',
};

/** Plain-text search over titles, summaries, keywords and bodies, best first. */
export function searchHelp(q: string): Article[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return ARTICLES.map((a) => {
    const title = a.title.toLowerCase();
    const meta = `${a.summary} ${a.keywords ?? ''}`.toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 6;
      else if (meta.includes(t)) score += 3;
      else if (body.includes(t)) score += 1;
      else return { a, score: -1 };
    }
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}
