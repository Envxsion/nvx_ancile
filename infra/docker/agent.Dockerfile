# ------------------------------------------------------------------
#  Title    |  Agent Engine image (lab lane)
#  Ref      |  vendor/opencode, UPSTREAM.md, DESIGN.md §1.2
# ------------------------------------------------------------------
#  Purpose  |  Our opencode fork, compiled to a single binary and run
#           |  headless as `opencode serve`, driven only by Core.
#  How      |  Bun compiles the vendored workspace; the runtime image
#           |  carries git (snapshots/undo), ripgrep (grep tool) and
#           |  the binary, as a non-root user confined to /workspace.
#  Note     |  The engine's source is unchanged: every planned patch is
#           |  done through its config and HTTP API (vendor/opencode/
#           |  PATCHES.md). Run it with agentEnv()'s isolated environment.
# ------------------------------------------------------------------

FROM oven/bun:1.3 AS build
WORKDIR /src
COPY vendor/opencode/ ./
RUN bun install --frozen-lockfile || bun install
RUN cd packages/opencode && bun run script/build.ts --single

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 agent && mkdir -p /workspace && chown agent /workspace
COPY --from=build /src/packages/opencode/dist/*/bin/opencode /usr/local/bin/opencode
USER agent
WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
