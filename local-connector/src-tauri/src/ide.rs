use crate::connector;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child as StdChild, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Default)]
pub struct IdeRuntimeState {
    terminals: Mutex<HashMap<String, TerminalSession>>,
    voice_sessions: Mutex<HashMap<String, VoiceSession>>,
    agent_sessions: Mutex<HashMap<String, Value>>,
    agent_events: Mutex<Vec<Value>>,
    local_server_port: Mutex<Option<u16>>,
    next_terminal_id: AtomicU64,
    next_voice_id: AtomicU64,
    next_agent_id: AtomicU64,
    next_agent_event_id: AtomicU64,
}

struct TerminalSession {
    process: TerminalProcess,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    shell: String,
    cwd: String,
    last_output: Arc<Mutex<String>>,
    local_echo: bool,
}

enum TerminalProcess {
    Pty {
        child: Box<dyn portable_pty::Child + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
    },
    Pipe {
        child: StdChild,
    },
}

struct VoiceSession {
    stop: mpsc::Sender<()>,
    join: Option<JoinHandle<Result<Value, String>>>,
}

#[derive(Debug, Deserialize)]
pub struct IdeApiRequestSettings {
    pub api_base_url: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct IdeAiRequest {
    pub messages: Vec<IdeAiMessage>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
}

impl Default for IdeAiRequest {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            temperature: Some(0.2),
            max_tokens: Some(4096),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct IdeAiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IdeAiResponse {
    pub answer: String,
    pub reasoning_summary: String,
    pub reasoning_raw: String,
    pub tool_calls: Vec<Value>,
    pub usage: Value,
    pub finish_reason: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone)]
struct AgentModelTurn {
    response: IdeAiResponse,
    tool_requests: Vec<Value>,
}

#[derive(Debug)]
struct AgentToolDetection {
    visible_delta: String,
    tool_requests: Option<Vec<Value>>,
}

enum AgentParsedStep {
    Tool(Vec<Value>),
    Final(String),
}

#[derive(Debug)]
enum AgentToolDetectorMode {
    Text,
    Fence { lang: String, content: String },
    RawJson { content: String },
}

#[derive(Debug)]
struct AgentStreamToolDetector {
    mode: AgentToolDetectorMode,
    pending: String,
    visible_started: bool,
    line_start: bool,
}

#[derive(Debug, Default, Clone)]
struct NativeToolDraft {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct AgentNativeToolAccumulator {
    openai_responses: HashMap<String, NativeToolDraft>,
    openai_chat: HashMap<usize, NativeToolDraft>,
    anthropic: HashMap<usize, NativeToolDraft>,
}

#[derive(Debug, Serialize)]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
    pub ok: bool,
    pub interactive: bool,
    pub local_echo: bool,
    pub probe_output: String,
    pub fallback_from: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub stream: String,
    pub data: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: i32,
}

#[derive(Debug, Serialize)]
pub struct AttachmentInfo {
    pub kind: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mime: String,
    pub previewable: bool,
}

#[tauri::command]
pub fn ide_bootstrap() -> connector::IdeBootstrap {
    connector::load_ide_bootstrap()
}

#[tauri::command]
pub fn ide_save_settings(settings: connector::IdeSettings) -> Result<connector::IdeSettings, String> {
    connector::save_ide_settings(settings)
}

fn ide_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(std::env::temp_dir)
        .join("AutoCodeLocalConnector")
}

fn session_storage_dir() -> PathBuf {
    ide_data_dir().join("sessions")
}

fn session_file_name(root_path: Option<&str>) -> String {
    let root = root_path.unwrap_or("").trim();
    if root.is_empty() || root == "__global__" {
        return "global.json".to_string();
    }
    let digest = Sha256::digest(root.to_lowercase().as_bytes());
    format!("{digest:x}.json")
}

fn session_snapshot_path(root_path: Option<&str>) -> PathBuf {
    session_storage_dir().join(session_file_name(root_path))
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid session snapshot path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create session directory: {err}"))?;
    let tmp = path.with_extension("tmp");
    let payload = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    fs::write(&tmp, payload).map_err(|err| format!("failed to write session snapshot: {err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("failed to save session snapshot: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn ide_session_load(root_path: Option<String>) -> Result<Value, String> {
    let path = session_snapshot_path(root_path.as_deref());
    if !path.exists() {
        return Ok(Value::Null);
    }
    let text = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read session snapshot: {err}"))?;
    serde_json::from_str::<Value>(&text)
        .map_err(|err| format!("failed to parse session snapshot: {err}"))
}

#[tauri::command]
pub fn ide_session_save(root_path: String, snapshot: Value) -> Result<Value, String> {
    let path = session_snapshot_path(Some(root_path.as_str()));
    write_json_pretty(&path, &snapshot)?;
    Ok(json!({
        "ok": true,
        "savedAt": agent_now(),
        "path": path.to_string_lossy()
    }))
}

#[tauri::command]
pub fn ide_session_clear(root_path: Option<String>) -> Result<Value, String> {
    let path = session_snapshot_path(root_path.as_deref());
    if path.exists() {
        fs::remove_file(&path).map_err(|err| format!("failed to clear session snapshot: {err}"))?;
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn ide_terminal_set_default_shell(shell: String) -> Result<connector::IdeSettings, String> {
    let mut settings = connector::load_ide_settings();
    let normalized = match shell.trim().to_lowercase().as_str() {
        "" | "auto" => "auto".to_string(),
        "cmd" | "cmd.exe" => "cmd".to_string(),
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => "powershell".to_string(),
        other => other.to_string(),
    };
    settings.default_shell = normalized;
    connector::save_ide_settings(settings)
}

#[tauri::command]
pub fn ide_pick_workspace() -> Result<connector::RecentProject, String> {
    let Some(project) = connector::pick_project_dir() else {
        return Err("Project selection was cancelled.".to_string());
    };
    connector::record_recent_project(&project.to_string_lossy(), None, None)
}

#[tauri::command]
pub fn ide_open_workspace(root_path: String, task_id: Option<String>, preview_url: Option<String>) -> Result<connector::RecentProject, String> {
    connector::record_recent_project(&root_path, task_id.as_deref(), preview_url.as_deref())
}

#[tauri::command]
pub fn ide_list_workspace(root_path: String, path: Option<String>, max_depth: Option<usize>) -> Result<Vec<connector::WorkspaceEntry>, String> {
    connector::list_workspace_tree(&root_path, path.as_deref().unwrap_or(""), max_depth.unwrap_or(4))
}

#[tauri::command]
pub fn ide_read_workspace_file(root_path: String, path: String) -> Result<connector::WorkspaceFileSnapshot, String> {
    connector::read_workspace_file(&root_path, &path)
}

#[tauri::command]
pub fn ide_save_workspace_file(
    root_path: String,
    path: String,
    content: String,
    encoding: Option<String>,
    line_ending: Option<String>,
) -> Result<connector::WorkspaceFileSnapshot, String> {
    connector::save_workspace_file(&root_path, &path, &content, encoding, line_ending)
}

#[tauri::command]
pub fn ide_run_workspace_command(root_path: String, command: String, timeout_secs: Option<u64>) -> Result<connector::WorkspaceCommandResult, String> {
    connector::run_workspace_command(&root_path, &command, timeout_secs)
}

#[tauri::command]
pub fn ide_shell_execute(
    root_path: String,
    cwd: String,
    command: String,
    shell: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    let cwd_path = if cwd.trim().is_empty() {
        root.clone()
    } else {
        let candidate = PathBuf::from(cwd.trim());
        if candidate.is_absolute() {
            candidate
        } else {
            root.join(cwd.trim())
        }
    };
    let cwd_path = cwd_path
        .canonicalize()
        .map_err(|err| format!("terminal cwd is not accessible: {err}"))?;
    if !cwd_path.starts_with(&root) {
        return Err("terminal cwd is outside workspace root".to_string());
    }
    let command = command.trim();
    if command.is_empty() {
        return Ok(json!({
            "ok": true,
            "exitCode": 0,
            "cwd": cwd_path.to_string_lossy().to_string(),
            "output": ""
        }));
    }
    let lower = command.to_ascii_lowercase();
    if lower == "cd" || lower == "chdir" {
        return Ok(json!({
            "ok": true,
            "exitCode": 0,
            "cwd": cwd_path.to_string_lossy().to_string(),
            "output": format!("{}\r\n", cwd_path.to_string_lossy())
        }));
    }
    if let Some(target) = parse_cd_target(command) {
        let next = if target.is_empty() {
            root.clone()
        } else {
            let raw = PathBuf::from(&target);
            if raw.is_absolute() {
                raw
            } else {
                cwd_path.join(target)
            }
        };
        let next = next
            .canonicalize()
            .map_err(|err| format!("cd failed: {err}"))?;
        if !next.starts_with(&root) {
            return Err("cd target is outside workspace root".to_string());
        }
        if !next.is_dir() {
            return Err("cd target is not a directory".to_string());
        }
        return Ok(json!({
            "ok": true,
            "exitCode": 0,
            "cwd": next.to_string_lossy().to_string(),
            "output": ""
        }));
    }

    let timeout = timeout_secs.unwrap_or(120).max(1);
    let shell = shell.unwrap_or_default();
    let normalized_shell = shell.trim().to_lowercase();
    let mut child = if cfg!(windows) {
        let use_powershell = normalized_shell.contains("powershell") || normalized_shell.contains("pwsh");
        let mut cmd = if use_powershell {
            Command::new(if normalized_shell.contains("pwsh") { "pwsh.exe" } else { "powershell.exe" })
        } else {
            Command::new("cmd.exe")
        };
        if use_powershell {
            cmd.arg("-NoLogo")
                .arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-Command")
                .arg(command);
        } else {
            cmd.arg("/C").arg(command);
        };
        cmd.current_dir(&cwd_path)
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
            .current_dir(&cwd_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
    .map_err(|err| format!("failed to run terminal command: {err}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|err| format!("failed to poll terminal command: {err}"))? {
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to collect terminal command output: {err}"))?;
            let mut text = decode_terminal_command_output(&output.stdout);
            text.push_str(&decode_terminal_command_output(&output.stderr));
            return Ok(json!({
                "ok": status.success(),
                "exitCode": status.code().unwrap_or(-1),
                "cwd": cwd_path.to_string_lossy().to_string(),
                "output": text
            }));
        }
        if started.elapsed() >= Duration::from_secs(timeout) {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to collect timed-out terminal output: {err}"))?;
            let mut text = format!("[TIMEOUT] command exceeded {timeout}s\r\n");
            text.push_str(&decode_terminal_command_output(&output.stdout));
            text.push_str(&decode_terminal_command_output(&output.stderr));
            return Ok(json!({
                "ok": false,
                "exitCode": -1,
                "cwd": cwd_path.to_string_lossy().to_string(),
                "output": text
            }));
        }
        thread::sleep(Duration::from_millis(80));
    }
}

fn parse_cd_target(command: &str) -> Option<String> {
    let trimmed = command.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower == "cd.." || lower.starts_with("cd ") || lower.starts_with("chdir ")) {
        return None;
    }
    let raw = if lower == "cd.." {
        ".."
    } else if lower.starts_with("chdir ") {
        trimmed[6..].trim()
    } else {
        trimmed[2..].trim()
    };
    let mut target = raw.trim().to_string();
    if (target.starts_with('"') && target.ends_with('"')) || (target.starts_with('\'') && target.ends_with('\'')) {
        target = target[1..target.len().saturating_sub(1)].to_string();
    }
    Some(target)
}

fn decode_terminal_command_output(bytes: &[u8]) -> String {
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => text,
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

#[tauri::command]
pub fn ide_git_status(root_path: String) -> Result<connector::WorkspaceGitStatus, String> {
    connector::read_workspace_git_status(&root_path)
}

#[tauri::command]
pub async fn ide_api_request(
    settings: IdeApiRequestSettings,
    method: String,
    path: String,
    body: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let base = settings.api_base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("AutoCode API URL is empty".to_string());
    }
    let url = if path.starts_with("http://") || path.starts_with("https://") {
        path
    } else {
        format!("{base}/{}", path.trim_start_matches('/'))
    };
    let method = method.to_uppercase();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs.unwrap_or(20).clamp(3, 120)))
        .build()
        .map_err(|err| format!("failed to create API client: {err}"))?;
    let req_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|err| format!("invalid API method: {err}"))?;
    let mut request = client.request(req_method, &url);
    let key = settings.api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key).header("X-API-Key", key);
    }
    if let Some(body) = body {
        request = request.header("Content-Type", "application/json").body(body);
    }
    let response = request.send().await.map_err(|err| {
        if err.is_timeout() {
            format!("API request timed out: {url}")
        } else if err.is_connect() {
            format!("Cannot connect to AutoCode API: {url}. Please check URL, network and service status.")
        } else {
            format!("API request failed: {err}")
        }
    })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("failed to read API response: {err}"))?;
    let parsed = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()))
    };
    if !status.is_success() {
        let detail = parsed
            .get("message")
            .or_else(|| parsed.get("detail"))
            .or_else(|| parsed.get("error"))
            .and_then(Value::as_str)
            .unwrap_or(text.as_str());
        return Err(format!("AutoCode API returned {}: {}", status.as_u16(), detail));
    }
    Ok(parsed)
}

fn provider_base(settings: &connector::IdeSettings) -> Result<String, String> {
    let base = settings.api_base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("AI Provider URL is empty".to_string());
    }
    Ok(base)
}

fn provider_model(settings: &connector::IdeSettings) -> String {
    let configured = settings.model.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    match settings.provider_type.as_str() {
        "anthropic-messages" => "claude-sonnet-4-5".to_string(),
        "dashscope-qwen" => "qwen-plus".to_string(),
        "deepseek" => "deepseek-reasoner".to_string(),
        "kimi" => "kimi-k2-0711-preview".to_string(),
        "xai-grok" => "grok-4".to_string(),
        _ => "gpt-5".to_string(),
    }
}

fn endpoint_for(settings: &connector::IdeSettings) -> Result<String, String> {
    let base = provider_base(settings)?;
    let provider = settings.provider_type.as_str();
    let path = if provider == "openai-responses" || (provider == "xai-grok" && base.contains("/responses")) {
        "/v1/responses"
    } else if provider == "anthropic-messages" {
        "/v1/messages"
    } else if provider == "deepseek" && !base.ends_with("/v1") {
        "/chat/completions"
    } else {
        "/v1/chat/completions"
    };
    if base.ends_with("/chat/completions") || base.ends_with("/responses") || base.ends_with("/messages") {
        Ok(base)
    } else if base.ends_with("/v1") && path.starts_with("/v1/") {
        Ok(format!("{base}/{}", path.trim_start_matches("/v1/")))
    } else {
        Ok(format!("{base}{path}"))
    }
}

fn provider_url(settings: &connector::IdeSettings, path: &str) -> Result<String, String> {
    let base = provider_base(settings)?;
    if base.ends_with(path) {
        return Ok(base);
    }
    if base.ends_with("/v1") && path.starts_with("/v1/") {
        return Ok(format!("{base}/{}", path.trim_start_matches("/v1/")));
    }
    Ok(format!("{base}{}", path))
}

fn effort_value(settings: &connector::IdeSettings) -> Option<String> {
    let mode = settings.reasoning_mode.trim();
    if mode.eq_ignore_ascii_case("off") {
        return None;
    }
    let raw = if mode.eq_ignore_ascii_case("custom") {
        settings.reasoning_effort.trim()
    } else if mode.is_empty() || mode.eq_ignore_ascii_case("auto") {
        "medium"
    } else {
        mode
    };
    let mapped = match raw {
        "minimal" | "low" | "medium" | "high" => raw,
        "xhigh" | "max" | "extreme" | "极高" => "high",
        "低" => "low",
        "中" => "medium",
        "高" => "high",
        _ => "medium",
    };
    Some(mapped.to_string())
}

fn anthropic_budget(settings: &connector::IdeSettings, max_tokens: u64) -> u64 {
    let by_effort = match effort_value(settings).as_deref() {
        Some("low") => 2048,
        Some("high") => 16000,
        Some(_) => 8192,
        None => 0,
    };
    let requested = if settings.reasoning_budget_tokens > 0 {
        settings.reasoning_budget_tokens
    } else {
        by_effort
    };
    requested.min(max_tokens.saturating_sub(1024)).max(1024)
}

fn extract_data_images(content: &str) -> (String, Vec<(String, String, String)>) {
    let mut text_lines = Vec::new();
    let mut images = Vec::new();
    for line in content.lines() {
        if let Some(url) = line.strip_prefix("image_data_url=").map(str::trim) {
            if let Some(rest) = url.strip_prefix("data:") {
                if let Some((mime, data)) = rest.split_once(";base64,") {
                    images.push((url.to_string(), mime.to_string(), data.to_string()));
                    text_lines.push("[已附加一张图片，模型可通过多模态输入查看]");
                    continue;
                }
            }
        }
        text_lines.push(line);
    }
    (text_lines.join("\n"), images)
}

fn message_content_for_provider(provider: &str, content: &str) -> Value {
    let (text, images) = extract_data_images(content);
    if images.is_empty() {
        return Value::String(text);
    }
    if provider == "openai-responses" || provider == "xai-grok" {
        let mut parts = vec![json!({ "type": "input_text", "text": text })];
        for (url, _, _) in images {
            parts.push(json!({ "type": "input_image", "image_url": url }));
        }
        return Value::Array(parts);
    }
    if provider == "anthropic-messages" {
        let mut parts = vec![json!({ "type": "text", "text": text })];
        for (_, mime, data) in images {
            parts.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime,
                    "data": data
                }
            }));
        }
        return Value::Array(parts);
    }
    let mut parts = vec![json!({ "type": "text", "text": text })];
    for (url, _, _) in images {
        parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    Value::Array(parts)
}

fn chat_messages(provider: &str, messages: &[IdeAiMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            json!({
                "role": if message.role == "system" { "system" } else if message.role == "assistant" { "assistant" } else { "user" },
                "content": message_content_for_provider(provider, &message.content)
            })
        })
        .collect()
}

