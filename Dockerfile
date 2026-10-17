# Multi-stage Dockerfile optimized for Coolify and production container deployments
# 1. Base stage
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat curl wget

# 2. Dependencies stage (installs all dependencies including dev for building)
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit

# 3. Builder stage (compiles client bundle and server bundle)
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN npm run build

# 4. Production Runner stage (clean, minimal, fast start)
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only using the warmed npm cache (instant 2s)
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit

# Copy built production assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/data ./data

# Setup persistence directory permissions for Coolify volume mounts
RUN mkdir -p /app/data /app/downloads && \
    chmod -R 777 /app/data /app/downloads

EXPOSE 3000

# Healthcheck guarantees Coolify zero-downtime auto-deploy waits until the server is ready before routing
HEALTHCHECK --interval=3s --timeout=3s --start-period=5s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
