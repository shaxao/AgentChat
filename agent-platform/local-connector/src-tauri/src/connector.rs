use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::{form_urlencoded, Url};
use walkdir::WalkDir;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

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

const GIT_AUTO_STAGE_MAX_DIR_FILES: usize = 300;
const GIT_AUTO_STAGE_MAX_DIR_BYTES: u64 = 100 * 1024 * 1024;

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
        let parsed =
            Url::parse(&self.server).map_err(|err| format!("invalid AutoCode URL: {err}"))?;
        let scheme = if parsed.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        let host = parsed
            .host_str()
            .ok_or_else(|| "AutoCode URL missing host".to_string())?;
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
        Ok(ws_url
            .split("?token=")
            .next()
            .unwrap_or(ws_url.as_str())
            .to_string())
    }

    pub fn needs_project_selection(&self) -> bool {
        let project = self.project.trim();
        project.is_empty() || project == "<你的项目目录>" || project.contains("你的项目")
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
    let _ = fs::write(
        &path,
        serde_json::to_string_pretty(&identity).unwrap_or_default(),
    );
    identity
}

pub fn load_local_project_grants() -> Vec<LocalProjectGrant> {
    let path = grants_file_path();
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<LocalProjectGrant>>(&text).unwrap_or_default()
}

fn write_local_project_grants(grants: &[LocalProjectGrant]) -> Result<(), String> {
    let path = grants_file_path();
    let parent = path
        .parent()
        .ok_or_else(|| "invalid grants path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建授权目录失败：{err}"))?;
    let tmp = path.with_extension("tmp");
    fs::write(
        &tmp,
        serde_json::to_string_pretty(grants).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("写入授权文件失败：{err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("保存授权文件失败：{err}"))?;
    Ok(())
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
    let mut grants = load_local_project_grants();
    let is_local_grant = grant.grant_id.starts_with("local-");
    grants.retain(|item| {
        if item.grant_id == grant.grant_id {
            return false;
        }
        if is_local_grant {
            !(item.grant_id.starts_with("local-") && item.project_root == grant.project_root)
        } else {
            item.project_root != grant.project_root
        }
    });
    grants.insert(0, grant);
    grants.truncate(30);
    write_local_project_grants(&grants)?;
    Ok(())
}

pub fn remove_local_project_grant(grant_id: &str) -> Result<Option<LocalProjectGrant>, String> {
    let grant_id = grant_id.trim();
    if grant_id.is_empty() {
        return Err("grant_id is required".to_string());
    }
    let mut removed = None;
    let mut grants = load_local_project_grants();
    grants.retain(|item| {
        if item.grant_id == grant_id {
            removed = Some(item.clone());
            false
        } else {
            true
        }
    });
    if removed.is_some() {
        write_local_project_grants(&grants)?;
    }
    Ok(removed)
}

pub fn update_local_project_grant_server(
    grant_id: &str,
    server_base: &str,
) -> Result<LocalProjectGrant, String> {
    let grant_id = grant_id.trim();
    if grant_id.is_empty() {
        return Err("grant_id is required".to_string());
    }
    let server_base = server_base.trim().trim_end_matches('/').to_string();
    if server_base.is_empty() {
        return Err("AutoCode 地址不能为空".to_string());
    }
    let mut grants = load_local_project_grants();
    let Some(pos) = grants.iter().position(|item| item.grant_id == grant_id) else {
        return Err("本地项目授权不存在或已清理".to_string());
    };
    let mut grant = grants[pos].clone();
    grant.server_base = server_base;
    if grant.grant_id.starts_with("local-") {
        grant.open_url = local_import_open_url(
            &grant.server_base,
            &grant.open_url,
            &grant.project_root,
            &grant.project_name,
        );
    }
    grants.remove(pos);
    grants.insert(0, grant.clone());
    write_local_project_grants(&grants)?;
    Ok(grant)
}

fn iso_now_and_expiry() -> (String, String) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expires = now.saturating_add(30 * 24 * 60 * 60);
    (now.to_string(), expires.to_string())
}

fn project_name_from_root(root: &Path) -> String {
    root.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "本地项目".to_string())
}

pub fn autocode_app_base(server_base: &str, open_url: &str) -> String {
    let server_base = server_base.trim().trim_end_matches('/');
    if !server_base.is_empty() {
        return server_base
            .strip_suffix("/autocode-api")
            .unwrap_or(server_base)
            .trim_end_matches('/')
            .to_string();
    }
    if let Ok(parsed) = Url::parse(open_url.trim()) {
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
        return origin.trim_end_matches('/').to_string();
    }
    String::new()
}

pub fn local_import_open_url(
    server_base: &str,
    open_url: &str,
    project_root: &str,
    project_name: &str,
) -> String {
    local_import_open_url_for_grant(server_base, open_url, project_root, project_name, "")
}

pub fn local_import_open_url_for_grant(
    server_base: &str,
    open_url: &str,
    project_root: &str,
    project_name: &str,
    grant_id: &str,
) -> String {
    let app_base = autocode_app_base(server_base, open_url);
    if app_base.is_empty() {
        return String::new();
    }
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("view", "autocode");
    query.append_pair("connector_action", "import_local");
    query.append_pair("auto_launch_local", "1");
    query.append_pair("auto_import_local", "1");
    query.append_pair("sync_to_cloud", "0");
    query.append_pair("local_project_path", project_root.trim());
    query.append_pair("local_project_name", project_name.trim());
    let device = load_or_create_device_identity();
    query.append_pair("connector_grant_id", grant_id.trim());
    query.append_pair("connector_device_id", &device.device_id);
    query.append_pair("connector_device_name", &device.device_name);
    query.append_pair("connector_device_os", &device.device_os);
    format!("{app_base}/?{}", query.finish())
}

pub fn create_local_project_grant(
    project: &Path,
    server_base: &str,
    open_url: &str,
) -> Result<LocalProjectGrant, String> {
    let root = resolve_authorized_root(&project.to_string_lossy())?;
    let root_text = root.to_string_lossy().to_string();
    let project_name = project_name_from_root(&root);
    let (last_used_at, expires_at) = iso_now_and_expiry();
    if let Some(mut grant) = load_local_project_grants()
        .into_iter()
        .find(|item| item.grant_id.starts_with("local-") && item.project_root == root_text)
    {
        if !server_base.trim().is_empty() {
            grant.server_base = server_base.trim().trim_end_matches('/').to_string();
        }
        if grant.project_name.trim().is_empty() {
            grant.project_name = project_name;
        }
        grant.last_used_at = last_used_at;
        grant.expires_at = expires_at;
        if grant.grant_id.starts_with("local-") || grant.open_url.trim().is_empty() {
            grant.open_url = local_import_open_url_for_grant(
                &grant.server_base,
                open_url,
                &grant.project_root,
                &grant.project_name,
                &grant.grant_id,
            );
        }
        save_local_project_grant(grant.clone())?;
        return Ok(grant);
    }
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(root_text.as_bytes());
    hasher.update(now_nanos.to_string().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let grant_id = format!("local-{}", &digest[..24]);
    let import_url = local_import_open_url_for_grant(
        server_base,
        open_url,
        &root_text,
        &project_name,
        &grant_id,
    );
    let grant = LocalProjectGrant {
        grant_id,
        server_base: server_base.trim().trim_end_matches('/').to_string(),
        project_root: root_text,
        project_name,
        task_id: String::new(),
        workspace_id: String::new(),
        expires_at,
        last_used_at,
        open_url: import_url,
    };
    save_local_project_grant(grant.clone())?;
    Ok(grant)
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
    if grant.grant_id.starts_with("local-") {
        let import_url = local_import_open_url_for_grant(
            &grant.server_base,
            &grant.open_url,
            &grant.project_root,
            &grant.project_name,
            &grant.grant_id,
        );
        if !import_url.trim().is_empty() {
            return import_url;
        }
        if !grant.open_url.trim().is_empty() {
            return grant.open_url.clone();
        }
    }

    let app_base = autocode_app_base(&grant.server_base, &grant.open_url);

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
    let scheme = if parsed.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| "AutoCode URL missing host".to_string())?;
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

pub async fn run_device_presence_loop<F>(on_connect: F) -> Result<(), String>
where
    F: Fn(LaunchConfig) + Send + Sync + 'static,
{
    let device = load_or_create_device_identity();
    let on_connect = Arc::new(on_connect);
    let mut active_grants: HashSet<String> = HashSet::new();
    loop {
        let grants = load_local_project_grants()
            .into_iter()
            .filter(|item| {
                !item.server_base.trim().is_empty()
                    && !item.grant_id.trim().is_empty()
                    && !item.project_root.trim().is_empty()
            })
            .collect::<Vec<_>>();
        if grants.is_empty() {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        }

        active_grants.retain(|grant_id| grants.iter().any(|grant| &grant.grant_id == grant_id));
        for grant in grants {
            if active_grants.contains(&grant.grant_id) {
                continue;
            }
            active_grants.insert(grant.grant_id.clone());
            let device = device.clone();
            let on_connect = on_connect.clone();
            tokio::spawn(async move {
                run_device_presence_for_grant(device, grant, on_connect).await;
            });
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

async fn run_device_presence_for_grant(
    device: DeviceIdentity,
    grant: LocalProjectGrant,
    on_connect: Arc<dyn Fn(LaunchConfig) + Send + Sync>,
) {
    loop {
        let still_authorized = load_local_project_grants()
            .into_iter()
            .any(|item| item.grant_id == grant.grant_id);
        if !still_authorized {
            return;
        }
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
                let mut grant_check = tokio::time::interval(Duration::from_secs(3));
                loop {
                    tokio::select! {
                        _ = grant_check.tick() => {
                            let still_authorized = load_local_project_grants()
                                .into_iter()
                                .any(|item| item.grant_id == grant.grant_id);
                            if !still_authorized {
                                let _ = tokio::time::timeout(
                                    Duration::from_secs(3),
                                    write.send(Message::Close(None)),
                                ).await;
                                return;
                            }
                        }
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
    let mut patterns = DEFAULT_IGNORES
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
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
        let p = pattern
            .trim()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        if p.is_empty() {
            return false;
        }
        if p.ends_with('/') {
            let dir = p.trim_end_matches('/');
            normalized == dir
                || normalized.starts_with(&format!("{dir}/"))
                || normalized.ends_with(&format!("/{dir}"))
                || normalized.contains(&format!("/{dir}/"))
        } else {
            wildcard_match(&p, &normalized)
        }
    })
}

pub fn ensure_inside_root(
    root: &Path,
    requested: &str,
    patterns: &[String],
    must_exist: bool,
) -> Result<PathBuf, String> {
    let raw = requested.trim();
    let target = if raw.replace('\\', "/").starts_with("/workspace/") {
        let normalized = raw.replace('\\', "/");
        let relative = normalized
            .strip_prefix("/workspace/")
            .unwrap_or(normalized.as_str())
            .trim_start_matches('/');
        root.join(relative)
    } else {
        let candidate = PathBuf::from(raw);
        if candidate.is_absolute() {
            candidate
        } else {
            root.join(raw.trim_start_matches(['/', '\\']))
        }
    };
    let checked = if must_exist {
        target
            .canonicalize()
            .map_err(|err| format!("path is not accessible: {err}"))?
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
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create parent directory: {err}"))?;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("autocode"),
        stamp
    ));
    fs::write(&tmp, content.as_bytes())
        .map_err(|err| format!("failed to write temp file: {err}"))?;
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("failed to replace file: {err}")
    })?;
    Ok(())
}

fn arg_string(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn arg_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(default)
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

fn read_lines(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, true)?;
    if !path.is_file() {
        return Err("target is not a file".to_string());
    }
    let start = arg_usize(args, "start", 1).max(1);
    let mut end = arg_usize(args, "end", start).max(start);
    let max_lines = 240usize;
    if end - start + 1 > max_lines {
        end = start + max_lines - 1;
    }
    let text = fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let selected_end = end.min(total);
    let width = selected_end
        .to_string()
        .len()
        .max(start.to_string().len())
        .max(3);
    let mut body = String::new();
    if start <= total {
        for (offset, line) in lines[start - 1..selected_end].iter().enumerate() {
            let idx = start + offset;
            body.push_str(&format!("{idx:>width$} | {line}\n"));
        }
    }
    if body.ends_with('\n') {
        body.pop();
    }
    if body.is_empty() {
        body = "(no lines in requested range)".to_string();
    }
    let display_end = if start > total { total } else { selected_end };
    let rel = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(json!({
        "ok": true,
        "result": format!("[OK] {rel} lines {start}-{display_end} of {total}\n{body}"),
        "path": rel,
        "start": start,
        "end": display_end,
        "total_lines": total
    }))
}

fn write_file(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, false)?;
    let content = arg_string(args, "content");
    atomic_write(&path, &content)?;
    let rel = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(
        json!({"ok": true, "result": format!("[OK] file written: {rel}"), "path": rel, "content": content}),
    )
}

fn normalize_text_encoding(args: &Value) -> Result<String, String> {
    let encoding = arg_string(args, "encoding")
        .to_lowercase()
        .replace('_', "-");
    let encoding = if encoding.is_empty() {
        "utf-8".to_string()
    } else {
        encoding
    };
    match encoding.as_str() {
        "utf-8" | "utf-8-sig" => Ok(encoding),
        _ => Err("local text file tools only support utf-8 or utf-8-sig".to_string()),
    }
}

fn local_write_text_file(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, false)?;
    let content = arg_string(args, "content");
    let encoding = normalize_text_encoding(args)?;
    atomic_write(&path, &content)?;
    let rel = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "ok": true,
        "result": format!("[OK] text file written: {rel}"),
        "path": rel,
        "absolute_path": path.to_string_lossy().to_string(),
        "content": content,
        "encoding": encoding,
        "size": size
    }))
}

