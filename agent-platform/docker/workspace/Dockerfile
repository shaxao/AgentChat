FROM python:3.11-slim

# ─── 换国内镜像源（加速构建）──────────────────────────────
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# ─── 安装多语言运行时 ────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    nodejs \
    npm \
    golang-go \
    openjdk-17-jdk \
    maven \
    unzip \
    vim \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ─── 安装 pnpm (淘宝 npm 镜像加速) ──────────────────────────────
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g pnpm@latest

# ─── 设置工作目录 ───────────────────────────────────────────────
WORKDIR /workspace

# ─── Node / Python / Go 版本验证 ────────────────────────────────
RUN echo "=== Runtime Versions ===" \
    && node --version \
    && npm --version \
    && python3 --version \
    && go version \
    && java -version 2>&1 | head -1 \
    && echo "========================="

# ─── Git 全局配置 ───────────────────────────────────────────────
ARG GIT_AUTHOR_NAME=AutoCode Agent
ARG GIT_AUTHOR_EMAIL=agent@autocode.local
RUN git config --global user.name "$GIT_AUTHOR_NAME" \
    && git config --global user.email "$GIT_AUTHOR_EMAIL" \
    && git config --global init.defaultBranch main

# ─── 安全加固 ───────────────────────────────────────────────────
RUN useradd -m -s /bin/bash agentuser
USER agentuser

# ─── 端口暴露 (workspace 内置 dev server) ──────────────────────
EXPOSE 3000 8000 5173 8080

CMD ["/bin/bash"]
