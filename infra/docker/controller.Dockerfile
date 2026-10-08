# NVX Ancile · Controller (Node 22, Hono). A separate deployable.
# Build from the repo root: docker build -f infra/docker/controller.Dockerfile .

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY services/controller services/controller
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter ./services/controller... \
 && pnpm --filter ./services/controller build \
 && pnpm --filter ./services/controller deploy --prod /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 7720
CMD ["node", "dist/main.js"]
