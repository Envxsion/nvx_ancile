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

### Providers and models (Gateway)

| Code | HTTP | Title / hint |
|---|---|---|
| `provider.auth_failed` | 502 | "<Provider> rejected the API key." / Update it in Settings → Models → <Provider>. |
| `provider.unavailable` | 503 | "<Model> is unavailable." / Ancile fell back where it could; check Health for the provider's status. |
| `provider.refused` | 502 | "<Model> declined to answer." / Another model answered if one was available. Rephrase, or pick a model in the switcher. |
| `provider.context_overflow` | 413 | "This conversation is too long for <model>." / Compact it, or switch to a model with a larger window. |
| `model.chain_exhausted` | 503 | "No model could answer." / Each attempt and its reason are listed. Check your keys and Health. |
| `model.not_configured` | 422 | "<Model> isn't set up." / Add a key in Settings → Models. |
| `model.not_chat` | 422 | "<Model> can't answer messages." / It is an embedding or rerank model; pick a chat model in the model switcher. |
| `model.exists` | 409 | "<id> is already in your models." / Edit the one you have, or remove it first. |
| `model.not_custom` | 409 | "<Model> comes from models.yaml." / Only models you added in Settings → Models can be edited or removed; you can still switch it on or off. |
| `model.needs_base_url` | 400 | "An OpenAI-compatible model needs the server address." / Give its base URL ending in /v1, for example https://abc123-8000.proxy.runpod.net/v1. |
| `model.catalogue_failed` | 502 | "Could not list the models <source> offers." / For OpenRouter, check your connection (you can still add a model by its id); for a server, check the address, key, and that it answers GET /models. |

### Permissions

| Code | HTTP | Title / hint |
|---|---|---|
| `permission.policy_denied` | 403 | "A policy blocks this." / Names the policy id; edit it in `config/policies/`. |
| `permission.denied` | 403 | "You declined this action." / (Given to the model as a tool result.) |
| `permission.critical_not_rememberable` | 422 | "Critical actions can't be remembered." / Approve this once instead. |
| `permission.pattern_too_broad` | 422 | "That pattern is wider than this tool allows." / Choose a suggested pattern or a narrower one. Also when the pattern doesn't cover what was asked. |

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
| `memory.repo_corrupt` | 500 | "The memory repository failed its integrity check." / See docs/runbooks/restore-backup.md. |
| `memory.invalid_entry` | 422 | "Some lines couldn't be read as memory entries." / Names the lines; keep one idea per bullet. |

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
| `extract.scanned_pdf` | 422 | "This PDF has no text layer." / It looks scanned. Enable OCR in Settings → Sources, then retry. |
| `extract.pdf_unreadable` | 422 | "This PDF could not be opened." / It may be damaged or password protected; save a fresh copy and add that. |
| `extract.unsupported` | 422 | "This file type cannot be read yet." / Convert it to PDF, DOCX or text and add it again. |
| `extract.engine_missing` | 501 | "The <engine> extractor is not installed." / Install it with `uv sync --extra <extra>`, or use the Docker image. |
| `extract.failed` | 422 | "The text could not be read from this source." / Check the file opens normally; if it does, convert it and add it again. |
| `extract.empty` | 422 | "No text was found in this source." / Check it has readable text; for images or scans, enable OCR. |
| `extract.original_missing` | 422 | "The uploaded file is missing." / Upload the file again. |
| `embed.unavailable` | 503 | "The embedding model is unavailable." / Retry, or change the embedder in Settings. Text search still works meanwhile. |
| `ingest.crashed` | 500 | "Ingestion stopped unexpectedly." / Retry. If it stops again, open Admin → Logs and filter by this source. |

### Fact-checking

| Code | HTTP | Title / hint |
|---|---|---|
| `factcheck.not_answer` | 409 | "Only a finished answer can be fact-checked." / Wait for the answer to finish, then fact-check it. |
| `factcheck.none` | 404 | "This answer has not been fact-checked." / Press F on the answer, or choose Fact-check under it. |
| `factcheck.no_model` | 422 | "No model is ready to fact-check." / Add a provider key in Settings → Models, or start Ancile with the offline test model. |
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
| `flow.failed` | 500 | "The flow could not finish." / Check the node that failed in the teamwork view. |

