# ============================================================
# ============================================================

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$TAR = "C:\Windows\System32\tar.exe"

$SSH_EXE = "ssh"
$SCP_EXE = "scp"
# Prefer Git for Windows SSH/SCP to avoid unstable system PATH resolution.
foreach ($p in @(
    "C:\Program Files\Git\usr\bin\ssh.exe",
    "C:\Program Files (x86)\Git\usr\bin\ssh.exe",
    "$env:ProgramFiles\Git\usr\bin\ssh.exe",
    "$env:USERPROFILE\AppData\Local\Programs\Git\usr\bin\ssh.exe"
)) {
    if (Test-Path $p) { $SSH_EXE = $p; $SCP_EXE = $p.Replace('\usr\bin\ssh.exe', '\usr\bin\scp.exe'); break }
}
if (-not (Test-Path $SSH_EXE)) {
    $SSH_EXE = "ssh"
    $SCP_EXE = "scp"
}

$MVN_EXE = "mvn"
foreach ($p in @(
    "$env:USERPROFILE\.m2\wrapper\dists\apache-maven-3.9.5-bin"
)) {
    if (Test-Path $p) {
        $subdir = Get-ChildItem -Directory $p | Select-Object -First 1
        if ($subdir) {
            $candidate = Join-Path $subdir.FullName "apache-maven-3.9.5\bin\mvn.cmd"
            if (Test-Path $candidate) { $MVN_EXE = $candidate; break }
        }
    }
}
Write-Host "Maven: $MVN_EXE" -ForegroundColor DarkGray

$WORKSPACE = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$HOST_A_IP = if ($env:MUHUGO_SERVER_A_IP) { $env:MUHUGO_SERVER_A_IP } else { "your-server-a-ip" }
$HOST_B_IP = if ($env:MUHUGO_SERVER_B_IP) { $env:MUHUGO_SERVER_B_IP } else { "your-server-b-ip" }
$HOST_OVERSEAS_IP = if ($env:MUHUGO_OVERSEAS_IP) { $env:MUHUGO_OVERSEAS_IP } else { "" }
$SSH_KEY   = if ($env:MUHUGO_SSH_KEY) { $env:MUHUGO_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\id_ed25519" }
$SSH_OPTS  = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=30")
$MUHUGO_FE_DIR   = "/var/www/muhugochat-frontend"
$AUTOCODE_FE_DIR = "/var/www/autocode-frontend"

$DB_HOST     = if ($env:MUHUGO_DB_HOST) { $env:MUHUGO_DB_HOST } else { "your-server-c-ip" }
$DB_PORT     = if ($env:MUHUGO_DB_PORT) { $env:MUHUGO_DB_PORT } else { "3306" }
$DB_USER     = if ($env:MUHUGO_DB_USER) { $env:MUHUGO_DB_USER } else { "muhuoai" }
$DB_PASS     = if ($env:MUHUGO_DB_PASS) { $env:MUHUGO_DB_PASS } else { "changeme" }
$DB_NAME     = if ($env:MUHUGO_DB_NAME) { $env:MUHUGO_DB_NAME } else { "MuHuoAi" }

$INTERNAL_API_KEY = if ($env:MUHUGO_INTERNAL_API_KEY) { $env:MUHUGO_INTERNAL_API_KEY } else { "change-me-internal-api-key" }

$CACHE_LEDGER_BASE_URL = if ($env:CACHE_LEDGER_BASE_URL) { $env:CACHE_LEDGER_BASE_URL } else { "http://127.0.0.1:8000/api/cache" }

function Invoke-SSH { param([string]$Alias, [string]$Cmd)
    ($Cmd -replace "`r", "") | & $SSH_EXE @SSH_OPTS $Alias "sed '1s/^\xEF\xBB\xBF//' | tr -d '\r' | bash -s"
    return $LASTEXITCODE
}
function Invoke-SCP { param([string]$Local, [string]$Alias, [string]$Remote)
    & $SCP_EXE @SSH_OPTS $Local "${Alias}:${Remote}"
    return $LASTEXITCODE
}
function Invoke-SSH-ByIP { param([string]$IP, [string]$Cmd)
    ($Cmd -replace "`r", "") | & $SSH_EXE @SSH_OPTS "-i" $SSH_KEY "root@$IP" "sed '1s/^\xEF\xBB\xBF//' | tr -d '\r' | bash -s"
    return $LASTEXITCODE
}
function Invoke-SCP-ByIP { param([string]$Local, [string]$IP, [string]$Remote)
    & $SCP_EXE @SSH_OPTS "-i" $SSH_KEY $Local "root@${IP}:${Remote}"
    return $LASTEXITCODE
}
$SSH_ALIAS_A = if ($env:MUHUGO_SSH_ALIAS_A) { $env:MUHUGO_SSH_ALIAS_A } else { "" }
$SSH_ALIAS_B = if ($env:MUHUGO_SSH_ALIAS_B) { $env:MUHUGO_SSH_ALIAS_B } else { "" }
$SSH_ALIAS_OVERSEAS = if ($env:MUHUGO_OVERSEAS_SSH_ALIAS) { $env:MUHUGO_OVERSEAS_SSH_ALIAS } else { "" }

function SSH-A { param([string]$Cmd)
    if ($SSH_ALIAS_A -and $SSH_ALIAS_A.Trim().Length -gt 0) { return Invoke-SSH $SSH_ALIAS_A $Cmd }
    return Invoke-SSH-ByIP $HOST_A_IP $Cmd
}
function SSH-B { param([string]$Cmd)
    if ($SSH_ALIAS_B -and $SSH_ALIAS_B.Trim().Length -gt 0) { return Invoke-SSH $SSH_ALIAS_B $Cmd }
    return Invoke-SSH-ByIP $HOST_B_IP $Cmd
}
function SSH-Overseas { param([string]$Cmd)
    if ($SSH_ALIAS_OVERSEAS -and $SSH_ALIAS_OVERSEAS.Trim().Length -gt 0) {
        return Invoke-SSH $SSH_ALIAS_OVERSEAS $Cmd
    }
    if (-not $HOST_OVERSEAS_IP -or $HOST_OVERSEAS_IP.Trim().Length -eq 0) {
        Write-Host "ERROR: overseas host not configured. Set `$HOST_OVERSEAS_IP in deploy.ps1 or MUHUGO_OVERSEAS_IP env." -ForegroundColor Red
        return 1
    }
    return Invoke-SSH-ByIP $HOST_OVERSEAS_IP $Cmd
}
function SCP-To-Overseas { param([string]$Local, [string]$Remote)
    if ($SSH_ALIAS_OVERSEAS -and $SSH_ALIAS_OVERSEAS.Trim().Length -gt 0) {
        return Invoke-SCP $Local $SSH_ALIAS_OVERSEAS $Remote
    }
    if (-not $HOST_OVERSEAS_IP -or $HOST_OVERSEAS_IP.Trim().Length -eq 0) {
        Write-Host "ERROR: overseas host not configured. Set `$HOST_OVERSEAS_IP in deploy.ps1 or MUHUGO_OVERSEAS_IP env." -ForegroundColor Red
        return 1
    }
    return Invoke-SCP-ByIP $Local $HOST_OVERSEAS_IP $Remote
}
function SCP-To-A { param([string]$Local, [string]$Remote)
    if ($SSH_ALIAS_A -and $SSH_ALIAS_A.Trim().Length -gt 0) { return Invoke-SCP $Local $SSH_ALIAS_A $Remote }
    return Invoke-SCP-ByIP $Local $HOST_A_IP $Remote
}
function SCP-To-B { param([string]$Local, [string]$Remote)
    if ($SSH_ALIAS_B -and $SSH_ALIAS_B.Trim().Length -gt 0) { return Invoke-SCP $Local $SSH_ALIAS_B $Remote }
    return Invoke-SCP-ByIP $Local $HOST_B_IP $Remote
}

function Invoke-Remote-MySql {
    param([string]$Sql)

    $escapedSql = $Sql.Replace("'", "'\''")
    $remoteCmd = @"
set -euo pipefail
db_host='$DB_HOST'
db_port='$DB_PORT'
db_user='$DB_USER'
db_pass='$DB_PASS'
db_name='$DB_NAME'
sql='$escapedSql'

if command -v mysql >/dev/null 2>&1; then
  mysql -h 127.0.0.1 -P "`$db_port" -u "`$db_user" -p"`$db_pass" "`$db_name" -e "`$sql"
elif command -v mariadb >/dev/null 2>&1; then
  mariadb -h 127.0.0.1 -P "`$db_port" -u "`$db_user" -p"`$db_pass" "`$db_name" -e "`$sql"
else
  echo "ERROR: mysql/mariadb client not found on Server C." >&2
  exit 127
fi
"@
    Invoke-SSH-ByIP $DB_HOST $remoteCmd
}

function Build-Frontend {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Building Frontend"             -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $appDir = "$WORKSPACE\app"
    if (-not (Test-Path $appDir)) { Write-Host "ERROR: $appDir not found" -ForegroundColor Red; return }

    Set-Location $appDir
    try {
        Write-Host "npm install..." -ForegroundColor Cyan
        npm install --legacy-peer-deps
        if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; return }

        Write-Host "npm run build..." -ForegroundColor Cyan
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Host "build failed" -ForegroundColor Red; return }

        Write-Host "Build OK" -ForegroundColor Green
    } finally { Set-Location $WORKSPACE\deploy }
}

function Upload-FrontendOnly {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Uploading Frontend to Server A"        -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $distDir = "$WORKSPACE\app\dist"
    if (-not (Test-Path $distDir)) {
        Write-Host "ERROR: dist not found, run build-frontend first" -ForegroundColor Red
        return
    }

    $tarFile = "$env:TEMP\frontend-dist.tar.gz"

    Write-Host "Packing dist..." -ForegroundColor Cyan
    & $TAR -czf $tarFile -C $distDir .
    if ($LASTEXITCODE -ne 0) { Write-Host "tar failed" -ForegroundColor Red; return }

    Write-Host "Uploading to $HOST_A_IP..." -ForegroundColor Cyan
    SCP-To-A $tarFile "/tmp/frontend-dist.tar.gz"
    if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; return }

    Write-Host "Extracting on server to $MUHUGO_FE_DIR ..." -ForegroundColor Cyan
    SSH-A "mkdir -p ${MUHUGO_FE_DIR}; cd ${MUHUGO_FE_DIR}; tar -xzf /tmp/frontend-dist.tar.gz; rm /tmp/frontend-dist.tar.gz"
    if ($LASTEXITCODE -ne 0) { Write-Host "remote extract failed" -ForegroundColor Red; return }

    $docsDistDir = "$WORKSPACE\docs-site\.vitepress\dist"
    if (Test-Path $docsDistDir) {
        Write-Host "Docs build detected; syncing /learn ..." -ForegroundColor Cyan
        Upload-Docs
        if ($LASTEXITCODE -ne 0) { return }
    } else {
        Write-Host "Docs site not built; skip /learn. Run .\deploy.ps1 build-docs; .\deploy.ps1 upload-docs to publish it." -ForegroundColor Yellow
    }

    Write-Host "Frontend deployed OK" -ForegroundColor Green
}

