#!/usr/bin/env bash
# Title    | Cloud session setup
# Purpose  | Prepares a Linux cloud session (Claude Code on the web) to build and
#          | test NVX Ancile: the pro submodule, Node and Python dependencies,
#          | and a Postgres with pgvector for the store tests.
# How      | Run first in every session: bash scripts/cloud/setup.sh. The
#          | environment's own setup box only installs tools and Postgres.
# Note     | The desktop installer, WebView2 and live engines are tested locally,
#          | never here. Safe to run twice.
set -uo pipefail
cd "$(dirname "$0")/../.."
S=$(command -v sudo || true)
asPG() { if [ "$(id -u)" = 0 ] && [ -z "$S" ]; then su postgres -c "$*"; else $S -u postgres sh -c "$*"; fi; }

echo "== pro submodule"
git submodule update --init --recursive pro || echo "!! pro did not clone: install the Claude GitHub app on nvx_ancile_pro"

echo "== Commit identity and message hook"
# Commits are the owner's: no co-author trailers, no generator links.
for repo in . pro; do
  [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || continue
  git -C "$repo" config user.name Envxsion
  git -C "$repo" config user.email 74938513+Envxsion@users.noreply.github.com
  hooks=$(git -C "$repo" rev-parse --git-path hooks)
  case "$hooks" in /*) ;; *) hooks="$repo/$hooks" ;; esac
  mkdir -p "$hooks"
  cat > "$hooks/commit-msg" <<'HOOK'
#!/bin/sh
sed -i -E '/^[[:space:]]*Co-Authored-By:/Id; /Generated with \[?Claude/Id; /claude\.(ai|com)/Id' "$1"
HOOK
  chmod +x "$hooks/commit-msg"
done

echo "== Node and pnpm"
corepack enable >/dev/null 2>&1 || npm i -g corepack
corepack prepare pnpm@11.3.0 --activate
pnpm install --frozen-lockfile

echo "== Python (uv)"
command -v uv >/dev/null || pip install --quiet uv
uv sync --project services/knowledge --frozen

echo "== Postgres with pgvector"
PGV=$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1 || true)
if [ -n "$PGV" ] && [ ! -f "/usr/share/postgresql/$PGV/extension/vector.control" ]; then
  ($S apt-get update -qq && $S apt-get install -y -qq "postgresql-$PGV-pgvector") || {
    tmp=$(mktemp -d) && git clone --depth 1 --branch v0.8.1 https://github.com/pgvector/pgvector "$tmp" \
      && make -C "$tmp" && $S make -C "$tmp" install
  }
fi
$S service postgresql start 2>/dev/null || $S pg_ctlcluster "$PGV" main start 2>/dev/null || true
asPG "psql -q" <<'SQL'
do $$ begin create role ancile login superuser password 'ancile'; exception when duplicate_object then null; end $$;
SQL
asPG "createdb -O ancile ancile" 2>/dev/null || true
psql postgres://ancile:ancile@127.0.0.1:5432/ancile -q -f infra/db/init.sql

echo
echo "Ready. Set these in the cloud environment's variables:"
echo "  CORE_TEST_DATABASE_URL=postgres://ancile:ancile@127.0.0.1:5432/ancile"
echo "  PRO_TEST_DATABASE_URL=postgres://ancile:ancile@127.0.0.1:5432/ancile"
