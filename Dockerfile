# Multi-stage Dockerfile optimized for Coolify and production container deployments
# 1. Base stage
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# 2. Dependencies stage
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# 3. Builder stage
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN npm run build

# 4. Production Runner stage
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy runtime files
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts

# Create data directory for user persistence
RUN mkdir -p /app/data && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 notflix && \
    chown -R notflix:nodejs /app

USER notflix

EXPOSE 3000

# Built-in health check for Coolify uptime monitoring
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "start"]