function Build-Docs {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Building Docs Site"                  -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $docsDir = "$WORKSPACE\docs-site"
    if (-not (Test-Path $docsDir)) {
        Write-Host "ERROR: $docsDir not found" -ForegroundColor Red
        return
    }

    Set-Location $docsDir
    try {
        Write-Host "npm install..." -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; return }

        Write-Host "npm run docs:build..." -ForegroundColor Cyan
        npm run docs:build
        if ($LASTEXITCODE -ne 0) { Write-Host "docs build failed" -ForegroundColor Red; return }

        Write-Host "Docs build OK: docs-site\.vitepress\dist" -ForegroundColor Green
    } finally { Set-Location $WORKSPACE\deploy }
}

function Upload-Docs {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Uploading Docs Site to /learn"       -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $distDir = "$WORKSPACE\docs-site\.vitepress\dist"
    if (-not (Test-Path $distDir)) {
        Write-Host "ERROR: docs dist not found, run build-docs first" -ForegroundColor Red
        return
    }

    $tarFile = "$env:TEMP\docs-site-dist.tar.gz"

    Write-Host "Packing docs dist..." -ForegroundColor Cyan
    & $TAR -czf $tarFile -C $distDir .
    if ($LASTEXITCODE -ne 0) { Write-Host "tar failed" -ForegroundColor Red; return }

    Write-Host "Uploading docs to $HOST_A_IP..." -ForegroundColor Cyan
    SCP-To-A $tarFile "/tmp/docs-site-dist.tar.gz"
    if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; return }

    $remote = @"
set -e
mkdir -p ${MUHUGO_FE_DIR}/learn
find ${MUHUGO_FE_DIR}/learn -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
tar -xzf /tmp/docs-site-dist.tar.gz -C ${MUHUGO_FE_DIR}/learn
rm -f /tmp/docs-site-dist.tar.gz
nginx -s reload 2>/dev/null || systemctl reload nginx || true
"@
    Write-Host "Extracting docs on server to ${MUHUGO_FE_DIR}/learn ..." -ForegroundColor Cyan
    SSH-A $remote
    if ($LASTEXITCODE -ne 0) { Write-Host "remote docs extract failed" -ForegroundColor Red; return }

    Write-Host "Docs deployed OK: /learn/" -ForegroundColor Green
}

function Upload-AutoCode {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Uploading AutoCode Backend to Server B" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $backendDir = "$WORKSPACE\agent-platform\backend"
    $connectorInstaller = Get-ChildItem "$WORKSPACE\agent-platform\local-connector\src-tauri\target\release\bundle\nsis\AutoCode Local Connector_*_x64-setup.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    $connectorExeFallback = "$WORKSPACE\agent-platform\local-connector\windows\AutoCodeLocalConnectorSetup.exe"
    $connectorTargetDir = "$backendDir\static\local-connector"
    $connectorTarget = "$connectorTargetDir\AutoCodeLocalConnectorSetup.exe"
    $tarFile    = "$env:TEMP\autocode-backend.tar.gz"

    if ($connectorInstaller -and (Test-Path $connectorInstaller.FullName)) {
        Write-Host "Including AutoCode Local Connector installer..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path $connectorTargetDir | Out-Null
        Copy-Item -Force $connectorInstaller.FullName $connectorTarget
    } elseif (Test-Path $connectorExeFallback) {
        Write-Host "Including AutoCode Local Connector self-installing exe..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path $connectorTargetDir | Out-Null
        Copy-Item -Force $connectorExeFallback $connectorTarget
    } else {
        Write-Host "Local Connector installer not found; skipping installer upload." -ForegroundColor Yellow
        Write-Host "Expected: latest AutoCode Local Connector_*_x64-setup.exe under bundle\nsis" -ForegroundColor DarkGray
        Write-Host "Fallback: $connectorExeFallback" -ForegroundColor DarkGray
    }

    Write-Host "Packing backend..." -ForegroundColor Cyan
    & $TAR -czf $tarFile -C $backendDir --exclude=".env" --exclude="venv" --exclude="__pycache__" --exclude="*.pyc" --exclude=".env.development" .
    if ($LASTEXITCODE -ne 0) { Write-Host "tar failed" -ForegroundColor Red; return }

    Write-Host "Uploading to $HOST_B_IP..." -ForegroundColor Cyan
    SCP-To-B $tarFile "/opt/autocode/autocode-backend.tar.gz"
    if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; return }

    Write-Host "Extracting and restarting..." -ForegroundColor Cyan
    SSH-B "cd /opt/autocode; tar -xzf autocode-backend.tar.gz; if [ ! -f .env ] || ! grep -q 'WORKSPACE_BASE_DIR=/data/autocode-workspaces' .env; then sed -i 's|^WORKSPACE_BASE_DIR=.*|WORKSPACE_BASE_DIR=/data/autocode-workspaces|' .env || echo 'WORKSPACE_BASE_DIR=/data/autocode-workspaces' >> .env; fi; bash start.sh; for i in 1 2 3 4 5 6 7 8 9 10; do ss -lntp | grep -q ':8000\b' && exit 0; sleep 2; done; echo 'ERROR: AutoCode did not listen on 8000 after restart' >&2; journalctl -u autocode --no-pager -n 80 >&2; tail -n 120 /var/log/autocode/app.log >&2 2>/dev/null || true; tail -n 80 /var/log/autocode/error.log >&2 2>/dev/null || true; exit 1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "remote extract/restart failed" -ForegroundColor Red
        Write-Host "Recent AutoCode logs:" -ForegroundColor Yellow
        SSH-B "journalctl -u autocode --no-pager -n 80"
        return
    }

    Write-Host "AutoCode backend deployed OK" -ForegroundColor Green
}

function Build-AutoCode-Frontend {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Building AutoCode Standalone Frontend" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $feDir = "$WORKSPACE\agent-platform\frontend"
    if (-not (Test-Path $feDir)) { Write-Host "ERROR: $feDir not found" -ForegroundColor Red; return }

    Set-Location $feDir
    try {
        Write-Host "npm install..." -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; return }

        Write-Host "npm run build..." -ForegroundColor Cyan
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Host "build failed" -ForegroundColor Red; return }

        Write-Host "Build OK" -ForegroundColor Green
    } finally { Set-Location $WORKSPACE\deploy }
}

function Upload-AutoCode-Frontend {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Uploading AutoCode Frontend to Server A" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $distDir = "$WORKSPACE\agent-platform\frontend\out"
    if (-not (Test-Path $distDir)) {
        Write-Host "ERROR: out not found, run build-autocode-frontend first" -ForegroundColor Red
        return
    }

    $tarFile = "$env:TEMP\autocode-frontend-dist.tar.gz"

    Write-Host "Packing dist..." -ForegroundColor Cyan
    & $TAR -czf $tarFile -C $distDir .
    if ($LASTEXITCODE -ne 0) { Write-Host "tar failed" -ForegroundColor Red; return }

    Write-Host "Uploading to $HOST_A_IP..." -ForegroundColor Cyan
    SCP-To-A $tarFile "/tmp/autocode-frontend-dist.tar.gz"
    if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; return }

    $remoteDir = $AUTOCODE_FE_DIR
    Write-Host "Deploying to nginx alias path: $remoteDir" -ForegroundColor Cyan
    SSH-A "mkdir -p $remoteDir"

    Write-Host "Extracting on server to $remoteDir ..." -ForegroundColor Cyan
    SSH-A "rm -rf ${remoteDir}/* ; tar -xzf /tmp/autocode-frontend-dist.tar.gz -C ${remoteDir} ; rm /tmp/autocode-frontend-dist.tar.gz ; chmod -R 755 ${remoteDir}"
    if ($LASTEXITCODE -ne 0) { Write-Host "remote extract failed" -ForegroundColor Red; return }

    Write-Host "AutoCode frontend deployed OK to $remoteDir" -ForegroundColor Green
    Write-Host "Tip: Ctrl+Shift+R hard-refresh browser to see changes" -ForegroundColor Yellow
}

function Upload-AutoCode-Frontend-B {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Uploading AutoCode Frontend to Server B" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $distDir = "$WORKSPACE\agent-platform\frontend\out"
    if (-not (Test-Path $distDir)) {
        Write-Host "ERROR: out not found, run build-autocode-frontend first" -ForegroundColor Red
        return
    }

    $tarFile = "$env:TEMP\autocode-frontend-dist.tar.gz"

    Write-Host "Packing dist..." -ForegroundColor Cyan
    & $TAR -czf $tarFile -C $distDir .
    if ($LASTEXITCODE -ne 0) { Write-Host "tar failed" -ForegroundColor Red; return }

    Write-Host "Uploading to $HOST_B_IP..." -ForegroundColor Cyan
    SCP-To-B $tarFile "/tmp/autocode-frontend-dist.tar.gz"
    if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; return }

    Write-Host "Extracting on server..." -ForegroundColor Cyan
    SSH-B "mkdir -p /opt/autocode/frontend/dist && cd /opt/autocode/frontend/dist && tar -xzf /tmp/autocode-frontend-dist.tar.gz && rm /tmp/autocode-frontend-dist.tar.gz && find . -type d -exec chmod 755 {} \; && find . -type f -exec chmod 644 {} \;"
    if ($LASTEXITCODE -ne 0) { Write-Host "remote extract failed" -ForegroundColor Red; return }

    Write-Host "AutoCode frontend deployed OK to Server B" -ForegroundColor Green
}

