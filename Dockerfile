# syntax=docker/dockerfile:1.7

# ---- Build stage ----
# Compile TypeScript with devDependencies, then drop them in the runtime image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Production deps ----
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

# Run as the unprivileged `node` user already provided in the base image.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# /data holds the OAuth token cache, FX cache, and merchant cache. Mount a
# persistent volume here so refresh tokens survive restarts.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/server/index.js"]
