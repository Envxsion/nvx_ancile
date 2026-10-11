#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  Load: concurrent streams
 *  Ref      |  ROADMAP Phase 6 ("50 concurrent streams, p95 TTFT
 *           |  overhead under 150 ms above the provider")
 *  ID       |  tests
 * ------------------------------------------------------------------
 *  Purpose  |  Start N answers at once against the offline model and
 *           |  measure, for each, the time from sending to the first
 *           |  word on the stream. The offline model answers its first
 *           |  token at once, so that time IS NVX Ancile's overhead:
 *           |  accepting the message, the durable run, retrieval and
 *           |  the gateway, before any provider latency.
 *  How      |  POST /threads + /threads/:id/messages, then read
 *           |  /runs/:id/stream (SSE) until the first text.delta, and on
 *           |  to the end. Prints p50/p95/p99 and fails over budget.
 *  Note     |  Run against the test profile: `pnpm start:e2e`, then
 *           |  `pnpm test:load` (or LOAD_BASE, LOAD_N, LOAD_BUDGET_MS).
 *           |  The budget is overhead above the provider (ROADMAP
 *           |  Phase 6): the offline model waits LOAD_PROVIDER_MS
 *           |  (default 400, a typical API's first token) before
 *           |  its first word, and overhead is time to first word
 *           |  minus that wait.
 *           |  Messages arrive spread over LOAD_SPREAD_MS (default
 *           |  2000) and each answer streams for a few seconds, so
 *           |  all N are in flight together, as with N people
 *           |  chatting. LOAD_SPREAD_MS=0 sends every message in the
 *           |  same instant (a burst), and LOAD_PROVIDER_MS=0 shows
 *           |  the raw cost with a provider that answers at once.
 *           |  LOAD_WARMUP (default 5) answers run first and are not
 *           |  counted: a freshly started stack (cold connections,
 *           |  caches, JIT) is not what people use for hours.
 * ------------------------------------------------------------------
 */

const BASE = process.env.LOAD_BASE ?? 'http://localhost:7800/api/v1';
const N = Number(process.env.LOAD_N ?? 50);
const BUDGET = Number(process.env.LOAD_BUDGET_MS ?? 150);
const PROVIDER_MS = Number(process.env.LOAD_PROVIDER_MS ?? 400);
const SPREAD_MS = Number(process.env.LOAD_SPREAD_MS ?? 2000);
const WARMUP = Number(process.env.LOAD_WARMUP ?? 5);
// About 100 words at the offline model's typing speed: a few seconds each,
// so the answers overlap.
const WORDS = Array.from({ length: 100 }, (_, w) => `word${w}`).join(' ');

const json = (r) =>
  r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(`${r.status} ${t.slice(0, 200)}`)));

async function one(i, spread = SPREAD_MS) {
  // Arrivals spread evenly over the window, in a shuffled order.
  if (spread) await new Promise((r) => setTimeout(r, ((i * 7919) % N) * (spread / N)));
  const thread = await fetch(`${BASE}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `load ${i}` }),
  }).then(json);
  const t0 = performance.now();
  const sent = await fetch(`${BASE}/threads/${thread.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parent_id: null,
      parts: [
        {
          type: 'text',
          text: `/say answer number ${i} is here ${WORDS}${PROVIDER_MS ? `\n/ttft ${PROVIDER_MS}` : ''}`,
        },
      ],
    }),
  }).then(json);
  const accepted = performance.now() - t0;
  const res = await fetch(`${BASE}/runs/${sent.run_id}/stream`, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ttft = null;
  let done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    if (ttft === null && /"type"\s*:\s*"text\.delta"/.test(buf)) ttft = performance.now() - t0;
    if (
      /"type"\s*:\s*"(run\.(succeeded|failed|completed)|done|message\.completed)"/.test(buf) ||
      /event:\s*end/.test(buf)
    ) {
      done = performance.now() - t0;
      break;
    }
    if (buf.length > 200_000) buf = buf.slice(-20_000);
  }
  await reader.cancel().catch(() => {});
  return { threadId: thread.id, accepted, ttft, done: done ?? performance.now() - t0 };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

if (WARMUP > 0) {
  await Promise.allSettled(Array.from({ length: WARMUP }, (_, i) => one(N + i, 0)));
  console.log(`Warmed up with ${WARMUP} answers (not counted).`);
}

const started = performance.now();
const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => one(i)));
const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
const failed = results.filter((r) => r.status === 'rejected');
const ttfts = ok.map((r) => r.ttft).filter((x) => x !== null);
const fmt = (x) => `${Math.round(x)} ms`;

console.log(
  `\n${N} concurrent streams against ${BASE}, arriving over ${SPREAD_MS} ms, provider first token ${PROVIDER_MS} ms,${((performance.now() - started) / 1000).toFixed(1)} s`,
);
console.log(
  `  finished      ${ok.length}/${N}${failed.length ? `, ${failed.length} failed: ${failed[0].reason?.message}` : ''}`,
);
console.log(
  `  first word    ${ttfts.length} streams  p50 ${fmt(pct(ttfts, 50))}  p95 ${fmt(pct(ttfts, 95))}  p99 ${fmt(pct(ttfts, 99))}`,
);
console.log(
  `  accepted      p50 ${fmt(
    pct(
      ok.map((r) => r.accepted),
      50,
    ),
  )}  p95 ${fmt(
    pct(
      ok.map((r) => r.accepted),
      95,
    ),
  )}`,
);
console.log(
  `  whole answer  p50 ${fmt(
    pct(
      ok.map((r) => r.done),
      50,
    ),
  )}  p95 ${fmt(
    pct(
      ok.map((r) => r.done),
      95,
    ),
  )}`,
);

// Tidy up: the threads are the test profile's, but leave it as it was.
await Promise.all(
  ok.map((r) => fetch(`${BASE}/threads/${r.threadId}`, { method: 'DELETE' }).catch(() => {})),
);

const overheads = ttfts.map((t) => t - PROVIDER_MS);
console.log(
  `  overhead      p50 ${fmt(pct(overheads, 50))}  p95 ${fmt(pct(overheads, 95))}  (first word minus the provider's ${PROVIDER_MS} ms)`,
);
const p95 = pct(overheads, 95);
if (failed.length || ttfts.length < ok.length || p95 > BUDGET) {
  console.log(`\n  over budget: p95 overhead ${fmt(p95)} (budget ${BUDGET} ms), ${failed.length} failed\n`);
  process.exit(1);
}
console.log(`\n  within budget (${BUDGET} ms)\n`);