fn local_read_text_file(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let path = ensure_inside_root(root, &arg_string(args, "path"), patterns, true)?;
    if !path.is_file() {
        return Err("target is not a file".to_string());
    }
    let encoding = normalize_text_encoding(args)?;
    let content = fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
    let rel = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "ok": true,
        "result": content,
        "path": rel,
        "absolute_path": path.to_string_lossy().to_string(),
        "content": content,
        "encoding": encoding,
        "size": size
    }))
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
    let rel = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(
        json!({"ok": true, "result": format!("[OK] file patched: {rel}"), "path": rel, "content": updated}),
    )
}

// ── code_editor：编辑器式文件工具（view/create/str_replace/insert/undo_edit）──
static CODE_EDITOR_UNDO: OnceLock<Mutex<HashMap<String, Vec<Option<String>>>>> = OnceLock::new();
const CODE_EDITOR_UNDO_LIMIT: usize = 20;
const CODE_EDITOR_DIFF_LIMIT: usize = 4000;

fn code_editor_undo_stack() -> &'static Mutex<HashMap<String, Vec<Option<String>>>> {
    CODE_EDITOR_UNDO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn push_undo(key: &str, old_text: Option<String>) {
    let mut guard = code_editor_undo_stack()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let stack = guard.entry(key.to_string()).or_default();
    stack.push(old_text);
    if stack.len() > CODE_EDITOR_UNDO_LIMIT {
        stack.remove(0);
    }
}

fn take_undo(key: &str) -> Option<Option<String>> {
    let mut guard = code_editor_undo_stack()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    guard.get_mut(key).and_then(|stack| stack.pop())
}

