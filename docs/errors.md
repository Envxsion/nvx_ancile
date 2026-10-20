# Error codes

Every error from every service has the same shape (`packages/contracts/src/errors.ts`): a stable dotted `code`, a plain `title`, what happened (`detail`), what to do (`hint`), whether retrying can help, the trace id, and any attempts made. The interface shows `title`, `detail` and `hint`, with **Copy debug info** for everything else.

Rules for new codes:
- Add the code here in the same change.
- The title says what happened, in one sentence, without apologising.
- The hint names a concrete action and where to do it.

## Catalogue

### Requests

| Code | HTTP | Title / hint |
|---|---|---|
| `request.invalid` | 400 | "That request isn't valid." / Names the field and what was expected. |
| `request.unauthenticated` | 401 | "Sign in to continue." / Enter your passphrase. |
| `request.not_found` | 404 | "That doesn't exist." / It may have been deleted. |
| `request.conflict` | 409 | "This changed while you were editing." / Review both versions and choose. |
| `request.rate_limited` | 429 | "Too many requests at once." / Wait a moment; Ancile retries by itself. |
| `request.cross_origin` | 403 | "This request came from another site." / Open NVX Ancile from its own address; add another origin to `ANCILE_ALLOWED_ORIGINS` if you serve the Cockpit elsewhere. |
| `request.unsupported_type` | 415 | "Ancile only accepts JSON here." / Send the body as `application/json` with a matching Content-Type header. |
| `request.too_large` | 413 | "That request is too large." / Send less at once: the limit is 25 MB. |
| `not_implemented` | 501 | "<Feature> is not built yet." / Names the release it arrives in. |
| `auth.service_token` | 401 | "This endpoint is for Ancile services only." / Check that `ANCILE_SERVICE_TOKEN` matches across services. |
| `http.unexpected` | any | "The server answered <status> without an explanation." / Copy the debug info and check the logs for this trace. The Cockpit's words for an error answer with no error body. |
| `cockpit.offline` | none | "<What> could not be loaded." / NVX Ancile is not answering. Check that it is running, then try again. The Cockpit's words when Core never answered a read; a panel shows it with Try again, never an empty list (docs/ux.md). |
| `cockpit.load_failed` | none | "<What> could not be loaded." / Try again. If it keeps failing, copy the debug info and report it. An answer the Cockpit could not read; what went wrong goes only into the debug info. |

### Providers and models (Gateway)