fn build_ai_payload(settings: &connector::IdeSettings, request: &IdeAiRequest) -> Value {
    let provider = settings.provider_type.as_str();
    let model = provider_model(settings);
    let max_tokens = request.max_tokens.unwrap_or(4096).clamp(512, 128000);
    let effort = effort_value(settings);
    if provider == "openai-responses" {
        let mut body = json!({
            "model": model,
            "input": chat_messages(provider, &request.messages),
            "max_output_tokens": max_tokens
        });
        if let Some(effort) = effort {
            body["reasoning"] = json!({
                "effort": effort,
                "summary": if settings.reasoning_summary { "auto" } else { "none" }
            });
        }
        return body;
    }
    if provider == "anthropic-messages" {
        let mut system = String::new();
        let messages = request
            .messages
            .iter()
            .filter_map(|message| {
                if message.role == "system" {
                    system.push_str(&message.content);
                    system.push('\n');
                    None
                } else {
                    Some(json!({
                        "role": if message.role == "assistant" { "assistant" } else { "user" },
                        "content": message_content_for_provider(provider, &message.content)
                    }))
                }
            })
            .collect::<Vec<_>>();
        let mut body = json!({
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens
        });
        if !system.trim().is_empty() {
            body["system"] = Value::String(system.trim().to_string());
        }
        if effort.is_some() {
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": anthropic_budget(settings, max_tokens)
            });
        }
        return body;
    }
    let mut body = json!({
        "model": model,
        "messages": chat_messages(provider, &request.messages),
        "temperature": request.temperature.unwrap_or(0.2),
        "max_tokens": max_tokens
    });
    match provider {
        "dashscope-qwen" => {
            if let Some(effort) = effort {
                body["enable_thinking"] = Value::Bool(true);
                body["thinking_budget"] = json!(match effort.as_str() {
                    "low" => 2048,
                    "high" => 16000,
                    _ => 8192,
                });
            }
        }
        "deepseek" => {
            if let Some(effort) = effort {
                body["thinking"] = json!({ "type": "enabled", "reasoning_effort": effort });
            }
        }
        "kimi" => {
            if let Some(effort) = effort {
                body["thinking"] = json!({ "type": "enabled", "effort": effort });
            }
        }
        "xai-grok" => {
            if let Some(effort) = effort {
                body["reasoning_effort"] = Value::String(effort);
            }
        }
        _ => {
            if let Some(effort) = effort {
                body["reasoning_effort"] = Value::String(effort);
            }
        }
    }
    body
}

fn collect_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(collect_text).collect::<Vec<_>>().join(""),
        Value::Object(map) => {
            for key in ["text", "output_text", "content", "summary"] {
                if let Some(found) = map.get(key) {
                    let text = collect_text(found);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn collect_response_output_text(value: &Value) -> String {
    let Some(items) = value.get("output").and_then(Value::as_array) else {
        return String::new();
    };
    let mut chunks = Vec::new();
    for item in items {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type == "reasoning" {
            continue;
        }
        if let Some(content) = item.get("content") {
            let text = collect_text(content);
            if !text.trim().is_empty() {
                chunks.push(text);
            }
        }
        for key in ["text", "output_text"] {
            if let Some(text_value) = item.get(key) {
                let text = collect_text(text_value);
                if !text.trim().is_empty() {
                    chunks.push(text);
                }
            }
        }
    }
    chunks.join("\n\n")
}

fn parse_ai_response(provider: &str, model: &str, value: Value) -> IdeAiResponse {
    let value = value
        .get("response")
        .cloned()
        .unwrap_or(value);
    let answer = value
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.pointer("/choices/0/message/content").map(collect_text))
        .or_else(|| value.pointer("/content").map(collect_text))
        .or_else(|| {
            let text = collect_response_output_text(&value);
            if text.trim().is_empty() { None } else { Some(text) }
        })
        .unwrap_or_else(|| collect_text(&value));
    let reasoning = value
        .pointer("/choices/0/message/reasoning_content")
        .map(collect_text)
        .or_else(|| value.pointer("/choices/0/message/reasoning").map(collect_text))
        .or_else(|| value.get("reasoning").map(collect_text))
        .or_else(|| value.pointer("/output/0/summary").map(collect_text))
        .unwrap_or_default();
    let finish_reason = value
        .pointer("/choices/0/finish_reason")
        .or_else(|| value.get("stop_reason"))
        .or_else(|| value.get("finish_reason"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_calls = value
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    IdeAiResponse {
        answer,
        reasoning_summary: reasoning.clone(),
        reasoning_raw: reasoning,
        tool_calls,
        usage: value.get("usage").cloned().unwrap_or(Value::Null),
        finish_reason,
        provider: provider.to_string(),
        model: model.to_string(),
    }
}

fn ai_http_request(
    client: &reqwest::Client,
    url: &str,
    settings: &connector::IdeSettings,
    provider: &str,
) -> reqwest::RequestBuilder {
    let key = settings.api_key.trim().to_string();
    let mut http = client.post(url).header("Content-Type", "application/json");
    if !key.is_empty() {
        if provider == "anthropic-messages" {
            http = http
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        } else {
            http = http.bearer_auth(key);
        }
    }
    for (name, value) in settings.custom_headers.iter() {
        if !name.trim().is_empty() && !value.trim().is_empty() {
            http = http.header(name.trim(), value.trim());
        }
    }
    http
}

fn enable_streaming(payload: &mut Value) {
    if let Some(object) = payload.as_object_mut() {
        object.insert("stream".to_string(), Value::Bool(true));
    }
}

fn agent_tool_schema(name: &str, description: &str, properties: Value, required: Vec<&str>) -> Value {
    json!({
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": true
        }
    })
}

fn agent_native_tool_specs() -> Vec<Value> {
    vec![
        agent_tool_schema(
            "read_file",
            "Read a UTF-8 text file inside the current workspace.",
            json!({ "path": { "type": "string", "description": "Workspace-relative file path." } }),
            vec!["path"],
        ),
        agent_tool_schema(
            "glob",
            "List workspace files using a glob-like pattern.",
            json!({ "pattern": { "type": "string", "description": "Pattern such as **/*.ts." }, "limit": { "type": "integer" } }),
            vec!["pattern"],
        ),
        agent_tool_schema(
            "grep",
            "Search file names and optionally file contents in the workspace.",
            json!({ "query": { "type": "string" }, "includeContent": { "type": "boolean" }, "limit": { "type": "integer" } }),
            vec!["query"],
        ),
        agent_tool_schema(
            "git_diff",
            "Read the current workspace Git diff.",
            json!({}),
            vec![],
        ),
        agent_tool_schema(
            "todowrite",
            "Record or update a concise task todo list for the current agent turn.",
            json!({ "items": { "type": "array", "items": { "type": "string" } } }),
            vec!["items"],
        ),
        agent_tool_schema(
            "bash",
            "Request execution of a workspace shell command. User approval is required.",
            json!({ "command": { "type": "string" } }),
            vec!["command"],
        ),
        agent_tool_schema(
            "apply_patch",
            "Request applying a unified diff patch to workspace files. User approval is required.",
            json!({ "patch": { "type": "string" } }),
            vec!["patch"],
        ),
        agent_tool_schema(
            "question",
            "Ask the user for missing information when local tools cannot resolve it.",
            json!({ "question": { "type": "string" } }),
            vec!["question"],
        ),
    ]
}

fn enable_agent_native_tools(provider: &str, payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let specs = agent_native_tool_specs();
    match provider {
        "openai-responses" => {
            object.insert(
                "tools".to_string(),
                Value::Array(
                    specs
                        .into_iter()
                        .map(|tool| {
                            json!({
                                "type": "function",
                                "name": tool.get("name").cloned().unwrap_or(Value::String("tool".to_string())),
                                "description": tool.get("description").cloned().unwrap_or(Value::String(String::new())),
                                "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                                "strict": false
                            })
                        })
                        .collect(),
                ),
            );
            object.insert("tool_choice".to_string(), Value::String("auto".to_string()));
        }
        "openai-chat" | "custom-openai-compatible" => {
            object.insert(
                "tools".to_string(),
                Value::Array(
                    specs
                        .into_iter()
                        .map(|tool| json!({ "type": "function", "function": tool }))
                        .collect(),
                ),
            );
            object.insert("tool_choice".to_string(), Value::String("auto".to_string()));
        }
        "anthropic-messages" => {
            object.insert(
                "tools".to_string(),
                Value::Array(
                    specs
                        .into_iter()
                        .map(|tool| {
                            json!({
                                "name": tool.get("name").cloned().unwrap_or(Value::String("tool".to_string())),
                                "description": tool.get("description").cloned().unwrap_or(Value::String(String::new())),
                                "input_schema": tool.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object" }))
                            })
                        })
                        .collect(),
                ),
            );
        }
        _ => {}
    }
}

fn agent_should_use_native_tools(provider: &str, model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    match provider {
        "openai-responses" | "anthropic-messages" => true,
        "openai-chat" => {
            !(model.contains("deepseek")
                || model.contains("qwen")
                || model.contains("kimi")
                || model.contains("moonshot")
                || model.contains("grok"))
        }
        _ => false,
    }
}

fn enable_agent_step_protocol(provider: &str, payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    match provider {
        "openai-chat"
        | "custom-openai-compatible"
        | "deepseek"
        | "kimi"
        | "dashscope-qwen"
        | "xai-grok" => {
            object.remove("tools");
            object.remove("tool_choice");
            object.insert("response_format".to_string(), json!({ "type": "json_object" }));
        }
        _ => {}
    }
}

fn stream_text_delta(provider: &str, value: &Value) -> (String, String, Value, String) {
    let mut answer = String::new();
    let mut reasoning = String::new();
    let mut usage = Value::Null;
    let mut finish_reason = String::new();

    if provider == "openai-responses" {
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(event_type, "response.output_text.delta" | "response.refusal.delta") {
            answer.push_str(value.get("delta").and_then(Value::as_str).unwrap_or(""));
        } else if event_type.contains("reasoning") || event_type.contains("summary") {
            reasoning.push_str(value.get("delta").and_then(Value::as_str).unwrap_or(""));
        } else if matches!(event_type, "response.completed" | "response.incomplete") {
            if let Some(response) = value.get("response") {
                if let Some(found) = response.get("usage") {
                    usage = found.clone();
                }
                finish_reason = response
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
        }
        return (answer, reasoning, usage, finish_reason);
    }

    if provider == "anthropic-messages" {
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "content_block_delta" => {
                let delta = value.get("delta").unwrap_or(&Value::Null);
                let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
                if delta_type == "text_delta" {
                    answer.push_str(delta.get("text").and_then(Value::as_str).unwrap_or(""));
                } else if delta_type.contains("thinking") {
                    reasoning.push_str(delta.get("thinking").and_then(Value::as_str).unwrap_or(""));
                }
            }
            "message_delta" => {
                if let Some(found) = value.pointer("/usage") {
                    usage = found.clone();
                }
                finish_reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            _ => {}
        }
        return (answer, reasoning, usage, finish_reason);
    }

    if let Some(delta) = value.pointer("/choices/0/delta") {
        answer.push_str(&collect_text(delta.get("content").unwrap_or(&Value::Null)));
        reasoning.push_str(&collect_text(
            delta.get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .unwrap_or(&Value::Null),
        ));
    }
    if let Some(found) = value.get("usage") {
        usage = found.clone();
    }
    finish_reason = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (answer, reasoning, usage, finish_reason)
}

fn parse_native_tool_arguments(arguments: &str) -> Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str::<Value>(trimmed).unwrap_or_else(|_| json!({ "raw": arguments }))
}

fn native_tool_request(name: String, arguments: String, id: String, provider: &str) -> Option<Value> {
    if name.trim().is_empty() {
        return None;
    }
    Some(json!({
        "tool": name,
        "input": parse_native_tool_arguments(&arguments),
        "native": {
            "provider": provider,
            "id": id
        }
    }))
}

impl AgentNativeToolAccumulator {
    fn feed(&mut self, provider: &str, value: &Value) -> Option<Vec<Value>> {
        match provider {
            "openai-responses" => self.feed_openai_responses(value),
            "anthropic-messages" => self.feed_anthropic(value),
            "openai-chat" | "custom-openai-compatible" => self.feed_openai_chat(value),
            _ => None,
        }
    }

    fn feed_openai_responses(&mut self, value: &Value) -> Option<Vec<Value>> {
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(event_type, "response.output_item.added" | "response.output_item.done") {
            if let Some(item) = value.get("item") {
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let id = item
                        .get("id")
                        .or_else(|| item.get("call_id"))
                        .and_then(Value::as_str)
                        .unwrap_or("function_call")
                        .to_string();
                    let draft = self.openai_responses.entry(id.clone()).or_default();
                    draft.id = id;
                    if let Some(name) = item.get("name").and_then(Value::as_str) {
                        draft.name = name.to_string();
                    }
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        draft.arguments = arguments.to_string();
                    }
                    if event_type == "response.output_item.done" {
                        if let Some(request) = native_tool_request(
                            draft.name.clone(),
                            draft.arguments.clone(),
                            draft.id.clone(),
                            "openai-responses",
                        ) {
                            return Some(vec![request]);
                        }
                    }
                }
            }
        }
        if event_type == "response.function_call_arguments.delta" {
            let id = value
                .get("item_id")
                .or_else(|| value.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or("function_call")
                .to_string();
            let draft = self.openai_responses.entry(id.clone()).or_default();
            draft.id = id;
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                draft.arguments.push_str(delta);
            }
        }
        if event_type == "response.function_call_arguments.done" {
            let id = value
                .get("item_id")
                .or_else(|| value.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or("function_call")
                .to_string();
            let draft = self.openai_responses.entry(id.clone()).or_default();
            draft.id = id;
            if let Some(name) = value.get("name").and_then(Value::as_str) {
                draft.name = name.to_string();
            }
            if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
                draft.arguments = arguments.to_string();
            }
            if let Some(request) = native_tool_request(
                draft.name.clone(),
                draft.arguments.clone(),
                draft.id.clone(),
                "openai-responses",
            ) {
                return Some(vec![request]);
            }
        }
        None
    }

    fn feed_openai_chat(&mut self, value: &Value) -> Option<Vec<Value>> {
        if let Some(calls) = value.pointer("/choices/0/delta/tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let draft = self.openai_chat.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    draft.id = id.to_string();
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    draft.name = name.to_string();
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                    draft.arguments.push_str(arguments);
                }
            }
        }
        let finish_reason = value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        if finish_reason == "tool_calls" || finish_reason == "function_call" {
            let mut requests = Vec::new();
            let mut keys = self.openai_chat.keys().cloned().collect::<Vec<_>>();
            keys.sort_unstable();
            for key in keys {
                if let Some(draft) = self.openai_chat.get(&key) {
                    if let Some(request) = native_tool_request(
                        draft.name.clone(),
                        draft.arguments.clone(),
                        if draft.id.is_empty() { format!("tool_call_{key}") } else { draft.id.clone() },
                        "openai-chat",
                    ) {
                        requests.push(request);
                    }
                }
            }
            if !requests.is_empty() {
                return Some(requests);
            }
        }
        None
    }

    fn feed_anthropic(&mut self, value: &Value) -> Option<Vec<Value>> {
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "content_block_start" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(block) = value.get("content_block") {
                    if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                        let draft = self.anthropic.entry(index).or_default();
                        draft.id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool_use")
                            .to_string();
                        draft.name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if let Some(input) = block
                            .get("input")
                            .filter(|input| !input.is_null() && !input.as_object().map(|object| object.is_empty()).unwrap_or(false))
                        {
                            draft.arguments = input.to_string();
                        }
                    }
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = value.get("delta").unwrap_or(&Value::Null);
                if delta.get("type").and_then(Value::as_str) == Some("input_json_delta") {
                    let draft = self.anthropic.entry(index).or_default();
                    if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                        draft.arguments.push_str(partial);
                    }
                }
            }
            "content_block_stop" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(draft) = self.anthropic.get(&index) {
                    if let Some(request) = native_tool_request(
                        draft.name.clone(),
                        draft.arguments.clone(),
                        draft.id.clone(),
                        "anthropic-messages",
                    ) {
                        return Some(vec![request]);
                    }
                }
            }
            _ => {}
        }
        None
    }
}

#[allow(dead_code)]
fn process_ai_stream_frame(
    app: &AppHandle,
    session_id: &str,
    provider: &str,
    frame: &str,
    answer: &mut String,
    reasoning: &mut String,
    usage: &mut Value,
    finish_reason: &mut String,
    final_frames: &mut Vec<Value>,
    pending_answer_delta: &mut String,
    pending_reasoning_delta: &mut String,
    last_emit: &mut Instant,
) -> bool {
    for line in frame.lines() {
        let line = line.trim();
        let data = if let Some(data) = line.strip_prefix("data:").map(str::trim) {
            data
        } else if line.starts_with('{') {
            line
        } else {
            continue;
        };
        if data == "[DONE]" {
            return true;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        final_frames.push(value.clone());
        let (delta, reasoning_delta, next_usage, next_finish) = stream_text_delta(provider, &value);
        if !delta.is_empty() {
            answer.push_str(&delta);
            pending_answer_delta.push_str(&delta);
        }
        if !reasoning_delta.is_empty() {
            reasoning.push_str(&reasoning_delta);
            pending_reasoning_delta.push_str(&reasoning_delta);
        }
        flush_ai_stream_deltas(app, session_id, pending_answer_delta, pending_reasoning_delta, last_emit, false);
        if next_usage != Value::Null {
            *usage = next_usage;
        }
        if !next_finish.is_empty() {
            *finish_reason = next_finish;
        }
    }
    false
}

fn flush_ai_stream_deltas(
    app: &AppHandle,
    session_id: &str,
    pending_answer_delta: &mut String,
    pending_reasoning_delta: &mut String,
    last_emit: &mut Instant,
    force: bool,
) {
    let ready = force
        || pending_answer_delta.chars().count() >= 120
        || pending_reasoning_delta.chars().count() >= 120
        || last_emit.elapsed() >= Duration::from_millis(60);
    if !ready {
        return;
    }
    if !pending_answer_delta.is_empty() {
        let content = std::mem::take(pending_answer_delta);
        agent_emit(app, session_id, "message_delta", json!({
            "role": "assistant",
            "kind": "text",
            "content": content
        }));
    }
    if !pending_reasoning_delta.is_empty() {
        let content = std::mem::take(pending_reasoning_delta);
        agent_emit(app, session_id, "reasoning_delta", json!({
            "content": content
        }));
    }
    *last_emit = Instant::now();
}

#[allow(dead_code)]
async fn stream_ai_request(
    app: &AppHandle,
    session_id: &str,
    settings: connector::IdeSettings,
    request: IdeAiRequest,
) -> Result<IdeAiResponse, String> {
    let provider = settings.provider_type.trim().to_string();
    let model = provider_model(&settings);
    let url = endpoint_for(&settings)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|err| format!("failed to create AI stream client: {err}"))?;
    let mut payload = build_ai_payload(&settings, &request);
    enable_streaming(&mut payload);
    if agent_should_use_native_tools(&provider, &model) {
        enable_agent_native_tools(&provider, &mut payload);
    } else {
        enable_agent_step_protocol(&provider, &mut payload);
    }
    let response = ai_http_request(&client, &url, &settings, &provider)
        .json(&payload)
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                format!("AI stream request timed out: {url}")
            } else if err.is_connect() {
                format!("Cannot connect to AI Provider: {url}. Please check URL and service status.")
            } else {
                format!("AI stream request failed: {err}")
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
        let detail = parsed
            .get("message")
            .or_else(|| parsed.get("detail"))
            .or_else(|| parsed.get("error"))
            .and_then(|value| value.as_str().or_else(|| value.get("message").and_then(Value::as_str)))
            .unwrap_or(text.as_str());
        return Err(format!("AI Provider returned {}: {}", status.as_u16(), detail));
    }

    let mut answer = String::new();
    let mut reasoning = String::new();
    let mut usage = Value::Null;
    let mut finish_reason = String::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    let mut saw_done = false;
    let mut final_frames: Vec<Value> = Vec::new();
    let mut pending_answer_delta = String::new();
    let mut pending_reasoning_delta = String::new();
    let mut last_emit = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("AI stream read failed: {err}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if buffer.contains("\r\n") {
            buffer = buffer.replace("\r\n", "\n");
        }
        // 按单个换行切分：不少 OpenAI 兼容代理只用 '\n' 分隔 data: 行，而非规范的空行(\n\n)。
        // 若只找 "\n\n" 会永远不命中 → 一个 delta 都不 emit → 前端误判流式卡死并降级非流式。
        // 每个 data: 行都是独立可解析的 JSON，逐行处理对两种分隔风格都兼容。
        // 末尾未以 '\n' 结束的残缺行留在 buffer，等下个 chunk 补全。
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].to_string();
            buffer = buffer[index + 1..].to_string();
            saw_done = process_ai_stream_frame(
                app,
                session_id,
                &provider,
                &line,
                &mut answer,
                &mut reasoning,
                &mut usage,
                &mut finish_reason,
                &mut final_frames,
                &mut pending_answer_delta,
                &mut pending_reasoning_delta,
                &mut last_emit,
            );
            if saw_done {
                break;
            }
        }
        if saw_done {
            break;
        }
    }

    if !buffer.trim().is_empty() && !saw_done {
        let leftover = buffer.replace("\r\n", "\n");
        for frame in leftover.split('\n') {
            if process_ai_stream_frame(
                app,
                session_id,
                &provider,
                frame,
                &mut answer,
                &mut reasoning,
                &mut usage,
                &mut finish_reason,
                &mut final_frames,
                &mut pending_answer_delta,
                &mut pending_reasoning_delta,
                &mut last_emit,
            ) {
                break;
            }
        }
    }
    flush_ai_stream_deltas(
        app,
        session_id,
        &mut pending_answer_delta,
        &mut pending_reasoning_delta,
        &mut last_emit,
        true,
    );

    if answer.trim().is_empty() {
        for value in final_frames.iter().rev() {
            let parsed = parse_ai_response(&provider, &model, value.clone());
            if !parsed.answer.trim().is_empty() {
                answer = parsed.answer;
                reasoning = if parsed.reasoning_summary.trim().is_empty() {
                    reasoning
                } else {
                    parsed.reasoning_summary
                };
                if usage == Value::Null {
                    usage = parsed.usage;
                }
                if finish_reason.is_empty() {
                    finish_reason = parsed.finish_reason;
                }
                agent_emit(app, session_id, "message_delta", json!({
                    "role": "assistant",
                    "kind": "text",
                    "content": answer.clone()
                }));
                break;
            }
        }
    }

    if answer.trim().is_empty() {
        return Err("stream completed without text".to_string());
    }
    Ok(IdeAiResponse {
        answer,
        reasoning_summary: reasoning.clone(),
        reasoning_raw: reasoning,
        tool_calls: Vec::new(),
        usage,
        finish_reason,
        provider,
        model,
    })
}

