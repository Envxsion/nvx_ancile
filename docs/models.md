# Models

NVX Ancile talks to models through APIs. There are four ways to connect one, and you can mix them freely: a flow can send writing to Claude, code to a model on your own GPU, and everything else to something cheap on OpenRouter.

| Way in | What you need | Good for |
|---|---|---|
| A provider key | An API key from Anthropic, OpenAI or Google | The big models, billed by the provider |
| OpenRouter | One OpenRouter key | Hundreds of models from one bill; trying models quickly |
| Your own server | The address of any OpenAI-compatible server (`/v1/chat/completions`) | Ollama, LM Studio, vLLM on a machine on your network |
| A GPU node | A RunPod pod or a LAN machine, added under Admin → Compute | Large or specialised open models on hardware you rent or own |

## Adding a model

**Admin → Models → Add a model** (also at the foot of every model picker in the flow editor) has three tabs:

- **OpenRouter.** Search the catalogue (browsing needs no key) and add a model. The first time you add one without an OpenRouter key, the dialog asks for it and tests it.
- **Your server.** Give the base URL (for example `http://192.168.1.20:11434/v1` for Ollama, or `https://<pod-id>-8000.proxy.runpod.net/v1` for vLLM on RunPod) and a key if the server wants one. Press **List its models**, then add the ones you want, or type a model id yourself.
- **A provider.** Pick Anthropic, OpenAI or Google and type a model id the provider publishes (for example `claude-opus-5-5`) when it is newer than the built-in list.

