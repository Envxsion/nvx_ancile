-- ==========================================================================
--  NVX Ancile: database bootstrap
--
--  Runs once, when the Postgres volume is first created
--  (docker-entrypoint-initdb.d). Creates the extensions and one schema per
--  owning service. Tables are created by each service's own migrations:
--    core        services/core       (drizzle)
--    knowledge   services/knowledge  (alembic)
--    controller  services/controller (drizzle / migrations/*.sql)
--  A service never writes another service's schema (DESIGN.md §3).
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector: HNSW embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy title search, palette suggestions

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE SCHEMA IF NOT EXISTS controller;

-- Roles. A single local user owns everything by default, which is right for
-- a single-machine install. For a shared or hosted deployment, give each
-- service its own login role that owns only its schema and can read nothing
-- else, e.g.:
--
--   CREATE ROLE ancile_knowledge LOGIN PASSWORD '…';
--   GRANT USAGE, CREATE ON SCHEMA knowledge TO ancile_knowledge;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge GRANT ALL ON TABLES TO ancile_knowledge;
--
-- and point each service's DATABASE_URL at its own role.

COMMENT ON SCHEMA core IS 'NVX Ancile Core: threads, runs, permissions, memory index, traces';
COMMENT ON SCHEMA knowledge IS 'NVX Ancile Knowledge: sources, chunks, embeddings, insights';
COMMENT ON SCHEMA controller IS 'NVX Ancile Controller: nodes, operations, costs, rules, routes';