enum AgentStreamFrameOutcome {
    Continue,
    Done,
    Tool(Vec<Value>),
}

fn process_agent_stream_frame(
    app: &AppHandle,
    session_id: &str,
    provider: &str,
    frame: &str,
    native_tools: &mut AgentNativeToolAccumulator,
    detector: &mut AgentStreamToolDetector,
    answer: &mut String,
    reasoning: &mut String,
    usage: &mut Value,
    finish_reason: &mut String,
    final_frames: &mut Vec<Value>,
    pending_answer_delta: &mut String,
    pending_reasoning_delta: &mut String,
    last_emit: &mut Instant,
) -> AgentStreamFrameOutcome {
    for line in frame.lines() {
        let line = line.trim();
        let data = if let Some(data) = line.strip_prefix("data:").map(str::trim) {
            data
        } else if line.starts_with('{') {
            line
        } else {
            continue;
        };
        if data == "[DONE]" {
            return AgentStreamFrameOutcome::Done;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        final_frames.push(value.clone());
        if let Some(tool_requests) = native_tools.feed(provider, &value) {
            flush_ai_stream_deltas(app, session_id, pending_answer_delta, pending_reasoning_delta, last_emit, true);
            return AgentStreamFrameOutcome::Tool(tool_requests);
        }
        let (delta, reasoning_delta, next_usage, next_finish) = stream_text_delta(provider, &value);
        if !delta.is_empty() {
            let detection = detector.feed(&delta);
            if !detection.visible_delta.is_empty() {
                answer.push_str(&detection.visible_delta);
                pending_answer_delta.push_str(&detection.visible_delta);
            }
            flush_ai_stream_deltas(app, session_id, pending_answer_delta, pending_reasoning_delta, last_emit, false);
            if let Some(tool_requests) = detection.tool_requests {
                flush_ai_stream_deltas(app, session_id, pending_answer_delta, pending_reasoning_delta, last_emit, true);
                return AgentStreamFrameOutcome::Tool(tool_requests);
            }
        }
        if !reasoning_delta.is_empty() {
            reasoning.push_str(&reasoning_delta);
            pending_reasoning_delta.push_str(&reasoning_delta);
        }
        flush_ai_stream_deltas(app, session_id, pending_answer_delta, pending_reasoning_delta, last_emit, false);
        if next_usage != Value::Null {
            *usage = next_usage;
        }
        if !next_finish.is_empty() {
            *finish_reason = next_finish;
        }
    }
    AgentStreamFrameOutcome::Continue
}

async fn stream_agent_model_turn(
    app: &AppHandle,
    session_id: &str,
    settings: connector::IdeSettings,
    request: IdeAiRequest,
) -> Result<AgentModelTurn, String> {
    let provider = settings.provider_type.trim().to_string();
    let model = provider_model(&settings);
    let url = endpoint_for(&settings)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|err| format!("failed to create agent stream client: {err}"))?;
    let mut payload = build_ai_payload(&settings, &request);
    enable_streaming(&mut payload);
    let response = ai_http_request(&client, &url, &settings, &provider)
        .json(&payload)
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                format!("agent stream request timed out: {url}")
            } else if err.is_connect() {
                format!("Cannot connect to AI Provider: {url}. Please check URL and service status.")
            } else {
                format!("agent stream request failed: {err}")
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
        let detail = parsed
            .get("message")
            .or_else(|| parsed.get("detail"))
            .or_else(|| parsed.get("error"))
            .and_then(|value| value.as_str().or_else(|| value.get("message").and_then(Value::as_str)))
            .unwrap_or(text.as_str());
        return Err(format!("AI Provider returned {}: {}", status.as_u16(), detail));
    }

    let mut answer = String::new();
    let mut reasoning = String::new();
    let mut usage = Value::Null;
    let mut finish_reason = String::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    let mut final_frames: Vec<Value> = Vec::new();
    let mut pending_answer_delta = String::new();
    let mut pending_reasoning_delta = String::new();
    let mut last_emit = Instant::now();
    let mut detector = AgentStreamToolDetector::default();
    let mut native_tools = AgentNativeToolAccumulator::default();
    let mut tool_requests: Vec<Value> = Vec::new();
    let mut saw_done = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("agent stream read failed: {err}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if buffer.contains("\r\n") {
            buffer = buffer.replace("\r\n", "\n");
        }
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].to_string();
            buffer = buffer[index + 1..].to_string();
            match process_agent_stream_frame(
                app,
                session_id,
                &provider,
                &line,
                &mut native_tools,
                &mut detector,
                &mut answer,
                &mut reasoning,
                &mut usage,
                &mut finish_reason,
                &mut final_frames,
                &mut pending_answer_delta,
                &mut pending_reasoning_delta,
                &mut last_emit,
            ) {
                AgentStreamFrameOutcome::Continue => {}
                AgentStreamFrameOutcome::Done => {
                    saw_done = true;
                    break;
                }
                AgentStreamFrameOutcome::Tool(requests) => {
                    tool_requests = requests;
                    break;
                }
            }
        }
        if saw_done || !tool_requests.is_empty() {
            break;
        }
    }

    if !buffer.trim().is_empty() && !saw_done && tool_requests.is_empty() {
        let leftover = buffer.replace("\r\n", "\n");
        for frame in leftover.split('\n') {
            match process_agent_stream_frame(
                app,
                session_id,
                &provider,
                frame,
                &mut native_tools,
                &mut detector,
                &mut answer,
                &mut reasoning,
                &mut usage,
                &mut finish_reason,
                &mut final_frames,
                &mut pending_answer_delta,
                &mut pending_reasoning_delta,
                &mut last_emit,
            ) {
                AgentStreamFrameOutcome::Continue => {}
                AgentStreamFrameOutcome::Done => break,
                AgentStreamFrameOutcome::Tool(requests) => {
                    tool_requests = requests;
                    break;
                }
            }
        }
    }

    if tool_requests.is_empty() {
        let detection = detector.finish();
        if !detection.visible_delta.is_empty() {
            answer.push_str(&detection.visible_delta);
            pending_answer_delta.push_str(&detection.visible_delta);
        }
        if let Some(requests) = detection.tool_requests {
            tool_requests = requests;
        }
    }

    flush_ai_stream_deltas(
        app,
        session_id,
        &mut pending_answer_delta,
        &mut pending_reasoning_delta,
        &mut last_emit,
        true,
    );

    if answer.trim().is_empty() && tool_requests.is_empty() {
        for value in final_frames.iter().rev() {
            let parsed = parse_ai_response(&provider, &model, value.clone());
            if parsed.answer.trim().is_empty() {
                continue;
            }
            let mut fallback_detector = AgentStreamToolDetector::default();
            let detection = fallback_detector.feed(&parsed.answer);
            let finish = fallback_detector.finish();
            let fallback_tools = detection
                .tool_requests
                .or(finish.tool_requests)
                .unwrap_or_default();
            if !fallback_tools.is_empty() {
                tool_requests = fallback_tools;
                break;
            }
            let visible = format!("{}{}", detection.visible_delta, finish.visible_delta);
            if !visible.trim().is_empty() {
                answer = visible;
                reasoning = if parsed.reasoning_summary.trim().is_empty() {
                    reasoning
                } else {
                    parsed.reasoning_summary
                };
                if usage == Value::Null {
                    usage = parsed.usage;
                }
                if finish_reason.is_empty() {
                    finish_reason = parsed.finish_reason;
                }
                agent_emit(app, session_id, "message_delta", json!({
                    "role": "assistant",
                    "kind": "text",
                    "content": answer.clone()
                }));
                break;
            }
        }
    }

    if answer.trim().is_empty() && tool_requests.is_empty() {
        return Err("agent stream completed without text or tool call".to_string());
    }

    let response = IdeAiResponse {
        answer,
        reasoning_summary: reasoning.clone(),
        reasoning_raw: reasoning,
        tool_calls: tool_requests.clone(),
        usage,
        finish_reason,
        provider,
        model,
    };
    Ok(AgentModelTurn {
        response,
        tool_requests,
    })
}

#[tauri::command]
pub async fn ide_ai_request(
    settings: connector::IdeSettings,
    request: IdeAiRequest,
    _stream: Option<bool>,
) -> Result<IdeAiResponse, String> {
    let provider = settings.provider_type.trim().to_string();
    let model = provider_model(&settings);
    let url = endpoint_for(&settings)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| format!("failed to create AI client: {err}"))?;
    let payload = build_ai_payload(&settings, &request);
    let response = ai_http_request(&client, &url, &settings, &provider).json(&payload).send().await.map_err(|err| {
        if err.is_timeout() {
            format!("AI request timed out: {url}")
        } else if err.is_connect() {
            format!("Cannot connect to AI Provider: {url}. Please check URL and service status.")
        } else {
            format!("AI request failed: {err}")
        }
    })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("failed to read AI response: {err}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        let detail = parsed
            .get("message")
            .or_else(|| parsed.get("detail"))
            .or_else(|| parsed.get("error"))
            .and_then(|value| value.as_str().or_else(|| value.get("message").and_then(Value::as_str)))
            .unwrap_or(text.as_str());
        return Err(format!("AI Provider returned {}: {}", status.as_u16(), detail));
    }
    Ok(parse_ai_response(&provider, &model, parsed))
}

#[tauri::command]
pub async fn ide_test_provider(settings: connector::IdeSettings) -> Result<IdeAiResponse, String> {
    ide_ai_request(
        settings,
        IdeAiRequest {
            messages: vec![IdeAiMessage {
                role: "user".to_string(),
                content: "Reply with exactly: ok".to_string(),
            }],
            temperature: Some(0.0),
            max_tokens: Some(128),
        },
        Some(false),
    )
    .await
}

