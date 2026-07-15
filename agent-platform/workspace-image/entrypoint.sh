#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# AutoCode Workspace 容器启动脚本
# 容器启动后保持运行，等待 docker exec 执行命令
# ─────────────────────────────────────────────────────────────────

echo "==============================================="
echo " AutoCode Agent Workspace 已启动"
echo " Node:   $(node --version)"
echo " Python: $(python3 --version)"
echo " Java:   $(java -version 2>&1 | head -1)"
echo " Go:     $(go version 2>/dev/null || echo '未安装')"
echo " Rust:   $(rustc --version 2>/dev/null || echo '未安装')"
echo " PHP:    $(php --version 2>/dev/null | head -1 || echo '未安装')"
echo " Docker: $(docker --version 2>/dev/null || echo '未安装')"
echo "==============================================="
echo ""
echo " 工作目录: $(pwd)"
echo " 用户: $(whoami)"
echo ""
echo " 容器已就绪，等待命令执行..."
echo ""

# 持续运行，保持容器活跃
# （主进程通过 docker exec 在此容器内执行命令）
tail -f /dev/null
