# syntax=docker/dockerfile:1.7-labs
# P4.5 syntax 升到 1.7,启用 --mount=type=cache

# ---- build dist ----
# P4.12.1 Node 升到 22:better-sqlite3 v12 对 Node 20(ABI 115)没有预编译二进制,
# 只能现场编译 sqlite3.c —— 那一步在小内存机(2C4G)会 OOM/卡死整台服务器。
# Node 22(ABI 127)有 musl 预编译;配合下面的 binary_host_mirror 直接下二进制,不再编译。
FROM node:22-alpine AS builder
WORKDIR /app

# 让 better-sqlite3 从 npmmirror 取预编译二进制(国内快),装不到才回退编译
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3

# P4.5 apk 换阿里云镜像,国内构建 apk add 提速 10-30 倍
#（make/g++/python3 仅作"取不到预编译时回退编译"的兜底)
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
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# P4.11 提到 8 GB 容纳大表上传(单个 274 MB CSV + 解析对象易超 2 GB 默认堆)
ENV NODE_OPTIONS=--max-old-space-size=8192
# P4.12.1 同样走预编译二进制,runtime 的 npm ci 不再编译 better-sqlite3
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3
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