function Get-Overseas-Routes-Script {
    $ip = if ($HOST_OVERSEAS_IP) { $HOST_OVERSEAS_IP.Trim() } else { "" }
    $script = @'
set -e
mkdir -p /etc/nginx/snippets
overseas_ip="__OVERSEAS_IP__"
snippet="/etc/nginx/snippets/muhugochat-overseas-routes.conf"

if [ -z "$overseas_ip" ]; then
  rm -f "$snippet"
  touch "$snippet"
  echo "Overseas routes disabled: empty overseas IP"
  exit 0
fi

cat > "$snippet" <<EOF
# Generated by deploy.ps1. Requests that require overseas network access go to
# the overseas backend node; normal domestic API traffic remains local.
location ^~ /api/auth/google/ {
    proxy_pass http://$overseas_ip:8080/api/auth/google/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 60s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

location ^~ /api/oauth/google/ {
    proxy_pass http://$overseas_ip:8080/api/oauth/google/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 60s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

location ^~ /api/login/oauth2/ {
    proxy_pass http://$overseas_ip:8080/api/login/oauth2/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 60s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

location ^~ /oauth2/ {
    proxy_pass http://$overseas_ip:8080/oauth2/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 60s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
EOF

echo "Overseas routes enabled -> $overseas_ip:8080"
'@
    return $script.Replace("__OVERSEAS_IP__", $ip)
}

function Sync-Overseas-Routes-A {
    SSH-A (Get-Overseas-Routes-Script)
}

function Sync-Overseas-Routes-B {
    SSH-B (Get-Overseas-Routes-Script)
}

function Reload-Nginx {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Updating Nginx Config on Server A" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $nginxConf = "$WORKSPACE\deploy\nginx-muhugochat.conf"
    if (-not (Test-Path $nginxConf)) {
        Write-Host "ERROR: nginx config not found: $nginxConf" -ForegroundColor Red
        return
    }

    Write-Host "Uploading nginx config to $HOST_A_IP..." -ForegroundColor Cyan
    SCP-To-A $nginxConf "/tmp/nginx-muhugochat.conf"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp failed" -ForegroundColor Red
        return
    }
    Sync-Overseas-Routes-A
    if ($LASTEXITCODE -ne 0) {
        Write-Host "sync overseas routes failed" -ForegroundColor Red
        return
    }

    $remoteCmd = @'
set -euo pipefail
backup="/etc/nginx/sites-available/muhugochat.bak.$(date +%Y%m%d%H%M%S)"
if [ -f /etc/nginx/sites-available/muhugochat ]; then
  cp /etc/nginx/sites-available/muhugochat "$backup"
  echo "Backup: $backup"
fi
cp /tmp/nginx-muhugochat.conf /etc/nginx/sites-available/muhugochat
ln -sf /etc/nginx/sites-available/muhugochat /etc/nginx/sites-enabled/muhugochat
nginx -t
systemctl reload nginx
echo "Nginx config reloaded"
'@

    SSH-A $remoteCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "nginx reload failed; config backup remains on Server A if it existed" -ForegroundColor Red
        return
    }

    Write-Host "Nginx config updated and reloaded OK" -ForegroundColor Green
}

function Reload-Nginx-B {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Updating Nginx Config on Server B" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $nginxConf = "$WORKSPACE\deploy\nginx-muhugochat.conf"
    if (-not (Test-Path $nginxConf)) {
        Write-Host "ERROR: nginx config not found: $nginxConf" -ForegroundColor Red
        return
    }

    Write-Host "Uploading nginx config to $HOST_B_IP..." -ForegroundColor Cyan
    SCP-To-B $nginxConf "/tmp/nginx-muhugochat.conf"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp failed" -ForegroundColor Red
        return
    }
    Sync-Overseas-Routes-B
    if ($LASTEXITCODE -ne 0) {
        Write-Host "sync overseas routes failed" -ForegroundColor Red
        return
    }

    $remoteCmd = @'
set -euo pipefail
backup="/etc/nginx/sites-available/muhugochat.bak.$(date +%Y%m%d%H%M%S)"
if [ -f /etc/nginx/sites-available/muhugochat ]; then
  cp /etc/nginx/sites-available/muhugochat "$backup"
  echo "Backup: $backup"
fi
cp /tmp/nginx-muhugochat.conf /etc/nginx/sites-available/muhugochat
ln -sf /etc/nginx/sites-available/muhugochat /etc/nginx/sites-enabled/muhugochat
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "Nginx config reloaded on Server B"
'@

    SSH-B $remoteCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "nginx reload failed; config backup remains on Server B if it existed" -ForegroundColor Red
        return
    }

    Write-Host "Nginx config updated and reloaded OK on Server B" -ForegroundColor Green
}

function Build-Backend {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Building MuhugoChat Java Backend"       -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $backendDir = "$WORKSPACE\backend"
    if (-not (Test-Path $backendDir)) {
        Write-Host "ERROR: $backendDir not found" -ForegroundColor Red
        return
    }

    Set-Location $backendDir
    try {
        Write-Host "Maven clean package (skip tests)..." -ForegroundColor Cyan
        & $MVN_EXE clean package -DskipTests -q
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Maven build failed (exit code: $LASTEXITCODE)" -ForegroundColor Red
            return
        }

        $jar = Get-ChildItem "$backendDir\target\*.jar" -Exclude "*sources*","*javadoc*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $jar) {
            Write-Host "ERROR: JAR not found in target/" -ForegroundColor Red
            return
        }
        Write-Host "Build OK: $($jar.Name) ($([math]::Round($jar.Length/1MB, 1)) MB)" -ForegroundColor Green
    } finally {
        Set-Location $WORKSPACE\deploy
    }
}

function Upload-Backend {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Deploying Backend to Server A"          -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $backendDir = "$WORKSPACE\backend"
    $jar = Get-ChildItem "$backendDir\target\*.jar" -Exclude "*sources*","*javadoc*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $jar) {
        Write-Host "ERROR: JAR not found in target/, run build-backend first" -ForegroundColor Red
        return
    }

    $jarName = $jar.Name
    Write-Host "JAR: $($jar.FullName)" -ForegroundColor Cyan

    Write-Host "Uploading $jarName to $HOST_A_IP ..." -ForegroundColor Cyan
    SCP-To-A $jar.FullName "/opt/muhugochat/backend-new.jar"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp failed" -ForegroundColor Red
        return
    }

    $runnerPath = "$backendDir\skill_runner.py"
    if (Test-Path $runnerPath) {
        Write-Host "Uploading skill_runner.py ..." -ForegroundColor Cyan
        SCP-To-A $runnerPath "/opt/muhugochat/skill_runner.py"
    }

    Write-Host "Stopping service..." -ForegroundColor Cyan
    SSH-A "systemctl stop muhugochat 2>/dev/null; sleep 1"

    Write-Host "Replacing JAR..." -ForegroundColor Cyan
    $replaceJar = @'
set -e
test -d /opt/muhugochat
test -f /opt/muhugochat/backend-new.jar
mv -f /opt/muhugochat/backend-new.jar /opt/muhugochat/backend.jar
chmod 644 /opt/muhugochat/backend.jar
ls -lh /opt/muhugochat/backend.jar
'@
    SSH-A $replaceJar
    if ($LASTEXITCODE -ne 0) {
        Write-Host "replace JAR failed" -ForegroundColor Red
        return
    }

    Write-Host "Starting service and waiting for port 8080..." -ForegroundColor Cyan
    $healthCheck = @'
set -e
systemctl restart muhugochat

for i in $(seq 1 45); do
  if ss -lntp | grep -q ':8080\b'; then
    echo "OK: muhugochat is listening on 8080"
    echo "== local HTTP probe =="
    curl -sS -m 3 -I http://127.0.0.1:8080/api/ 2>&1 | head -n 8 || true
    exit 0
  fi

  if ! systemctl is-active --quiet muhugochat; then
    echo "ERROR: muhugochat exited before 8080 became ready" >&2
    break
  fi

  sleep 1
done

echo "ERROR: muhugochat did not listen on 8080 after restart" >&2
echo "== service status ==" >&2
systemctl status muhugochat --no-pager >&2 || true
echo "== recent journal ==" >&2
journalctl -u muhugochat --no-pager -n 160 >&2 || true
echo "== app log ==" >&2
tail -n 160 /opt/muhugochat/app.log >&2 2>/dev/null || true
echo "== service environment ==" >&2
systemctl show muhugochat -p Environment >&2 || true
echo "== listening ports ==" >&2
ss -lntp | grep -E ':(80|8000|8080)\b' >&2 || true
exit 1
'@
    SSH-A $healthCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Backend deploy failed health check. See diagnostics above." -ForegroundColor Red
        return
    }

    Write-Host "Backend deployed & listening on 8080" -ForegroundColor Green
}

function Init-Backend-Overseas {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Init Overseas Backend Node" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    if (-not $HOST_OVERSEAS_IP -and -not $SSH_ALIAS_OVERSEAS) {
        Write-Host "ERROR: configure HOST_OVERSEAS_IP or MUHUGO_OVERSEAS_IP first" -ForegroundColor Red
        return
    }

    $script = @'
set -e
apt-get update -qq
apt-get install -y openjdk-17-jdk curl lsof ca-certificates >/tmp/muhugo-overseas-init-apt.log 2>&1 || {
  echo "apt install failed, see /tmp/muhugo-overseas-init-apt.log" >&2
  tail -n 120 /tmp/muhugo-overseas-init-apt.log >&2 || true
  exit 1
}

mkdir -p /opt/muhugochat /opt/muhugochat/logs

cat > /etc/systemd/system/muhugochat.service << 'SVCEOF'
[Unit]
Description=MuHuoGoChat Java Backend Overseas Node
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/muhugochat
Environment="JAVA_OPTS=-Xmx900m -Xms256m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -Dspring.profiles.active=prod -DDB_HOST=__DB_HOST__ -DDB_PORT=__DB_PORT__ -DDB_NAME=__DB_NAME__ -DDB_USERNAME=__DB_USER__ -DDB_PASSWORD=__DB_PASS__"
Environment="INTERNAL_API_KEY=__INTERNAL_API_KEY__"
Environment="MUHUGOCHAT_INTERNAL_API_KEY=__INTERNAL_API_KEY__"
Environment="CACHE_LEDGER_BASE_URL=__CACHE_LEDGER_BASE_URL__"
Environment="CORS_ALLOWED_ORIGINS=https://muhuo.cloud,https://www.muhuo.cloud,http://muhuo.cloud,http://www.muhuo.cloud"
ExecStart=/bin/bash -lc 'exec java $JAVA_OPTS -jar /opt/muhugochat/backend.jar'
Restart=always
RestartSec=5
StandardOutput=append:/opt/muhugochat/app.log
StandardError=append:/opt/muhugochat/app.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable muhugochat
ufw allow from __HOST_A_IP__ to any port 8080 proto tcp 2>/dev/null || true
echo "Overseas backend node initialized. Upload backend jar next."
'@
    $script = $script.Replace("__DB_HOST__", $DB_HOST).
        Replace("__DB_PORT__", $DB_PORT).
        Replace("__DB_NAME__", $DB_NAME).
        Replace("__DB_USER__", $DB_USER).
        Replace("__DB_PASS__", $DB_PASS).
        Replace("__INTERNAL_API_KEY__", $INTERNAL_API_KEY).
        Replace("__CACHE_LEDGER_BASE_URL__", $CACHE_LEDGER_BASE_URL).
        Replace("__HOST_A_IP__", $HOST_A_IP)
    SSH-Overseas $script
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Overseas backend init failed" -ForegroundColor Red
        return
    }
    Write-Host "Overseas backend init OK" -ForegroundColor Green
}

function Upload-Backend-Overseas {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Deploying Backend to Overseas Node" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    if (-not $HOST_OVERSEAS_IP -and -not $SSH_ALIAS_OVERSEAS) {
        Write-Host "ERROR: configure HOST_OVERSEAS_IP or MUHUGO_OVERSEAS_IP first" -ForegroundColor Red
        return
    }

    $backendDir = "$WORKSPACE\backend"
    $jar = Get-ChildItem "$backendDir\target\*.jar" -Exclude "*sources*","*javadoc*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $jar) {
        Write-Host "ERROR: JAR not found in target/, run build-backend first" -ForegroundColor Red
        return
    }

    Write-Host "JAR: $($jar.FullName)" -ForegroundColor Cyan
    Write-Host "Uploading backend jar to overseas node..." -ForegroundColor Cyan
    SCP-To-Overseas $jar.FullName "/opt/muhugochat/backend-new.jar"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp jar failed" -ForegroundColor Red
        return
    }

    $runnerPath = "$backendDir\skill_runner.py"
    if (Test-Path $runnerPath) {
        Write-Host "Uploading skill_runner.py to overseas node..." -ForegroundColor Cyan
        SCP-To-Overseas $runnerPath "/opt/muhugochat/skill_runner.py"
    }

    $healthCheck = @'
