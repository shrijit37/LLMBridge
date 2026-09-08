# Multi-stage Docker build for CCS TypeScript Daemon
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json vitest.config.ts ./
COPY src ./src

RUN pnpm build

# Production image
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json ./
RUN pnpm install --prod

COPY --from=builder /app/dist ./dist

EXPOSE 7896

CMD ["node", "dist/index.js"]