#[tauri::command]
pub async fn ide_list_provider_models(settings: connector::IdeSettings) -> Result<Value, String> {
    let url = if settings.provider_type == "xai-grok" {
        provider_url(&settings, "/v1/language-models")?
    } else {
        provider_url(&settings, "/v1/models")?
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("failed to create model client: {err}"))?;
    let mut request = client.get(&url);
    let key = settings.api_key.trim();
    if !key.is_empty() {
        if settings.provider_type == "anthropic-messages" {
            request = request.header("x-api-key", key).header("anthropic-version", "2023-06-01");
        } else {
            request = request.bearer_auth(key);
        }
    }
    for (name, value) in settings.custom_headers.iter() {
        if !name.trim().is_empty() && !value.trim().is_empty() {
            request = request.header(name.trim(), value.trim());
        }
    }
    let response = request.send().await.map_err(|err| format!("model list request failed: {err}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|err| format!("failed to read model list: {err}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        return Err(format!("model list returned {}: {}", status.as_u16(), text));
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn ide_provider_model_refresh(settings: connector::IdeSettings) -> Result<Value, String> {
    ide_list_provider_models(settings).await
}

#[tauri::command]
pub async fn ide_provider_account_status(settings: connector::IdeSettings) -> Result<Value, String> {
    let path = match settings.provider_type.as_str() {
        "deepseek" => "/user/balance",
        "kimi" => "/v1/users/me/balance",
        "xai-grok" => "/v1/language-models",
        _ => {
            return Ok(json!({
                "supported": false,
                "provider": settings.provider_type,
                "message": "该 Provider 不支持通过当前 Key 查询余额。"
            }))
        }
    };
    let url = provider_url(&settings, path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("failed to create account client: {err}"))?;
    let mut request = client.get(&url);
    let key = settings.api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    for (name, value) in settings.custom_headers.iter() {
        if !name.trim().is_empty() && !value.trim().is_empty() {
            request = request.header(name.trim(), value.trim());
        }
    }
    let response = request.send().await.map_err(|err| format!("account status request failed: {err}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|err| format!("failed to read account status: {err}"))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        return Err(format!("account status returned {}: {}", status.as_u16(), text));
    }
    Ok(json!({
        "supported": true,
        "provider": settings.provider_type,
        "data": parsed
    }))
}

#[tauri::command]
pub fn ide_ai_cancel(_request_id: String) -> Result<(), String> {
    Ok(())
}

fn agent_now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn agent_tool_call(name: &str, input: Value, output: Value, error: Option<String>) -> Value {
    let status = if error.is_some() { "error" } else { "ok" };
    json!({
        "id": format!("tool-{}-{}", name, agent_now()),
        "name": name,
        "status": status,
        "input": input,
        "output": output,
        "error": error.unwrap_or_default(),
        "startedAt": agent_now(),
        "finishedAt": agent_now()
    })
}

fn agent_emit(app: &AppHandle, session_id: &str, event_type: &str, payload: Value) {
    let event_id = {
        let state = app.state::<IdeRuntimeState>();
        state.next_agent_event_id.fetch_add(1, Ordering::SeqCst) + 1
    };
    let event = json!({
        "id": event_id,
        "sessionId": session_id,
        "type": event_type,
        "payload": payload,
        "at": agent_now()
    });
    {
        let state = app.state::<IdeRuntimeState>();
        let mut events = state.agent_events.lock().unwrap();
        events.push(event.clone());
        if events.len() > 1000 {
            let remove_count = events.len().saturating_sub(1000);
            events.drain(0..remove_count);
        }
    }
    let _ = app.emit("ide://agent-event", event);
}

fn agent_session_storage_dir() -> PathBuf {
    ide_data_dir().join("agent-sessions")
}

fn agent_session_snapshot_path(session_id: &str) -> PathBuf {
    let safe = session_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect::<String>();
    agent_session_storage_dir().join(format!("{safe}.json"))
}

fn persist_agent_session_value(session: &Value) {
    if let Some(session_id) = session.get("id").and_then(Value::as_str) {
        let _ = write_json_pretty(&agent_session_snapshot_path(session_id), session);
    }
}

fn load_persisted_agent_sessions(state: &State<'_, IdeRuntimeState>) {
    let dir = agent_session_storage_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut sessions = state.agent_sessions.lock().unwrap();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        sessions.entry(id.to_string()).or_insert(session);
    }
}

fn update_agent_session(app: &AppHandle, session_id: &str, mut update: impl FnMut(&mut Value)) {
    let state = app.state::<IdeRuntimeState>();
    let snapshot = {
        let mut sessions = state.agent_sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        update(session);
        session["updatedAt"] = Value::String(agent_now());
        session.clone()
    };
    persist_agent_session_value(&snapshot);
}

#[allow(dead_code)]
fn agent_emit_tool_result(app: &AppHandle, session_id: &str, call: &Value) {
    agent_emit(app, session_id, "tool_call_start", json!({
        "id": call.get("id").cloned().unwrap_or(Value::Null),
        "name": call.get("name").cloned().unwrap_or(Value::Null),
        "input": call.get("input").cloned().unwrap_or(Value::Null),
        "status": "running"
    }));
    agent_emit(app, session_id, "tool_call_result", call.clone());
    update_agent_session(app, session_id, |session| {
        if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
            items.push(call.clone());
        }
    });
}

fn permission_policy_for_tool(profile_id: &str, tool: &str) -> &'static str {
    if matches!(tool, "read" | "glob" | "grep" | "list_files" | "read_file" | "git_diff" | "terminal_output" | "workspace_context" | "todowrite") {
        return "allow";
    }
    if profile_id.eq_ignore_ascii_case("plan") && matches!(tool, "edit" | "write" | "apply_patch" | "bash") {
        return "deny";
    }
    if matches!(tool, "edit" | "write" | "apply_patch" | "bash") {
        return "ask";
    }
    "ask"
}

fn looks_dangerous_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    [
        "rm -rf",
        "del /f",
        "format ",
        "diskpart",
        "shutdown",
        "reg delete",
        "remove-item -recurse",
        "git reset --hard",
        "git clean -fd",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_safe_auto_approved_bash(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() || looks_dangerous_command(command) {
        return false;
    }
    let lower = command.to_ascii_lowercase();
    if ["&&", "||", ";", "|", ">", "<", "`", "$(", "%comspec%", "\n", "\r"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return false;
    }
    const SAFE_EXACT: &[&str] = &[
        "dir",
        "ls",
        "pwd",
        "git status",
        "git diff",
        "git branch",
        "npm test",
        "npm run test",
        "npm run build",
        "npm run dev",
        "pnpm test",
        "pnpm build",
        "pnpm dev",
        "yarn test",
        "yarn build",
        "yarn dev",
        "cargo test",
        "cargo build",
        "go test",
        "go build",
        "mvn test",
        "gradle test",
    ];
    if SAFE_EXACT.iter().any(|item| lower == *item) {
        return true;
    }
    const SAFE_PREFIXES: &[&str] = &[
        "dir ",
        "ls ",
        "type ",
        "cat ",
        "head ",
        "tail ",
        "echo ",
        "git log",
        "git show",
        "npm run ",
        "npm --prefix ",
        "pnpm ",
        "yarn ",
        "npx vite",
        "node -v",
        "npm -v",
        "pnpm -v",
        "yarn -v",
        "python --version",
        "python -m pytest",
        "pytest",
        "cargo run",
        "go run",
        "where ",
        "which ",
    ];
    SAFE_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
}

fn is_long_running_dev_command(command: &str) -> bool {
    let lower = command.trim().to_ascii_lowercase();
    [
        "npm run dev",
        "npm --prefix ",
        "pnpm dev",
        "yarn dev",
        "bun dev",
        "npx vite",
        "vite",
    ]
    .iter()
    .any(|prefix| {
        if *prefix == "npm --prefix " {
            lower.starts_with(prefix) && (lower.contains(" run dev") || lower.ends_with(" start") || lower.contains(" run start"))
        } else {
            lower == *prefix || lower.starts_with(&format!("{prefix} "))
        }
    })
}

fn infer_npm_script_command(root_path: &str, package_path: &str, preferred: &[&str]) -> Option<String> {
    let file = connector::read_workspace_file(root_path, package_path).ok()?;
    let parsed = serde_json::from_str::<Value>(&file.content).ok()?;
    let scripts = parsed.get("scripts").and_then(Value::as_object)?;
    let script = preferred.iter().copied().find(|name| scripts.contains_key(*name))?;
    let parent = Path::new(package_path)
        .parent()
        .and_then(|path| path.to_str())
        .unwrap_or("")
        .replace('\\', "/");
    if parent.is_empty() {
        if script == "start" {
            Some("npm start".to_string())
        } else {
            Some(format!("npm run {script}"))
        }
    } else if script == "start" {
        Some(format!("npm --prefix {parent} start"))
    } else {
        Some(format!("npm --prefix {parent} run {script}"))
    }
}

fn infer_backend_start_command(root_path: &str) -> Option<String> {
    infer_npm_script_command(root_path, "server/package.json", &["dev", "start", "server", "backend"])
        .or_else(|| infer_npm_script_command(root_path, "backend/package.json", &["dev", "start", "server", "backend"]))
        .or_else(|| infer_npm_script_command(root_path, "api/package.json", &["dev", "start", "server", "backend"]))
        .or_else(|| infer_npm_script_command(root_path, "package.json", &["server", "backend", "dev:server", "dev:backend", "start:server"]))
}

fn extract_direct_agent_command(root_path: &str, message: &str) -> Option<String> {
    let trimmed = message.trim();
    if let Some(command) = trimmed.strip_prefix('!').map(str::trim).filter(|value| !value.is_empty()) {
        return Some(command.to_string());
    }
    let normalized = trimmed
        .replace('：', ":")
        .replace('，', " ")
        .replace('。', " ")
        .replace('\n', " ");
    let lower = normalized.to_ascii_lowercase();
    let wants_execution = [
        "运行",
        "执行",
        "启动",
        "跑一下",
        "去执行",
        "帮我跑",
        "帮我运行",
        "帮我启动",
        "start",
        "run",
        "execute",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !wants_execution {
        return None;
    }
    let known = [
        "npm run dev",
        "npm run build",
        "npm run test",
        "npm test",
        "pnpm dev",
        "pnpm build",
        "pnpm test",
        "yarn dev",
        "yarn build",
        "yarn test",
        "cargo test",
        "cargo build",
        "go test",
        "go build",
        "python --version",
        "node -v",
        "git status",
    ];
    for command in known {
        if lower.contains(command) {
            return Some(command.to_string());
        }
    }
    if lower.contains("后端") || lower.contains("backend") || lower.contains("server") {
        if let Some(command) = infer_backend_start_command(root_path) {
            return Some(command);
        }
    }
    if lower.contains("开发测试") || lower.contains("dev server") || lower.contains("开发服务") {
        return Some("npm run dev".to_string());
    }
    None
}

fn spawn_agent_background_command(root_path: &str, command: &str) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(root_path)?;
    let shell_root = shell_path(&root);
    let mut process = if cfg!(windows) {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg("-lc").arg(command);
        cmd
    };
    process
        .current_dir(&shell_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let child = process
        .spawn()
        .map_err(|err| format!("failed to start background command: {err}"))?;
    Ok(json!({
        "command": command,
        "cwd": shell_root.to_string_lossy(),
        "ok": true,
        "background": true,
        "pid": child.id(),
        "message": "开发服务已在后台启动；如需查看实时输出，请在内置终端运行同一命令。"
    }))
}

fn extract_patch_preview(answer: &str) -> Option<Value> {
    let mut patch = String::new();
    let mut in_fence = false;
    for line in answer.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            let lang = trimmed.trim_matches('`').trim().to_ascii_lowercase();
            if !in_fence && (lang.contains("diff") || lang.contains("patch")) {
                in_fence = true;
                continue;
            }
            if in_fence {
                break;
            }
        }
        if in_fence {
            patch.push_str(line);
            patch.push('\n');
        }
    }
    if patch.trim().is_empty() && (answer.contains("\n+++ ") || answer.contains("\n--- ")) {
        patch = answer.to_string();
    }
    if patch.trim().is_empty() {
        return None;
    }
    Some(json!({
        "id": format!("patch-{}", agent_now()),
        "patch": patch,
        "requiresApproval": true,
        "files": []
    }))
}

fn extract_agent_tool_requests(answer: &str) -> Vec<Value> {
    let mut candidates = Vec::new();
    let trimmed = answer.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        candidates.push(trimmed.to_string());
    }
    let mut in_fence = false;
    let mut fence_lang = String::new();
    let mut buffer = String::new();
    for line in answer.lines() {
        let trimmed_line = line.trim_start();
        if trimmed_line.starts_with("```") {
            if in_fence {
                if fence_lang.contains("json") || fence_lang.contains("tool") || fence_lang.contains("agent") {
                    candidates.push(buffer.clone());
                }
                in_fence = false;
                fence_lang.clear();
                buffer.clear();
            } else {
                fence_lang = trimmed_line.trim_matches('`').trim().to_ascii_lowercase();
                in_fence = true;
            }
            continue;
        }
        if in_fence {
            buffer.push_str(line);
            buffer.push('\n');
        }
    }
    candidates
        .into_iter()
        .flat_map(|candidate| parse_agent_tool_candidate(&candidate))
        .collect()
}

fn extract_agent_final_answer(answer: &str) -> Option<String> {
    let trimmed = answer.trim();
    if let Some(AgentParsedStep::Final(content)) = parse_agent_step_candidate(trimmed) {
        return Some(content);
    }
    let mut in_fence = false;
    let mut fence_lang = String::new();
    let mut buffer = String::new();
    for line in answer.lines() {
        let trimmed_line = line.trim_start();
        if trimmed_line.starts_with("```") {
            if in_fence {
                if fence_lang.contains("json") || fence_lang.contains("agent") {
                    if let Some(AgentParsedStep::Final(content)) = parse_agent_step_candidate(&buffer) {
                        return Some(content);
                    }
                }
                in_fence = false;
                fence_lang.clear();
                buffer.clear();
            } else {
                fence_lang = trimmed_line.trim_matches('`').trim().to_ascii_lowercase();
                in_fence = true;
            }
            continue;
        }
        if in_fence {
            buffer.push_str(line);
            buffer.push('\n');
        }
    }
    None
}

fn parse_agent_tool_candidate(candidate: &str) -> Vec<Value> {
    match parse_agent_step_candidate(candidate) {
        Some(AgentParsedStep::Tool(tools)) => tools,
        _ => Vec::new(),
    }
}

fn parse_agent_step_candidate(candidate: &str) -> Option<AgentParsedStep> {
    let value = serde_json::from_str::<Value>(candidate).ok()?;
    if let Some(step) = value.get("action").or_else(|| value.get("type")).and_then(Value::as_str) {
        let step = step.trim().to_ascii_lowercase();
        if matches!(step.as_str(), "final" | "final_answer" | "answer" | "message") {
            let content = value
                .get("content")
                .or_else(|| value.get("answer"))
                .or_else(|| value.get("message"))
                .map(collect_text)
                .unwrap_or_default();
            if !content.trim().is_empty() {
                return Some(AgentParsedStep::Final(content));
            }
        }
        if matches!(step.as_str(), "tool" | "tool_call" | "tool_calls" | "call") {
            if let Some(items) = value.get("tools").or_else(|| value.get("tool_calls")).and_then(Value::as_array) {
                let tools = items
                    .iter()
                    .cloned()
                    .flat_map(agent_tool_requests_from_value)
                    .collect::<Vec<_>>();
                if !tools.is_empty() {
                    return Some(AgentParsedStep::Tool(tools));
                }
            }
            let tool_name = value
                .get("tool")
                .or_else(|| value.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !tool_name.trim().is_empty() {
                let mut input = tool_input(&value);
                if let Some(raw) = input.as_str() {
                    input = parse_native_tool_arguments(raw);
                }
                if input.as_object().map(|object| object.is_empty()).unwrap_or(false) {
                    if let Some(command) = value.get("command").and_then(Value::as_str) {
                        input = json!({ "command": command });
                    } else if let Some(path) = value.get("path").and_then(Value::as_str) {
                        input = json!({ "path": path });
                    } else if let Some(query) = value.get("query").and_then(Value::as_str) {
                        input = json!({ "query": query });
                    }
                }
                return Some(AgentParsedStep::Tool(vec![json!({
                    "tool": tool_name,
                    "input": input,
                    "source": "agent_step"
                })]));
            }
        }
    }
    let tools = agent_tool_requests_from_value(value);
    if tools.is_empty() {
        None
    } else {
        Some(AgentParsedStep::Tool(tools))
    }
}

fn shell_fence_tool_request(lang: &str, content: &str) -> Option<Value> {
    let lang = lang.trim().to_ascii_lowercase();
    let is_shell = matches!(
        lang.as_str(),
        "bash" | "sh" | "shell" | "cmd" | "bat" | "powershell" | "ps1" | "pwsh"
    );
    if !is_shell {
        return None;
    }
    let command = content.trim();
    if command.is_empty() {
        return None;
    }
    Some(json!({
        "tool": "bash",
        "input": { "command": command },
        "source": "fenced_shell_block"
    }))
}

fn agent_tool_requests_from_value(value: Value) -> Vec<Value> {
    let items = if let Some(items) = value.as_array() {
        items.clone()
    } else if let Some(items) = value.get("tools").and_then(Value::as_array) {
        items.clone()
    } else if let Some(items) = value.get("tool_calls").and_then(Value::as_array) {
        items.clone()
    } else {
        vec![value]
    };
    items
        .into_iter()
        .filter(|value| {
            value.get("tool").and_then(Value::as_str).is_some()
                || value.get("name").and_then(Value::as_str).is_some()
        })
        .collect()
}

fn is_complete_json_value(text: &str) -> bool {
    let mut depth = 0i32;
    let mut started = false;
    let mut in_string = false;
    let mut escape = false;
    for ch in text.trim_start().chars() {
        if !started {
            if ch == '{' || ch == '[' {
                started = true;
                depth = 1;
            } else if ch.is_whitespace() {
                continue;
            } else {
                return false;
            }
            continue;
        }
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

impl Default for AgentStreamToolDetector {
    fn default() -> Self {
        Self {
            mode: AgentToolDetectorMode::Text,
            pending: String::new(),
            visible_started: false,
            line_start: true,
        }
    }
}

impl AgentStreamToolDetector {
    fn feed(&mut self, delta: &str) -> AgentToolDetection {
        self.pending.push_str(delta);
        self.drain(false)
    }

    fn finish(&mut self) -> AgentToolDetection {
        self.drain(true)
    }

    fn mark_visible(&mut self, visible: &str) {
        if !visible.trim().is_empty() {
            self.visible_started = true;
        }
        if !visible.is_empty() {
            self.line_start = visible.ends_with('\n') || visible.ends_with('\r');
        }
    }

    fn drain(&mut self, force: bool) -> AgentToolDetection {
        let mut visible_delta = String::new();
        loop {
            match &mut self.mode {
                AgentToolDetectorMode::Text => {
                    if !self.visible_started || self.line_start {
                        let trimmed = self.pending.trim_start();
                        if trimmed.starts_with('{') || trimmed.starts_with('[') {
                            let leading = self.pending.len().saturating_sub(trimmed.len());
                            let prefix = self.pending[..leading].to_string();
                            if !prefix.is_empty() {
                                self.mark_visible(&prefix);
                                visible_delta.push_str(&prefix);
                            }
                            let content = self.pending[leading..].to_string();
                            self.pending.clear();
                            self.mode = AgentToolDetectorMode::RawJson { content };
                            continue;
                        }
                    }

                    let Some(index) = self.pending.find("```") else {
                        let keep = if force {
                            0
                        } else {
                            self.pending
                                .chars()
                                .rev()
                                .take_while(|ch| *ch == '`')
                                .count()
                                .min(2)
                        };
                        let emit_len = self.pending.len().saturating_sub(keep);
                        if emit_len > 0 {
                            let text = self.pending[..emit_len].to_string();
                            self.pending = self.pending[emit_len..].to_string();
                            self.mark_visible(&text);
                            visible_delta.push_str(&text);
                        }
                        break;
                    };

                    if index > 0 {
                        let text = self.pending[..index].to_string();
                        self.mark_visible(&text);
                        visible_delta.push_str(&text);
                    }
                    let rest = self.pending[index + 3..].to_string();
                    let Some(line_end) = rest.find('\n') else {
                        self.pending = format!("```{rest}");
                        break;
                    };
                    let lang = rest[..line_end].trim().to_ascii_lowercase();
                    let original_lang = rest[..line_end].to_string();
                    self.pending = rest[line_end + 1..].to_string();
                    if lang.contains("tool")
                        || lang.contains("agent")
                        || lang.contains("json")
                        || matches!(
                            lang.as_str(),
                            "bash" | "sh" | "shell" | "cmd" | "bat" | "powershell" | "ps1" | "pwsh"
                        )
                    {
                        self.mode = AgentToolDetectorMode::Fence {
                            lang: original_lang,
                            content: String::new(),
                        };
                    } else {
                        let text = format!("```{original_lang}\n");
                        self.mark_visible(&text);
                        visible_delta.push_str(&text);
                    }
                }
                AgentToolDetectorMode::Fence { lang, content } => {
                    if let Some(index) = self.pending.find("```") {
                        content.push_str(&self.pending[..index]);
                        let rest = self.pending[index + 3..].to_string();
                        if let Some(step) = parse_agent_step_candidate(content) {
                            self.pending.clear();
                            match step {
                                AgentParsedStep::Tool(tool_requests) => {
                                    return AgentToolDetection {
                                        visible_delta,
                                        tool_requests: Some(tool_requests),
                                    };
                                }
                                AgentParsedStep::Final(content) => {
                                    self.mark_visible(&content);
                                    visible_delta.push_str(&content);
                                    return AgentToolDetection {
                                        visible_delta,
                                        tool_requests: None,
                                    };
                                }
                            }
                        }
                        if let Some(request) = shell_fence_tool_request(lang, content) {
                            self.pending.clear();
                            return AgentToolDetection {
                                visible_delta,
                                tool_requests: Some(vec![request]),
                            };
                        }
                        let text = format!("```{lang}\n{content}```");
                        self.mark_visible(&text);
                        visible_delta.push_str(&text);
                        self.pending = rest;
                        self.mode = AgentToolDetectorMode::Text;
                    } else {
                        content.push_str(&self.pending);
                        self.pending.clear();
                        if force {
                            let text = format!("```{lang}\n{content}");
                            self.mark_visible(&text);
                            visible_delta.push_str(&text);
                            self.mode = AgentToolDetectorMode::Text;
                        }
                        break;
                    }
                }
                AgentToolDetectorMode::RawJson { content } => {
                    content.push_str(&self.pending);
                    self.pending.clear();
                    if is_complete_json_value(content) {
                        if let Some(step) = parse_agent_step_candidate(content) {
                            match step {
                                AgentParsedStep::Tool(tool_requests) => {
                                    return AgentToolDetection {
                                        visible_delta,
                                        tool_requests: Some(tool_requests),
                                    };
                                }
                                AgentParsedStep::Final(content) => {
                                    self.mark_visible(&content);
                                    visible_delta.push_str(&content);
                                    self.mode = AgentToolDetectorMode::Text;
                                    return AgentToolDetection {
                                        visible_delta,
                                        tool_requests: None,
                                    };
                                }
                            }
                        }
                        let text = content.clone();
                        self.mark_visible(&text);
                        visible_delta.push_str(&text);
                        self.mode = AgentToolDetectorMode::Text;
                    } else if force {
                        let text = content.clone();
                        self.mark_visible(&text);
                        visible_delta.push_str(&text);
                        self.mode = AgentToolDetectorMode::Text;
                    }
                    break;
                }
            }
        }
        AgentToolDetection {
            visible_delta,
            tool_requests: None,
        }
    }
}

#[cfg(test)]
mod agent_stream_tool_detector_tests {
    use super::*;

    #[test]
    fn streams_plain_markdown_as_visible_text() {
        let mut detector = AgentStreamToolDetector::default();
        let first = detector.feed("先读取项目");
        let second = detector.feed("再总结。");
        let end = detector.finish();
        assert_eq!(format!("{}{}{}", first.visible_delta, second.visible_delta, end.visible_delta), "先读取项目再总结。");
        assert!(first.tool_requests.is_none());
        assert!(second.tool_requests.is_none());
        assert!(end.tool_requests.is_none());
    }

    #[test]
    fn detects_chunked_fenced_tool_without_visible_json() {
        let mut detector = AgentStreamToolDetector::default();
        let first = detector.feed("```tool\n{\"tool\":\"read");
        let second = detector.feed("_file\",\"input\":{\"path\":\"vite.config.ts\"}}\n```");
        assert_eq!(first.visible_delta, "");
        assert_eq!(second.visible_delta, "");
        let tools = second.tool_requests.expect("tool request should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("read_file"));
    }

    #[test]
    fn detects_raw_json_tool_at_message_start() {
        let mut detector = AgentStreamToolDetector::default();
        let first = detector.feed("{\"tool\":\"glob\",");
        let second = detector.feed("\"input\":{\"pattern\":\"**/*.ts\"}}");
        assert_eq!(first.visible_delta, "");
        let tools = second.tool_requests.expect("raw JSON tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("glob"));
    }

    #[test]
    fn preserves_visible_text_before_tool_call() {
        let mut detector = AgentStreamToolDetector::default();
        let result = detector.feed("我先读取配置。\n```tool\n{\"tool\":\"read_file\",\"input\":{\"path\":\"package.json\"}}\n```");
        assert_eq!(result.visible_delta, "我先读取配置。\n");
        let tools = result.tool_requests.expect("tool request should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("read_file"));
    }

    #[test]
    fn detects_raw_json_tool_after_visible_line() {
        let mut detector = AgentStreamToolDetector::default();
        let first = detector.feed("好的，我先读取文件。\n");
        let second = detector.feed("{\"tool\":\"read_file\",\"input\":{\"path\":\"server/index.js\"}}");
        assert_eq!(first.visible_delta, "好的，我先读取文件。\n");
        assert_eq!(second.visible_delta, "");
        let tools = second.tool_requests.expect("line-start raw JSON tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("read_file"));
    }

    #[test]
    fn detects_shell_fence_as_bash_tool() {
        let mut detector = AgentStreamToolDetector::default();
        let first = detector.feed("我来启动服务。\n```bash\ncat server/package.json\n```");
        assert_eq!(first.visible_delta, "我来启动服务。\n");
        let tools = first.tool_requests.expect("shell fence should become bash tool");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("bash"));
        assert_eq!(tools[0].pointer("/input/command").and_then(Value::as_str), Some("cat server/package.json"));
    }

    #[test]
    fn allows_inferred_npm_prefix_dev_command() {
        assert!(is_safe_auto_approved_bash("npm --prefix server run dev"));
        assert!(is_long_running_dev_command("npm --prefix server run dev"));
        assert!(!is_safe_auto_approved_bash("npm --prefix server run dev && del /f package.json"));
    }

    #[test]
    fn detects_structured_agent_step_tool() {
        let mut detector = AgentStreamToolDetector::default();
        let result = detector.feed("{\"action\":\"tool\",\"tool\":\"bash\",\"input\":{\"command\":\"npm run build\"}}");
        assert_eq!(result.visible_delta, "");
        let tools = result.tool_requests.expect("structured step tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("bash"));
        assert_eq!(tools[0].pointer("/input/command").and_then(Value::as_str), Some("npm run build"));
    }

    #[test]
    fn unwraps_structured_agent_step_final() {
        let mut detector = AgentStreamToolDetector::default();
        let result = detector.feed("{\"action\":\"final\",\"content\":\"后端已启动。\"}");
        assert_eq!(result.visible_delta, "后端已启动。");
        assert!(result.tool_requests.is_none());
        assert_eq!(extract_agent_final_answer("{\"action\":\"final\",\"content\":\"完成\"}"), Some("完成".to_string()));
    }

    #[test]
    fn detects_openai_responses_native_tool_call() {
        let mut native = AgentNativeToolAccumulator::default();
        assert!(native.feed("openai-responses", &json!({
            "type": "response.output_item.added",
            "item": { "type": "function_call", "id": "fc_1", "name": "read_file" }
        })).is_none());
        assert!(native.feed("openai-responses", &json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "{\"path\":\"vite.config.ts\"}"
        })).is_none());
        let tools = native.feed("openai-responses", &json!({
            "type": "response.function_call_arguments.done",
            "item_id": "fc_1",
            "arguments": "{\"path\":\"vite.config.ts\"}"
        })).expect("OpenAI Responses native tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("read_file"));
        assert_eq!(tools[0].pointer("/input/path").and_then(Value::as_str), Some("vite.config.ts"));
    }

    #[test]
    fn detects_openai_chat_native_tool_call() {
        let mut native = AgentNativeToolAccumulator::default();
        assert!(native.feed("openai-chat", &json!({
            "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "grep", "arguments": "{\"query\":\"TODO\"}" } }] } }]
        })).is_none());
        let tools = native.feed("openai-chat", &json!({
            "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
        })).expect("OpenAI Chat native tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("grep"));
        assert_eq!(tools[0].pointer("/input/query").and_then(Value::as_str), Some("TODO"));
    }

    #[test]
    fn detects_anthropic_native_tool_call() {
        let mut native = AgentNativeToolAccumulator::default();
        assert!(native.feed("anthropic-messages", &json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "toolu_1", "name": "glob", "input": {} }
        })).is_none());
        assert!(native.feed("anthropic-messages", &json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"pattern\":\"**/*.rs\"}" }
        })).is_none());
        let tools = native.feed("anthropic-messages", &json!({
            "type": "content_block_stop",
            "index": 1
        })).expect("Claude native tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("glob"));
        assert_eq!(tools[0].pointer("/input/pattern").and_then(Value::as_str), Some("**/*.rs"));
    }
}

