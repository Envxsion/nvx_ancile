# Observability

Everything Ancile does leaves a trace you can follow: structured logs, distributed traces, saved run steps, and a "why" view on every answer.

## Trace ids everywhere

The Cockpit starts a W3C trace for each action and sends `traceparent` with the request. Every service continues it, and so does every outbound provider call. Every API response carries `x-trace-id`. Every log line includes it:

```json
{"ts":"2026-10-07T03:12:44.381Z","level":"warn","service":"core","component":"gateway","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","msg":"fallback","from":"anthropic/claude-sonnet-5-5","to":"openai/gpt-5.5","reason":"transient","attempts":3}
```

Spans follow the OpenTelemetry GenAI conventions (model, token usage) plus Ancile attributes: `ancile.run_id`, `ancile.step`, `ancile.memory.commit`, `ancile.permission.outcome`. They're stored in Postgres for the in-app views. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to also export them, for example to Phoenix:

```bash
docker compose --profile observability up -d
# then in .env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces
```

## Why did the AI say this?

Press `w` on any reply. The panel shows:
- **Model:** which one answered, which one you asked for, and every attempt in between with its timing and reason.
- **Memory:** the files, commit and entries that were injected, and their token cost.
- **Sources:** each retrieved excerpt with its search and rerank scores, and whether it was cited.
- **Tools:** each call, and the permission decision that let it run (auto, a grant, your approval) with a link to that grant.
- **Compaction:** whether earlier turns were summarised.
- **Cost:** tokens and dollars.
- **Fact-check:** results, if run.
- A link to **Replay**.

## Replay

Admin → Traces, or **Replay** from the "why" panel, steps through a run one step at a time with a scrubber. At each step you see exactly what the model was sent and what came back.

**Re-run from step N** with a different model or a different memory version. It creates a new run that reuses the recorded tool results, so nothing happens in the world. To re-execute tools, choose that explicitly; permissions apply as usual.

## The log viewer

Admin → Logs:
- **Filters:** level, service, component, trace id, free text, time range.
- **Live tail** streams new lines. It's virtualised, so it stays fast with millions of lines.
- **Export** the current filter as JSON or CSV.
- **Click a trace id** to open the trace waterfall.

## Errors

The interface never shows a stack trace. Every error has:
- a plain title
- what happened, with secrets already removed
- what to do next
- **Copy debug info**, which copies the error, an environment summary, the recent spans and the log lines for that trace

Paste that into an issue and it has everything needed. Error codes are catalogued in [errors.md](errors.md).

## Retention

| Data | Default | Variable |
|---|---|---|
| Logs | 14 days | `ANCILE_LOG_RETENTION_DAYS` |
| Spans | 30 days | `ANCILE_SPAN_RETENTION_DAYS` |
| Run stream events | 7 days after the run ends | `ANCILE_RUN_EVENT_RETENTION_DAYS` |
| Run steps | kept: they're the audit trail | `ANCILE_RUN_RETENTION_DAYS` |

Logs and spans are partitioned by day, so cleanup drops whole partitions and costs nothing.
