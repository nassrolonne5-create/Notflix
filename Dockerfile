# Dockerfile for Coolify Deployment
FROM node:22-bookworm-slim

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Install dependencies (including optional native bindings)
COPY package*.json .npmrc ./
RUN npm install --include=dev --include=optional

# Copy source files
COPY . .

# Build Vite production assets
RUN npm run build

# Expose standard application port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