These are not errors but endings, written into the answer instead: `flow.budget` (the flow reached its cost cap for one message), `flow.steps` (it reached its step limit) and `flow.timeout` (it ran longer than its time limit). The answer keeps what was produced and says which limit to raise in the flow's settings. When trying a message, a Tool or Human node is skipped and a `flow.try_paused` warning says so.

Validation issues (shown in the editor, not as HTTP errors): `flow.no_input`, `flow.no_output`, `flow.many_inputs`, `flow.many_outputs`, `flow.cycle`, `flow.no_path`, `flow.duplicate_id`, `flow.edge_dangling`, `flow.unreachable`, `flow.dead_end`, `flow.route_mismatch`, `flow.route_unconnected`, `flow.route_unused`, `flow.model_unknown`, `flow.model_unready`, `flow.no_model_ready`, `flow.gpu_node`, `flow.gpu_no_fallback`, `flow.manager_alone`, `flow.judge_missing`, `flow.tool_unknown`, `flow.tool_args`, `flow.subflow_missing`, `flow.subflow_self`, `flow.loop_body`, `flow.loop_uncapped`, `flow.factcheck_unsure`, `flow.context_too_big`, `flow.secret_in_prompt`, `flow.pinned_published`.


### Compute (Controller)

| Code | HTTP | Title / hint |
|---|---|---|
| `compute.node_waking` | 503 | "Your GPU node is waking up." / Wait about N s, or use a cloud model. |
| `compute.cost_cap` | 402 | "This month's compute cap is reached." / Raise it in Admin → Compute → Rules, or use cloud models. |
| `compute.no_capacity` | 502 | "RunPod has no capacity for this GPU here." / Try another region with your volume's datacentre, or another GPU type. |
| `compute.invalid_transition` | 409 | "The node can't <action> while <state>." / Wait for the current operation to finish. |
| `compute.provider_auth` | 502 | "RunPod rejected the API key." / Update RUNPOD_API_KEY with pod read/write scope. |
| `compute.controller_unreachable` | 503 | "The Controller isn't responding." / Node models are queued; see Health and docs/runbooks/service-down.md. |
| `compute.unavailable` | 503 | "The Controller is not answering." / It starts with NVX Ancile; check "Controller" in Admin → Health. |
| `compute.not_configured` | 503 | "Remote compute is not set up." / Set `CONTROLLER_URL` and `CONTROLLER_TOKEN` in .env, then restart. |
| `node.not_found` | 404 | "No such node." / Refresh the node list. |
| `provider.cannot_create` | 501 | "The <provider> provider cannot create nodes." / Create the machine yourself, then add it by its id or address. |
| `node.busy` | 409 | "This node has an operation in progress." / Wait for it to confirm or time out, then remove the node. |
| `provider.manual_node` | 422 | "<Machine> is a machine on your network; NVX Ancile cannot <action> it." / Turn it on and start Ollama or vLLM on it; NVX Ancile notices within a minute. |
| `provider.<code>` (adding a node) | 422 | RunPod's own words (`not_found`, `auth`, `capacity_unavailable`, `billing`…) / The matching fix, e.g. "Create a key with pod read/write scope and set RUNPOD_API_KEY." |
| `operation.idempotency_conflict` | 409 | "That idempotency key was already used for a different action." / Generate a new key for each distinct request. |

Node actions never fail with an HTTP error once accepted: they answer 202, and a failure lands on the operation as `{code, provider_message, suggestion}` (codes: `capacity_unavailable`, `billing`, `volume_busy`, `auth`, `not_found`, `invalid_state`, `rate_limited`, `provider_unavailable`, `unreachable`, `manual_node`, `node_terminated`, `operation_in_progress`, `node_error`). The Cockpit shows the provider's message under the failed link of the confirmation chain, with the suggestion.

### System

| Code | HTTP | Title / hint |
|---|---|---|
| `system.boot_test_failed` | none | (At boot only.) Names the test and its remediation. |
| `system.service_down` | 503 | "<Service> is down." / Ancile is restarting it; if it keeps failing, see the runbook. |
| `system.disk_low` | 507 | "Disk space is low." / Free space or move ANCILE_DATA_DIR. |
| `internal.bug` | 500 | "Something went wrong inside Ancile." / Copy debug info and report it; the trace has the details. |
| `health.cannot_restart` | 422 | "<Service> can't be restarted from here." / Start NVX Ancile with `pnpm start` (or set ANCILE_RESTART_ADAPTER), or follow the service's fix. |

