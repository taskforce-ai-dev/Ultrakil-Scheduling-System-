FROM node:22-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/manager-web/package.json apps/manager-web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN pnpm install --frozen-lockfile --filter @ultrakil/api...

COPY apps/api apps/api
COPY packages/api-contracts packages/api-contracts
RUN pnpm --filter @ultrakil/api prisma:generate
RUN pnpm --filter @ultrakil/api build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

RUN corepack enable
WORKDIR /workspace
COPY --from=build /workspace /workspace
RUN mkdir -p /workspace/data && chown -R node:node /workspace/data

USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