fn normalize_agent_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "read" | "read_file" | "local_read_text_file" => "read_file".to_string(),
        "grep" | "search" | "search_code" => "grep".to_string(),
        "glob" | "list" | "list_files" => "glob".to_string(),
        "write" | "write_file" | "edit" => "write".to_string(),
        "patch" | "apply_patch" => "apply_patch".to_string(),
        "bash" | "run_command" | "shell" => "bash".to_string(),
        "git_diff" | "diff" => "git_diff".to_string(),
        "todo" | "todowrite" => "todowrite".to_string(),
        "question" | "ask" => "question".to_string(),
        other => other.to_string(),
    }
}

fn tool_input(value: &Value) -> Value {
    value
        .get("input")
        .or_else(|| value.get("args"))
        .or_else(|| value.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn agent_tool_requires_approval(profile_id: &str, tool: &str, input: &Value) -> (&'static str, &'static str) {
    if tool == "bash" {
        let command = input
            .get("command")
            .or_else(|| input.get("cmd"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if looks_dangerous_command(command) {
            return ("deny", "high");
        }
        if !profile_id.eq_ignore_ascii_case("plan") && is_safe_auto_approved_bash(command) {
            return ("allow", "low");
        }
    }
    let decision = permission_policy_for_tool(profile_id, tool);
    let risk = if decision == "deny" { "high" } else if matches!(tool, "bash" | "write" | "apply_patch") { "medium" } else { "low" };
    (decision, risk)
}

fn execute_agent_tool(root_path: &str, tool: &str, input: &Value) -> Result<Value, String> {
    match tool {
        "read_file" => {
            let path = input
                .get("path")
                .or_else(|| input.get("file"))
                .and_then(Value::as_str)
                .ok_or_else(|| "read_file requires path".to_string())?;
            let file = connector::read_workspace_file(root_path, path)?;
            Ok(json!({
                "path": file.path,
                "encoding": file.encoding,
                "lineEnding": file.line_ending,
                "size": file.size,
                "content": file.content.chars().take(24000).collect::<String>()
            }))
        }
        "glob" => {
            let path = input.get("path").and_then(Value::as_str).unwrap_or("");
            let depth = input.get("maxDepth").or_else(|| input.get("depth")).and_then(Value::as_u64).unwrap_or(4) as usize;
            let tree = connector::list_workspace_tree(root_path, path, depth)?;
            let mut lines = Vec::new();
            summarize_workspace_entries(&tree, 0, &mut lines, 300);
            Ok(json!({ "path": path, "count": lines.len(), "entries": lines, "tree": tree }))
        }
        "grep" => {
            let query = input
                .get("query")
                .or_else(|| input.get("pattern"))
                .and_then(Value::as_str)
                .ok_or_else(|| "grep requires query".to_string())?;
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(80) as usize;
            let results = connector::search_workspace(root_path, query, true, limit)?;
            Ok(json!({ "query": query, "count": results.len(), "results": results }))
        }
        "git_diff" => {
            let git = connector::read_workspace_git_status(root_path)?;
            Ok(json!({
                "branch": git.branch,
                "staged": git.staged_count,
                "unstaged": git.unstaged_count,
                "untracked": git.untracked_count,
                "diff": git.diff
            }))
        }
        "todowrite" => Ok(json!({
            "items": input.get("items").cloned().unwrap_or_else(|| json!([])),
            "summary": "todo updated"
        })),
        "question" => Ok(json!({
            "question": input.get("question").or_else(|| input.get("prompt")).cloned().unwrap_or(Value::String("需要用户补充信息。".to_string())),
            "requiresUserResponse": true
        })),
        "bash" => {
            let command = input
                .get("command")
                .or_else(|| input.get("cmd"))
                .and_then(Value::as_str)
                .ok_or_else(|| "bash requires command".to_string())?;
            if is_long_running_dev_command(command) {
                return spawn_agent_background_command(root_path, command);
            }
            let timeout = input.get("timeoutSecs").or_else(|| input.get("timeout")).and_then(Value::as_u64).unwrap_or(120);
            let result = connector::run_workspace_command(root_path, command, Some(timeout))?;
            Ok(json!({
                "command": result.command,
                "cwd": result.cwd,
                "ok": result.ok,
                "exitCode": result.exit_code,
                "output": result.output,
                "truncated": result.truncated
            }))
        }
        "write" => {
            let path = input
                .get("path")
                .or_else(|| input.get("file"))
                .and_then(Value::as_str)
                .ok_or_else(|| "write requires path".to_string())?;
            let content = input
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "write requires content".to_string())?;
            let saved = connector::save_workspace_file(root_path, path, content, None, None)?;
            Ok(json!({ "path": saved.path, "size": saved.size, "modifiedAt": saved.modified_at }))
        }
        "apply_patch" => {
            let patch = input
                .get("patch")
                .or_else(|| input.get("diff"))
                .and_then(Value::as_str)
                .ok_or_else(|| "apply_patch requires patch".to_string())?;
            apply_agent_patch(root_path, patch)
        }
        other => Err(format!("unsupported agent tool: {other}")),
    }
}

fn apply_agent_patch(root_path: &str, patch: &str) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(root_path)?;
    if patch.trim().is_empty() {
        return Err("patch cannot be empty".to_string());
    }
    let mut child = Command::new("git")
        .arg("apply")
        .arg("--whitespace=nowarn")
        .current_dir(shell_path(&root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to start git apply: {err}"))?;
    {
        let stdin = child.stdin.as_mut().ok_or_else(|| "failed to open git apply stdin".to_string())?;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|err| format!("failed to send patch to git apply: {err}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("failed to wait for git apply: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("git apply failed: {stderr}{stdout}"));
    }
    Ok(json!({ "message": "patch applied", "stdout": stdout, "stderr": stderr }))
}

fn summarize_workspace_entries(items: &[connector::WorkspaceEntry], level: usize, lines: &mut Vec<String>, limit: usize) {
    if lines.len() >= limit {
        return;
    }
    for item in items {
        if lines.len() >= limit {
            break;
        }
        let indent = "  ".repeat(level);
        let suffix = if item.kind == "dir" { "/" } else { "" };
        lines.push(format!("{indent}{}{suffix}", item.path));
        if item.kind == "dir" {
            summarize_workspace_entries(&item.children, level + 1, lines, limit);
        }
    }
}

fn emit_agent_tool_execution(
    app: &AppHandle,
    session_id: &str,
    root_path: &str,
    tool: &str,
    input: Value,
) -> Value {
    let tool_call_id = format!("tool-{tool}-{}", agent_now());
    agent_emit(app, session_id, "tool_call_start", json!({
        "id": tool_call_id,
        "name": tool,
        "input": input,
        "status": "running"
    }));
    let mut call = match execute_agent_tool(root_path, tool, &input) {
        Ok(output) => agent_tool_call(tool, input.clone(), output, None),
        Err(err) => agent_tool_call(tool, input.clone(), json!({}), Some(err)),
    };
    if let Some(obj) = call.as_object_mut() {
        obj.insert("id".to_string(), Value::String(tool_call_id));
    }
    agent_emit(app, session_id, "tool_call_result", call.clone());
    update_agent_session(app, session_id, |session| {
        if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
            items.push(call.clone());
        }
    });
    call
}

fn handle_direct_agent_command(
    app: &AppHandle,
    session_id: &str,
    root_path: &str,
    profile_id: &str,
    command: &str,
) -> Result<Value, String> {
    let input = json!({ "command": command });
    let (decision, risk) = agent_tool_requires_approval(profile_id, "bash", &input);
    let tool_call_id = format!("tool-bash-{}", agent_now());
    if decision == "deny" {
        agent_emit(app, session_id, "permission_request", json!({
            "id": tool_call_id,
            "kind": "command",
            "target": command,
            "reason": "该命令命中危险命令策略，已阻止执行。",
            "risk": risk,
            "decision": "deny"
        }));
        agent_emit(app, session_id, "message_delta", json!({
            "role": "assistant",
            "kind": "text",
            "content": format!("命令 `{command}` 命中危险命令策略，已阻止执行。")
        }));
        return Ok(json!({
            "ok": false,
            "requiresApproval": false,
            "error": "permission denied by policy"
        }));
    }
    if decision == "ask" {
        update_agent_session(app, session_id, |session| {
            if let Some(items) = session.get_mut("pendingTools").and_then(Value::as_array_mut) {
                items.push(json!({ "id": tool_call_id, "tool": "bash", "input": input, "createdAt": agent_now() }));
            } else {
                session["pendingTools"] = json!([{ "id": tool_call_id, "tool": "bash", "input": input, "createdAt": agent_now() }]);
            }
        });
        agent_emit(app, session_id, "permission_request", json!({
            "id": tool_call_id,
            "kind": "command",
            "target": command,
            "reason": "Agent 请求执行工作区命令，需要用户确认。",
            "risk": risk,
            "decision": "ask"
        }));
        agent_emit(app, session_id, "message_delta", json!({
            "role": "assistant",
            "kind": "text",
            "content": format!("需要确认后执行 `{command}`。")
        }));
        return Ok(json!({
            "ok": true,
            "requiresApproval": true,
            "message": "waiting for command approval"
        }));
    }

    let call = emit_agent_tool_execution(app, session_id, root_path, "bash", input);
    let ok = call.get("status").and_then(Value::as_str).unwrap_or("ok") != "error";
    let output = call
        .pointer("/output/output")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let background = call.pointer("/output/background").and_then(Value::as_bool).unwrap_or(false);
    let summary = if background {
        let pid = call.pointer("/output/pid").and_then(Value::as_u64).map(|value| value.to_string()).unwrap_or_else(|| "-".to_string());
        format!("已启动 `{command}`，进程 PID：{pid}。")
    } else if ok {
        format!(
            "`{command}` 执行完成。\n\n{}",
            if output.is_empty() { "命令没有输出。".to_string() } else { output.chars().take(6000).collect::<String>() }
        )
    } else {
        format!(
            "`{command}` 执行失败。\n\n{}",
            if output.is_empty() { call.get("error").and_then(Value::as_str).unwrap_or("未知错误").to_string() } else { output.chars().take(6000).collect::<String>() }
        )
    };
    agent_emit(app, session_id, "message_delta", json!({
        "role": "assistant",
        "kind": "text",
        "content": summary
    }));
    Ok(json!({
        "ok": ok,
        "requiresApproval": false,
        "response": {
            "answer": summary,
            "toolCalls": [call]
        }
    }))
}

fn read_agent_file(
    root_path: &str,
    path: &str,
    max_chars: usize,
    record_missing: bool,
    tool_calls: &mut Vec<Value>,
    context: &mut Vec<String>,
) {
    match connector::read_workspace_file(root_path, path) {
        Ok(file) => {
            let mut content = file.content;
            if content.len() > max_chars {
                content.truncate(max_chars);
                content.push_str("\n...[truncated]");
            }
            context.push(format!("[file:{}]\n{}", file.path, content));
            tool_calls.push(agent_tool_call(
                "read_file",
                json!({ "path": path }),
                json!({ "path": file.path, "size": file.size, "summary": format!("读取 {}", path) }),
                None,
            ));
        }
        Err(err) => {
            if !record_missing
                && (err.contains("failed to inspect file")
                    || err.contains("path is not accessible")
                    || err.contains("os error 2")
                    || err.contains("target is a directory"))
            {
                return;
            }
            tool_calls.push(agent_tool_call(
                "read_file",
                json!({ "path": path }),
                json!({ "path": path }),
                Some(err),
            ));
        }
    }
}

fn collect_agent_context(root_path: &str, workspace_context: &Value) -> (String, Vec<Value>) {
    let mut tool_calls = Vec::new();
    let mut context = Vec::new();
    context.push(format!("[workspace]\nroot={root_path}"));

    match connector::list_workspace_tree(root_path, "", 3) {
        Ok(tree) => {
            let mut lines = Vec::new();
            summarize_workspace_entries(&tree, 0, &mut lines, 180);
            context.push(format!("[directory_tree]\n{}", lines.join("\n")));
            tool_calls.push(agent_tool_call(
                "list_files",
                json!({ "path": "", "maxDepth": 3 }),
                json!({ "count": lines.len(), "summary": "扫描工作区目录" }),
                None,
            ));
        }
        Err(err) => {
            tool_calls.push(agent_tool_call(
                "list_files",
                json!({ "path": "", "maxDepth": 3 }),
                json!({}),
                Some(err),
            ));
        }
    }

    let mut candidates = vec![
        "README.md",
        "README",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "requirements.txt",
        "vite.config.ts",
        "vite.config.js",
        "next.config.js",
        "tsconfig.json",
        "tailwind.config.ts",
        "docker-compose.yml",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    if let Some(open_file) = workspace_context.get("openFile").and_then(Value::as_str) {
        if !open_file.trim().is_empty() && !candidates.iter().any(|item| item == open_file) {
            candidates.push(open_file.to_string());
        }
    }
    for path in candidates {
        let record_missing = workspace_context
            .get("openFile")
            .and_then(Value::as_str)
            .map(|open_file| open_file == path)
            .unwrap_or(false);
        read_agent_file(root_path, &path, 14000, record_missing, &mut tool_calls, &mut context);
    }

    if let Some(selected) = workspace_context.get("selectedText").and_then(Value::as_str) {
        if !selected.trim().is_empty() {
            context.push(format!("[selected_text]\n{}", selected.chars().take(8000).collect::<String>()));
            tool_calls.push(agent_tool_call(
                "workspace_context",
                json!({ "kind": "selection" }),
                json!({ "summary": "加入编辑器选区上下文" }),
                None,
            ));
        }
    }
    if let Some(chips) = workspace_context.get("contextRefs").and_then(Value::as_array) {
        if !chips.is_empty() {
            context.push(format!("[explicit_context_refs]\n{}", Value::Array(chips.clone())));
            tool_calls.push(agent_tool_call(
                "workspace_context",
                json!({ "kind": "contextRefs" }),
                json!({ "count": chips.len(), "summary": "加入用户显式引用上下文" }),
                None,
            ));
        }
    }
    if let Some(output) = workspace_context.get("terminalOutput").and_then(Value::as_str) {
        if !output.trim().is_empty() {
            let mut recent = output.to_string();
            if recent.len() > 8000 {
                recent = recent.chars().rev().take(8000).collect::<Vec<_>>().into_iter().rev().collect::<String>();
            }
            context.push(format!("[recent_terminal_output]\n{recent}"));
            tool_calls.push(agent_tool_call(
                "terminal_output",
                json!({ "tail": 8000 }),
                json!({ "summary": "读取最近终端输出" }),
                None,
            ));
        }
    }
    match connector::read_workspace_git_status(root_path) {
        Ok(git) => {
            context.push(format!(
                "[git]\nbranch={}\nstaged={}\nunstaged={}\nuntracked={}\n\n{}",
                git.branch, git.staged_count, git.unstaged_count, git.untracked_count, git.diff
            ));
            tool_calls.push(agent_tool_call(
                "git_diff",
                json!({}),
                json!({ "summary": format!("{} staged / {} unstaged / {} untracked", git.staged_count, git.unstaged_count, git.untracked_count) }),
                None,
            ));
        }
        Err(err) => {
            tool_calls.push(agent_tool_call("git_diff", json!({}), json!({}), Some(err)));
        }
    }
    (context.join("\n\n---\n\n"), tool_calls)
}

fn build_agent_ai_request(
    request: Value,
    workspace_context: Value,
) -> Result<(IdeAiRequest, String, Vec<Value>), String> {
    let mut ai_request = serde_json::from_value::<IdeAiRequest>(request.clone()).unwrap_or_default();
    let root_path = workspace_context
        .get("root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "agent workspace root is required".to_string())?;
    connector::resolve_authorized_root(root_path)?;
    let (local_context, tool_calls) = collect_agent_context(root_path, &workspace_context);
    let prompt = ai_request
        .messages
        .iter()
        .rev()
        .find(|message| message.role != "system")
        .map(|message| message.content.clone())
        .or_else(|| request.get("prompt").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "请基于当前工作区继续开发。".to_string());
    let user_system = ai_request
        .messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let agent_system = format!(
        "{}\n\n{}",
        user_system,
        "你是 AutoCode 本地 IDE 的 coding agent。必须像本地开发助手一样行动：能通过工具完成的事就调用工具，不要把命令丢给用户手动执行；不要反复扫描已经给出的基础上下文；直接命令类请求优先调用 bash 工具。\n\nAgent runtime 协议：若当前 Provider 提供原生 tools/function calling，优先使用原生工具调用。若没有原生 tools 或原生 tools 不可靠，你的每一步只能输出一个 JSON object，不允许 Markdown、不允许代码块、不允许解释性前缀。需要工具时输出 {\"action\":\"tool\",\"tool\":\"read_file|grep|glob|git_diff|todowrite|bash|apply_patch|question\",\"input\":{...}}；完成任务时输出 {\"action\":\"final\",\"content\":\"面向用户的最终回答\"}。不要输出 ```bash/```shell 代码块让用户复制执行；如果要运行命令，必须调用 bash 工具。工具结果会作为 observation 继续发给你。read_file/grep/glob/git_diff/todowrite 和安全开发命令可自动执行；危险命令、bash 高风险命令和 apply_patch 需要用户批准。拿到足够信息后输出 final，不要要求用户手动粘贴 package.json、README 或目录列表。"
    );
    let history = workspace_context
        .get("history")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let role = item.get("role").and_then(Value::as_str).unwrap_or("");
                    let content = item
                        .get("content")
                        .or_else(|| item.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if content.is_empty() || !(role == "user" || role == "assistant") {
                        return None;
                    }
                    Some(IdeAiMessage {
                        role: role.to_string(),
                        content: content.chars().take(12000).collect::<String>(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut messages = vec![IdeAiMessage {
        role: "system".to_string(),
        content: agent_system,
    }];
    messages.extend(history.into_iter().rev().take(8).collect::<Vec<_>>().into_iter().rev());
    messages.push(IdeAiMessage {
        role: "user".to_string(),
        content: format!(
            "{prompt}\n\n[AutoCode Local Agent Context]\n{local_context}\n\n请直接基于以上本地上下文完成请求。"
        ),
    });
    ai_request.messages = messages;
    Ok((ai_request, prompt, tool_calls))
}

#[tauri::command]
pub async fn ide_agent_run(
    settings: connector::IdeSettings,
    request: Value,
    workspace_context: Value,
) -> Result<Value, String> {
    let (ai_request, _, tool_calls) = build_agent_ai_request(request, workspace_context)?;
    let response = ide_ai_request(settings, ai_request, Some(false)).await?;
    let requires_approval = extract_patch_preview(&response.answer).is_some();
    Ok(json!({
        "ok": true,
        "message": "agent response ready",
        "response": response,
        "toolCalls": tool_calls,
        "requiresApproval": requires_approval
    }))
}

#[tauri::command]
pub fn ide_agent_session_start(
    state: State<'_, IdeRuntimeState>,
    root_path: String,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    connector::resolve_authorized_root(&root_path)?;
    let session_id = format!(
        "agent-{}",
        state.next_agent_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let now = agent_now();
    let session = json!({
        "id": session_id,
        "rootPath": root_path,
        "provider": settings.provider_type,
        "model": settings.model,
        "messages": [],
        "toolCalls": [],
        "permissions": [],
        "createdAt": now,
        "updatedAt": now,
    });
    state.agent_sessions.lock().unwrap().insert(session_id.clone(), session.clone());
    persist_agent_session_value(&session);
    Ok(session)
}

#[tauri::command]
pub fn ide_agent_session_create(
    state: State<'_, IdeRuntimeState>,
    root_path: String,
    profile_id: Option<String>,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    connector::resolve_authorized_root(&root_path)?;
    let session_id = format!(
        "agent-{}",
        state.next_agent_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let now = agent_now();
    let profile = profile_id.unwrap_or_else(|| "build".to_string());
    let session = json!({
        "id": session_id,
        "rootPath": root_path,
        "profileId": profile,
        "provider": settings.provider_type,
        "model": settings.model,
        "messages": [],
        "toolCalls": [],
        "permissions": [],
        "createdAt": now,
        "updatedAt": now,
    });
    state.agent_sessions.lock().unwrap().insert(session_id.clone(), session.clone());
    persist_agent_session_value(&session);
    Ok(session)
}

async fn agent_call_model(
    app: &AppHandle,
    session_id: &str,
    settings: connector::IdeSettings,
    ai_request: IdeAiRequest,
) -> Result<AgentModelTurn, String> {
    match stream_agent_model_turn(app, session_id, settings.clone(), ai_request.clone()).await {
        Ok(turn) => Ok(turn),
        Err(stream_err) => match ide_ai_request(settings, ai_request, Some(false)).await {
            Ok(mut response) => {
                let tool_requests = extract_agent_tool_requests(&response.answer);
                if tool_requests.is_empty() {
                    if let Some(final_answer) = extract_agent_final_answer(&response.answer) {
                        response.answer = final_answer;
                    }
                }
                if !response.answer.trim().is_empty() && tool_requests.is_empty() {
                    agent_emit(app, session_id, "message_part", json!({
                        "role": "assistant",
                        "kind": "text",
                        "content": response.answer.clone()
                    }));
                }
                Ok(AgentModelTurn {
                    response: IdeAiResponse {
                        tool_calls: tool_requests.clone(),
                        ..response
                    },
                    tool_requests,
                })
            }
            Err(err) => Err(format!("{err}; stream fallback reason: {stream_err}")),
        },
    }
}

const AGENT_LOOP_MAX_STEPS: usize = 30;

async fn run_agent_tool_loop(
    app: &AppHandle,
    session_id: &str,
    root_path: &str,
    profile_id: &str,
    settings: connector::IdeSettings,
    mut ai_request: IdeAiRequest,
    start_step: usize,
) -> Result<IdeAiResponse, String> {
    let mut last_response = IdeAiResponse {
        answer: String::new(),
        reasoning_summary: String::new(),
        reasoning_raw: String::new(),
        tool_calls: Vec::new(),
        usage: Value::Null,
        finish_reason: String::new(),
        provider: settings.provider_type.clone(),
        model: settings.model.clone(),
    };
    for step in start_step..AGENT_LOOP_MAX_STEPS {
        let turn = agent_call_model(app, session_id, settings.clone(), ai_request.clone()).await?;
        let response = turn.response;
        let tool_requests = turn.tool_requests;
        last_response = response.clone();
        if tool_requests.is_empty() {
            return Ok(response);
        }
        let mut observations = Vec::new();
        for request in tool_requests {
            let raw_tool = request
                .get("tool")
                .or_else(|| request.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let tool = normalize_agent_tool_name(raw_tool);
            let input = tool_input(&request);
            let tool_call_id = format!("tool-{tool}-{}", agent_now());
            let (decision, risk) = agent_tool_requires_approval(profile_id, &tool, &input);
            if decision == "deny" {
                agent_emit(app, session_id, "permission_request", json!({
                    "id": tool_call_id,
                    "kind": if tool == "bash" { "command" } else { "write" },
                    "target": input.get("command").or_else(|| input.get("path")).cloned().unwrap_or(Value::String(tool.clone())),
                    "reason": "该工具请求被权限策略拒绝。",
                    "risk": risk,
                    "decision": "deny"
                }));
                observations.push(json!({ "tool": tool, "ok": false, "error": "permission denied by policy" }));
                continue;
            }
            if decision == "ask" {
                if tool == "apply_patch" {
                    if let Some(patch) = input.get("patch").or_else(|| input.get("diff")).and_then(Value::as_str) {
                        agent_emit(app, session_id, "patch_preview", json!({
                            "id": tool_call_id,
                            "patch": patch,
                            "files": [],
                            "requiresApproval": true
                        }));
                    }
                }
                update_agent_session(app, session_id, |session| {
                    session["pendingContinuation"] = json!({
                        "settings": settings.clone(),
                        "aiRequest": ai_request.clone(),
                        "step": step,
                        "lastAnswer": last_response.answer.clone(),
                        "profileId": profile_id,
                        "rootPath": root_path
                    });
                    if let Some(items) = session.get_mut("pendingTools").and_then(Value::as_array_mut) {
                        items.push(json!({ "id": tool_call_id, "tool": tool, "input": input, "createdAt": agent_now() }));
                    } else {
                        session["pendingTools"] = json!([{ "id": tool_call_id, "tool": tool, "input": input, "createdAt": agent_now() }]);
                    }
                });
                agent_emit(app, session_id, "permission_request", json!({
                    "id": tool_call_id,
                    "kind": if tool == "bash" { "command" } else { "write" },
                    "target": input.get("command").or_else(|| input.get("path")).cloned().unwrap_or(Value::String(tool.clone())),
                    "reason": "Agent 请求执行会修改环境或运行命令的工具，需要确认。",
                    "risk": risk,
                    "decision": "ask"
                }));
                return Ok(last_response);
            }

            agent_emit(app, session_id, "tool_call_start", json!({
                "id": tool_call_id,
                "name": tool,
                "input": input,
                "status": "running"
            }));
            let call = match execute_agent_tool(root_path, &tool, &input) {
                Ok(output) => agent_tool_call(&tool, input.clone(), output.clone(), None),
                Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
            };
            let mut call = call;
            if let Some(obj) = call.as_object_mut() {
                obj.insert("id".to_string(), Value::String(tool_call_id.clone()));
            }
            agent_emit(app, session_id, "tool_call_result", call.clone());
            update_agent_session(app, session_id, |session| {
                if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
                    items.push(call.clone());
                }
            });
            observations.push(json!({ "tool": tool, "result": call }));
        }
        ai_request.messages.push(IdeAiMessage {
            role: "assistant".to_string(),
            content: last_response.answer.clone(),
        });
        ai_request.messages.push(IdeAiMessage {
            role: "user".to_string(),
            content: format!(
                "[tool observations step {}]\n{}\n\n请基于这些 observation 继续；如仍需工具，继续输出 tool JSON；否则输出最终回答。",
                step + 1,
                Value::Array(observations).to_string()
            ),
        });
    }
    Ok(last_response)
}

fn spawn_agent_continuation(app: AppHandle, session_id: String, continuation: Value, observation: Value) {
    tauri::async_runtime::spawn(async move {
        let settings = match continuation
            .get("settings")
            .cloned()
            .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok())
        {
            Some(settings) => settings,
            None => {
                agent_emit(&app, &session_id, "error", json!({ "message": "pending continuation is missing provider settings" }));
                return;
            }
        };
        let mut ai_request = match continuation
            .get("aiRequest")
            .cloned()
            .and_then(|value| serde_json::from_value::<IdeAiRequest>(value).ok())
        {
            Some(request) => request,
            None => {
                agent_emit(&app, &session_id, "error", json!({ "message": "pending continuation is missing AI request" }));
                return;
            }
        };
        let root_path = continuation
            .get("rootPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let profile_id = continuation
            .get("profileId")
            .and_then(Value::as_str)
            .unwrap_or("build")
            .to_string();
        let step = continuation.get("step").and_then(Value::as_u64).unwrap_or(0) as usize;
        if let Some(last_answer) = continuation.get("lastAnswer").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
            ai_request.messages.push(IdeAiMessage {
                role: "assistant".to_string(),
                content: last_answer.to_string(),
            });
        }
        ai_request.messages.push(IdeAiMessage {
            role: "user".to_string(),
            content: format!(
                "[tool observations after approval]\n{}\n\n请基于这个工具结果继续；如仍需工具，继续输出 tool JSON；否则输出最终回答。",
                observation
            ),
        });
        let response = match run_agent_tool_loop(
            &app,
            &session_id,
            &root_path,
            &profile_id,
            settings,
            ai_request,
            step.saturating_add(1),
        )
        .await
        {
            Ok(response) => response,
            Err(err) => {
                agent_emit(&app, &session_id, "error", json!({ "message": err.clone() }));
                agent_emit(&app, &session_id, "session_done", json!({ "ok": false, "error": err }));
                return;
            }
        };
        if response.usage != Value::Null {
            agent_emit(&app, &session_id, "usage", response.usage.clone());
        }
        let result = json!({
            "ok": true,
            "message": "agent continuation ready",
            "response": response,
            "requiresApproval": false
        });
        update_agent_session(&app, &session_id, |session| {
            if let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({
                    "role": "assistant",
                    "content": result.pointer("/response/answer").cloned().unwrap_or(Value::Null),
                    "at": agent_now()
                }));
            }
        });
        agent_emit(&app, &session_id, "session_done", result);
    });
}

async fn run_agent_send_task(
    app: AppHandle,
    session_id: String,
    settings: connector::IdeSettings,
    message: String,
    context_refs: Value,
) -> Result<Value, String> {
    let session = {
        let state = app.state::<IdeRuntimeState>();
        let snapshot = state
            .agent_sessions
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "agent session not found".to_string())?;
        snapshot
    };
    let root_path = session
        .get("rootPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "agent session root is missing".to_string())?
        .to_string();
    let profile_id = session
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("build")
        .to_string();
    let history = session
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    agent_emit(&app, &session_id, "message_part", json!({
        "role": "user",
        "content": message.clone(),
        "kind": "text"
    }));
    if let Some(command) = extract_direct_agent_command(&root_path, &message) {
        let result = handle_direct_agent_command(&app, &session_id, &root_path, &profile_id, &command)?;
        update_agent_session(&app, &session_id, |session| {
            if let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({ "role": "user", "content": message, "at": agent_now() }));
                if let Some(answer) = result.pointer("/response/answer").and_then(Value::as_str) {
                    messages.push(json!({ "role": "assistant", "content": answer, "at": agent_now() }));
                }
            }
        });
        agent_emit(&app, &session_id, "session_done", result.clone());
        return Ok(result);
    }
    agent_emit(&app, &session_id, "tool_call_start", json!({
        "id": format!("todo-{}", agent_now()),
        "name": "todowrite",
        "status": "running",
        "input": { "items": ["理解需求", "收集项目上下文", "请求模型", "整理回答"] }
    }));
    agent_emit(&app, &session_id, "tool_call_result", agent_tool_call(
        "todowrite",
        json!({ "items": ["理解需求", "收集项目上下文", "请求模型", "整理回答"] }),
        json!({ "summary": "已创建本轮 agent todo" }),
        None,
    ));
    let request = json!({
        "messages": [{ "role": "user", "content": message.clone() }]
    });
    let workspace_context = json!({
        "root": root_path,
        "contextRefs": context_refs,
        "history": history
    });
    let (ai_request, _, _context_tool_calls) = match build_agent_ai_request(request, workspace_context) {
        Ok(result) => result,
        Err(err) => {
            agent_emit(&app, &session_id, "error", json!({ "message": err }));
            return Err(err);
        }
    };
    if profile_id.eq_ignore_ascii_case("plan") {
        let permission = json!({
            "id": format!("permission-{}", agent_now()),
            "kind": "write",
            "target": "workspace",
            "reason": "Plan Agent 默认不写入文件，仅输出方案。",
            "risk": "medium",
            "decision": permission_policy_for_tool(&profile_id, "write")
        });
        agent_emit(&app, &session_id, "permission_request", permission);
    }
    let response = match run_agent_tool_loop(
        &app,
        &session_id,
        &root_path,
        &profile_id,
        settings.clone(),
        ai_request.clone(),
        0,
    )
    .await
    {
        Ok(response) => response,
        Err(err) => {
            agent_emit(&app, &session_id, "error", json!({ "message": err }));
            return Err(err);
        }
    };
    if response.usage != Value::Null {
        agent_emit(&app, &session_id, "usage", response.usage.clone());
    }
    let mut requires_approval = false;
    if let Some(preview) = extract_patch_preview(&response.answer) {
        requires_approval = true;
        agent_emit(&app, &session_id, "patch_preview", preview.clone());
        agent_emit(&app, &session_id, "permission_request", json!({
            "id": preview.get("id").cloned().unwrap_or(Value::Null),
            "kind": "write",
            "target": "workspace patch",
            "reason": "AI 返回了可应用 patch，应用前需要用户确认。",
            "risk": "medium",
            "decision": permission_policy_for_tool(&profile_id, "apply_patch")
        }));
    }
    {
        let state = app.state::<IdeRuntimeState>();
        let sessions = state.agent_sessions.lock().unwrap();
        if let Some(active) = sessions.get(&session_id) {
            if active
                .get("pendingTools")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false)
            {
                requires_approval = true;
            }
        }
    }
    let result = json!({
        "ok": true,
        "message": "agent response ready",
        "response": response,
        "toolCalls": [],
        "requiresApproval": requires_approval
    });
    {
        let state = app.state::<IdeRuntimeState>();
        let mut sessions = state.agent_sessions.lock().unwrap();
        if let Some(active) = sessions.get_mut(&session_id) {
            if let Some(messages) = active.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({ "role": "user", "content": message, "at": agent_now() }));
                messages.push(json!({ "role": "assistant", "content": result.pointer("/response/answer").cloned().unwrap_or(Value::Null), "at": agent_now() }));
            }
            active["updatedAt"] = Value::String(agent_now());
            persist_agent_session_value(active);
        }
    }
    agent_emit(&app, &session_id, "session_done", result.clone());
    Ok(result)
}

#[tauri::command]
pub fn ide_agent_send(
    app: AppHandle,
    session_id: String,
    settings: connector::IdeSettings,
    message: String,
    context_refs: Value,
) -> Result<Value, String> {
    let request_id = format!("agent-request-{}", agent_now());
    let task_request_id = request_id.clone();
    let app_task = app.clone();
    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_agent_send_task(
            app_task.clone(),
            task_session_id.clone(),
            settings,
            message,
            context_refs,
        )
        .await
        {
            agent_emit(&app_task, &task_session_id, "error", json!({ "message": err.clone() }));
            agent_emit(
                &app_task,
                &task_session_id,
                "session_done",
                json!({ "ok": false, "requestId": task_request_id, "error": err }),
            );
        }
    });
    Ok(json!({
        "requestId": request_id,
        "accepted": true,
        "sessionId": session_id
    }))
}

#[tauri::command]
pub fn ide_agent_message_send(
    app: AppHandle,
    session_id: String,
    settings: connector::IdeSettings,
    message: String,
    context_refs: Value,
) -> Result<Value, String> {
    ide_agent_send(app, session_id, settings, message, context_refs)
}

#[tauri::command]
pub fn ide_agent_approve(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    approval_id: String,
    granted: bool,
) -> Result<Value, String> {
    let (root_path, pending_tool, pending_continuation, snapshot) = {
        let mut sessions = state.agent_sessions.lock().unwrap();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "agent session not found".to_string())?;
        let approval = json!({ "id": approval_id, "granted": granted, "at": agent_now() });
        if let Some(items) = session.get_mut("permissions").and_then(Value::as_array_mut) {
            items.push(approval);
        }
        let root_path = session.get("rootPath").and_then(Value::as_str).unwrap_or("").to_string();
        let mut pending_tool = None;
        if let Some(items) = session.get_mut("pendingTools").and_then(Value::as_array_mut) {
            if let Some(index) = items.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(approval_id.as_str())) {
                pending_tool = Some(items.remove(index));
            }
        }
        let pending_continuation = session.get("pendingContinuation").cloned();
        let no_pending_tools = session
            .get("pendingTools")
            .and_then(Value::as_array)
            .map(|items| items.is_empty())
            .unwrap_or(true);
        if no_pending_tools {
            session["pendingContinuation"] = Value::Null;
        }
        session["updatedAt"] = Value::String(agent_now());
        (root_path, pending_tool, pending_continuation, session.clone())
    };
    persist_agent_session_value(&snapshot);

    if !granted {
        let tool_name = pending_tool
            .as_ref()
            .and_then(|tool| tool.get("tool"))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = pending_tool
            .as_ref()
            .and_then(|tool| tool.get("input"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let call = json!({
            "id": approval_id,
            "name": tool_name,
            "status": "error",
            "input": input,
            "output": {},
            "error": "user denied permission",
            "startedAt": agent_now(),
            "finishedAt": agent_now()
        });
        agent_emit(&app, &session_id, "tool_call_result", call.clone());
        update_agent_session(&app, &session_id, |session| {
            if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
                items.push(call.clone());
            }
        });
        if let Some(continuation) = pending_continuation.filter(|value| !value.is_null()) {
            spawn_agent_continuation(app.clone(), session_id.clone(), continuation, json!({ "tool": tool_name, "result": call }));
        }
        return Ok(json!({ "id": approval_id, "granted": false, "executed": false }));
    }

    if let Some(pending) = pending_tool {
        let tool = pending.get("tool").and_then(Value::as_str).unwrap_or("tool").to_string();
        let input = pending.get("input").cloned().unwrap_or_else(|| json!({}));
        agent_emit(&app, &session_id, "tool_call_start", json!({
            "id": approval_id,
            "name": tool,
            "input": input,
            "status": "running"
        }));
        let mut call = match execute_agent_tool(&root_path, &tool, &input) {
            Ok(output) => agent_tool_call(&tool, input.clone(), output, None),
            Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
        };
        if let Some(obj) = call.as_object_mut() {
            obj.insert("id".to_string(), Value::String(approval_id.clone()));
        }
        agent_emit(&app, &session_id, "tool_call_result", call.clone());
        update_agent_session(&app, &session_id, |session| {
            if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
                items.push(call.clone());
            }
        });
        if let Some(continuation) = pending_continuation.filter(|value| !value.is_null()) {
            spawn_agent_continuation(app.clone(), session_id.clone(), continuation, json!({ "tool": tool, "result": call }));
        }
        return Ok(json!({ "id": approval_id, "granted": true, "executed": true, "tool": tool }));
    }

    Ok(json!({ "id": approval_id, "granted": true, "executed": false }))
}

