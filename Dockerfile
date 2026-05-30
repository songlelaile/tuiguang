# syntax=docker/dockerfile:1.7-labs
# P4.5 syntax 升到 1.7,启用 --mount=type=cache

# ---- build dist ----
FROM node:20-alpine AS builder
WORKDIR /app

# P4.5 apk 换阿里云镜像,国内构建 apk add 提速 10-30 倍
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

# P4.5 BuildKit cache mount:npm cache 跨次构建复用
# --prefer-offline 优先用 cache 中的 tarball,不联网
# 国内 registry 用淘宝镜像,装包飞快
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund \
    --registry=https://registry.npmmirror.com

COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# P4.11 提到 8 GB 容纳大表上传(单个 274 MB CSV + 解析对象易超 2 GB 默认堆)
ENV NODE_OPTIONS=--max-old-space-size=8192
WORKDIR /app

# P4.5 apk 同样换镜像;tini + wget 给 HEALTHCHECK 用;
# python3/make/g++ 只在 npm ci 期间用来编译 better-sqlite3,装完立刻清
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache tini wget python3 make g++

COPY package.json package-lock.json ./

# P4.5 同样的 cache mount + 国内 registry
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --no-fund \
    --registry=https://registry.npmmirror.com \
 && npm cache clean --force \
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
