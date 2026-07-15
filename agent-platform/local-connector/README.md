# AutoCode Local Connector

Windows-first desktop connector for AutoCode local execution.

## User Flow

1. Install `AutoCodeLocalConnectorSetup.exe` once.
2. In AutoCode, click `一键连接本地项目`.
3. The browser opens a URL like:

   `muhuo-autocode://connect?server=...&session=...&token=...&project=...`

4. The connector connects outbound to AutoCode WebSocket and executes tool requests inside the authorized project directory.

## Build

### Fast Windows Connector

This path packages the existing mature Python runner into a single exe. End
users do not need Python installed.

```powershell
cd agent-platform/local-connector/windows
.\build-windows-connector.ps1
```

The output `AutoCodeLocalConnectorSetup.exe` is a self-installing executable:
users double-click it once, it copies itself to LocalAppData and registers
`muhuo-autocode://`.

### Tauri Desktop Shell

```powershell
cd agent-platform/local-connector
powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -InstallRust
```

The expected Windows installer path is:

`src-tauri/target/release/bundle/nsis/AutoCode Local Connector_0.1.0_x64-setup.exe`

`deploy/deploy.ps1 upload-autocode` copies the Tauri installer when present.
If it is missing, it falls back to:

`windows/AutoCodeLocalConnectorSetup.exe`

The uploaded target is:

`agent-platform/backend/static/local-connector/AutoCodeLocalConnectorSetup.exe`

The backend exposes it at:

`/api/local-runner/connector/windows/latest`

## Fallback

The Python script runner remains available at:

`/api/local-runner/download`

It is intended for advanced troubleshooting only.
