-- Settings -> Usage (docs/api.md, Usage): totals by day over answers that
-- recorded usage. Only those rows are indexed, by time, so a week or a month
-- reads a narrow slice however long the history grows.
create index if not exists messages_usage_created on core.messages (created_at) where usage is not null;
