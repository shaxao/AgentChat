# ─────────────────────────────────────────────────────────────────
# Makefile — agent-workspace 镜像管理
# ─────────────────────────────────────────────────────────────────

REGISTRY ?= registry.example.com
TAG ?= latest
IMAGE := agent-workspace

.PHONY: build build-local tag push login health-check clean help

# ── 构建 ─────────────────────────────────────────────────────────
build:
	@echo "🔨 构建 agent-workspace:${TAG} ..."
	docker build --platform linux/amd64 -t ${IMAGE}:${TAG} .

build-local:
	@echo "🔨 构建本地镜像 ..."
	docker build -t ${IMAGE}:${TAG} .

# ── 标签 & 推送 ───────────────────────────────────────────────────
tag:
	@echo "🏷️  打标签 ${REGISTRY}/${IMAGE}:${TAG} ..."
	docker tag ${IMAGE}:${TAG} ${REGISTRY}/${IMAGE}:${TAG}

push: tag
	@echo "⬆️  推送镜像 ..."
	docker push ${REGISTRY}/${IMAGE}:${TAG}

# ── 登录 ─────────────────────────────────────────────────────────
login:
	@echo "🔑 登录镜像仓库 ..."
	docker login ${REGISTRY}

# ── 完整发布流程 ─────────────────────────────────────────────────
release: build push
	@echo "✅ 发布完成: ${REGISTRY}/${IMAGE}:${TAG}"

# ── 本地测试 ─────────────────────────────────────────────────────
test-run:
	@echo "🚀 启动测试容器 ..."
	docker run --rm -it --name test-workspace ${IMAGE}:${TAG} bash

test-exec:
	@echo "🔧 在运行中的容器内执行命令 ..."
	docker exec -it test-workspace bash

# ── 清理 ─────────────────────────────────────────────────────────
clean:
	@echo "🧹 清理未使用的镜像 ..."
	docker image prune -f
	docker builder prune -f

# ── 健康检查 ─────────────────────────────────────────────────────
health-check:
	@docker run --rm ${IMAGE}:${TAG} bash -c 'node --version && python3 --version && java -version 2>&1 | head -1 && go version'

# ── 帮助 ─────────────────────────────────────────────────────────
help:
	@echo "agent-workspace 镜像管理"
	@echo ""
	@echo "  make build                   构建本地镜像 (linux/amd64)"
	@echo "  make build-local             构建本地镜像 (当前平台)"
	@echo "  make tag                     打标签"
	@echo "  make push                    推送镜像"
	@echo "  make release                 完整发布流程 (构建+推送)"
	@echo "  make login                   登录镜像仓库"
	@echo "  make test-run                启动测试容器"
	@echo "  make clean                   清理未使用镜像"
	@echo "  make health-check            健康检查"
	@echo ""
	@echo "  环境变量: REGISTRY=xxx TAG=yyy"
