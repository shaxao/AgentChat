@echo off
REM ================================================================
REM  AutoCode Agent Platform - Local Development Startup Script
REM ================================================================
REM
REM  Usage:
REM     start-dev.bat           - start with default settings
REM     start-dev.bat --reload  - enable auto-reload on code changes
REM
REM  Prerequisites:
REM     1. Python 3.10+ installed and in PATH
REM     2. MySQL running on localhost:3306 (or update .env.development)
REM     3. Docker Desktop (optional - workspace will use local FS if unavailable)
REM ================================================================

setlocal enabledelayedexpansion

REM ---- Detect Python ------------------------------------------------
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found in PATH. Please install Python 3.10+.
    pause
    exit /b 1
)

REM ---- Detect venv --------------------------------------------------
if not exist "venv\Scripts\activate.bat" (
    echo [SETUP] Virtual environment not found. Creating...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo [SETUP] Installing dependencies...
    pip install -r requirements.txt
    goto :after_install
)

call venv\Scripts\activate.bat

:after_install
REM ---- Load .env.development if exists, else .env ---------------
if exist ".env.development" (
    echo [CONFIG] Loading .env.development
    for /f "usebackq tokens=1,* delims==" %%i in (`findstr /v "^#" ".env.development"`) do (
        if not "%%j"=="" set "%%i=%%j"
    )
) else (
    echo [CONFIG] .env.development not found, using .env
)

REM ---- Check MySQL connectivity ---------------------------------------
set "MYSQL_HOST=%MUHUGOCHAT_DB_HOST%"
if "%MYSQL_HOST%"=="" set "MYSQL_HOST=localhost"

echo [CHECK] Testing MySQL connection: %MYSQL_HOST%:3306
python -c "import socket; s=socket.socket(); s.settimeout(3); exit(0 if s.connect_ex(('%MYSQL_HOST%', 3306))==0 else 1)" 2>nul
if %errorlevel% neq 0 (
    echo [WARN]  MySQL not reachable at %MYSQL_HOST%:3306
    echo [WARN]  Tasks will use IN-MEMORY storage (lost on restart)
    echo [INFO]  To use MySQL: update MUHUGOCHAT_DB_HOST in .env or .env.development
) else (
    echo [OK]    MySQL reachable at %MYSQL_HOST%:3306
)

REM ---- Check Docker --------------------------------------------------
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN]  Docker not available - workspaces will use LOCAL filesystem
    echo [INFO]  Start Docker Desktop if you need container isolation
) else (
    echo [OK]    Docker available
)

REM ---- Start server ----------------------------------------------------
set "RELOAD_FLAG="
if "%1"=="--reload" set "RELOAD_FLAG=--reload"

echo.
echo ================================================================
echo  Starting AutoCode Backend on http://localhost:8000
echo  API Docs: http://localhost:8000/docs
echo  WebSocket Terminal: ws://localhost:8000/ws/terminal/{workspace_id}
echo ================================================================
echo.

uvicorn main:app --host 0.0.0.0 --port 8000 %RELOAD_FLAG%

endlocal