set -e
test -d /opt/muhugochat
test -f /opt/muhugochat/backend-new.jar
mv -f /opt/muhugochat/backend-new.jar /opt/muhugochat/backend.jar
chmod 644 /opt/muhugochat/backend.jar
systemctl restart muhugochat

for i in $(seq 1 45); do
  if ss -lntp | grep -q ':8080\b'; then
    echo "OK: overseas muhugochat is listening on 8080"
    curl -sS -m 5 -I http://127.0.0.1:8080/api/ 2>&1 | head -n 8 || true
    exit 0
  fi
  if ! systemctl is-active --quiet muhugochat; then
    echo "ERROR: muhugochat exited before 8080 became ready" >&2
    break
  fi
  sleep 1
done

echo "ERROR: overseas muhugochat did not listen on 8080" >&2
systemctl status muhugochat --no-pager >&2 || true
journalctl -u muhugochat --no-pager -n 120 >&2 || true
tail -n 160 /opt/muhugochat/app.log >&2 2>/dev/null || true
exit 1
'@
    SSH-Overseas $healthCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Overseas backend deploy failed health check" -ForegroundColor Red
        return
    }
    Write-Host "Overseas backend deployed & listening on 8080" -ForegroundColor Green
}

function Check-Backend-Overseas {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Checking Overseas Backend Node" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    SSH-Overseas @'
echo "muhugochat: $(systemctl is-active muhugochat 2>/dev/null || true)"
ss -lntp | grep -E ':(8080)\b' || true
curl -sS -m 5 -I http://127.0.0.1:8080/api/ 2>&1 | head -n 12 || true
echo "== recent logs =="
journalctl -u muhugochat --no-pager -n 80 || true
'@
}

function Migrate-DB {
    param([string]$SqlFile)

    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Database Migration (Server C MySQL)"   -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $sqlFile = $SqlFile
    if (-not $sqlFile) {
        Write-Host "Available SQL files in deploy\:" -ForegroundColor Cyan
        Get-ChildItem "$WORKSPACE\deploy\*.sql" | ForEach-Object { Write-Host "  $($_.Name)" }
        Write-Host ""
        Write-Host "Also available at project root:" -ForegroundColor Cyan
        Get-ChildItem "$WORKSPACE\*.sql" | ForEach-Object { Write-Host "  $($_.Name)" }
        Write-Host ""
        Write-Host "Usage: .\deploy.ps1 migrate-db <sql_file_path>" -ForegroundColor Yellow
        Write-Host "  e.g: .\deploy.ps1 migrate-db deploy\rbac_migration.sql" -ForegroundColor Yellow
        Write-Host "  e.g: .\deploy.ps1 migrate-db ..\migration.sql" -ForegroundColor Yellow
        return
    }

    if (-not (Test-Path $sqlFile)) {
        $candidate = Join-Path $WORKSPACE $sqlFile
        if (Test-Path $candidate) {
            $sqlFile = $candidate
        }
    }
    if (-not (Test-Path $sqlFile)) {
        $candidate = Join-Path "$WORKSPACE\deploy" $sqlFile
        if (Test-Path $candidate) {
            $sqlFile = $candidate
        }
    }
    if (-not (Test-Path $sqlFile)) {
        Write-Host "ERROR: SQL file not found: $sqlFile" -ForegroundColor Red
        return
    }

    $fileName = Split-Path $sqlFile -Leaf
    $remotePath = "/tmp/db_migration_$fileName"

    Write-Host "SQL file: $sqlFile" -ForegroundColor Cyan
    Write-Host "Target:   ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}" -ForegroundColor Cyan

    # Upload SQL to Server C and execute it on the MySQL host itself.
    Write-Host "Uploading to Server C..." -ForegroundColor Cyan
    Invoke-SCP-ByIP $sqlFile $DB_HOST $remotePath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp failed" -ForegroundColor Red
        return
    }

    Write-Host "Executing migration..." -ForegroundColor Cyan
    $remoteCmd = @"
set -euo pipefail
remote_sql='$remotePath'
db_host='$DB_HOST'
db_port='$DB_PORT'
db_user='$DB_USER'
db_pass='$DB_PASS'
db_name='$DB_NAME'

cleanup() {
  rm -f "`$remote_sql"
}
trap cleanup EXIT

if command -v mysql >/dev/null 2>&1; then
  mysql -h 127.0.0.1 -P "`$db_port" -u "`$db_user" -p"`$db_pass" "`$db_name" < "`$remote_sql"
elif command -v mariadb >/dev/null 2>&1; then
  mariadb -h 127.0.0.1 -P "`$db_port" -u "`$db_user" -p"`$db_pass" "`$db_name" < "`$remote_sql"
else
  echo "ERROR: mysql/mariadb client not found on Server C." >&2
  exit 127
fi
"@
    Invoke-SSH-ByIP $DB_HOST $remoteCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Migration failed (exit code: $LASTEXITCODE)" -ForegroundColor Red
        return
    }

    Write-Host "Migration completed OK" -ForegroundColor Green

    Write-Host "Verifying key tables..." -ForegroundColor Cyan
    Invoke-Remote-MySql "SELECT table_name FROM information_schema.tables WHERE table_schema='$DB_NAME' AND table_name IN ('sys_role','sys_permission','sys_user_role','pay_config','orders','payment_record','refund_record','pay_audit_log','workflow','workflow_execution','workflow_artifact','workflow_execution_step','workflow_execution_event','scenario') ORDER BY table_name;"

    Write-Host "Verifying key columns..." -ForegroundColor Cyan
    Invoke-Remote-MySql "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='$DB_NAME' AND ((table_name='workflow' AND column_name='scenario_id') OR (table_name='subscription_plan' AND column_name IN ('features','role_id')) OR (table_name='subscription' AND column_name='features') OR (table_name='model_channel' AND column_name='tags') OR (table_name='sys_user' AND column_name='balance') OR (table_name='sys_user' AND column_name IN ('cost_used','cost_limit')) OR (table_name='model_config' AND column_name='cached_input_price') OR (table_name='api_log' AND column_name IN ('cached_input_tokens','provider','channel_id','request_ip')) OR (table_name='model_routing_rule' AND column_name IN ('user_id','rule_name','required_tags','preferred_providers','min_context_length','max_input_price','max_output_price','deleted')) OR (table_name='model_routing_stats' AND column_name IN ('total_calls','success_calls','failed_calls','avg_response_time','last_success_at','last_failure_at','circuit_breaker_state','deleted'))) ORDER BY table_name,column_name;"
}

function Recover-Backend-Env {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Recover Backend Env & Restart"         -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $jwtSecret = if ($env:JWT_SECRET) { $env:JWT_SECRET } else { "change-this-to-a-very-long-random-secret-key-at-least-64-characters" }
    $payAesKey = if ($env:PAY_AES_KEY) { $env:PAY_AES_KEY } else { "change-this-to-a-32-byte-or-longer-random-secret" }
    $corsOrigins = "https://muhuo.cloud,https://www.muhuo.cloud,http://muhuo.cloud,http://your-server-b-ip,http://your-server-b-ip:8000"
    $internalKey = $INTERNAL_API_KEY
    $cacheLedgerUrl = $CACHE_LEDGER_BASE_URL
    if ($HOST_A_IP -eq $HOST_B_IP) {
        $muhugoApiUrl = "http://127.0.0.1:8080/api/admin"
    } else {
        $muhugoApiUrl = "http://$HOST_A_IP:8080/api/admin"
    }

    $remoteCmd = "mkdir -p /etc/systemd/system/muhugochat.service.d; " +
                 "printf '%s\n' '[Service]' 'Environment=""JWT_SECRET=$jwtSecret""' 'Environment=""PAY_AES_KEY=$payAesKey""' 'Environment=""CORS_ALLOWED_ORIGINS=$corsOrigins""' 'Environment=""MUHUGOCHAT_INTERNAL_API_KEY=$internalKey""' 'Environment=""INTERNAL_API_KEY=$internalKey""' 'Environment=""CACHE_LEDGER_BASE_URL=$cacheLedgerUrl""' > /etc/systemd/system/muhugochat.service.d/override.conf; " +
                 "systemctl daemon-reload; systemctl restart muhugochat; sleep 3; systemctl is-active muhugochat; journalctl -u muhugochat --no-pager -n 50"

    SSH-A $remoteCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Java backend env recovery failed; AutoCode env was not changed." -ForegroundColor Red
        return
    }

    Write-Host "Syncing AutoCode bridge env on Server B..." -ForegroundColor Cyan
    $syncAutoCode = @"
set -e
mkdir -p /opt/autocode
touch /opt/autocode/.env
cp /opt/autocode/.env /opt/autocode/.env.bak.$(date +%Y%m%d%H%M%S)
awk '/^[[:space:]]*($|#|[A-Za-z_][A-Za-z0-9_]*=)/ { print }' /opt/autocode/.env > /opt/autocode/.env.clean
mv /opt/autocode/.env.clean /opt/autocode/.env
set_env() {
  key="`$1"
  value="`$2"
  if grep -qE "^`${key}=" /opt/autocode/.env; then
    sed -i "s|^`${key}=.*|`${key}=`${value}|" /opt/autocode/.env
  else
    printf '%s=%s\n' "`$key" "`$value" >> /opt/autocode/.env
  fi
}
set_env MUHUGOCHAT_API_URL "$muhugoApiUrl"
set_env MUHUGOCHAT_INTERNAL_API_KEY "$internalKey"
set_env INTERNAL_API_KEY "$internalKey"
set_env CACHE_LEDGER_BASE_URL "$cacheLedgerUrl"
set_env AUTOCODE_LLM_VIA_MUHUGOCHAT "true"
echo "AutoCode bridge env synced:"
grep -E '^(MUHUGOCHAT_API_URL|MUHUGOCHAT_INTERNAL_API_KEY|INTERNAL_API_KEY|CACHE_LEDGER_BASE_URL|AUTOCODE_LLM_VIA_MUHUGOCHAT)=' /opt/autocode/.env | sed -E 's/(KEY)=.*/\1=*** set ***/'
if systemctl list-unit-files autocode.service >/dev/null 2>&1; then
  systemctl restart autocode
  sleep 3
  systemctl is-active autocode
else
  echo "WARN: autocode.service not found; skipped AutoCode restart"
fi
"@
    SSH-B $syncAutoCode
    if ($LASTEXITCODE -ne 0) {
        Write-Host "AutoCode bridge env sync failed" -ForegroundColor Red
        return
    }

    Check-AutoCode-Bridge
}

