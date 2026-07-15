# AutoCode Agent Platform — Local Development Guide

## Quick Start (Windows)

### 1. Prerequisites

- **Python 3.10+** in PATH
- **MySQL** running on `localhost:3306` (or update `.env`)
- **Docker Desktop** (optional — workspaces run on local FS without it)

### 2. One-Command Start

```powershell
cd agent-platform\backend
.\start-dev.bat
```

This script will:
- ✅ Detect Python and create `venv` if missing
- ✅ Install dependencies from `requirements.txt`
- ✅ Test MySQL connectivity (warn if unavailable)
- ✅ Test Docker availability (warn if unavailable)
- ✅ Start uvicorn on `http://localhost:8000`

With auto-reload:
```powershell
.\start-dev.bat --reload
```

### 3. Manual Start (if you prefer)

```powershell
cd agent-platform\backend

# Create venv (first time only)
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt

# Copy development env (uses localhost MySQL)
copy .env.development .env

# Start server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Configuration

### `.env` vs `.env.development`

| File | Use case |
|------|----------|
| `.env` | Docker environment (default) |
| `.env.development` | Local development on Windows |

To switch to local dev config:
```powershell
copy .env.development .env
```

### Key Environment Variables

```bash
# MySQL (MuhugoChat DB for reading channel config)
MUHUGOCHAT_DB_HOST=localhost    # Docker: "aiplatform-mysql"
MUHUGOCHAT_DB_PORT=3306
MUHUGOCHAT_DB_NAME=MuHuoAi
MUHUGOCHAT_DB_USER=muhuoai
MUHUGOCHAT_DB_PASSWORD=changeme

# LLM API Keys (fallback if DB is unavailable)
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
QWEN_API_KEY=sk-...
KIMI_API_KEY=sk-...

# Workspace (local filesystem path)
WORKSPACE_BASE_DIR=C:/autocode-workspaces

# Docker (Windows Desktop default)
DOCKER_HOST=npipe:////./pipe/docker_engine
```

---

## Automatic Environment Detection

The platform now **auto-detects** your environment on startup:

### MySQL Host
```
1. Check MUHUGOCHAT_DB_HOST env var (if set)
2. Try "localhost:3306" (local dev)
3. Try "aiplatform-mysql:3306" (Docker)
4. Fall back to "localhost" with warning
```

### Docker Availability
```
Available  → Container isolation ENABLED
Unavailable → Local filesystem mode (graceful degradation)
```

### MySQL Availability
```
Available  → Task persistence ENABLED (survives restarts)
Unavailable → In-memory storage (tasks lost on restart)
```

---

## Startup Output (What to Expect)

### ✅ Ideal (Docker + MySQL available)

```
[AutoCode] ========================================
[AutoCode] Starting AutoCode Agent Platform
[AutoCode] WORKSPACE_DIR=C:\autocode-workspaces
[AutoCode] Python=3.11.3
[AutoCode] ========================================
[AutoCode] ✅ Docker connected — container isolation ENABLED
[AutoCode] ✅ MySQL connected — task persistence ENABLED
[AutoCode] ✅ Restored 3 historical tasks from MySQL
[AutoCode] ========================================
[AutoCode] Ready! Visit: http://localhost:8000/docs
```

### ⚠️ Local Dev (no Docker, no MySQL)

```
[AutoCode] ========================================
[AutoCode] Starting AutoCode Agent Platform
[AutoCode] WORKSPACE_DIR=C:\autocode-workspaces
[AutoCode] Python=3.11.3
[AutoCode] ========================================
[AutoCode] ⚠️  Docker unavailable: Error while fetching server API version
[AutoCode]    → Running in LOCAL mode (no container isolation)
[AutoCode]    → Workspaces will use local filesystem at: C:\autocode-workspaces
[AutoCode] ⚠️  MySQL unavailable — using IN-MEMORY task storage
[AutoCode]    → Tasks will be lost on service restart
[AutoCode] ========================================
[AutoCode] Ready! Visit: http://localhost:8000/docs
```

---

## API Testing

### Health Check
```bash
curl http://localhost:8000/health
```

### Create a Task
```bash
curl -X POST http://localhost:8000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Task","description":"Testing local dev","project_type":"nextjs"}'
```

### API Docs (Swagger UI)
Open: http://localhost:8000/docs

---

## Troubleshooting

### "MySQL not reachable"
- Make sure MySQL container is running: `docker ps | findstr mysql`
- Or install MySQL locally and update `.env`
- Or set `MUHUGOCHAT_DB_HOST=localhost` in `.env`

### "Docker unavailable"
- Install Docker Desktop and start it
- Or just ignore — workspaces will use local filesystem

### "Channel Service cannot connect to DB"
- This is expected if MySQL is unavailable
- Set API keys directly in `.env`:
  ```
  ANTHROPIC_API_KEY=sk-ant-...
  DEEPSEEK_API_KEY=sk-...
  ```

### Port 8000 already in use
```powershell
netstat -ano | findstr :8000
taskkill /PID <pid> /F
```

---

## Project Structure

```
agent-platform/
├── backend/
│   ├── .env                     # Docker env (default)
│   ├── .env.development         # Local dev env template
│   ├── start-dev.bat            # One-command startup for Windows
│   ├── main.py                   # FastAPI entry point
│   ├── core/
│   │   ├── config.py            # Auto-detects MySQL host
│   │   ├── llm_client.py        # Provider-agnostic LLM client
│   │   ├── agent_orchestrator.py # ReAct loop
│   │   └── docker_manager.py    # Workspace container management
│   └── services/
│       ├── task_repository.py    # Task persistence (MySQL + memory fallback)
│       └── channel_service.py    # LLM channel config reader
└── frontend/                     # Next.js frontend
```

---

## Next Steps

After local dev is working:
1. Test with DeepSeek: set `DEEPSEEK_API_KEY` in `.env`
2. Test with Kimi/Qwen: set respective API keys
3. Verify tool calling works with all providers
4. Deploy to Docker: `docker compose up -d autocode-backend`
