# Multi-stage production Dockerfile for CCS TypeScript Gateway Daemon
FROM node:22-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json vitest.config.ts ./
COPY src ./src

RUN pnpm build
RUN pnpm prune --prod

# Production Runner Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV CCS_CONFIG_DIR=/app/config
ENV PORT=7896

# Install tini for PID 1 signal handling and curl for healthchecks
RUN apk add --no-cache tini curl

# Setup directories with permissions for non-root node user
RUN mkdir -p /app/config /app/data && chown -R node:node /app

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

USER node

EXPOSE 7896

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7896/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
