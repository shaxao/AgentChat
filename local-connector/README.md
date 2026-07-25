# AutoCode IDE

Windows-first desktop IDE shell for local AutoCode development.

## User Flow

1. Launch AutoCode IDE locally.
2. Configure `API URL` and `API Key`.
3. Open a local project directory.
4. Use the integrated file tree, editor, terminal, preview browser, Git panel, skill store, and AutoCode task panel.

The website AutoCode API remains the business source of truth. The desktop app owns the local IDE experience and calls the configured API directly with:

- `Authorization: Bearer <apiKey>`
- `X-API-Key: <apiKey>`

## Defaults

The production API URL is injected by release/deployment configuration. Development builds default to:

```text
http://localhost:8000
```

The connector also checks these environment variables, in order:

```text
AUTOCODE_API_BASE_URL
AUTOCODE_CONNECTOR_API_BASE_URL
AUTOCODE_PUBLIC_API_BASE_URL
```

## Local Capabilities

- Workspace tree listing with path-boundary checks and `.autocodeignore` support.
- File read/write with UTF-8, UTF-8 BOM, and Windows GBK handling where possible.
- Line ending preservation for saved files.
- External file modification polling for the active editor file.
- Local terminal command execution through the connector runner.
- Git status and diff summary.
- Built-in preview browser panel.
- Skill store list/install through the configured API.

## Compatibility

`muhuo-autocode://` deep links are still registered for compatibility, but they now act as project import/open helpers. They are no longer the primary product entry.

## Build

### Tauri Desktop Shell

```powershell
cd agent-platform/local-connector
powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -InstallRust
```

The expected Windows installer path is:

```text
src-tauri/target/release/bundle/nsis/AutoCode IDE_0.4.8_x64-setup.exe
```

### Legacy Python Runner

The mature Python runner package is still available as a fallback for troubleshooting:

```powershell
cd agent-platform/local-connector/windows
.\build-windows-connector.ps1
```

The backend exposes installer downloads at:

```text
/api/local-runner/connector/windows/latest
```