Keys are encrypted at rest with `ANCILE_SECRET_KEY` and never shown again. Add, replace or remove any of them in **Settings → API keys** (see [configuration](configuration.md#api-keys)). Once it can answer (its key is saved), an added model appears everywhere a model can be chosen: the model picker (`m`), `@model` in the composer, and every Model, Router and Manager node in a flow.

OpenRouter models are added one by one: nothing lists OpenRouter's catalogue in a picker, and a first OpenRouter key switches on only the models you added (see [OpenRouter](openrouter.md#adding-openrouter-models)).

## Which models a picker offers

Every picker lists only models that can answer now: the model picker (`m`) and the palette, `@model` in the composer, **Answer this again with**, the flow editor's model pickers, and **Add model** in Admin → Routing. A model can answer when it is:

- a provider's model (Anthropic, OpenAI, Google, OpenRouter, your own server) that is switched on and whose key is saved;
- an Ollama model that Ollama has pulled (see [Ollama](#ollama));
- a model served by a GPU node the Controller knows (`node/<model>`);
- Claude Code, when it is installed and usable on this computer.

The [test models](#test-models) leave the pickers once a real model can answer, and come back only if none can. Picking an Ollama model starts loading it (see [Loaded now](#loaded-now)).

A model that cannot answer is never offered: one that needs its key, is switched off, or is not in Ollama. **Admin → Models** lists only what is real (MD2):

- a provider appears once its key is saved, and then starts with **three current models of different tiers**: a fast one, a balanced one and the best one (Haiku, Sonnet and Opus for Anthropic; ranked by price for a provider whose models are not in lines). They come from the provider's live model list when the daily check has read it, and from the list that ships with NVX Ancile (dated by `prices_as_of` in `config/models.yaml`) when it has not or the call failed; a model the provider retired, or that is only a preview, steps aside;
- **Add more models** shows the rest of what the provider offers, one **Show** at a time (`POST /models/shown`); a model you showed stays, and one you hide goes back;
- Claude Code's models show only while Claude Code is signed in; node models only when a node serves them; Ollama's only once pulled; any you added always show;
- a key you remove later hides the provider again, and a flow that used one of its models shows a warning on that step.

`GET /models` marks each model `listed` and, when it is not, `unlisted_reason` (`no_key`, `not_pulled`, `no_node`, `signed_out`, `more`, `retired`). Admin → Routing keeps such a model in a chain, marked, and routing skips it.

When Claude Code cannot answer (not installed, or its install could not be verified), the picker shows no Claude Code model. A separate **Set up Claude Code** row says why and opens Settings → Claude Code. It is an action, not a model, so it can never be chosen to answer a message.

## Download a local model

**Admin → Models → Download a local model** offers a short list of models that run on this computer, so nothing you ask them leaves it. The list is `config/local-models.yaml`. Each entry gives the download size, the memory it needs (and the graphics memory to run fully on a graphics card), its licence with a link, and what it is good for.

Before anything downloads, NVX Ancile checks this computer and says plainly whether each model fits:

- **Fits well:** it fits on your graphics card (found with `nvidia-smi`), or in Apple silicon's shared memory.
- **Fits, but slow:** there is enough memory, but it would run on the processor.
- **Won't fit:** not enough memory (you can still choose **Download anyway**), or not enough free disk where Ollama keeps models (`OLLAMA_MODELS`, else `~/.ollama/models`). A full disk is never overridden.
- **Cannot check:** Ollama runs on another computer (`OLLAMA_BASE_URL`), so its memory and disk can't be read from here.

Chat models download through [Ollama](https://ollama.com), using its own pull. You see progress, can **Cancel**, and **Resume** carries on from what Ollama already has. When Ollama confirms the model is there, the model is switched on, or added as `ollama/<tag>` with the details from the list (its window and tools), in every model picker, ready.

If Ollama is missing, NVX Ancile never installs it for you. The dialog links to the official download page for your system (on Linux it shows the official install command to copy). If it is installed but not running, open it and press **Check again**.

The search embedder (BGE small) downloads through the knowledge service, with fastembed's own downloader into `KNOWLEDGE_MODEL_CACHE`. It needs `KNOWLEDGE_MODEL_DOWNLOAD` left on (`embed.download_off`).

## Ollama

NVX Ancile asks Ollama (`OLLAMA_BASE_URL`, else `http://localhost:11434`) for its list of pulled models (`/api/tags`) at most every 30 seconds, and again as soon as a download finishes or setup finds Ollama.

- **Pulled models are found by themselves.** Every chat model Ollama has is listed as `ollama/<name>` (`ollama/llama3.2` for `llama3.2:latest`), ready, with no need to add it. Embedding models are left out. What Ollama says a model can do (`/api/show`: tools, vision, thinking, its context length) is used when Ollama says it; otherwise the model is listed without tools, with an 8,192-token window. A model you pull with `ollama pull` shows up within 30 seconds, and leaves the list when you remove it (`ollama rm`).
- **Never twice.** A name that a model in `config/models.yaml` or one you added already serves is not listed again. A download from the list saves its details under the same id, which then replaces the one that was found.
- **Yours to switch off.** A found model can be switched off and given a colour in Admin → Models, and stays off. It cannot be edited or removed there (`model.from_ollama`): remove it in Ollama.
- **Only what Ollama has.** An Ollama model in `config/models.yaml` or one you added answers only once Ollama has said it has it: until then it shows as **Not pulled** (`not_pulled` in `GET /models`), no picker offers it, and routing skips it. That includes the time before Ollama first answers. If Ollama stops answering, what it said last stands. Finding Ollama during setup switches on only the models it has, wherever they are configured to be served from.

## Test models

Before you connect a model, the switcher offers two built-in **test** models: **Offline test model** and **Offline echo** (the backup it falls back to). They don't use AI: they stream, call tools, ask for permission and fail on request, so you can see how NVX Ancile behaves with nothing installed. They are on when `ANCILE_OFFLINE_MODELS=1`, which `pnpm start` and the desktop app set.

Once any real model is ready, the model switcher and the flow pickers stop listing them, and routing no longer falls back to them: a real model that fails says so, instead of being answered by a model that does not use AI. They come back if no real model can answer, and setup then points you to adding one. There is no setting for this (TO2). In the test profile (`pnpm start:e2e`) the Controller's sample nodes are test models too, so they do not count as a real model. Admin → Models always lists them, and a model asked for by name still answers, so `/say`, `/slow` and `/fail` keep working. A dev build started with `VITE_ANCILE_TEST_MODELS=1` keeps them in the pickers next to a real model. A flow saved with a test model keeps working and its step says so, with a **Choose a model** fix.

## Loaded now

Admin → Models opens with a **Loaded now** strip when Ollama has models in memory (LM1): each model, how much memory it uses, when Ollama will unload it, with **Unload** and **Keep loaded** (`keep_alive` 0 and -1 through Ollama's own API). Only models NVX Ancile lists can be changed; anything else Ollama has loaded is shown and left alone. Picking an Ollama model in the switcher asks Ollama to load it (`POST /local-models/warm`), with a small dot until it is in memory; a newer pick cancels an older load, nothing loads early while the computer runs on its battery, and a note says when two models will not fit together. An Ollama older than 0.1.33 cannot list what is loaded and the strip says so; Ollama on another computer works the same, without memory figures. Pro adds per-notebook keep-alive and context-length presets with a memory forecast: a notebook can keep a model loaded for a time you choose, or until you unload it, and load it with a shorter or longer context. The preset rides on each chat request, so it applies from the first message.

## Editing and removing a model

Each row in **Admin → Models** has a "⋯" menu:

- **Edit.** For a model you added: its name, context window, chip colour and whether it is on. A model on your own server also takes a new address, the name of a stored key to use instead (empty for none), or a replacement key. A model from `config/models.yaml` takes only its colour and on/off here; change the rest in the file.
- **Turn on / Turn off.** Routing and every picker skip a model that is off.
- **Remove** (models you added only). It asks first, then shows an Undo for ten minutes that brings the model and its stored key back. A server's key goes with its last model. Models from `config/models.yaml` cannot be removed (`model.not_custom`); turn them off instead. A model found in Ollama leaves when you remove it in Ollama (`model.from_ollama`).

The chip colour is one of the identity hues; **Follow the family** goes back to the default for its provider family.

## GPU nodes

A GPU node is a machine the Controller can start and stop. Add one under **Admin → Compute**: a RunPod pod by id (once a RunPod key is saved in Settings → API keys, or `RUNPOD_API_KEY` is set), or a machine on your network running Ollama, vLLM or LM Studio (`CONTROLLER_LOCAL_NODES`). Its models are listed as `node/<model>`. If the node serves an OpenAI-compatible API you can reach directly, you can also add it under **Your server**, but then NVX Ancile cannot wake it for you.

When a message needs a node that is stopped, the answer shows **Waking your GPU node** with the start-up chain lighting as it goes; **Use a cloud model instead** answers straight away from the cloud. Rules stop idle nodes and cap spending; see [compute](compute.md).

## Subscriptions are not API keys

Claude Pro or Max and ChatGPT Plus or Pro are subscriptions to the providers' own apps. They are not API credentials, and the providers do not offer them for other apps to call, so NVX Ancile cannot route through them. Use an API key, OpenRouter, or a model you run yourself.

## Routing chains

When nothing more specific chooses a model, the task class's fallback chain does: the first model in it that can answer is tried first, then the next. Change a chain in **Admin → Routing**. Drag a model by its grip, or open its **⋯** menu for **Move up**, **Move down** and **Remove from chain**; **Add model** offers the chat models that can answer now. Every change saves at once and applies to the next turn. A model without its key, or switched off, stays in the chain but is skipped. **Reset to default** goes back to `config/routing.yaml`, and offers Undo.

## Which model answers

The most specific choice wins:

1. `@flow` on the message
2. a model picked for the message (`@model`, or **Just the next message** in the model switcher): it answers alone, instead of any flow
3. the thread's flow, or flows turned off for the thread
4. the notebook's flow, then the workspace's flow
5. with no flow: the thread's model, then your default model

A thread's model is the model for plain chat in that thread. It does not override a flow: to use it instead of the notebook's flow, choose **This thread instead of the flow** when you switch. If a thread's model loses its key or is removed, your default answers instead and the Why panel says so.

The Why panel (`w`) names the model that answered, who chose it, the route a flow took, any flow that was set aside, and any fallback. See [flows](flows.md#changing-the-model-while-a-flow-answers).

## Staying current: the daily model check

Once a day, 60 seconds after NVX Ancile starts, and when the computer wakes from sleep, NVX Ancile reads the live model list of every provider you have a key for (Anthropic, OpenAI, Google, OpenRouter, and DeepSeek, Moonshot, Mistral, xAI and similar providers you added as an endpoint). It does this to keep prices, context sizes and abilities true, to offer new models, and to tell you when a model is going away. What it found is listed under **Settings → Models**.

**What is checked.** Each model's id, its context window and output limit, the abilities the provider reports (tools, images, reasoning, JSON), and whether the provider has deprecated or retired it. Providers differ. Anthropic's list has limits, abilities and retirement dates but no prices. OpenAI's list has ids only. Google's has limits. OpenRouter's has prices, limits and abilities. Z.ai has no model list, so nothing is checked there and the page says so.

**When.** Each provider is checked when its last good check is over 24 hours old. A failed check is tried again after 1 hour, then 2, 4, 8 and so on, up to 24 hours. **Check now** asks a provider at most once a minute. Only one check runs at a time.

**A key that cannot list models** is not a rejected key. Some keys are allowed to answer but not to list. The page says "This key can't list models" (`models.list_forbidden`), your answers carry on as before, and prices and lists for that provider stay as shipped.

### Where prices come from

1. The provider's own live price, when its list has one (OpenRouter).
2. OpenRouter's public list, for direct providers whose lists carry no price (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Mistral, xAI, Qwen, Z.ai, MiniMax). A model is matched by vendor and name, lowercased, with dots turned into dashes and any date at the end removed. Only an exact match counts, so a model that is merely similar never borrows a price.
3. The prices shipped in `config/models.yaml`, which carry a date (`prices_as_of`) shown beside them.

A live price replaces the shipped one for costs and for Usage. When one differs from what was in use, a **Price** change shows the old and new price per million tokens. The setting **Check prices against OpenRouter** (on by default) turns step 2 off. When it is off, OpenRouter's list is never fetched unless you have an OpenRouter key, and prices from OpenRouter already stored are dropped so the shipped ones apply again.

**Privacy.** The price lookup fetches OpenRouter's public list with no key and nothing about you. Your provider keys are sent only to that provider's own address, to read its model list. Keys and responses are never logged.

### Off-peak prices

A model's `price` can carry an `off_peak` block: a second set of rates that applies inside weekly windows, in UTC (no daylight saving), and the normal `price` at every other time. Each window lists weekdays (`mon` to `sun`) and a `from` and `to` as `HH:MM`, from the start up to but not including the end; `24:00` ends a day, and a window never crosses midnight (write two). A rate the off-peak block leaves out keeps the normal one. DeepSeek charges half price outside 01:00 to 04:00 and 06:00 to 10:00 UTC on Monday to Friday, so its off-peak windows are every other hour plus Saturday and Sunday; Chinese public holidays are also off-peak and are not modelled. Every call is priced at the rate in force when it began, and the receipt shows the rate that applied. A live price that comes out lower than the shipped off-peak rate drops the off-peak block, rather than make off-peak dearer than normal.

### Lines and tiers

A **line** is one family of a provider's models that gets newer versions, such as Claude Opus, Claude Sonnet, GPT, GPT mini or Gemini Flash. Each line has a tier:

| Tier | Examples |
|---|---|
| Best | Claude Fable and Opus, GPT, Gemini Pro, DeepSeek Pro, Kimi, Grok, Mistral Large |
| Balanced | Claude Sonnet, GPT mini, Gemini Flash, Mistral Medium |
| Fast | Claude Haiku, GPT nano, Gemini Flash-Lite, DeepSeek Flash, Grok mini, Mistral Small |

A line's id is `<provider>/<line>`, for example `anthropic/opus`, and its alias is `anthropic/opus:latest`. The alias works anywhere a model id does: in routing chains, a thread's model, a flow step, an automation or a persona. It answers with the line's **current model**. Before any check, that is the newest stable model in your model list. A dated snapshot such as `gpt-5.5-2026-08-01` is the same version as `gpt-5.5`, never newer, and the undated id is preferred. A preview, experimental or beta model is never the newest stable one.

An answer records the model that actually answered. The message keeps the alias you asked for as the model you requested, so the Why panel can say "asked for Claude Opus (latest), answered by Claude Opus 5.5".

A model that matches no line (an unknown name) can still be offered as new and added, but it is never followed.

### Follow latest

Each line has **Follow latest**, off until you turn it on. When it is on and a newer stable model appears:

1. NVX Ancile sends a **test call** through the normal model path: "Reply with the single word: ready", at most 16 tokens, no tools, with 30 seconds to answer. The call is billed like any other.
2. If it comes back with some text and no error, the line moves to the new model. The new model is added to your list, and the change shows in the feed.
3. If it fails, the line stays where it is, the page says why, and the check is tried again at the next daily run.

Following never goes to a preview. With Follow off, a newer model is only offered. You can always choose a model of the line yourself (**Use this one**): that moves at once, with no test call, and previews are allowed because you chose it. **Go back** returns to the model the line used before its last move, and a second **Go back** returns again.

### Retirements

When a provider marks a model deprecated or retired, a **Retired** change says so. A model that is missing from three successful checks in a row is treated as retired too. A retired model stays in your list, and its id keeps working: a call to it is answered by its line's current model, with a note. If the line's current model is the retired one, the line moves to the newest stable model of the line (after a passing test call, when you are following). Nothing is ever deleted.

### New abilities

Models also gain abilities over time. When a model you have gains or loses an ability NVX Ancile uses, a **Capability** change says so and the live list is used from then on. When it gains one NVX Ancile does not use yet (reading PDFs, say), a separate change says that, so you know without anything being switched on.

### Changes and the first check

Changes are kept as a feed of the newest 200. Seen ones older than 30 days are dropped. A provider's first check records every model quietly and only mentions the newest stable model of a line you already use, so adding a key does not open with a hundred "new" models. OpenRouter's list never offers new models: the catalogue in **Add a model** does that.
