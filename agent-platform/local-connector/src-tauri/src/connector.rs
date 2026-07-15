use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::{form_urlencoded, Url};
use walkdir::WalkDir;

pub const VERSION: &str = "0.4.7";

const DEFAULT_IGNORES: &[&str] = &[
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    "__pycache__/",
    ".venv/",
    "venv/",
    ".env",
    ".env.*",
    "*.log",
    "*.tmp",
    "*.cache",
    "*.pyc",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LaunchConfig {
    pub server: String,
    pub session: String,
    pub token: String,
    pub project: String,
    pub min_version: String,
    pub grant_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LocalProjectGrant {
    pub grant_id: String,
    pub server_base: String,
    pub project_root: String,
    pub project_name: String,
    pub task_id: String,
    pub workspace_id: String,
    pub expires_at: String,
    pub last_used_at: String,
    pub open_url: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
    pub device_os: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunnerSnapshot {
    pub status: String,
    pub detail: String,
    pub server: String,
    pub session: String,
    pub project: String,
    pub redacted_ws_url: String,
    pub version: String,
    pub last_error: String,
    pub last_heartbeat_at: String,
    pub connected: bool,
    pub running: bool,
}

impl LaunchConfig {
    pub fn from_deep_link(raw: &str) -> Result<Self, String> {
        let url = Url::parse(raw).map_err(|err| format!("failed to parse connect URL: {err}"))?;
        if url.scheme() != "muhuo-autocode" {
            return Err("not an AutoCode Local Connector URL".to_string());
        }
        let mut config = LaunchConfig::default();
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "server" => config.server = value.to_string(),
                "session" => config.session = value.to_string(),
                "token" => config.token = value.to_string(),
                "project" => config.project = value.to_string(),
                "min_version" => config.min_version = value.to_string(),
                "grant_id" => config.grant_id = value.to_string(),
                _ => {}
            }
        }
        if config.server.is_empty() || config.session.is_empty() || config.token.is_empty() {
            return Err("connect URL missing server/session/token".to_string());
        }
        Ok(config)
    }

    pub fn websocket_url(&self) -> Result<String, String> {
        let parsed = Url::parse(&self.server).map_err(|err| format!("invalid AutoCode URL: {err}"))?;
        let scheme = if parsed.scheme() == "https" { "wss" } else { "ws" };
        let host = parsed.host_str().ok_or_else(|| "AutoCode URL missing host".to_string())?;
        let mut netloc = host.to_string();
        if let Some(port) = parsed.port() {
            netloc.push(':');
            netloc.push_str(&port.to_string());
        }
        let prefix = parsed.path().trim_end_matches('/');
        let base_path = if prefix.ends_with("/api/local-runner") {
            prefix.to_string()
        } else if prefix.ends_with("/api") {
            format!("{prefix}/local-runner")
        } else {
            format!("{prefix}/api/local-runner")
        };
        Ok(format!(
            "{scheme}://{netloc}{base_path}/ws/{}?token={}",
            self.session, self.token
        ))
    }

    pub fn redacted_websocket_url(&self) -> Result<String, String> {
        let ws_url = self.websocket_url()?;
        Ok(ws_url.split("?token=").next().unwrap_or(ws_url.as_str()).to_string())
    }

    pub fn needs_project_selection(&self) -> bool {
        let project = self.project.trim();
        project.is_empty()
            || project == "<你的项目目录>"
            || project.contains("你的项目")
    }
}

fn grants_file_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(default_project_dir);
    base.join("AutoCodeLocalConnector").join("projects.json")
}

fn connector_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(default_project_dir)
        .join("AutoCodeLocalConnector")
}

fn device_identity_path() -> PathBuf {
    connector_data_dir().join("device.json")
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Windows Device".to_string())
}

