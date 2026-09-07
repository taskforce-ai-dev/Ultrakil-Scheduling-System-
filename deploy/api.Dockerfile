# Patch tags are reviewed together; record resolved digests with each release.
FROM node:22.23.2-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

FROM base AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/manager-web/package.json apps/manager-web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN pnpm install --frozen-lockfile --filter @ultrakil/api...

COPY apps/api apps/api
RUN pnpm --filter @ultrakil/api prisma:generate && pnpm --filter @ultrakil/api build
RUN pnpm --filter @ultrakil/api deploy --prod --legacy /out/api
# Regenerate into the portable production dependency tree, not the build tree.
RUN cd /out/api && node /workspace/apps/api/node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma \
    && node -e 'const {PrismaClient}=require("@prisma/client"); new PrismaClient()'

# Explicit operations image: no Corepack/pnpm download is needed at runtime.
FROM base AS tooling
ENV NODE_ENV=production CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/apps/api/prisma ./apps/api/prisma
COPY --from=build /workspace/apps/api/scripts ./apps/api/scripts
COPY --from=build /workspace/apps/api/src ./apps/api/src
COPY --from=build /workspace/apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY deploy/staging-tool.mjs ./deploy/staging-tool.mjs
COPY deploy/lifecycle.mjs ./deploy/lifecycle.mjs
USER node
CMD ["node", "deploy/staging-tool.mjs", "preflight"]

FROM base AS runtime
ENV NODE_ENV=production CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=build /out/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
