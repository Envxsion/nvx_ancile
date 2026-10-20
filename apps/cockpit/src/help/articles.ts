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

export interface ArticleSource {
  title: string;
  url: string;
}

export interface Article {
  id: string;
  title: string;
  summary: string;
  body: string;
  keywords?: string;
  tour?: string;
  /** Where the facts in this article were read. Listed at its foot. */
  sources?: ArticleSource[];
  /** An ISO date: when those sources were last read. */
  checked?: string;
  /**
   * Sentences of the body (exactly as written) or section ids that are not yet
   * confirmed at the vendor's own page. Each is shown with a "Not yet confirmed" mark.
   */
  unconfirmed?: string[];
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
        id: 'composer',
        title: 'Commands, files and the queue',
        summary: 'What / does, how to attach a file to one message, and writing ahead.',
        keywords:
          'composer slash command compact branch factcheck memory export instructions find init effort attach file pdf csv queue steer',
        body: `Type **/** at the start of the composer to see the commands, each with what it does. Type a command in full and its argument shows in grey after it. A command that doesn't exist is explained and not sent; start a message with **//** to send a slash.

- **/memory** opens the memory inbox. **/memory** *something* sends it as a request to remember, which is saved with an Undo
- **/compact** summarises the older messages. The next answer starts a fresh prompt cache, so it reads the thread once at full price
- **/branch** *name* branches from the last message
- **/factcheck** checks the last answer; add **web** to search the web if your notebook allows it
- **/export** saves the thread as markdown. **/instructions** edits its instructions. **/find** searches every thread
- **/init** drafts an AGENTS.md for the repository linked to this thread. Nothing is written until you choose **Write AGENTS.md**
- **/effort** *low*, *medium*, *high* or *auto* sets how hard a reasoning model thinks, the same as the **Effort** chip beside the model chip. Changing it keeps the cache

**Files.** Attach a PDF, text, code or CSV file with the paperclip or by dropping it. It goes with that one message only and shows as a chip with its page count. In a notebook you are asked whether it is for this message or a source; turn on **Keep in notebook** on its chip to add it as a source as well. Claude Code reads files from its folder, so name the path in your message.

**Writing ahead.** Press **Enter** while an answer is written and your message waits above the composer ("Sends when this turn ends"). **Esc** takes it back, **Ctrl Enter** stops the answer and sends it now. One message can wait. If the answer fails, or you move to another branch, it stays and says why.`,
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

**Context.** The meter in the status bar shows how much of the model's context this path uses. Past 80% a slim line on top of the composer offers **Compact now**: older messages become a summary and the latest turns stay word for word. Every branch through that point reuses the same summary. At 95% it happens before the next answer by itself, and the answer says so.

**Deleting.** **Delete from here** removes a message and everything that grew from it. It tells you how many messages go first, and **Undo** brings them back for 30 seconds.

When a message starts a clearly different topic, a quiet chip offers to name the branch. It never branches on its own.`,
      },
      {
        id: 'models',
        title: 'Adding models',
        summary: 'Paste a key, test it, and choose which model answers.',
        keywords:
          'api key provider anthropic openai google ollama openrouter model setup routing chain fallback order',
        body: `Open **Settings → API keys** and press **Add API key** beside a provider. The key is checked with one tiny call before it is saved, so you know it works before you rely on it. Keys are encrypted on this computer and never shown again. Admin → Models lists every model and switches each one on or off.

Ollama on this computer is found from the setup screen: press **Find it**. If it isn't installed, **Get Ollama** opens the download page, and NVX Ancile notices it by itself once it is running.

Press **M** anywhere to change the model for the thread you are in. The next message uses it, and the conversation so far carries over.

If a model fails or declines, NVX Ancile asks the next one in its chain without interrupting you. The answer says which model wrote it, and its **receipt** says which models were tried first.

To change who answers first, open **Admin → Routing**. Drag a model by its grip, or use its **⋯** menu to move it up, move it down or remove it, and **Add model** to put another in the chain. Changes save at once. **Reset to default** brings back the original order, and you can undo it.

In **Admin → Models**, each model's **⋯** menu can **Edit** it (its name, context window, chip colour, and for your own server its address and key), turn it on or off, or **Remove** a model you added. Removing asks first, and **Undo** on the notice brings it back, key and all, for ten minutes. Models from config/models.yaml take only their colour and on/off there.`,
      },
      {
        id: 'openrouter-quality',
        title: 'Why the same model can feel worse on OpenRouter',
        summary: 'Providers differ in how much they read and write, and in tools. How NVX Ancile handles it.',
        keywords:
          'openrouter provider endpoint routing quantization precision fp8 fp4 context max output tools auto exacto nitro floor cache cost cut off',
        body: `OpenRouter sends each request to one of several providers that serve the same model. By default it spreads requests by price: cheaper providers get more of them. So two answers from "the same model" may come from two different computers run by two different companies.

Precision matters less than people think. Many labs release their models at FP8 or even FP4, so a provider running FP8 is often running the original. The explorer says when a precision is the lab's own, and says "Unknown" when nobody has told us.

What matters more is what each provider allows. Some read only part of the model's window: "This endpoint can only read 9% of what the model can" means long threads and documents are cut before the model sees them. Some cap the answer: a reasoning model that runs out of room mid-thought looks careless when it was simply stopped. Some cannot use tools at all.

Price sorting also ignores caching. A provider with a lower list price but no cache discount can cost more than one that reads your repeated context at a tenth of the price. **Lowest real cost** ranks by what your own turns would cost, using your cache hit rate and your mix of input and output.

For tool calls OpenRouter runs Auto Exacto, which prefers providers that handle tools well. Sorting by price, or the :floor suffix, turns it off. Setting your own order replaces it too. **Recommended** keeps it.

**Recommended** is the safe default: it leaves out providers too small for the job, asks only providers that support every setting in the request, and sets a sensible answer length. **Best quality** sticks to trusted providers at the lab's own precision. **Pinned** uses only the providers you choose. **Advanced** shows every OpenRouter field.

Every OpenRouter answer records which provider served it, and its receipt shows it. If an answer stopped at the provider's output limit, the receipt says "Cut off by this endpoint's output limit" and offers **Retry on an endpoint with more room**. Usage can show your spending by provider.

Open a model's **⋯** menu in Admin → Models and choose **Providers, routing and cost** to see all of this for that model.`,
      },
      {
        id: 'offline-model',
        title: 'The test models',
        summary: 'Try everything before you add a key. They do not use AI.',
        keywords: 'test offline fake say fail tool slow directive echo try-out tryout',
        body: `Until you add a model, threads are answered by the built-in **Offline test model**, marked **Test model** in the model switcher. It doesn't use AI and needs nothing installed, but it can stream, call tools and fail on request, so you can see how NVX Ancile behaves. Type **/** in the composer to see its commands (**/say** *text* answers with exactly that text and **/slow** *text* writes one word every 150 ms, but they are listed in the developer build only):

- **/fail 500**, **/fail refusal**, **/fail auth**: fail on purpose, and watch NVX Ancile switch to the backup model (Offline echo) and say so
- **/tool fs_write** *{"path":"note.md","content":"hi"}*: call a tool, which asks for your approval first

Offline echo, the backup, only repeats what you wrote.

Once a real model is ready, the test models leave the model switcher and the flow pickers, and they come back only if no real model can answer. There is no setting for this. A flow that was saved with a test model keeps working and is marked in the flow editor, with a **Choose a model** fix.`,
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

If you add something that is already there, NVX Ancile offers to **merge** the two.

A source's menu (**⋯**, or right-click) can **Rename** it, which changes its title in every notebook; **Remove from notebook**, which you can undo and which leaves it in your other notebooks; or **Delete source**, which takes it out of every notebook, search and answers after you confirm. A deleted source cannot be brought back from here, so add it again if you need it.`,
      },
      {
        id: 'context-levels',
        title: 'What a question can use',
        summary: 'Passages, summary only, or off, per source.',
        keywords: 'context level off insights summary full passages exclude include',
        body: `Every source in a notebook has a setting for how much a question may draw from it:

- **Passages**: each question finds the passages that match it best, and can cite them. The whole source is never sent at once, so a question about all of it ("summarise every chapter") reads only what matched; ask about one part at a time, or use Summary.
- **Summary**: only the source's summary is used. Good for background reading.
- **Off**: ignored, but kept in the notebook.

Change it from the source's row in the Sources panel. The **receipt** on an answer shows which passages were found, which were cited, and how each scored.`,
      },
      {
        id: 'citations',
        title: 'Citations',
        summary: 'Numbers in an answer that open the exact passage.',
        keywords: 'citation cite reference footnote source passage quote verify',
        tour: 'cite',
        body: `In a grounded answer, numbers like **[1]** mark where a statement came from. Hover one to see the passage. Click it to open the source with the passage highlighted, scrolled into view, with its page for PDFs.

A citation the model made up (a number that matches no passage it was given) is removed before you see the answer, and the receipt counts how many were removed.

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

**Grounded mode** fact-checks every answer in a notebook as soon as it finishes. Turn it on from the Sources panel.

**Which model checks.** You never list models for this. Obvious claims ("the sky is blue") go to a tiny model, claims with numbers, dates, citations or legal, medical or financial wording to a standard one or better, and the rest to a small one, from any company whose key you have. A claim is sent up a tier when the model is unsure or disagrees, twice at most. Hover a claim's score to see which model checked it. A claim checked before, against the same sources, is answered from memory: the card says "Checked earlier" and offers **Re-check**. **Share checks with other notebooks** (Sources panel) lets other notebooks reuse claims checked without your own sources, and switching it off takes them back.

**Mission-critical.** Turn on **Mission-critical checks** in the Sources panel and every claim is checked by two standard or frontier models. If two are not both ready, nothing runs: you see every ready model, the writer's company included, and choose. Sonnet writing and Opus checking is fine.

**Just one claim.** Highlight any words in any message, an answer or your own, and choose **Fact-check** on the bar beside them (or press **F**). A card gives a one-line verdict, the corrected claim when it does not hold, three to five evidence lines each with its source, and one line on what would change. **Use the corrected claim** writes a follow-up in your message box and never sends it. A check uses a model from a different company than the one that wrote the words when one is ready, and checks anyway when only the writer's is. A check costs money only when you ask for it, and the card shows the cost.

**On the web.** Turn on **Check on the web** in the Sources panel, or choose **Check again with the web** for one check, and claims your sources do not cover are looked up on the web and marked **Web**. A private notebook never uses the web.

**Setting up web search.** Nothing to install if you already have a Google (Gemini), OpenRouter or Anthropic key: NVX Ancile uses the cheapest of them for one small lookup per claim, up to 25 cents a day by default, and the card shows what it cost. If you run SearXNG, set \`SEARXNG_URL\` and it is used instead, free. When the web could not be checked, the panel says why in one line: no search set up, a private notebook, or the daily budget reached. It never says "no evidence" for a claim it did not look up.`,
      },
      {
        id: 'why',
        title: 'The receipt under an answer',
        summary: 'The model, who paid, the cost, what went in and what went wrong, for one answer.',
        keywords:
          'receipt why explain provenance trace attempts fallback memory retrieval tools decisions cost cache',
        body: `Under every finished answer is one quiet line: the model, who paid (**Plan**, **Key** or **Local**), how long it took and what it cost. Click it, or press **W** on the answer, to open its receipt:

- **Answered by**: the model, who pays for it, and why this model was used
- **What it cost**: fresh input, cache reads and writes, and output, with the rate per million tokens at the time. A plan answer shows tokens only; a local one costs nothing. **Step by step** lists each model call and tool in order
- **What went in**: the memory it was given, the passages it read (**Show scores** lists how each ranked) and how many earlier turns were sent
- **Worth knowing**: problems that fixed themselves, tool requests that asked you first, and the fact-check
- **Open the trace** for the full record

Press **Escape** to close the receipt and return to the line.

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
        id: 'claude-code',
        title: 'Using Claude Code in NVX Ancile',
        summary:
          'Your own Claude Code, its sessions kept here as threads, and its sign-in kept by Claude Code.',
        keywords:
          'claude code anthropic cli terminal sessions import sync sign in install update agent live send stop slash commands model effort context usage queue approval edit branch fork citations',
        body: `NVX Ancile works with the Claude Code installed on this computer. Every Claude Code session comes in as a thread, in a notebook named after the folder it ran in, and keeps in step as Claude Code adds to it.

**Install**
Open **Settings → Claude Code**. If Claude Code is missing, **Install Claude Code** runs Anthropic's official installer and shows its progress. NVX Ancile can do this by itself when Claude Code is missing; turn that off in the same place.

If Claude Code is too old, run \`claude update\` in a terminal, then press **Check again**.

**Sign in**
**Sign in to Claude Code** asks Claude Code to sign in. A browser window opens from Claude Code itself, and you sign in there. NVX Ancile never sees your Claude sign-in: Claude Code keeps it, and NVX Ancile only asks whether it is signed in.

**Sessions**
With **Bring Claude Code sessions in by themselves** on (the default), there is nothing to do: sessions arrive as threads and stay up to date. A small line in Settings shows progress while they come in, and one notice says how many arrived.

**Open Claude Code sessions** (in the palette, or **See sessions** in Settings) lists every session by folder: which are in NVX Ancile, which have new messages, and which are open in a terminal right now. Turn the switch off to choose sessions yourself and import them.

A thread from Claude Code says so under its title. **Sync from Claude Code** (in that marker's menu, the thread's menu in the sidebar, or the palette) adds anything new at once.

**Carry a session on here**
Type in a Claude Code thread and send: the session carries on in your own Claude Code, in its own folder, with your CLAUDE.md files, skills, plugins and MCP servers. The answer streams in like any other, with each tool step as it happens. **Stop** (in place of Send while it works) is Claude Code's own interrupt; what it wrote so far is kept.

A line above the composer says what the session is doing: **Claude Code ready in cyberfolio**, **Starting Claude Code…** or **Working…**, with the model and effort. The small meter is Claude Code's own count of its context; press it for the last turn's tokens and its cost: included in your Claude plan (or, signed in with an API key, billed there), with Claude Code's estimate at API list prices beside it.

Choose the **model** and **effort** for the next message with the two buttons in the composer's bar. A message you send while Claude Code works waits as **Queued** and goes when the turn ends.

**Commands**
Type **/** for Claude Code's own commands for this folder: built-ins, your skills, plugins, MCP prompts and custom commands, each with what it does. Keep typing to narrow the list, use the arrow keys, and press Tab or Enter. A command with set values (such as **/effort** or **/model**) offers them next. A few commands open the matching part of NVX Ancile instead of being sent: **/mcp** opens Plugins, **/permissions** opens Permissions, **/context** and **/cost** open usage, **/branch** branches here, **/rewind** opens the branch tree, **/login** opens Claude Code sign-in. Commands that only work in a terminal say so and are not sent.

**Approvals, with your changes**
Every tool call Claude Code makes is checked by NVX Ancile first. When one asks, the approval can be changed before it runs: press **Edit before allowing**, change the command, the edit or the file, then **Allow once with changes**. NVX Ancile checks the changed call again; if it is refused, the dialog says why and stays open. Changes apply to that one call, so nothing is remembered while you edit.

**Sources and citations**
The notebook's sources are there for Claude Code to search. Narrow a message to one source with **@**. Where the answer uses a passage, it cites it, and the citation opens the exact passage, as in any other answer.

**Branches**
Rewinds you made in Claude Code come in as branches. Edit an earlier message, try an answer again, or branch from any message, and Claude Code forks the session there; switch between versions with the arrows under a message or the branch tree.

**Good to know**
- If the session is open in Claude Code somewhere else, NVX Ancile will not write to it. Close it there, or press **Continue as a branch** to fork it and carry on here.
- If NVX Ancile restarts during a turn, what Claude Code wrote is brought in from the session when it starts again.
- Where Claude Code compacted a conversation, the thread shows **Conversation compacted here**.
- Usage counts against the account Claude Code is signed in to, as it would in a terminal.`,
      },
      {
        id: 'approvals',
        title: 'Approvals',
        summary: 'Once, always, or every time: you decide what the AI may do.',
        keywords:
          'approval permission permissions allow deny grant grants always once tier critical gated expired',
        tour: 'approve',
        body: `Every tool call is checked at the moment it runs, on its real arguments. There are three tiers:

- **Auto**: reading inside the workspace. It just happens.
- **Asks once**: writing, fetching, running something reversible. Approve it **once**, or **always** for a pattern you choose (for example, every file under one folder).
- **Asks every time**: deleting, writing outside the workspace, running shell commands. There is no "always" for these.

While the AI waits, the mark in the top-left closes like a shield and the status bar counts the decisions waiting. You can leave and come back: the run waits for you, even across a restart.

Admin → Permissions lists everything you have allowed. A saved permission's **⋯** menu can **Edit** it, to narrow its pattern, change where it applies or set when it expires, or **Revoke** it. One past its expiry no longer counts: it is marked **Expired**, and **Show: Expired** lists only those, so you can renew or revoke them. A pattern can only be narrowed there; to allow more, revoke it and answer the next request. Revoking asks first, and **Undo** on the notice puts it back for ten minutes.`,
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

**Connect RunPod** opens **Settings → API keys** at the RunPod row: the one place keys are entered. Paste an API key from RunPod (Settings → API Keys, with read and write access to pods); it is checked with RunPod before anything changes and kept encrypted on this computer. NVX Ancile gives it to the Controller again every time the Controller starts, so you enter it once. With a key saved, Compute never asks for it again: if RunPod has not answered yet it says so and tries again each minute (or now, with **Try again**), and if RunPod refused the key it says why and leads to changing it. To set a pod up yourself, **Add a node** → *Setting the pod up yourself?* has the exact start command and settings to copy.`,
      },
      {
        id: 'compute-rules',
        title: 'Rules: idle stop, cap, schedule',
        summary: 'Keep GPU bills where you want them, automatically.',
        keywords:
          'rules idle timeout cost cap budget schedule nightly weekdays days nodes stop start automatic edit remove',
        body: `Three kinds of rule keep nodes in check. Each acts through the same confirmation chain as your own clicks, and is listed on the node it acted on.

- **Stop idle nodes**: a running node that has answered nothing for the minutes you type is stopped. Its disk is kept.
- **Monthly cap**: when this month's spend reaches the amount you type, NVX Ancile either answers with your cloud models instead, stops nodes, or just tells you. You are warned at 80%. Spend always counts every node.
- **Schedule**: start or stop nodes at a time you type, on the days you pick (Mon to Sun), in your time zone. Leave every day on for a daily rule; pick Mon to Fri for "never leave it running overnight on a workday".

Each rule acts on **All nodes** or on **Chosen nodes** you tick. For a monthly cap, the choice says which nodes "Stop nodes" stops.

New rules start empty: type the number or time, and **Add rule** turns on once it reads. Turn a rule off with its switch. Use the ⋯ menu on a rule to edit or remove it; removing asks first, and the notice that follows has **Undo**.`,
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

To see exactly what a thread's next answer will be given, open the **receipt** on any answer: the memory it used is listed with the version of each file, starting with a **Used:** line in words.`,
      },
      {
        id: 'memory-learning',
        title: 'How it learns',
        summary: 'Corrections become preferences; a failure then a fix becomes a lesson.',
        keywords: 'memory learn correction capture inbox propose auto undo',
        body: `After each answer, NVX Ancile looks for a few things, without slowing the answer down:

- **A correction in your own words.** "No, use British spelling" or "always give metric units" becomes a preference. A one-off fix ("the second number is wrong") does not.
- **A tool that failed and then worked.** The lesson goes in Lessons so the same mistake is spotted sooner next time.

- **Things you say in passing.** "I prefer tabs" or "my manager is Dana", said once, waits in the inbox. Said again, it is kept, with **Undo**. Switch this off at the top of **Admin → Memory**. Private notebooks stay off unless you allow it.
- **Someone else's work as the bar.** Paste or attach "how my manager writes updates", ideally with yours. You get a short standard to approve, and **Compare with a standard** (the menu beside Copy) shows how your work differs. It is always your yes: a rule written from pasted text is never kept on its own.
- **A mistake you correct**, and **a change of mind** ("scrap that, I now use US dates"), which replaces the old entry. If nothing clear was learned from a change of mind, a quiet note says so and **Update memory** saves it.

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

**Review changes** (or **Ctrl S**) shows exactly what will change before it is committed. If NVX Ancile learned something in the same file while you were typing, the two are merged for you. If they touched the same lines, both versions are shown side by side so you can keep what you want.

To delete a whole file, choose **⋯** beside the file's views, then **Delete file**. The deletion is its own commit, so **Undo** on the notice (or **Revert** in History) brings it back. AGENTS.md, USER.md and the folder's guides cannot be deleted: every answer is built around them, so edit them instead.`,
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
        keywords:
          'automations schedule cron cleanup backup stale links run now new edit reset reminder flow events switch tags duplicates drafts context test push remote',
        body: `**Admin → Automations** lists the work NVX Ancile does by itself. Scheduled jobs (clean-up, memory backup, checking links for changes) show when they last ran, how it went, and when they run next. The switch stops a schedule; the **⋯** menu has **Edit**, **Run now** and **Reset to default**.

**On events** lists the jobs that run as you work: naming new threads, tagging sources, spotting duplicates, suggesting a branch, watching the context window, saving drafts and learning from corrections. Each has a switch, and **Edit** for its settings, such as how many tags a source gets or how full the context gets before it is compacted.

**Edit** changes when a job runs (every few minutes or hours, daily, weekly on the days you pick, or a custom cron schedule) and its settings, such as how long logs are kept. A changed job is marked **Changed** until you reset it.

**New automation** makes your own: ask a model a question on a schedule (in a notebook if you like), run a flow, re-check a notebook's links, or send yourself a reminder. Answers land in a new thread each time; **Open** on the card takes you there. Nobody is watching when it runs, so anything it wants to change waits for your yes.

A job that needs something first, like a git remote for memory backups, shows **Set up** instead of its switch, and stays off until it is. For memory backup, **Set up** asks for the remote, **Test push** checks it can push (nothing changes there), and **Save and turn on** starts the hourly backup.

The jobs that run on events, like naming a new thread or learning from a correction, are listed too, so nothing happens out of sight.`,
      },
      {
        id: 'connect-apps',
        title: 'Using NVX Ancile from other apps',
        summary: 'Connect an editor or assistant over MCP, with only the access you choose.',
        keywords: 'mcp connect app editor token plugin search server grant',
        body: `Apps that speak MCP (editors, desktop assistants) can search your sources and memory. In **Admin → Plugins → Connect an app**, name the app and tick what it may do. You get a token and a ready-made config to paste into the app, shown once.

Every call the app makes is checked like the assistant's own and recorded in **Decisions**. **Disconnect** stops its token at once; you can also take back one kind of access in **Admin → Permissions**.

For apps that only start commands, run the stdio bridge with your token in \`ANCILE_MCP_TOKEN\`.`,
      },
      {
        id: 'mcp-servers',
        title: 'Giving the assistant more tools',
        summary: 'Add MCP servers, keep their keys secret, and choose how each tool asks.',
        keywords:
          'mcp server add tool plugin github stdio http remote command secret header environment tier test connection remove',
        body: `An MCP server gives the assistant more tools: a search engine, a database, your issue tracker. In **Admin → Plugins → Add server**, give it a short name and choose how it connects:

- **Local command**: NVX Ancile starts the server on this computer, for example \`npx\` with one argument per line. Plain settings go in environment variables.
- **Remote**: NVX Ancile connects to the server's address over HTTP. Plain settings go in headers.

Keys and tokens go in **secrets**: environment variables for a local command, request headers such as \`Authorization\` for a remote one. They are stored encrypted and afterwards show only as **Saved**. **Replace** sets a new value; removing the row deletes it. **Quick start: GitHub** adds the official GitHub server in one step.

Each server shows whether it is connected, and what went wrong in words when it is not. **Test connection** tries again now. Open its tools to see how each one asks (**Auto**, **Asks once**, **Asks every time**), change it, or switch a tool off. A changed tool is marked **Changed**; **Server's default** puts it back. A tool that changes things cannot be set to Auto.

Servers set in \`config/mcp.yaml\` are marked **From config file**: change those in the file. Their tool settings can still be changed here. **Remove server** stops its tools at once and deletes its secrets.`,
      },
      {
        id: 'licence',
        title: 'Free and Pro',
        summary: 'Everything you need is free; Pro adds scale.',
        keywords: 'licence license pro key activate free edition features',
        body: `Everything for working with your own models, sources and memory is in the free edition and stays there. Pro adds GPU pools, asking several models at once, teams, encrypted sync, long research and smart routing.

To turn Pro on, paste the key from your NVX purchase email (NVX-XXXX-XXXX-XXXX) in **Admin → Licence**. The licence is checked on this computer, so Pro keeps working offline. **Move to another computer** frees the key for use elsewhere.`,
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
    id: 'extras',
    title: 'More features',
    articles: [
      {
        id: 'private-notebooks',
        title: 'Private notebooks',
        summary: 'What stays on this computer, and the few things you can allow.',
        keywords:
          'private notebook local privacy off machine cloud decisions jev clef passive memory verdicts',
        body: `A notebook marked **Private** keeps its work on this computer. It uses only models on this machine (or on your own GPU node), never Claude Code, never the web, and Auto mode asks only local reviewers.

**Settings → Private notebooks** lists the few extras you can allow for every private notebook at once. All are off to begin with:

- **Hosted decision models.** Jev and hosted Clef choose routes and checks. Off, a decision model on this computer is used if you have one, and the rules otherwise.
- **Learn from things said in passing.** Off, nothing is remembered unless you say so, unless a model on this computer can do the learning.
- **Share fact-check verdicts.** Off, a private notebook's verdicts are never reused in other notebooks.

Turning one on affects only private notebooks. Everywhere else these features already work. A model on this computer, or on a GPU node you run yourself, counts as private.`,
      },
      {
        id: 'spend-less-on-decisions',
        title: 'Spend less on decisions',
        summary:
          'What decision models are, how far the free allowance goes, and how to add Cloudflare and Jev.',
        keywords:
          'decision model decisions clef flash jev cloudflare workers ai neurons free allowance perplexity laya julia cost router auto review triage',
        checked: '2026-10-20',
        sources: [
          {
            title: 'Cloudflare: Workers AI pricing',
            url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
          },
          {
            title: 'Cloudflare: Clef-flash',
            url: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
          },
          { title: 'Cloudflare: Clef', url: 'https://developers.cloudflare.com/workers-ai/models/clef/' },
          {
            title: 'Cloudflare: Workers AI REST API token',
            url: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
          },
          { title: 'TypeSafe: System One API (Jev)', url: 'https://docs.typesafe.ai/api' },
          {
            title: 'OpenRouter: Decisions API and Jev',
            url: 'https://openrouter.ai/docs/guides/community/jev',
          },
          { title: 'Perplexity: Decisions API', url: 'https://docs.perplexity.ai/docs/decisions/quickstart' },
          {
            title: 'Hugging Face: Clef-flash (open weights, Apache 2.0)',
            url: 'https://huggingface.co/Cloudflare/clef-flash',
          },
        ],
        unconfirmed: [
          'The OpenAI Decisions API (GPT-6 Luna) is a preview. Its own pages were not readable when this was written, so it is off until you turn it on, and it may refuse your key.',
        ],
        body: `A **decision model** does not write sentences. It reads a short piece of text and answers questions about it with probabilities: "is this a prompt injection? 0.02", "which route? code 0.8". They are small, fast (tens of milliseconds) and cheap, so NVX Ancile uses them for the quick judgements around your chats: Auto mode's reviewer, flow routers, fact-check triage and Keystone's intent.

**They bill input only.** Output is free, and none of them offers prompt caching, so nothing here is ever shown as a cache saving.

### The free allowance, in numbers

Cloudflare Workers AI gives **10,000 neurons a day** free, and the count resets at **00:00 UTC** (11 am in Melbourne during daylight saving). A neuron is Cloudflare's own unit:

- **Clef-flash:** 3,455 neurons per million input tokens. 10,000 neurons is about **2.9 million tokens** a day. A 1,000-token decision costs about 3.5 neurons, so roughly **2,900 decisions** a day.
- **Clef:** 21,818 neurons per million input tokens. About **458,000 tokens** a day, or roughly **450 decisions** of 1,000 tokens.

Past the free line, Workers AI bills $0.011 per 1,000 neurons on the paid plan (Clef-flash $0.038 and Clef $0.24 per million tokens). NVX Ancile **never takes that step for you**: it counts what you use, leaves Cloudflare at 9,950 neurons (you can change this) and moves on.

### What happens on each decision

1. In a private notebook, a decision server on this computer or your own GPU node goes first. Hosted models are used only if you allowed them in **Settings → Private notebooks**.
2. Routes with free allowance left that suit the task come first. Fast sorting prefers Clef-flash; a security review prefers Clef or Jev.
3. Then the cheapest paid route that suits: Perplexity's deciders (from $0.01 per million), Clef-flash through OpenRouter, Jev ($0.042 per million) through OpenRouter or TypeSafe.
4. A route that is out of credit (402), refused or down is skipped, and the next is tried. If none answers, the feature carries on the way it did before. Nothing waits on a decision model.

Each paid provider has a daily spend cap, $1 unless you change it. A decision costs a few millionths of a dollar, so the cap is a safety net, not a budget.

### Add Cloudflare (free)

1. In the Cloudflare dashboard open **Workers AI** and choose **Use REST API**. Copy the **account ID**.
2. Make an API token from the **Workers AI** template. It needs Workers AI Read and Edit.
3. Open **Settings → API keys → Decision models**, paste both, and choose **Check and save**. The check is Cloudflare's token verify call, which uses no neurons.

### Add Jev

Your **OpenRouter** key already works for Jev (and for Perplexity's and Clef's decision models there). A direct **TypeSafe** key works too, and is the next route if OpenRouter runs out of credit.

### On your own hardware

Clef-flash's weights are open (Apache 2.0). Serve them with vLLM or SGLang and they answer the same API at \`/v1/systemone\`. Laya (421 million parameters) runs on a CPU through \`laya-serve\` and answers the same way. Paste the address in **Settings → Decisions → On this computer**. It counts as private and costs nothing. Ollama cannot serve these models, because it returns text rather than probabilities.

### Not supported

There is no hosted "Julia" decision API. Julia-1 is a small open model from Supersonic Labs; if you serve it behind a Jev-compatible server, the same address field takes it. Other decision models on OpenRouter (Microsoft, Inception, Liquid AI, Upstage) are not added yet.

### What NVX Ancile does about it

It counts what you use against each free allowance and leaves before the edge, never after. It never turns a decision into a paid Cloudflare charge, and it never blocks a chat: if no decision model can answer, the feature carries on the way it did before. The OpenAI Decisions API (GPT-6 Luna) is a preview. Its own pages were not readable when this was written, so it is off until you turn it on, and it may refuse your key.`,
      },
      {
        id: 'grants',
        title: 'Grants and permissions',
        summary: 'What the AI may do without asking, and how to take it back.',
        keywords: 'grant grants permission permissions allow always once deny tier preset scope',
        body: `A **grant** is a standing yes: "this tool, on this folder, without asking". You make one when you answer an approval with **Always**. **Once** allows only that call.

Open **Admin → Permissions** to see every grant, change the **preset** (how often NVX Ancile asks) and remove any grant. Removing one takes effect on the next call.

Every tool call is checked at the moment it runs, on its real arguments, so a grant for one folder never covers another. A **scope** (the places a notebook or thread may reach) is checked first and cannot be granted past.

**Admin → Decisions** is the record of what was asked and what you answered.`,
      },
      {
        id: 'decisions',
        title: 'Decisions',
        summary: 'The record of every approval, and who or what answered it.',
        keywords: 'decisions audit log approvals history reviewer',
        body: `**Admin → Decisions** lists each time the AI asked to do something risky: what it wanted, the arguments, the answer (yours, or the reviewer's in Auto mode) and the time.

Use it to check what ran while you were away, or to find a grant you now want to remove. Open a row to see the exact call. Decisions stay on this computer and are never edited.`,
      },
      {
        id: 'auto-mode',
        title: 'Auto mode',
        summary: 'Long sessions where routine steps run and risky ones still stop.',
        keywords: 'auto mode reviewer floors plan cache jev autonomous',
        body: `Auto is a permission preset for long jobs. **Routine steps run without asking; anything risky still stops.**

For each step that would have asked, in order:
- **Floors** refuse or ask for dangerous things (recursive deletes, secrets, shell tricks, text that tries to instruct the reviewer). Nothing overrides them.
- **Your plan**, if you approved one for the thread, lets matching steps run.
- **The cache** lets a step like one already reviewed run.
- **A reviewer** (a small model) says how likely the step fits the task and how likely it is an injection. It can only make things stricter.

With no reviewer reachable, rules alone decide and more steps ask. Calls that ran by themselves carry a small badge.

**Check my reviewers** (Settings → Auto mode) runs the built-in safety cases through your reviewers and shows what each caught or missed. It shows the most it can cost first, and changes no setting.`,
      },
      {
        id: 'flow-lab',
        title: 'Flow lab',
        summary: 'Try a flow on sample messages before it answers for real.',
        keywords: 'flow lab try-out tryout test shadow dry run sample epoch',
        tour: 'flow-lab',
        body: `The **Flow lab** runs a flow on messages you choose and shows the path each took, with cost and time, without replying in a thread. A **try-out** changes nothing you have saved.

**Shadow** runs a second flow beside the live one on real messages and only records what it would have done. Compare the two, then switch when you are happy. A shadow never reaches your answers.`,
      },
      {
        id: 'routing',
        title: 'Routing',
        summary: 'Which model answers when no flow says otherwise.',
        keywords: 'routing router lines latest model default fallback utility',
        body: `**Admin → Routing** sets the defaults: the model for plain chats, the one for small jobs (titles, summaries) and the fallbacks used when a model is down.

A **router** inside a flow is different: it picks a route for each message. Routing here applies when no flow does.

A model can be named by a **line** such as "latest". The line points at whichever model is current, and the receipt shows which one answered.`,
      },
      {
        id: 'usage',
        title: 'Usage and cost',
        summary: 'What you spent, on what, and what is left of a plan.',
        keywords: 'usage cost tokens spend budget plan limits meter',
        body: `**Usage** shows tokens and cost by model, notebook and day, and what a plan (a subscription) still allows. A key bills each use; a plan is a flat fee with limits, so the two are shown apart.

The meter in the status bar shows the context window of the open thread. Tokens and cost under each answer can be switched on in Settings → Reading.`,
      },
      {
        id: 'sync',
        title: 'Sync',
        summary: 'Keep your workspace on more than one computer, encrypted.',
        keywords: 'sync devices encrypted passphrase pro',
        body: `**Sync** (Pro) copies your threads, notebooks and settings between your computers. Everything is encrypted on this computer, with a key made from your passphrase, before it leaves. The relay sees only scrambled records.

A new computer joins by approval from one that already syncs. Anything marked to stay on this machine is not synced, and device-only settings (zoom, widths, custom CSS) stay put.`,
      },
      {
        id: 'beam',
        title: 'Beam',
        summary: 'Ask several models at once and compare.',
        keywords: 'beam compare models pro fan out',
        body: `**Beam** (Pro) sends one question to several models and lays the answers side by side. Open it from **Compare models** in the composer, **/beam**, or **Beam this question** on a message. Keep the answer you want as the thread's reply.

Without Pro the dialog explains Beam and sends nothing.`,
      },
      {
        id: 'context-packs',
        title: 'Context packs',
        summary: 'Bundles of sources and notes you attach in one step.',
        keywords: 'context packs bundle attach pro sources',
        body: `A **context pack** (Pro) is a saved set of sources and notes you add to a thread or notebook together, so you do not rebuild the same background each time. Pick one in the composer's pack picker; its size shows before you attach it.`,
      },
      {
        id: 'receipt',
        title: 'The receipt and model updates',
        summary: 'How an answer was made: model, flow, cost and checks.',
        keywords: 'receipt answer provenance cost cache warm latest model update',
        body: `Open the **receipt** on any answer to see which model answered, the flow and path if there was one, tokens, cost, time, and whether it was fact-checked.

**Model updates:** when a model you use is replaced, a toast says so once, and the receipt names the model that really answered. A **latest** line follows the newest model; pin a specific one when you need repeatable answers.

**Cache warm marks:** a small mark on a model means the provider still holds your recent prompt, so the next message is cheaper and faster. It cools after a few minutes.`,
      },
      {
        id: 'trash',
        title: 'Trash and undo',
        summary: 'Deleted threads wait 30 days and can be restored.',
        keywords: 'trash delete undo restore bulk select',
        body: `Deleting threads moves them to the **Trash**. **Undo** appears at once. Later, open the Trash from the sidebar or Settings and choose **Restore**. After 30 days they are removed for good. Tick the boxes beside threads to act on many together.`,
      },
      {
        id: 'highlight-fact-check',
        title: 'Fact-check a highlight',
        summary: 'Check any passage of an answer against your sources.',
        keywords: 'fact check highlight selection verify',
        body: `Select text in an answer and choose **Fact-check**. A different model checks the passage against your notebook's sources, and each claim is marked supported, unsupported or not found, with the passage it relied on.`,
      },
      {
        id: 'desktop',
        title: 'The desktop app',
        summary: 'Tray, links, updates and the window.',
        keywords: 'desktop tray links updates window close quit',
        body: `Closing the window keeps NVX Ancile running in the **tray**, so runs and reminders carry on. **Quit** in the tray menu stops everything. Web and mail links open in your browser; other kinds of link are refused. Updates download when you say so and install on the next start. The window follows your system theme.`,
      },
      {
        id: 'memory-scopes',
        title: 'Memory scope, hindsight and tidy',
        summary: 'Who sees a memory, what it learns from, and cleaning up.',
        keywords: 'memory scope hindsight tidy storage lessons',
        body: `A memory has a **scope**: this notebook, this project or everywhere. Narrow scopes keep unrelated work out.

**Hindsight pass** (in a thread's menu) reviews a session for root causes and files suggestions in the inbox. Nothing is saved until you accept it.

**Tidy storage** (Settings) removes duplicate chunks of older source versions after taking a backup, and shows the space it gives back.`,
      },
      {
        id: 'lab-safety',
        title: 'Coding lab safety',
        summary: 'What the lab agent can touch and what it asks first.',
        keywords: 'lab coding safety folder worktree sandbox approval',
        body: `The lab agent works in its own folder, on a copy of your repository, and cannot reach outside it. Reading or writing outside, recursive deletes, secrets and risky shell commands ask first or are refused. You review the changes as a diff before anything lands in your repository.`,
      },
      {
        id: 'custom-css',
        title: 'Custom CSS and safe mode',
        summary: 'Restyle the app, and turn it off if it breaks.',
        keywords: 'custom css safe mode notifications accessibility restyle',
        body: `Settings → Advanced takes your own CSS. If it makes the app unusable, open the app with **?safe=1** (or choose **Start in safe mode** on an error screen). Custom CSS and plugins stay off until you reload normally.

**Notifications** and **Accessibility** have their own groups in Settings; **Settings** in this guide says what each holds.`,
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

- **Looks scanned**: the PDF is images of pages with no text. Choose **Read with OCR** on its row, or turn on **Settings → Sources → Read scanned PDFs with OCR** so every scan is read when you add it. OCR runs on this computer, needs RapidOCR or Tesseract installed, reads only the pages that have no text, and keeps citations on the right page. A long scan shows its progress page by page, and carries on from the last page read if NVX Ancile restarts. Handwriting is read poorly.
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

Every answer records which flow and path made it. Open the **receipt** on the answer, then **Show the flow's steps**.`,
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
- If a thread's model loses its key, your default answers instead, and its receipt says so.

The **receipt** on any answer says what answered, who chose it, and any flow that was set aside.`,
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
  'privacy.denied': 'private-notebooks',
  'privacy.locked': 'private-notebooks',
  'decisions.local_url_invalid': 'spend-less-on-decisions',
  'openrouter.endpoints_unavailable': 'openrouter-quality',
  'openrouter.model_invalid': 'openrouter-quality',
  'routing.no_chat_model': 'fact-checking',
  'factcheck.needs_choice': 'fact-checking',
  'factcheck.model_not_ready': 'fact-checking',
  'factcheck.judge_not_allowed': 'fact-checking',
  'factcheck.bad_output': 'fact-checking',
  'factcheck.evidence_unavailable': 'fact-checking',
  'model.needs_key': 'models',
  'model.not_chat': 'models',
  'run.already_running': 'first-thread',
  'thread.busy': 'first-thread',
  'permission.denied': 'approvals',
  'permission.pattern_too_broad': 'approvals',
  'lab.unavailable': 'lab',
  'lab.failed': 'lab',
  'lab.undo_unavailable': 'lab',
  'extract.scanned_pdf': 'source-failed',
  'extract.fetch_failed': 'source-failed',
  'embed.unavailable': 'source-failed',
  'mcp.name_taken': 'mcp-servers',
  'mcp.read_only': 'mcp-servers',
  'mcp.secret_missing': 'mcp-servers',
  'mcp.tier_not_allowed': 'mcp-servers',
  'claude_code.not_installed': 'claude-code',
  'claude_code.signed_out': 'claude-code',
  'claude_code.session_busy': 'claude-code',
  'claude_code.plan_limit': 'claude-code',
  'claude_code.unverified': 'claude-code',
  'claude_code.branch_unmapped': 'claude-code',
  'claude_code.version_old': 'claude-code',
  'claude_code.sdk_unavailable': 'claude-code',
  'claude_code.install_failed': 'claude-code',
  'claude_code.folder_excluded': 'claude-code',
};

/**
 * Add a chapter that was loaded on demand (help/lazyGuide.ts). The chapter and
 * article lists are the same arrays as before, so search, the contents and
 * `articleById` see it at once. Registering a chapter again replaces it.
 */
export function registerChapter(chapter: Chapter): void {
  const at = CHAPTERS.findIndex((c) => c.id === chapter.id);
  if (at >= 0) {
    const old = CHAPTERS[at];
    if (old)
      for (const a of old.articles) {
        const i = ARTICLES.indexOf(a);
        if (i >= 0) ARTICLES.splice(i, 1);
      }
    CHAPTERS.splice(at, 1, chapter);
  } else CHAPTERS.push(chapter);
  ARTICLES.push(...chapter.articles);
}

/** Words that carry no meaning in a question such as "does Mistral train on my data". */
const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
]);

/** Plain-text search over titles, summaries, keywords and bodies, best first. */
export function searchHelp(q: string): Article[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w));
  const terms = meaningful.length ? meaningful : words;
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

/* ---- Sections and citations -------------------------------------------- */

/** A stable anchor for a heading: lower case, letters and digits, one hyphen between words. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface Section {
  id: string;
  title: string;
}

/**
 * The `###` headings of a body, each with its anchor. Two headings that make the
 * same slug get -2, -3 and so on, in order, so an anchor never moves unless a
 * heading above it with the same name is added or removed.
 */
export function sectionsOf(body: string): Section[] {
  const seen = new Map<string, number>();
  const out: Section[] = [];
  for (const line of body.split('\n')) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const title = m[1];
    const base = slugOf(title) || 'section';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}-${n}`, title });
  }
  return out;
}

/** What the "Not yet confirmed" mark is in the markdown; the guide draws it as a quiet label. */
export const NOT_CONFIRMED_HREF = '#not-confirmed';
const MARK = ` [Not yet confirmed](${NOT_CONFIRMED_HREF})`;

/**
 * The body with a "Not yet confirmed" mark after each unconfirmed sentence. An entry
 * that is a section id (not a sentence of the body) marks the whole section, under its heading.
 */
export function markUnconfirmed(body: string, unconfirmed: readonly string[] | undefined): string {
  if (!unconfirmed?.length) return body;
  const inserts: { at: number; text: string }[] = [];
  const sections = sectionsOf(body);
  for (const u of unconfirmed) {
    const at = body.indexOf(u);
    if (at >= 0) {
      inserts.push({ at: at + u.length, text: MARK });
      continue;
    }
    const sec = sections.find((s) => s.id === u);
    if (!sec) continue;
    const heading = body.indexOf(`### ${sec.title}`);
    if (heading < 0) continue;
    const eol = body.indexOf('\n', heading);
    inserts.push({
      at: eol < 0 ? body.length : eol,
      text: `\n\n[Not yet confirmed](${NOT_CONFIRMED_HREF}) Facts in this section are not yet confirmed.`,
    });
  }
  let out = body;
  for (const { at, text } of inserts.sort((x, y) => y.at - x.at))
    out = out.slice(0, at) + text + out.slice(at);
  return out;
}

export interface GuideCitation {
  /** The article's title. */
  title: string;
  /** The section's heading, or null for the article as a whole. */
  section: string | null;
  /** The in-app route that opens the guide there, with the section as the hash. */
  url: string;
  /** An ISO date the article's sources were last read, or null when it has none. */
  checked: string | null;
}

/**
 * Point at a place in the guide, for an answer that quotes it (Ctrl K questions, K2).
 * `null` when the article or the section does not exist, so a citation never points nowhere.
 * Articles in a chapter that loads on demand are only found once help/lazyGuide.ts has loaded it.
 */
export function citeGuide(articleId: string, sectionId?: string): GuideCitation | null {
  const found = articleById(articleId);
  if (!found) return null;
  const { article } = found;
  const section = sectionId ? sectionsOf(article.body).find((s) => s.id === sectionId) : undefined;
  if (sectionId && !section) return null;
  return {
    title: article.title,
    section: section?.title ?? null,
    url: `/open/help?topic=${encodeURIComponent(article.id)}${section ? `#${section.id}` : ''}`,
    checked: article.checked ?? null,
  };
}
