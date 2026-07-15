#!/bin/bash
# ================================================================
# 前端构建 + 部署脚本
# 在服务器 A 上运行，或在本机构建后 rsync 过去
# ================================================================

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }

# ── 配置前端 .env.production ────────────────────────────────────────
# 服务器 A 的 IP 或域名
SERVER_A_URL="${VITE_API_BASE_URL:-http://localhost}"

info "配置前端环境变量: VITE_API_BASE_URL=$SERVER_A_URL"

cat > ../app/.env.production << EOF
VITE_API_BASE_URL=$SERVER_A_URL
VITE_AUTOCODE_API_URL=$SERVER_A_URL/autocode-api
VITE_APP_NAME=MuhugoChat
VITE_ENABLE_Agent=true
VITE_ENABLE_SKILL_STORE=true
EOF

info "开始构建前端..."
cd ../app
npm install
npm run build

info "✅ 前端构建完成: app/dist/"

# 如果提供了服务器 IP，自动上传
if [ -n "$1" ]; then
    info "上传到服务器 $1:/var/www/muhugochat-frontend/ ..."
    ssh root@$1 "mkdir -p /var/www/muhugochat-frontend"
    rsync -avz --delete dist/ root@$1:/var/www/muhugochat-frontend/
    info "✅ 上传完成，请重启 Nginx: ssh root@$1 systemctl restart nginx"
fi
