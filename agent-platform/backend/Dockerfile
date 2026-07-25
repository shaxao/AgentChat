FROM python:3.11-slim

WORKDIR /app

# ─── 换国内镜像源（加速构建）──────────────────────────────
# Debian Trixie → 阿里云镜像
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# ─── 系统依赖 ───────────────────────────────────────────
# 只安装 docker CLI（不需要 docker daemon），通过挂载宿主机 socket 通信
# C 编译工具链：uvicorn[standard] 的 uvloop/httptools 需要
# Rust：通过 rustup 安装最新版（apt 提供的是 1.63，无法编译新版 cryptography>=43 / bcrypt>=4.1）
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    gnupg \
    gcc \
    g++ \
    make \
    libffi-dev \
    libssl-dev \
    python3-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 安装最新稳定版 Rust（rustup + USTC 镜像加速）
ENV RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static
ENV RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# ─── Python 依赖（阿里云 PyPI 镜像）──────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
    --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
    -r requirements.txt

# 清理编译工具链（减小最终镜像体积 ~400MB）
RUN apt-get remove -y \
    gcc g++ make libffi-dev libssl-dev python3-dev \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.cargo /root/.rustup

# ─── LSP 语言服务器（代码智能）──────────────────────────────
# 在 backend 主机侧运行，供 agent 查跳定义/引用/符号并在编辑后回喂
# 编译/类型错误。全部优雅降级：缺二进制时对应语言的 LSP 自动跳过。
# 用 INSTALL_LSP=0 构建可跳过，得到更小的镜像（LSP 功能随之关闭）。
ARG INSTALL_LSP=1
# Node 20（pyright + typescript-language-server）与 Go（gopls）
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"
RUN if [ "$INSTALL_LSP" = "1" ]; then set -eux; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    # Node 20 (NodeSource)
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm config set registry https://registry.npmmirror.com; \
    npm install -g pyright typescript typescript-language-server; \
    # Go + gopls（官方 tarball；GOPROXY 用国内镜像加速）
    curl -fsSL https://mirrors.aliyun.com/golang/go1.22.5.linux-amd64.tar.gz \
      | tar -C /usr/local -xzf -; \
    GOPROXY=https://goproxy.cn,direct /usr/local/go/bin/go install golang.org/x/tools/gopls@latest; \
    # 保留运行时需要的 node/go，仅清理 apt 缓存
    apt-get clean && rm -rf /var/lib/apt/lists/*; \
    pyright-langserver --version || true; \
    typescript-language-server --version || true; \
    gopls version || true; \
    fi

# ─── 源码 ────────────────────────────────────────────────
COPY . .

# ─── 健康检查 ───────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
