# NVX Ancile · Core + Cockpit (Node 22). Core serves the built Cockpit on one
# origin, so the browser never needs CORS. git ships in the image because
# memory is a git repository (DESIGN.md §6.4).
# Build from the repo root: docker build -f infra/docker/core.Dockerfile .
#
# Assumes: services/core builds to dist/main.js and serves static files from
# ANCILE_PUBLIC_DIR; apps/cockpit builds to dist/.

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages packages
COPY plugins plugins
COPY services/core services/core
COPY apps/cockpit apps/cockpit
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter ./services/core... --filter ./apps/cockpit... \
 && pnpm --filter ./apps/cockpit build \
 && pnpm --filter ./services/core build \
 && pnpm --filter ./services/core deploy --prod /out \
 && cp -r apps/cockpit/dist /out/public

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /app/config && chown -R node:node /data /app
ENV NODE_ENV=production ANCILE_DATA_DIR=/data ANCILE_PUBLIC_DIR=/app/public \
    GIT_AUTHOR_NAME="NVX Ancile" GIT_AUTHOR_EMAIL=memory@ancile.local \
    GIT_COMMITTER_NAME="NVX Ancile" GIT_COMMITTER_EMAIL=memory@ancile.local
WORKDIR /app
COPY --from=build --chown=node:node /out /app
COPY --chown=node:node memory-template /app/memory-template
USER node
EXPOSE 7700
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