#[tauri::command]
pub fn ide_agent_tool_approve(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    tool_call_id: String,
    decision: Value,
) -> Result<Value, String> {
    let granted = decision
        .get("granted")
        .and_then(Value::as_bool)
        .or_else(|| decision.as_bool())
        .unwrap_or(false);
    ide_agent_approve(app, state, session_id, tool_call_id, granted)
}

#[tauri::command]
pub fn ide_agent_cancel(_request_id: String) -> Result<Value, String> {
    Ok(json!({ "ok": true, "message": "agent request cancelled" }))
}

#[tauri::command]
pub fn ide_agent_sessions(
    state: State<'_, IdeRuntimeState>,
    root_path: Option<String>,
) -> Result<Vec<Value>, String> {
    if let Some(root) = root_path.as_deref().filter(|value| !value.trim().is_empty()) {
        connector::resolve_authorized_root(root)?;
    }
    let sessions = state.agent_sessions.lock().unwrap();
    Ok(sessions
        .values()
        .filter(|session| {
            root_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|root| session.get("rootPath").and_then(Value::as_str).unwrap_or("") == root)
                .unwrap_or(true)
        })
        .cloned()
        .collect())
}

#[tauri::command]
pub fn ide_agent_session_snapshot(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<Value, String> {
    state
        .agent_sessions
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "agent session not found".to_string())
}