/// 生成紧凑 unified diff（公共前后缀裁剪，适合局部编辑场景）。
fn unified_diff(old: &str, new: &str, rel: &str) -> String {
    if old == new {
        return "(无内容差异)".to_string();
    }
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut start = 0usize;
    while start < old_lines.len() && start < new_lines.len() && old_lines[start] == new_lines[start]
    {
        start += 1;
    }
    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > start && new_end > start && old_lines[old_end - 1] == new_lines[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    let ctx = 3usize;
    let ctx_start = start.saturating_sub(ctx);
    let old_hunk_len = (old_end - start) + (start - ctx_start) + ctx.min(old_lines.len() - old_end);
    let new_hunk_len = (new_end - start) + (start - ctx_start) + ctx.min(new_lines.len() - new_end);
    let mut out = format!(
        "--- a/{rel}\n+++ b/{rel}\n@@ -{},{} +{},{} @@\n",
        ctx_start + 1,
        old_hunk_len,
        ctx_start + 1,
        new_hunk_len
    );
    for i in ctx_start..start {
        out.push_str(&format!(" {}\n", old_lines[i]));
    }
    for i in start..old_end {
        out.push_str(&format!("-{}\n", old_lines[i]));
    }
    for i in start..new_end {
        out.push_str(&format!("+{}\n", new_lines[i]));
    }
    let tail_end = (new_end + ctx).min(new_lines.len());
    for i in new_end..tail_end {
        out.push_str(&format!(" {}\n", new_lines[i]));
    }
    if out.chars().count() > CODE_EDITOR_DIFF_LIMIT {
        out = out.chars().take(CODE_EDITOR_DIFF_LIMIT).collect();
        out.push_str("\n... (diff 已截断)");
    }
    out
}

fn code_editor_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn code_editor(
    session_id: &str,
    root: &Path,
    patterns: &[String],
    args: &Value,
) -> Result<Value, String> {
    let command = arg_string(args, "command");
    let raw_path = arg_string(args, "path");
    // 按会话隔离撤销历史：同一目录被多个会话（多个 task）同时打开时，
    // A 会话的 undo 不能串到 B 会话。键里带上 session_id 即可各自独立。
    let undo_key = format!(
        "{}::{}::{}",
        session_id,
        root.display(),
        raw_path.trim_start_matches('/')
    );

    match command.as_str() {
        "view" => {
            let path = ensure_inside_root(root, &raw_path, patterns, true)?;
            if !path.is_file() {
                return Err("target is not a file".to_string());
            }
            let text =
                fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();
            let (mut start, mut end) = (1usize, total);
            if let Some(range) = args.get("view_range").and_then(Value::as_array) {
                if range.len() == 2 {
                    start = range[0].as_i64().unwrap_or(1).max(1) as usize;
                    end = (range[1].as_i64().unwrap_or(total as i64).max(0) as usize).min(total);
                }
            }
            let mut numbered = String::new();
            for i in start..=end {
                if (1..=total).contains(&i) {
                    numbered.push_str(&format!("{:>6}\t{}\n", i, lines[i - 1]));
                }
            }
            let rel = code_editor_rel(root, &path);
            Ok(
                json!({"ok": true, "result": format!("[OK] {rel} lines {start}-{end} of {total}:\n{numbered}"), "path": rel}),
            )
        }
        "create" => {
            let path = ensure_inside_root(root, &raw_path, patterns, false)?;
            if path.is_dir() {
                return Err("cannot overwrite a directory".to_string());
            }
            let old_text = if path.is_file() {
                Some(
                    fs::read_to_string(&path)
                        .map_err(|err| format!("failed to read file: {err}"))?,
                )
            } else {
                None
            };
            let new_text = arg_string(args, "file_text");
            atomic_write(&path, &new_text)?;
            push_undo(&undo_key, old_text.clone());
            let rel = code_editor_rel(root, &path);
            let diff = unified_diff(old_text.as_deref().unwrap_or(""), &new_text, &rel);
            Ok(
                json!({"ok": true, "result": format!("[OK] file written: {rel}\n{diff}"), "path": rel, "diff": diff, "content": new_text}),
            )
        }
        "str_replace" => {
            let path = ensure_inside_root(root, &raw_path, patterns, true)?;
            if !path.is_file() {
                return Err("target is not a file".to_string());
            }
            let original =
                fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
            let old_str = arg_string(args, "old_str");
            let new_str = arg_string(args, "new_str");
            if old_str.is_empty() {
                return Err("str_replace requires old_str".to_string());
            }
            // 换行符容错：文件可能是 CRLF，而 old_str 经传输被规范化为 LF（反之亦然）。
            // 统一到 LF 空间做匹配与替换，写回时保留文件原本的换行风格。
            let uses_crlf = original.contains("\r\n");
            let work = original.replace("\r\n", "\n");
            let old_norm = old_str.replace("\r\n", "\n");
            let new_norm = new_str.replace("\r\n", "\n");
            let occurrences = work.matches(&old_norm).count();
            if occurrences == 0 {
                let preview: String = original.chars().take(500).collect();
                return Err(format!(
                    "old_str not found in file. First 500 chars:\n{preview}"
                ));
            }
            if occurrences > 1 {
                return Err(format!(
                    "old_str matched {occurrences} times; it must be unique. Provide more context."
                ));
            }
            let replaced = work.replacen(&old_norm, &new_norm, 1);
            let updated = if uses_crlf {
                replaced.replace('\n', "\r\n")
            } else {
                replaced
            };
            atomic_write(&path, &updated)?;
            push_undo(&undo_key, Some(original.clone()));
            let rel = code_editor_rel(root, &path);
            let diff = unified_diff(&original, &updated, &rel);
            Ok(
                json!({"ok": true, "result": format!("[OK] replaced in: {rel}\n{diff}"), "path": rel, "diff": diff, "content": updated}),
            )
        }
        "insert" => {
            let path = ensure_inside_root(root, &raw_path, patterns, true)?;
            if !path.is_file() {
                return Err("target is not a file".to_string());
            }
            let original =
                fs::read_to_string(&path).map_err(|err| format!("failed to read file: {err}"))?;
            let new_str = arg_string(args, "new_str");
            if new_str.is_empty() {
                return Err("insert requires new_str".to_string());
            }
            let insert_line = args
                .get("insert_line")
                .and_then(Value::as_i64)
                .unwrap_or(-1);
            // 保留文件原本的换行风格：CRLF 文件插入后仍写回 CRLF。
            let uses_crlf = original.contains("\r\n");
            let newline = if uses_crlf { "\r\n" } else { "\n" };
            let work = original.replace("\r\n", "\n");
            let new_norm = new_str.replace("\r\n", "\n");
            let mut lines: Vec<String> = work.split('\n').map(|line| line.to_string()).collect();
            // split('\n') 会因结尾换行产生一个尾部空段，去掉后按行处理，最后再统一恢复。
            let trailing_newline = work.ends_with('\n');
            if trailing_newline {
                lines.pop();
            }
            if insert_line < 0 || insert_line as usize > lines.len() {
                return Err(format!(
                    "insert_line out of range (0-{}, 0 inserts at file start)",
                    lines.len()
                ));
            }
            lines.insert(insert_line as usize, new_norm);
            let mut updated = lines.join(newline);
            if trailing_newline {
                updated.push_str(newline);
            }
            atomic_write(&path, &updated)?;
            push_undo(&undo_key, Some(original.clone()));
            let rel = code_editor_rel(root, &path);
            let diff = unified_diff(&original, &updated, &rel);
            Ok(
                json!({"ok": true, "result": format!("[OK] inserted after line {insert_line}: {rel}\n{diff}"), "path": rel, "diff": diff, "content": updated}),
            )
        }
        "undo_edit" => {
            let previous =
                take_undo(&undo_key).ok_or_else(|| format!("nothing to undo: {raw_path}"))?;
            let path = ensure_inside_root(root, &raw_path, patterns, false)?;
            let rel = code_editor_rel(root, &path);
            match previous {
                None => {
                    let _ = fs::remove_file(&path);
                    Ok(
                        json!({"ok": true, "result": format!("[OK] undo create, file removed: {rel}"), "path": rel, "deleted": true}),
                    )
                }
                Some(content) => {
                    atomic_write(&path, &content)?;
                    Ok(
                        json!({"ok": true, "result": format!("[OK] restored previous content: {rel}"), "path": rel, "content": content}),
                    )
                }
            }
        }
        other => Err(format!("unknown code_editor command: {other}")),
    }
}

fn glob_tool(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let pattern = arg_string(args, "pattern").replace('\\', "/");
    let pattern = if pattern.is_empty() {
        "**/*".to_string()
    } else {
        pattern
    };
    let simple_pattern = pattern.trim_start_matches("**/").to_string();
    let mut matches = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
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

pub fn glob_workspace(
    root_path: &str,
    base_path: &str,
    pattern: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let start = if base_path.trim().is_empty() || base_path.trim() == "/" {
        root.clone()
    } else {
        ensure_inside_root(&root, base_path, &patterns, true)?
    };
    let pattern = pattern.trim().replace('\\', "/");
    let pattern = if pattern.is_empty() {
        "**/*".to_string()
    } else {
        pattern
    };
    let simple_pattern = pattern.trim_start_matches("**/").to_string();
    let limit = limit.clamp(1, 500);
    let mut matches = Vec::new();
    for entry in WalkDir::new(&start)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if matches.len() >= limit {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if is_ignored(&rel, &patterns) {
            continue;
        }
        let scoped_rel = entry
            .path()
            .strip_prefix(&start)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if wildcard_match(&pattern, &rel)
            || wildcard_match(&simple_pattern, &rel)
            || wildcard_match(&pattern, &scoped_rel)
            || wildcard_match(&simple_pattern, &scoped_rel)
        {
            matches.push(rel);
        }
    }
    Ok(matches)
}

fn search_code(root: &Path, patterns: &[String], args: &Value) -> Result<Value, String> {
    let pattern = arg_string(args, "pattern");
    let glob_filter = {
        let g = arg_string(args, "glob");
        if g.is_empty() {
            "*".to_string()
        } else {
            g
        }
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
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if is_ignored(&rel, patterns) || !wildcard_match(&glob_filter, &rel) {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        for (idx, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                lines.push(format!(
                    "{}:{}: {}",
                    rel,
                    idx + 1,
                    line.chars().take(240).collect::<String>()
                ));
                if lines.len() >= 100 {
                    return Ok(json!({"ok": true, "result": lines.join("\n")}));
                }
            }
        }
    }
    Ok(
        json!({"ok": true, "result": if lines.is_empty() { "[no matches]".to_string() } else { lines.join("\n") }}),
    )
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
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if is_ignored(&rel, patterns) {
            continue;
        }
        let Ok(data) = fs::read(path) else {
            continue;
        };
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
    let mut normalized = command
        .trim()
        .replace("/workspace/", "./")
        .replace("/workspace", ".");
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

/// Decode child-process console output. On Windows, cmd.exe emits text in the
/// OEM code page (typically GBK on zh-CN systems), so try strict UTF-8 first
/// and fall back to GBK to avoid mojibake in tool output.
fn decode_console_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            #[cfg(windows)]
            {
                let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
                decoded.into_owned()
            }
            #[cfg(not(windows))]
            {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

fn run_command_with_timeout(
    root: &Path,
    command: &str,
    timeout_secs: u64,
) -> Result<(bool, i32, String), String> {
    let mut child = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(command)
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.spawn()
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
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll command: {err}"))?
        {
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to collect command output: {err}"))?;
            let mut text = String::new();
            text.push_str(&decode_console_output(&output.stdout));
            text.push_str(&decode_console_output(&output.stderr));
            return Ok((status.success(), status.code().unwrap_or(-1), text));
        }
        if started.elapsed() >= Duration::from_secs(timeout_secs.max(1)) {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to collect timed-out command output: {err}"))?;
            let mut text = format!(
                "[LOCAL_RUNNER_TIMEOUT] command exceeded {}s\n",
                timeout_secs.max(1)
            );
            text.push_str(&decode_console_output(&output.stdout));
            text.push_str(&decode_console_output(&output.stderr));
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
    let timeout = args
        .get("timeout")
        .and_then(Value::as_u64)
        .or_else(|| args.get("command_timeout").and_then(Value::as_u64))
        .unwrap_or(120);
    let max_output = arg_usize(args, "max_output", 20_000);
    let (ok, exit_code, text) = run_command_with_timeout(root, &command, timeout)?;
    let result = if text.len() > max_output {
        text.chars()
            .rev()
            .take(max_output)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    } else {
        text
    };
    Ok(json!({"ok": ok, "result": result, "exit_code": exit_code}))
}

fn git_diff(root: &Path, _patterns: &[String], _args: &Value) -> Result<Value, String> {
    let (unstaged_ok, unstaged_exit, unstaged) =
        run_command_with_timeout(root, "git diff -- .", 60)?;
    let (staged_ok, staged_exit, staged) =
        run_command_with_timeout(root, "git diff --cached -- .", 60)?;
    let (status_ok, status_exit, status) =
        run_command_with_timeout(root, "git status --short --branch", 30)?;
    let mut text = String::new();
    if !staged.trim().is_empty() {
        text.push_str("[staged]\n");
        text.push_str(&staged);
        if !text.ends_with('\n') {
            text.push('\n');
        }
    }
    if !unstaged.trim().is_empty() {
        text.push_str("[unstaged]\n");
        text.push_str(&unstaged);
        if !text.ends_with('\n') {
            text.push('\n');
        }
    }
    if text.trim().is_empty() {
        text.push_str(&status);
    }
    Ok(json!({
        "ok": unstaged_ok && staged_ok && status_ok,
        "result": text,
        "diff": text,
        "status": status,
        "exit_code": if unstaged_ok && staged_ok && status_ok { 0 } else { unstaged_exit.max(staged_exit).max(status_exit) }
    }))
}

fn execute_tool(
    session_id: &str,
    root: &Path,
    patterns: &[String],
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    match tool {
        "read_file" => read_file(root, patterns, args),
        "read_lines" => read_lines(root, patterns, args),
        "write_file" => write_file(root, patterns, args),
        "local_write_text_file" => local_write_text_file(root, patterns, args),
        "local_read_text_file" => local_read_text_file(root, patterns, args),
        "apply_patch" => apply_patch_tool(root, patterns, args),
        "code_editor" => code_editor(session_id, root, patterns, args),
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
    let root = root
        .canonicalize()
        .map_err(|err| format!("project directory is not accessible: {err}"))?;
    let patterns = load_ignore_patterns(&root);
    let device = load_or_create_device_identity();
    let ws_url = config.websocket_url()?;
    let redacted_ws_url = config
        .redacted_websocket_url()
        .unwrap_or_else(|_| "(invalid ws url)".to_string());
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
                update(snapshot(
                    &config,
                    &root,
                    &redacted_ws_url,
                    "reconnecting",
                    last_error.clone(),
                    false,
                    true,
                    last_error.clone(),
                    last_heartbeat_at.clone(),
                ));
            }
            Ok(Err(err)) => {
                last_error = format!("连接失败：{err}");
                update(snapshot(
                    &config,
                    &root,
                    &redacted_ws_url,
                    "reconnecting",
                    format!("{}。URL：{}", last_error, redacted_ws_url),
                    false,
                    true,
                    last_error.clone(),
                    last_heartbeat_at.clone(),
                ));
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
                let hello_result = tokio::time::timeout(
                    Duration::from_secs(10),
                    write.send(Message::Text(hello.to_string().into())),
                )
                .await;
                if let Err(err) = hello_result
                    .map_err(|_| "发送 hello 超时".to_string())
                    .and_then(|result| result.map_err(|err| format!("发送 hello 失败：{err}")))
                {
                    last_error = err;
                    update(snapshot(
                        &config,
                        &root,
                        &redacted_ws_url,
                        "reconnecting",
                        last_error.clone(),
                        false,
                        true,
                        last_error.clone(),
                        last_heartbeat_at.clone(),
                    ));
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }

                last_error.clear();
                update(snapshot(
                    &config,
                    &root,
                    &redacted_ws_url,
                    "connected",
                    "已连接，正在等待 AutoCode 工具请求。".to_string(),
                    true,
                    true,
                    String::new(),
                    last_heartbeat_at.clone(),
                ));

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
                            let response = match execute_tool(&config.session, &root, &patterns, &tool, &args) {
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub task_id: String,
    pub preview_url: String,
    pub last_opened_at: String,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct IdeSettings {
    pub api_base_url: String,
    pub api_key: String,
    pub connection_mode: String,
    pub provider_type: String,
    pub api_protocol: String,
    pub model: String,
    pub reasoning_mode: String,
    pub reasoning_effort: String,
    pub reasoning_budget_tokens: u64,
    pub reasoning_summary: bool,
    pub custom_headers: HashMap<String, String>,
    pub channels: Vec<ProviderChannel>,
    pub default_routes: HashMap<String, String>,
    pub code_completion: CodeCompletionSettings,
    pub transcription_model: String,
    pub offline_stt_enabled: bool,
    pub offline_stt_engine: String,
    pub offline_stt_model: String,
    pub default_shell: String,
    pub default_workspace_path: String,
    pub last_workspace_path: String,
    pub preview_url: String,
    pub ui_font_size: u64,
    pub code_font_size: u64,
    pub ui_font_family: String,
    pub code_font_family: String,
    pub appearance_density: String,
    pub ui_contrast: u64,
    pub reduced_motion: String,
    pub desktop_notifications_enabled: bool,
    #[serde(default = "default_true")]
    pub desktop_notification_sound_enabled: bool,
    pub notify_on_agent_waiting: bool,
    pub notify_on_agent_done: bool,
    pub notify_on_agent_failed: bool,
    pub auto_update_enabled: bool,
    pub update_manifest_url: String,
    pub update_public_key: String,
    pub update_check_on_startup: bool,
    pub update_check_interval_hours: u64,
    pub last_update_check_at: String,
    pub skipped_update_version: String,
    pub recent_projects: Vec<RecentProject>,
    pub approval_mode: String,
    pub permission_policy: serde_json::Value,
    pub agent_profiles: serde_json::Value,
    pub subagents: serde_json::Value,
    pub hooks: serde_json::Value,
    pub mcp_servers: serde_json::Value,
    pub memory_files: Vec<String>,
    pub context_budget: u64,
    pub auto_compact_threshold: u64,
    pub checkpoint_policy: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderChannel {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub api_protocol: String,
    pub api_base_url: String,
    pub api_key: String,
    pub custom_headers: HashMap<String, String>,
    pub enabled: bool,
    pub priority: i64,
    pub weight: i64,
    pub purposes: Vec<String>,
    pub models: Vec<String>,
    pub enabled_models: Vec<String>,
    pub model_filter_configured: bool,
    pub default_model: String,
    pub code_completion_model: String,
    pub account_status: String,
    pub last_error: String,
    pub capabilities: serde_json::Value,
    pub updated_at: String,
}

impl Default for ProviderChannel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            provider_type: "openai-responses".to_string(),
            api_protocol: String::new(),
            api_base_url: String::new(),
            api_key: String::new(),
            custom_headers: HashMap::new(),
            enabled: true,
            priority: 10,
            weight: 1,
            purposes: vec![
                "chat".to_string(),
                "agent".to_string(),
                "reasoning".to_string(),
                "codeCompletion".to_string(),
            ],
            models: Vec::new(),
            enabled_models: Vec::new(),
            model_filter_configured: false,
            default_model: String::new(),
            code_completion_model: String::new(),
            account_status: String::new(),
            last_error: String::new(),
            capabilities: serde_json::json!({}),
            updated_at: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct CodeCompletionSettings {
    pub enabled: bool,
    pub trigger: String,
    pub debounce_ms: u64,
    pub max_prefix_chars: usize,
    pub max_suffix_chars: usize,
    pub model: String,
    pub channel_id: String,
    pub prompt: String,
}

impl Default for CodeCompletionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            trigger: "idle".to_string(),
            debounce_ms: 750,
            max_prefix_chars: 5000,
            max_suffix_chars: 2000,
            model: String::new(),
            channel_id: String::new(),
            prompt: "只返回应该插入到光标位置的代码，不要解释，不要 Markdown，不要代码围栏，不要重复已有前缀。".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct IdeBootstrap {
    pub version: String,
    pub default_api_base_url: String,
    pub settings: IdeSettings,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: String,
    pub hidden: bool,
    pub children: Vec<WorkspaceEntry>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceFileIndexItem {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceFileIndex {
    pub files: Vec<WorkspaceFileIndexItem>,
    pub dirs: Vec<WorkspaceFileIndexItem>,
    pub generated_at: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceFileSnapshot {
    pub path: String,
    pub absolute_path: String,
    pub content: String,
    pub encoding: String,
    pub line_ending: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceCommandResult {
    pub command: String,
    pub cwd: String,
    pub ok: bool,
    pub exit_code: i32,
    pub output: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceGitFile {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: String,
    pub parent: String,
    pub name: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceGitGroups {
    pub staged: Vec<WorkspaceGitFile>,
    pub unstaged: Vec<WorkspaceGitFile>,
    pub untracked: Vec<WorkspaceGitFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceGitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceGitStatus {
    pub branch: String,
    pub ahead: i64,
    pub behind: i64,
    pub repository: bool,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub summary: String,
    pub repository_message: String,
    pub diff: String,
    pub staged_diff: String,
    pub unstaged_diff: String,
    pub status_short: String,
    pub files: Vec<WorkspaceGitFile>,
    pub grouped_files: WorkspaceGitGroups,
    pub recent_commits: Vec<WorkspaceGitCommit>,
    pub untracked_files: Vec<String>,
    pub skipped_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceFileStat {
    pub path: String,
    pub absolute_path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: String,
    pub hash: String,
    pub exists: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceSearchResult {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: String,
    pub line: usize,
    pub preview: String,
}

fn ide_settings_path() -> PathBuf {
    connector_data_dir().join("ide-settings.json")
}

pub fn default_api_base_url() -> String {
    std::env::var("AUTOCODE_API_BASE_URL")
        .or_else(|_| std::env::var("AUTOCODE_CONNECTOR_API_BASE_URL"))
        .or_else(|_| std::env::var("AUTOCODE_PUBLIC_API_BASE_URL"))
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "http://localhost:8000".to_string()
            } else {
                String::new()
            }
        })
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn default_workspace_path() -> String {
    default_project_dir().to_string_lossy().to_string()
}

fn settings_defaults() -> IdeSettings {
    IdeSettings {
        api_base_url: default_api_base_url(),
        api_key: String::new(),
        connection_mode: "aiProvider".to_string(),
        provider_type: "openai-responses".to_string(),
        api_protocol: String::new(),
        model: String::new(),
        reasoning_mode: "auto".to_string(),
        reasoning_effort: "medium".to_string(),
        reasoning_budget_tokens: 8192,
        reasoning_summary: true,
        custom_headers: HashMap::new(),
        channels: Vec::new(),
        default_routes: default_provider_routes(),
        code_completion: CodeCompletionSettings::default(),
        transcription_model: String::new(),
        offline_stt_enabled: true,
        offline_stt_engine: "sherpa-onnx".to_string(),
        offline_stt_model: "zh-streaming-small".to_string(),
        default_shell: "auto".to_string(),
        default_workspace_path: default_workspace_path(),
        last_workspace_path: String::new(),
        preview_url: String::new(),
        ui_font_size: 14,
        code_font_size: 12,
        ui_font_family: "Inter, \"Segoe UI\", \"Microsoft YaHei\", Arial, sans-serif".to_string(),
        code_font_family: "\"Cascadia Code\", Consolas, monospace".to_string(),
        appearance_density: "comfortable".to_string(),
        ui_contrast: 100,
        reduced_motion: "system".to_string(),
        desktop_notifications_enabled: true,
        desktop_notification_sound_enabled: true,
        notify_on_agent_waiting: true,
        notify_on_agent_done: true,
        notify_on_agent_failed: true,
        auto_update_enabled: true,
        update_manifest_url: String::new(),
        update_public_key: String::new(),
        update_check_on_startup: true,
        update_check_interval_hours: 12,
        last_update_check_at: String::new(),
        skipped_update_version: String::new(),
        recent_projects: Vec::new(),
        approval_mode: "autoEdit".to_string(),
        permission_policy: serde_json::json!({}),
        agent_profiles: serde_json::json!([]),
        subagents: serde_json::json!([]),
        hooks: serde_json::json!([]),
        mcp_servers: serde_json::json!([]),
        memory_files: vec![
            ".autocode/AGENTS.md".to_string(),
            ".autocode/memory.md".to_string(),
            ".autocode/settings.json".to_string(),
        ],
        context_budget: 18000,
        auto_compact_threshold: 24000,
        checkpoint_policy: "before_write".to_string(),
        updated_at: now_secs(),
    }
}

fn normalize_api_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn default_provider_routes() -> HashMap<String, String> {
    [
        ("chat".to_string(), "default".to_string()),
        ("agent".to_string(), "default".to_string()),
        ("reasoning".to_string(), "default".to_string()),
        ("codeCompletion".to_string(), "default".to_string()),
        ("audioTranscription".to_string(), "default".to_string()),
    ]
    .into_iter()
    .collect()
}

fn channel_from_legacy(settings: &IdeSettings) -> ProviderChannel {
    ProviderChannel {
        id: "default".to_string(),
        name: "默认渠道".to_string(),
        provider_type: settings.provider_type.clone(),
        api_protocol: settings.api_protocol.clone(),
        api_base_url: normalize_api_base_url(&settings.api_base_url),
        api_key: settings.api_key.clone(),
        custom_headers: settings.custom_headers.clone(),
        enabled: true,
        priority: 10,
        weight: 1,
        purposes: vec![
            "chat".to_string(),
            "agent".to_string(),
            "reasoning".to_string(),
            "codeCompletion".to_string(),
            "audioTranscription".to_string(),
        ],
        models: if settings.model.trim().is_empty() {
            Vec::new()
        } else {
            vec![settings.model.clone()]
        },
        enabled_models: if settings.model.trim().is_empty() {
            Vec::new()
        } else {
            vec![settings.model.clone()]
        },
        model_filter_configured: false,
        default_model: settings.model.clone(),
        code_completion_model: String::new(),
        account_status: String::new(),
        last_error: String::new(),
        capabilities: serde_json::json!({}),
        updated_at: settings.updated_at.clone(),
    }
}

fn normalize_ide_settings(mut settings: IdeSettings) -> IdeSettings {
    if settings.api_base_url.trim().is_empty() {
        settings.api_base_url = default_api_base_url();
    } else {
        settings.api_base_url = normalize_api_base_url(&settings.api_base_url);
    }
    if settings.default_workspace_path.trim().is_empty() {
        settings.default_workspace_path = default_workspace_path();
    }
    if settings.offline_stt_engine.trim().is_empty() {
        settings.offline_stt_engine = "sherpa-onnx".to_string();
    }
    if settings.offline_stt_model.trim().is_empty() {
        settings.offline_stt_model = "zh-streaming-small".to_string();
    }
    if settings.connection_mode.trim().is_empty() {
        settings.connection_mode = "aiProvider".to_string();
    }
    if settings.provider_type.trim().is_empty() {
        settings.provider_type = "openai-responses".to_string();
    }
    if settings.api_protocol.trim().is_empty()
        && settings.provider_type.trim() == "local-openai-compatible"
    {
        settings.api_protocol = "auto".to_string();
    }
    if settings.reasoning_mode.trim().is_empty() {
        settings.reasoning_mode = "auto".to_string();
    }
    if settings.reasoning_effort.trim().is_empty() {
        settings.reasoning_effort = "medium".to_string();
    }
    if settings.reasoning_budget_tokens == 0 {
        settings.reasoning_budget_tokens = 8192;
    }
    if settings.ui_font_size == 0 {
        settings.ui_font_size = 14;
    }
    settings.ui_font_size = settings.ui_font_size.clamp(12, 20);
    if settings.code_font_size == 0 {
        settings.code_font_size = 12;
    }
    settings.code_font_size = settings.code_font_size.clamp(10, 20);
    if settings.ui_font_family.trim().is_empty() {
        settings.ui_font_family =
            "Inter, \"Segoe UI\", \"Microsoft YaHei\", Arial, sans-serif".to_string();
    }
    if settings.code_font_family.trim().is_empty() {
        settings.code_font_family = "\"Cascadia Code\", Consolas, monospace".to_string();
    }
    if !matches!(
        settings.appearance_density.as_str(),
        "comfortable" | "compact"
    ) {
        settings.appearance_density = "comfortable".to_string();
    }
    if settings.ui_contrast == 0 {
        settings.ui_contrast = 100;
    }
    settings.ui_contrast = settings.ui_contrast.clamp(80, 120);
    if !matches!(settings.reduced_motion.as_str(), "system" | "on" | "off") {
        settings.reduced_motion = "system".to_string();
    }
    settings.update_manifest_url = settings.update_manifest_url.trim().to_string();
    settings.update_public_key = settings.update_public_key.trim().to_string();
    if settings.update_check_interval_hours == 0 {
        settings.update_check_interval_hours = 12;
    }
    settings.update_check_interval_hours = settings.update_check_interval_hours.clamp(1, 168);
    if settings.default_routes.is_empty() {
        settings.default_routes = default_provider_routes();
    }
    if settings.code_completion.trigger.trim().is_empty() {
        settings.code_completion.trigger = "idle".to_string();
    }
    if settings.code_completion.debounce_ms == 0 {
        settings.code_completion.debounce_ms = 750;
    }
    if settings.code_completion.max_prefix_chars == 0 {
        settings.code_completion.max_prefix_chars = 5000;
    }
    if settings.code_completion.max_suffix_chars == 0 {
        settings.code_completion.max_suffix_chars = 2000;
    }
    if settings.code_completion.prompt.trim().is_empty() {
        settings.code_completion.prompt = CodeCompletionSettings::default().prompt;
    }
    if settings.channels.is_empty() {
        settings.channels.push(channel_from_legacy(&settings));
    } else if !settings.api_base_url.trim().is_empty()
        || !settings.api_key.trim().is_empty()
        || !settings.model.trim().is_empty()
    {
        let legacy = channel_from_legacy(&settings);
        if let Some(channel) = settings
            .channels
            .iter_mut()
            .find(|channel| channel.id == "default")
        {
            if channel.provider_type.trim().is_empty() {
                channel.provider_type = legacy.provider_type;
            }
            if channel.api_base_url.trim().is_empty() {
                channel.api_base_url = legacy.api_base_url;
            }
            if channel.api_key.trim().is_empty() {
                channel.api_key = legacy.api_key;
            }
            if channel.custom_headers.is_empty() {
                channel.custom_headers = legacy.custom_headers;
            }
            if channel.default_model.trim().is_empty() {
                channel.default_model = legacy.default_model;
            }
            if channel.models.is_empty() {
                channel.models = legacy.models;
            }
            if channel.enabled_models.is_empty() && !channel.model_filter_configured {
                channel.enabled_models = legacy.enabled_models;
            }
        }
    }
    for channel in settings.channels.iter_mut() {
        if channel.id.trim().is_empty() {
            channel.id = format!("channel-{}", now_secs());
        }
        if channel.name.trim().is_empty() {
            channel.name = channel.provider_type.clone();
        }
        if channel.provider_type.trim().is_empty() {
            channel.provider_type = "openai-responses".to_string();
        }
        if channel.api_protocol.trim().is_empty()
            && channel.provider_type.trim() == "local-openai-compatible"
        {
            channel.api_protocol = "auto".to_string();
        }
        if channel.api_base_url.trim().is_empty()
            && channel.provider_type.trim() == "local-openai-compatible"
        {
            channel.api_base_url = "http://127.0.0.1:11434".to_string();
        }
        channel.api_base_url = normalize_api_base_url(&channel.api_base_url);
        if channel.priority == 0 {
            channel.priority = 10;
        }
        if channel.weight <= 0 {
            channel.weight = 1;
        }
        if channel.purposes.is_empty() {
            channel.purposes = vec!["chat".to_string(), "agent".to_string()];
        }
        channel.models.sort();
        channel.models.dedup();
        channel
            .enabled_models
            .retain(|model| channel.models.is_empty() || channel.models.contains(model));
        channel.enabled_models.sort();
        channel.enabled_models.dedup();
    }
    let routed_id = settings
        .default_routes
        .get("chat")
        .cloned()
        .unwrap_or_else(|| "default".to_string());
    let selected_model = settings.model.trim().to_string();
    let model_supported = |channel: &&ProviderChannel| {
        if selected_model.is_empty() || selected_model.eq_ignore_ascii_case("auto") {
            return true;
        }
        let models = if channel.model_filter_configured {
            &channel.enabled_models
        } else {
            &channel.models
        };
        models.is_empty()
            || models.iter().any(|item| item == &selected_model)
            || channel.default_model == selected_model
    };
    let active_channel = settings
        .channels
        .iter()
        .filter(|channel| channel.enabled)
        .find(|channel| channel.id == routed_id && model_supported(channel))
        .or_else(|| {
            settings
                .channels
                .iter()
                .filter(|channel| channel.enabled && model_supported(channel))
                .max_by(|left, right| {
                    left.priority
                        .cmp(&right.priority)
                        .then(left.weight.cmp(&right.weight))
                        .then_with(|| right.id.cmp(&left.id))
                })
        })
        .or_else(|| settings.channels.iter().find(|channel| channel.enabled))
        .or_else(|| settings.channels.first());
    if let Some(channel) = active_channel {
        settings.provider_type = channel.provider_type.clone();
        settings.api_base_url = channel.api_base_url.clone();
        settings.api_key = channel.api_key.clone();
        settings.custom_headers = channel.custom_headers.clone();
        let channel_models = if channel.model_filter_configured {
            &channel.enabled_models
        } else {
            &channel.models
        };
        let fallback_model = channel.default_model.trim().to_string();
        let fallback_model =
            if !fallback_model.is_empty() && !fallback_model.eq_ignore_ascii_case("auto") {
                fallback_model
            } else {
                channel_models
                    .iter()
                    .map(|item| item.trim())
                    .find(|item| !item.is_empty() && !item.eq_ignore_ascii_case("auto"))
                    .unwrap_or("")
                    .to_string()
            };
        if selected_model.is_empty()
            || selected_model.eq_ignore_ascii_case("auto")
            || !model_supported(&channel)
        {
            settings.model = fallback_model;
        }
    }
    if settings.default_shell.trim().is_empty() {
        settings.default_shell = "auto".to_string();
    }
    if settings.recent_projects.len() > 24 {
        settings.recent_projects.truncate(24);
    }
    if settings.approval_mode.trim().is_empty() {
        settings.approval_mode = "autoEdit".to_string();
    }
    if settings.memory_files.is_empty() {
        settings.memory_files = vec![
            ".autocode/AGENTS.md".to_string(),
            ".autocode/memory.md".to_string(),
            ".autocode/settings.json".to_string(),
        ];
    }
    if settings.context_budget == 0 {
        settings.context_budget = 18000;
    }
    if settings.auto_compact_threshold == 0 {
        settings.auto_compact_threshold = 24000;
    }
    if settings.checkpoint_policy.trim().is_empty() {
        settings.checkpoint_policy = "before_write".to_string();
    }
    settings
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid settings path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create settings directory: {err}"))?;
    let tmp = path.with_extension("tmp");
    let payload = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    fs::write(&tmp, payload).map_err(|err| format!("failed to write settings: {err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("failed to save settings: {err}"))?;
    Ok(())
}

pub fn load_ide_settings() -> IdeSettings {
    let path = ide_settings_path();
    let mut settings = if let Ok(text) = fs::read_to_string(&path) {
        let normalized = text.trim_start_matches('\u{feff}');
        match serde_json::from_str::<IdeSettings>(normalized) {
            Ok(settings) => settings,
            Err(_err) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "failed to parse IDE settings at {}: {_err}",
                    path.to_string_lossy()
                );
                IdeSettings::default()
            }
        }
    } else {
        #[cfg(debug_assertions)]
        eprintln!("IDE settings not found at {}", path.to_string_lossy());
        IdeSettings::default()
    };
    let defaults = settings_defaults();
    if settings.api_base_url.trim().is_empty() {
        settings.api_base_url = defaults.api_base_url;
    }
    if settings.default_workspace_path.trim().is_empty() {
        settings.default_workspace_path = defaults.default_workspace_path;
    }
    if settings.updated_at.trim().is_empty() {
        settings.updated_at = defaults.updated_at;
    }
    if settings.preview_url.trim().is_empty() {
        settings.preview_url = defaults.preview_url;
    }
    if settings.ui_font_size == 0 {
        settings.ui_font_size = defaults.ui_font_size;
    }
    if settings.code_font_size == 0 {
        settings.code_font_size = defaults.code_font_size;
    }
    if settings.ui_font_family.trim().is_empty() {
        settings.ui_font_family = defaults.ui_font_family;
    }
    if settings.code_font_family.trim().is_empty() {
        settings.code_font_family = defaults.code_font_family;
    }
    if settings.appearance_density.trim().is_empty() {
        settings.appearance_density = defaults.appearance_density;
    }
    if settings.ui_contrast == 0 {
        settings.ui_contrast = defaults.ui_contrast;
    }
    if settings.reduced_motion.trim().is_empty() {
        settings.reduced_motion = defaults.reduced_motion;
    }
    settings
        .recent_projects
        .retain(|item| !item.path.trim().is_empty());
    normalize_ide_settings(settings)
}

pub fn save_ide_settings(settings: IdeSettings) -> Result<IdeSettings, String> {
    let mut normalized = normalize_ide_settings(settings);
    normalized.updated_at = now_secs();
    let path = ide_settings_path();
    write_json_file(
        &path,
        &serde_json::to_value(&normalized).map_err(|err| err.to_string())?,
    )?;
    Ok(normalized)
}

pub fn load_ide_bootstrap() -> IdeBootstrap {
    IdeBootstrap {
        version: VERSION.to_string(),
        default_api_base_url: default_api_base_url(),
        settings: load_ide_settings(),
    }
}

fn project_name_from_path(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "AutoCode Project".to_string())
}

fn normalize_recent_project(mut project: RecentProject) -> RecentProject {
    if project.name.trim().is_empty() {
        project.name = project_name_from_path(Path::new(&project.path));
    }
    if project.last_opened_at.trim().is_empty() {
        project.last_opened_at = now_secs();
    }
    project
}

pub fn record_recent_project(
    path: &str,
    task_id: Option<&str>,
    preview_url: Option<&str>,
) -> Result<RecentProject, String> {
    let root = resolve_authorized_root(path)?;
    let root_text = root.to_string_lossy().to_string();
    let mut settings = load_ide_settings();
    let now = now_secs();
    let project = RecentProject {
        path: root_text.clone(),
        name: project_name_from_path(&root),
        task_id: task_id.unwrap_or("").trim().to_string(),
        preview_url: preview_url.unwrap_or("").trim().to_string(),
        last_opened_at: now.clone(),
    };
    settings.default_workspace_path = root_text.clone();
    settings.last_workspace_path = root_text.clone();
    if !project.preview_url.trim().is_empty() {
        settings.preview_url = project.preview_url.clone();
    }
    settings
        .recent_projects
        .retain(|item| item.path != root_text);
    settings
        .recent_projects
        .insert(0, normalize_recent_project(project.clone()));
    settings.recent_projects.truncate(24);
    settings.updated_at = now;
    let saved = save_ide_settings(settings)?;
    let mut current = saved
        .recent_projects
        .into_iter()
        .find(|item| item.path == root_text)
        .unwrap_or(project);
    current = normalize_recent_project(current);
    Ok(current)
}

pub fn import_legacy_deep_link(raw: &str) -> Result<Option<RecentProject>, String> {
    let url = Url::parse(raw).map_err(|err| format!("failed to parse connector URL: {err}"))?;
    if url.scheme() != "muhuo-autocode" {
        return Err("not an AutoCode deep link".to_string());
    }

    let mut project_path = String::new();
    let mut preview_url = String::new();
    let mut task_id = String::new();
    let mut api_base_url = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "project" | "local_project_path" => {
                project_path = value.to_string();
            }
            "task_id" => task_id = value.to_string(),
            "preview_url" => preview_url = value.to_string(),
            "server" | "api_base_url" => api_base_url = value.to_string(),
            _ => {}
        }
    }

    if !api_base_url.trim().is_empty() {
        let mut settings = load_ide_settings();
        settings.api_base_url = normalize_api_base_url(&api_base_url);
        let _ = save_ide_settings(settings);
    }

    if project_path.trim().is_empty() || project_path.contains("浣犵殑椤圭洰") {
        return Ok(None);
    }
    record_recent_project(
        &project_path,
        Some(task_id.as_str()),
        Some(preview_url.as_str()),
    )
    .map(Some)
}

fn workspace_patterns(root: &Path) -> Vec<String> {
    load_ignore_patterns(root)
}

fn is_git_repository(root: &Path) -> bool {
    let Ok((ok, _, output)) =
        run_command_with_timeout(root, "git rev-parse --is-inside-work-tree", 15)
    else {
        return false;
    };
    ok && output.to_lowercase().contains("true")
}

fn file_modified_at(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs().to_string())
        .unwrap_or_default()
}

fn detect_text_encoding(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let text = String::from_utf8(bytes[3..].to_vec())
            .unwrap_or_else(|_| String::from_utf8_lossy(&bytes[3..]).into_owned());
        return ("utf-8-sig".to_string(), text);
    }
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return ("utf-8".to_string(), text);
    }
    #[cfg(windows)]
    {
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        return ("gbk".to_string(), text.into_owned());
    }
    #[cfg(not(windows))]
    {
        return (
            "utf-8".to_string(),
            String::from_utf8_lossy(bytes).into_owned(),
        );
    }
}

fn normalize_line_ending(value: &str) -> String {
    if value.eq_ignore_ascii_case("crlf") || value.eq_ignore_ascii_case("windows") {
        "crlf".to_string()
    } else {
        "lf".to_string()
    }
}

fn detect_line_ending(text: &str) -> String {
    if text.contains("\r\n") {
        "crlf".to_string()
    } else {
        "lf".to_string()
    }
}

fn apply_line_ending(text: &str, line_ending: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    if normalize_line_ending(line_ending) == "crlf" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create parent directory: {err}"))?;
    }
    fs::write(&tmp, bytes).map_err(|err| format!("failed to write file: {err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("failed to replace file: {err}"))?;
    Ok(())
}

fn encode_text_bytes(content: &str, encoding: &str, line_ending: &str) -> Result<Vec<u8>, String> {
    let normalized = apply_line_ending(content, line_ending);
    match normalize_text_encoding_name(encoding).as_str() {
        "utf-8-sig" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(normalized.as_bytes());
            Ok(bytes)
        }
        "gbk" => {
            #[cfg(windows)]
            {
                let (encoded, _, had_errors) = encoding_rs::GBK.encode(&normalized);
                if had_errors {
                    return Err(
                        "file content contains characters that cannot be represented in GBK"
                            .to_string(),
                    );
                }
                Ok(encoded.into_owned())
            }
            #[cfg(not(windows))]
            {
                Ok(normalized.into_bytes())
            }
        }
        _ => Ok(normalized.into_bytes()),
    }
}

fn normalize_text_encoding_name(value: &str) -> String {
    let encoding = value.trim().to_lowercase().replace('_', "-");
    if encoding.is_empty() || encoding == "utf8" {
        "utf-8".to_string()
    } else if encoding == "ansi" || encoding == "gbk" || encoding == "cp936" {
        "gbk".to_string()
    } else if encoding == "utf-8-sig" || encoding == "utf8-sig" {
        "utf-8-sig".to_string()
    } else {
        "utf-8".to_string()
    }
}

fn rel_path_from_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn workspace_entry_from_path(root: &Path, path: &Path) -> Result<WorkspaceEntry, String> {
    let meta = fs::metadata(path).map_err(|err| format!("path is not accessible: {err}"))?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(WorkspaceEntry {
        name: name.clone(),
        path: rel_path_from_root(root, path),
        kind: if meta.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        },
        size: meta.len(),
        modified_at: file_modified_at(path),
        hidden: name.starts_with('.'),
        children: Vec::new(),
    })
}

fn clean_workspace_name(name: &str) -> Result<String, String> {
    let cleaned = name.trim();
    if cleaned.is_empty() {
        return Err("name cannot be empty".to_string());
    }
    if cleaned == "." || cleaned == ".." || cleaned.contains('/') || cleaned.contains('\\') {
        return Err("name must be a single file or folder name".to_string());
    }
    Ok(cleaned.to_string())
}

fn ensure_new_workspace_path(
    root: &Path,
    requested: &str,
    patterns: &[String],
) -> Result<PathBuf, String> {
    let raw = requested.trim().trim_start_matches(['/', '\\']);
    if raw.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    let target = root.join(raw);
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let checked_parent = parent
        .canonicalize()
        .map_err(|err| format!("parent directory is not accessible: {err}"))?;
    if !checked_parent.starts_with(root) {
        return Err("path escapes the authorized project directory".to_string());
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| "target file name is invalid".to_string())?;
    let checked = checked_parent.join(file_name);
    if !checked.starts_with(root) {
        return Err("path escapes the authorized project directory".to_string());
    }
    let rel = rel_path_from_root(root, &checked);
    if is_ignored(&rel, patterns) {
        return Err(format!("path is ignored by .autocodeignore: {rel}"));
    }
    Ok(checked)
}

pub fn list_workspace_tree(
    root_path: &str,
    path: &str,
    max_depth: usize,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let start = if path.trim().is_empty() || path.trim() == "/" {
        root.clone()
    } else {
        ensure_inside_root(&root, path, &patterns, true)?
    };

    fn walk(
        root: &Path,
        current: &Path,
        patterns: &[String],
        depth: usize,
        max_depth: usize,
        total: &mut usize,
    ) -> Vec<WorkspaceEntry> {
        if depth >= max_depth || *total >= 1500 {
            return Vec::new();
        }
        let mut entries = Vec::new();
        let Ok(read_dir) = fs::read_dir(current) else {
            return entries;
        };
        let mut items = read_dir
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = rel_path_from_root(root, &path);
                if is_ignored(&rel, patterns) {
                    return None;
                }
                let meta = entry.metadata().ok()?;
                let kind = if meta.is_dir() { "dir" } else { "file" };
                let modified_at = meta
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_secs().to_string())
                    .unwrap_or_default();
                Some((
                    path,
                    name,
                    kind.to_string(),
                    meta.len(),
                    modified_at,
                    rel,
                    meta.is_dir(),
                ))
            })
            .collect::<Vec<_>>();
        items.sort_by(|a, b| {
            a.2.cmp(&b.2)
                .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
        });
        for (path, name, kind, size, modified_at, rel, is_dir) in items {
            if *total >= 1500 {
                break;
            }
            *total += 1;
            let hidden = name.starts_with('.');
            let children = if is_dir {
                walk(root, &path, patterns, depth + 1, max_depth, total)
            } else {
                Vec::new()
            };
            entries.push(WorkspaceEntry {
                name,
                path: rel,
                kind,
                size,
                modified_at,
                hidden,
                children,
            });
        }
        entries
    }

    let mut total = 0usize;
    Ok(walk(
        &root,
        &start,
        &patterns,
        0,
        max_depth.max(1),
        &mut total,
    ))
}

pub fn list_workspace_file_index(
    root_path: &str,
    max_files: usize,
) -> Result<WorkspaceFileIndex, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let limit = max_files.clamp(200, 20000);
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut truncated = false;

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.path() == root {
                return true;
            }
            let rel = rel_path_from_root(&root, entry.path());
            !is_ignored(&rel, &patterns)
        })
        .filter_map(Result::ok)
    {
        if files.len() + dirs.len() >= limit {
            truncated = true;
            break;
        }
        let path = entry.path();
        if path == root {
            continue;
        }
        let rel = rel_path_from_root(&root, path);
        if is_ignored(&rel, &patterns) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let parent = Path::new(&rel)
            .parent()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let item = WorkspaceFileIndexItem {
            path: rel,
            name,
            parent,
            size: meta.len(),
            modified_at: file_modified_at(path),
        };
        if entry.file_type().is_dir() {
            dirs.push(item);
        } else if entry.file_type().is_file() {
            files.push(item);
        }
    }

    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    dirs.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(WorkspaceFileIndex {
        files,
        dirs,
        generated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs().to_string())
            .unwrap_or_default(),
        truncated,
    })
}

pub fn read_workspace_file(root_path: &str, path: &str) -> Result<WorkspaceFileSnapshot, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let absolute = ensure_inside_root(&root, path, &patterns, true)?;
    if absolute.is_dir() {
        return Err("target is a directory".to_string());
    }
    let meta = fs::metadata(&absolute).map_err(|err| format!("failed to inspect file: {err}"))?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("file is larger than the 5 MB editor safety limit".to_string());
    }
    let bytes = fs::read(&absolute).map_err(|err| format!("failed to read file: {err}"))?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err("binary files cannot be opened in the text editor".to_string());
    }
    let (encoding, content) = detect_text_encoding(&bytes);
    Ok(WorkspaceFileSnapshot {
        path: rel_path_from_root(&root, &absolute),
        absolute_path: absolute.to_string_lossy().to_string(),
        content,
        encoding,
        line_ending: detect_line_ending(&String::from_utf8_lossy(&bytes)),
        size: bytes.len() as u64,
        modified_at: file_modified_at(&absolute),
    })
}

