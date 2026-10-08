# Upstream projects

Ancile unifies what two open-source projects do separately and adds what neither does. This page explains the relationship. Each bundled project keeps its own licence file beside its code (`vendor/*/LICENSE`, `services/knowledge/LICENSE.open-notebook`).

## Open Notebook (MIT): adopted and rebuilt

Open Notebook is a NotebookLM-style research tool by Luis Novo: notebooks, sources, notes, insights, transformations, podcasts.

| Open Notebook | In Ancile | Change |
|---|---|---|
| Notebook / Source / Note / Insight / Transformation | Same concepts, same names | Moved from SurrealDB (BSL) to Postgres + pgvector |
| A source in many notebooks | Kept (`notebook_sources`) | |
| Context levels per source (off / insights / full) | Kept | Visible in the "why" view |
| content-core extraction | **Replaced** by pypdfium2 (PDFs, page by page), readability and MarkItDown | Docling added for layout-heavy PDFs |
| Separate vector and full-text search | **Replaced** by hybrid search with reciprocal-rank fusion and a cross-encoder reranker | Contextual chunk blurbs added |
| Citations to sources | Citations to the **exact span**, with highlight and page | Validated after generation |
| Ask: plan, search, answer | Folded into the Conductor's retrieval step and deep research | |
| Podcasts (podcast-creator) | Planned as audio overviews | |
| Single shared password | Workspace-scoped data model, team-ready | |
| No agents, tools or MCP | Full agent runtime, MCP client and server, permissions | |

## Odysseus (AGPL since 9 June 2026): ideas only

Odysseus is a ChatGPT/Claude-style workspace with agents, MCP, deep research and memory. It was relicensed from MIT to AGPL-3.0, so **Ancile contains none of its code**. We work from its public description and behaviour (clean room).

| Odysseus idea | Ancile's version |
|---|---|
| Agent loop with tools and approvals per action/task/session | Three tiers, pattern grants with scopes and expiry, durable pause/resume, decision log |
| MCP client (stdio / SSE / HTTP, OAuth) | Same transports, behind an adapter for the stateless 2026 spec; plus Ancile *as* an MCP server |
| Memory: flat table plus vector store | Typed markdown files in git with capture, reconciliation, supersession and injection budgets |
| Context auto-compaction | Compaction keyed by message, reused across branches |
| Deep research loop with a coverage check | Planned, with an editable plan, budgets, and the report saved as a source |
| Embedding-based tool selection | Planned for large MCP tool sets |
| Prompt-injection guard | Untrusted-content wrapping with a per-request nonce; content can't approve, grant or write memory |
| Model comparison | Branch compare and merge; Beam (Pro) |
| Personas ("crew") and scheduled tasks | Personas and automations, on the roadmap |

Deliberately not carried over: consumer-subscription "providers", because of provider terms of service.

## What neither has

- Conversation trees with compare and merge
- Claim-level fact-checking with an explained confidence score
- Self-healing with breakers and fallback chains
- Durable runs that survive restarts
- Remote GPU lifecycle with confirmation chains and cost rules
- Full trace replay
- A "why did the AI say this?" view on every answer
- One keyboard-first design language
