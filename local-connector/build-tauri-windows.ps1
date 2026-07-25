param(
    [switch]$InstallRust,
    [switch]$UseChinaMirror,
    [switch]$ResetLocalRust,
    [switch]$InstallBuildTools
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendStatic = Join-Path $root "..\backend\static\local-connector"
$installerBundleDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
$releaseExe = Join-Path $root "src-tauri\target\release\autocode_local_connector.exe"
$targetInstaller = Join-Path $backendStatic "AutoCodeLocalConnectorSetup.exe"
$targetPortableExe = Join-Path $backendStatic "AutoCodeLocalConnector.exe"
$cargoProxyPort = 38473
$cargoProxyJob = $null

Set-Location $root

$globalCargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$localCargoHome = Join-Path $root ".cargo"
$localRustupHome = Join-Path $root ".rustup"
$localCargoBin = Join-Path $localCargoHome "bin"
$localAppData = Join-Path $root ".localappdata"
$localTemp = Join-Path $root ".tmp"
New-Item -ItemType Directory -Force -Path $localCargoHome, $localRustupHome, $localAppData, $localTemp | Out-Null

$env:CARGO_HOME = $localCargoHome
$env:RUSTUP_HOME = $localRustupHome
$env:LOCALAPPDATA = $localAppData
$env:TEMP = $localTemp
$env:TMP = $localTemp
if ($UseChinaMirror) {
    if (-not $env:RUSTUP_DIST_SERVER) {
        $env:RUSTUP_DIST_SERVER = "https://rsproxy.cn"
    }
    if (-not $env:RUSTUP_UPDATE_ROOT) {
        $env:RUSTUP_UPDATE_ROOT = "https://rsproxy.cn/rustup"
    }
    if (-not $env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL) {
        $env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL = "sparse"
    }
    $proxyScript = Join-Path $root "scripts\cargo-rsproxy-proxy.mjs"
    if (-not (Test-Path $proxyScript)) {
        throw "Cargo proxy script not found: $proxyScript"
    }
    Write-Host "Starting local Cargo HTTP proxy on port $cargoProxyPort..." -ForegroundColor Cyan
    $cargoProxyJob = Start-Job -ScriptBlock {
        param($ProxyRoot, $ProxyPort)
        $env:CARGO_PROXY_PORT = "$ProxyPort"
        Set-Location $ProxyRoot
        node "scripts\cargo-rsproxy-proxy.mjs"
    } -ArgumentList $root, $cargoProxyPort
    Start-Sleep -Seconds 2

    $cargoConfig = Join-Path $localCargoHome "config.toml"
    @"
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+http://127.0.0.1:$cargoProxyPort/index/"

[net]
git-fetch-with-cli = true

[http]
check-revoke = false
"@ | Set-Content -Path $cargoConfig -Encoding utf8
}
foreach ($pathEntry in @($localCargoBin, $globalCargoBin)) {
    if ((Test-Path $pathEntry) -and ($env:Path -notlike "*$pathEntry*")) {
        $env:Path = "$pathEntry;$env:Path"
    }
}

if ($ResetLocalRust) {
    Write-Host "Resetting project-local Rustup/Cargo directories..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $localRustupHome, $localCargoHome -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $localCargoHome, $localRustupHome | Out-Null
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    if (-not $InstallRust) {
        Write-Host "cargo was not found." -ForegroundColor Yellow
        Write-Host "Run this command once to install Rustup automatically:" -ForegroundColor Cyan
        Write-Host "  powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -InstallRust"
        Write-Host ""
        Write-Host "Or install Rustup manually from: https://rustup.rs/"
        exit 2
    }

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "cargo was not found and winget is unavailable. Please install Rustup from https://rustup.rs/"
    }

    Write-Host "Installing Rustup via winget source..." -ForegroundColor Cyan
    winget install --id Rustlang.Rustup -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "winget returned exit code $LASTEXITCODE. Checking whether Rustup is already installed..." -ForegroundColor Yellow
    }

    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        Write-Host "Rustup was installed, but cargo is not visible in this PowerShell session." -ForegroundColor Yellow
        Write-Host "Please close and reopen PowerShell, then run:" -ForegroundColor Cyan
        Write-Host "  powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1"
        exit 3
    }
}

