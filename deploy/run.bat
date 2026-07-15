@echo off
REM MuhugoChat 部署启动器（绕过 PowerShell 执行策略 + 编码问题）
REM 用法: run.bat init-server-c  或  run.bat init-server-a  等

set SCRIPT_DIR=%~dp0
set DEPLOY_PS1=%SCRIPT_DIR%deploy.ps1

if not exist "%DEPLOY_PS1%" (
    echo [ERROR] deploy.ps1 未找到: %DEPLOY_PS1%
    exit /b 1
)

if "%~1"=="" (
    echo MuhugoChat 部署工具
    echo.
    echo 用法: run.bat ^<command^>
    echo.
    echo 初始化:    run.bat init-server-c    init-server-a    init-server-b
    echo 构建:      run.bat build-frontend    build-backend
    echo 上传:      run.bat upload-frontend    upload-all
    echo 检查:      run.bat check-connectivity
    echo 一键部署:  run.bat full-deploy
    echo.
    echo 当前服务器:
    echo   服务器 A (Java+Nginx): your-server-a-ip
    echo   服务器 B (AutoCode):   your-server-b-ip
    echo   服务器 C (MySQL):      your-server-c-ip
    exit /b 0
)

REM 使用 UTF-8 编码 + 绕过执行策略
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '%DEPLOY_PS1%' %*"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] 部署失败! 错误码: %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)
