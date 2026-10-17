# Multi-stage Dockerfile optimized for Coolify zero-downtime auto-deployments
# 1. Base stage
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat curl wget

# 2. Dependencies stage (cached via Docker layer cache whenever package.json is unchanged)
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit

# 3. Builder stage (compiles fresh client bundle and server bundle on every commit)
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
ARG SOURCE_COMMIT=""
ARG COOLIFY_COMMIT_SHA=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
ENV COOLIFY_COMMIT_SHA=${COOLIFY_COMMIT_SHA}
COPY . .
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN rm -rf dist server.js && npm run build && test -f dist/index.html && test -f server.js

# 4. Production Runner stage (clean, fast start)
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules from deps stage (instant cached layer, avoids concurrent npm cache locks)
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules

# Copy built production assets (keep /app/data_seed separate so /app/data is never overwritten)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/index.html ./index.html
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/data ./data_seed

# Setup persistence directory permissions for Coolify volume mounts
RUN mkdir -p /app/data /app/data_seed /app/downloads && \
    chmod -R 777 /app/data /app/data_seed /app/downloads

EXPOSE 3000

# Healthcheck guarantees Coolify zero-downtime auto-deploy waits until the server is ready before routing
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
