-- Anonymous usage statistics (docs/telemetry.md). Nothing is written here
-- until you say yes, and saying no deletes all of it.

-- Envelopes waiting to be sent, oldest first.
create table core.telemetry_queue (
  id bigserial primary key,
  envelope jsonb not null,
  tries integer not null default 0,
  created_at timestamptz not null default now()
);

-- Per-day counters and timing histograms, rolled up into daily_counts and
-- perf once the day is over, then deleted.
--   c:<counter>          a count
--   h:<metric>:<bucket>  how many timings fell in that MS_BUCKETS bucket
--   e:<code>:<status>    an error code seen that day
--   x:<where>:<kind>     an exception kind seen that day
create table core.telemetry_daily (
  day date not null,
  key text not null,
  n bigint not null default 0,
  primary key (day, key)
);
