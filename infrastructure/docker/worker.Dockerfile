FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --no-optional --prod=false \
    --filter @topology/worker

COPY apps/worker/tsconfig.json ./apps/worker/tsconfig.json
COPY apps/worker/src ./apps/worker/src

RUN pnpm --filter @topology/worker build
RUN pnpm --filter @topology/worker deploy --prod --no-optional /prod/apps/worker

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002
ENV HOME=/tmp

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs worker

COPY --from=builder --chown=worker:nodejs /prod/apps/worker ./apps/worker

USER worker

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3002/health/live >/dev/null || exit 1

CMD ["node", "apps/worker/dist/server.js"]