pub fn save_workspace_file(
    root_path: &str,
    path: &str,
    content: &str,
    encoding: Option<String>,
    line_ending: Option<String>,
) -> Result<WorkspaceFileSnapshot, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let absolute = ensure_inside_root(&root, path, &patterns, false)?;
    let mut next_encoding = encoding.unwrap_or_default();
    let mut next_line_ending = line_ending.unwrap_or_default();
    if absolute.exists() {
        let existing = read_workspace_file(root_path, path)?;
        if next_encoding.trim().is_empty() {
            next_encoding = existing.encoding;
        }
        if next_line_ending.trim().is_empty() {
            next_line_ending = existing.line_ending;
        }
    }
    if next_encoding.trim().is_empty() {
        next_encoding = "utf-8".to_string();
    }
    if next_line_ending.trim().is_empty() {
        next_line_ending = "lf".to_string();
    }
    let bytes = encode_text_bytes(content, &next_encoding, &next_line_ending)?;
    atomic_write_bytes(&absolute, &bytes)?;
    read_workspace_file(root_path, path)
}

pub fn create_workspace_entry(
    root_path: &str,
    parent_path: &str,
    name: &str,
    kind: &str,
) -> Result<WorkspaceEntry, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let parent = if parent_path.trim().is_empty() {
        root.clone()
    } else {
        ensure_inside_root(&root, parent_path, &patterns, true)?
    };
    if !parent.is_dir() {
        return Err("parent path is not a directory".to_string());
    }
    let clean_name = clean_workspace_name(name)?;
    let target = parent.join(clean_name);
    if !target.starts_with(&root) {
        return Err("path escapes the authorized project directory".to_string());
    }
    let rel = rel_path_from_root(&root, &target);
    if is_ignored(&rel, &patterns) {
        return Err(format!("path is ignored by .autocodeignore: {rel}"));
    }
    if target.exists() {
        return Err("target already exists".to_string());
    }
    if kind == "dir" {
        fs::create_dir(&target).map_err(|err| format!("failed to create folder: {err}"))?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create parent directory: {err}"))?;
        }
        fs::File::create(&target).map_err(|err| format!("failed to create file: {err}"))?;
    }
    workspace_entry_from_path(&root, &target)
}