### Operations (logs, replay, automations, licence)

| Code | HTTP | Title / hint |
|---|---|---|
| `replay.not_rerunnable` | 422 | "Only an answer in a thread can be re-run." / Open a chat answer's run and choose Re-run there. |
| `replay.run_active` | 409 | "That run has not finished yet." / Wait for it to finish, or stop it, then re-run it. |
| `replay.bad_step` | 422 | "There is no step N in that run." / Pick a step from the replay. |
| `automation.event_driven` | 422 | "<Automation> runs as part of another feature." / It has no schedule to switch off here. |
| `automation.busy` | 409 | "It is running already." / Wait for it to finish. |
| `license.unreachable` | 503 | "nvx.sh could not be reached." / Check your connection; once Pro is on, it keeps working offline until its token expires. |
| `license.rejected` | 422 | nvx.sh's own words / Check the key (NVX-XXXX-XXXX-XXXX) in your nvx.sh account. |
| `license.invalid` | 422 | Why the token did not unlock anything: not a token from nvx.sh, issued for another computer, signed by a key this version does not know, or expired / Turn Pro on here with your key, or update NVX Ancile. |
| `license.free_build` | 422 | "This build has no Pro in it." / Download NVX Ancile from ancile.nvx.sh to use Pro. A clone without `pro/` is the free product. |
| `license.seat_taken` | 409 | "This key is in use on another computer." / Choose Move it here; the other computer goes back to the free edition. `error.context.devices` names it. |
| `license.transfer_limit` | 409 | "This key has moved too many times recently." / Wait a few days, or ask nvx.sh support to move it. |
| `license.not_found` | 404 | "There is no licence with that key." / Copy the key again from your nvx.sh account. |
| `license.paused` | 410 | "This licence is paused." / Resume it in your nvx.sh account. A paused licence keeps its key; Pro comes back when it is resumed. |
| `license.expired` | 410 | "This licence has ended." / Renew it in your nvx.sh account, then check again. |
| `license.revoked` | 410 | "This licence was revoked." / Contact nvx.sh support. The key is forgotten on this computer. |
| `license.rate_limited` | 429 | "Too many tries just now." / Wait a minute, then try again. |
| `pro.feature_required` | 402 | "<Feature> is part of NVX Ancile Pro." / Turn on Pro in Admin → Licence. Everything else keeps working on the free edition. `error.context.feature` names it. Also returned when the free edition already has one GPU node and another is added (GPU fleet). |
| `pro.core_too_old` | 501 | "This part of Pro needs a newer NVX Ancile." / Update NVX Ancile, then try again. Pro is newer than the Core it runs in. |
| `beam.members` | 400 | "Pick between 2 and 6 models or flows" (or "The same pick is in there twice") / Beam asks several at once, so it needs at least two, each once. |
| `beam.not_ready` | 422 | "<Model> cannot answer." / Add its key or switch it on in Settings → Models, or pick another. Nothing was asked. |
| `beam.no_fuser` | 422 | "No model can fuse the answers." / Add a key in Settings → Models, or turn fusing off. |
| `beam.busy` | 409 | "An answer is still being written here." / Wait for it to finish, or stop it, then ask again. |
| `flowlab.empty_set` | 422 | "This test set has no questions yet." / Add answers from your threads, or write questions, then run it. |
| `flowlab.not_ready` | 422 | "<Model> cannot answer." / Add its key in Settings → Models, or run with stand-in models. |
| `auth.sign_in_required` | 401 | "Sign in to this workspace first." / This workspace has a team: sign in with your account or your identity provider. Never returned by a single-person install. |
| `auth.role_too_low` | 403 | "Your role in this workspace cannot do that." / Ask the workspace's owner or an admin. Viewers read; members write; admins manage people and settings. `error.context.need` names the role. |

The MCP endpoint (`/mcp`) answers 401 with a JSON-RPC error when the bearer token is missing, unknown or disconnected. A tool an app has no grant for answers with `isError` and the way to allow it (Admin → Plugins).

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
