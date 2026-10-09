# Multi-stage production Dockerfile for CCS TypeScript Gateway Daemon
# Shared build arg: the CI bakes the git SHA into the runtime image so
# GET /health can report it as `version` and the deploy gate can tell a
# new container from a stale one.
ARG APP_VERSION=unknown

FROM node:22-alpine AS builder
ARG APP_VERSION
WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json vitest.config.ts ./
COPY src ./src

RUN pnpm build
RUN pnpm prune --prod

# Dashboard SPA (served by the gateway at /dashboard, same origin /api)
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN cd dashboard && npm ci
COPY dashboard ./dashboard
RUN cd dashboard && npm run build

# Production Runner Stage
FROM node:22-alpine AS runner
ARG APP_VERSION
WORKDIR /app

ENV NODE_ENV=production
ENV CCS_CONFIG_DIR=/app/config
ENV PORT=7896
ENV APP_VERSION=${APP_VERSION}

# Install tini for PID 1 signal handling and curl for healthchecks
RUN apk add --no-cache tini curl

# Setup directories with permissions for non-root node user
RUN mkdir -p /app/config /app/data && chown -R node:node /app

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/dashboard/dist ./dashboard/dist
COPY --chown=node:node config ./baked-config
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node

EXPOSE 7896

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7896/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
