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

# ─── 源码 ────────────────────────────────────────────────
COPY . .

# ─── 健康检查 ───────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