function Init-ServerC {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Init Server C: MySQL ($DB_HOST)"       -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    Write-Host "WARNING: This will install/configure MySQL on Server C" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C within 5s to abort..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    $script = @'
set -e
echo "[1/4] Installing MySQL 8.0..."
apt-get update -qq && apt-get install -y mysql-server && systemctl enable mysql
echo "MySQL installed: $(mysql --version)"

echo "[2/4] Writing my.cnf (2C2G optimized)..."
cat > /etc/mysql/mysql.conf.d/mysqld.cnf << 'MYEOF'
[mysqld]
pid-file  = /var/run/mysqld/mysqld.pid
socket    = /var/run/mysqld/mysqld.sock
datadir   = /var/lib/mysql
log-error = /var/log/mysql/error.log

bind-address = 0.0.0.0
mysqlx-bind-address = 0.0.0.0

innodb_buffer_pool_size = 768M
innodb_log_buffer_size = 16M
key_buffer_size = 32M
tmp_table_size = 64M
max_heap_table_size = 64M
sort_buffer_size = 2M
read_buffer_size = 1M
join_buffer_size = 2M

max_connections = 80
thread_cache_size = 16
wait_timeout = 600
interactive_timeout = 600

innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT
innodb_file_per_table = 1
innodb_io_capacity = 200
innodb_io_capacity_max = 2000

slow_query_log = 1
long_query_time = 2

character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci

[client]
default-character-set = utf8mb4
MYEOF

echo "[3/4] Restarting MySQL..."
systemctl restart mysql

echo "[4/4] Creating database & users..."
mysql -u root << SQL
CREATE DATABASE IF NOT EXISTS MuHuoAi DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'muhuoai'@'%' IDENTIFIED BY 'changeme';
GRANT ALL PRIVILEGES ON MuHuoAi.* TO 'muhuoai'@'%';
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY 'changeme';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SELECT 'DB init OK' AS status;
SQL

echo "=== Server C init complete ==="
echo "MySQL is listening on all interfaces, DB: MuHuoAi, User: muhuoai"
'@

    Invoke-SSH-ByIP $DB_HOST $script
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Server C init FAILED" -ForegroundColor Red
        return
    }
    Write-Host "Server C init OK" -ForegroundColor Green
}

function Check-DB-Disk {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Check Server C Disk / MySQL Temp Space" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    $script = @'
set -e
echo "== host =="
hostname
date

echo "== disk =="
df -h

echo "== inode =="
df -ih

echo "== /tmp usage =="
du -sh /tmp 2>/dev/null || true
find /tmp -maxdepth 1 -mindepth 1 -printf '%s %p\n' 2>/dev/null | sort -n | tail -30 | awk '{ size=$1; $1=""; printf "%.1fM %s\n", size/1024/1024, $0 }' || true

echo "== largest top-level dirs =="
du -xh / 2>/dev/null | sort -h | tail -40 || true

echo "== mysql status =="
systemctl is-active mysql 2>/dev/null || systemctl is-active mysqld 2>/dev/null || true
systemctl status mysql --no-pager 2>/dev/null || systemctl status mysqld --no-pager 2>/dev/null || true
mysql --version 2>/dev/null || true

echo "== mysql datadir/log hints =="
du -sh /var/lib/mysql 2>/dev/null || true
du -sh /var/log/mysql 2>/dev/null || true
ls -lh /var/lib/mysql 2>/dev/null | tail -40 || true

echo "== mysql recent journal =="
journalctl -u mysql --no-pager -n 160 2>/dev/null || journalctl -u mysqld --no-pager -n 160 2>/dev/null || true

echo "== mysql error log =="
tail -n 220 /var/log/mysql/error.log 2>/dev/null || tail -n 220 /var/log/mysqld.log 2>/dev/null || true

echo "== mysql config snippets =="
grep -R "tmpdir\|datadir\|log-error\|bind-address\|port\|expire_logs\|binlog" -n /etc/mysql/mysql.conf.d /etc/mysql/conf.d 2>/dev/null || true

echo "== mysql tmp/binlog candidates =="
du -sh /var/lib/mysql-tmp 2>/dev/null || true
find /var/lib/mysql -maxdepth 1 -type f \( -name 'binlog.*' -o -name 'mysql-bin.*' -o -name '#sql*' \) -printf '%s %p\n' 2>/dev/null | sort -n | tail -40 | awk '{ size=$1; $1=""; printf "%.1fM %s\n", size/1024/1024, $0 }' || true
'@

    Invoke-SSH-ByIP $DB_HOST $script
}

