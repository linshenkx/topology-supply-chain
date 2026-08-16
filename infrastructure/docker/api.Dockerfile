FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false \
    --filter . \
    --filter @topology/api \
    --filter @topology/worker \
    --filter @topology/contracts

COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src
COPY apps/worker/tsconfig.json ./apps/worker/tsconfig.json
COPY apps/worker/src ./apps/worker/src
COPY packages/contracts/tsconfig.json ./packages/contracts/tsconfig.json
COPY packages/contracts/src ./packages/contracts/src
COPY database ./database
COPY tooling ./tooling
COPY infrastructure/local ./infrastructure/local

RUN pnpm --filter @topology/worker build \
    && pnpm --filter @topology/api build
RUN pnpm --filter @topology/api deploy --prod --no-optional /prod/apps/api

FROM node:22-alpine AS runner

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=3001
ENV HOME=/tmp

RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate

COPY --from=builder /prod/apps/api ./apps/api
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/database ./database
COPY --from=builder /app/tooling ./tooling
COPY --from=builder /app/infrastructure/local ./infrastructure/local
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health/live >/dev/null || exit 1

CMD ["node", "apps/api/dist/backend-server.js"]
