-- MCP servers added in the app (docs/plugins.md). Plain env (stdio) and
-- request headers (http) live here; secret values never do: env_secret_ids
-- lists the secret keys (env vars or headers) and the values sit in
-- core.secrets as mcp.<server id>.<key>, encrypted.

alter table core.mcp_servers add column if not exists env jsonb not null default '{}';
alter table core.mcp_servers add column if not exists headers jsonb not null default '{}';
alter table core.mcp_servers add column if not exists created_at timestamptz not null default now();
alter table core.mcp_servers add column if not exists updated_at timestamptz not null default now();