function Repair-DB-Disk-Safe {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Safe Repair Server C Disk Space"       -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Target DB host: $DB_HOST" -ForegroundColor Cyan
    Write-Host "This cleans apt cache, old journal logs, and old /tmp files only." -ForegroundColor Yellow
    Write-Host "It does NOT delete MySQL data files. Press Ctrl+C within 5s to abort..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    $script = @'
set -e
echo "== before =="
df -h
df -ih
du -sh /tmp 2>/dev/null || true
du -sh /var/log/journal 2>/dev/null || true
du -sh /var/cache/apt 2>/dev/null || true

echo "== cleanup apt cache =="
apt-get clean || true
rm -rf /var/cache/apt/archives/*.deb 2>/dev/null || true

echo "== cleanup journal =="
journalctl --vacuum-time=3d || true
journalctl --vacuum-size=300M || true

echo "== cleanup old MySQL temp files in /tmp =="
find /tmp -maxdepth 1 -type f \( -name 'MY*' -o -name 'ML*' -o -name '#sql*' \) -mmin +60 -print -delete 2>/dev/null || true

echo "== cleanup old generic temp files =="
find /tmp -maxdepth 1 -type f -mtime +2 -print -delete 2>/dev/null || true
find /tmp -maxdepth 1 -type d -name 'tmp*' -mtime +2 -print -exec rm -rf {} + 2>/dev/null || true

echo "== repair MySQL tmpdir if it points outside datadir =="
mkdir -p /var/lib/mysql/mysql-tmp
chown mysql:mysql /var/lib/mysql/mysql-tmp 2>/dev/null || true
chmod 750 /var/lib/mysql/mysql-tmp 2>/dev/null || true
if grep -Rqs '^tmpdir[[:space:]]*=[[:space:]]*/var/lib/mysql-tmp' /etc/mysql/mysql.conf.d /etc/mysql/conf.d; then
  sed -i 's#^tmpdir[[:space:]]*=.*#tmpdir = /var/lib/mysql/mysql-tmp#g' /etc/mysql/mysql.conf.d/*.cnf /etc/mysql/conf.d/*.cnf 2>/dev/null || true
  echo "tmpdir changed to /var/lib/mysql/mysql-tmp"
fi

echo "== after =="
df -h
df -ih
du -sh /tmp 2>/dev/null || true
du -sh /var/lib/mysql/mysql-tmp 2>/dev/null || true

echo "== mysql restart check =="
systemctl reset-failed mysql 2>/dev/null || systemctl reset-failed mysqld 2>/dev/null || true
systemctl restart mysql 2>/dev/null || systemctl restart mysqld 2>/dev/null || true
sleep 2
systemctl is-active mysql 2>/dev/null || systemctl is-active mysqld 2>/dev/null || true
mysql -u root -e "SELECT 1 AS ok;" 2>/dev/null || true
'@

    Invoke-SSH-ByIP $DB_HOST $script
}

function Optimize-DB-ServerC {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Optimize Server C as MySQL-only Host"  -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Target DB host: $DB_HOST" -ForegroundColor Cyan
    Write-Host "This configures MySQL binlog expiry and prunes unused Docker data." -ForegroundColor Yellow
    Write-Host "It does NOT remove Docker volumes or MySQL data files. Press Ctrl+C within 5s to abort..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    $script = @'
set -e
echo "== before =="
df -h
du -sh /var/lib/docker 2>/dev/null || true
du -sh /var/lib/mysql 2>/dev/null || true

echo "== configure MySQL storage policy =="
mkdir -p /var/lib/mysql/mysql-tmp
chown mysql:mysql /var/lib/mysql/mysql-tmp 2>/dev/null || true
chmod 750 /var/lib/mysql/mysql-tmp 2>/dev/null || true

cat > /etc/mysql/mysql.conf.d/99-autocode-storage.cnf << 'MYEOF'
[mysqld]
binlog_expire_logs_seconds = 259200
max_binlog_size = 128M
tmpdir = /var/lib/mysql/mysql-tmp
tmp_table_size = 64M
max_heap_table_size = 64M
slow_query_log = 1
long_query_time = 2
MYEOF

systemctl restart mysql 2>/dev/null || systemctl restart mysqld 2>/dev/null || true
sleep 2
systemctl is-active mysql 2>/dev/null || systemctl is-active mysqld 2>/dev/null || true

echo "== purge old MySQL binlogs =="
mysql -u root -e "SET GLOBAL binlog_expire_logs_seconds = 259200;" 2>/dev/null || true
mysql -u root -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 3 DAY;" 2>/dev/null || true
mysql -u root -e "SHOW BINARY LOGS;" 2>/dev/null || true

echo "== Docker usage on DB host =="
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'running: {{.ID}} {{.Image}} {{.Names}}' || true
  docker system df || true
  docker system prune -af || true
  docker builder prune -af || true
  docker system df || true
else
  echo "docker not installed"
fi

echo "== install weekly conservative cleanup timer =="
cat > /usr/local/sbin/autocode-db-host-cleanup.sh << 'CLEOF'
#!/bin/bash
set -e
apt-get clean || true
journalctl --vacuum-time=7d || true
find /tmp -maxdepth 1 -type f \( -name 'MY*' -o -name 'ML*' -o -name '#sql*' \) -mmin +120 -delete 2>/dev/null || true
if command -v docker >/dev/null 2>&1; then
  docker system prune -af --filter "until=168h" || true
  docker builder prune -af --filter "until=168h" || true
fi
mysql -u root -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 3 DAY;" 2>/dev/null || true
CLEOF
chmod +x /usr/local/sbin/autocode-db-host-cleanup.sh

cat > /etc/systemd/system/autocode-db-host-cleanup.service << 'SVCEOF'
[Unit]
Description=AutoCode DB host conservative cleanup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/autocode-db-host-cleanup.sh
SVCEOF

cat > /etc/systemd/system/autocode-db-host-cleanup.timer << 'TIMEREOF'
[Unit]
Description=Run AutoCode DB host cleanup weekly

[Timer]
OnCalendar=Sun 04:30
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable --now autocode-db-host-cleanup.timer

echo "== after =="
df -h
du -sh /var/lib/docker 2>/dev/null || true
du -sh /var/lib/mysql 2>/dev/null || true
'@

    Invoke-SSH-ByIP $DB_HOST $script
}

function Optimize-ServerB-Cleanup {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Optimize Server B Docker Cleanup"      -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Target: $HOST_B_IP ($SSH_ALIAS_B)" -ForegroundColor Cyan

    $script = @'
set -e
echo "== before =="
df -h
docker system df 2>/dev/null || true

cat > /usr/local/sbin/autocode-server-b-cleanup.sh << 'CLEOF'
#!/bin/bash
set -e
apt-get clean || true
journalctl --vacuum-time=7d || true
if command -v docker >/dev/null 2>&1; then
  docker system prune -af --filter "until=72h" || true
  docker builder prune -af --filter "until=72h" || true
fi
find /tmp -maxdepth 1 -type f -mtime +2 -delete 2>/dev/null || true
find /var/log/autocode -type f -name '*.log.*' -mtime +14 -delete 2>/dev/null || true
find /var/log/autocode/task-archives -type f -name '*.overflow.json' -mtime +30 -delete 2>/dev/null || true
CLEOF
chmod +x /usr/local/sbin/autocode-server-b-cleanup.sh

cat > /etc/systemd/system/autocode-server-b-cleanup.service << 'SVCEOF'
[Unit]
Description=AutoCode Server B Docker and cache cleanup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/autocode-server-b-cleanup.sh
SVCEOF

cat > /etc/systemd/system/autocode-server-b-cleanup.timer << 'TIMEREOF'
[Unit]
Description=Run AutoCode Server B cleanup daily

[Timer]
OnCalendar=*-*-* 04:15:00
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable --now autocode-server-b-cleanup.timer
/usr/local/sbin/autocode-server-b-cleanup.sh || true

echo "== timers =="
systemctl list-timers 'autocode-*cleanup*' --no-pager || true
echo "== after =="
df -h
docker system df 2>/dev/null || true
'@

    SSH-B $script
}

function Init-ServerA {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Init Server A: Java + Nginx ($HOST_A_IP)" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    Write-Host "WARNING: This will install Java17+Nginx on Server A" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C within 5s to abort..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    $script = @"
set -e

echo '[1/5] Installing Java 17 + Nginx...'
apt-get update -qq && apt-get install -y openjdk-17-jdk nginx && systemctl enable nginx
java -version 2>&1 | head -1

echo '[2/5] Creating app directories...'
mkdir -p /opt/muhugochat /opt/muhugochat/logs /var/www/muhugochat-frontend ${AUTOCODE_FE_DIR}

echo '[3/5] Writing start.sh...'
cat > /opt/muhugochat/start.sh << 'STARTEOF'
#!/bin/bash
if [ -f /opt/muhugochat/app.pid ]; then
    old_pid=`$(cat /opt/muhugochat/app.pid)
    if kill -0 `$old_pid 2>/dev/null; then
        kill `$old_pid
        sleep 3
    fi
    rm -f /opt/muhugochat/app.pid
fi

export JAVA_OPTS="-Xmx800m -Xms256m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/opt/muhugochat/heapdump -Dspring.profiles.active=prod -DDB_HOST=${DB_HOST} -DDB_PORT=${DB_PORT} -DDB_NAME=${DB_NAME} -DDB_USERNAME=${DB_USER} -DDB_PASSWORD=${DB_PASS}"

cd /opt/muhugochat
nohup java `$JAVA_OPTS -jar backend.jar > /opt/muhugochat/app.log 2>&1 &
echo `$! > /opt/muhugochat/app.pid
echo "Started with PID `$!"
STARTEOF
chmod +x /opt/muhugochat/start.sh

echo '[4/5] Writing systemd service...'
cat > /etc/systemd/system/muhugochat.service << 'SVCEOF'
[Unit]
Description=MuhugoChat Java Backend
After=network.target

[Service]
Type=forking
User=root
WorkingDirectory=/opt/muhugochat
ExecStart=/opt/muhugochat/start.sh
ExecStop=/bin/kill -TERM `$MAINPID
Restart=on-failure
RestartSec=10
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable muhugochat

echo '[5/6] Writing env override (JWT + PAY_AES_KEY + CORS)...'
mkdir -p /etc/systemd/system/muhugochat.service.d
cat > /etc/systemd/system/muhugochat.service.d/override.conf << 'ENVEOF'
[Service]
Environment="JWT_SECRET=change-this-to-a-very-long-random-secret-key-at-least-64-characters"
Environment="PAY_AES_KEY=change-this-to-a-32-byte-or-longer-random-secret"
Environment="CORS_ALLOWED_ORIGINS=https://muhuo.cloud,https://www.muhuo.cloud,http://muhuo.cloud,http://your-server-b-ip"
Environment="MUHUGOCHAT_INTERNAL_API_KEY=${INTERNAL_API_KEY}"
Environment="INTERNAL_API_KEY=${INTERNAL_API_KEY}"
Environment="CACHE_LEDGER_BASE_URL=${CACHE_LEDGER_BASE_URL}"
ENVEOF
systemctl daemon-reload
echo 'env override written'

echo '[6/6] Writing Nginx config...'
cat > /etc/nginx/sites-available/muhugochat << 'NGINXEOF'
server {
    listen 80;
    server_name _;
    client_max_body_size 1024m;

    location = /aucode {
        return 301 /autocode/;
    }

    location ^~ /aucode/ {
        return 301 /autocode/;
    }

    location = /autocode {
        return 301 /autocode/;
    }

    location ^~ /autocode/_next/static/ {
        alias ${AUTOCODE_FE_DIR}/_next/static/;
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
        access_log off;
    }

    location ^~ /autocode/tasks/ {
        alias ${AUTOCODE_FE_DIR}/tasks/;
        try_files index.html =404;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    location ^~ /autocode/ {
        alias ${AUTOCODE_FE_DIR}/;
        try_files `$uri `$uri/ /index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # Workspace preview fallback for Next.js runtime chunks that still resolve
    # to domain-root /_next/static/... after client-side navigation.
    location ^~ /_next/static/ {
        proxy_pass http://127.0.0.1:8000/_next/static/;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_set_header X-Forwarded-Prefix /autocode-api;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # Learning docs site. VitePress is built with base=/learn/.
    location ^~ /learn/ {
        alias /var/www/muhugochat-frontend/learn/;
        try_files `$uri `$uri/ /learn/index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    location ^~ /v1/ {
        proxy_pass http://127.0.0.1:8080/v1/;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 300s;
        proxy_send_timeout 900s;
        proxy_buffering off;
        proxy_cache off;
    }

    location / {
        root /var/www/muhugochat-frontend;
        try_files `$uri `$uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # Optional overseas API routes. deploy.ps1 reload-nginx generates this
    # snippet only when HOST_OVERSEAS_IP / MUHUGO_OVERSEAS_IP is configured.
    include /etc/nginx/snippets/muhugochat-overseas-routes.conf;

    location /api/chat/stream {
        proxy_pass http://127.0.0.1:8080/api/chat/stream;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 300s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080/api/;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 300s;
        proxy_send_timeout 900s;
    }

    location /api/workflow-artifacts/ {
        proxy_pass http://127.0.0.1:8080/api/workflow-artifacts/;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        proxy_request_buffering off;
    }

    location ^~ /workspaces/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_set_header X-Forwarded-Prefix /autocode-api;
        proxy_http_version 1.1;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # Keep AutoCode API and workspace preview assets on the backend proxy.
    # Without ^~, nginx can route preview .js/.css files to the generic static
    # asset regex below and return an nginx 404 before FastAPI sees the request.
    location ^~ /autocode-api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host `$host;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Prefix /autocode-api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade `$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
NGINXEOF

mkdir -p /etc/nginx/snippets
touch /etc/nginx/snippets/muhugochat-overseas-routes.conf
ln -sf /etc/nginx/sites-available/muhugochat /etc/nginx/sites-enabled/muhugochat
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo "=== Server A init complete ==="
echo "Dir: /opt/muhugochat/ | /var/www/muhugochat-frontend/"
echo "Next: deploy.ps1 upload-backend ; deploy.ps1 upload-frontendonly"
"@

    SSH-A $script
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Server A init FAILED" -ForegroundColor Red
        return
    }
    Write-Host "Server A init OK" -ForegroundColor Green
}

function Init-ServerB {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Init Server B: Python + AutoCode ($HOST_B_IP)" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    Write-Host "WARNING: This will install Python3.11+Node on Server B" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C within 5s to abort..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    $script = @"
set -e

echo '[1/5] Installing Python 3.11 + Node.js + Git...'
apt-get update -qq && apt-get install -y python3.11 python3-pip python3-venv nodejs npm git
python3.11 --version && node --version

echo '[2/5] Creating app directories...'
mkdir -p /opt/autocode /data/autocode-workspaces /var/log/autocode

echo '[3/5] Writing .env...'
cat > /opt/autocode/.env << 'ENVEOF'
AUTOCODE_MODEL=deepseek-v4-pro
AUTOCODE_API_KEY=
AUTOCODE_BASE_URL=https://api.deepseek.com
AUTOCODE_PROVIDER=openai
AUTOCODE_PUBLIC_API_BASE=https://muhuo.cloud/autocode-api

MUHUGOCHAT_DB_HOST=${DB_HOST}
MUHUGOCHAT_DB_PORT=${DB_PORT}
MUHUGOCHAT_DB_NAME=${DB_NAME}
MUHUGOCHAT_DB_USER=${DB_USER}
MUHUGOCHAT_DB_PASSWORD=${DB_PASS}
MUHUGOCHAT_API_URL=http://127.0.0.1:8080/api/admin
MUHUGOCHAT_INTERNAL_API_KEY=${INTERNAL_API_KEY}
INTERNAL_API_KEY=${INTERNAL_API_KEY}
AUTOCODE_LLM_VIA_MUHUGOCHAT=true

MAX_CONCURRENT_TASKS=2
WORKSPACE_BASE_DIR=/data/autocode-workspaces
AUTOCODE_WORKSPACE_MAX_SIZE_MB=3072
AUTOCODE_WORKSPACE_CLEANUP_DAYS=7
AUTOCODE_DEV_SERVER_IDLE_TIMEOUT=1800
AUTOCODE_TASK_ARCHIVE_DIR=/var/log/autocode/task-archives
AUTOCODE_TASK_DB_MAX_LOG_ENTRIES=500
AUTOCODE_TASK_DB_MAX_EVENT_ENTRIES=1000
AUTOCODE_TASK_DB_MAX_COMMAND_ENTRIES=200
AUTOCODE_TASK_DB_MAX_STRING_CHARS=12000

GIT_AUTHOR_NAME="AutoCode Agent"
GIT_AUTHOR_EMAIL=agent@autocode.local

LOG_LEVEL=INFO
ENVEOF

echo '[4/5] Writing systemd service...'
cat > /etc/systemd/system/autocode.service << 'SVCEOF'
[Unit]
Description=AutoCode Agent Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/autocode
Environment="PYTHONUNBUFFERED=1"
ExecStartPre=/bin/sleep 2
ExecStart=/opt/autocode/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --ws-ping-interval 60 --ws-ping-timeout 120
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
StandardOutput=append:/var/log/autocode/app.log
StandardError=append:/var/log/autocode/error.log

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable autocode

echo '[5/5] Configuring firewall (allow Server A only)...'
ufw allow from ${HOST_A_IP} to any port 8000 proto tcp 2>/dev/null || iptables -A INPUT -p tcp -s ${HOST_A_IP} --dport 8000 -j ACCEPT
ufw allow from ${HOST_A_IP} to any port 3100:3199 proto tcp 2>/dev/null || iptables -A INPUT -p tcp -s ${HOST_A_IP} --dport 3100:3199 -j ACCEPT

echo "=== Server B init complete ==="
echo "Dir: /opt/autocode/ | Workspaces: /data/autocode-workspaces/"
echo "Next: deploy.ps1 upload-autocode"
echo "      (then SSH in: cd /opt/autocode && python3.11 -m venv venv && venv/bin/pip install -r requirements.txt)"
"@

    SSH-B $script
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Server B init FAILED" -ForegroundColor Red
        return
    }
    Write-Host "Server B init OK" -ForegroundColor Green
}

function Repair-SingleServerB {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Repair Single Server B Runtime"        -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Target: $HOST_B_IP ($SSH_ALIAS_B)" -ForegroundColor Cyan
    Write-Host "This will rewrite nginx/systemd runtime config on Server B." -ForegroundColor Yellow
    Write-Host "Press Ctrl+C within 5s to abort..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    $nginxConf = "$WORKSPACE\deploy\nginx-muhugochat.conf"
    if (-not (Test-Path $nginxConf)) {
        Write-Host "ERROR: nginx config not found: $nginxConf" -ForegroundColor Red
        return
    }

    Write-Host "[local] Uploading nginx config to Server B..." -ForegroundColor Cyan
    SCP-To-B $nginxConf "/tmp/nginx-muhugochat-single.conf"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp nginx config failed" -ForegroundColor Red
        return
    }

    $scriptTemplate = @'
set -u

echo "== [1/8] Install/check base packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y openjdk-17-jdk nginx redis-server python3.11 python3-pip python3-venv nodejs npm git curl lsof >/tmp/autocode-repair-apt.log 2>&1 || {
  echo "WARN: apt install failed, see /tmp/autocode-repair-apt.log"
}

echo "== [2/8] Ensure directories =="
mkdir -p /opt/muhugochat /opt/muhugochat/logs /opt/autocode /data/autocode-workspaces /var/log/autocode /var/log/autocode/task-archives /var/www/muhugochat-frontend /var/www/autocode-frontend

echo "== [3/8] Write MuhugoChat Java service =="
cat > /opt/muhugochat/start.sh << 'STARTEOF'
#!/bin/bash
set -e
cd /opt/muhugochat
if [ ! -f /opt/muhugochat/backend.jar ]; then
  echo "ERROR: /opt/muhugochat/backend.jar not found. Run .\deploy.ps1 upload-backend first." >&2
  exit 66
fi
exec java $JAVA_OPTS -jar /opt/muhugochat/backend.jar
STARTEOF
chmod +x /opt/muhugochat/start.sh

cat > /etc/systemd/system/muhugochat.service << 'SVCEOF'
[Unit]
Description=MuhugoChat Java Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/muhugochat
Environment="JAVA_OPTS=-Xmx800m -Xms256m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -Dspring.profiles.active=prod -DDB_HOST=__DB_HOST__ -DDB_PORT=__DB_PORT__ -DDB_NAME=__DB_NAME__ -DDB_USERNAME=__DB_USER__ -DDB_PASSWORD=__DB_PASS__"
ExecStart=/opt/muhugochat/start.sh
Restart=on-failure
RestartSec=10
TimeoutStartSec=120
StandardOutput=append:/opt/muhugochat/app.log
StandardError=append:/opt/muhugochat/app.log

[Install]
WantedBy=multi-user.target
SVCEOF

mkdir -p /etc/systemd/system/muhugochat.service.d
cat > /etc/systemd/system/muhugochat.service.d/override.conf << 'ENVEOF'
[Service]
Environment="JWT_SECRET=change-this-to-a-very-long-random-secret-key-at-least-64-characters"
Environment="PAY_AES_KEY=change-this-to-a-32-byte-or-longer-random-secret"
Environment="CORS_ALLOWED_ORIGINS=https://muhuo.cloud,https://www.muhuo.cloud,http://muhuo.cloud,http://__HOST_B_IP__"
Environment="MUHUGOCHAT_INTERNAL_API_KEY=__INTERNAL_API_KEY__"
Environment="INTERNAL_API_KEY=__INTERNAL_API_KEY__"
Environment="CACHE_LEDGER_BASE_URL=__CACHE_LEDGER_BASE_URL__"
ENVEOF

echo "== [4/8] Repair AutoCode .env =="
touch /opt/autocode/.env
set_env() {
  key="$1"
  value="$2"
  file="/opt/autocode/.env"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
set_env AUTOCODE_PUBLIC_API_BASE "https://muhuo.cloud/autocode-api"
set_env MUHUGOCHAT_DB_HOST "__DB_HOST__"
set_env MUHUGOCHAT_DB_PORT "__DB_PORT__"
set_env MUHUGOCHAT_DB_NAME "__DB_NAME__"
set_env MUHUGOCHAT_DB_USER "__DB_USER__"
set_env MUHUGOCHAT_DB_PASSWORD "__DB_PASS__"
set_env MUHUGOCHAT_API_URL "http://127.0.0.1:8080/api/admin"
set_env MUHUGOCHAT_INTERNAL_API_KEY "__INTERNAL_API_KEY__"
set_env INTERNAL_API_KEY "__INTERNAL_API_KEY__"
set_env AUTOCODE_LLM_VIA_MUHUGOCHAT "true"
set_env WORKSPACE_BASE_DIR "/data/autocode-workspaces"
set_env MAX_CONCURRENT_TASKS "2"
set_env AUTOCODE_TASK_ARCHIVE_DIR "/var/log/autocode/task-archives"
set_env AUTOCODE_TASK_DB_MAX_LOG_ENTRIES "500"
set_env AUTOCODE_TASK_DB_MAX_EVENT_ENTRIES "1000"
set_env AUTOCODE_TASK_DB_MAX_COMMAND_ENTRIES "200"
set_env AUTOCODE_TASK_DB_MAX_STRING_CHARS "12000"

echo "== [5/8] Write AutoCode service =="
cat > /etc/systemd/system/autocode.service << 'SVCEOF'
[Unit]
Description=AutoCode Agent Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/autocode
Environment="PYTHONUNBUFFERED=1"
ExecStartPre=/bin/bash -lc 'test -f /opt/autocode/main.py'
ExecStart=/opt/autocode/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --ws-ping-interval 60 --ws-ping-timeout 120
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
StandardOutput=append:/var/log/autocode/app.log
StandardError=append:/var/log/autocode/error.log

[Install]
WantedBy=multi-user.target
SVCEOF

if [ -f /opt/autocode/requirements.txt ]; then
  if [ ! -x /opt/autocode/venv/bin/uvicorn ]; then
    echo "Creating AutoCode venv and installing requirements..."
    python3.11 -m venv /opt/autocode/venv
    /opt/autocode/venv/bin/pip install -U pip >/tmp/autocode-repair-pip.log 2>&1 || true
    /opt/autocode/venv/bin/pip install -r /opt/autocode/requirements.txt >>/tmp/autocode-repair-pip.log 2>&1 || {
      echo "WARN: pip install failed, see /tmp/autocode-repair-pip.log"
    }
  fi
fi

echo "== [6/8] Install nginx config =="
cp /tmp/nginx-muhugochat-single.conf /etc/nginx/sites-available/muhugochat
ln -sf /etc/nginx/sites-available/muhugochat /etc/nginx/sites-enabled/muhugochat
rm -f /etc/nginx/sites-enabled/default
mkdir -p /etc/nginx/snippets
touch /etc/nginx/snippets/muhugochat-overseas-routes.conf
nginx -t

echo "== [7/8] Enable/restart services =="
systemctl daemon-reload
systemctl enable nginx redis-server muhugochat autocode >/dev/null 2>&1 || true
systemctl restart redis-server || true
systemctl restart nginx

if [ -f /opt/muhugochat/backend.jar ]; then
  systemctl restart muhugochat || true
else
  echo "WARN: /opt/muhugochat/backend.jar missing; muhugochat cannot start."
fi

if [ -f /opt/autocode/main.py ] && [ -x /opt/autocode/venv/bin/uvicorn ]; then
  systemctl restart autocode || true
else
  echo "WARN: AutoCode files or venv missing; autocode cannot start."
  echo "      Need: /opt/autocode/main.py and /opt/autocode/venv/bin/uvicorn"
fi

sleep 3

if ! ss -lntp | grep -q ':8080\b' && [ -f /opt/muhugochat/backend.jar ]; then
  echo "Java did not expose 8080 after first restart; waiting once more..."
  sleep 8
fi

if ! ss -lntp | grep -q ':8000\b' && [ -f /opt/autocode/main.py ] && [ -x /opt/autocode/venv/bin/uvicorn ]; then
  echo "AutoCode did not expose 8000 after first restart; waiting once more..."
  sleep 5
fi

echo "== [8/8] Diagnostics =="
echo "-- active states --"
systemctl is-active nginx 2>/dev/null | sed 's/^/nginx: /' || true
systemctl is-active redis-server 2>/dev/null | sed 's/^/redis: /' || true
systemctl is-active muhugochat 2>/dev/null | sed 's/^/muhugochat: /' || true
systemctl is-active autocode 2>/dev/null | sed 's/^/autocode: /' || true

echo "-- listeners --"
ss -lntp | grep -E ':(80|6379|8080|8000)\b' || true

echo "-- important files --"
ls -lh /opt/muhugochat/backend.jar 2>/dev/null || echo "missing: /opt/muhugochat/backend.jar"
ls -lh /opt/autocode/main.py 2>/dev/null || echo "missing: /opt/autocode/main.py"
ls -lh /opt/autocode/venv/bin/uvicorn 2>/dev/null || echo "missing: /opt/autocode/venv/bin/uvicorn"
ls -ld /var/www/muhugochat-frontend /var/www/autocode-frontend 2>/dev/null || true

echo "-- quick local probes --"
curl -sS -m 3 -I http://127.0.0.1/ | head -n 5 || true
curl -sS -m 3 -I http://127.0.0.1:8080/api/ 2>&1 | head -n 5 || true
curl -sS -m 3 -I http://127.0.0.1:8000/ 2>&1 | head -n 5 || true

if ! systemctl is-active --quiet muhugochat; then
  echo "-- muhugochat logs --"
  journalctl -u muhugochat --no-pager -n 80 || true
  tail -n 80 /opt/muhugochat/app.log 2>/dev/null || true
fi

if ! ss -lntp | grep -q ':8080\b'; then
  echo "-- muhugochat 8080 is not listening; recent logs --"
  journalctl -u muhugochat --no-pager -n 120 || true
  tail -n 120 /opt/muhugochat/app.log 2>/dev/null || true
fi

if ! systemctl is-active --quiet autocode || ! ss -lntp | grep -q ':8000\b'; then
  echo "-- autocode logs --"
  journalctl -u autocode --no-pager -n 80 || true
  tail -n 120 /var/log/autocode/app.log 2>/dev/null || true
  tail -n 80 /var/log/autocode/error.log 2>/dev/null || true
fi

if systemctl is-active --quiet nginx && systemctl is-active --quiet redis-server && ss -lntp | grep -q ':8080\b' && ss -lntp | grep -q ':8000\b'; then
  echo "OK: Server B single-machine runtime is healthy."
else
  echo "WARN: One or more services are not active. See diagnostics above."
  exit 1
fi
'@

    $script = $scriptTemplate.
        Replace("__DB_HOST__", $DB_HOST).
        Replace("__DB_PORT__", $DB_PORT).
        Replace("__DB_NAME__", $DB_NAME).
        Replace("__DB_USER__", $DB_USER).
        Replace("__DB_PASS__", $DB_PASS).
        Replace("__HOST_B_IP__", $HOST_B_IP).
        Replace("__INTERNAL_API_KEY__", $INTERNAL_API_KEY).
        Replace("__CACHE_LEDGER_BASE_URL__", $CACHE_LEDGER_BASE_URL)

    SSH-B $script
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Single Server B repair finished with warnings/errors. Read diagnostics above." -ForegroundColor Yellow
        return
    }
    Write-Host "Single Server B repair OK" -ForegroundColor Green
}

function Check-AutoCode-Bridge {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Checking AutoCode Internal Bridge"     -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    Write-Host "[1/2] Server A Java backend env..." -ForegroundColor Cyan
    $checkA = @'
set -e
echo "muhugochat: $(systemctl is-active muhugochat 2>/dev/null || true)"
systemctl show muhugochat -p Environment 2>/dev/null \
  | tr ' ' '\n' \
  | grep -E '^(Environment=)?(MUHUGOCHAT_INTERNAL_API_KEY|INTERNAL_API_KEY|CACHE_LEDGER_BASE_URL)=' \
  | sed -E 's/=.*/=*** set ***/' || true
'@
    SSH-A $checkA

    Write-Host "[2/2] Server B AutoCode env + internal API probe..." -ForegroundColor Cyan
    $checkB = @'
set -e
echo "autocode: $(systemctl is-active autocode 2>/dev/null || true)"
if [ ! -f /opt/autocode/.env ]; then
  echo "ERROR: /opt/autocode/.env not found" >&2
  exit 2
fi
grep -E '^(MUHUGOCHAT_API_URL|MUHUGOCHAT_INTERNAL_API_KEY|INTERNAL_API_KEY|AUTOCODE_LLM_VIA_MUHUGOCHAT)=' /opt/autocode/.env \
  | sed -E 's/(KEY)=.*/\1=*** set ***/' || true
bad_env_lines="$(grep -nEv '^[[:space:]]*($|#|[A-Za-z_][A-Za-z0-9_]*=)' /opt/autocode/.env || true)"
if [ -n "$bad_env_lines" ]; then
  echo "WARN: /opt/autocode/.env contains non KEY=value lines; ignored by this check:"
  printf '%s\n' "$bad_env_lines" | head -n 10
fi
read_env() {
  key="$1"
  awk -F= -v k="$key" '
    $1 == k {
      value = substr($0, length(k) + 2)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' /opt/autocode/.env
}
MUHUGOCHAT_INTERNAL_API_KEY="$(read_env MUHUGOCHAT_INTERNAL_API_KEY)"
INTERNAL_API_KEY="$(read_env INTERNAL_API_KEY)"
MUHUGOCHAT_API_URL="$(read_env MUHUGOCHAT_API_URL)"
AUTOCODE_LLM_VIA_MUHUGOCHAT="$(read_env AUTOCODE_LLM_VIA_MUHUGOCHAT)"
key="${MUHUGOCHAT_INTERNAL_API_KEY:-${INTERNAL_API_KEY:-}}"
url="${MUHUGOCHAT_API_URL:-}"
if [ -z "$key" ]; then
  echo "ERROR: MUHUGOCHAT_INTERNAL_API_KEY/INTERNAL_API_KEY is empty" >&2
  exit 3
fi
if [ -z "$url" ]; then
  echo "ERROR: MUHUGOCHAT_API_URL is empty" >&2
  exit 4
fi
echo "probe: $url/internal/models"
models_body="$(curl -sS --fail --max-time 8 -H "X-Internal-Api-Key: $key" "$url/internal/models")"
printf '%s' "$models_body" | head -c 500
echo
echo "probe: $url/internal/channels"
channels_body="$(curl -sS --fail --max-time 8 -H "X-Internal-Api-Key: $key" "$url/internal/channels")"
printf '%s' "$channels_body" | head -c 500
echo
python3 - "$models_body" "$channels_body" <<'PY'
import json
import sys

def data_len(raw, label):
    payload = json.loads(raw)
    code = payload.get("code", 200 if payload.get("success") is True else None)
    if code not in (0, 200, "0", "200"):
        raise SystemExit(f"ERROR: {label} internal API failed: {payload.get('message')}")
    data = payload.get("data") or []
    if not isinstance(data, list) or not data:
        raise SystemExit(f"ERROR: {label} internal API returned empty data")
    return len(data)

print(f"models_count={data_len(sys.argv[1], 'models')}")
print(f"channels_count={data_len(sys.argv[2], 'channels')}")
PY
if [ "${AUTOCODE_LLM_VIA_MUHUGOCHAT:-}" = "true" ]; then
  echo "probe: $url/internal/chat/completions"
  chat_body='{"model":"deepseek-v4-flash","system":"你是内部连通性测试助手，只需要简短回复。","messages":[{"role":"user","content":"请回复 OK"}],"temperature":0,"maxTokens":64}'
  chat_resp="$(curl -sS --fail --max-time 30 -H "Content-Type: application/json" -H "X-Internal-Api-Key: $key" -d "$chat_body" "$url/internal/chat/completions")"
  printf '%s' "$chat_resp" | head -c 500
  echo
  python3 - "$chat_resp" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
code = payload.get("code", 200 if payload.get("success") is True else None)
if code not in (0, 200, "0", "200"):
    raise SystemExit(f"ERROR: internal chat failed: {payload.get('message')}")
data = payload.get("data") or {}
content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
if not content:
    raise SystemExit("ERROR: internal chat returned empty content")
print(f"internal_chat_content_len={len(content)}")
PY
fi
'@
    SSH-B $checkB
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Bridge check failed" -ForegroundColor Red
        return
    }
    Write-Host "Bridge check completed" -ForegroundColor Green
}

