# AutoCode IDE

Windows-first desktop IDE shell for local AutoCode development.

**只有你打包发布时配置好了 updater，用户下载安装后点“检查更新/自动更新”就能直接更新。**
用户不需要、也不应该填写 `AUTOCODE_UPDATER_ENDPOINT`、`AUTOCODE_UPDATER_URL`、`AUTOCODE_UPDATER_PUBKEY`、更新 JSON 地址、签名公钥。

但你现在这个仓库里的 [tauri.conf.json (line 45)](C:/Users/Administrator/WorkBuddy/20260417103053/agent-platform/local-connector/src-tauri/tauri.conf.json:45) 还是：

```
"endpoints": [],
"pubkey": ""
```

所以如果现在直接打正式包，自动更新还不能正常给用户用。

你作为发布者要做这条链路：

```
cd C:\Users\Administrator\WorkBuddy\20260417103053\agent-platform\local-connector

npm.cmd run tauri signer generate -- -w C:\Users\Administrator\.tauri\autocode.key
```

然后把生成出来的 **public key** 写进 `tauri.conf.json`：

```
"plugins": {
  "updater": {
    "endpoints": ["https://你的域名/latest.json"],
    "pubkey": "这里填生成的 public key",
    "windows": {
      "installMode": "passive"
    }
  }
}
```

打包时用私钥签名：

```
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\Administrator\.tauri\autocode.key"
npm.cmd run build
```

发布时上传这些东西到你的下载站/GitHub Release/对象存储：

```
AutoCode IDE_版本号_x64-setup.exe
AutoCode IDE_版本号_x64-setup.nsis.zip
AutoCode IDE_版本号_x64-setup.nsis.zip.sig
latest.json
```

`latest.json` 大概长这样：

```
{
  "version": "0.4.9",
  "notes": "修复通知声音和自动更新设置。",
  "pub_date": "2026-07-23T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "填 .sig 文件内容",
      "url": "https://你的域名/AutoCode-IDE_0.4.9_x64-setup.nsis.zip"
    }
  }
}
```

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