pub fn load_or_create_device_identity() -> DeviceIdentity {
    let path = device_identity_path();
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(identity) = serde_json::from_str::<DeviceIdentity>(&text) {
            if !identity.device_id.trim().is_empty() {
                return identity;
            }
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let seed = format!("{}:{}:{}", default_device_name(), std::process::id(), now);
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let digest = hasher.finalize();
    let identity = DeviceIdentity {
        device_id: format!("dev-{:x}", digest)[..28].to_string(),
        device_name: default_device_name(),
        device_os: std::env::consts::OS.to_string(),
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, serde_json::to_string_pretty(&identity).unwrap_or_default());
    identity
}

pub fn load_local_project_grants() -> Vec<LocalProjectGrant> {
    let path = grants_file_path();
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<LocalProjectGrant>>(&text).unwrap_or_default()
}

pub fn save_local_project_grant(mut grant: LocalProjectGrant) -> Result<(), String> {
    if grant.grant_id.trim().is_empty() || grant.project_root.trim().is_empty() {
        return Ok(());
    }
    if grant.project_name.trim().is_empty() {
        grant.project_name = Path::new(&grant.project_root)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "本地项目".to_string());
    }
    let path = grants_file_path();
    let mut grants = load_local_project_grants();
    grants.retain(|item| item.grant_id != grant.grant_id && item.project_root != grant.project_root);
    grants.insert(0, grant);
    grants.truncate(30);
    let parent = path.parent().ok_or_else(|| "invalid grants path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建授权目录失败：{err}"))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&grants).map_err(|err| err.to_string())?)
        .map_err(|err| format!("写入授权文件失败：{err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("保存授权文件失败：{err}"))?;
    Ok(())
}

pub fn open_url(url: &str) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("open URL is empty".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|err| format!("打开网页失败：{err}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|err| format!("打开网页失败：{err}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|err| format!("打开网页失败：{err}"))?;
        return Ok(());
    }
}

pub fn grant_open_url(grant: &LocalProjectGrant) -> String {
    let server_base = grant.server_base.trim().trim_end_matches('/');
    let app_base = if !server_base.is_empty() {
        server_base
            .strip_suffix("/autocode-api")
            .unwrap_or(server_base)
            .trim_end_matches('/')
            .to_string()
    } else if let Ok(parsed) = Url::parse(grant.open_url.trim()) {
        let mut origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
        if let Some(port) = parsed.port() {
            origin.push(':');
            origin.push_str(&port.to_string());
        }
        let path = parsed.path().trim_end_matches('/');
        if path.ends_with("/autocode-api") {
            origin.push_str(path.trim_end_matches("/autocode-api"));
        } else if !path.is_empty() && path != "/" {
            origin.push_str(path);
        }
        origin.trim_end_matches('/').to_string()
    } else {
        String::new()
    };

    if !app_base.is_empty() {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query.append_pair("view", "autocode");
        if !grant.grant_id.trim().is_empty() {
            query.append_pair("local_grant_id", grant.grant_id.trim());
        }
        if !grant.task_id.trim().is_empty() {
            query.append_pair("task_id", grant.task_id.trim());
        }
        if !grant.project_root.trim().is_empty() {
            query.append_pair("local_project_path", grant.project_root.trim());
        }
        if !grant.project_name.trim().is_empty() {
            query.append_pair("local_project_name", grant.project_name.trim());
        }
        return format!("{app_base}/?{}", query.finish());
    }
    grant.open_url.clone()
}

fn device_ws_url(server_base: &str, device_id: &str, grant_id: &str) -> Result<String, String> {
    let parsed = Url::parse(server_base).map_err(|err| format!("invalid AutoCode URL: {err}"))?;
    let scheme = if parsed.scheme() == "https" { "wss" } else { "ws" };
    let host = parsed.host_str().ok_or_else(|| "AutoCode URL missing host".to_string())?;
    let mut netloc = host.to_string();
    if let Some(port) = parsed.port() {
        netloc.push(':');
        netloc.push_str(&port.to_string());
    }
    let prefix = parsed.path().trim_end_matches('/');
    let base_path = if prefix.ends_with("/api/local-runner") {
        prefix.to_string()
    } else if prefix.ends_with("/api") {
        format!("{prefix}/local-runner")
    } else {
        format!("{prefix}/api/local-runner")
    };
    Ok(format!(
        "{scheme}://{netloc}{base_path}/device/ws/{}?grant_id={}",
        device_id, grant_id
    ))
}

