param(
    [string]$InstallDir = "$env:LOCALAPPDATA\AutoCodeLocalConnector"
)

$ErrorActionPreference = "Stop"
$exeName = "AutoCodeLocalConnector.exe"
$source = Join-Path $PSScriptRoot $exeName
if (-not (Test-Path $source)) {
    throw "$exeName was not found. Run build-windows-connector.ps1 first."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir $exeName
Copy-Item -Force $source $target

$protocolRoot = "HKCU:\Software\Classes\muhuo-autocode"
New-Item -Force -Path $protocolRoot | Out-Null
Set-ItemProperty -Path $protocolRoot -Name "(default)" -Value "URL:AutoCode Local Connector"
Set-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value ""
New-Item -Force -Path "$protocolRoot\DefaultIcon" | Out-Null
Set-ItemProperty -Path "$protocolRoot\DefaultIcon" -Name "(default)" -Value "`"$target`",0"
New-Item -Force -Path "$protocolRoot\shell\open\command" | Out-Null
Set-ItemProperty -Path "$protocolRoot\shell\open\command" -Name "(default)" -Value "`"$target`" `"%1`""

Write-Host "AutoCode Local Connector installed." -ForegroundColor Green
Write-Host "Protocol registered: muhuo-autocode://"
Write-Host "Executable: $target"
