# AutoCode IDE 桌面版发布说明

AutoCode IDE 的自动更新由发布包预先配置。普通用户只需要下载安装包，后续在应用里点“检查更新”或保持自动更新开启即可，不需要填写 updater 地址、公钥或任何环境变量。

## 当前公开地址

- 下载入口: https://muhuo.site/autocode-api/api/local-runner/connector/windows/latest
- 版本号安装包: https://muhuo.site/downloads/autocode/AutoCode-IDE-0.4.12-x64-setup.exe
- 更新清单: https://muhuo.site/downloads/autocode/latest.json
- 服务器目录: `/var/www/muhugochat-frontend/downloads/autocode`

## 发布新版本

1. 修改桌面端版本号:

```powershell
C:\Users\Administrator\WorkBuddy\20260417103053\agent-platform\local-connector\src-tauri\tauri.conf.json
C:\Users\Administrator\WorkBuddy\20260417103053\agent-platform\local-connector\package.json
```

2. 可选: 设置本次更新说明。

```powershell
$env:AUTOCODE_RELEASE_NOTES = "填写本次更新内容"
```

3. 一键构建、签名、生成 `latest.json` 并上传。

```powershell
cd C:\Users\Administrator\WorkBuddy\20260417103053\deploy
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 publish-autocode-desktop
```

也可以在桌面端目录运行:

```powershell
cd C:\Users\Administrator\WorkBuddy\20260417103053\agent-platform\local-connector
npm.cmd run publish:desktop
```

## 签名密钥

发布脚本会自动复用本机 Tauri updater 签名密钥:

- 私钥: `C:\Users\Administrator\.tauri\autocode.key`
- 密码: `C:\Users\Administrator\.tauri\autocode.key.password`
- 公钥: `C:\Users\Administrator\.tauri\autocode.key.pub`

这三个文件必须备份好。尤其是私钥和密码文件，一旦丢失，已经安装的旧版本无法继续通过同一条更新链路升级。

## 验证

```powershell
Invoke-WebRequest -Uri "https://muhuo.site/downloads/autocode/latest.json" | Select-Object StatusCode, Content
Invoke-WebRequest -Uri "https://muhuo.site/autocode-api/api/local-runner/connector/windows/latest" -Method Head
```

`latest.json` 中的 `platforms.windows-x86_64.url` 必须指向公开可下载的安装包，并且 `signature` 必须来自同版本构建产物的 `.sig` 文件。
