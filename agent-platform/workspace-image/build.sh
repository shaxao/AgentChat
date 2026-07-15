#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# 构建并推送 agent-workspace 镜像
# 用法: ./build.sh [registry] [tag]
# 示例: ./build.sh registry.example.com latest
# ─────────────────────────────────────────────────────────────────
set -e

REGISTRY="${1:-registry.example.com}"
TAG="${2:-latest}"
IMAGE="agent-workspace"

echo "🔨 构建 agent-workspace:${TAG} ..."
docker build --platform linux/amd64 -t ${IMAGE}:${TAG} .

echo "📦 打标签 ${REGISTRY}/${IMAGE}:${TAG} ..."
docker tag ${IMAGE}:${TAG} ${REGISTRY}/${IMAGE}:${TAG}

if [ "$3" != "--push-only" ]; then
    echo "⬆️  推送镜像 ..."
    docker push ${REGISTRY}/${IMAGE}:${TAG}
    echo "✅ 完成: ${REGISTRY}/${IMAGE}:${TAG}"
else
    echo "✅ 构建完成（未推送）: ${IMAGE}:${TAG}"
    echo "   手动推送: docker push ${REGISTRY}/${IMAGE}:${TAG}"
fi