$cmd = $args[0]

switch ($cmd) {
    "init-server-c"                { Init-ServerC }
    "check-db-disk"                { Check-DB-Disk }
    "repair-db-disk-safe"          { Repair-DB-Disk-Safe }
    "optimize-db-server-c"         { Optimize-DB-ServerC }
    "optimize-server-b-cleanup"    { Optimize-ServerB-Cleanup }
    "init-server-a"                { Init-ServerA }
    "init-server-b"                { Init-ServerB }
    "init-backend-overseas"        { Init-Backend-Overseas }
    "build-frontend"               { Build-Frontend }
    "upload-frontendonly"          { Upload-FrontendOnly }
    "build-docs"                   { Build-Docs }
    "upload-docs"                  { Upload-Docs }
    "build-backend"                { Build-Backend }
    "upload-backend"               { Upload-Backend }
    "upload-backend-overseas"      { Upload-Backend-Overseas }
    "upload-autocode"              { Upload-AutoCode }
    "build-autocode-frontend"      { Build-AutoCode-Frontend }
    "upload-autocode-frontend"     { Upload-AutoCode-Frontend }
    "upload-autocode-frontend-b"   { Upload-AutoCode-Frontend-B }
    "reload-nginx"                 { Reload-Nginx }
    "reload-nginx-b"               { Reload-Nginx-B }
    "migrate-db"                   { Migrate-DB $args[1] }
    "recover-backend-env"          { Recover-Backend-Env }
    "repair-single-server-b"       { Repair-SingleServerB }
    "check-autocode-bridge"        { Check-AutoCode-Bridge }
    "check-backend-overseas"       { Check-Backend-Overseas }
    default {
        Write-Host "Usage: .\deploy.ps1 cmd" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Init (first-time setup, runs remotely):" -ForegroundColor Magenta
        Write-Host "  init-server-c               Install MySQL 8.0 on Server C"
        Write-Host "  init-server-a               Install Java 17 + Nginx + systemd on Server A"
        Write-Host "  init-server-b               Install Python 3.11 + Node + systemd on Server B"
        Write-Host "  init-backend-overseas       Install Java backend runtime on overseas node"
        Write-Host ""
        Write-Host "Deploy (daily updates):" -ForegroundColor Cyan
        Write-Host "  build-frontend              Build main frontend"
        Write-Host "  upload-frontendonly         Upload main frontend to Server A ($HOST_A_IP)"
        Write-Host "  build-docs                  Build docs-site learning site"
        Write-Host "  upload-docs                 Upload docs-site to /learn on Server A ($HOST_A_IP)"
        Write-Host "  build-backend               Build Java backend JAR"
        Write-Host "  upload-backend              Upload Java backend to Server A ($HOST_A_IP)"
        Write-Host "  upload-backend-overseas     Upload Java backend to overseas node ($HOST_OVERSEAS_IP)"
        Write-Host "  upload-autocode             Upload AutoCode backend to Server B ($HOST_B_IP)"
        Write-Host "  build-autocode-frontend     Build AutoCode frontend"
        Write-Host "  upload-autocode-frontend    Upload AutoCode frontend to Server A ($HOST_A_IP)"
        Write-Host "  upload-autocode-frontend-b  Upload AutoCode frontend to Server B ($HOST_B_IP)"
        Write-Host ""
        Write-Host "Maintenance:" -ForegroundColor Yellow
        Write-Host "  migrate-db <sql_file>       Run SQL migration on Server C MySQL (${DB_HOST}:${DB_PORT})"
        Write-Host "  check-db-disk               Check Server C MySQL disk/tmp/inode status"
        Write-Host "  repair-db-disk-safe         Conservative Server C disk cleanup"
        Write-Host "  optimize-db-server-c        Tune Server C as MySQL server"
        Write-Host "  optimize-server-b-cleanup   Configure Server B cleanup jobs"
        Write-Host "  recover-backend-env         Recover JWT/PAY_AES_KEY env and restart backend"
        Write-Host "  repair-single-server-b      Repair single-server deployment on Server B"
        Write-Host "  check-autocode-bridge       Check AutoCode internal model/billing bridge"
        Write-Host "  check-backend-overseas      Check overseas Java backend node"
        Write-Host "  reload-nginx                Upload nginx config to Server A and reload"
        Write-Host "  reload-nginx-b              Upload nginx config to Server B and reload"
        Write-Host ""
        Write-Host "Recommended first-time deployment order:" -ForegroundColor Green
        Write-Host "  1) .\deploy.ps1 init-server-c"
        Write-Host "  2) .\deploy.ps1 init-server-a"
        Write-Host "  3) .\deploy.ps1 init-server-b"
        Write-Host "  4) .\deploy.ps1 build-backend; .\deploy.ps1 upload-backend"
        Write-Host "     Optional overseas: set MUHUGO_OVERSEAS_IP, then .\deploy.ps1 init-backend-overseas; .\deploy.ps1 upload-backend-overseas; .\deploy.ps1 reload-nginx"
        Write-Host "  5) .\deploy.ps1 build-frontend; .\deploy.ps1 build-docs; .\deploy.ps1 upload-frontendonly"
        Write-Host "  6) .\deploy.ps1 build-autocode-frontend; .\deploy.ps1 upload-autocode-frontend"
        Write-Host "  7) .\deploy.ps1 upload-autocode"
        Write-Host "  8) .\deploy.ps1 repair-single-server-b"
    }
}
