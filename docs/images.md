# Images

Images are part of a thread like text: you can attach them to a message for a model that can see, models can make them with the image provider you set up, and every image in an answer is shown inline, under the same permissions and scopes as everything else.

Code: `services/core/src/images/`, `apps/cockpit/src/images/`. Shapes: `packages/contracts/src/images.ts`.

## Seeing images in a thread

Every image is shown the same way, wherever it came from: a Markdown image in an answer, an image part (Claude Code's tool results, a message you sent with images), a chart from the code interpreter, or an image a model made.

- Inline, loaded lazily, with its alt text. Select it (or press Enter on it) to open the lightbox: zoom in and out (`+`, `-`, `0` to fit), **Copy image** (as PNG), **Download image**, and **Close** (Escape). The lightbox is a dialog: focus moves into it and back when it closes.
- Images on this computer (stored ones, `data:` and `blob:` addresses) load directly.
- **A remote image is never loaded by itself.** Loading one tells its site that you read the answer, when, and from where: it is a beacon. In its place the thread shows "Loading it would tell <host> you read this" and a **Load image from <host>** button. Your yes is remembered for the notebook (for a thread outside any notebook, for the thread), so later images from that host load straight away.
- After the yes, the image comes through Core, never straight from the site (`GET /threads/:id/images/remote`). The Cockpit's own CSP allows only `'self'`, `data:` and `blob:` images, so no answer can make the page reach another site.
- Where nothing may leave this machine (a private notebook, or `data_leaves_machine` off), remote images are not loaded at all and there is no button: the placeholder says why and offers the link to open yourself.

### What Core fetches for a remote image

- `http` and `https` only, on the usual ports, with no user name or password in the address.
- The host must resolve to a public address: never this computer, your network (10/8, 172.16/12, 192.168/16, 100.64/10), link-local or cloud metadata addresses (169.254/16), or their IPv6 equivalents. Redirects are followed at most three times, and each one is checked again. A host that changes its answer between the check and the request (DNS rebinding) is a residual risk the check narrows but cannot close.
- No cookies, no referrer. At most 10 MB, read as a stream and cut off past it; 15 seconds.
- The bytes must be PNG, JPEG, WebP or GIF, judged from the bytes themselves. SVG is never shown as an image.
- Served with `nosniff` and a sandboxing CSP, so it is data, never a page.

## Attaching images to a message

Paste, drop, or choose **Attach images** (the picture button in the composer) in a thread. Up to 8 images go with one message, 20 MB each, PNG, JPEG, WebP or GIF. Other files still go into the notebook as sources.

- The images are stored as the thread's attachments (`POST /threads/:id/images`) and sent with the turn (`image_ids` on `POST /threads/:id/turns`).
- **The model must be able to see.** A model with `vision` in its capabilities (config/models.yaml, Admin → Models) gets the images as image input. Any other model is refused before anything is written: "<model> can't see images. Choose a model that reads images (marked vision in Admin → Models), or send the message without them." (`image.model_no_vision`).
- **Claude Code** gets them through its own input path: image blocks in the prompt, sent by the Claude bridge.
- **Scopes apply.** An image goes wherever the turn goes, so the turn's engine and model check is the image's check: in a private or local-only notebook, only a model on this computer can be sent images (`scope.private_notebook`, `scope.data_stays_local`).
- Images cannot go to a flow yet: pick one model for that message with `@`.
- If a fallback model without vision answers instead, it is told an image was there ("[Image not shown]"), never handed nothing silently.

## Making images

Models can call `image_generate {prompt, size?, n?, provider?}`. In the composer, `/image <description>` asks the thread's model to make one.

- It is a built-in tool: action `image.generate`, resource the provider's URL (`http:https://api.openai.com/v1/images/generations`, `http:http://127.0.0.1:7860/sdapi/v1/txt2img`). The conductor runs it only after the permission gate allowed the call on its real arguments. Its default tier is **gated** (it can cost money); `config/tools.yaml` (`tools.image.generate`) can change that. The Research tool preset includes it.
- Because the resource is the provider's URL, scopes treat a cloud provider as data leaving the machine and a provider on this computer as loopback. In a private or local-only notebook only a `kind: local` provider can be used; the service checks the provider's kind again itself.
- The images are stored as the thread's attachments with their prompt, model, provider and cost, and shown inline in the step with the prompt and "<model> on <provider> (cloud | this computer | your GPU node) · $0.04".

### Providers (config/images.yaml)

| `api` | What it calls | Key | Cost recorded |
|---|---|---|---|
| `openai` | OpenAI's images API (`gpt-image-1`) | `OPENAI_API_KEY` | `price_usd` per image (an estimate; the API reports tokens) |
| `openrouter` | An OpenRouter image model through chat completions with image output | `OPENROUTER_API_KEY` | What OpenRouter reports (`usage.cost`) |
| `a1111` | An Automatic1111 or Forge server you run, started with `--api` (`/sdapi/v1/txt2img`) | none | Nothing for `kind: local`; a node's time is counted by Compute |

`kind` says where it runs: `cloud`, `local` (this computer) or `node` (a RunPod pod or a machine on your network). NVX Ancile bundles no image model. Cloud providers are ready once their key is saved (Settings → API keys); a local one once its `base_url` is set. With none ready, `GET /images/providers` and `/image` say what to set up in one line: "No image provider is set up: add an OpenAI or OpenRouter key in Settings → API keys, or a local Automatic1111 or Forge address in config/images.yaml."

TODO(phase-5): ComfyUI workflows; an Admin page for image providers.

## Storage

- Each image is stored once by content: `<data>/images/<first two hex>/<sha256>`. The same picture attached twice, or in two threads, is one file. `core.images` (migration 0032) has a row per use: thread, sha256, type, size, width and height, where it came from (`generated`, `attached`, `model_output`), alt text, and for a generated one its prompt, model, provider, kind and cost.
- Limits: 20 MB an image, 8 per message, 4 per `image_generate` call, 10 MB a remote image. Too large: `image.too_large` (413) with the limit.
- Deleting a thread deletes its image rows at once, and every file no other thread still uses.
- TODO(phase-6): exports. Messages name their images by URL; no export carries the image files yet.

## Telemetry

Only closed sets, as feature counts (docs/telemetry.md): `image_generated`, `image_attached`, `image_model_output` (a remote image loaded after a yes), and for a generated image the provider's kind, `image_provider_cloud`, `image_provider_local` or `image_provider_node`. Never a prompt, a host, a model or a size.

API: docs/api.md (Images). Errors: docs/errors.md (Images).