pub async fn run_device_presence_loop<F>(mut on_connect: F) -> Result<(), String>
where
    F: FnMut(LaunchConfig) + Send + 'static,
{
    let device = load_or_create_device_identity();
    loop {
        let grant = load_local_project_grants()
            .into_iter()
            .find(|item| !item.server_base.trim().is_empty() && !item.grant_id.trim().is_empty());
        let Some(grant) = grant else {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        };
        let ws_url = match device_ws_url(&grant.server_base, &device.device_id, &grant.grant_id) {
            Ok(value) => value,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };
        match tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url)).await {
            Ok(Ok((ws_stream, _))) => {
                let (mut write, mut read) = ws_stream.split();
                let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
                loop {
                    tokio::select! {
                        _ = heartbeat.tick() => {
                            let msg = json!({
                                "type": "device_heartbeat",
                                "version": VERSION,
                                "device_id": device.device_id.clone(),
                                "device_name": device.device_name.clone(),
                                "device_os": device.device_os.clone(),
                            });
                            if write.send(Message::Text(msg.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                        incoming = read.next() => {
                            let Some(message) = incoming else { break; };
                            let text = match message {
                                Ok(Message::Text(text)) => text.to_string(),
                                Ok(Message::Binary(data)) => String::from_utf8_lossy(&data).to_string(),
                                Ok(Message::Close(_)) => break,
                                Ok(_) => continue,
                                Err(_) => break,
                            };
                            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                                continue;
                            };
                            if parsed.get("type").and_then(Value::as_str) == Some("connect_request") {
                                let config = LaunchConfig {
                                    server: parsed.get("server").and_then(Value::as_str).unwrap_or("").to_string(),
                                    session: parsed.get("session").and_then(Value::as_str).unwrap_or("").to_string(),
                                    token: parsed.get("token").and_then(Value::as_str).unwrap_or("").to_string(),
                                    project: parsed.get("project").and_then(Value::as_str).unwrap_or("").to_string(),
                                    min_version: parsed.get("min_version").and_then(Value::as_str).unwrap_or("").to_string(),
                                    grant_id: parsed.get("grant_id").and_then(Value::as_str).unwrap_or("").to_string(),
                                };
                                if !config.server.is_empty() && !config.session.is_empty() && !config.token.is_empty() {
                                    on_connect(config);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

pub fn default_project_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn pick_project_dir() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("选择要授权给 AutoCode 的项目目录")
        .set_directory(default_project_dir())
        .pick_folder()
}

pub fn resolve_authorized_root(project: &str) -> Result<PathBuf, String> {
    let raw = if project.trim().is_empty() || project.contains("你的项目") {
        default_project_dir()
    } else {
        PathBuf::from(project)
    };
    let root = raw
        .canonicalize()
        .map_err(|err| format!("project directory is not accessible: {err}"))?;
    if !root.is_dir() {
        return Err("project path is not a directory".to_string());
    }
    Ok(root)
}

fn now_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn load_ignore_patterns(root: &Path) -> Vec<String> {
    let mut patterns = DEFAULT_IGNORES.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    let ignore_file = root.join(".autocodeignore");
    if let Ok(text) = fs::read_to_string(ignore_file) {
        for raw in text.lines() {
            let line = raw.trim();
            if !line.is_empty() && !line.starts_with('#') {
                patterns.push(line.replace('\\', "/"));
            }
        }
    }
    patterns
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let (mut p, mut v) = (0usize, 0usize);
    let (mut star, mut match_at) = (None, 0usize);
    let p_bytes = pattern.as_bytes();
    let v_bytes = value.as_bytes();
    while v < v_bytes.len() {
        if p < p_bytes.len() && (p_bytes[p] == b'?' || p_bytes[p] == v_bytes[v]) {
            p += 1;
            v += 1;
        } else if p < p_bytes.len() && p_bytes[p] == b'*' {
            star = Some(p);
            match_at = v;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            match_at += 1;
            v = match_at;
        } else {
            return false;
        }
    }
    while p < p_bytes.len() && p_bytes[p] == b'*' {
        p += 1;
    }
    p == p_bytes.len()
}

fn is_ignored(rel: &str, patterns: &[String]) -> bool {
    let normalized = rel.replace('\\', "/").trim_start_matches('/').to_string();
    patterns.iter().any(|pattern| {
        let p = pattern.trim().replace('\\', "/").trim_start_matches('/').to_string();
        if p.is_empty() {
            return false;
        }
        if p.ends_with('/') {
            let dir = p.trim_end_matches('/');
            normalized == dir || normalized.starts_with(&format!("{dir}/"))
        } else {
            wildcard_match(&p, &normalized)
        }
    })
}

pub fn ensure_inside_root(root: &Path, requested: &str, patterns: &[String], must_exist: bool) -> Result<PathBuf, String> {
    let normalized = requested.replace('\\', "/");
    let relative = normalized
        .strip_prefix("/workspace/")
        .unwrap_or(normalized.as_str())
        .trim_start_matches('/');
    let target = root.join(relative);
    let checked = if must_exist {
        target.canonicalize().map_err(|err| format!("path is not accessible: {err}"))?
    } else {
        target
    };
    if !checked.starts_with(root) {
        return Err("path escapes the authorized project directory".to_string());
    }
    if let Ok(rel) = checked.strip_prefix(root) {
        let rel_text = rel.to_string_lossy().replace('\\', "/");
        if !rel_text.is_empty() && is_ignored(&rel_text, patterns) {
            return Err(format!("path is ignored by .autocodeignore: {rel_text}"));
        }
    }
    Ok(checked)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("failed to create parent directory: {err}"))?;
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("autocode"),
        stamp
    ));
    fs::write(&tmp, content.as_bytes()).map_err(|err| format!("failed to write temp file: {err}"))?;
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("failed to replace file: {err}")
    })?;
    Ok(())
}

fn arg_string(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn arg_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key).and_then(Value::as_u64).map(|v| v as usize).unwrap_or(default)
}

fn read_file(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, true)?;
    if !path.is_file() {
        return Err("target is not a file".to_string());
    }
    let limit = arg_usize(args, "limit", 20_000).max(1);
    let text = fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
    Ok(json!({"ok": true, "result": text.chars().take(limit).collect::<String>()}))
}

fn write_file(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, false)?;
    let content = arg_string(args, "content");
    atomic_write(&path, &content)?;
    let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
    Ok(json!({"ok": true, "result": format!("[OK] file written: {rel}"), "path": rel, "content": content}))
}

