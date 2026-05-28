# syntax=docker/dockerfile:1.6

# ---- build dist ----
FROM node:20-alpine AS builder
WORKDIR /app
# better-sqlite3 is a native module; alpine needs python + make + g++ to compile
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini + wget for HEALTHCHECK; python3/make/g++ kept only during npm ci for better-sqlite3
RUN apk add --no-cache tini wget python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
 && apk del python3 make g++

COPY --from=builder /app/dist ./dist
COPY server ./server

# uploads is for raw source files, data is for SQLite history db
RUN mkdir -p /app/uploads/source-data /app/data \
 && chown -R node:node /app

USER node

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5174/api/health || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server/index.js"]
