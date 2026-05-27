# syntax=docker/dockerfile:1.6

# ---- build dist ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY server ./server

RUN mkdir -p /app/uploads/source-data /app/data/source-data \
 && chown -R node:node /app

USER node

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5174/api/health || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server/index.js"]