fn apply_patch_tool(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, true)?;
    let search = arg_string(args, "search");
    let replace = arg_string(args, "replace");
    if search.is_empty() {
        return Err("apply_patch requires search".to_string());
    }
    let text = fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
    if !text.contains(&search) {
        return Err("search text was not found".to_string());
    }
    let updated = text.replacen(&search, &replace, 1);
    atomic_write(&path, &updated)?;
    let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
    Ok(json!({"ok": true, "result": format!("[OK] file patched: {rel}"), "path": rel, "content": updated}))
}

fn glob_tool(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let pattern = arg_string(args, "pattern").replace('\\', "/");
    let pattern = if pattern.is_empty() { "**/*".to_string() } else { pattern };
    let simple_pattern = pattern.trim_start_matches("**/").to_string();
    let mut matches = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
        if is_ignored(&rel, patterns) {
            continue;
        }
        if wildcard_match(&pattern, &rel) || wildcard_match(&simple_pattern, &rel) {
            matches.push(rel);
        }
        if matches.len() >= 200 {
            break;
        }
    }
    Ok(json!({"ok": true, "result": matches.join("\n")}))
}

fn search_code(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let pattern = arg_string(args, "pattern");
    let glob_filter = {
        let g = arg_string(args, "glob");
        if g.is_empty() { "*".to_string() } else { g }
    };
    if pattern.is_empty() {
        return Err("search_code requires pattern".to_string());
    }
    let needle = pattern.to_lowercase();
    let mut lines = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
        if is_ignored(&rel, patterns) || !wildcard_match(&glob_filter, &rel) {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { continue; };
        for (idx, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                lines.push(format!("{}:{}: {}", rel, idx + 1, line.chars().take(240).collect::<String>()));
                if lines.len() >= 100 {
                    return Ok(json!({"ok": true, "result": lines.join("\n")}));
                }
            }
        }
    }
    Ok(json!({"ok": true, "result": if lines.is_empty() { "[no matches]".to_string() } else { lines.join("\n") }}))
}

fn snapshot_files(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let max_files = arg_usize(args, "max_files", 800);
    let max_total_bytes = arg_usize(args, "max_total_bytes", 8 * 1024 * 1024);
    let max_file_bytes = arg_usize(args, "max_file_bytes", 512 * 1024);
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total_bytes = 0usize;
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
        if is_ignored(&rel, patterns) {
            continue;
        }
        let Ok(data) = fs::read(path) else { continue; };
        let size = data.len();
        if size > max_file_bytes {
            skipped.push(json!({"path": rel, "reason": "file_too_large", "size": size}));
            continue;
        }
        if files.len() >= max_files || total_bytes + size > max_total_bytes {
            skipped.push(json!({"path": rel, "reason": "snapshot_limit", "size": size}));
            continue;
        }
        let Ok(content) = String::from_utf8(data.clone()) else {
            skipped.push(json!({"path": rel, "reason": "binary_or_non_utf8", "size": size}));
            continue;
        };
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let sha256 = format!("{:x}", hasher.finalize());
        total_bytes += size;
        files.push(json!({"path": rel, "content": content, "size": size, "sha256": sha256}));
    }
    let skipped_count = skipped.len();
    if skipped.len() > 200 {
        skipped.truncate(200);
    }
    Ok(json!({
        "ok": true,
        "result": format!("[OK] snapshot files={} skipped={} bytes={}", files.len(), skipped_count, total_bytes),
        "files": files,
        "skipped": skipped,
        "file_count": files.len(),
        "skipped_count": skipped_count,
        "total_bytes": total_bytes
    }))
}

