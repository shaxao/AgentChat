$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$deployScript = Join-Path $PSScriptRoot "deploy.ps1"
if (-not (Test-Path $deployScript)) {
    Write-Host "ERROR: deploy.ps1 not found: $deployScript" -ForegroundColor Red
    exit 1
}

& $deployScript publish-autocode-desktop
exit $LASTEXITCODE
