FROM node:22-bookworm-slim AS build

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

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

WORKDIR /workspace
COPY --from=build /workspace /workspace

USER node
EXPOSE 3000
WORKDIR /workspace/apps/manager-web
CMD ["./node_modules/.bin/next", "start"]