fn normalize_command(command: &str) -> String {
    let mut normalized = command.trim().replace("/workspace/", "./").replace("/workspace", ".");
    if cfg!(windows) {
        let lowered = normalized.to_lowercase();
        if lowered == "pwd" || lowered == "pwd;" {
            return "cd".to_string();
        }
        if lowered == "ls" || lowered == "ls -la" || lowered == "ls -al" {
            return "dir".to_string();
        }
        if lowered == "find . -type f" || lowered == "find . -type f;" {
            return "dir /s /b".to_string();
        }
        if lowered.starts_with("find . ") && lowered.contains(" -type f") {
            return "dir /s /b".to_string();
        }
        if normalized.starts_with("python3 ") {
            normalized = normalized.replacen("python3 ", "python ", 1);
        }
    }
    normalized
}

fn run_command_with_timeout(root: &Path, command: &str, timeout_secs: u64) -> Result<(bool, i32, String), String> {
    let mut child = if cfg!(windows) {
        Command::new("cmd")
            .arg("/C")
            .arg(command)
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        Command::new("sh")
            .arg("-lc")
            .arg(command)
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
    .map_err(|err| format!("failed to run command: {err}"))?;

    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|err| format!("failed to poll command: {err}"))? {
            let output = child.wait_with_output().map_err(|err| format!("failed to collect command output: {err}"))?;
            let mut text = String::new();
            text.push_str(&String::from_utf8_lossy(&output.stdout));
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            return Ok((status.success(), status.code().unwrap_or(-1), text));
        }
        if started.elapsed() >= Duration::from_secs(timeout_secs.max(1)) {
            let _ = child.kill();
            let output = child.wait_with_output().map_err(|err| format!("failed to collect timed-out command output: {err}"))?;
            let mut text = format!("[LOCAL_RUNNER_TIMEOUT] command exceeded {}s\n", timeout_secs.max(1));
            text.push_str(&String::from_utf8_lossy(&output.stdout));
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            return Ok((false, -1, text));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn bash(root: &Path, _patterns: &[String], args: &Value) -> Result<Value, String> {
    let command = normalize_command(&arg_string(args, "command"));
    if command.is_empty() {
        return Err("bash requires command".to_string());
    }
    let timeout = args.get("timeout").and_then(Value::as_u64).or_else(|| args.get("command_timeout").and_then(Value::as_u64)).unwrap_or(120);
    let max_output = arg_usize(args, "max_output", 20_000);
    let (ok, exit_code, text) = run_command_with_timeout(root, &command, timeout)?;
    let result = if text.len() > max_output {
        text.chars().rev().take(max_output).collect::<String>().chars().rev().collect::<String>()
    } else {
        text
    };
    Ok(json!({"ok": ok, "result": result, "exit_code": exit_code}))
}

fn git_diff(root: &Path, _patterns: &[String], _args: &Value) -> Result<Value, String> {
    let (ok, exit_code, text) = run_command_with_timeout(root, "git diff -- .", 60)?;
    Ok(json!({"ok": ok, "result": text, "exit_code": exit_code}))
}

fn execute_tool(root: &Path, patterns: &[String], tool: &str, args: &Value) -> Result<Value, String> {
    match tool {
        "read_file" => read_file(root, patterns, args),
        "write_file" => write_file(root, patterns, args),
        "apply_patch" => apply_patch_tool(root, patterns, args),
        "glob" => glob_tool(root, patterns, args),
        "search_code" => search_code(root, patterns, args),
        "snapshot_files" => snapshot_files(root, patterns, args),
        "bash" => bash(root, patterns, args),
        "git_diff" => git_diff(root, patterns, args),
        other => Err(format!("unsupported tool: {other}")),
    }
}

fn snapshot(
    config: &LaunchConfig,
    root: &Path,
    redacted_ws_url: &str,
    status: &str,
    detail: String,
    connected: bool,
    running: bool,
    last_error: String,
    last_heartbeat_at: String,
) -> RunnerSnapshot {
    RunnerSnapshot {
        status: status.to_string(),
        detail,
        server: config.server.clone(),
        session: config.session.clone(),
        project: root.to_string_lossy().to_string(),
        redacted_ws_url: redacted_ws_url.to_string(),
        version: VERSION.to_string(),
        last_error,
        last_heartbeat_at,
        connected,
        running,
    }
}

pub async fn run_connector_loop<F>(
    config: LaunchConfig,
    root: PathBuf,
    generation: u64,
    active_generation: Arc<AtomicU64>,
    mut update: F,
) -> Result<(), String>
where
    F: FnMut(RunnerSnapshot) + Send + 'static,
{
    let root = root.canonicalize().map_err(|err| format!("project directory is not accessible: {err}"))?;
    let patterns = load_ignore_patterns(&root);
    let device = load_or_create_device_identity();
    let ws_url = config.websocket_url()?;
    let redacted_ws_url = config.redacted_websocket_url().unwrap_or_else(|_| "(invalid ws url)".to_string());
    let mut attempt = 0u32;
    let mut last_error = String::new();
    let mut last_heartbeat_at = String::new();

    // 若一个更新的会话（更高代次）已经接管，则本循环优雅退出，不再覆盖新会话状态。
    let superseded = || active_generation.load(Ordering::SeqCst) != generation;

    loop {
        if superseded() {
            return Ok(());
        }
        attempt += 1;
        update(snapshot(
            &config,
            &root,
            &redacted_ws_url,
            "connecting",
            format!("正在连接 AutoCode（第 {attempt} 次）：{redacted_ws_url}"),
            false,
            true,
            last_error.clone(),
            last_heartbeat_at.clone(),
        ));

        match tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url)).await {
            Err(_) => {
                last_error = format!("连接 15 秒超时：{redacted_ws_url}");
                update(snapshot(&config, &root, &redacted_ws_url, "reconnecting", last_error.clone(), false, true, last_error.clone(), last_heartbeat_at.clone()));
            }
            Ok(Err(err)) => {
                last_error = format!("连接失败：{err}");
                update(snapshot(&config, &root, &redacted_ws_url, "reconnecting", format!("{}。URL：{}", last_error, redacted_ws_url), false, true, last_error.clone(), last_heartbeat_at.clone()));
            }
            Ok(Ok((ws_stream, _))) => {
                attempt = 0;
                let (mut write, mut read) = ws_stream.split();
                let hello = json!({
                    "type": "hello",
                    "version": VERSION,
                    "device_id": device.device_id.clone(),
                    "device_name": device.device_name.clone(),
                    "device_os": device.device_os.clone(),
                    "project_root": root.to_string_lossy(),
                    "ignore_count": patterns.len(),
                    "pid": std::process::id()
                });
                let hello_result = tokio::time::timeout(Duration::from_secs(10), write.send(Message::Text(hello.to_string().into()))).await;
                if let Err(err) = hello_result.map_err(|_| "发送 hello 超时".to_string()).and_then(|result| result.map_err(|err| format!("发送 hello 失败：{err}"))) {
                    last_error = err;
                    update(snapshot(&config, &root, &redacted_ws_url, "reconnecting", last_error.clone(), false, true, last_error.clone(), last_heartbeat_at.clone()));
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }

                last_error.clear();
                update(snapshot(&config, &root, &redacted_ws_url, "connected", "已连接，正在等待 AutoCode 工具请求。".to_string(), true, true, String::new(), last_heartbeat_at.clone()));

                let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
                let mut supersede_check = tokio::time::interval(Duration::from_millis(500));
                loop {
                    tokio::select! {
                        _ = supersede_check.tick() => {
                            // 有更新的会话接管时，主动断开旧连接并优雅退出，把控制权交给新循环。
                            if superseded() {
                                let _ = tokio::time::timeout(
                                    Duration::from_secs(3),
                                    write.send(Message::Close(None)),
                                ).await;
                                return Ok(());
                            }
                        }
                        _ = heartbeat.tick() => {
                            last_heartbeat_at = now_secs();
                            let heartbeat_msg = json!({
                                "type": "heartbeat",
                                "version": VERSION,
                                "device_id": device.device_id.clone(),
                                "device_name": device.device_name.clone(),
                                "device_os": device.device_os.clone(),
                                "project_root": root.to_string_lossy(),
                                "ignore_count": patterns.len(),
                                "sent_at": last_heartbeat_at
                            });
                            let sent = tokio::time::timeout(Duration::from_secs(8), write.send(Message::Text(heartbeat_msg.to_string().into()))).await;
                            if let Err(err) = sent.map_err(|_| "心跳发送超时".to_string()).and_then(|result| result.map_err(|err| format!("心跳发送失败：{err}"))) {
                                last_error = err;
                                update(snapshot(&config, &root, &redacted_ws_url, "reconnecting", last_error.clone(), false, true, last_error.clone(), last_heartbeat_at.clone()));
                                break;
                            }
                        }
                        incoming = read.next() => {
                            let Some(message) = incoming else { break; };
                            let message = match message {
                                Ok(Message::Text(text)) => text.to_string(),
                                Ok(Message::Binary(data)) => String::from_utf8_lossy(&data).to_string(),
                                Ok(Message::Close(_)) => break,
                                Ok(_) => continue,
                                Err(err) => {
                                    last_error = format!("读取 WebSocket 失败：{err}");
                                    update(snapshot(&config, &root, &redacted_ws_url, "reconnecting", last_error.clone(), false, true, last_error.clone(), last_heartbeat_at.clone()));
                                    break;
                                }
                            };
                            let parsed: Value = match serde_json::from_str(&message) {
                                Ok(value) => value,
                                Err(_) => continue,
                            };
                            if parsed.get("type").and_then(Value::as_str) == Some("session_disabled") {
                                update(snapshot(
                                    &config,
                                    &root,
                                    &redacted_ws_url,
                                    "ready",
                                    "Local execution has been closed in the browser. Waiting for a new browser connection.".to_string(),
                                    false,
                                    false,
                                    String::new(),
                                    last_heartbeat_at.clone(),
                                ));
                                return Ok(());
                            }
                            if parsed.get("type").and_then(Value::as_str) == Some("local_project_grant") {
                                match serde_json::from_value::<LocalProjectGrant>(parsed.clone()) {
                                    Ok(grant) => {
                                        if let Err(err) = save_local_project_grant(grant) {
                                            last_error = err;
                                        }
                                    }
                                    Err(err) => {
                                        last_error = format!("保存本地项目授权失败：{err}");
                                    }
                                }
                                continue;
                            }
                            if parsed.get("type").and_then(Value::as_str) != Some("tool_request") {
                                continue;
                            }
                            let request_id = parsed.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let tool = parsed.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
                            let args = parsed.get("args").cloned().unwrap_or_else(|| json!({}));
                            update(snapshot(&config, &root, &redacted_ws_url, "working", format!("正在执行工具：{tool}"), true, true, String::new(), last_heartbeat_at.clone()));
                            let response = match execute_tool(&root, &patterns, &tool, &args) {
                                Ok(mut result) => {
                                    if let Some(obj) = result.as_object_mut() {
                                        obj.insert("type".to_string(), json!("tool_result"));
                                        obj.insert("id".to_string(), json!(request_id));
                                        obj.insert("tool".to_string(), json!(tool));
                                    }
                                    result
                                }
                                Err(err) => json!({
                                    "type": "tool_result",
                                    "id": request_id,
                                    "tool": tool,
                                    "ok": false,
                                    "result": format!("[LOCAL_RUNNER_ERROR] {err}"),
                                    "error": err
                                }),
                            };
                            let sent = tokio::time::timeout(Duration::from_secs(10), write.send(Message::Text(response.to_string().into()))).await;
                            if let Err(err) = sent.map_err(|_| "工具结果发送超时".to_string()).and_then(|result| result.map_err(|err| format!("工具结果发送失败：{err}"))) {
                                last_error = err;
                                update(snapshot(&config, &root, &redacted_ws_url, "reconnecting", last_error.clone(), false, true, last_error.clone(), last_heartbeat_at.clone()));
                                break;
                            }
                            update(snapshot(&config, &root, &redacted_ws_url, "connected", "工具结果已发送，等待下一次请求。".to_string(), true, true, String::new(), last_heartbeat_at.clone()));
                        }
                    }
                }
            }
        }

        let delay = (1u64 << attempt.min(5)).min(30);
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}
