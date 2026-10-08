# NVX Ancile · Knowledge (Python 3.12, uv)
# Build from the repo root: docker build -f infra/docker/knowledge.Dockerfile .
# Includes the local embedder and extractors; add --build-arg EXTRAS=embed,extract,docling
# for layout-heavy PDFs (pulls torch, much larger image).

FROM python:3.12-slim AS build
ARG EXTRAS=embed,extract,boot
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY services/knowledge/pyproject.toml services/knowledge/uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev --no-install-project $(echo ",$EXTRAS" | sed 's/,/ --extra /g')
COPY services/knowledge/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev $(echo ",$EXTRAS" | sed 's/,/ --extra /g')

FROM python:3.12-slim AS runtime
RUN groupadd --system ancile && useradd --system --gid ancile --home /app ancile \
 && mkdir -p /data && chown ancile:ancile /data
WORKDIR /app
COPY --from=build --chown=ancile:ancile /app /app
COPY --chown=ancile:ancile prompts /app/prompts
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 ANCILE_DATA_DIR=/data KNOWLEDGE_MODEL_CACHE=/data/models
USER ancile
EXPOSE 7710
# Migrate, run the boot suite (blocks on failure), then serve.
# ANCILE_BOOT_TESTS=strict (default) refuses to serve when a boot check fails.
CMD ["sh", "-c", "alembic upgrade head && { ANCILE_BOOT_REQUIRE_DB=1 ANCILE_BOOT_REQUIRE_EMBED=1 pytest -q -m boot tests/boot || [ \"${ANCILE_BOOT_TESTS:-strict}\" != strict ]; } && exec ancile-knowledge"]
