FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=development
ENV HOST=0.0.0.0
ENV PORT=3003

COPY infrastructure/local/stub-provider.mjs ./stub-provider.mjs

USER node
EXPOSE 3003

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3003/health >/dev/null || exit 1

CMD ["node", "stub-provider.mjs"]