#[tauri::command]
pub fn ide_agent_session_state(root_path: String) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    Ok(json!({
        "ok": true,
        "rootPath": shell_path(&root).to_string_lossy().to_string(),
        "capabilities": ["read_file", "write_with_approval", "run_terminal", "apply_patch_with_approval"],
        "toolCalls": [],
        "permissions": []
    }))
}

#[tauri::command]
pub fn ide_local_server_status(state: State<'_, IdeRuntimeState>) -> Result<Value, String> {
    let port = *state.local_server_port.lock().unwrap();
    let latest_event_id = state.next_agent_event_id.load(Ordering::SeqCst).saturating_sub(1);
    Ok(json!({
        "ok": port.is_some(),
        "host": "127.0.0.1",
        "port": port,
        "baseUrl": port.map(|value| format!("http://127.0.0.1:{value}")),
        "latestEventId": latest_event_id
    }))
}

pub fn start_ide_local_server(app: AppHandle) {
    {
        let state = app.state::<IdeRuntimeState>();
        load_persisted_agent_sessions(&state);
    }
    let already_running = {
        let state = app.state::<IdeRuntimeState>();
        let value = state.local_server_port.lock().unwrap().is_some();
        value
    };
    if already_running {
        return;
    }
    thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(_) => return,
        };
        if let Ok(address) = listener.local_addr() {
            let state = app.state::<IdeRuntimeState>();
            *state.local_server_port.lock().unwrap() = Some(address.port());
        }
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || {
                let _ = handle_ide_http_request(app, stream);
            });
        }
    });
}

fn handle_ide_http_request(app: AppHandle, mut stream: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|err| err.to_string())?);
    let mut first = String::new();
    reader.read_line(&mut first).map_err(|err| err.to_string())?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|err| err.to_string())?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:").or_else(|| trimmed.strip_prefix("content-length:")) {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).map_err(|err| err.to_string())?;
    }
    let body_value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null)
    };
    let path = target.split('?').next().unwrap_or("/");
    let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
    match (method.as_str(), path) {
        ("OPTIONS", _) => write_empty_response(&mut stream, 204),
        ("GET", "/health") => write_json_response(&mut stream, 200, json!({
            "ok": true,
            "name": "AutoCode Local IDE Server",
            "version": connector::VERSION,
            "capabilities": ["sessions", "events", "messages", "permissions", "files", "tools"]
        })),
        ("GET", "/sessions") => {
            let state = app.state::<IdeRuntimeState>();
            let sessions = state.agent_sessions.lock().unwrap().values().cloned().collect::<Vec<_>>();
            write_json_response(&mut stream, 200, json!({ "sessions": sessions }))
        }
        ("POST", "/session") => {
            let root_path = body_value
                .get("rootPath")
                .or_else(|| body_value.get("root_path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if root_path.trim().is_empty() {
                return write_json_response(&mut stream, 400, json!({ "error": "rootPath is required" }));
            }
            let profile_id = body_value
                .get("profileId")
                .or_else(|| body_value.get("profile_id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let settings = body_value
                .get("settings")
                .cloned()
                .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok())
                .unwrap_or_else(connector::load_ide_settings);
            let state = app.state::<IdeRuntimeState>();
            let session = ide_agent_session_create(state, root_path, profile_id, settings)?;
            write_json_response(&mut stream, 200, session)
        }
        ("GET", "/events") => write_sse_response(app, &mut stream, query),
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/message") => {
            let session_id = path.trim_start_matches("/session/").trim_end_matches("/message").trim_matches('/');
            let message = body_value.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            let settings = body_value
                .get("settings")
                .cloned()
                .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok())
                .unwrap_or_else(connector::load_ide_settings);
            let context_refs = body_value.get("contextRefs").cloned().unwrap_or_else(|| json!([]));
            let result = ide_agent_send(app, session_id.to_string(), settings, message, context_refs)?;
            write_json_response(&mut stream, 202, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.contains("/permission/") => {
            let parts = path.trim_start_matches("/session/").split("/permission/").collect::<Vec<_>>();
            if parts.len() != 2 {
                return write_json_response(&mut stream, 400, json!({ "error": "invalid permission path" }));
            }
            let granted = body_value.get("granted").and_then(Value::as_bool).unwrap_or(false);
            let app_for_approval = app.clone();
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_approve(app_for_approval, state, parts[0].to_string(), parts[1].to_string(), granted)?;
            write_json_response(&mut stream, 200, result)
        }
        _ if method == "GET" && path.starts_with("/session/") => {
            let session_id = path.trim_start_matches("/session/").trim_matches('/');
            let state = app.state::<IdeRuntimeState>();
            let session = state
                .agent_sessions
                .lock()
                .unwrap()
                .get(session_id)
                .cloned()
                .unwrap_or(Value::Null);
            if session == Value::Null {
                write_json_response(&mut stream, 404, json!({ "error": "session not found" }))
            } else {
                write_json_response(&mut stream, 200, session)
            }
        }
        _ => write_json_response(&mut stream, 404, json!({ "error": "not found" })),
    }
}

fn write_empty_response(stream: &mut TcpStream, status: u16) -> Result<(), String> {
    let reason = if status == 204 { "No Content" } else { "OK" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization, X-API-Key\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(response.as_bytes()).map_err(|err| err.to_string())
}

fn write_json_response(stream: &mut TcpStream, status: u16, value: Value) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let body = value.to_string();
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream.write_all(response.as_bytes()).map_err(|err| err.to_string())
}

fn write_sse_response(app: AppHandle, stream: &mut TcpStream, query: &str) -> Result<(), String> {
    let since = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("since=").and_then(|value| value.parse::<u64>().ok()))
        .unwrap_or(0);
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n")
        .map_err(|err| err.to_string())?;
    let started = Instant::now();
    let mut last_sent = since;
    loop {
        let events = {
            let state = app.state::<IdeRuntimeState>();
            let value = state.agent_events.lock().unwrap().clone();
            value
        };
        for event in events {
            let id = event.get("id").and_then(Value::as_u64).unwrap_or(0);
            if id <= last_sent {
                continue;
            }
            last_sent = id;
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("message");
            let frame = format!("id: {id}\nevent: {event_type}\ndata: {}\n\n", event);
            stream.write_all(frame.as_bytes()).map_err(|err| err.to_string())?;
        }
        stream.flush().map_err(|err| err.to_string())?;
        if started.elapsed() > Duration::from_secs(30) {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

#[tauri::command]
pub fn ide_agent_apply_patch(
    root_path: String,
    patch: String,
    approvals: Value,
) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    let approved = approvals
        .as_array()
        .map(|items| {
            items.iter().any(|item| {
                item.get("granted").and_then(Value::as_bool).unwrap_or(false)
                    && item.get("kind").and_then(Value::as_str).unwrap_or("") == "write"
            })
        })
        .unwrap_or(false);
    if !approved {
        return Err("file write approval is required before applying patch".to_string());
    }
    if patch.trim().is_empty() {
        return Err("patch cannot be empty".to_string());
    }
    let result = apply_agent_patch(&root.to_string_lossy(), &patch)?;
    Ok(json!({
        "ok": true,
        "message": "patch applied",
        "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
        "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new()))
    }))
}

fn mime_for_path(path: &Path) -> String {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "md" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "java" | "css" | "html" => "text/plain",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn shell_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy().to_string();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    PathBuf::from(raw)
}

fn attachment_from_path(path: &Path, kind: &str) -> Result<AttachmentInfo, String> {
    let metadata = fs::metadata(path).map_err(|err| format!("failed to read attachment metadata: {err}"))?;
    let mime = mime_for_path(path);
    Ok(AttachmentInfo {
        kind: kind.to_string(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "attachment".to_string()),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        previewable: mime.starts_with("image/") || mime.starts_with("text/") || mime == "application/pdf",
        mime,
    })
}

#[tauri::command]
pub fn ide_pick_attachments(kind: String) -> Result<Vec<AttachmentInfo>, String> {
    let dialog = rfd::FileDialog::new();
    let dialog = if kind == "image" {
        dialog.add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "svg"])
    } else if kind == "voice" {
        dialog.add_filter("Audio", &["wav", "mp3", "m4a", "ogg", "flac"])
    } else {
        dialog
    };
    let Some(paths) = dialog.pick_files() else {
        return Err("Attachment selection was cancelled.".to_string());
    };
    paths.iter().map(|path| attachment_from_path(path, &kind)).collect()
}

#[tauri::command]
pub fn ide_read_attachment_preview(path: String) -> Result<Value, String> {
    let path = Path::new(&path);
    let info = attachment_from_path(path, "file")?;
    Ok(json!({
        "path": info.path,
        "name": info.name,
        "mime": info.mime,
        "size": info.size,
        "previewable": info.previewable
    }))
}

#[tauri::command]
pub fn ide_voice_record_start(state: State<'_, IdeRuntimeState>) -> Result<Value, String> {
    let session_id = format!(
        "voice-{}",
        state.next_voice_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u16), String>>();
    let session_for_thread = session_id.clone();
    let join = thread::spawn(move || record_voice_thread(session_for_thread, stop_rx, ready_tx));
    let (sample_rate, channels) = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "麦克风启动超时。".to_string())??;
    state.voice_sessions.lock().unwrap().insert(
        session_id.clone(),
        VoiceSession {
            stop: stop_tx,
            join: Some(join),
        },
    );
    Ok(json!({
        "supported": true,
        "sessionId": session_id,
        "sampleRate": sample_rate,
        "channels": channels,
        "message": "正在录音。"
    }))
}

#[tauri::command]
pub fn ide_voice_record_stop(state: State<'_, IdeRuntimeState>, session_id: String) -> Result<Value, String> {
    let mut session = state
        .voice_sessions
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "录音会话不存在或已结束。".to_string())?;
    let _ = session.stop.send(());
    let join = session.join.take().ok_or_else(|| "录音线程已结束。".to_string())?;
    join.join()
        .map_err(|_| "录音线程异常退出。".to_string())?
}

fn record_voice_thread(
    session_id: String,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<(u32, u16), String>>,
) -> Result<Value, String> {
    let started_at = Instant::now();
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "没有找到可用麦克风输入设备。".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|err| format!("读取麦克风配置失败：{err}"))?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let capture = samples.clone();
    let err_fn = |err| eprintln!("AutoCode voice input error: {err}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| {
                let mut out = capture.lock().unwrap();
                out.extend(data.iter().map(|value| (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[i16], _| {
                capture.lock().unwrap().extend_from_slice(data);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[u16], _| {
                let mut out = capture.lock().unwrap();
                out.extend(data.iter().map(|value| (*value as i32 - 32768).clamp(i16::MIN as i32, i16::MAX as i32) as i16));
            },
            err_fn,
            None,
        ),
        other => {
            let message = format!("暂不支持该麦克风采样格式：{other:?}");
            let _ = ready_tx.send(Err(message.clone()));
            return Err(message);
        }
    }
    .map_err(|err| format!("启动麦克风录音失败：{err}"))?;
    stream.play().map_err(|err| format!("麦克风录音启动失败：{err}"))?;
    let _ = ready_tx.send(Ok((sample_rate, channels)));
    let _ = stop_rx.recv();
    drop(stream);
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    let samples = samples.lock().unwrap().clone();
    if samples.is_empty() {
        return Err("没有录到音频数据，请检查麦克风权限和输入设备。".to_string());
    }
    let path = std::env::temp_dir().join(format!("{session_id}.wav"));
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, spec)
        .map_err(|err| format!("创建录音文件失败：{err}"))?;
    for sample in samples {
        writer.write_sample(sample).map_err(|err| format!("写入录音文件失败：{err}"))?;
    }
    writer.finalize().map_err(|err| format!("保存录音文件失败：{err}"))?;
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    Ok(json!({
        "supported": true,
        "path": path.to_string_lossy(),
        "name": path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "voice.wav".to_string()),
        "mime": "audio/wav",
        "size": size,
        "durationMs": elapsed_ms,
        "message": "录音已保存。"
    }))
}