pub fn rename_workspace_entry(
    root_path: &str,
    path: &str,
    new_path: &str,
) -> Result<WorkspaceEntry, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let source = ensure_inside_root(&root, path, &patterns, true)?;
    if source == root {
        return Err("cannot rename the workspace root".to_string());
    }
    let target = ensure_new_workspace_path(&root, new_path, &patterns)?;
    if target.exists() {
        return Err("target already exists".to_string());
    }
    fs::rename(&source, &target).map_err(|err| format!("failed to rename entry: {err}"))?;
    workspace_entry_from_path(&root, &target)
}

pub fn delete_workspace_entry(root_path: &str, path: &str, recursive: bool) -> Result<(), String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let target = ensure_inside_root(&root, path, &patterns, true)?;
    if target == root {
        return Err("cannot delete the workspace root".to_string());
    }
    if target.is_dir() {
        if recursive {
            fs::remove_dir_all(&target).map_err(|err| format!("failed to delete folder: {err}"))?;
        } else {
            fs::remove_dir(&target).map_err(|err| format!("failed to delete folder: {err}"))?;
        }
    } else {
        fs::remove_file(&target).map_err(|err| format!("failed to delete file: {err}"))?;
    }
    Ok(())
}

pub fn stat_workspace_file(root_path: &str, path: &str) -> Result<WorkspaceFileStat, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let target = ensure_inside_root(&root, path, &patterns, true)?;
    let meta = fs::metadata(&target).map_err(|err| format!("failed to inspect file: {err}"))?;
    let mut hash = String::new();
    if meta.is_file() && meta.len() <= 10 * 1024 * 1024 {
        let bytes = fs::read(&target).map_err(|err| format!("failed to hash file: {err}"))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hash = format!("{:x}", hasher.finalize());
    }
    Ok(WorkspaceFileStat {
        path: rel_path_from_root(&root, &target),
        absolute_path: target.to_string_lossy().to_string(),
        kind: if meta.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        },
        size: meta.len(),
        modified_at: file_modified_at(&target),
        hash,
        exists: true,
    })
}

