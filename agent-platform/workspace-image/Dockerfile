# ============================================================
# AutoCode Workspace — Agent 执行容器镜像
#
# 用途：每个任务创建独立容器，Agent 在此环境中执行
#       npm / git / python / go / java / docker 等命令
#
# 构建：docker build -t agent-workspace:latest .
# 推送：docker push <registry>/agent-workspace:latest
# ============================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# ─── 系统工具 ───────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Git / VCS
    git \
    curl \
    wget \
    vim \
    nano \
    unzip \
    zip \
    bzip2 \
    gzip \
    tar \
    jq \
    # 通用构建工具
    build-essential \
    ca-certificates \
    openssl \
    # 网络工具
    iputils-ping \
    netcat \
    telnet \
    # Docker-in-Docker
    docker.io \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js 20 ─────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm yarn \
    && node --version && npm --version

# ─── Python 3.11 ────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    && pip3 install --upgrade pip \
    && pip3 install pipx \
    && python3 --version && pip3 --version

# ─── Go 1.22 ────────────────────────────────────────────────────
ENV GO_VERSION=1.22.5
ENV GOPATH=/root/go
ENV PATH=$PATH:/usr/local/go/bin:$GOPATH/bin

RUN curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz \
    | tar -C /usr/local -xzf - \
    && mkdir -p $GOPATH \
    && echo "export PATH=\$PATH:/usr/local/go/bin:\$GOPATH/bin" >> /root/.bashrc \
    && echo "export GOPATH=\$GOPATH" >> /root/.bashrc \
    && go version

# ─── Java 21 (Eclipse Temurin) ─────────────────────────────────
ENV JAVA_VERSION=21
ENV JAVA_HOME=/opt/java/openjdk

RUN curl -fsSL https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.3%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.3_9.tar.gz \
    | tar -xzf - -C /opt \
    && mv /opt/jdk-* $JAVA_HOME \
    && ln -s $JAVA_HOME/bin/java /usr/local/bin/java \
    && ln -s $JAVA_HOME/bin/javac /usr/local/bin/javac \
    && java -version

# ─── PHP 8.3 (可选) ────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    php8.3 \
    php8.3-cli \
    php8.3-curl \
    php8.3-mbstring \
    php8.3-xml \
    php8.3-sqlite3 \
    php8.3-mysql \
    composer \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ─── Ruby 3.3 (可选) ───────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby \
    ruby-dev \
    bundler \
    && gem install rails bundler \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ─── Rust (可选，用于前端工具链) ─────────────────────────────────
ENV RUSTUP_HOME=/root/.rustup
ENV CARGO_HOME=/root/.cargo
ENV PATH=$PATH:$CARGO_HOME/bin

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && rustc --version && cargo --version

# ─── 工作目录设置 ───────────────────────────────────────────────
WORKDIR /workspace

# Agent 用户（非 root，安全）
RUN useradd -m -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers \
    && chown -R agent:agent /workspace

USER agent

# ─── Git 全局配置 ───────────────────────────────────────────────
RUN git config --global init.defaultBranch master \
    && git config --global pull.rebase false \
    && git config --global core.autocrlf input \
    && git config --global safe.directory '*'

# ─── 常用 npm 全局包 ───────────────────────────────────────────
RUN npm install -g \
    typescript \
    ts-node \
    @nestjs/cli \
    vite \
    create-next-app \
    create-vite \
    expo-cli \
    pm2 \
    && npm cache clean --force

# ─── Python 全局包 ─────────────────────────────────────────────
RUN pip3 install --break-system-packages \
    requests \
    httpx \
    pydantic \
    loguru \
    black \
    ruff \
    mypy \
    && pip3 cache purge

# ─── 启动脚本 ───────────────────────────────────────────────────
COPY --chown=agent:agent entrypoint.sh /workspace/entrypoint.sh
RUN chmod +x /workspace/entrypoint.sh

ENTRYPOINT ["/workspace/entrypoint.sh"]

# ─── 版本信息 ───────────────────────────────────────────────────
LABEL org.opencontainers.image.title="AutoCode Agent Workspace"
LABEL org.opencontainers.image.description="预装 Node.js / Python / Go / Java / Rust 等运行时的 Agent 执行环境"
LABEL org.opencontainers.image.version="1.0"
