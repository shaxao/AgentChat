# ─── Base Stage ──────────────────────────────────────────────
FROM node:20-slim AS base

# 换阿里云 Debian 镜像源
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
EXPOSE 3000


# ─── Dependencies Stage ─────────────────────────────────────────
FROM base AS deps

WORKDIR /app

COPY package*.json ./
# 淘宝 npm 镜像加速
RUN npm config set registry https://registry.npmmirror.com && npm install


# ─── Build Stage ────────────────────────────────────────────────
FROM base AS builder

WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建时注入 API 地址
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-http://localhost:8000}

RUN npm run build

# ── 关键步骤：把 public 和 .next/static 塞进 standalone 目录 ──
RUN if [ -d /app/public ]; then \
      cp -r /app/public /app/.next/standalone/public; \
    fi
RUN if [ -d /app/.next/static ]; then \
      mkdir -p /app/.next/standalone/.next && \
      cp -r /app/.next/static /app/.next/standalone/.next/static; \
    fi


# ─── Production Stage ───────────────────────────────────────────
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 只复制 standalone 目录（已包含 public 和 static）
COPY --from=builder /app/.next/standalone ./

EXPOSE 3000

CMD ["node", "server.js"]