pub fn search_workspace(
    root_path: &str,
    query: &str,
    include_content: bool,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let root = resolve_authorized_root(root_path)?;
    let patterns = workspace_patterns(&root);
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 500);
    let mut results = Vec::new();
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if results.len() >= limit {
            break;
        }
        let path = entry.path();
        if path == root {
            continue;
        }
        let rel = rel_path_from_root(&root, path);
        if is_ignored(&rel, &patterns) {
            if entry.file_type().is_dir() {
                continue;
            }
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = if meta.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        };
        let mut matched_line = 0usize;
        let mut preview = String::new();
        let name_matched = rel.to_lowercase().contains(&needle);
        let mut content_matched = false;
        if include_content && meta.is_file() && meta.len() <= 512 * 1024 {
            if let Ok(bytes) = fs::read(path) {
                if !bytes.iter().take(8192).any(|byte| *byte == 0) {
                    let (_encoding, text) = detect_text_encoding(&bytes);
                    for (idx, line) in text.lines().enumerate() {
                        if line.to_lowercase().contains(&needle) {
                            content_matched = true;
                            matched_line = idx + 1;
                            preview = line.trim().chars().take(180).collect();
                            break;
                        }
                    }
                }
            }
        }
        if name_matched || content_matched {
            results.push(WorkspaceSearchResult {
                path: rel,
                name,
                kind,
                size: meta.len(),
                modified_at: file_modified_at(path),
                line: matched_line,
                preview,
            });
        }
    }
    Ok(results)
}

