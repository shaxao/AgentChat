#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

SSH_USER="${SSH_USER:-root}"
SERVER_A_IP="${SERVER_A_IP:-}"
SERVER_B_IP="${SERVER_B_IP:-}"
SERVER_C_IP="${SERVER_C_IP:-}"
DB_NAME="${DB_NAME:-MuHuoAi}"
DB_USER="${DB_USER:-muhuoai}"
DB_PASS="${DB_PASS:-changeme}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

require_ip() {
  local value="$1"
  local name="$2"
  if [ -z "$value" ]; then
    error "$name is not configured"
    exit 1
  fi
}

remote() {
  local host="$1"
  shift
  ssh "${SSH_USER}@${host}" "$@"
}

deploy_server_c() {
  require_ip "$SERVER_C_IP" "SERVER_C_IP"
  info "Initialize Server C: MySQL"
  remote "$SERVER_C_IP" "apt-get update -qq && apt-get install -y mysql-server && systemctl enable mysql"
  remote "$SERVER_C_IP" "cat >/etc/mysql/mysql.conf.d/autocode.cnf <<'EOF'
[mysqld]
bind-address = 0.0.0.0
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
max_connections = 120
innodb_buffer_pool_size = 768M
binlog_expire_logs_seconds = 604800
tmp_table_size = 64M
max_heap_table_size = 64M

[client]
default-character-set = utf8mb4
EOF
systemctl restart mysql"
  remote "$SERVER_C_IP" "mysql -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS ${DB_NAME} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL"
  info "Server C initialized"
}

deploy_server_a() {
  require_ip "$SERVER_A_IP" "SERVER_A_IP"
  info "Initialize Server A: Java backend and Nginx"
  remote "$SERVER_A_IP" "apt-get update -qq && apt-get install -y openjdk-17-jdk nginx rsync && systemctl enable nginx"
  remote "$SERVER_A_IP" "mkdir -p /opt/muhugochat/logs /var/www/muhugochat-frontend"
  info "Server A initialized"
}

deploy_server_b() {
  require_ip "$SERVER_B_IP" "SERVER_B_IP"
  info "Initialize Server B: AutoCode worker"
  remote "$SERVER_B_IP" "apt-get update -qq && apt-get install -y python3 python3-pip python3-venv nodejs npm git rsync && mkdir -p /opt/autocode /data/autocode-workspaces /var/log/autocode"
  info "Server B initialized"
}

build_frontend() {
  info "Build frontend"
  (cd "$repo_root/app" && npm install && npm run build)
  info "Frontend build ready: app/dist"
}

build_backend() {
  info "Build Java backend"
  (cd "$repo_root/backend" && mvn clean package -DskipTests)
  local jar
  jar="$(find "$repo_root/backend/target" -name '*.jar' | head -1)"
  info "Backend artifact ready: $jar"
}

build_docs() {
  info "Build learning docs site"
  (cd "$repo_root/docs-site" && npm install && npm run docs:build)
  info "Docs build ready: docs-site/.vitepress/dist (base=/learn/)"
}

upload_to_server_a() {
  local host="${1:-$SERVER_A_IP}"
  require_ip "$host" "Server A IP"
  info "Upload frontend and backend to Server A: $host"
  [ -d "$repo_root/app/dist" ] || build_frontend
  rsync -az --delete "$repo_root/app/dist/" "${SSH_USER}@${host}:/var/www/muhugochat-frontend/"
  # 学习文档站 → 前端目录下的 /learn 子路径（--delete 已排除，单独同步避免误删主站）
  if [ -d "$repo_root/docs-site/.vitepress/dist" ]; then
    info "Upload learning docs to /learn"
    remote "$host" "mkdir -p /var/www/muhugochat-frontend/learn"
    rsync -az --delete "$repo_root/docs-site/.vitepress/dist/" "${SSH_USER}@${host}:/var/www/muhugochat-frontend/learn/"
  else
    warn "Docs site not built; skip. Run ./deploy.sh build-docs first to publish /learn"
  fi
  local jar
  jar="$(find "$repo_root/backend/target" -name '*.jar' | head -1 || true)"
  if [ -z "$jar" ]; then
    warn "Backend jar not found; running build_backend"
    build_backend
    jar="$(find "$repo_root/backend/target" -name '*.jar' | head -1)"
  fi
  scp "$jar" "${SSH_USER}@${host}:/opt/muhugochat/backend.jar"
  remote "$host" "systemctl restart muhugochat 2>/dev/null || true; nginx -s reload 2>/dev/null || systemctl reload nginx || true"
  info "Upload to Server A completed"
}

upload_to_server_b() {
  local host="${1:-$SERVER_B_IP}"
  require_ip "$host" "Server B IP"
  info "Upload AutoCode backend to Server B: $host"
  rsync -az --delete \
    --exclude 'venv/' \
    --exclude '__pycache__/' \
    --exclude 'workspaces/' \
    --exclude '*.pyc' \
    "$repo_root/agent-platform/" "${SSH_USER}@${host}:/opt/autocode/"
  remote "$host" "systemctl restart autocode 2>/dev/null || true"
  info "Upload to Server B completed"
}

upload_to_server_c() {
  local host="${1:-$SERVER_C_IP}"
  require_ip "$host" "Server C IP"
  info "Upload SQL files to Server C: $host"
  local sql_file=""
  for candidate in "$repo_root"/backend/src/main/resources/sql/*.sql "$repo_root"/sql/*.sql "$repo_root"/*.sql; do
    if [ -f "$candidate" ]; then
      sql_file="$candidate"
      break
    fi
  done
  if [ -z "$sql_file" ]; then
    warn "No SQL file found"
    return
  fi
  scp "$sql_file" "${SSH_USER}@${host}:/tmp/autocode-init.sql"
  remote "$host" "mysql -u root -p'${DB_PASS}' ${DB_NAME} < /tmp/autocode-init.sql"
  info "SQL upload completed"
}

verify_connectivity() {
  info "Verify server connectivity"
  for host in "$SERVER_A_IP" "$SERVER_B_IP" "$SERVER_C_IP"; do
    printf "  SSH %s ... " "$host"
    if timeout 5 ssh -o ConnectTimeout=3 "${SSH_USER}@${host}" "echo OK" >/dev/null 2>&1; then
      echo "OK"
    else
      echo "FAIL"
    fi
  done
}

show_help() {
  cat <<HELP
MuhugoChat deployment script

Usage:
  ./deploy.sh server-c
  ./deploy.sh server-a
  ./deploy.sh server-b
  ./deploy.sh build-frontend
  ./deploy.sh build-backend
  ./deploy.sh build-docs
  ./deploy.sh build-docs
  ./deploy.sh upload-a [ip]
  ./deploy.sh upload-b [ip]
  ./deploy.sh upload-c [ip]
  ./deploy.sh verify

Environment:
  SERVER_A_IP, SERVER_B_IP, SERVER_C_IP, SSH_USER, DB_NAME, DB_USER, DB_PASS
HELP
}

case "${1:-help}" in
  server-c) deploy_server_c ;;
  server-a) deploy_server_a ;;
  server-b) deploy_server_b ;;
  build-frontend) build_frontend ;;
  build-backend) build_backend ;;
  build-docs) build_docs ;;
  upload-a) upload_to_server_a "${2:-}" ;;
  upload-b) upload_to_server_b "${2:-}" ;;
  upload-c) upload_to_server_c "${2:-}" ;;
  verify) verify_connectivity ;;
  help|-h|--help) show_help ;;
  *) show_help; exit 1 ;;
esac
