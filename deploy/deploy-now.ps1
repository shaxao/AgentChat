# Deploy script for runtime intervention feature.
# Logs to deploy-output.log.

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$logFile = "$env:TEMP\deploy-output.log"

function Write-DeployLog {
    param([string]$Message)
    [System.IO.File]::AppendAllText($logFile, "$Message`r`n", $Utf8NoBom)
}

if (Test-Path $logFile) { Remove-Item $logFile -Force }
Write-DeployLog "=== Deploy started: $(Get-Date) ==="

# Find SSH/SCP.
$SSH_EXE = "ssh"
$SCP_EXE = "scp"
foreach ($p in @(
    "C:\Program Files\Git\usr\bin\ssh.exe",
    "C:\Program Files (x86)\Git\usr\bin\ssh.exe"
)) {
    if (Test-Path $p) {
        $SSH_EXE = $p
        $SCP_EXE = $p.Replace('\usr\bin\ssh.exe', '\usr\bin\scp.exe')
        break
    }
}
Write-DeployLog "SSH: $SSH_EXE"
Write-DeployLog "SCP: $SCP_EXE"

$SSH_ALIAS_A = "muhugo-a"
$SSH_OPTS = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=30")

# Step 1: upload frontend.
Write-DeployLog "`n--- Step 1: Upload Frontend ---"
$distDir = "C:\Users\Administrator\WorkBuddy\20260417103053\app\dist"
$tarFile = "$env:TEMP\frontend-dist.tar.gz"
$TAR = "C:\Windows\System32\tar.exe"

Write-DeployLog "Packing dist..."
& $TAR -czf $tarFile -C $distDir .
Write-DeployLog "tar exit: $LASTEXITCODE"

Write-DeployLog "Uploading frontend..."
& $SCP_EXE @SSH_OPTS $tarFile "${SSH_ALIAS_A}:/tmp/frontend-dist.tar.gz"
Write-DeployLog "scp frontend exit: $LASTEXITCODE"

Write-DeployLog "Extracting frontend on server..."
& $SSH_EXE @SSH_OPTS $SSH_ALIAS_A "mkdir -p /usr/share/nginx/html; cd /usr/share/nginx/html; tar -xzf /tmp/frontend-dist.tar.gz; rm /tmp/frontend-dist.tar.gz"
Write-DeployLog "ssh extract frontend exit: $LASTEXITCODE"

# Step 2: upload backend JAR.
Write-DeployLog "`n--- Step 2: Upload Backend ---"
$jarPath = "C:\Users\Administrator\WorkBuddy\20260417103053\backend\target\backend-1.0.0.jar"
$jarSize = [math]::Round((Get-Item $jarPath).Length / 1MB, 1)
Write-DeployLog "JAR size: $jarSize MB"

Write-DeployLog "Uploading backend JAR..."
& $SCP_EXE @SSH_OPTS $jarPath "${SSH_ALIAS_A}:/opt/muhugochat/backend-new.jar"
Write-DeployLog "scp backend exit: $LASTEXITCODE"

# Upload skill_runner.py.
$runnerPath = "C:\Users\Administrator\WorkBuddy\20260417103053\backend\skill_runner.py"
if (Test-Path $runnerPath) {
    Write-DeployLog "Uploading skill_runner.py..."
    & $SCP_EXE @SSH_OPTS $runnerPath "${SSH_ALIAS_A}:/opt/muhugochat/skill_runner.py"
    Write-DeployLog "scp runner exit: $LASTEXITCODE"
}

# Step 3: restart backend.
Write-DeployLog "`n--- Step 3: Restart Backend ---"
Write-DeployLog "Stopping service..."
& $SSH_EXE @SSH_OPTS $SSH_ALIAS_A "systemctl stop muhugochat 2>/dev/null; sleep 1"
Write-DeployLog "stop exit: $LASTEXITCODE"

Write-DeployLog "Replacing JAR..."
& $SSH_EXE @SSH_OPTS $SSH_ALIAS_A "set -e; test -d /opt/muhugochat; test -f /opt/muhugochat/backend-new.jar; mv -f /opt/muhugochat/backend-new.jar /opt/muhugochat/backend.jar; chmod 644 /opt/muhugochat/backend.jar"
Write-DeployLog "replace exit: $LASTEXITCODE"

Write-DeployLog "Starting service..."
& $SSH_EXE @SSH_OPTS $SSH_ALIAS_A "systemctl start muhugochat; sleep 3; systemctl is-active muhugochat"
Write-DeployLog "start exit: $LASTEXITCODE"

if ($LASTEXITCODE -eq 0) {
    Write-DeployLog "`n=== DEPLOY SUCCESS ==="
} else {
    Write-DeployLog "`n=== DEPLOY MAY HAVE FAILED - checking logs ==="
    $journal = & $SSH_EXE @SSH_OPTS $SSH_ALIAS_A "journalctl -u muhugochat --no-pager -n 30"
    Write-DeployLog ($journal -join "`r`n")
}

Write-DeployLog "`n=== Deploy finished: $(Get-Date) ==="
