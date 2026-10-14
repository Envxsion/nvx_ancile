#!/usr/bin/env bash
# Title    | Cloud session setup
# Purpose  | Prepares a Linux cloud session (Claude Code on the web) to build and
#          | test NVX Ancile: the pro submodule, Node and Python dependencies,
#          | and a Postgres with pgvector for the store tests.
# How      | Set the environment's setup script to: bash scripts/cloud/setup.sh
#          | and its variables to the two TEST URLs printed at the end.
# Note     | The desktop installer, WebView2 and live engines are tested locally,
#          | never here. Safe to run twice.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== pro submodule"
git submodule update --init --recursive pro || echo "!! pro did not clone: install the Claude GitHub app on nvx_ancile_pro"

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
  (sudo apt-get update -qq && sudo apt-get install -y -qq "postgresql-$PGV-pgvector") || {
    tmp=$(mktemp -d) && git clone --depth 1 --branch v0.8.1 https://github.com/pgvector/pgvector "$tmp" \
      && make -C "$tmp" && sudo make -C "$tmp" install
  }
fi
sudo service postgresql start || sudo pg_ctlcluster "$PGV" main start
sudo -u postgres psql -qc "do \$\$ begin create role ancile login superuser password 'ancile'; exception when duplicate_object then null; end \$\$;"
sudo -u postgres psql -qtc "select 1 from pg_database where datname='ancile'" | grep -q 1 || sudo -u postgres createdb -O ancile ancile
psql postgres://ancile:ancile@127.0.0.1:5432/ancile -q -f infra/db/init.sql

echo
echo "Ready. Set these in the cloud environment's variables:"
echo "  CORE_TEST_DATABASE_URL=postgres://ancile:ancile@127.0.0.1:5432/ancile"
echo "  PRO_TEST_DATABASE_URL=postgres://ancile:ancile@127.0.0.1:5432/ancile"