pub fn open_workspace_in_explorer(path: &str) -> Result<(), String> {
    let root = resolve_authorized_root(path)?;
    open_folder(&root)
}

fn open_folder(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|err| format!("failed to open folder: {err}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("failed to open folder: {err}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("failed to open folder: {err}"))?;
        return Ok(());
    }
}

pub fn run_workspace_command(
    root_path: &str,
    command: &str,
    timeout_secs: Option<u64>,
) -> Result<WorkspaceCommandResult, String> {
    let root = resolve_authorized_root(root_path)?;
    let command = normalize_command(command);
    if command.trim().is_empty() {
        return Err("command cannot be empty".to_string());
    }
    let timeout = timeout_secs.unwrap_or(120).max(1);
    let (ok, exit_code, output) = run_command_with_timeout(&root, &command, timeout)?;
    let truncated = output.chars().count() > 20000;
    let output = if truncated {
        output
            .chars()
            .rev()
            .take(20000)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    } else {
        output
    };
    Ok(WorkspaceCommandResult {
        command,
        cwd: root.to_string_lossy().to_string(),
        ok,
        exit_code,
        output,
        truncated,
    })
}

fn git_file_parent(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn git_file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn workspace_git_file(
    path: String,
    index_status: String,
    worktree_status: String,
    kind: &str,
) -> WorkspaceGitFile {
    let staged = index_status.trim() != "" && index_status != "?";
    let untracked = kind == "untracked";
    let unstaged = untracked || worktree_status.trim() != "";
    WorkspaceGitFile {
        parent: git_file_parent(&path),
        name: git_file_name(&path),
        path,
        index_status,
        worktree_status,
        kind: kind.to_string(),
        staged,
        unstaged,
        untracked,
    }
}

fn group_git_files(files: &[WorkspaceGitFile]) -> WorkspaceGitGroups {
    WorkspaceGitGroups {
        staged: files.iter().filter(|file| file.staged).cloned().collect(),
        unstaged: files
            .iter()
            .filter(|file| file.unstaged && !file.untracked)
            .cloned()
            .collect(),
        untracked: files
            .iter()
            .filter(|file| file.untracked)
            .cloned()
            .collect(),
    }
}

fn empty_git_groups() -> WorkspaceGitGroups {
    WorkspaceGitGroups {
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
    }
}

fn read_recent_git_commits(
    root: &Path,
    max_count: usize,
    timeout_secs: u64,
) -> Vec<WorkspaceGitCommit> {
    let args = vec![
        "log".to_string(),
        format!("--max-count={}", max_count.max(1)),
        "--date=relative".to_string(),
        "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%aI".to_string(),
    ];
    let Ok((ok, _, output)) = run_git_args(root, &args, timeout_secs.max(1)) else {
        return Vec::new();
    };
    if !ok {
        return Vec::new();
    }
    output
        .lines()
        .filter_map(|line| {
            let parts = line.split('\x1f').collect::<Vec<_>>();
            if parts.len() < 6 {
                return None;
            }
            Some(WorkspaceGitCommit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                subject: parts[2].to_string(),
                author: parts[3].to_string(),
                relative_time: parts[4].to_string(),
                timestamp: parts[5].to_string(),
            })
        })
        .collect()
}

pub fn read_workspace_git_status(root_path: &str) -> Result<WorkspaceGitStatus, String> {
    read_workspace_git_status_inner(root_path, true)
}

pub fn read_workspace_git_status_light(root_path: &str) -> Result<WorkspaceGitStatus, String> {
    read_workspace_git_status_inner(root_path, false)
}