if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & rustup show active-toolchain > $null 2> $null
    $rustupStatus = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($rustupStatus -ne 0) {
        Write-Host "No Rust default toolchain configured. Using stable for this build session..." -ForegroundColor Cyan
        $env:RUSTUP_TOOLCHAIN = "stable"
        Write-Host "Ensuring stable Rust toolchain is complete in project-local RUSTUP_HOME..." -ForegroundColor Cyan
        & rustup set profile minimal
        & rustup toolchain install stable --profile minimal --no-self-update
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install Rust stable toolchain."
        }
    }
}

function Test-MsvcLinker {
    if (Get-Command link.exe -ErrorAction SilentlyContinue) {
        return $true
    }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($installPath) {
            $link = Get-ChildItem -Path (Join-Path $installPath "VC\Tools\MSVC") -Recurse -Filter link.exe -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -like "*\Hostx64\x64\link.exe" } |
                Select-Object -First 1
            if ($link) {
                $linkDir = Split-Path -Parent $link.FullName
                if ($env:Path -notlike "*$linkDir*") {
                    $env:Path = "$linkDir;$env:Path"
                }
                return $true
            }
        }
    }
    return $false
}

if (-not (Test-MsvcLinker)) {
    if (-not $InstallBuildTools) {
        Write-Host "MSVC linker link.exe was not found." -ForegroundColor Yellow
        Write-Host "Install Visual Studio Build Tools C++ workload once with:" -ForegroundColor Cyan
        Write-Host "  powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -UseChinaMirror -InstallBuildTools"
        exit 4
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is unavailable. Please install Visual Studio 2022 Build Tools with the C++ workload manually."
    }
    Write-Host "Installing Visual Studio 2022 Build Tools C++ workload..." -ForegroundColor Cyan
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if ($LASTEXITCODE -ne 0) {
        throw "Visual Studio Build Tools installation failed."
    }
    if (-not (Test-MsvcLinker)) {
        Write-Host "Build Tools were installed, but link.exe is not visible yet." -ForegroundColor Yellow
        Write-Host "Please reopen PowerShell and run:" -ForegroundColor Cyan
        Write-Host "  powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -UseChinaMirror"
        exit 5
    }
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed."
    }
}

Write-Host "Building AutoCode Local Connector with Tauri..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    if ($cargoProxyJob) {
        Stop-Job -Job $cargoProxyJob -ErrorAction SilentlyContinue
        Remove-Job -Job $cargoProxyJob -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $releaseExe) {
        New-Item -ItemType Directory -Force -Path $backendStatic | Out-Null
        Copy-Item -Force $releaseExe $targetPortableExe
        Write-Host "Tauri bundling failed, but the app executable was built and copied to:" -ForegroundColor Yellow
        Write-Host $targetPortableExe
        Write-Host "The installer still needs the NSIS bundling issue fixed." -ForegroundColor Yellow
    }
    throw "Tauri build failed."
}

$expectedInstaller = $null
if (Test-Path $installerBundleDir) {
    $expectedInstaller = Get-ChildItem -Path $installerBundleDir -Filter "AutoCode Local Connector_*_x64-setup.exe" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}
if (-not $expectedInstaller) {
    if ($cargoProxyJob) {
        Stop-Job -Job $cargoProxyJob -ErrorAction SilentlyContinue
        Remove-Job -Job $cargoProxyJob -Force -ErrorAction SilentlyContinue
    }
    throw "Tauri build finished, but installer was not found in: $installerBundleDir"
}

New-Item -ItemType Directory -Force -Path $backendStatic | Out-Null
Copy-Item -Force $expectedInstaller.FullName $targetInstaller
if (Test-Path $releaseExe) {
    Copy-Item -Force $releaseExe $targetPortableExe
}
if ($cargoProxyJob) {
    Stop-Job -Job $cargoProxyJob -ErrorAction SilentlyContinue
    Remove-Job -Job $cargoProxyJob -Force -ErrorAction SilentlyContinue
}
Write-Host "AutoCode Local Connector installer copied to:" -ForegroundColor Green
Write-Host $targetInstaller
