# Architecture

This page is the short tour of how NVX Ancile fits together: the services, what each one owns, and how a message becomes an answer.

## Four services, three layers

```
Cockpit ──REST/SSE──▶ Core ──▶ Knowledge      (sources, retrieval, evidence)
                       │  └──▶ Controller     (your GPU nodes; optional, separate)
                       └─────▶ model providers (direct)
          everything ──▶ Postgres + pgvector   · memory ──▶ git repo in data/memory
```

- **Cockpit** (`apps/cockpit`) is a single-page app. It talks only to Core, on one origin, so cookies and tracing are simple.
- **Core** (`services/core`) owns intent:
  - what goes into the context
  - which memory is injected
  - which model answers, and what to fall back to
  - whether a tool may run
  - pausing and resuming runs
  - tracing all of the above
- **Knowledge** (`services/knowledge`) owns sources: extraction, chunking, contextual enrichment, embeddings, hybrid search, reranking, deduplication, staleness, and evidence for fact-checks.
- **Controller** (`services/controller`) owns infrastructure: which node serves a model, waking it, queueing while it wakes, cost, and caps. It's a separate deployable with its own contract (`packages/contracts/src/controller.ts`). Ancile works without it.

## Principles that shape the code

1. **Core decides which model; the Controller decides where it runs.**
2. **Every model call goes through Core's Gateway,** including the Knowledge service's calls. So fallbacks, budgets and traces cover every token.
3. **Files are the truth for what a person should own:** memory (git), prompts, config, uploaded originals. Postgres holds state and *derived* indexes that can be rebuilt.
4. **Every external call is wrapped** in timeout, retry, circuit breaker and fallback (`packages/resilience`).
5. **Every run is durable:** each step is committed before the next starts, so a restart resumes instead of losing work.
6. **Every decision is visible:** spans and run steps feed the "why did the AI say this?" view.

## Where to look

| You want to… | Read |
|---|---|
| Understand a chat turn end to end | `services/core/src/conductor/pipeline.ts` |
| Change how permissions decide | [permissions.md](permissions.md), `services/core/src/permissions/` |
| Change memory capture or injection | [memory.md](memory.md), `services/core/src/memory/` |
| Change retrieval | `services/knowledge/ancile_knowledge/search/` |
| Add a compute provider | [compute.md](compute.md), `services/controller/src/providers/` |
| Add a tool, panel or memory backend | [plugins.md](plugins.md) |
| Add an API route | [api.md](api.md), then `packages/contracts/src/api.ts` first |