fn read_workspace_git_status_inner(
    root_path: &str,
    include_diff: bool,
) -> Result<WorkspaceGitStatus, String> {
    let root = resolve_authorized_root(root_path)?;
    if !is_git_repository(&root) {
        return Ok(WorkspaceGitStatus {
            branch: String::new(),
            ahead: 0,
            behind: 0,
            repository: false,
            staged_count: 0,
            unstaged_count: 0,
            untracked_count: 0,
            summary: "当前项目还没有初始化 Git 仓库。点击“初始化 Git”后即可开始跟踪变更。"
                .to_string(),
            repository_message: "当前项目还没有初始化 Git 仓库。".to_string(),
            diff: String::new(),
            staged_diff: String::new(),
            unstaged_diff: String::new(),
            status_short: String::new(),
            files: Vec::new(),
            grouped_files: empty_git_groups(),
            recent_commits: Vec::new(),
            untracked_files: Vec::new(),
            skipped_paths: Vec::new(),
        });
    }
    let status_timeout = if include_diff { 30 } else { 8 };
    let (ok, _exit_code, summary) =
        run_command_with_timeout(&root, "git status --short --branch", status_timeout)?;
    let (unstaged_ok, _, unstaged_diff) = if include_diff {
        run_command_with_timeout(&root, "git diff -- .", 60)?
    } else {
        (true, 0, String::new())
    };
    let (staged_ok, _, staged_diff) = if include_diff {
        run_command_with_timeout(&root, "git diff --cached -- .", 60)?
    } else {
        (true, 0, String::new())
    };
    let mut branch = String::new();
    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut staged_count = 0usize;
    let mut unstaged_count = 0usize;
    let mut untracked_count = 0usize;
    let mut files = Vec::<WorkspaceGitFile>::new();
    let mut untracked_files = Vec::<String>::new();

    for line in summary.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.split("...").next().unwrap_or(rest).to_string();
            if let Some(meta) = rest.split('[').nth(1) {
                let meta = meta.trim_end_matches(']');
                for part in meta.split(',') {
                    let trimmed = part.trim();
                    if let Some(value) = trimmed.strip_prefix("ahead ") {
                        ahead = value.parse::<i64>().unwrap_or(0);
                    } else if let Some(value) = trimmed.strip_prefix("behind ") {
                        behind = value.parse::<i64>().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if line.starts_with("?? ") {
            untracked_count += 1;
            let path = line.trim_start_matches("?? ").trim().replace('\\', "/");
            if !path.is_empty() {
                untracked_files.push(path.clone());
                files.push(workspace_git_file(
                    path,
                    "?".to_string(),
                    "?".to_string(),
                    "untracked",
                ));
            }
        } else if line.len() >= 2 {
            let bytes = line.as_bytes();
            let index_status = bytes.first().copied().unwrap_or(b' ') as char;
            let worktree_status = bytes.get(1).copied().unwrap_or(b' ') as char;
            if index_status != ' ' {
                staged_count += 1;
            }
            if worktree_status != ' ' {
                unstaged_count += 1;
            }
            let path = line
                .get(3..)
                .unwrap_or("")
                .trim()
                .split(" -> ")
                .last()
                .unwrap_or("")
                .replace('\\', "/");
            if !path.is_empty() {
                let kind = if index_status != ' ' && worktree_status != ' ' {
                    "staged+unstaged"
                } else if index_status != ' ' {
                    "staged"
                } else {
                    "unstaged"
                };
                files.push(workspace_git_file(
                    path,
                    index_status.to_string(),
                    worktree_status.to_string(),
                    kind,
                ));
            }
        }
    }
    let mut full_diff = String::new();
    if !staged_diff.trim().is_empty() {
        full_diff.push_str("[staged]\n");
        full_diff.push_str(&staged_diff);
        if !full_diff.ends_with('\n') {
            full_diff.push('\n');
        }
    }
    if !unstaged_diff.trim().is_empty() {
        full_diff.push_str("[unstaged]\n");
        full_diff.push_str(&unstaged_diff);
        if !full_diff.ends_with('\n') {
            full_diff.push('\n');
        }
    }
    if !untracked_files.is_empty() {
        full_diff.push_str("[untracked]\n");
        for path in &untracked_files {
            full_diff.push_str(path);
            full_diff.push('\n');
        }
    }
    if !staged_ok {
        full_diff.push_str("\n[git diff --cached failed]\n");
        full_diff.push_str(&staged_diff);
    }
    if !unstaged_ok {
        full_diff.push_str("\n[git diff failed]\n");
        full_diff.push_str(&unstaged_diff);
    }

    let grouped_files = group_git_files(&files);
    let recent_commits = if include_diff {
        read_recent_git_commits(&root, 30, 30)
    } else {
        read_recent_git_commits(&root, 12, 5)
    };

    Ok(WorkspaceGitStatus {
        branch,
        ahead,
        behind,
        repository: true,
        staged_count,
        unstaged_count,
        untracked_count,
        summary: if ok {
            summary.clone()
        } else {
            format!("{summary}\n[git status failed]")
        },
        repository_message: String::new(),
        diff: full_diff,
        staged_diff,
        unstaged_diff,
        status_short: summary,
        files,
        grouped_files,
        recent_commits,
        untracked_files,
        skipped_paths: Vec::new(),
    })
}

pub fn initialize_git_repository(root_path: &str) -> Result<WorkspaceGitStatus, String> {
    let root = resolve_authorized_root(root_path)?;
    let (ok, _exit_code, output) = run_command_with_timeout(&root, "git init", 30)?;
    if !ok {
        return Err(if output.trim().is_empty() {
            "failed to initialize git repository".to_string()
        } else {
            output
        });
    }
    read_workspace_git_status(root_path)
}

fn normalized_git_path(path: &str) -> Result<String, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("git path cannot be empty".to_string());
    }
    if Path::new(&normalized).is_absolute() || normalized.split('/').any(|part| part == "..") {
        return Err("git path must be relative to workspace root".to_string());
    }
    Ok(normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

fn run_git_args(
    root: &Path,
    args: &[String],
    timeout_secs: u64,
) -> Result<(bool, i32, String), String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to run git: {err}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll git: {err}"))?
        {
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to collect git output: {err}"))?;
            let mut text = String::new();
            text.push_str(&decode_console_output(&output.stdout));
            text.push_str(&decode_console_output(&output.stderr));
            return Ok((status.success(), status.code().unwrap_or(-1), text));
        }
        if started.elapsed() >= Duration::from_secs(timeout_secs.max(1)) {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to collect timed-out git output: {err}"))?;
            let mut text = format!("[GIT_TIMEOUT] command exceeded {}s\n", timeout_secs.max(1));
            text.push_str(&decode_console_output(&output.stdout));
            text.push_str(&decode_console_output(&output.stderr));
            return Ok((false, -1, text));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn is_nested_git_repo_without_head(root: &Path, rel_path: &str) -> bool {
    let clean = rel_path.trim().trim_end_matches('/').replace('\\', "/");
    if clean.is_empty() {
        return false;
    }
    let candidate = root.join(clean);
    let git_marker = candidate.join(".git");
    if !git_marker.exists() {
        return false;
    }
    let args = vec![
        "rev-parse".to_string(),
        "--verify".to_string(),
        "HEAD".to_string(),
    ];
    match run_git_args(&candidate, &args, 10) {
        Ok((ok, _, _)) => !ok,
        Err(_) => true,
    }
}

fn nested_git_repos_without_head(root: &Path, rel_path: &str) -> Vec<String> {
    let clean = rel_path.trim().trim_end_matches('/').replace('\\', "/");
    if clean.is_empty() {
        return Vec::new();
    }
    let candidate = root.join(&clean);
    if !candidate.exists() {
        return Vec::new();
    }
    let mut repos = Vec::new();
    if is_nested_git_repo_without_head(root, &clean) {
        repos.push(clean.clone());
    }
    if !candidate.is_dir() {
        return repos;
    }
    for entry in WalkDir::new(&candidate)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.file_name().to_string_lossy() != ".git" {
            continue;
        }
        let Some(repo_path) = entry.path().parent() else {
            continue;
        };
        if repo_path == candidate {
            continue;
        }
        let Ok(rel) = repo_path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !rel.is_empty() && is_nested_git_repo_without_head(root, &rel) {
            repos.push(rel);
        }
    }
    repos.sort();
    repos.dedup();
    repos
}

fn git_exclude_pathspec(path: &str) -> String {
    format!(
        ":(exclude){}",
        path.trim().trim_end_matches('/').replace('\\', "/")
    )
}

fn parse_unchecked_nested_repo_errors(output: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in output.lines() {
        let Some(rest) = line.split("error: '").nth(1) else {
            continue;
        };
        let Some((path, tail)) = rest.split_once("'") else {
            continue;
        };
        if tail.contains("does not have a commit checked out") {
            let clean = path.trim().trim_end_matches('/').replace('\\', "/");
            if !clean.is_empty() {
                paths.push(clean);
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn should_skip_large_untracked_dir(root: &Path, rel_path: &str) -> Option<String> {
    let clean = rel_path.trim().trim_end_matches('/').replace('\\', "/");
    if clean.is_empty() {
        return None;
    }
    let candidate = root.join(&clean);
    if !candidate.is_dir() {
        return None;
    }
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    for entry in WalkDir::new(&candidate)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.file_name().to_string_lossy() != ".git")
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        file_count = file_count.saturating_add(1);
        total_bytes =
            total_bytes.saturating_add(entry.metadata().map(|value| value.len()).unwrap_or(0));
        if file_count > GIT_AUTO_STAGE_MAX_DIR_FILES || total_bytes > GIT_AUTO_STAGE_MAX_DIR_BYTES {
            return Some(format!(
                "{clean}（约 {file_count} 个文件 / {} MB，超过自动跟踪阈值）",
                total_bytes / 1024 / 1024
            ));
        }
    }
    None
}

fn mark_skipped_git_paths(
    mut status: WorkspaceGitStatus,
    skipped_paths: Vec<String>,
) -> WorkspaceGitStatus {
    if skipped_paths.is_empty() {
        return status;
    }
    let skipped = skipped_paths.join(", ");
    status.repository_message = format!(
        "已跳过不适合自动跟踪的路径：{skipped}。可能是大型未跟踪目录，或未提交的嵌套 Git 仓库；请在 Git 面板中单独处理这些路径。"
    );
    if status.summary.trim().is_empty() {
        status.summary = status.repository_message.clone();
    } else {
        status.summary = format!("{}\n{}", status.summary, status.repository_message);
    }
    status.skipped_paths = skipped_paths;
    status
}

pub fn stage_git_paths(root_path: &str, paths: Vec<String>) -> Result<WorkspaceGitStatus, String> {
    let root = resolve_authorized_root(root_path)?;
    if !is_git_repository(&root) {
        return Err("current project is not a Git repository".to_string());
    }
    let before = read_workspace_git_status_light(root_path).ok();
    let mut skipped_paths = Vec::<String>::new();
    let mut candidates = Vec::<String>::new();
    if paths.is_empty() {
        if let Some(before) = &before {
            for file in &before.files {
                let path = normalized_git_path(&file.path)?;
                if file.untracked && should_skip_large_untracked_dir(&root, &path).is_some() {
                    skipped_paths.push(path);
                    continue;
                }
                let invalid_nested = if file.untracked {
                    nested_git_repos_without_head(&root, &path)
                } else {
                    Vec::new()
                };
                if invalid_nested.iter().any(|item| item == &path) {
                    skipped_paths.extend(invalid_nested);
                } else {
                    skipped_paths.extend(invalid_nested);
                    candidates.push(path);
                }
            }
        }
    } else {
        for path in &paths {
            let path = normalized_git_path(&path)?;
            if is_nested_git_repo_without_head(&root, &path) {
                return Err(format!(
                    "无法跟踪 {path}：它是一个还没有 commit 的嵌套 Git 仓库。请先进入该目录提交一次，或移除其中的 .git 后再跟踪。"
                ));
            }
            candidates.push(path);
        }
    }
    candidates.sort();
    candidates.dedup();
    skipped_paths.sort();
    skipped_paths.dedup();
    let mut output = String::new();
    for chunk in candidates.chunks(80) {
        if chunk.is_empty() {
            continue;
        }
        let mut args = vec!["add".to_string(), "--all".to_string(), "--".to_string()];
        args.extend(chunk.iter().cloned());
        args.extend(skipped_paths.iter().map(|path| git_exclude_pathspec(path)));
        let (mut ok, _, mut chunk_output) = run_git_args(&root, &args, 300)?;
        if !ok {
            let retry_skips = parse_unchecked_nested_repo_errors(&chunk_output);
            if !retry_skips.is_empty() {
                skipped_paths.extend(retry_skips);
                skipped_paths.sort();
                skipped_paths.dedup();
                let mut retry_args = vec!["add".to_string(), "--all".to_string(), "--".to_string()];
                retry_args.extend(chunk.iter().cloned());
                retry_args.extend(skipped_paths.iter().map(|path| git_exclude_pathspec(path)));
                let retry = run_git_args(&root, &retry_args, 300)?;
                ok = retry.0;
                chunk_output.push_str(&retry.2);
            }
        }
        output.push_str(&chunk_output);
        if !ok {
            return Err(if output.trim().is_empty() {
                "git add failed".to_string()
            } else {
                output
            });
        }
    }
    let after = read_workspace_git_status_light(root_path)?;
    if paths.is_empty() {
        if let Some(before) = before {
            let before_changes =
                before.staged_count + before.unstaged_count + before.untracked_count;
            let after_changes = after.staged_count + after.unstaged_count + after.untracked_count;
            let unchanged = before.staged_count == after.staged_count
                && before.unstaged_count == after.unstaged_count
                && before.untracked_count == after.untracked_count;
            if skipped_paths.is_empty()
                && before_changes > 0
                && after.staged_count == 0
                && after_changes > 0
                && unchanged
            {
                return Err(format!(
                    "Git 跟踪全部变更执行后状态没有变化。执行前：暂存 {} / 未暂存 {} / 未跟踪 {}；执行后：暂存 {} / 未暂存 {} / 未跟踪 {}。\n{}",
                    before.staged_count,
                    before.unstaged_count,
                    before.untracked_count,
                    after.staged_count,
                    after.unstaged_count,
                    after.untracked_count,
                    if output.trim().is_empty() { "git add 没有返回错误输出，请检查文件权限、.gitignore 或 Git 配置。".to_string() } else { output }
                ));
            }
        }
    }
    Ok(mark_skipped_git_paths(after, skipped_paths))
}

pub fn unstage_git_paths(
    root_path: &str,
    paths: Vec<String>,
) -> Result<WorkspaceGitStatus, String> {
    let root = resolve_authorized_root(root_path)?;
    if !is_git_repository(&root) {
        return Err("current project is not a Git repository".to_string());
    }
    let mut args = vec!["restore".to_string(), "--staged".to_string()];
    if paths.is_empty() {
        args.push("--".to_string());
        args.push(".".to_string());
    } else {
        args.push("--".to_string());
        for path in paths {
            args.push(normalized_git_path(&path)?);
        }
    }
    let (ok, _, output) = run_git_args(&root, &args, 60)?;
    if !ok {
        return Err(if output.trim().is_empty() {
            "git restore --staged failed".to_string()
        } else {
            output
        });
    }
    read_workspace_git_status_light(root_path)
}

pub fn commit_git_changes(root_path: &str, message: &str) -> Result<WorkspaceGitStatus, String> {
    let root = resolve_authorized_root(root_path)?;
    if !is_git_repository(&root) {
        return Err("current project is not a Git repository".to_string());
    }
    let clean = message.trim();
    if clean.is_empty() {
        return Err("commit message cannot be empty".to_string());
    }
    let args = vec!["commit".to_string(), "-m".to_string(), clean.to_string()];
    let (ok, _, output) = run_git_args(&root, &args, 120)?;
    if !ok {
        return Err(if output.trim().is_empty() {
            "git commit failed".to_string()
        } else {
            output
        });
    }
    read_workspace_git_status(root_path)
}

pub fn read_git_file_diff(root_path: &str, path: &str, staged: bool) -> Result<String, String> {
    let root = resolve_authorized_root(root_path)?;
    if !is_git_repository(&root) {
        return Err("current project is not a Git repository".to_string());
    }
    let clean = normalized_git_path(path)?;
    let mut args = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(clean.clone());
    let (ok, _, output) = run_git_args(&root, &args, 60)?;
    if ok && !output.trim().is_empty() {
        return Ok(output);
    }
    if !ok {
        return Err(if output.trim().is_empty() {
            "git diff failed".to_string()
        } else {
            output
        });
    }
    Ok(format!("[untracked or clean]\n{clean}"))
}

pub fn show_git_commit(root_path: &str, commit_hash: &str) -> Result<Value, String> {
    let root = resolve_authorized_root(root_path)?;
    if !is_git_repository(&root) {
        return Err("current project is not a Git repository".to_string());
    }
    let clean = commit_hash.trim();
    if clean.is_empty() || clean.len() > 64 || !clean.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("invalid commit hash".to_string());
    }
    let meta_args = vec![
        "show".to_string(),
        "--no-patch".to_string(),
        "--date=relative".to_string(),
        "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%aI".to_string(),
        clean.to_string(),
    ];
    let (meta_ok, _, meta) = run_git_args(&root, &meta_args, 30)?;
    if !meta_ok {
        return Err(if meta.trim().is_empty() {
            "git show failed".to_string()
        } else {
            meta
        });
    }
    let diff_args = vec![
        "show".to_string(),
        "--stat".to_string(),
        "--summary".to_string(),
        "--find-renames".to_string(),
        "--format=".to_string(),
        clean.to_string(),
    ];
    let (_, _, summary) = run_git_args(&root, &diff_args, 60)?;
    let parts = meta
        .lines()
        .next()
        .unwrap_or("")
        .split('\x1f')
        .collect::<Vec<_>>();
    Ok(json!({
        "hash": parts.get(0).copied().unwrap_or(clean),
        "short_hash": parts.get(1).copied().unwrap_or(clean),
        "subject": parts.get(2).copied().unwrap_or(""),
        "author": parts.get(3).copied().unwrap_or(""),
        "relative_time": parts.get(4).copied().unwrap_or(""),
        "timestamp": parts.get(5).copied().unwrap_or(""),
        "summary": summary,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_settings_prefers_enabled_channel_over_disabled_default() {
        let mut settings = IdeSettings::default();
        settings.provider_type = "openai-responses".to_string();
        settings.api_base_url = "https://api.openai.example".to_string();
        settings.model = "deepseek-v4-flash".to_string();
        settings
            .default_routes
            .insert("chat".to_string(), "default".to_string());
        settings.channels = vec![
            ProviderChannel {
                id: "default".to_string(),
                name: "disabled openai".to_string(),
                provider_type: "openai-responses".to_string(),
                api_base_url: "https://api.openai.example".to_string(),
                enabled: false,
                models: vec!["deepseek-v4-flash".to_string()],
                enabled_models: vec!["deepseek-v4-flash".to_string()],
                model_filter_configured: true,
                ..ProviderChannel::default()
            },
            ProviderChannel {
                id: "deepseek".to_string(),
                name: "deepseek".to_string(),
                provider_type: "deepseek".to_string(),
                api_base_url: "https://api.deepseek.com".to_string(),
                enabled: true,
                priority: 10,
                models: vec!["deepseek-v4-flash".to_string()],
                enabled_models: vec!["deepseek-v4-flash".to_string()],
                model_filter_configured: true,
                default_model: "deepseek-v4-flash".to_string(),
                ..ProviderChannel::default()
            },
        ];

        let normalized = normalize_ide_settings(settings);

        assert_eq!(normalized.provider_type, "deepseek");
        assert_eq!(normalized.api_base_url, "https://api.deepseek.com");
        assert_eq!(normalized.model, "deepseek-v4-flash");
    }
}
