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

Keys are encrypted at rest with `ANCILE_SECRET_KEY` and never shown again; to change one, add it again. An added model appears everywhere a model can be chosen: the model picker (`m`), `@model` in the composer, and every Model, Router and Manager node in a flow.

## GPU nodes

A GPU node is a machine the Controller can start and stop. Add one under **Admin → Compute**: a RunPod pod by id (with `RUNPOD_API_KEY` in `.env`), or a machine on your network running Ollama, vLLM or LM Studio (`CONTROLLER_LOCAL_NODES`). Its models are listed as `node/<model>`. If the node serves an OpenAI-compatible API you can reach directly, you can also add it under **Your server**, but then NVX Ancile cannot wake it for you.

When a message needs a node that is stopped, the answer shows **Waking your GPU node** with the start-up chain lighting as it goes; **Use a cloud model instead** answers straight away from the cloud. Rules stop idle nodes and cap spending; see [compute](compute.md).

## Subscriptions are not API keys

Claude Pro or Max and ChatGPT Plus or Pro are subscriptions to the providers' own apps. They are not API credentials, and the providers do not offer them for other apps to call, so NVX Ancile cannot route through them. Use an API key, OpenRouter, or a model you run yourself.

## Which model answers

The most specific choice wins:

1. `@flow` on the message
2. a model picked for the message (`@model`, or **Just the next message** in the model switcher): it answers alone, instead of any flow
3. the thread's flow, or flows turned off for the thread
4. the notebook's flow, then the workspace's flow
5. with no flow: the thread's model, then your default model

A thread's model is the model for plain chat in that thread. It does not override a flow: to use it instead of the notebook's flow, choose **This thread instead of the flow** when you switch. If a thread's model loses its key or is removed, your default answers instead and the Why panel says so.

The Why panel (`w`) names the model that answered, who chose it, the route a flow took, any flow that was set aside, and any fallback. See [flows](flows.md#changing-the-model-while-a-flow-answers).