#[cfg(windows)]
fn run_windows_speech_transcribe(audio_path: &str, language: &str) -> Result<Value, String> {
    let path = Path::new(audio_path);
    if !path.exists() {
        return Err("音频文件不存在，无法转写。".to_string());
    }
    let script_path = ide_data_dir().join("windows-speech-transcribe.ps1");
    let script = r#"
param([string]$AudioPath, [string]$Language)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Speech
  $culture = $null
  if (![string]::IsNullOrWhiteSpace($Language)) {
    try { $culture = [System.Globalization.CultureInfo]::GetCultureInfo($Language) } catch { $culture = $null }
  }
  if ($null -eq $culture) { $culture = [System.Globalization.CultureInfo]::CurrentUICulture }
  try {
    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  } catch {
    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new()
  }
  $grammar = [System.Speech.Recognition.DictationGrammar]::new()
  $recognizer.LoadGrammar($grammar)
  $recognizer.SetInputToWaveFile($AudioPath)
  $result = $recognizer.Recognize()
  $text = ''
  if ($null -ne $result) { $text = $result.Text }
  $recognizer.Dispose()
  @{
    supported = $true
    text = $text
    language = $culture.Name
    message = $(if ([string]::IsNullOrWhiteSpace($text)) { 'Windows speech recognition returned no text; audio was kept.' } else { 'Windows speech recognition completed.' })
  } | ConvertTo-Json -Compress
} catch {
  @{
    supported = $false
    text = ''
    language = $Language
    message = ('Windows speech recognition unavailable: ' + $_.Exception.Message)
  } | ConvertTo-Json -Compress
}
"#;
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("创建语音识别脚本目录失败：{err}"))?;
    }
    let mut script_bytes = vec![0xEF, 0xBB, 0xBF];
    script_bytes.extend_from_slice(script.as_bytes());
    fs::write(&script_path, script_bytes)
        .map_err(|err| format!("写入语音识别脚本失败：{err}"))?;
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script_path)
        .arg("-AudioPath")
        .arg(path)
        .arg("-Language")
        .arg(language)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let started = Instant::now();
    let output = command
        .output()
        .map_err(|err| format!("启动 Windows 原生语音识别失败：{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(json!({
            "supported": false,
            "text": "",
            "language": language,
            "durationMs": started.elapsed().as_millis() as u64,
            "message": format!("Windows 原生语音识别不可用：{stderr}")
        }));
    }
    let mut parsed = serde_json::from_str::<Value>(stdout.trim()).unwrap_or_else(|_| {
        json!({
            "supported": false,
            "text": "",
            "language": language,
            "message": if stderr.trim().is_empty() { "Windows 原生语音识别未返回可解析结果。" } else { stderr.trim() }
        })
    });
    if let Some(object) = parsed.as_object_mut() {
        object.insert(
            "durationMs".to_string(),
            Value::Number(serde_json::Number::from(started.elapsed().as_millis() as u64)),
        );
    }
    Ok(parsed)
}

#[cfg(not(windows))]
fn run_windows_speech_transcribe(_audio_path: &str, language: &str) -> Result<Value, String> {
    Ok(json!({
        "supported": false,
        "text": "",
        "language": language,
        "durationMs": 0,
        "message": "当前平台不支持 Windows 原生语音识别。"
    }))
}

#[tauri::command]
pub fn ide_windows_speech_transcribe(
    audio_path: String,
    language: Option<String>,
) -> Result<Value, String> {
    let lang = language.unwrap_or_else(|| "zh-CN".to_string());
    run_windows_speech_transcribe(&audio_path, &lang)
}

#[tauri::command]
pub async fn ide_transcribe_audio(
    settings: connector::IdeSettings,
    audio_path: String,
    model: Option<String>,
) -> Result<Value, String> {
    let provider = settings.provider_type.as_str();
    let supported = matches!(
        provider,
        "openai-responses" | "openai-chat" | "custom-openai-compatible" | "kimi" | "xai-grok"
    );
    if !supported {
        return Ok(json!({
            "supported": false,
            "provider": settings.provider_type,
            "audioPath": audio_path,
            "message": "当前 Provider 未声明支持 /v1/audio/transcriptions，已保留音频附件。"
        }));
    }
    let path = Path::new(&audio_path);
    if !path.exists() {
        return Err("音频文件不存在，无法转写。".to_string());
    }
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "voice.wav".to_string());
    let bytes = fs::read(path).map_err(|err| format!("读取音频文件失败：{err}"))?;
    let mime = mime_for_path(path);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime)
        .map_err(|err| format!("音频 MIME 无效：{err}"))?;
    let transcription_model = model
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let configured = settings.transcription_model.trim();
            if configured.is_empty() {
                None
            } else {
                Some(configured.to_string())
            }
        });
    let Some(transcription_model) = transcription_model else {
        return Ok(json!({
            "supported": false,
            "provider": settings.provider_type,
            "audioPath": audio_path,
            "message": "未配置云端转写模型，已保留音频附件。可在设置中填写 transcriptionModel 后启用 Provider ASR。"
        }));
    };
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", transcription_model.clone())
        .text("response_format", "json");
    let url = provider_url(&settings, "/v1/audio/transcriptions")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| format!("创建转写客户端失败：{err}"))?;
    let mut request = client.post(&url).multipart(form);
    let key = settings.api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    for (name, value) in settings.custom_headers.iter() {
        if !name.trim().is_empty() && !value.trim().is_empty() {
            request = request.header(name.trim(), value.trim());
        }
    }
    let started = Instant::now();
    let response = request
        .send()
        .await
        .map_err(|err| format!("语音转文字请求失败：{err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取转写响应失败：{err}"))?;
    if !status.is_success() {
        return Err(format!("语音转文字返回 {}：{}", status.as_u16(), text));
    }
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "text": text }));
    let transcript = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if transcript.trim().is_empty() {
        return Err("语音转文字成功返回，但没有 text 字段。".to_string());
    }
    Ok(json!({
        "supported": true,
        "provider": settings.provider_type,
        "model": transcription_model,
        "text": transcript,
        "raw": parsed,
        "durationMs": started.elapsed().as_millis() as u64
    }))
}

#[tauri::command]
pub fn ide_terminal_start(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    root_path: String,
    shell: Option<String>,
) -> Result<TerminalSessionInfo, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    let shell_root = shell_path(&root);
    let shell_root_text = shell_root.to_string_lossy().to_string();
    let requested = shell.unwrap_or_else(|| "auto".to_string());
    let candidates = terminal_shell_candidates(&requested);
    let mut last_error = String::new();
    let mut fallback_from = String::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let mut started = match spawn_terminal_candidate(&app, &state, &shell_root, &shell_root_text, candidate) {
            Ok(started) => started,
            Err(err) => {
                last_error = err;
                if index == 0 {
                    fallback_from = candidate.label.clone();
                }
                continue;
            }
        };
        let (interactive, probe_output) = probe_terminal_candidate(&mut started, candidate);
        let has_fallback = index + 1 < candidates.len();
        if !interactive && has_fallback {
            let _ = terminate_terminal_process(&mut started.process);
            fallback_from = candidate.label.clone();
            continue;
        }
        let session_id = started.session_id.clone();
        let label = started.shell.clone();
        let cwd = started.cwd.clone();
        let writer = started.writer.clone();
        let last_output = started.last_output.clone();
        let local_echo = started.local_echo;
        let process = started.process;
        state.terminals.lock().unwrap().insert(
            session_id.clone(),
            TerminalSession {
                process,
                writer,
                shell: label.clone(),
                cwd: cwd.clone(),
                last_output,
                local_echo,
            },
        );
        let started_message = if fallback_from.is_empty() {
            format!("Started {label} in {cwd}\n")
        } else {
            format!("Started {label} in {cwd} (fallback from {fallback_from})\n")
        };
        let _ = app.emit(
            "ide://terminal-output",
            TerminalOutputEvent {
                session_id: session_id.clone(),
                stream: "system".to_string(),
                data: started_message.clone(),
            },
        );
        let _ = app.emit(
            "ide://pty-output",
            TerminalOutputEvent {
                session_id: session_id.clone(),
                stream: "system".to_string(),
                data: started_message,
            },
        );
        return Ok(TerminalSessionInfo {
            session_id,
            shell: label,
            cwd,
            ok: true,
            interactive,
            local_echo,
            probe_output,
            fallback_from,
            message: if interactive {
                "terminal started".to_string()
            } else {
                "terminal started but did not respond to probe".to_string()
            },
        });
    }
    Err(if last_error.is_empty() {
        "failed to start PTY shell".to_string()
    } else {
        last_error
    })
}

struct TerminalShellCandidate {
    program: String,
    args: Vec<String>,
    label: String,
    probe: String,
    pipe: bool,
}

struct StartedTerminal {
    process: TerminalProcess,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    shell: String,
    cwd: String,
    last_output: Arc<Mutex<String>>,
    session_id: String,
    local_echo: bool,
}

fn powershell_candidate(program: &str, label: &str) -> TerminalShellCandidate {
    TerminalShellCandidate {
        program: program.to_string(),
        args: vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NoExit".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
        ],
        label: label.to_string(),
        probe: "Write-Output \"__AUTOCODE_PTY_READY__ $(Get-Location)\"\r".to_string(),
        pipe: false,
    }
}

fn cmd_candidate() -> TerminalShellCandidate {
    TerminalShellCandidate {
        program: "cmd.exe".to_string(),
        args: vec![
            "/K".to_string(),
            "chcp 65001 > nul".to_string(),
        ],
        label: "cmd.exe".to_string(),
        probe: "echo __AUTOCODE_PTY_READY__ && cd\r\n".to_string(),
        pipe: false,
    }
}

fn terminal_shell_candidates(requested: &str) -> Vec<TerminalShellCandidate> {
    let normalized = requested.trim().to_lowercase();
    if cfg!(windows) {
        match normalized.as_str() {
            "" | "auto" => vec![powershell_candidate("powershell.exe", "PowerShell"), cmd_candidate()],
            "powershell" | "powershell.exe" => vec![powershell_candidate("powershell.exe", "PowerShell"), cmd_candidate()],
            "pwsh" | "pwsh.exe" => vec![powershell_candidate("pwsh.exe", "PowerShell 7"), cmd_candidate()],
            "cmd" | "cmd.exe" => vec![cmd_candidate()],
            other => vec![TerminalShellCandidate {
                program: other.to_string(),
                args: Vec::new(),
                label: other.to_string(),
                probe: "echo __AUTOCODE_PTY_READY__\r".to_string(),
                pipe: false,
            }],
        }
    } else if normalized.is_empty() || normalized == "auto" {
        vec![TerminalShellCandidate {
            program: "sh".to_string(),
            args: Vec::new(),
            label: "sh".to_string(),
            probe: "printf '__AUTOCODE_PTY_READY__\\n'; pwd\r".to_string(),
            pipe: false,
        }]
    } else {
        vec![TerminalShellCandidate {
            program: normalized.clone(),
            args: Vec::new(),
            label: normalized,
            probe: "echo __AUTOCODE_PTY_READY__\r".to_string(),
            pipe: false,
        }]
    }
}

fn spawn_terminal_candidate(
    app: &AppHandle,
    state: &IdeRuntimeState,
    shell_root: &Path,
    shell_root_text: &str,
    candidate: &TerminalShellCandidate,
) -> Result<StartedTerminal, String> {
    if candidate.pipe {
        return spawn_pipe_terminal_candidate(app, state, shell_root, shell_root_text, candidate);
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to create PTY: {err}"))?;
    let mut command = CommandBuilder::new(candidate.program.clone());
    for arg in &candidate.args {
        command.arg(arg);
    }
    command.cwd(shell_root);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("failed to start {}: {err}", candidate.label))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("failed to open PTY reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("failed to open PTY writer: {err}"))?;
    let session_id = format!(
        "term-{}",
        state.next_terminal_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let last_output = Arc::new(Mutex::new(String::new()));
    spawn_terminal_reader(app.clone(), session_id.clone(), "pty", reader, last_output.clone());
    let writer = Arc::new(Mutex::new(writer));
    Ok(StartedTerminal {
        process: TerminalProcess::Pty {
            child,
            master: pair.master,
        },
        writer,
        shell: candidate.label.clone(),
        cwd: shell_root_text.to_string(),
        last_output,
        session_id,
        local_echo: false,
    })
}

fn spawn_pipe_terminal_candidate(
    app: &AppHandle,
    state: &IdeRuntimeState,
    shell_root: &Path,
    shell_root_text: &str,
    candidate: &TerminalShellCandidate,
) -> Result<StartedTerminal, String> {
    let mut command = Command::new(&candidate.program);
    for arg in &candidate.args {
        command.arg(arg);
    }
    command
        .current_dir(shell_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start {}: {err}", candidate.label))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("failed to open {} stdin", candidate.label))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to open {} stdout", candidate.label))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to open {} stderr", candidate.label))?;
    let session_id = format!(
        "term-{}",
        state.next_terminal_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let last_output = Arc::new(Mutex::new(String::new()));
    spawn_terminal_reader(app.clone(), session_id.clone(), "stdout", stdout, last_output.clone());
    spawn_terminal_reader(app.clone(), session_id.clone(), "stderr", stderr, last_output.clone());
    let writer: Box<dyn Write + Send> = Box::new(stdin);
    Ok(StartedTerminal {
        process: TerminalProcess::Pipe { child },
        writer: Arc::new(Mutex::new(writer)),
        shell: candidate.label.clone(),
        cwd: shell_root_text.to_string(),
        last_output,
        session_id,
        local_echo: true,
    })
}

fn terminate_terminal_process(process: &mut TerminalProcess) -> Result<i32, String> {
    match process {
        TerminalProcess::Pty { child, .. } => {
            let _ = child.kill();
            Ok(child
                .wait()
                .ok()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(-1))
        }
        TerminalProcess::Pipe { child } => {
            let _ = child.kill();
            Ok(child.wait().ok().and_then(|status| status.code()).unwrap_or(-1))
        }
    }
}

fn probe_terminal_candidate(
    started: &mut StartedTerminal,
    candidate: &TerminalShellCandidate,
) -> (bool, String) {
    if !candidate.probe.is_empty() {
        if let Ok(mut writer) = started.writer.lock() {
            let _ = writer.write_all(candidate.probe.as_bytes());
            let _ = writer.flush();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let probe_output = started.last_output.lock().unwrap().clone();
        if probe_output.contains("__AUTOCODE_PTY_READY__") {
            return (true, probe_output);
        }
        thread::sleep(Duration::from_millis(80));
    }
    let probe_output = started.last_output.lock().unwrap().clone();
    (probe_output.contains("__AUTOCODE_PTY_READY__"), probe_output)
}

#[tauri::command]
pub fn ide_pty_start(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    root_path: String,
    shell: Option<String>,
) -> Result<TerminalSessionInfo, String> {
    ide_terminal_start(app, state, root_path, shell)
}

#[tauri::command]
pub fn ide_pty_write(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    ide_terminal_write(state, session_id, data)
}

#[tauri::command]
pub fn ide_pty_probe(state: State<'_, IdeRuntimeState>, session_id: String) -> Result<Value, String> {
    let sessions = state.terminals.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    let last_output = session.last_output.lock().unwrap().clone();
    Ok(json!({
        "ok": true,
        "shell": session.shell.clone(),
        "cwd": session.cwd.clone(),
        "localEcho": session.local_echo,
        "lastOutput": last_output,
    }))
}

#[tauri::command]
pub fn ide_pty_resize(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ide_terminal_resize(state, session_id, cols, rows)
}

#[tauri::command]
pub fn ide_pty_kill(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<(), String> {
    ide_terminal_kill(app, state, session_id)
}

fn spawn_terminal_reader<R: Read + Send + 'static>(
    app: AppHandle,
    session_id: String,
    stream: &str,
    reader: R,
    last_output: Arc<Mutex<String>>,
) {
    let stream = stream.to_string();
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    {
                        let mut recent = last_output.lock().unwrap();
                        recent.push_str(&data);
                        if recent.len() > 12000 {
                            let keep_from = recent.len().saturating_sub(12000);
                            *recent = recent[keep_from..].to_string();
                        }
                    }
                    let event = TerminalOutputEvent {
                        session_id: session_id.clone(),
                        stream: stream.clone(),
                        data,
                    };
                    let _ = app.emit("ide://terminal-output", event.clone());
                    let _ = app.emit("ide://pty-output", event);
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
pub fn ide_terminal_write(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let sessions = state.terminals.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    let input = normalize_terminal_input(&input, session.local_echo);
    let mut writer = session.writer.lock().unwrap();
    writer
        .write_all(input.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|err| format!("failed to write terminal input: {err}"))
}

fn normalize_terminal_input(input: &str, pipe_mode: bool) -> String {
    if !pipe_mode {
        return input.to_string();
    }
    let mut output = String::with_capacity(input.len() + 8);
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                output.push('\r');
                if !matches!(chars.peek(), Some('\n')) {
                    output.push('\n');
                }
            }
            '\u{7f}' => output.push('\u{8}'),
            _ => output.push(ch),
        }
    }
    output
}

#[tauri::command]
pub fn ide_terminal_resize(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.terminals.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    match &session.process {
        TerminalProcess::Pty { master, .. } => master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("failed to resize terminal: {err}")),
        TerminalProcess::Pipe { .. } => Ok(()),
    }
}

#[tauri::command]
pub fn ide_terminal_kill(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.terminals.lock().unwrap();
    if let Some(mut session) = sessions.remove(&session_id) {
        let code = terminate_terminal_process(&mut session.process).unwrap_or(-1);
        let _ = app.emit(
            "ide://terminal-exit",
            TerminalExitEvent {
                session_id: session_id.clone(),
                exit_code: code,
            },
        );
        let _ = app.emit(
            "ide://pty-exit",
            TerminalExitEvent {
                session_id,
                exit_code: code,
            },
        );
        Ok(())
    } else {
        Err("terminal session not found".to_string())
    }
}

#[tauri::command]
pub fn ide_create_workspace_entry(
    root_path: String,
    parent_path: String,
    name: String,
    kind: String,
) -> Result<connector::WorkspaceEntry, String> {
    connector::create_workspace_entry(&root_path, &parent_path, &name, &kind)
}

#[tauri::command]
pub fn ide_rename_workspace_entry(
    root_path: String,
    path: String,
    new_path: String,
) -> Result<connector::WorkspaceEntry, String> {
    connector::rename_workspace_entry(&root_path, &path, &new_path)
}

#[tauri::command]
pub fn ide_delete_workspace_entry(root_path: String, path: String, recursive: bool) -> Result<(), String> {
    connector::delete_workspace_entry(&root_path, &path, recursive)
}

#[tauri::command]
pub fn ide_search_workspace(
    root_path: String,
    query: String,
    include_content: bool,
    limit: Option<usize>,
) -> Result<Vec<connector::WorkspaceSearchResult>, String> {
    connector::search_workspace(&root_path, &query, include_content, limit.unwrap_or(80))
}

#[tauri::command]
pub fn ide_stat_workspace_file(root_path: String, path: String) -> Result<connector::WorkspaceFileStat, String> {
    connector::stat_workspace_file(&root_path, &path)
}

#[tauri::command]
pub fn ide_open_path(path: String) -> Result<(), String> {
    connector::open_workspace_in_explorer(&path)
}

#[tauri::command]
pub fn ide_open_url(url: String) -> Result<(), String> {
    connector::open_url(&url)
}

#[tauri::command]
pub fn ide_reload_deep_link(raw: String) -> Result<Option<connector::RecentProject>, String> {
    connector::import_legacy_deep_link(&raw)
}

pub fn handle_deep_link<R: Runtime>(app: &tauri::AppHandle<R>, raw: &str) {
    match connector::import_legacy_deep_link(raw) {
        Ok(Some(project)) => {
            let _ = app.emit("connector://open-project", project.clone());
            let _ = app.emit("connector://deep-link", raw.to_string());
        }
        Ok(None) => {
            let _ = app.emit("connector://deep-link", raw.to_string());
        }
        Err(error) => {
            let _ = app.emit("connector://deep-link-error", error);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
