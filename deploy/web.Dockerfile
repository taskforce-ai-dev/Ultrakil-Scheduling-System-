FROM node:22.23.2-bookworm-slim AS build

ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/manager-web/package.json apps/manager-web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN pnpm install --frozen-lockfile --filter @ultrakil/manager-web...

COPY apps/manager-web apps/manager-web
COPY packages/api-contracts packages/api-contracts
RUN pnpm --filter @ultrakil/manager-web build

FROM node:22.23.2-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/manager-web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/manager-web/.next/static ./apps/manager-web/.next/static
COPY --from=build --chown=node:node /workspace/apps/manager-web/public ./apps/manager-web/public

USER node
EXPOSE 3000
CMD ["node", "apps/manager-web/server.js"]