| Code | HTTP | Title / hint |
|---|---|---|
| `provider.auth_failed` | 502 | "<Provider> rejected the API key." / Update it in Settings → API keys → <Provider>. Only raised when the provider answers 401 or 403 with a body that sounds like authentication (or a bare 401); a 403 that is throttling or quota is not a bad key, and a signal the research could not confirm is never proof of one (gateway/provider-errors.ts); any other failed key test is `provider.unavailable`, with the provider's own explanation (the key scrubbed out) in `detail`. |
| `provider.no_credit` | 502 | "<Provider> says your account is out of credit." / Top up at <Provider>, or pick another model. Raised when the provider's own words say so, whatever the HTTP status: a 402 (DeepSeek, OpenRouter, Google prepaid, Together, Cerebras, Anthropic `billing_error`), a 429 with a code (OpenAI `credit_balance_exhausted`, `*_spend_limit_exceeded`, `insufficient_quota`; Kimi `exceeded_current_quota_error`; Z.ai 1113 and the plan limits 1308 to 1321), a 400 (Anthropic spend limit, Qwen `Arrearage`) or a 403 (Qwen `AllocationQuota.FreeTierOnly`). Some shapes keep the code but change the title and hint, because the fix is not "top up": Anthropic's tier spend cap (a 429 `rate_limit_error` with `details.error_code` `enforced_spend_limit_reached` and no `retry-after`: "has stopped requests at your monthly spend cap", never retried, resets 00:00 UTC on the 1st), a limit you set yourself (a 400 "You have reached your specified API usage limits") and a billing problem (a 402); Z.ai 1113, whose hint also says a Coding Plan key used from a tool the plan does not cover is reported the same way, and 1310, 1316 and 1317 (the plan's caps: wait, the plan never draws on the balance); MiniMax 2056 (the plan's window is spent: wait, a plan key never spends the pay-as-you-go balance); OpenRouter 402 (a balance below zero blocks free models too; a 402 whose reason is `in_flight_budget_exhausted` is transient instead). Kimi's out-of-balance and rate-limit errors are both 429: `error.type` tells them apart. Permanent for that provider: it is not retried, and the chain moves to the next model at once. A key test that hits it saves nothing. |
| `provider.credit_exhausted` | 502 | "Your plan's monthly API credit is used up." / It renews at the start of the next cycle. Until then this model is skipped: pick another, or buy credit in the Claude Console. Raised instead of `provider.no_credit` only on an Anthropic key that is marked as drawing on the plan's monthly credit (Settings → API keys → Anthropic), and for a Claude Code session or model run on that key (`claude-code/<model>@credit`) whose result says the credit balance is too low. Anthropic documents HTTP 402 `billing_error` for billing problems (platform.claude.com/docs/en/api/errors); the "credit balance is too low" wording of a 400 `invalid_request_error` is read as a spent credit only on a marked key. A tier spend cap (429) and a limit you set (400) are documented and are never read as the credit running out. Permanent: never retried, the chain moves on and the answer's fallback note names it. It marks the credit spent until the cycle ends, or until you save the credit settings again (for example after buying credit). |
| `provider.wrong_region` | 502 | "<Provider> says this key is for another region." / Names the other regions ("Try China (Beijing)"): change the region beside the key in Settings → API keys. Moonshot, MiniMax, Qwen and Z.ai keys only work in the region they were made in. Raised when the body says so, and for OpenAI's "country, region, or territory not supported" (then the hint says to use another provider). A wrong-region 401 on those providers is otherwise `provider.auth_failed` with a hint about the region. Kimi's international (`platform.kimi.ai`) and China (`platform.moonshot.cn`) keys are separate. The Alibaba Token Plan is sold in the Beijing region only and the free quota applies to Singapore only. |
| `provider.model_not_permitted` | 502 | "<Provider> says this key can't use <model>." / Pick another model, or check that your plan or project at the provider includes it. For Anthropic 403 `permission_error`, Qwen `Model.AccessDenied`, Z.ai 1311 (the plan lacks the model, sent as a 429) and Kimi's 404 for a model you may not use. |
| `provider.model_not_offered` | 502 | "<Provider> accepted the key, but <model> isn't offered to it." / The key was not the problem, and nothing was saved. The provider does not serve that model to this key: check that your plan or project there includes it, or add another model in Admin → Models, then test again. Raised by a key test when the provider answers 404 or says the model is not found or not supported (Google: "models/… is not found for API version v1beta, or is not supported for generateContent"). Where the provider's own model list can be read with the key, that list is used instead, so a model it does not offer is only left off and the key is saved. |
| `setup.no_test_model` | 422 | "NVX Ancile has no <Provider> model to test the key with." / The provider has no way to check a key without a model (its model list is public, missing or undocumented) and none is configured for it. Add a model for it in Admin → Models, then test again. Nothing is saved. |
| `provider.workspace_needed` | 400 | "Anthropic needs to know which workspace this key bills." / A personal key (`sk-ant-usr-`) is not tied to a workspace: copy the workspace's ID (`wrkspc_…`) from the Claude Console, Settings → Workspaces, and paste it beside the key. Raised before any call when a personal key comes without one, and when Anthropic itself asks for the `anthropic-workspace-id` header. Nothing is saved. |
| `provider.unavailable` | 503 | "<Model> is unavailable." / Ancile fell back where it could; check Health for the provider's status. In a key test it reads the failure three ways, each with the provider's own explanation (key scrubbed) below: "<Provider> didn't answer the test" with "Check your connection" only for a real network failure (no DNS answer, a refused or dropped connection, a timeout); "<Provider> turned the test down" when it answered with a refusal that is not a bad key, no credit, a wrong region, a rate limit or a missing model; and "<Provider> had a problem answering the test" for its own 5xx. Nothing is saved. |
| `provider.refused` | 502 | "<Model> declined to answer." / Another model answered if one was available. Rephrase, or pick a model in the switcher. |
| `provider.context_overflow` | 413 | "This conversation is too long for <model>." / Compact it, or switch to a model with a larger window. |
| `model.context_truncated` | (warning) | "This local model only read part of the conversation." / Sent as a `warning` event, once per thread and model, when Ollama reports reading far fewer prompt tokens than were sent. Raise the model's context length in Ollama, or choose a model with a larger window. |
| `model.chain_exhausted` | 503 | "No model could answer." / Each attempt and its reason are listed. Check your keys and Health. |
| `model.not_configured` | 422 | "<Model> isn't set up." / Add a key in Settings → Models. |
| `model.not_chat` | 422 | "<Model> can't answer messages." / It is an embedding or rerank model; pick a chat model in the model switcher. |
| `model.gone` | 409 | "<model> is no longer available." / It was removed or renamed; pick another model and send again. Raised when a message, edit or regenerate names a model that is no longer in the list. `error.context` has `model_id` and `suggested_model` (the thread's model, else the default route's first), and the Cockpit offers a model picker on the error, preset to it. |
| `model.unknown` | 404 | "There is no model called <id>." / Check the id in Settings → Models, or pick a model from the switcher. Raised when a message, edit or regenerate names an id that Ancile has never listed (a typo, or a model from another install); a model that was listed and then removed is `model.gone`. `error.context` has `model_id` and `suggested_model`. |
| `model.pinned_unavailable` | (run error) | "<Model> could not answer." / Says why in one sentence. A model you chose falls back only to models no dearer than it (docs/models.md, Pinned models); none could answer, so the turn stopped. The error carries `options` (up to two dearer models, with their prices) and the Cockpit shows each as **Try with <model>**, beside **Pick another model** and **Try again**. |
| `model.exists` | 409 | "<id> is already in your models." / Edit the one you have, or remove it first. |
| `model.not_custom` | 409 | "<Model> comes from models.yaml." / Only models you added in Settings → Models can be edited or removed; you can still switch it on or off and change its colour. |
| `model.from_ollama` | 409 | "<Model> comes from Ollama." / It is listed because Ollama has it pulled (docs/models.md, Ollama). To take it off the list, remove it in Ollama (`ollama rm <name>`); you can still switch it on or off and change its colour. Raised when a model found in Ollama is edited or removed. |
| `model.needs_base_url` | 400 | "An OpenAI-compatible model needs the server address." / Give its base URL ending in /v1, for example https://abc123-8000.proxy.runpod.net/v1. |
| `models.list_forbidden` | 502 (shown on the provider's check) | "This key can't list models at <host>." / The key still works for answers. Prices and new models for this provider stay as shipped. A key allowed to list models, or a different key, turns the daily check on. Never reported as a rejected key. |
| `models.list_unavailable` | 502 (shown on the check) | "<Host> did not give its model list." / It answered with an error or was busy (429, 5xx). NVX Ancile asks again later: after 1 hour, then 2, 4, 8, up to 24. |
| `models.list_failed` | 502 (shown on the check) | "The model list from <host> could not be read." / Check your connection, or the address in Settings → Models, then Check now. Asked again later. |
| `models.check_too_soon` | 429 | "<Provider> was checked a moment ago." / Each provider can be checked once a minute (POST /models/watch/check). |
| `models.line_model_not_in_line` | 400 | "<id> is not a model of <line>." / Pick one of the models listed for the line (PUT /models/lines/:provider/:line, `use`). |
| `models.line_no_previous` | 409 | "There is no earlier model to go back to." / A line remembers the model it used before its last move; it has not moved yet. |
| `routing.task_class_unknown` | 404 | "There is no task class called <class>." / Pick one of the task classes listed in Admin → Routing. |
| `routing.chain_empty` | 400 | "A chain needs at least one model." / Add a model before saving, or reset the chain to its default. |
| `routing.model_unknown` | 400 | "<id> isn't one of your models." / Add it in Admin → Models first, or pick a model from the list. |
| `model.not_endpoint` | 409 | "<Model> is not on your own server." / Only OpenAI-compatible models have an address and a key to change in Admin → Models; provider keys live in Settings → Models. |
| `model.secret_missing` | 422 | "No key called <name> is stored." / Check the name, or paste the key itself instead. |
| `model.restore_expired` | 410 | "Too late to undo that removal." / Undo works for ten minutes, and not across a restart; add the model again from Admin → Models. |
| `model.catalogue_failed` | 502 | "Could not list the models <source> offers." / For OpenRouter, check your connection (you can still add a model by its id); for a server, check the address, key, and that it answers GET /models. |
| `local_model.not_managed` | 409 | "<model> was not loaded by NVX Ancile." / Only models listed in Admin → Models can be unloaded or kept from Loaded now. Use Ollama itself for the rest. |
| `local_model.ollama_silent` | 503 | "Ollama is not answering." / Open Ollama (or run `ollama serve`), then try again. Raised by Unload and Keep loaded; the Loaded now strip itself just hides. |
| `import.too_large` | 413 | "That file is too large to import." / Imports hold up to 300 MB. Open the export's zip and bring in conversations.json on its own, or export fewer conversations. |
| `import.unreadable` | 422 | "That file is not a chat export." / Pick conversations.json from your ChatGPT or Claude export (or the .zip it came in), or the chats file Open WebUI exports. |
| `import.unknown_format` | 422 | "NVX Ancile does not recognise those chats." / It reads exports from ChatGPT, Claude and Open WebUI. Check you picked the conversations file. |
| `import.empty` | 422 | "That file has no conversations." / Export again from the tool, then pick the new file. |
| `import.zip_no_chats` | 422 | "That zip has no conversations in it." / Pick the zip the export came in, or conversations.json from inside it. |
| `import.not_found` | 404 | "That import does not exist." / Start a new import. |
| `import.failed` | (job) | "The import stopped part way." / Start it again with the same file: conversations already brought in are skipped. Shown on the import, not as a response. |
| `local_model.unknown` | 404 | "That model is not in the list of local models." / Pick one from Admin → Models → Download a local model. |
| `local_model.ollama_missing` | 409 | "Ollama is not installed" (or "installed but not running", or "Ollama at <url> is not answering") / Install it from its official page (never done for you), or open it, then try again. `error.context.ollama` and `download_url` say which. |
| `local_model.no_disk` | 507 | "Not enough disk for <model>." / Says how much it needs and how much is free, and where. Never overridden. |
| `local_model.too_big` | 422 | "<Model> needs more memory than this computer has." / Says how much it needs; pick a smaller model, or start it anyway (`anyway: true`). |
| `local_model.quant_unavailable` | 400 | "<Model> is not offered at <precision>." / Choose one of the precisions listed for it (its `quant_tags` in config/local-models.yaml), or the default. |
| `openrouter.endpoints_unavailable` | 502 | "Could not read this model's providers from OpenRouter." / Check the connection and try again. Only when nothing was saved before: once read, the list is kept for offline use (docs/openrouter.md). Routing never fails on it; it builds without the endpoint exclusions. |
| `openrouter.model_invalid` | 400 | "That is not an OpenRouter model id." / Use the form author/model, for example qwen/qwen3-coder. |
| `local_model.embedder_unavailable` | 503 | "The knowledge service is not connected." / Start NVX Ancile with its knowledge service, then try again. |
| `local_model.download_not_found` | 404 | "That download is not running." / It may have finished before NVX Ancile last restarted. Start it again to carry on. |
| `local_model.pull_failed` | 502 | "The download of <model> stalled" (or "stopped") / Check your connection, then press Resume: Ollama carries on from what it already has. Shown on the download, not as a response. |
| `local_model.pull_refused` | 502 | "Ollama would not download <model>." / Quotes Ollama's reason; check the name or update Ollama. Shown on the download. |
| `local_model.not_verified` | 502 | "<Model> downloaded but Ollama does not list it" (or the embedder did not load) / Start the download again; Ollama keeps what it already has. Shown on the download. |
| `e2e.real_model_blocked` | 403 | "The test profile blocked a call to <model>" (or "blocked Claude Code") / Tests may only use the offline models (`offline/echo`, `offline/test`). Raised in the test profile only (`ANCILE_PROFILE=e2e`), before any network, key or CLI is touched, at the two lowest points a model call passes (`RoutingClient.stream` and `languageModelFor`) and at the Claude bridge and CLI. Allowed: the built-in fake provider and models on the Controller (forced to its fake provider in that profile). Also raised in a live test run (`ANCILE_LIVE_ALLOW` set, `pnpm test:live`, [testing.md](testing.md)): "The live test run blocked a call to <model>", for every model that is not on the run's list, for Claude Code (Mode A and B), and for the direct calls that bypass the gateway (image providers, the Jev reviewers). Not a fallback: the chain stops. Never raised in the everyday stack. |
| `live.cap_reached` | 403 | "The live test cap was reached before a call to <model>" / The run may spend at most the cap (`ANCILE_LIVE_CAP_USD`, default $2). Core adds up what every call billed in this process (`billed_usd`, else `cost_usd`) and refuses a call when that total, the calls still running and an estimate of this one (its whole prompt at the fresh input price plus a full answer) would pass the cap. Nothing was sent. Raised only in a live test run. Not a fallback: the chain stops, and background work that meets it skips. |

### Permissions

| Code | HTTP | Title / hint |
|---|---|---|
| `permission.policy_denied` | 403 | "A policy blocks this." / Names the policy id; edit it in `config/policies/`. |
| `permission.denied` | 403 | "You declined this action." / (Given to the model as a tool result.) |
| `permission.critical_not_rememberable` | 422 | "Critical actions can't be remembered." / Approve this once instead. |
| `permission.scope_too_wide` | 422 | "Careful remembers answers for this thread only." / Choose "In this thread" or "Just this once", or switch to Balanced in Admin → Permissions. |
| `permission.pattern_too_broad` | 422 | "That pattern is wider than this tool allows." / Choose a suggested pattern or a narrower one. Also when the pattern doesn't cover what was asked, and when editing a saved permission would widen its pattern ("That pattern is wider than the one you granted"). |
| `permission.restore_expired` | 410 | "Too late to undo that revocation." / Undo works for ten minutes after revoking; the agent will ask again next time. |
| `permission.edit_needs_once` | 422 | "Changed arguments can only be approved once." / Choose "Just this once" to run it with your changes, or approve the original. |
| `permission.args_not_editable` | 422 | "This tool's arguments can't be changed." / Approve or deny it as it is. |
| `permission.edited_args_denied` | 422 | "Your changes are not allowed." / Names the policy or your deny; undo the change, or deny it. The approval stays open. |

### Scopes {#scopes}

What a notebook or thread may use (docs/scopes.md). The `scope.*` refusals marked "–" are not HTTP errors: they are the `code` on a gate decision (`via: "scope"`), given to the model as the tool result and shown in the Why view, and what `checkEngineAllowed` returns. The decision log records them as `policy_deny` with the field as the policy id (`scope.network`).

| Code | HTTP | Title / hint |
|---|---|---|
| `scope.widen` | 422 | "A thread can only narrow its notebook." / Names the fields; change the notebook's scope first, or choose less. |
| `scope.private_conflict` | 422 | "A private notebook keeps everything on this machine." / Turn off "Private" for the notebook first. |
| `privacy.denied` | 403 | "This notebook is private, so that stayed on this computer." / Allow it in Settings → Private notebooks, or use a model on this computer. For a floor (cloud models, Claude Code, the web, hosted Auto reviewers) turn off Private for the notebook. Raised by `PrivacyPolicies.require` (docs/privacy.md); the capability is in the context. |
| `privacy.locked` | 422 | "That cannot be switched on for private notebooks." / `PUT /privacy/policy` named a capability that is a fixed floor, or one that does not exist. Only `decisions_off_machine`, `passive_memory` and `verdict_cache_global` can be switched. |
| `scope.engine_not_allowed` | – | "<Engine> is not allowed here." / Change the notebook's or thread's engines. |
| `scope.model_not_allowed` | – | "<Model> is blocked here" or "is not one of the models allowed here." / Pick an allowed model, or change the scope. |
| `scope.data_stays_local` | – | "Nothing may leave this machine here." / Use a local model, or allow data to leave in the scope. |
| `scope.private_notebook` | – | "This notebook is private, so only local models answer here" (never Claude Code). / Turn off "Private" if it should. |
| `scope.tool_not_allowed` | – | "<action> is blocked here" or "is not one of the tools allowed here." / Change the scope's tools. |
| `scope.mcp_server_not_allowed` | – | "The <server> MCP server is not allowed here." / Change the scope's MCP servers. |
| `scope.folder_not_allowed` | – | "<path> is outside the folders allowed here." / Add the folder to the scope. |
| `scope.network_off` | – | "The network is off here." / Turn the network on in the scope. |
| `scope.memory_read_off` / `scope.memory_write_off` | – | "Memory is off here" / "Nothing may be written to memory here." / Change the scope's memory switches. |
| `scope.source_not_allowed` | – | Reserved: retrieval skips sources outside the scope rather than failing. |
| `scope.context_links_off` | 403 / – | "Context links are switched off here." / Turn context links on in this notebook's or thread's scope. Also the code on a link the Why view lists as not read. |
| `tool_preset.not_found` | 422 | "That tool preset does not exist." / Choose another preset, or none. A preset deleted after it was chosen fails closed: `scope.tool_not_allowed` with the field `tool_preset`. |
| `tool_preset.builtin` | 409 | "Built-in tool presets cannot be changed." / Make your own preset instead. |
| `tool_preset.in_use` | 409 | "This tool preset is still in use." / Says how many notebooks and threads use it; choose another preset there first. |

A refusal by a tool preset uses the same `scope.tool_not_allowed`, `scope.mcp_server_not_allowed` or `scope.network_off` codes with the field `tool_preset`, so the decision log records it as `scope.tool_preset` and the reason names the preset ("fs.write is not in the Read only tool preset").

### Auto mode {#auto-mode}

docs/auto-mode.md. A floor's refusal is a gate decision with `via: "floor"` and the rule as its `code` and policy id (`floor.fork_bomb`, `floor.recursive_delete_root`, `floor.protected_path`, `floor.secret_in_call`, …). A floor or reviewer that asks gives its reason on the `approval.batched` run event.

| Code | HTTP | Title / hint |
|---|---|---|
| `auto.plan_too_broad` | 422 | "A plan step must say what it touches." / Name a folder or command, such as fs:/workspace/src/** or shell:pnpm test*. |
| `auto.plan_not_pending` | 409 | "This plan was already answered." / A newer plan may have replaced it; refresh to see the current one. |
| `auto.plan_not_active` | 409 | "This plan is no longer the approved one." / A newer plan may have replaced it, or it was declined. Allow the step once instead. (Add to plan, `POST /auto/plans/:id/steps`.) |
| `auto.check_not_confirmed` | 400 | "The check has not been started." / Choose Run the check in Settings, Auto mode. Nothing runs and nothing is spent until you do. (`POST /auto/reviewer-check` without `confirm: true`.) |
| `auto.check_running` | 409 | "The check is already running." / Wait for it to finish, then run it again if you need to. |

### Runs

| Code | HTTP | Title / hint |
|---|---|---|
| `run.already_running` | 409 | "This thread is already answering." / Wait for it, or stop it first. One thread has one live run at a time. |
| `run.cancelled` | 499 | "Stopped." / (Informational.) |
| `lab.unavailable` | 503 | "The lab isn't running." / It needs Bun; install it, then restart with `pnpm start`. |
| `lab.undo_unavailable` | 409 | "This lab run can't be undone." / Its folder was over 50 MB when it started. |
| `lab.undo_superseded` | 409 | "A later lab run changed these files." / Undo the latest lab run first, or undo nothing. |
| `lab.already_undone` | 409 | "This lab run was already undone." / Nothing more to put back. |
| `lab.undo_unsafe` | 409 | "Undo stopped at a link inside the lab folder." / Remove the link from the lab folder, then undo again. |
| `lab.timed_out` | 504 | "The lab did not finish within N minutes." / It was stopped; check what it changed, then run a smaller task. The limit is `ANCILE_LAB_TIMEOUT_S`. |
| `lab.failed` | 502 | "The lab stopped with an error." / The message names what went wrong; try again. |
| `fs.path_escape` | 403 | "That path leaves the folder this agent may use." / Use a path inside the notebook or lab folder. Links and junctions that point elsewhere are not followed. (A write, rename or delete through a symlink, junction or `..`; the lab answers the engine with a reject and this reason.) |
| `run.crashed` | 500 | "This run stopped unexpectedly." / Try again. If it keeps happening, the trace has the details. Also when a run stopped its worker five times and Ancile gave up. |
| `run.step_uncertain` | 409 | "A tool may or may not have run before a restart." / Check the result, then ask again if it is needed. Reads run again by themselves; anything else is never repeated without a person. |

### Branches

| Code | HTTP | Title / hint |
|---|---|---|
| `branch.streaming` | 409 | "That reply is still being written." / Wait for it to finish or stop it, then branch. Branching from the message before it works now. |
| `message.confirm_delete` | 409 | "This removes N messages." / Confirm with the number of messages (`?confirm=N`; `context.subtree` has it). Undo works for 30 seconds. |
| `message.undo_expired` | 410 | "It is too late to undo that delete." / Undo works for 30 seconds after a delete. |
| `message.restore_parent_first` | 409 | "Undo the later delete first." / These messages hang from one deleted afterwards; undo that delete, then this one. |
| `thread.nothing_to_compact` | 409 | "This path is already short." / Compaction keeps the latest 4 messages verbatim; there is nothing older to summarise yet. |
| `thread.merge_no_model` | 503 | "No model could write the combined answer." / Pick the messages to keep yourself, or add a model in Settings → Models. |
| `thread.busy` | 409 | "Another window is sending in this thread." / Wait for it to finish, or send as a branch. Another Cockpit window (by its `x-ancile-client` id) holds the thread's send lock: from its send until the run it started ends. The Cockpit offers **Send as a branch**, which sends once that turn ends. When that turn is paused on a tool approval, the title is "Waiting for your approval" (context `reason: "approval"`) and the Cockpit also offers **Deny and send**. docs/api.md, One sender at a time. |
| `trash.confirm_needed` | 400 | "Emptying the Trash needs your confirmation." / Confirm in the Trash view, or send `confirm: true` to `POST /threads/trash/empty`. Nothing was removed. |

### Memory

| Code | HTTP | Title / hint |
|---|---|---|
| `memory.conflict` | 409 | "This file changed while you were editing it." / Both versions are shown with conflict markers (`error.context.merged_with_markers`); keep the lines you want and save again. A change on different lines is merged without asking. |
| `memory.bad_path` | 400 | "That is not a memory file." / Memory files are markdown files inside the memory folder, like `USER.md` or `PROJECTS/grant.md`. |
| `memory.not_found` | 404 | "That memory file does not exist." / Open Memory to see the files there are, or create it. |
| `memory.protected` | 409 | "AGENTS.md can't be deleted" (or USER.md, or a guide file) / Every answer is built around it. Edit it instead, or clear the entries you no longer want. |
| `memory.unknown_version` | 404 | "That version of memory does not exist." / Pick a version from the file history. |
| `memory.revert_conflict` | 409 | "That change cannot be undone automatically." / Later edits touched the same lines; change the file by hand. |
| `memory.proposal_not_found` | 404 | "That memory suggestion does not exist." / Reload the inbox. |
| `memory.proposal_decided` | 409 | "That memory suggestion was already dealt with." / Reload the inbox to see where it stands. |
| `memory.scope_fixed` | 400 | "That kind of note stays in its own file" / Lessons and model quirks are kept by topic. Choose a file instead, or approve it as it is. |
| `memory.scope_unavailable` | 409 | "This was not learned in a notebook" (or "The thread this came from is gone") / Keep it for you or everywhere instead, or choose a file. |
| `memory.notebook_gone` | 409 | "That notebook no longer exists" / Keep it for you or everywhere instead, or choose a file. Nothing is written. |
| `memory.file_unknown` | 400 | "<path> is not a memory file" / Choose USER.md, AGENTS.md, a notebook file under PROJECTS, or a topic under FAILURES. |
| `memory.thread_not_found` | 404 | "That thread does not exist" / It may have been deleted. Open another thread and try again. (Hindsight pass.) |
| `memory.hindsight_unavailable` | 503 | "The review could not be done" / No model answered, or its answer could not be read. Check that a utility or default model is set up, then try again. Nothing was saved. |
| `memory.repo_corrupt` | 500 | "The memory repository failed its integrity check." / See docs/runbooks/restore-backup.md. |
| `memory.invalid_entry` | 422 | "Some lines couldn't be read as memory entries." / Names the lines; keep one idea per bullet. |
| `memory.export_bundle_whole` | 422 | "A git bundle always holds all of memory." / A bundle carries every file and its history, private notebooks included. Choose a zip or Markdown to leave some out. |
| `memory.import_unreadable` | 422 | "That file is not a zip file" (or a git bundle, or an NVX Ancile memory export) / Pick the file NVX Ancile exported (a .zip, a .bundle or a .md), or paste the text instead. |
| `memory.import_too_large` | 413 | "That archive is too large to import." / Memory imports hold up to 5,000 files and 64 MB once opened. Import the files you need on their own. |
| `memory.import_empty` | 422 | "Nothing to import." / Every entry is already in memory, or none was ticked (or no entries were found: imports read bullets and paragraphs). |
| `memory.import_not_allowed` | 409 | "“<Notebook>” does not let memory learn." / Its scope has memory writing switched off. Turn it on in the notebook's scope, or import into About you instead. `error.context.notebook_id` names it. |
| `memory.import_not_found` | 404 | "That import does not exist." / Open Memory → Import and export to see your imports. |

### Notebooks and context links {#notebooks-and-context-links}

Merging notebooks and context links (docs/notebooks.md). A link refused by a scope answers 403 with the scope's own code (Scopes above).

| Code | HTTP | Title / hint |
|---|---|---|
| `notebook.merge_self` | 422 | "A notebook cannot be merged into itself." / Choose another notebook to merge. |
| `notebook.merge_conflict` | 409 | "One of the notebooks changed while merging." / Nothing was merged. Look at both notebooks again and try once more. On undo: "This merge cannot be undone now" / The notebook it was merged into has been deleted. Restore it first. |
| `notebook.merge_undone` | 409 | "This merge was already undone." / Nothing to do. |
| `notebook.merge_expired` | 409 | "This merge can no longer be undone." / A merge can be undone for 7 days. Move threads and sources back by hand instead. |
| `link.self` | 422 | "A thread or notebook cannot link to itself." / Choose another notebook or thread to draw on. |
| `link.own_notebook` | 422 | "This thread already reads its own notebook's sources." / Link it to another notebook instead. |
| `link.exists` | 409 | "<The notebook or thread> is already linked here." / It is in the list of links already. |

Context packs (Pro):

| Code | HTTP | Title / hint |
|---|---|---|
| `pack.empty` | 422 | "A context pack needs at least one item." / Choose sources, notes, a summary, memory or instructions. |
| `pack.no_notebook` | 422 | "This thread is not in a notebook, so it has no sources or notes." / Make the pack from a notebook instead. |
| `pack.source_not_here` | 422 | "One of the sources is not in that notebook." / Pick sources from the notebook the pack is made from. `error.context.source_id` names it. |
| `pack.no_summary` | 422 | "That thread has no summary yet." / Ask something in it first, or leave the summary out. |
| `pack.bad_file` | 422 | "That is not a context pack file" (or from a version this one cannot read, or incomplete). / Choose a file exported from NVX Ancile. |
| `pack.unverified` | 422 | "This file does not verify, so nothing was added." / The first problem found (changed after it was signed, an item not what the manifest lists). |
| `pack.needs_notebook` | 422 | "This pack holds sources." / Choose a notebook to add its sources to. |

Attaching a pack where a scope says no answers 403 with the scope's own code (`scope.data_stays_local`, `scope.private_notebook`, …). In the free build every pack route answers 402 `pro.feature_required` with `error.context.feature` `context_packs`.

### Knowledge

| Code | HTTP | Title / hint |
|---|---|---|
| `source.extract_failed` | 422 | "Couldn't read <file>." / e.g. "This PDF is scanned. Enable OCR in Settings → Sources." |
| `source.fetch_failed` | 502 | "Couldn't fetch <url>." / Gives the HTTP status; check the link or try again later. |
| `source.too_large` | 413 | "<file> is larger than the limit." / Split it, or raise the limit in Settings → Sources. |
| `source.duplicate` | 409 | "You already have this source." / Open the existing one, or keep both. |
| `knowledge.unavailable` | 503 | "Source search is unavailable." / Answers continue without sources; see Health. |
| `notebook.unavailable` | 503 | "The notebook engine is not answering." / It starts with `pnpm start`; if it keeps failing, check "notebook" in Admin → Health. |
| `source.not_ready` | 409 | "This source is still being read." / Wait until it is ready, then open it again. |
| `source.not_failed` | 409 | "Only a failed source can be retried." / This one has not failed. |
| `source.busy` | 409 | "This source is still being read." / Wait until it is ready, then fetch it again. |
| `source.refetch_unsupported` | 409 | "Only web pages can be fetched again." / To update a file, upload the new version as a source. |
| `source.no_original` | 404 | "There is no original file for this source." / Only uploaded files keep an original; open the extracted text instead. |
| `extract.url_blocked` | 422 | "This URL points somewhere Ancile will not fetch from." / Names why (private, loopback, link-local address or a non-http scheme); use a public link or paste the text. |
| `extract.fetch_failed` | 502 | "The page could not be fetched." / Check the link opens in a browser, or paste the text instead. Detail gives the HTTP status. |
| `extract.scanned_pdf` | 422 | "This PDF has no text layer." / It looks scanned. Turn on OCR in Settings → Sources, or choose Read with OCR on this source. |
| `extract.ocr_unavailable` | 422 | "OCR is not installed." / Install RapidOCR (`uv pip install rapidocr-onnxruntime`) or Tesseract on this computer, then retry. Languages other than Latin letters and Chinese need Tesseract with that language's data. |
| `source.ocr_unsupported` | 409 | "Only PDF files can be read with OCR." / Paste a page of text, or put an image in a PDF first. |
| `extract.pdf_unreadable` | 422 | "This PDF could not be opened." / It may be damaged or password protected; save a fresh copy and add that. |
| `extract.unsupported` | 422 | "This file type cannot be read yet." / Convert it to PDF, DOCX or text and add it again. |
| `extract.engine_missing` | 501 | "The <engine> extractor is not installed." / Install it with `uv sync --extra <extra>`, or use the Docker image. |
| `extract.failed` | 422 | "The text could not be read from this source." / Check the file opens normally; if it does, convert it and add it again. |
| `extract.empty` | 422 | "No text was found in this source." / Check it has readable text; for scans, turn on OCR in Settings → Sources. After OCR it reads "OCR found no text in this PDF": the scan may be too faint, rotated or handwritten, which OCR reads poorly. |
| `extract.original_missing` | 422 | "The uploaded file is missing." / Upload the file again. |
| `embed.unavailable` | 503 | "The embedding model is unavailable." / Retry, or change the embedder in Settings. Text search still works meanwhile. |
| `embed.download_off` | 409 | "Downloading models is switched off for the knowledge service." / Set KNOWLEDGE_MODEL_DOWNLOAD=true, or put the model in KNOWLEDGE_MODEL_CACHE yourself. |
| `ingest.crashed` | 500 | "Ingestion stopped unexpectedly." / Retry. If it stops again, open Admin → Logs and filter by this source. |

### Fact-checking

| Code | HTTP | Title / hint |
|---|---|---|
| `factcheck.not_answer` | 409 | "Only a finished answer can be fact-checked." / Wait for the answer to finish, then fact-check it. |
| `factcheck.none` | 404 | "This answer has not been fact-checked." / Press F on the answer, or choose Fact-check under it. |
| `factcheck.no_model` | 422 | "No model is ready to fact-check." / Names each model that was tried and why it was skipped ("Claude Code (signed out)", "no key saved", "not pulled in Ollama"): the models set for the step, Claude Code and a small Ollama model you pulled (none of 14B or less). Add a provider key in Settings → Models, set up Claude Code in Settings → Claude Code, or pull a small model with Ollama. Only raised when all three are missing: Claude Code's quickest model, then the local model, judge when no model is set (docs/factcheck.md). |
| `factcheck.no_other_family` | 422 | "No second opinion is available." / This was written by a <family> model, and a fact-check is always judged by a model from a different family (guard rail GR24). Says which were skipped. Add a provider key for another family in Settings → Models, or pull a small Ollama model, then check again. Nothing was run. |
| `factcheck.judge_not_allowed` | 422 | "No allowed model can fact-check this here." / The scope keeps every ready judge out (a private notebook, or nothing may leave the machine, so only a local model judges). Says each reason. Allow a model in this notebook's scope, or add a local model. |
| `factcheck.still_writing` | 409 | "The answer is still being written." / Wait until it is done, then highlight the claim again. |
| `factcheck.selection_too_long` | 413 | "That is too much to check at once." / Highlight up to 2,000 characters, one passage at a time. |
| `factcheck.web_unavailable` | 503 | "The web search did not answer." / The check went on with your sources only. Check the SearXNG address (`SEARXNG_URL`) and that it is running. |
| `factcheck.unavailable` | 503 | "Highlighted claims cannot be checked here." / Core was started without the fact-check service. Restart NVX Ancile. |
| `factcheck.bad_output` | 502 | "No model returned a usable fact-check." / Try again, or add a stronger model for the utility and fact-check tasks. Every model in the chain answered, but not in the shape asked for. |
| `factcheck.evidence_unavailable` | 503 | "Your sources could not be searched." / Knowledge did not answer; check it in Admin → Health, then fact-check again. |
| `factcheck.message_gone` | 404 | "The answer was deleted." / There is nothing left to check. |

### Flows

| Code | HTTP | Title / hint |
|---|---|---|
| `flow.not_found` | 404 | "That flow does not exist." / It may have been deleted. Pick another flow, or make a new one. |
| `flow.conflict` | 409 | "This flow changed while you were editing it." / Version N was saved in the meantime; reload it, then make your change again. `error.context.latest_version` names it. |
| `flow.version_missing` | 404 | "There is no version N of this flow." / Pick a version from its history. |
| `flow.invalid` | 422 | "This flow has problems to fix first." (or "This flow cannot run as drawn.") / Open it in the editor: each problem is marked on its node or connection. `error.context.issues` lists them. A draft with problems can be saved, but not activated, published, tried or routed through. |
| `flow.model_unknown` | 422 | "There is no model called X." / Open the flow and pick a model this workspace has. |
| `flow.model_unready` | 422 | "X needs its key" or "X is switched off" / Add the key or switch it on in Settings → Models, or pick another model for this step. |
| `flow.no_model_ready` | 422 | "None of this flow's models can answer yet." / Add a key in Settings → Models, or choose models you have set up, then turn the flow on. Returned when turning on a flow; the editor shows the same as a warning. |
| `flow.bad_output` | 502 | "<Node> did not answer in the expected shape." / Try a stronger model for this node, or tighten its instructions. A router, manager, judge or loop needs a JSON answer. |
| `flow.node_failed` | 502 | "<Node> failed." / The model's own error. Check its model and settings ("Run only this" in the editor). |
| `flow.retrieve_unavailable` | 422 / 502 | "This chat has no notebook to search", "Source search is not running" or "Searching your sources failed" / A Retrieve step searches a notebook's sources. Move the chat into a notebook, start the knowledge service, or remove the step. It no longer passes on an empty result. |
| `flow.factcheck_unavailable` | 422 | "<Node> cannot check facts here" / Fact-checking needs the knowledge service and a notebook with sources. A check that runs but cannot decide takes the "unsure" route instead of passing. |
| `flow.human_timeout` | 408 | "Nobody answered the question in time" / Send the message again and answer when asked, or remove the Human step. It no longer passes "Nobody answered" on as if it were your answer. |
| `flow.failed` | 500 | "The flow could not finish." / Check the node that failed in the teamwork view. |

These are not errors but endings, written into the answer instead: `flow.budget` (the flow reached its cost cap for one message), `flow.steps` (it reached its step limit) and `flow.timeout` (it ran longer than its time limit). The answer keeps what was produced and says which limit to raise in the flow's settings. When trying a message, a Tool or Human node is skipped and a `flow.try_paused` warning says so.

Validation issues (shown in the editor, not as HTTP errors): `flow.no_input`, `flow.no_output`, `flow.many_inputs`, `flow.many_outputs`, `flow.cycle`, `flow.no_path`, `flow.duplicate_id`, `flow.edge_dangling`, `flow.unreachable`, `flow.dead_end`, `flow.route_mismatch`, `flow.route_unconnected`, `flow.route_unused`, `flow.model_unknown`, `flow.model_unready`, `flow.no_model_ready`, `flow.gpu_node`, `flow.gpu_no_fallback`, `flow.manager_alone`, `flow.judge_missing`, `flow.tool_unknown`, `flow.tool_args`, `flow.subflow_missing`, `flow.subflow_self`, `flow.loop_body`, `flow.loop_uncapped`, `flow.factcheck_unsure`, `flow.context_too_big`, `flow.secret_in_prompt`, `flow.pinned_published`.


### Compute (Controller)

| Code | HTTP | Title / hint |
|---|---|---|
| `compute.node_waking` | 503 | "Your GPU node is waking up." / Wait about N s, or use a cloud model. |
| `compute.node_stopped` | 409 | "Your GPU node is stopped." / Start node to wake it (usually a minute or two), then try again. Shown on the answer, with a Start node button, when the thread's model runs on a stopped node and no route can answer meanwhile. While a woken node's server is still loading its model, the Controller answers `node_waking` with `phase: "loading"`, never the proxy's own 502 or 404 page. |
| `compute.cost_cap` | 402 | "This month's compute cap is reached." / Raise it in Admin → Compute → Rules, or use cloud models. |
| `compute.no_capacity` | 502 | "RunPod has no capacity for this GPU here." / Try another region with your volume's datacentre, or another GPU type. |
| `compute.invalid_transition` | 409 | "The node can't <action> while <state>." / Wait for the current operation to finish. |
| `compute.provider_auth` | 502 | "RunPod rejected the API key." / Update RUNPOD_API_KEY with pod read/write scope. |
| `provider.auth` | 422 | "RunPod did not accept that key." / RunPod's own reason. Only RunPod answering and refusing the key; Core then stops offering that key until it changes, and Compute leads to Settings → API keys. |
| `provider.unreachable` | 503 | "RunPod could not be reached." / Connecting a key while RunPod (or the network) does not answer. Not a refusal: Core keeps the saved key, Compute says so, and it is tried again each minute. |
| `compute.controller_unreachable` | 503 | "The Controller isn't responding." / Node models are queued; see Health and docs/runbooks/service-down.md. |
| `compute.unavailable` | 503 | "The Controller is not answering." / It starts with NVX Ancile; check "Controller" in Admin → Health. |
| `compute.not_configured` | 503 | "Remote compute is not set up." / Set `CONTROLLER_URL` and `CONTROLLER_TOKEN` in .env, then restart. |
| `node.not_found` | 404 | "No such node." / Refresh the node list. |
| `node.needs_token` | 422 | "The Controller has no node key to give the new node." / Set CONTROLLER_NODE_TOKEN in .env, restart the Controller, then create the node again. |
| `provider.cannot_create` | 501 | "The <provider> provider cannot create nodes." / Create the machine yourself, then add it by its id or address. |
| `node.busy` | 409 | "This node has an operation in progress." / Wait for it to confirm or time out, then remove the node. |
| `provider.manual_node` | 422 | "<Machine> is a machine on your network; NVX Ancile cannot <action> it." / Turn it on and start Ollama or vLLM on it; NVX Ancile notices within a minute. |
| `provider.<code>` (adding a node) | 422 | RunPod's own words (`not_found`, `auth`, `capacity_unavailable`, `billing`…) / The matching fix, e.g. "Create a key with pod read/write scope and set RUNPOD_API_KEY." |
| `operation.idempotency_conflict` | 409 | "That idempotency key was already used for a different action." / Generate a new key for each distinct request. |

Node actions never fail with an HTTP error once accepted: they answer 202, and a failure lands on the operation as `{code, provider_message, suggestion}` (codes: `capacity_unavailable`, `billing`, `volume_busy`, `auth`, `not_found`, `invalid_state`, `rate_limited`, `provider_unavailable`, `unreachable`, `manual_node`, `node_terminated`, `operation_in_progress`, `node_error`). The Cockpit shows the provider's message under the failed link of the confirmation chain, with the suggestion.

### Maintenance

| Code | HTTP | Title / hint |
|---|---|---|
| `maintenance.busy` | 409 | "Storage can't be tidied while something is running" / A run is in progress; wait for it to finish, or stop it, then try again. Also "NVX Ancile was used a moment ago" (the Tidy storage automation waits for 10 quiet minutes, then tries again at its next time), "A run started while the backup was being taken" (nothing was changed; the backup is kept) and, from the knowledge service, sources still being read or the embedding model being changed. Nothing is changed in any case. |

Tidy storage also ends with `system.disk_full` (checked before the backup) or `system.backup_failed` (nothing is removed without a backup), documented below.

### System

| Code | HTTP | Title / hint |
|---|---|---|
| `system.boot_test_failed` | none | (At boot only.) Names the test and its remediation. |
| `system.service_down` | 503 | "<Service> is down." / Ancile is restarting it; if it keeps failing, see the runbook. |
| `system.disk_low` | 507 | "Disk space is low." / Free space or move ANCILE_DATA_DIR. |
| `system.disk_full` | 507 | "Not enough free disk space: needs ~X, Y free on drive Z" (on macOS and Linux, "on the disk holding <folder>") / Free some space there (empty the Recycle Bin, Bin or trash, remove large downloads), then try again. Nothing was changed. Checked before a backup, before a migration, and before a source is added; `error.context` has `need_bytes`, `free_bytes`, `drive` and `for`. The need includes 256 MB kept free for the database. |
| `system.database_newer` | 409 | "Your data was updated by NVX Ancile <version>, which this version cannot read." / Restore the backup taken before that update, or install that version again. Nothing has been changed. Core never runs a migration backwards: it stops and shows the start-up screen. `error.context` has `expected`, `newer`, `newer_by` and `restore` (the suggested backup). The desktop preflight exits with code 3. |
| `system.backup_failed` | 503 | "The database could not be backed up." with pg_dump's words / Your data was not changed. Try again, or continue without a backup if you keep your own copy. When pg_dump is missing: set `ANCILE_PG_BIN` to the folder holding it. No migration runs without a backup unless the database is empty. |
| `system.migration_failed` | 500 | "The database update did not finish, so it was undone." with the file and the reason / Your data is as it was before the update. Try again; if it fails again, copy the debug info and report it. Each migration is one transaction. |
| `system.restore_failed` | 500 | "The backup could not be restored." / Names the safety backup of the data as it was before the restore, and docs/runbooks/restore-backup.md. |
| `system.backup_not_found` | 404 | "There is no backup by that name." / Pick one from the list of backups. |
| `system.restoring` | 503 | "Restoring your backup." / This can take a while for a large backup. If NVX Ancile is closed, it carries on the next time it starts. Every route answers this while a restore chosen in setup is applied; the start-up screen shows its steps. |
| `system.restore_not_staged` | 409 | "No restore is waiting." / Choose a backup first, then restart to restore it. |
| `system.restore_in_progress` | 409 | "A restore is already under way." / Wait for it to finish. It carries on by itself if NVX Ancile is restarted. |
| `system.restart_needed` | 503 | "The backup was restored." / NVX Ancile is starting again (desktop), or restart it with `pnpm start`. Every route answers this until Core restarts. |
| `desktop.critical_in_app` | 403 | "A critical request can only be answered in NVX Ancile." / Open the request in the app to read what it will do, then decide there. A notification button (Pro) never answers a critical request, and Core refuses one even if Pro were asked. |
| `desktop.already_answered` | 409 | "That request was already answered." / Nothing more to do. A button on a notification (Pro) found the request answered elsewhere. |
| `internal.bug` | 500 | "Something went wrong inside Ancile." / Copy debug info and report it; the trace has the details. |
| `health.cannot_restart` | 422 | "<Service> can't be restarted from here." / Start NVX Ancile with `pnpm start` (or set ANCILE_RESTART_ADAPTER), or follow the service's fix. |

### Operations (logs, replay, automations, licence)

| Code | HTTP | Title / hint |
|---|---|---|
| `replay.not_rerunnable` | 422 | "Only an answer in a thread can be re-run." / Open a chat answer's run and choose Re-run there. |
| `replay.run_active` | 409 | "That run has not finished yet." / Wait for it to finish, or stop it, then re-run it. |
| `replay.bad_step` | 422 | "There is no step N in that run." / Pick a step from the replay. |
| `automation.event_driven` | 422 | "<Automation> runs as part of another feature." / It has no schedule to change; switch it off or change its settings instead. Raised for a schedule sent to an event-driven job. |
| `automation.no_test` | 422 | "<Automation> has no test." / Run it now instead, and read what it did on its card. Only Back up memory has one (Test push). |
| `automation.busy` | 409 | "It is running already." / Wait for it to finish. |
| `automation.bad_schedule` | 422 | "That schedule can't be used." / A schedule has five fields: minute, hour, day of month, month and weekday, for example "0 9 * * 1-5". `error.context` has `cron` and `problem` (what is wrong, or that it never comes round). |
| `automation.too_often` | 422 | "That schedule runs more often than every 5 minutes." / Pick a schedule with at least 5 minutes between runs. |
| `automation.not_set_up` | 422 | "<Automation> is not set up." / What it needs, for example a git remote for memory backups. Run now and switching it on are refused, and the schedule waits, until it is set up; meanwhile it reads as off. |
| `automation.no_default` | 422 | "Only built-in automations have a default." / Edit this one instead, or delete it. |
| `automation.builtin` | 422 | "<Automation> is built in and can't be deleted." / Switch it off instead, or reset it to default. |
| `license.unreachable` | 503 | "nvx.sh could not be reached." / Check your connection; once Pro is on, it keeps working offline until its token expires. |
| `license.rejected` | 422 | nvx.sh's own words / Check the key (NVX-XXXX-XXXX-XXXX) in your NVX purchase email. |
| `license.invalid` | 422 | Why the token did not unlock anything: not a token from nvx.sh, issued for another computer, signed by a key this version does not know, for another NVX product, or expired / Turn Pro on here with your key, or update NVX Ancile. In the free build, anything but a key: "Enter your licence key here." / Copy the key (NVX-XXXX-XXXX-XXXX) from your nvx.sh account. Pro then arrives as an update. |
| `license.free_build` | 422 | No longer used: the free build takes a key, and Pro arrives as an update (docs/desktop.md). |
| `license.seat_taken` | 409 | "This key is already on as many computers as it allows." / Choose Move it here; the one used least recently goes back to the free edition. `error.context` has `devices` and `max_devices`. |
| `license.transfer_limit` | 409 | "This key has moved too many times recently." / Wait a few days, or ask nvx.sh support to move it. |
| `license.not_found` | 404 | "There is no licence with that key." / Copy the key again from your NVX purchase email, or ask support@nvx.sh. |
| `license.paused` | 410 | "This licence is paused." / Contact NVX support (support@nvx.sh) to resume it. A paused licence keeps its key; Pro comes back when it is resumed. |
| `license.expired` | 410 | "This licence has ended." / Renew it from the link in your NVX receipt email, then check again. |
| `license.revoked` | 410 | "This licence was revoked." / Contact nvx.sh support. The key is forgotten on this computer. |
| `license.released` | 410 | "This computer was released from the licence." / Turn Pro on again with your key to take a seat here. The key is forgotten on this computer. |
| `license.bad_token` | 401 | "nvx.sh did not accept this licence." / Enter your key again in Admin → Licence. The token is cleared; the key, if held, is kept. |
| `license.rate_limited` | 429 | "Too many tries just now." / Wait a minute, then try again. |
| `pro.feature_required` | 402 | "<Feature> is part of NVX Ancile Pro." / Turn on Pro in Admin → Licence. Everything else keeps working on the free edition. `error.context.feature` names it. Also returned when the free edition already has one GPU node and another is added (GPU fleet). The desktop extras (feature `desktop`) answer it too: choosing the Beta update channel, going back to the previous version, and Approve or Deny on a notification. |
| `pro.core_too_old` | 501 | "This part of Pro needs a newer NVX Ancile." / Update NVX Ancile, then try again. Pro is newer than the Core it runs in. |
| `pro.seat_required` | 403 | "<Feature> needs a Pro seat." / Pro is on in this workspace, but your account has no Pro seat. Ask the workspace's owner for one in Admin → Team. A team member the owner has not given a seat is a free member; the licence's `member_seats` sets how many there are (the owner alone without it). `error.context.feature` names it. Also returned for a second GPU node. |
| `pro.bad_request` | 400 | "“<field>” is required" (or must be text, a number, one of…) / Check the request and send it again. `error.context.field` names it. Pro's own checks use it too, with their own words (an email, an address). |
| `pro.not_found` | 404 | "<Thing> is not there." / Refresh the page. |
| `pro.not_started` | 503 | "Pro is still starting." / Try again in a moment. |
| `pro.search_name_taken` | 409 | "There is already a saved search called “<name>”." / Pick another name, or rename the other one first. Names are compared without regard to capitals, per person. |
| `pro.search_limit` | 409 | "You can keep 50 saved searches." / Delete one you no longer use, then save this one. |
| `pro.search_slow` | 503 | "Searching every branch took too long." / Use longer words, or find in this branch only. Raised by Pro's "All branches" in the find bar after 6 seconds. Pro's Ctrl+K search never raises it: a kind of result that runs out of time is named in the answer (`incomplete`) and the rest still arrive. |
| `beam.members` | 400 | "Pick between 2 and 6 models or flows" (or "The same pick is in there twice") / Beam asks several at once, so it needs at least two, each once. |
| `beam.not_ready` | 422 | "<Model> cannot answer." / Add its key or switch it on in Settings → Models, or pick another. Nothing was asked. |
| `beam.no_fuser` | 422 | "No model can fuse the answers." / Add a key in Settings → Models, or turn fusing off. |
| `beam.busy` | 409 | "An answer is still being written here." / Wait for it to finish, or stop it, then ask again. |
| `beam.not_a_question` | 422 | "Only a question can be beamed." / Pick the message you asked. Raised when Beam this question names an answer, not a question. |
| `steer.not_running` | 409 | "No answer is being written here." / The turn has ended, so the message sends as a normal one. Raised by Pro's steer mode when a note is offered after the turn ended. |
| `steer.not_supported` | 409 | "A flow cannot take a note while it runs" (or "This model cannot take a note while it works", for Claude Code) / The message waits and sends when this turn ends. |
| `steer.branch_changed` | 409 | "You moved to another branch." / A note goes only to the answer it was written for. Send the message here as a new one instead. |
| `steer.too_many` | 409 | "Up to 3 notes can wait for the next step." / Wait for the model to take them, or remove one. |
| `steer.too_long` | 422 | "A note can be up to 4,000 characters." / Shorten it, or send it as a message when the turn ends. |
| `export.nothing` | 422 | "There is nothing to export yet." / Send a message in this thread first, then export it. Raised by Pro's Word and PDF export. |
| `export.branch_missing` | 404 | "That branch is not in this thread." / Open the thread again and choose a branch from the list. |
| `export.same_branch` | 422 | "Choose a different branch to compare with." / A branch compared with itself shows nothing new. |
| `export.too_large` | 413 | "This thread is too long to export as one file" (or "This file would be too large") / Export a shorter branch, turn off the evidence appendix or tool steps, or use the Markdown export, which has no size limit. A Word or PDF file is up to 24 MB. |
| `smart_sections.not_found` | 404 | "That section no longer exists." / Reload the rail to see the sections you have. Sections are per person: another person's id is also not found. |
| `smart_sections.name_taken` | 409 | "You already have a section called <name>." / Pick a different name, or edit the one you have. Names compare without regard to case. |
| `smart_sections.limit` | 409 | "You can keep 30 smart sections." / Delete one you no longer use, then save this again. |
| `smart_sections.bad_filter` | 400 | "“<field>” …" (or "Add at least one condition") / Fix that part of the filter and save it again. `error.context.field` names it. A section with no condition would list every thread, so it is refused. |
| `flowlab.empty_set` | 422 | "This test set has no questions yet." / Add answers from your threads, or write questions, then run it. |
| `flowlab.not_ready` | 422 | "<Model> cannot answer." / Add its key in Settings → Models, or run with stand-in models. |
| `sync.unavailable` | 501 | "This build cannot sync." / Update NVX Ancile, then try again. |
| `sync.not_set_up` | 409 | "Sync is not set up on this computer." / Set it up in Settings → Sync. Also returned when approving a computer from one that does not sync. |
| `sync.weak_passphrase` | 400 | "Use a passphrase of at least 10 characters." / It protects everything you sync, and nvx.sh cannot recover it. A few words you will remember works well. |
| `sync.account_exists` | 409 | "Sync is already set up for your licence." / Join it with your passphrase, or with a code from a computer that already syncs. |
| `sync.no_account` | 404 | "Sync is not set up yet." / Set it up on your first computer, then join here. |
| `sync.wrong_passphrase` | 401 | "That passphrase does not open your sync." / Check it and try again, or join with a code from a computer that already syncs. Only known once a computer that syncs has approved this one (the relay shows the passphrase check to approved computers only); until then the join waits. |
| `sync.bad_code` | 400 | "That code does not work." / Codes work once, for ten minutes. Make a new one. |
| `sync.pairing_gone` | 404 | "That code has been used or has expired." / Make a new one on a computer that syncs (Settings → Sync → Add a computer). A code with a wrong secret answers this too, and is used up. |
| `sync.no_licence` | 402 | "Sync needs Pro turned on here." / Turn Pro on in Admin → Licence on this computer, then set up sync. |
| `sync.offline` | 503 | "The sync relay could not be reached." / Sync carries on when the connection is back. Nothing is lost: changes wait here. |
| `sync.licence_invalid` | 401 | "Sync does not accept the Pro licence on this computer." / Turn Pro on again in Admin → Licence. Sync starts again by itself once it is active; nothing is tried until the licence token changes. |
| `sync.licence_lapsed` | 402 | From the relay: the licence has lapsed. / Renew Pro. Changes keep downloading and nothing uploads, except taking back what a scope keeps on a computer. Shown in Settings → Sync, not as an error. |
| `sync.device_pending` | 403 | From the relay: "This computer is waiting to be approved." / Approve it on a computer that syncs (Settings → Sync), or join with a code. With no computer left that syncs, contact NVX support (support@nvx.sh) to approve it. A waiting computer reads nothing, not even the passphrase check. |
| `sync.device_unknown` | 401 | From the relay: "This computer is not registered for sync." / A computer that syncs declined or removed it. Settings → Sync says so: ask again, or join with a code. |
| `sync.too_many_pending` | 429 | From the relay: "Too many computers are waiting to be approved." / Approve or decline them on a computer that syncs. A request waits a day at most. |
| `sync.device_exists` | 409 | From the relay: the device id is registered with another key. / Nothing to do: the computer takes a new id and asks again by itself. |
| `sync.bad_signature` | 401 | From the relay: the request is not signed by its device, or this computer's clock is more than five minutes out. / Check the clock, then try again. |
| `sync.too_large`, `sync.quota`, `sync.blob_missing`, `sync.rate_limited` | 413, 413, 404, 429 | From the relay, with its own words. / Sync tries again shortly; see pro/docs/sync-server-brief.md for its limits. Any other relay refusal is `sync.relay_<status>`. |
| `auth.sign_in_required` | 401 | "Sign in to this workspace first." / This workspace has a team: sign in with your account or your identity provider. Never returned by a single-person install. |
| `auth.role_too_low` | 403 | "Your role in this workspace cannot do that." / Ask the workspace's owner or an admin. Viewers read; members write; admins manage people and settings. `error.context.need` names the role. |
| `auth.sign_in_failed` | 401 | "That email and passphrase do not match." / Check both, or ask an admin to send you a new invitation. Changing your passphrase: "Your current passphrase is not right." |
| `auth.too_many_tries` | 429 | "Too many tries just now." / Wait N seconds, then try again. After 5 failures for one email (signing in, a reset link, a recovery code) or one account (changing a passphrase): a wait of 1 minute, doubling, at most 15. |
| `auth.weak_passphrase` | 400 | "Use a passphrase of at least 10 characters." / A few words you will remember works well. |
| `auth.recovery_failed` | 401 | "That email and recovery code do not match." / Check both. A recovery code works once, for an owner. |
| `auth.oidc_unreachable` | 502 | "Your identity provider did not answer." / Check the issuer address in Admin → Team. |
| `auth.oidc_state` | 400 | "That sign-in took too long or was used already." / Start signing in again. |
| `team.not_on` | 409 | "This workspace has no team yet." / The owner can turn one on in Admin → Team. |
| `team.already_on` | 409 | "This workspace already has a team." / Manage it in Admin → Team. |
| `team.last_owner` | 409 | "A team needs at least one owner." / Make someone else an owner first. |
| `team.already_member` | 409 | "<email> is already in the team." / Change their role instead (or withdraw the invitation, when resending one). |
| `team.already_invited` | 409 | "<email> already has an invitation waiting." / Resend it from the list, or withdraw it first. One invitation waits per email. |
| `team.invite_gone` | 410 | "That invitation has been used or has expired." / Ask an admin to send a new one. A resent or withdrawn invitation's old link answers this too. |
| `team.reset_gone` | 410 | "That reset link has been used, has expired or is for another email." / Check the email, or ask an admin for a new link. A reset link works once, for 24 hours; a newer one replaces it. |
| `team.address_not_allowed` | 400 | "NVX Ancile does not accept changes from <address>." / Set ANCILE_PUBLIC_URL to it, or add it to ANCILE_ALLOWED_ORIGINS, where NVX Ancile starts; restart, then save it here. People could open a link there but not join. `error.context.allowed` lists the addresses it does accept. Signing in through an identity provider from such an address says to open NVX Ancile from its own address. |
| `team.oidc_off` | 409 | "Sign-in through an identity provider is not set up." / An admin can set it up in Admin → Team. |
| `team.no_seat_free` | 409 | "Every Pro seat is taken." / Take a seat from someone first, or contact NVX support (support@nvx.sh) to add people to your licence. |
| `team.owner_seat` | 409 | "The workspace's owner always has a Pro seat." / Give or take seats from other people. |

The MCP endpoint (`/mcp`) answers 401 with a JSON-RPC error when the bearer token is missing, unknown or disconnected. A tool an app has no grant for answers with `isError` and the way to allow it (Admin → Plugins).

The lab's MCP endpoint (`/mcp/lab`) answers 401 with a JSON-RPC error unless the bearer token is the lab's gateway token (`AGENT_GATEWAY_TOKEN`). A call the gate denies answers `isError` with "Not allowed: …"; a call that needs a person and has no approval yet answers `isError` and asks the lab to try again (the approval appears in NVX Ancile when the lab uses the tool).

### Engines

Choosing an engine for a turn (docs/engines.md) refuses with the scope's own codes (see Scopes above: `scope.private_notebook`, `scope.data_stays_local`, `scope.engine_not_allowed`, `scope.model_not_allowed`), as HTTP 403, before anything is written. The title is the scope's reason; the hint is "Pick another model, or change what this notebook or thread allows in its scope settings."

Claude Code as a model fails like any model (`provider.unavailable`, then a fallback when the chain has one): "Claude Code could not answer", or "The Claude bridge stopped".

### Credentials {#credentials}

Settings → API keys (`/api/v1/credentials`). A value is never echoed in an error: anything a provider says back is scrubbed of it first.

| Code | HTTP | Title / hint |
|---|---|---|
| `credentials.unknown` | 404 | "There is no key by that name." / Pick one from Settings → API keys. |
| `credentials.from_environment` | 409 | "<Name> is set in the environment." / Change or remove <VARIABLE> where NVX Ancile is started, then restart it. |
| `credentials.rejected` | 502 | "<Service> rejected the token." / Check you copied all of it and that it is still active, or make a new one at <where>. Nothing was saved. |
| `credentials.check_failed` | 502 | "Couldn't reach <service> to check it." / Check your connection, then try again. Nothing was saved. |
| `credentials.invalid` | 400 | "That doesn't look like a git remote." / Use an address git can push to, such as git@github.com:you/memory.git. For a key checked by its shape only (TypeSafe): "That doesn't look like a <Name> key." / Paste the whole key, with no spaces. |
| `credentials.unavailable` | 503 | "Compute is not set up here." / RunPod is managed by the Controller. Start NVX Ancile with CONTROLLER_URL set, then add the key. |

Model provider keys fail with `provider.auth_failed` or `provider.unavailable`, as in setup; a RunPod key with the Controller's own codes (`compute.provider_auth`, `provider.auth`).

### Repositories and GitHub

| Code | HTTP | Title / hint |
|---|---|---|
| `repo.not_a_repo` | 400 | "That folder is not a git repository." / Choose the folder you cloned (the one with a .git folder), or run `git init` in it first. |
| `repo.not_found` | 404 | "There is no repository called X." / Add the folder in the Repo panel first, or check the name. |
| `repo.not_linked` | 400 | "Which repository?" / Link this thread to one, or name it (the tools list the names). |
| `repo.unavailable` | 409 | "That repository cannot be read now." / The folder may have moved or been deleted. Remove it and add it again. |
| `repo.git_missing` | 503 | "Git is not installed." / Install git from git-scm.com, then try again. |
| `repo.git_timeout` | 504 | "Git took too long." / A pull or push may be waiting on the network or a password. Try it in a terminal to see why. |
| `repo.git_failed` | 409 | "git <command> failed." with git's own words / The fix that matches what git said: sign in to the remote, pull first, resolve conflicts, commit or stash, stage something. |
| `repo.bad_ref` | 400 | "X is not a branch name git accepts." / Use letters, numbers, dashes, dots and slashes, like feature/login-fix. Anything that git could read as an option is refused. |
| `repo.bad_path` | 400 | "That path is not inside the repository." / Give a path relative to the repository root. |
| `repo.detached` | 409 | "There is no branch to push." / Switch to a branch (or create one) first. |
| `repo.not_github` | 409 | "This repository is not on GitHub." / Its origin remote is not a github.com address. |
| `repo.github_unavailable` | 401 | "NVX Ancile is not connected to GitHub." / Sign in with `gh auth login` (NVX Ancile uses that), or save a fine-grained token in the Repo panel (GitHub). |
| `repo.github_failed` | 502 | "GitHub refused to <do that>." with GitHub's words / `gh auth refresh -s repo,workflow`, or a token with those permissions. |
| `mcp.github_runner_missing` | 409 | "Nothing can run the GitHub MCP server here." / Install Docker, or put github-mcp-server on your PATH. |
| `mcp.unavailable` | 503 | "MCP servers are not available here." / Restart NVX Ancile and try again. |
| `mcp.not_found` | 404 | "That MCP server was not found." / It may have been removed. Refresh the list in Admin → Plugins. |
| `mcp.tool_not_found` | 404 | "<server> does not offer a tool called <tool>." / Its tools are listed once it is connected. Press Test to reconnect, then try again. |
| `mcp.name_taken` | 409 | "There is already an MCP server called <name>." (or "config/mcp.yaml already has a server called <name>.") / Pick another name, or edit the server you have. |
| `mcp.read_only` | 409 | "<name> comes from config/mcp.yaml." / Edit or remove it in config/mcp.yaml, then restart NVX Ancile. You can still change its tools here. |
| `mcp.secret_missing` | 400 | "No value is stored for <key>." / Type the value for <key>, or take it out of the list. |
| `mcp.tier_not_allowed` | 400 | "<tool> can delete or change things, so it always asks first." / Choose Gated or Critical for this tool. |
| `mcp.transport_mismatch` | 400 | "A command (stdio) server has no <field>." (or a web address (http or sse) one) / The way a server connects cannot change. Remove it and add it again. |
| `mcp.preset_unknown` | 404 | "There is no server preset called <id>." / Pick one from the Add server list, or add a server by hand. |
| `mcp.preset_field` | 400 | "<Field>: this is needed" (or "use a single line") / Fill it in and press Add again. `error.context.field` names it. |
| `mcp.runtime_missing` | 409 | "<name> cannot start on this machine." / It runs with Node.js (npx) or uv (uvx), and that is not installed: install it, then open the list again. |
| `mcp.claude_code_unavailable` | 409 | "NVX Ancile cannot reach Claude Code." / Install Claude Code or check it in Settings, Claude Code. |
| `mcp.claude_code_server_not_found` | 404 | "Claude Code has no server called <name>." / It may have been removed. Refresh the list. |
| `mcp.claude_code_failed` | 502 | "Claude Code did not <show, add or remove> that server." / Its own message is in `error.detail`, with any secret taken out. |
| `mcp.claude_code_exists` | 409 | "Claude Code already has a server called <name>." / Choose another name, or change the one it has. |
| `mcp.not_copyable` | 409 | "<name> cannot be copied to NVX Ancile." / A claude.ai connector is tied to your Claude account; a server that signs in through the browser (OAuth) needs an access token instead; the hint says which. |
| `mcp.needs_values` | 400 | "Claude Code reads <VAR> from its environment, and NVX Ancile does not have a value." / Type a value for each (`error.context.unresolved`), and copy again. They are stored encrypted. |
| `mcp.secret_in_config` | 409 | "A secret sits in the arguments (or address), where it would be stored in plain text." / Move it into an environment variable or a header in Claude Code, then copy again. |
| `mcp.tools_changed` | 403 (gate) | A gate refusal, not an HTTP error: `via: "mcp_changed"`, logged as `policy_deny` with this policy id. "<server> added (or changed) <tool> after you approved its tools." / Review the change in Admin → Plugins before it can run. docs/plugins.md. |
| `mcp.tools_changed_again` | 409 | "<server> changed its tools again." / Look over the new list, then approve it. (`POST /mcp/approvals/:key/approve` with a fingerprint that is no longer current.) |

### Files (the code editor)

| Code | HTTP | Title / hint |
|---|---|---|
| `files.outside_roots` | 403 | "That file is outside the folders NVX Ancile can open." / Open files in the workspace, a repository added in the Repo panel, or a Claude Code project folder. |
| `files.not_found` | 404 | "<name> does not exist." / It may have been moved or deleted since the thread mentioned it. |
| `files.is_folder` | 400 | "<name> is a folder." / Open a file inside it instead. |
| `files.too_large` | 413 | "<name> is too large to open here" (or "to save here"). / Open or save it in your own editor; the limit is 2 MB. |
| `files.read_denied` | 403 | "Reading <name> is not allowed here." / Check this thread's scope, or the policy named in Admin → Decisions. |
| `files.write_denied` | 403 | "Saving <name> is not allowed here." / Check this thread's scope, or the policy named in Admin → Decisions. |
| `files.needs_confirm` | 409 | "Saving <name> needs your confirmation." / Choose "Save anyway" to write it, or cancel. The context carries the tier, the resource and the reason. |
| `files.changed` | 409 | "<name> changed since you opened it." / Reload to see the new version, or keep editing and save again to replace it. |
| `files.no_folder` | 404 | "The folder for <name> does not exist." / Create the folder first, then save again. |
| `files.write_failed` | 500 | "<name> could not be saved." / Check the file is not open read-only elsewhere and the disk has space, then save again. |

### Artifacts and the code interpreter

| Code | HTTP | Title / hint |
|---|---|---|
| `artifact.bad_key` | 400 | "That artifact name isn't valid." / Open the artifact from its answer and change the setting there. |
| `interpreter.no_window` | 503 | "No NVX Ancile window is open to run Python." / Python runs inside an open window, sandboxed. Open one and ask again. (Given to the model as the tool result.) |
| `interpreter.timeout` | 504 | "The Python run did not finish within <n> seconds." / Make the code do less, or ask for a longer limit (up to two minutes). |
| `interpreter.cancelled` | 499 | "The Python run was stopped." / Ask again when you want it run. |
| `interpreter.request_gone` | 410 | "That Python run is no longer waiting." / It finished, timed out or was stopped. Ask for it again if you still need it. |
| `interpreter.claimed` | 409 | "Another window is running this." / Nothing to do: its result appears in every window. |
| `interpreter.bad_args` | 400 | "That python_run call is not valid." / Names the argument and what was expected. |
| `interpreter.file_unknown` | 400 | "No file called <name> is attached to this thread." / Lists the attached files, or says to add the file to the notebook first. |
| `interpreter.files_too_large` | 413 | "<name> is too large to hand to Python." / Up to 20 MB a file and 50 MB in all; use a smaller extract. |
| `interpreter.runtime_unavailable` | 503 | "The Python runtime could not be downloaded." / Check this machine can reach cdn.jsdelivr.net, then run the code again. It is downloaded once. |
| `interpreter.runtime_mismatch` | 502 | "A downloaded Python runtime file did not match its pinned fingerprint." / It was thrown away and nothing ran. Try again later; report it if it keeps happening. |
| `interpreter.file_not_allowed` | 404 | "<file> is not part of the Python runtime." / Only the pinned Pyodide files and the allowed packages are served. |

### Images

| Code | HTTP | Title / hint |
|---|---|---|
| `image.too_large` | 413 | "<name> is too large." / Images can be up to 20 MB (remote ones 10 MB). Use a smaller or more compressed copy. |
| `image.type_not_allowed` | 415 | "<name> is not an image NVX Ancile can show." / Use a PNG, JPEG, WebP or GIF file. SVG is not accepted as an image. |
| `image.not_found` | 404 | "That image doesn't exist." / It may have been deleted with its thread. Attach or make it again. |
| `image.too_many` | 400 | "Up to 8 images can go with one message." / Remove some, or send them over more than one message. |
| `image.model_no_vision` | 422 | "<model> can't see images." / Choose a model that reads images (marked vision in Admin → Models), or send the message without them. |
| `image.no_provider` | 409 | "No image provider is set up." / Add an OpenAI or OpenRouter key in Settings → API keys, or a local Automatic1111 or Forge address in config/images.yaml. (Given to the model as the tool result.) |
| `image.provider_unknown` | 400 | "There is no image provider called <id>." / Lists the providers set up. |
| `image.provider_failed` | 502 (or the provider's status) | "<provider> did not make the image." / What it said; check its key or address, or try another provider. |
| `image.bad_args` | 400 | "That image_generate call is not valid." / Names the argument and what was expected. |
| `image.remote_not_allowed` | 403 | "Images from <host> have not been allowed here." / Choose "Load image" on the image first. The choice is remembered for this notebook. |
| `image.remote_blocked` | 400 | "That image address cannot be loaded." / Why (not http or https, an unusual port, inside your network or this computer); only public addresses are fetched. |
| `image.remote_failed` | 502 | "The image from <host> could not be loaded." / What happened; open the link in your browser instead, if you trust it. |

### Attachments

| Code | HTTP | Title / hint |
|---|---|---|
| `attachment.too_large` | 413 | "<name> is too large to attach." / A file can be up to 25 MB. Attach a smaller copy, or add it to a notebook as a source. |
| `attachment.type_not_allowed` | 415 | "<name> is not a file a message can carry." / Attach a PDF, or a text, code or CSV file. For other files, add them to a notebook as sources. |
| `attachment.unreadable` | 422 | "<name> could not be read as text." / It looks like a binary file. Attach a text copy, or add it to a notebook as a source. |
| `attachment.empty` | 422 | "<name> is empty." / Choose the file again. |
| `attachment.scanned_pdf` | 422 | "This PDF has no text to read." / It looks scanned. Add it to a notebook as a source with OCR on, or attach a copy that has a text layer. |
| `attachment.not_found` | 404 | "An attached file is no longer here." / Files wait an hour for their message, and Core forgets them when it restarts. Attach the file again. |
| `attachment.too_many` | 422 | "Up to 5 files go with one message." / Send this message, then attach the rest to the next. |
| `attachment.claude_code` | 422 | "Claude Code reads files from its folder." / Put the file in the session folder and name its path in your message. |

Scope refusals for images use the scope codes (`scope.private_notebook`, `scope.data_stays_local`) with titles that name what would have left the machine.

### Claude Code

| Code | HTTP | Title / hint |
|---|---|---|
| `claude_code.not_installed` | 409 | "Claude Code is not installed on this computer." / Press Install in Settings → Claude Code, or install it from claude.ai/install and press Check again. |
| `claude_code.off` | 409 | "Claude Code is off: <reason>" / Nothing was read or sent. Claude Code is switched off for the whole Core: `ANCILE_CLAUDE_CODE=off`, which the test profile (`pnpm start:e2e`) always sets so the suite never touches your install, your sessions or your plan. The status carries the reason as `off_reason`. Start the everyday stack (`pnpm start`) to use Claude Code. |
| `claude_code.version_old` | 409 | "Claude Code <version> is older than NVX Ancile supports." / Run `claude update` in a terminal (NVX Ancile needs 2.1.200 or later), then press Check again. |
| `claude_code.signed_out` | 409 | "Claude Code is not signed in." / Press Sign in to open Claude Code's own sign-in, or run `claude auth login` in a terminal. Listing and bringing in sessions does not need sign-in. |
| `claude_code.sdk_unavailable` | 503 | "NVX Ancile cannot read Claude Code sessions yet." with the reason / It needs Anthropic's Agent SDK, fetched from npm the first time. Check this computer can reach registry.npmjs.org, then press Check again. |
| `claude_code.file_blocked` | 503 | "Anthropic's Agent SDK was removed or blocked after it was checked" (or "The Claude bridge …") / Security software may have quarantined it. Allow the folder <data>/claude-bridge/claude-sdk (or the bridge's folder) in your antivirus, then press Check again. `error.context.folder` names the folder. Claude Code itself: the install check fails with "the program at <path> was removed or blocked after it was checked" and the folder to allow; an install that is gone at once names `~/.local/bin`. |
| `claude_code.install_failed` | 502 | "Claude Code could not be installed." with the installer's words / Install it yourself from claude.ai/install (no admin rights needed), then press Check again. |
| `claude_code.unverified` | 409 | "This Claude Code install could not be verified." with the reason / Reinstall Claude Code from claude.ai/install, then press Check again. Sessions are not run through an install that fails the check. |
| `claude_code.sign_in_unavailable` | 409 | "Claude Code's sign-in cannot open from here." / Run `claude auth login` in a terminal on this computer, then press Check again. |
| `claude_code.session_not_found` | 404 | "That Claude Code session is not on this computer." / It may have been deleted or moved. Refresh the list of sessions. |
| `claude_code.folder_excluded` | 409 | "Sessions from that folder are not brought in." / It is in Excluded folders in Settings → Claude Code. Remove it there to bring its sessions in. |
| `claude_code.not_bound` | 409 | "This thread did not come from Claude Code." / Only threads brought in from Claude Code can be synced. |
| `claude_code.cli_failed` | 502 | "Claude Code could not <do that>." with its words / Run the same command in a terminal to see why, then try again. |
| `claude_code.session_busy` | 409 | "This session is open in Claude Code somewhere else." / Close it there (or wait a minute after its last reply), or press Continue as a branch to carry on in a fork of it. |
| `claude_code.branch_unmapped` | 409 | "That message is not part of the Claude Code session." / Send from a message that came from Claude Code, or from the latest message in the thread. Only without the engines module: with it, a parent written by another model goes on from Claude Code's latest message (docs/engines.md). |
| `claude_code.no_folder` | 409 | "This session's folder is not on this computer." / Claude Code runs a session in its own folder. Restore the folder, or start a new session in Claude Code. Only for a thread that never recorded a folder. |
| `claude_code.folder_missing` | 409 | "This session's folder has moved or been deleted." with the folder / Point NVX Ancile to the folder where it is now, or continue without files. Nothing was sent. Checked before every Claude Code turn; the Cockpit offers **Point to new folder** and **Continue without files** (POST /claude-code/threads/:id/folder). |
| `claude_code.live_failed` | 502 | "Claude Code stopped before it answered." with its words / Try again. If it keeps happening, run the same session in a terminal to see why. |
| `claude_code.prompt_too_long` | 502 (run error) | "Claude Code's own setup filled its window." / The conversation is small; the weight is what Claude Code loads itself (for example every connector on the Claude account). Try another model, or turn off connectors in your Claude account. NVX Ancile now starts Claude Code as a model with only its own tools. A Claude Code error is never saved as the answer text. |
| `claude_code.folder_invalid` | 400 | "Give the whole path to the folder", "That folder is not on this computer" or "That is a file, not a folder" / Starting a session (POST /claude-code/threads) needs a full path to a folder that exists on this computer. |
| `claude_code.folder_out_of_scope` | 403 | "That folder is outside what this notebook allows." / Choose a folder inside the notebook's allowed folders (its scope's `folders`), or add the folder to them. |
| `claude_code.plan_limit` | 429 (run error) | "Claude Code limit reached, resets at 14:00" (local time; "resets Mon 09:00" when not today; no time when none is known) / Finish on another model, or wait for the limit to reset. What Claude Code wrote so far is kept. A turn stopped by the plan's limit: a rejected `rate_limit_event`, or Claude Code's own "limit reached" result. The run's `error` event and the answer's `provenance.error` carry `resets_at`; the Cockpit offers **Finish on another model**. |
| `claude_code.not_live` | 409 | "Nothing is running in this Claude Code thread." / There is nothing to stop. |
| `claude_code.recovered` | (warning) | A run event, not an error: NVX Ancile restarted during a turn; what Claude Code wrote was brought in from its session. |
