$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backendRunner = Join-Path $root "..\backend\local_runner\autocode_local_runner.py"
$launcher = Join-Path $PSScriptRoot "autocode_connector_launcher.py"
$dist = Join-Path $PSScriptRoot "dist"

if (-not (Test-Path $backendRunner)) {
    throw "Runner script not found: $backendRunner"
}

python -m pip install --upgrade pyinstaller websockets
python -m PyInstaller `
    --noconfirm `
    --onefile `
    --name AutoCodeLocalConnector `
    --add-data "$backendRunner;." `
    --distpath "$dist" `
    "$launcher"

Copy-Item -Force (Join-Path $dist "AutoCodeLocalConnector.exe") (Join-Path $PSScriptRoot "AutoCodeLocalConnector.exe")
Copy-Item -Force (Join-Path $dist "AutoCodeLocalConnector.exe") (Join-Path $PSScriptRoot "AutoCodeLocalConnectorSetup.exe")
Write-Host "Built: $PSScriptRoot\AutoCodeLocalConnector.exe" -ForegroundColor Green
Write-Host "Installer-compatible copy: $PSScriptRoot\AutoCodeLocalConnectorSetup.exe" -ForegroundColor Green
Write-Host "Users can double-click the exe to register muhuo-autocode://"
