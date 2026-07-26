use crate::connector;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child as StdChild, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::UpdaterExt;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

#[derive(Default)]
pub struct IdeRuntimeState {
    terminals: Mutex<HashMap<String, TerminalSession>>,
    voice_sessions: Mutex<HashMap<String, VoiceSession>>,
    offline_stt_server: Mutex<Option<OfflineSttServer>>,
    offline_stt_download_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    agent_processes: Mutex<HashMap<String, AgentProcess>>,
    agent_child_processes: Mutex<HashMap<String, AgentChildProcess>>,
    agent_cancel_tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
    agent_sessions: Mutex<HashMap<String, Value>>,
    agent_events: Mutex<Vec<Value>>,
    local_server_port: Mutex<Option<u16>>,
    next_terminal_id: AtomicU64,
    next_voice_id: AtomicU64,
    next_agent_id: AtomicU64,
    next_agent_event_id: AtomicU64,
}

struct AgentProcess {
    child: StdChild,
    session_id: String,
    root_path: String,
    command: String,
    cwd: String,
    started_at: String,
    last_output: Arc<Mutex<String>>,
}

#[derive(Clone)]
struct AgentChildProcess {
    session_id: String,
    pid: u32,
    kind: String,
    label: String,
    started_at: String,
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

struct OfflineSttServer {
    child: StdChild,
    model_id: String,
    port: u16,
}

impl Drop for OfflineSttServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reasoning_content: String,
}

impl IdeAiMessage {
    fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: String::new(),
            reasoning_content: String::new(),
        }
    }

    fn assistant_with_tools(
        content: impl Into<String>,
        tool_calls: Vec<Value>,
        reasoning_content: impl Into<String>,
    ) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.into(),
            tool_calls,
            tool_call_id: String::new(),
            reasoning_content: reasoning_content.into(),
        }
    }

    fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".to_string(),
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: tool_call_id.into(),
            reasoning_content: String::new(),
        }
    }
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

#[derive(Clone)]
struct OfflineSttModelSpec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    size_label: &'static str,
    accuracy_label: &'static str,
    latency_label: &'static str,
    archive_url: &'static str,
    archive_name: &'static str,
    extracted_dir: &'static str,
    model_kind: &'static str,
}

#[tauri::command]
pub fn ide_bootstrap() -> connector::IdeBootstrap {
    connector::load_ide_bootstrap()
}

#[tauri::command]
pub fn ide_save_settings(
    settings: connector::IdeSettings,
) -> Result<connector::IdeSettings, String> {
    connector::save_ide_settings(settings)
}

fn update_manifest_url(settings: &connector::IdeSettings) -> Result<Option<Url>, String> {
    let raw = settings
        .update_manifest_url
        .trim()
        .to_string()
        .or_else_nonempty(std::env::var("AUTOCODE_UPDATER_ENDPOINT").unwrap_or_default())
        .or_else_nonempty(std::env::var("AUTOCODE_UPDATER_URL").unwrap_or_default());
    if raw.is_empty() {
        return Ok(None);
    }
    let url = Url::parse(&raw).map_err(|err| format!("Invalid update manifest URL: {err}"))?;
    if url.scheme() != "https" && !cfg!(debug_assertions) {
        return Err("Update manifest URL must use https in release builds.".to_string());
    }
    Ok(Some(url))
}

fn updater_public_key(settings: &connector::IdeSettings) -> String {
    settings
        .update_public_key
        .trim()
        .to_string()
        .or_else_nonempty(std::env::var("AUTOCODE_UPDATER_PUBKEY").unwrap_or_default())
}

trait NonEmptyString {
    fn or_else_nonempty(self, fallback: String) -> String;
}

impl NonEmptyString for String {
    fn or_else_nonempty(self, fallback: String) -> String {
        if self.trim().is_empty() {
            fallback
        } else {
            self
        }
    }
}

#[tauri::command]
pub async fn ide_update_check(
    app: AppHandle,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    if !settings.auto_update_enabled {
        return Ok(json!({ "ok": true, "configured": false, "message": "auto update disabled" }));
    }
    let endpoint_from_settings = update_manifest_url(&settings)?;
    let pubkey_from_settings = updater_public_key(&settings);
    if endpoint_from_settings.is_none() && pubkey_from_settings.trim().is_empty() {
        let updater = app
            .updater()
            .map_err(|err| format!("updater is not configured or failed to initialize: {err}"))?;
        let update = updater
            .check()
            .await
            .map_err(|err| format!("update check failed: {err}"))?;
        if let Some(update) = update {
            return Ok(json!({
                "ok": true,
                "configured": true,
                "available": true,
                "hasPublicKey": true,
                "currentVersion": update.current_version.to_string(),
                "version": update.version.to_string(),
                "date": update.date.map(|date| date.to_string()),
                "body": update.body,
                "rawJson": update.raw_json,
            }));
        }
        return Ok(json!({
            "ok": true,
            "configured": true,
            "available": false,
            "hasPublicKey": true,
            "message": "already latest"
        }));
    }
    let endpoint_override = endpoint_from_settings;
    let mut builder = app
        .updater_builder()
        .endpoints(endpoint_override.into_iter().collect::<Vec<_>>())
        .map_err(|err| format!("invalid update endpoint: {err}"))?
        .timeout(Duration::from_secs(20));
    let pubkey = updater_public_key(&settings);
    let has_public_key = !pubkey.trim().is_empty();
    if has_public_key {
        builder = builder.pubkey(pubkey);
    }
    let updater = builder
        .build()
        .map_err(|err| format!("updater initialization failed: {err}"))?;
    let update = updater
        .check()
        .await
        .map_err(|err| format!("update check failed: {err}"))?;
    if let Some(update) = update {
        Ok(json!({
            "ok": true,
            "configured": true,
            "available": true,
            "hasPublicKey": has_public_key,
            "currentVersion": update.current_version.to_string(),
            "version": update.version.to_string(),
            "date": update.date.map(|date| date.to_string()),
            "body": update.body,
            "rawJson": update.raw_json,
        }))
    } else {
        Ok(json!({
            "ok": true,
            "configured": true,
            "available": false,
            "hasPublicKey": has_public_key,
            "message": "already latest"
        }))
    }
}

#[tauri::command]
pub async fn ide_update_install(
    app: AppHandle,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    let endpoint_from_settings = update_manifest_url(&settings)?;
    let pubkey_from_settings = updater_public_key(&settings);
    if endpoint_from_settings.is_none() && pubkey_from_settings.trim().is_empty() {
        let updater = app
            .updater()
            .map_err(|err| format!("updater is not configured or failed to initialize: {err}"))?;
        let update = updater
            .check()
            .await
            .map_err(|err| format!("update check failed: {err}"))?
            .ok_or_else(|| "no installable update".to_string())?;
        let version = update.version.to_string();
        let app_for_progress = app.clone();
        update
            .download_and_install(
                move |chunk_length, content_length| {
                    let _ = app_for_progress.emit(
                        "ide-update-progress",
                        json!({
                            "event": "progress",
                            "chunkLength": chunk_length,
                            "contentLength": content_length,
                            "version": version
                        }),
                    );
                },
                {
                    let app = app.clone();
                    move || {
                        let _ = app.emit("ide-update-progress", json!({ "event": "finished" }));
                    }
                },
            )
            .await
            .map_err(|err| format!("update download or install failed: {err}"))?;
        return Ok(json!({ "ok": true, "installed": true }));
    }
    let endpoint = endpoint_from_settings.ok_or_else(|| "missing update endpoint".to_string())?;
    let pubkey = pubkey_from_settings;
    if pubkey.trim().is_empty() {
        return Err("missing update signature public key".to_string());
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|err| format!("invalid update endpoint: {err}"))?
        .pubkey(pubkey)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("updater initialization failed: {err}"))?;
    let update = updater
        .check()
        .await
        .map_err(|err| format!("update check failed: {err}"))?
        .ok_or_else(|| "no installable update".to_string())?;
    let version = update.version.to_string();
    let app_for_progress = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = app_for_progress.emit(
                    "ide-update-progress",
                    json!({
                        "event": "progress",
                        "chunkLength": chunk_length,
                        "contentLength": content_length,
                        "version": version
                    }),
                );
            },
            {
                let app = app.clone();
                move || {
                    let _ = app.emit("ide-update-progress", json!({ "event": "finished" }));
                }
            },
        )
        .await
        .map_err(|err| format!("update download or install failed: {err}"))?;
    Ok(json!({ "ok": true }))
}

static PROVIDER_ROUTE_ROTATION: AtomicUsize = AtomicUsize::new(0);
static JSON_WRITE_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn settings_for_channel(
    base: &connector::IdeSettings,
    channel: &connector::ProviderChannel,
    model_override: Option<&str>,
) -> connector::IdeSettings {
    let mut settings = base.clone();
    settings.provider_type = channel.provider_type.clone();
    settings.api_protocol = channel.api_protocol.clone();
    settings.api_base_url = channel.api_base_url.clone();
    settings.api_key = channel.api_key.clone();
    settings.custom_headers = channel.custom_headers.clone();
    settings.model = model_override
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
        .map(str::to_string)
        .unwrap_or_else(|| select_channel_model(channel).unwrap_or_default());
    settings.channels.clear();
    settings.default_routes.clear();
    settings
}

fn channel_models(channel: &connector::ProviderChannel) -> &[String] {
    if channel.model_filter_configured {
        &channel.enabled_models
    } else {
        &channel.models
    }
}

fn select_channel_model(channel: &connector::ProviderChannel) -> Option<String> {
    let configured = channel.default_model.trim();
    if !configured.is_empty() && !configured.eq_ignore_ascii_case("auto") {
        return Some(configured.to_string());
    }
    channel_models(channel)
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
        .map(str::to_string)
        .or_else(|| {
            channel
                .models
                .iter()
                .map(|value| value.trim())
                .find(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
                .map(str::to_string)
        })
}

fn extract_provider_model_names(data: &Value) -> Vec<String> {
    let source = data
        .get("data")
        .or_else(|| data.get("models"))
        .or_else(|| data.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| data.as_array().cloned().unwrap_or_default());
    let mut models = source
        .iter()
        .filter_map(|item| {
            item.get("id")
                .or_else(|| item.get("model"))
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

fn channel_supports_model(channel: &connector::ProviderChannel, model_hint: Option<&str>) -> bool {
    let Some(model) = model_hint.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    if model.eq_ignore_ascii_case("auto") {
        return true;
    }
    let models = channel_models(channel);
    models.is_empty() || models.iter().any(|item| item == model) || channel.default_model == model
}

fn channel_supports_purpose(channel: &connector::ProviderChannel, purpose: &str) -> bool {
    match purpose {
        "chat" | "agent" | "reasoning" => true,
        "codeCompletion" => {
            !channel.code_completion_model.trim().is_empty()
                || channel.purposes.iter().any(|item| item == "codeCompletion")
        }
        _ => channel.purposes.is_empty() || channel.purposes.iter().any(|item| item == purpose),
    }
}

fn provider_channel_candidates(
    settings: &connector::IdeSettings,
    purpose: &str,
    model_hint: Option<&str>,
) -> Vec<connector::ProviderChannel> {
    let mut candidates = settings
        .channels
        .iter()
        .filter(|channel| channel.enabled)
        .filter(|channel| channel_supports_purpose(channel, purpose))
        .filter(|channel| channel_supports_model(channel, model_hint))
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| b.weight.cmp(&a.weight))
            .then_with(|| a.id.cmp(&b.id))
    });
    if candidates.len() > 1 {
        let highest = candidates[0].priority;
        let equal_count = candidates
            .iter()
            .take_while(|item| item.priority == highest)
            .count();
        if equal_count > 1 {
            let offset = PROVIDER_ROUTE_ROTATION.fetch_add(1, Ordering::Relaxed) % equal_count;
            candidates[..equal_count].rotate_left(offset);
        }
    }
    candidates
}

fn route_provider_channel(
    settings: &connector::IdeSettings,
    purpose: &str,
    model_hint: Option<&str>,
) -> Option<connector::ProviderChannel> {
    provider_channel_candidates(settings, purpose, model_hint)
        .into_iter()
        .next()
}

#[tauri::command]
pub fn ide_channels_list() -> Result<Vec<connector::ProviderChannel>, String> {
    Ok(connector::load_ide_settings().channels)
}

#[tauri::command]
pub fn ide_provider_route(purpose: String, model_hint: Option<String>) -> Result<Value, String> {
    let settings = connector::load_ide_settings();
    let channel = route_provider_channel(&settings, &purpose, model_hint.as_deref())
        .ok_or_else(|| format!("no enabled provider channel for purpose: {purpose}"))?;
    let model = model_hint
        .filter(|value| !value.trim().is_empty() && !value.trim().eq_ignore_ascii_case("auto"))
        .unwrap_or_else(|| {
            if purpose == "codeCompletion" && !settings.code_completion.model.trim().is_empty() {
                settings.code_completion.model.clone()
            } else {
                select_channel_model(&channel).unwrap_or_default()
            }
        });
    Ok(json!({
        "purpose": purpose,
        "channelId": channel.id,
        "channelName": channel.name,
        "providerType": channel.provider_type,
        "model": model,
        "baseUrl": channel.api_base_url
    }))
}

#[tauri::command]
pub fn ide_channel_save(
    channel: connector::ProviderChannel,
) -> Result<connector::ProviderChannel, String> {
    let mut settings = connector::load_ide_settings();
    let mut next = channel;
    if next.id.trim().is_empty() {
        next.id = format!("channel-{}", agent_now());
    }
    if next.updated_at.trim().is_empty() {
        next.updated_at = agent_now();
    }
    if next.name.trim().is_empty() {
        next.name = next.provider_type.clone();
    }
    if is_local_openai_provider(next.provider_type.as_str()) {
        if next.api_base_url.trim().is_empty() {
            next.api_base_url = "http://127.0.0.1:11434".to_string();
        }
        if next.api_protocol.trim().is_empty() {
            next.api_protocol = "auto".to_string();
        }
    }
    if let Some(existing) = settings.channels.iter_mut().find(|item| item.id == next.id) {
        *existing = next.clone();
    } else {
        settings.channels.push(next.clone());
    }
    if next.id == "default" {
        settings.provider_type = next.provider_type.clone();
        settings.api_base_url = next.api_base_url.clone();
        settings.api_key = next.api_key.clone();
        settings.custom_headers = next.custom_headers.clone();
        settings.model = next.default_model.clone();
    }
    connector::save_ide_settings(settings)?;
    Ok(next)
}

#[tauri::command]
pub fn ide_channel_delete(channel_id: String) -> Result<Value, String> {
    let mut settings = connector::load_ide_settings();
    if channel_id == "default" {
        return Err("default channel cannot be deleted; disable or edit it instead".to_string());
    }
    let before = settings.channels.len();
    settings.channels.retain(|channel| channel.id != channel_id);
    for value in settings.default_routes.values_mut() {
        if *value == channel_id {
            *value = "default".to_string();
        }
    }
    connector::save_ide_settings(settings)?;
    Ok(
        json!({ "ok": true, "deleted": before.saturating_sub(connector::load_ide_settings().channels.len()) }),
    )
}

#[tauri::command]
pub async fn ide_channel_test(
    channel_id: String,
    purpose: Option<String>,
) -> Result<IdeAiResponse, String> {
    let settings = connector::load_ide_settings();
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .cloned()
        .or_else(|| route_provider_channel(&settings, purpose.as_deref().unwrap_or("chat"), None))
        .ok_or_else(|| "no testable provider channel found".to_string())?;
    ide_test_provider(settings_for_channel(&settings, &channel, None)).await
}

#[tauri::command]
pub async fn ide_channel_refresh_models(channel_id: String) -> Result<Value, String> {
    let mut settings = connector::load_ide_settings();
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .cloned()
        .ok_or_else(|| "provider channel not found".to_string())?;
    let data = ide_provider_model_refresh(settings_for_channel(&settings, &channel, None)).await?;
    let models = extract_provider_model_names(&data);
    if let Some(target) = settings
        .channels
        .iter_mut()
        .find(|item| item.id == channel_id)
    {
        target.models = models.clone();
        target.last_error.clear();
        target.updated_at = agent_now();
    }
    connector::save_ide_settings(settings)?;
    Ok(json!({ "models": models, "raw": data, "fetchedAt": agent_now() }))
}

#[tauri::command]
pub async fn ide_channel_account_status(channel_id: String) -> Result<Value, String> {
    let mut settings = connector::load_ide_settings();
    let channel = settings
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .cloned()
        .ok_or_else(|| "provider channel not found".to_string())?;
    let data = ide_provider_account_status(settings_for_channel(&settings, &channel, None)).await?;
    if let Some(target) = settings
        .channels
        .iter_mut()
        .find(|item| item.id == channel_id)
    {
        target.account_status = data.to_string();
        target.last_error.clear();
        target.updated_at = agent_now();
    }
    connector::save_ide_settings(settings)?;
    Ok(data)
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
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("snapshot.json");
    let tmp = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        JSON_WRITE_TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let payload = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    fs::write(&tmp, payload).map_err(|err| format!("failed to write session snapshot: {err}"))?;
    if let Err(first_err) = fs::rename(&tmp, path) {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        fs::rename(&tmp, path).map_err(|err| {
            let _ = fs::remove_file(&tmp);
            format!("failed to save session snapshot: {err}; first attempt: {first_err}")
        })?;
    }
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
pub fn ide_open_workspace(
    root_path: String,
    task_id: Option<String>,
    preview_url: Option<String>,
) -> Result<connector::RecentProject, String> {
    let project =
        connector::record_recent_project(&root_path, task_id.as_deref(), preview_url.as_deref())?;
    initialize_autocode_project_files(&project.path)?;
    Ok(project)
}

#[tauri::command]
pub fn ide_initialize_autocode_project_files(root_path: String) -> Result<Value, String> {
    initialize_autocode_project_files(&root_path)
}

fn write_file_if_missing(path: &Path, content: &str) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.to_string_lossy()))?;
    }
    fs::write(path, content)
        .map_err(|err| format!("failed to write {}: {err}", path.to_string_lossy()))?;
    Ok(true)
}

fn initialize_autocode_project_files(root_path: &str) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(root_path)?;
    let dir = root.join(".autocode");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create .autocode directory: {err}"))?;
    let created = vec![
        (
            ".autocode/AGENTS.md",
            write_file_if_missing(&dir.join("AGENTS.md"), DEFAULT_AGENTS_MD)?,
        ),
        (
            ".autocode/memory.md",
            write_file_if_missing(&dir.join("memory.md"), DEFAULT_MEMORY_MD)?,
        ),
        (
            ".autocode/settings.json",
            write_file_if_missing(&dir.join("settings.json"), DEFAULT_AUTOCODE_SETTINGS_JSON)?,
        ),
    ];
    Ok(json!({
        "ok": true,
        "rootPath": root.to_string_lossy(),
        "created": created
            .into_iter()
            .filter_map(|(path, did_create)| did_create.then(|| path))
            .collect::<Vec<_>>()
    }))
}

const DEFAULT_AGENTS_MD: &str = r#"# AutoCode 智能体规则

AutoCode IDE 打开项目时会自动读取这个文件，用它约束当前项目内的智能体行为。

## 项目规则
- 在这里记录项目技术栈、代码风格、重要目录和约定。
- 写清楚哪些命令对本项目是安全且常用的。
- 标出需要谨慎处理的文件、目录或操作，例如生产配置、数据库迁移、密钥文件。

## 常用命令
- 安装依赖：
- 启动开发服务：
- 运行测试：
- 构建：

## 给智能体的注意事项
- 回答项目结构、技术框架、启动方式前，优先读取本地 README、package.json、配置文件和入口文件。
- 修改文件、应用 patch 或运行有风险命令前，必须按权限策略请求确认。
- 不要越过 workspace root 读写文件。
"#;

const DEFAULT_MEMORY_MD: &str = r#"# AutoCode 项目记忆

这个文件用于保存长期有效的项目事实、用户偏好和已经确认过的决策。

## 已确认事实
- 

## 用户偏好
- 

## 决策记录
- 
"#;

const DEFAULT_AUTOCODE_SETTINGS_JSON: &str = r#"{
  "mcpServers": [],
  "permissionPolicy": {},
  "notes": {
    "mcpServers": "椤圭洰绾?MCP 鏈嶅姟閰嶇疆銆傜ず渚嬶細[{\"name\":\"filesystem\",\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"D:/project\"],\"enabled\":true,\"timeoutSecs\":30}]",
    "permissionPolicy": "椤圭洰绾ф潈闄愮瓥鐣ュ娉ㄣ€傚綋鍓?IDE 璁剧疆涓殑鏉冮檺绛栫暐璐熻矗涓昏鎵ц鎺у埗銆?
  }
}
"#;

#[tauri::command]
pub fn ide_list_workspace(
    root_path: String,
    path: Option<String>,
    max_depth: Option<usize>,
) -> Result<Vec<connector::WorkspaceEntry>, String> {
    connector::list_workspace_tree(
        &root_path,
        path.as_deref().unwrap_or(""),
        max_depth.unwrap_or(4),
    )
}

#[tauri::command]
pub async fn ide_workspace_file_index(
    root_path: String,
    max_files: Option<usize>,
) -> Result<connector::WorkspaceFileIndex, String> {
    tokio::task::spawn_blocking(move || {
        connector::list_workspace_file_index(&root_path, max_files.unwrap_or(8000))
    })
    .await
    .map_err(|err| format!("宸ヤ綔鍖烘枃浠剁储寮曚换鍔″け璐ワ細{err}"))?
}

#[tauri::command]
pub fn ide_read_workspace_file(
    root_path: String,
    path: String,
) -> Result<connector::WorkspaceFileSnapshot, String> {
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
pub fn ide_format_workspace_content(
    root_path: String,
    path: String,
    content: String,
    line_ending: Option<String>,
) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    let relative_path = normalize_workspace_relative_path(&path)?;
    let target_path = root.join(&relative_path);
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");

    if let Some((formatter, formatted)) =
        format_with_project_formatter(&root, &target_path, &normalized)?
    {
        let formatted = normalize_formatted_text(&formatted, line_ending.as_deref());
        return Ok(json!({
            "ok": true,
            "changed": formatted != content,
            "formatter": formatter,
            "content": formatted,
            "message": format!("formatted with {formatter}")
        }));
    }

    let extension = target_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (formatter, formatted) = if extension == "json" {
        match serde_json::from_str::<Value>(&normalized) {
            Ok(value) => (
                "built-in json".to_string(),
                serde_json::to_string_pretty(&value)
                    .map_err(|err| format!("JSON format failed: {err}"))?,
            ),
            Err(_) => (
                "safe text cleanup".to_string(),
                cleanup_text_for_save(&normalized),
            ),
        }
    } else {
        (
            "safe text cleanup".to_string(),
            cleanup_text_for_save(&normalized),
        )
    };
    let formatted = normalize_formatted_text(&formatted, line_ending.as_deref());
    Ok(json!({
        "ok": true,
        "changed": formatted != content,
        "formatter": formatter,
        "content": formatted,
        "message": if formatter == "safe text cleanup" {
            "safe text cleanup applied"
        } else {
            "formatted"
        }
    }))
}

fn normalize_workspace_relative_path(path: &str) -> Result<PathBuf, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("file path is required".to_string());
    }
    if Path::new(&normalized).is_absolute() {
        return Err("format path must be relative to workspace root".to_string());
    }
    let mut clean = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("format path cannot leave workspace root".to_string());
        }
        clean.push(part);
    }
    Ok(clean)
}

fn cleanup_text_for_save(content: &str) -> String {
    let mut lines = content
        .split('\n')
        .map(|line| line.trim_end().to_string())
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

fn normalize_formatted_text(content: &str, line_ending: Option<&str>) -> String {
    let mut text = content.replace("\r\n", "\n").replace('\r', "\n");
    while text.ends_with('\n') {
        text.pop();
    }
    if !text.is_empty() {
        text.push('\n');
    }
    if matches!(
        line_ending.map(str::to_ascii_lowercase).as_deref(),
        Some("crlf")
    ) {
        text.replace('\n', "\r\n")
    } else {
        text
    }
}

fn format_with_project_formatter(
    root: &Path,
    target_path: &Path,
    content: &str,
) -> Result<Option<(String, String)>, String> {
    let Some(formatter_kind) = formatter_kind_for_path(target_path) else {
        return Ok(None);
    };
    let target = target_path.to_string_lossy().to_string();
    if formatter_kind == "web" {
        if let Some(prettier) = formatter_command(root, "prettier") {
            return run_stdin_formatter(
                root,
                target_path,
                &prettier,
                "prettier",
                &["--stdin-filepath"],
                content,
            )
            .map(Some);
        }
        if let Some(biome) = formatter_command(root, "biome") {
            return run_stdin_formatter(
                root,
                target_path,
                &biome,
                "biome",
                &["format", "--stdin-file-path"],
                content,
            )
            .map(Some);
        }
    }
    if formatter_kind == "python" {
        if let Some(ruff) = formatter_command(root, "ruff") {
            return run_stdin_formatter_args(
                root,
                &ruff,
                "ruff format",
                vec![
                    "format".to_string(),
                    "--stdin-filename".to_string(),
                    target.clone(),
                    "-".to_string(),
                ],
                content,
            )
            .map(Some);
        }
        if let Some(black) = formatter_command(root, "black") {
            return run_stdin_formatter_args(
                root,
                &black,
                "black",
                vec![
                    "--quiet".to_string(),
                    "--stdin-filename".to_string(),
                    target.clone(),
                    "-".to_string(),
                ],
                content,
            )
            .map(Some);
        }
    }
    if formatter_kind == "go" {
        if let Some(gofmt) = formatter_command(root, "gofmt") {
            return run_stdin_formatter_args(root, &gofmt, "gofmt", vec![], content).map(Some);
        }
    }
    if formatter_kind == "rust" {
        if let Some(rustfmt) = formatter_command(root, "rustfmt") {
            return run_stdin_formatter_args(
                root,
                &rustfmt,
                "rustfmt",
                vec!["--emit".to_string(), "stdout".to_string()],
                content,
            )
            .map(Some);
        }
    }
    if matches!(formatter_kind, "clang" | "java") {
        if let Some(clang_format) = formatter_command(root, "clang-format") {
            return run_stdin_formatter_args(
                root,
                &clang_format,
                "clang-format",
                vec![format!("--assume-filename={target}")],
                content,
            )
            .map(Some);
        }
    }
    Ok(None)
}

fn formatter_kind_for_path(path: &Path) -> Option<&'static str> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "js" | "jsx"
            | "ts"
            | "tsx"
            | "mjs"
            | "cjs"
            | "json"
            | "css"
            | "scss"
            | "less"
            | "html"
            | "vue"
            | "svelte"
            | "md"
            | "mdx"
            | "yaml"
            | "yml"
            | "graphql"
            | "gql"
    ) || matches!(
        name.as_str(),
        "package.json" | "tsconfig.json" | "jsconfig.json"
    ) {
        Some("web")
    } else if matches!(extension.as_str(), "py" | "pyi" | "pyw") {
        Some("python")
    } else if extension == "go" {
        Some("go")
    } else if extension == "rs" {
        Some("rust")
    } else if matches!(
        extension.as_str(),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "m" | "mm" | "proto"
    ) {
        Some("clang")
    } else if extension == "java" {
        Some("java")
    } else {
        None
    }
}

fn formatter_command(root: &Path, name: &str) -> Option<PathBuf> {
    local_node_bin(root, name)
        .or_else(|| local_python_bin(root, name))
        .or_else(|| command_on_path(name))
}

fn local_node_bin(root: &Path, name: &str) -> Option<PathBuf> {
    let bin_dir = root.join("node_modules").join(".bin");
    let candidates = if cfg!(windows) {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    candidates
        .into_iter()
        .map(|candidate| bin_dir.join(candidate))
        .find(|path| path.exists())
}

fn local_python_bin(root: &Path, name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        for env_dir in [".venv", "venv"] {
            candidates.push(
                root.join(env_dir)
                    .join("Scripts")
                    .join(format!("{name}.exe")),
            );
            candidates.push(
                root.join(env_dir)
                    .join("Scripts")
                    .join(format!("{name}.cmd")),
            );
            candidates.push(root.join(env_dir).join("Scripts").join(name));
        }
    } else {
        for env_dir in [".venv", "venv"] {
            candidates.push(root.join(env_dir).join("bin").join(name));
        }
    }
    candidates.into_iter().find(|path| path.exists())
}

fn command_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let candidates = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&path_var).find_map(|dir| {
        candidates
            .iter()
            .map(|candidate| dir.join(candidate))
            .find(|path| path.exists())
    })
}

fn run_stdin_formatter(
    root: &Path,
    target_path: &Path,
    command_path: &Path,
    label: &str,
    args_before_path: &[&str],
    content: &str,
) -> Result<(String, String), String> {
    let mut args = args_before_path
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    args.push(target_path.to_string_lossy().to_string());
    run_stdin_formatter_args(root, command_path, label, args, content)
}

fn run_stdin_formatter_args(
    root: &Path,
    command_path: &Path,
    label: &str,
    args: Vec<String>,
    content: &str,
) -> Result<(String, String), String> {
    let mut command = Command::new(command_path);
    command.current_dir(shell_path(root));
    for arg in args {
        command.arg(arg);
    }
    command
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
        .map_err(|err| format!("鍚姩 {label} 鏍煎紡鍖栧け璐ワ細{err}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|err| format!("鍐欏叆 {label} 鏍煎紡鍖栬緭鍏ュけ璐ワ細{err}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("绛夊緟 {label} 鏍煎紡鍖栧け璐ワ細{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() && !stdout.is_empty() {
        Ok((label.to_string(), stdout))
    } else {
        Err(format!(
            "{label} 鏍煎紡鍖栧け璐ワ細{}",
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        ))
    }
}

#[tauri::command]
pub fn ide_run_workspace_command(
    root_path: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<connector::WorkspaceCommandResult, String> {
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
        let use_powershell =
            normalized_shell.contains("powershell") || normalized_shell.contains("pwsh");
        let mut cmd = if use_powershell {
            Command::new(if normalized_shell.contains("pwsh") {
                "pwsh.exe"
            } else {
                "powershell.exe"
            })
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
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll terminal command: {err}"))?
        {
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
    if (target.starts_with('"') && target.ends_with('"'))
        || (target.starts_with('\'') && target.ends_with('\''))
    {
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
pub async fn ide_git_status(root_path: String) -> Result<connector::WorkspaceGitStatus, String> {
    tokio::task::spawn_blocking(move || connector::read_workspace_git_status_light(&root_path))
        .await
        .map_err(|err| format!("Git 鐘舵€佷换鍔″け璐ワ細{err}"))?
}

#[tauri::command]
pub async fn ide_git_init(root_path: String) -> Result<connector::WorkspaceGitStatus, String> {
    tokio::task::spawn_blocking(move || connector::initialize_git_repository(&root_path))
        .await
        .map_err(|err| format!("Git 鍒濆鍖栦换鍔″け璐ワ細{err}"))?
}

#[tauri::command]
pub async fn ide_git_stage(
    root_path: String,
    paths: Option<Vec<String>>,
) -> Result<connector::WorkspaceGitStatus, String> {
    tokio::task::spawn_blocking(move || {
        connector::stage_git_paths(&root_path, paths.unwrap_or_default())
    })
    .await
    .map_err(|err| format!("Git stage task failed: {err}"))?
}

#[tauri::command]
pub async fn ide_git_unstage(
    root_path: String,
    paths: Option<Vec<String>>,
) -> Result<connector::WorkspaceGitStatus, String> {
    tokio::task::spawn_blocking(move || {
        connector::unstage_git_paths(&root_path, paths.unwrap_or_default())
    })
    .await
    .map_err(|err| format!("Git unstage task failed: {err}"))?
}

#[tauri::command]
pub async fn ide_git_commit(
    root_path: String,
    message: String,
) -> Result<connector::WorkspaceGitStatus, String> {
    tokio::task::spawn_blocking(move || connector::commit_git_changes(&root_path, &message))
        .await
        .map_err(|err| format!("Git commit task failed: {err}"))?
}

#[tauri::command]
pub async fn ide_git_file_diff(
    root_path: String,
    path: String,
    staged: Option<bool>,
) -> Result<Value, String> {
    let diff_path = path.clone();
    let staged_value = staged.unwrap_or(false);
    let diff = tokio::task::spawn_blocking(move || {
        connector::read_git_file_diff(&root_path, &diff_path, staged_value)
    })
    .await
    .map_err(|err| format!("Git diff task failed: {err}"))??;
    Ok(json!({ "path": path, "staged": staged_value, "diff": diff }))
}

#[tauri::command]
pub async fn ide_git_commit_show(root_path: String, commit_hash: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || connector::show_git_commit(&root_path, &commit_hash))
        .await
        .map_err(|err| format!("Git commit show task failed: {err}"))?
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
        .timeout(Duration::from_secs(
            timeout_secs.unwrap_or(20).clamp(3, 120),
        ))
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
        request = request
            .header("Content-Type", "application/json")
            .body(body);
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
        return Err(format!(
            "AutoCode API returned {}: {}",
            status.as_u16(),
            detail
        ));
    }
    Ok(parsed)
}

fn provider_base(settings: &connector::IdeSettings) -> Result<String, String> {
    let base = settings
        .api_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
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
    provider_adapter(settings.provider_type.as_str())
        .default_model
        .to_string()
}

fn normalize_api_protocol(protocol: &str) -> String {
    protocol
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace('/', "_")
}

fn is_local_openai_provider(provider: &str) -> bool {
    matches!(provider.trim(), "local-openai-compatible" | "ollama")
}

fn provider_adapter_for_settings(settings: &connector::IdeSettings) -> ProviderAdapter {
    let mut adapter = provider_adapter(settings.provider_type.as_str());
    match normalize_api_protocol(&settings.api_protocol).as_str() {
        "response" | "responses" | "openai_responses" => {
            adapter.payload_kind = ProviderPayloadKind::Responses;
            adapter.capabilities.tool_result_messages = false;
        }
        "chat" | "chat_completion" | "chat_completions" | "openai_chat_completions" => {
            adapter.payload_kind = ProviderPayloadKind::ChatCompletions;
            adapter.capabilities.tool_result_messages = true;
        }
        _ if is_local_openai_provider(settings.provider_type.as_str()) => {
            adapter.payload_kind = ProviderPayloadKind::Responses;
            adapter.capabilities.tool_result_messages = false;
        }
        _ => {}
    }
    adapter
}

fn local_auto_responses(settings: &connector::IdeSettings) -> bool {
    is_local_openai_provider(settings.provider_type.as_str())
        && matches!(
            normalize_api_protocol(&settings.api_protocol).as_str(),
            "" | "auto"
        )
        && provider_adapter_for_settings(settings).payload_kind == ProviderPayloadKind::Responses
}

fn local_chat_fallback_settings(settings: &connector::IdeSettings) -> connector::IdeSettings {
    let mut next = settings.clone();
    next.provider_type = "custom-openai-compatible".to_string();
    next.api_protocol = "chat_completions".to_string();
    next
}

fn request_settings_for_protocol(settings: connector::IdeSettings) -> connector::IdeSettings {
    if is_local_openai_provider(settings.provider_type.as_str())
        && matches!(
            normalize_api_protocol(&settings.api_protocol).as_str(),
            "chat" | "chat_completion" | "chat_completions" | "openai_chat_completions"
        )
    {
        local_chat_fallback_settings(&settings)
    } else {
        settings
    }
}

fn responses_fallback_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 404 | 405 | 501)
}

fn provider_error_detail(parsed: &Value, text: &str) -> String {
    parsed
        .get("message")
        .or_else(|| parsed.get("detail"))
        .or_else(|| parsed.get("error"))
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("message").and_then(Value::as_str))
        })
        .unwrap_or(text)
        .to_string()
}

fn endpoint_for(settings: &connector::IdeSettings) -> Result<String, String> {
    let base = provider_base(settings)?;
    let provider = settings.provider_type.as_str();
    let path = match provider_adapter_for_settings(settings).payload_kind {
        ProviderPayloadKind::Responses => "/v1/responses",
        ProviderPayloadKind::AnthropicMessages => "/v1/messages",
        ProviderPayloadKind::ChatCompletions => {
            if matches!(provider, "deepseek" | "zhipu") && !base.ends_with("/v1") {
                "/chat/completions"
            } else {
                "/v1/chat/completions"
            }
        }
    };
    if base.ends_with("/chat/completions")
        || base.ends_with("/responses")
        || base.ends_with("/messages")
    {
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

fn local_provider_root_url(settings: &connector::IdeSettings) -> Result<String, String> {
    let mut base = provider_base(settings)?;
    for suffix in [
        "/v1/chat/completions",
        "/chat/completions",
        "/v1/responses",
        "/responses",
        "/v1/messages",
        "/messages",
        "/v1",
    ] {
        if base.ends_with(suffix) {
            base.truncate(base.len().saturating_sub(suffix.len()));
            break;
        }
    }
    Ok(base.trim_end_matches('/').to_string())
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
        "xhigh" | "max" | "extreme" | "\u{6781}\u{9ad8}" => "high",
        "\u{4f4e}" => "low",
        "\u{4e2d}" => "medium",
        "\u{9ad8}" => "high",
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

fn openai_chat_reasoning_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
        || model.starts_with("gpt-5")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderPayloadKind {
    Responses,
    ChatCompletions,
    AnthropicMessages,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
struct ProviderCapabilities {
    native_tools: bool,
    stream_tool_calls: bool,
    reasoning_content: bool,
    vision_input: bool,
    file_input: bool,
    built_in_web_tools: bool,
    tool_result_messages: bool,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
struct ProviderAdapter {
    provider_type: &'static str,
    payload_kind: ProviderPayloadKind,
    default_model: &'static str,
    capabilities: ProviderCapabilities,
}

impl ProviderAdapter {
    fn chat_tool_messages(self) -> bool {
        self.capabilities.tool_result_messages
            && matches!(self.payload_kind, ProviderPayloadKind::ChatCompletions)
    }
}

fn provider_adapter(provider: &str) -> ProviderAdapter {
    let chat_native = ProviderCapabilities {
        native_tools: true,
        stream_tool_calls: true,
        reasoning_content: false,
        vision_input: true,
        file_input: false,
        built_in_web_tools: false,
        tool_result_messages: true,
    };
    match provider {
        "openai-responses" => ProviderAdapter {
            provider_type: "openai-responses",
            payload_kind: ProviderPayloadKind::Responses,
            default_model: "gpt-4o-mini",
            capabilities: ProviderCapabilities {
                native_tools: true,
                stream_tool_calls: true,
                reasoning_content: true,
                vision_input: true,
                file_input: true,
                built_in_web_tools: false,
                tool_result_messages: false,
            },
        },
        "local-openai-compatible" | "ollama" => ProviderAdapter {
            provider_type: "local-openai-compatible",
            payload_kind: ProviderPayloadKind::Responses,
            default_model: "llama3.1",
            capabilities: ProviderCapabilities {
                native_tools: true,
                stream_tool_calls: true,
                reasoning_content: false,
                vision_input: false,
                file_input: false,
                built_in_web_tools: false,
                tool_result_messages: false,
            },
        },
        "qwen-responses" => ProviderAdapter {
            provider_type: "qwen-responses",
            payload_kind: ProviderPayloadKind::Responses,
            default_model: "qwen-plus",
            capabilities: ProviderCapabilities {
                native_tools: true,
                stream_tool_calls: true,
                reasoning_content: true,
                vision_input: true,
                file_input: true,
                built_in_web_tools: true,
                tool_result_messages: false,
            },
        },
        "anthropic-messages" => ProviderAdapter {
            provider_type: "anthropic-messages",
            payload_kind: ProviderPayloadKind::AnthropicMessages,
            default_model: "claude-sonnet-4-5",
            capabilities: ProviderCapabilities {
                native_tools: true,
                stream_tool_calls: true,
                reasoning_content: true,
                vision_input: true,
                file_input: false,
                built_in_web_tools: false,
                tool_result_messages: false,
            },
        },
        "dashscope-qwen" => ProviderAdapter {
            provider_type: "dashscope-qwen",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "qwen-plus",
            capabilities: ProviderCapabilities {
                reasoning_content: true,
                ..chat_native
            },
        },
        "deepseek" => ProviderAdapter {
            provider_type: "deepseek",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "deepseek-v4-flash",
            capabilities: ProviderCapabilities {
                reasoning_content: true,
                ..chat_native
            },
        },
        "kimi" => ProviderAdapter {
            provider_type: "kimi",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "kimi-k3",
            capabilities: ProviderCapabilities {
                reasoning_content: true,
                ..chat_native
            },
        },
        "zhipu" => ProviderAdapter {
            provider_type: "zhipu",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "glm-4.6",
            capabilities: ProviderCapabilities {
                reasoning_content: true,
                ..chat_native
            },
        },
        "openai-chat" => ProviderAdapter {
            provider_type: "openai-chat",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "gpt-4o-mini",
            capabilities: chat_native,
        },
        "custom-openai-compatible" => ProviderAdapter {
            provider_type: "custom-openai-compatible",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "gpt-4o-mini",
            capabilities: chat_native,
        },
        "xai-grok" => ProviderAdapter {
            provider_type: "xai-grok",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "grok-4",
            capabilities: ProviderCapabilities {
                native_tools: false,
                stream_tool_calls: false,
                reasoning_content: true,
                vision_input: true,
                file_input: false,
                built_in_web_tools: false,
                tool_result_messages: false,
            },
        },
        _ => ProviderAdapter {
            provider_type: "openai-chat",
            payload_kind: ProviderPayloadKind::ChatCompletions,
            default_model: "gpt-4o-mini",
            capabilities: chat_native,
        },
    }
}

fn kimi_reasoning_effort(settings: &connector::IdeSettings) -> Option<String> {
    effort_value(settings).map(|effort| match effort.as_str() {
        "low" => "low".to_string(),
        "high" => "high".to_string(),
        _ => "max".to_string(),
    })
}

fn extract_data_images(content: &str) -> (String, Vec<(String, String, String)>) {
    let mut text_lines = Vec::new();
    let mut images = Vec::new();
    for line in content.lines() {
        if let Some(url) = line.strip_prefix("image_data_url=").map(str::trim) {
            if let Some(rest) = url.strip_prefix("data:") {
                if let Some((mime, data)) = rest.split_once(";base64,") {
                    images.push((url.to_string(), mime.to_string(), data.to_string()));
                    text_lines.push("[image attachment included]");
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
    if matches!(
        provider,
        "openai-responses" | "qwen-responses" | "local-openai-compatible" | "ollama" | "xai-grok"
    ) {
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
            let role = match message.role.as_str() {
                "system" => "system",
                "assistant" => "assistant",
                "tool" => "tool",
                _ => "user",
            };
            let mut item = json!({
                "role": role,
                "content": message_content_for_provider(provider, &message.content)
            });
            if role == "tool" && !message.tool_call_id.trim().is_empty() {
                item["tool_call_id"] = Value::String(message.tool_call_id.clone());
            }
            if role == "assistant" && !message.tool_calls.is_empty() {
                item["tool_calls"] = Value::Array(message.tool_calls.clone());
                if !message.reasoning_content.trim().is_empty() {
                    item["reasoning_content"] = Value::String(message.reasoning_content.clone());
                }
            }
            item
        })
        .collect()
}

fn build_ai_payload(settings: &connector::IdeSettings, request: &IdeAiRequest) -> Value {
    let provider = settings.provider_type.as_str();
    let adapter = provider_adapter_for_settings(settings);
    let model = provider_model(settings);
    let max_tokens = request.max_tokens.unwrap_or(4096).clamp(512, 128000);
    let effort = effort_value(settings);
    if adapter.payload_kind == ProviderPayloadKind::Responses {
        let mut body = json!({
            "model": model,
            "input": chat_messages(provider, &request.messages),
            "max_output_tokens": max_tokens
        });
        if provider == "qwen-responses" {
            if let Some(effort) = effort {
                body["enable_thinking"] = Value::Bool(true);
                body["thinking_budget"] = json!(match effort.as_str() {
                    "low" => 2048,
                    "high" => 16000,
                    _ => 8192,
                });
            }
        } else if let Some(effort) = effort {
            body["reasoning"] = json!({
                "effort": effort,
                "summary": if settings.reasoning_summary { "auto" } else { "none" }
            });
        }
        return body;
    }
    if adapter.payload_kind == ProviderPayloadKind::AnthropicMessages {
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
                body["thinking"] = json!({ "type": "enabled" });
                body["reasoning_effort"] = Value::String(effort);
            }
        }
        "kimi" => {
            if let Some(effort) = kimi_reasoning_effort(settings) {
                body["reasoning_effort"] = Value::String(effort);
            }
        }
        "zhipu" => {
            if let Some(effort) = effort {
                body["thinking"] = json!({ "type": "enabled" });
                body["reasoning_effort"] = Value::String(effort);
            }
        }
        "xai-grok" => {
            if let Some(effort) = effort {
                body["reasoning_effort"] = Value::String(effort);
            }
        }
        "openai-chat" => {
            if let Some(effort) = effort.filter(|_| openai_chat_reasoning_model(&model)) {
                body["reasoning_effort"] = Value::String(effort);
            }
        }
        _ => {
            if let Some(effort) = effort {
                if openai_chat_reasoning_model(&model) {
                    body["reasoning_effort"] = Value::String(effort);
                }
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

fn strip_dsml_tool_blocks(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<DSML-tool_calls>") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start..];
        if let Some(end) = after_start.find("</DSML-tool_calls>") {
            rest = &after_start[end + "</DSML-tool_calls>".len()..];
        } else {
            rest = "";
            break;
        }
    }
    output.push_str(rest);
    output.trim().to_string()
}

fn looks_like_cjk_mojibake(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch as u32, 0xfffd | 0x951f | 0x95ff | 0x95c1))
}

fn repair_cjk_mojibake(text: &str) -> String {
    if !looks_like_cjk_mojibake(text) {
        return text.to_string();
    }
    let (bytes, _, _) = encoding_rs::GB18030.encode(text);
    let Ok(candidate) = String::from_utf8(bytes.into_owned()) else {
        return text.to_string();
    };
    if candidate
        .chars()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .count()
        >= 4
    {
        candidate
    } else {
        text.to_string()
    }
}

fn extract_dsml_tool_calls(text: &str) -> Vec<Value> {
    let mut calls = Vec::new();
    let mut rest = text;
    while let Some(invoke_start) = rest.find("<DSML-invoke") {
        rest = &rest[invoke_start..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        let name = tag
            .split("name=\"")
            .nth(1)
            .and_then(|value| value.split('"').next())
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(invoke_end) = rest.find("</DSML-invoke>") else {
            break;
        };
        let body = &rest[tag_end + 1..invoke_end];
        let mut input = serde_json::Map::new();
        let mut body_rest = body;
        while let Some(param_start) = body_rest.find("<DSML-parameter") {
            body_rest = &body_rest[param_start..];
            let Some(param_tag_end) = body_rest.find('>') else {
                break;
            };
            let param_tag = &body_rest[..param_tag_end];
            let param_name = param_tag
                .split("name=\"")
                .nth(1)
                .and_then(|value| value.split('"').next())
                .unwrap_or("value")
                .trim()
                .to_string();
            let Some(param_end) = body_rest.find("</DSML-parameter>") else {
                break;
            };
            let raw_value = body_rest[param_tag_end + 1..param_end].trim();
            input.insert(param_name, Value::String(raw_value.to_string()));
            body_rest = &body_rest[param_end + "</DSML-parameter>".len()..];
        }
        if !name.is_empty() {
            let tool = match name.as_str() {
                "read_file" => "read",
                "write_file" => "write",
                other => other,
            };
            if let Some(value) = input.remove("file_path") {
                input.insert("path".to_string(), value);
            }
            calls.push(json!({
                "tool": tool,
                "input": Value::Object(input),
                "source": "deepseek_dsml"
            }));
        }
        rest = &rest[invoke_end + "</DSML-invoke>".len()..];
    }
    calls
}

fn parse_ai_response(provider: &str, model: &str, value: Value) -> IdeAiResponse {
    let value = value.get("response").cloned().unwrap_or(value);
    let answer_raw = value
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .pointer("/choices/0/message/content")
                .map(collect_text)
        })
        .or_else(|| value.pointer("/content").map(collect_text))
        .or_else(|| {
            let text = collect_response_output_text(&value);
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        })
        .unwrap_or_else(|| collect_text(&value));
    let mut tool_calls = value
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let dsml_calls = extract_dsml_tool_calls(&answer_raw);
    if !dsml_calls.is_empty() {
        tool_calls.extend(dsml_calls);
    }
    let answer = repair_cjk_mojibake(&strip_dsml_tool_blocks(&answer_raw));
    let reasoning = value
        .pointer("/choices/0/message/reasoning_content")
        .map(collect_text)
        .or_else(|| {
            value
                .pointer("/choices/0/message/reasoning")
                .map(collect_text)
        })
        .or_else(|| value.get("reasoning").map(collect_text))
        .or_else(|| value.pointer("/output/0/summary").map(collect_text))
        .map(|text| repair_cjk_mojibake(&text))
        .unwrap_or_default();
    let finish_reason = value
        .pointer("/choices/0/finish_reason")
        .or_else(|| value.get("stop_reason"))
        .or_else(|| value.get("finish_reason"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
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
    let mut http = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity");
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

fn agent_tool_schema(
    name: &str,
    description: &str,
    properties: Value,
    required: Vec<&str>,
) -> Value {
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
            json!({
                "items": {
                    "type": "array",
                    "items": {
                        "anyOf": [
                            { "type": "string" },
                            {
                                "type": "object",
                                "properties": {
                                    "text": { "type": "string" },
                                    "status": { "type": "string" },
                                    "source": { "type": "string" }
                                }
                            }
                        ]
                    }
                }
            }),
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
            "memory_update",
            "Propose a patch for .autocode memory files when durable project facts, user preferences, or decisions should be remembered. User approval is always required.",
            json!({
                "patch": {
                    "type": "string",
                    "description": "Unified diff or Codex patch targeting only .autocode/AGENTS.md, .autocode/memory.md, or .autocode/settings.json."
                },
                "reason": {
                    "type": "string",
                    "description": "Why this memory update is useful for future turns."
                }
            }),
            vec!["patch"],
        ),
        agent_tool_schema(
            "write",
            "Replace or create a UTF-8 text file inside the workspace with full content. User approval is required.",
            json!({
                "path": { "type": "string", "description": "Workspace-relative file path." },
                "content": { "type": "string", "description": "Complete target file content." }
            }),
            vec!["path", "content"],
        ),
        agent_tool_schema(
            "question",
            "Ask the user for missing information when local tools cannot resolve it.",
            json!({
                "question": { "type": "string" },
                "options": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string" },
                            "value": { "type": "string" },
                            "kind": { "type": "string" }
                        }
                    }
                },
                "placeholder": { "type": "string" }
            }),
            vec!["question"],
        ),
        agent_tool_schema(
            "diagnostics",
            "Run a safe project diagnostics command such as typecheck, lint, build, cargo check, or return why none is configured.",
            json!({ "scope": { "type": "string", "description": "Optional area such as workspace, frontend, backend." } }),
            vec![],
        ),
        agent_tool_schema(
            "test_runner",
            "Run the project's detected test command if one is configured.",
            json!({ "scope": { "type": "string" }, "timeoutSecs": { "type": "integer" } }),
            vec![],
        ),
        agent_tool_schema(
            "symbol_search",
            "Search likely symbols, function names, classes, files, and references in the workspace.",
            json!({ "query": { "type": "string" }, "limit": { "type": "integer" } }),
            vec!["query"],
        ),
        agent_tool_schema(
            "process_manager",
            "Manage Agent-controlled background processes such as dev servers. start runs a safe long-lived command after permission policy approval; kill stops a managed process.",
            json!({
                "action": { "type": "string", "enum": ["list", "start", "kill"] },
                "command": { "type": "string", "description": "Command to start for action=start, for example npm run dev." },
                "processId": { "type": "string", "description": "Managed process id for action=kill." }
            }),
            vec![],
        ),
        agent_tool_schema(
            "browser_preview",
            "Check a local development preview URL. Only localhost, 127.0.0.1, and ::1 HTTP URLs are allowed.",
            json!({
                "url": { "type": "string", "description": "Local preview URL such as http://localhost:5173." },
                "timeoutSecs": { "type": "integer" }
            }),
            vec!["url"],
        ),
        agent_tool_schema(
            "lsp",
            "Request lightweight local language intelligence: diagnostics, symbols, definition, references, hover, or rename preview.",
            json!({ "method": { "type": "string", "enum": ["diagnostics", "workspace/symbol", "definition", "references", "hover", "rename"] }, "params": { "type": "object" } }),
            vec!["method"],
        ),
        agent_tool_schema(
            "mcp_call",
            "Call a configured MCP server tool through stdio JSON-RPC. User approval is required.",
            json!({
                "server": { "type": "string", "description": "Configured MCP server name." },
                "tool": { "type": "string", "description": "MCP tool name to invoke." },
                "arguments": { "type": "object", "description": "MCP tool arguments." }
            }),
            vec!["server", "tool"],
        ),
    ]
}

fn sanitize_tool_schema_for_provider(provider: &str, mut tool: Value) -> Value {
    if !matches!(
        provider,
        "deepseek"
            | "kimi"
            | "zhipu"
            | "dashscope-qwen"
            | "qwen-responses"
            | "local-openai-compatible"
            | "ollama"
    ) {
        return tool;
    }
    fn sanitize_value(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("strict");
                map.remove("minItems");
                map.remove("maxItems");
                map.remove("minLength");
                map.remove("maxLength");
                map.remove("pattern");
                map.remove("$schema");
                for child in map.values_mut() {
                    sanitize_value(child);
                }
            }
            Value::Array(items) => {
                for child in items {
                    sanitize_value(child);
                }
            }
            _ => {}
        }
    }
    sanitize_value(&mut tool);
    tool
}

fn agent_tool_registry(
    root_path: Option<&str>,
    profile_id: &str,
    settings: &connector::IdeSettings,
) -> Value {
    let builtins = agent_native_tool_specs()
        .into_iter()
        .map(|schema| {
            let name = schema.get("name").and_then(Value::as_str).unwrap_or("tool");
            let decision = permission_policy_for_tool(profile_id, Some(settings), name);
            let risk = if decision == "deny" {
                "high"
            } else if matches!(name, "bash" | "write" | "apply_patch") {
                "medium"
            } else {
                "low"
            };
            json!({
                "id": name,
                "name": name,
                "kind": "builtin",
                "description": schema.get("description").cloned().unwrap_or(Value::String(String::new())),
                "schema": schema,
                "permission": decision,
                "risk": risk,
                "implemented": true
            })
        })
        .collect::<Vec<_>>();
    let mut mcp_tools = Vec::new();
    if let Some(root) = root_path.filter(|value| !value.trim().is_empty()) {
        let project_settings = project_autocode_settings(root);
        let mut servers = Vec::new();
        if let Some(items) = settings.mcp_servers.as_array() {
            servers.extend(items.iter().cloned());
        }
        if let Some(items) = project_settings
            .get("mcpServers")
            .or_else(|| project_settings.get("mcp_servers"))
            .and_then(Value::as_array)
        {
            servers.extend(items.iter().cloned());
        }
        for (index, server) in servers.into_iter().enumerate() {
            if !mcp_server_enabled(&server) {
                continue;
            }
            let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
            mcp_tools.push(json!({
                "id": format!("mcp:{name}:{index}"),
                "name": name,
                "kind": "mcp",
                "server": server,
                "permission": "ask",
                "risk": "medium",
                "implemented": true,
                "callTool": "mcp_call",
                "message": "MCP server is configured and can be called through mcp_call after approval."
            }));
        }
    }
    let builtin_count = builtins.len();
    let mcp_count = mcp_tools.len();
    json!({
        "profileId": profile_id,
        "approvalMode": settings.approval_mode,
        "tools": builtins,
        "mcpTools": mcp_tools,
        "counts": {
            "builtin": builtin_count,
            "mcp": mcp_count
        }
    })
}

fn builtin_agent_profiles() -> Vec<Value> {
    vec![
        json!({
            "id": "build",
            "label": "Build",
            "kind": "primary",
            "description": "Default coding agent. Reads project context, proposes edits, requests approval for writes and commands, and validates changes.",
            "defaultTools": ["read_file", "glob", "grep", "git_diff", "todowrite", "bash", "write", "apply_patch", "memory_update", "diagnostics", "test_runner", "symbol_search", "process_manager", "browser_preview", "lsp", "mcp_call"],
            "writePolicy": "ask"
        }),
        json!({
            "id": "plan",
            "label": "Plan",
            "kind": "primary",
            "description": "Read-only planning agent. Produces implementation plans and risk notes without applying changes.",
            "defaultTools": ["read_file", "glob", "grep", "git_diff", "todowrite", "symbol_search", "lsp", "question"],
            "writePolicy": "deny"
        }),
        json!({
            "id": "explore",
            "label": "Explore",
            "kind": "subagent",
            "description": "Scans project structure, key configs, memory, and entry points to build a compact evidence summary.",
            "defaultTools": ["git_diff", "glob", "read_file"],
            "writePolicy": "deny"
        }),
        json!({
            "id": "review",
            "label": "Review",
            "kind": "subagent",
            "description": "Reviews Git diff and likely issue markers, returning findings with evidence.",
            "defaultTools": ["git_diff", "grep", "read_file", "lsp"],
            "writePolicy": "deny"
        }),
        json!({
            "id": "debug",
            "label": "Debug",
            "kind": "subagent",
            "description": "Runs safe diagnostics and inspects managed processes to isolate failures.",
            "defaultTools": ["diagnostics", "process_manager", "browser_preview", "grep", "read_file", "write"],
            "writePolicy": "ask"
        }),
        json!({
            "id": "test",
            "label": "Test",
            "kind": "subagent",
            "description": "Detects and runs configured test commands through the controlled runner.",
            "defaultTools": ["test_runner", "diagnostics", "read_file"],
            "writePolicy": "ask"
        }),
        json!({
            "id": "refactor",
            "label": "Refactor",
            "kind": "subagent",
            "description": "Finds refactor opportunities and risk boundaries; changes still require approval.",
            "defaultTools": ["grep", "glob", "read_file", "symbol_search", "lsp", "write"],
            "writePolicy": "ask"
        }),
        json!({
            "id": "docs",
            "label": "Docs",
            "kind": "subagent",
            "description": "Summarizes documentation gaps and project-facing explanations.",
            "defaultTools": ["grep", "glob", "read_file", "memory_update"],
            "writePolicy": "deny"
        }),
    ]
}

fn agent_profile_registry(settings: &connector::IdeSettings) -> Value {
    let mut profiles = builtin_agent_profiles();
    if let Some(configured) = settings.agent_profiles.as_array() {
        for item in configured {
            let id = item
                .get("id")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if id.is_empty()
                || profiles
                    .iter()
                    .any(|profile| profile.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                continue;
            }
            profiles.push(json!({
                "id": id,
                "label": item.get("label").or_else(|| item.get("name")).and_then(Value::as_str).unwrap_or("Custom Agent"),
                "kind": item.get("kind").and_then(Value::as_str).unwrap_or("custom"),
                "description": item.get("description").and_then(Value::as_str).unwrap_or("Configured local Agent profile."),
                "defaultTools": item.get("defaultTools").or_else(|| item.get("tools")).cloned().unwrap_or_else(|| json!([])),
                "writePolicy": item.get("writePolicy").or_else(|| item.get("write_policy")).and_then(Value::as_str).unwrap_or("ask"),
                "configured": true
            }));
        }
    }
    let primary = profiles
        .iter()
        .filter(|profile| profile.get("kind").and_then(Value::as_str) == Some("primary"))
        .cloned()
        .collect::<Vec<_>>();
    let subagents = profiles
        .iter()
        .filter(|profile| profile.get("kind").and_then(Value::as_str) != Some("primary"))
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "ok": true,
        "approvalMode": settings.approval_mode,
        "profiles": profiles,
        "primary": primary,
        "subagents": subagents
    })
}

#[tauri::command]
pub fn ide_agent_profiles(settings: connector::IdeSettings) -> Result<Value, String> {
    Ok(agent_profile_registry(&settings))
}

fn agent_profile_system_contract(profile_id: &str) -> &'static str {
    let normalized_profile = profile_id.to_ascii_lowercase();
    match normalized_profile.as_str() {
        "plan" => {
            "Profile contract: Planning mode.\n- Planning mode has exactly one product goal: produce a user-confirmed executable development plan, save it as a plan, generate Todo, and let the user start development from that plan. Advisory-only analysis, comparison reports, generic suggestions, or documentation-only endings are forbidden as final answers.\n- Legal end states are only: (1) call the question tool to confirm requirements, or (2) after user confirmation, output a complete executable development plan. Plain analysis/recommendation-only text is invalid and must not be emitted as the final answer.\n- Do not edit project files, do not update memory, do not run unsafe commands, do not ask for write approval, and do not call todowrite before the final confirmed plan.\n- First inspect enough read-only project context to avoid asking discoverable questions. Never claim a file, feature, tool, or IDE behavior exists unless it was present in explicit context or verified with read-only tools.\n- Unless the user explicitly says no confirmation is needed, your first planning turn MUST call the question tool to confirm the development target and scope. Do not skip this because the topic looks understandable.\n- Every planning question tool call MUST include one clear question, exactly 2-3 concrete options, and a placeholder for free-form user input. The recommended option must be first.\n- If the user answers with a new question, objection, alternative, or extra constraint, answer/absorb it and then ask another question card until no open user question remains.\n- Only after implementation requirements are confirmed should you produce the executable development plan.\n- The final plan content must be Chinese, but the five top-level Markdown headings must keep these exact standard labels, in this exact order: Summary（摘要）, Key Changes（关键改动）, Public Interfaces（公共接口）, Test Plan（测试计划）, Assumptions（假设）.\n- Each required heading must be present exactly once as a top-level section heading. Do not replace them with translated-only headings such as 总结, 优化方向, 后续建议, 验证方式, or 需要确认.\n- Under Public Interfaces（公共接口）, write None（无） if there are no user-facing API, setting, command, event, storage, or UI contract changes.\n- Do not end with phrases like \"如果你愿意\", \"下一步可以\", \"你可以手动输入\", \"落盘为文档\", or \"更新 AGENTS.md\". Planning mode itself must produce the plan, not ask the user to manually request another mode.\n- For executable development plans only, call todowrite with a concise task list using items like {\"text\":\"...\",\"status\":\"pending\",\"source\":\"plan\"}. Include validation items from Test Plan.\n- Mention that implementation starts only when the user clicks or asks to develop from the executable plan."
        }
        "build" => {
            "Profile contract: Build mode.\n- If the user message contains EXECUTE_APPROVED_PLAN or an approved plan/task list, you are in executing_plan mode: execute the plan, do not re-plan it.\n- First call todowrite with the provided implementation tasks and statuses.\n- Then immediately locate relevant source files and perform the first incomplete Todo using tools.\n- Do not write planning documents, do not output generic suggestions, and do not end while Todos remain incomplete unless you are blocked by approval, a user question, a tool error, cancellation, or step/context limits.\n- Ask questions only when execution would otherwise be unsafe, the target file/module is missing, or the approved plan is materially ambiguous."
        }
        "debug" => {
            "Profile contract: Debug mode.\n- Start with a short diagnostic path and a minimal reproduction/check Todo.\n- Prefer read-only evidence first, then run targeted diagnostics or fixes with approval as required."
        }
        "review" => {
            "Profile contract: Review mode.\n- Prioritize findings by severity with file/line evidence where possible.\n- Maintain a review checklist with todowrite when the review spans multiple files or tests."
        }
        "test" => {
            "Profile contract: Test mode.\n- Create a small test matrix and validation Todo before running tests.\n- Report which checks passed, failed, or were skipped."
        }
        "docs" | "doc" => {
            "Profile contract: Documentation mode.\n- Produce a documentation outline and missing-doc checklist before drafting or updating docs.\n- Keep project-facing explanations concise and actionable."
        }
        "refactor" => {
            "Profile contract: Refactor mode.\n- Preserve behavior by default. Create a refactor Todo that separates mechanical cleanup, behavior checks, and validation.\n- Ask before broad rewrites that affect public APIs."
        }
        _ => "",
    }
}

fn agent_profile_turn_contract(profile_id: &str, workspace_context: &Value) -> String {
    if !profile_id.eq_ignore_ascii_case("plan") {
        return String::new();
    }
    let answers_count = workspace_context
        .pointer("/sessionSnapshot/planningAnswers")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    if answers_count == 0 {
        [
            "PLAN_MODE_START_PROTOCOL",
            "This is a planning-mode request, not a normal analysis/chat request.",
            "The first visible result for this turn must be a question tool call unless the user explicitly wrote that no confirmation is needed.",
            "The question tool call must contain one clear question, exactly 2-3 options, recommended option first, and a free-form placeholder.",
            "Confirm the concrete development target, scope, and acceptance path. If read-only inspection is needed, inspect first, then end the turn with the question tool.",
            "Do not output advisory analysis, comparison reports, generic suggestions, or a final plan before the question-card confirmation exists.",
        ]
        .join("\n")
    } else {
        [
            "PLAN_MODE_FINALIZE_PROTOCOL",
            "The user has already answered a planning question card. Produce the confirmed executable development plan now.",
            "Do not output advisory analysis, comparison reports, generic suggestions, or phrases such as 如果你愿意 / 下一步可以.",
            "The final plan content must be Chinese and must use these exact top-level headings in order:",
            "Summary（摘要）",
            "Key Changes（关键改动）",
            "Public Interfaces（公共接口）",
            "Test Plan（测试计划）",
            "Assumptions（假设）",
            "Call todowrite with executable tasks after the final plan is known.",
        ]
        .join("\n")
    }
}

fn enable_agent_native_tools(provider: &str, payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let adapter = provider_adapter(provider);
    let specs = agent_native_tool_specs()
        .into_iter()
        .map(|tool| sanitize_tool_schema_for_provider(provider, tool))
        .collect::<Vec<_>>();
    match adapter.payload_kind {
        ProviderPayloadKind::Responses => {
            let mut tools = Vec::new();
            if adapter.capabilities.built_in_web_tools {
                tools.push(json!({ "type": "web_search" }));
                tools.push(json!({ "type": "web_extractor" }));
            }
            tools.extend(
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
                    .collect::<Vec<_>>(),
            );
            object.insert("tools".to_string(), Value::Array(tools));
            object.insert("tool_choice".to_string(), Value::String("auto".to_string()));
        }
        ProviderPayloadKind::ChatCompletions => {
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
            if provider == "zhipu" {
                object.insert("tool_stream".to_string(), Value::Bool(true));
            }
        }
        ProviderPayloadKind::AnthropicMessages => {
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
    }
}

fn agent_should_use_native_tools(provider: &str, _model: &str) -> bool {
    provider_adapter(provider).capabilities.native_tools
}

fn enable_agent_step_protocol(provider: &str, payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    match provider {
        "xai-grok" => {
            object.remove("tools");
            object.remove("tool_choice");
            object.insert(
                "response_format".to_string(),
                json!({ "type": "json_object" }),
            );
        }
        _ => {}
    }
}

fn stream_text_delta(provider: &str, value: &Value) -> (String, String, Value, String) {
    let mut answer = String::new();
    let mut reasoning = String::new();
    let mut usage = Value::Null;
    let mut finish_reason = String::new();

    if matches!(
        provider,
        "openai-responses" | "qwen-responses" | "local-openai-compatible" | "ollama"
    ) {
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(
            event_type,
            "response.output_text.delta" | "response.refusal.delta"
        ) {
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
            delta
                .get("reasoning_content")
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

fn responses_stream_event_is_terminal(event_type: &str) -> bool {
    matches!(
        event_type,
        "response.completed" | "response.incomplete" | "response.failed" | "response.cancelled"
    )
}

fn parse_native_tool_arguments(arguments: &str) -> Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str::<Value>(trimmed).unwrap_or_else(|_| json!({ "raw": arguments }))
}

fn native_tool_request(
    name: String,
    arguments: String,
    id: String,
    provider: &str,
) -> Option<Value> {
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
            "openai-responses" | "qwen-responses" | "local-openai-compatible" | "ollama" => {
                self.feed_openai_responses(value, provider)
            }
            "anthropic-messages" => self.feed_anthropic(value),
            _ if provider_adapter(provider).chat_tool_messages() => {
                self.feed_openai_chat(provider, value)
            }
            _ => None,
        }
    }

    fn feed_openai_responses(&mut self, value: &Value, provider: &str) -> Option<Vec<Value>> {
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(
            event_type,
            "response.output_item.added" | "response.output_item.done"
        ) {
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
                            provider,
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
                provider,
            ) {
                return Some(vec![request]);
            }
        }
        None
    }

    fn feed_openai_chat(&mut self, provider: &str, value: &Value) -> Option<Vec<Value>> {
        if let Some(calls) = value
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
        {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let draft = self.openai_chat.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    draft.id = id.to_string();
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    draft.name = name.to_string();
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str)
                {
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
                        if draft.id.is_empty() {
                            format!("tool_call_{key}")
                        } else {
                            draft.id.clone()
                        },
                        provider,
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
                        if let Some(input) = block.get("input").filter(|input| {
                            !input.is_null()
                                && !input
                                    .as_object()
                                    .map(|object| object.is_empty())
                                    .unwrap_or(false)
                        }) {
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
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let (delta, reasoning_delta, next_usage, next_finish) = stream_text_delta(provider, &value);
        if !delta.is_empty() {
            answer.push_str(&delta);
            pending_answer_delta.push_str(&delta);
        }
        if !reasoning_delta.is_empty() {
            reasoning.push_str(&reasoning_delta);
            pending_reasoning_delta.push_str(&reasoning_delta);
        }
        flush_ai_stream_deltas(
            app,
            session_id,
            pending_answer_delta,
            pending_reasoning_delta,
            last_emit,
            false,
        );
        if next_usage != Value::Null {
            *usage = next_usage;
        }
        if !next_finish.is_empty() {
            *finish_reason = next_finish;
        }
        if responses_stream_event_is_terminal(event_type) {
            return true;
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
        agent_emit(
            app,
            session_id,
            "message_delta",
            json!({
                "role": "assistant",
                "kind": "text",
                "content": content
            }),
        );
    }
    if !pending_reasoning_delta.is_empty() {
        let content = std::mem::take(pending_reasoning_delta);
        agent_emit(
            app,
            session_id,
            "reasoning_delta",
            json!({
                "content": content
            }),
        );
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
    let settings = request_settings_for_protocol(settings);
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
                format!(
                    "Cannot connect to AI Provider: {url}. Please check URL and service status."
                )
            } else {
                format!("AI stream request failed: {err}")
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let parsed =
            serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
        let detail = provider_error_detail(&parsed, text.as_str());
        if local_auto_responses(&settings) && responses_fallback_status(status) {
            let fallback = local_chat_fallback_settings(&settings);
            return Box::pin(stream_ai_request(app, session_id, fallback, request))
                .await
                .map_err(|err| {
                    format!(
                        "Responses endpoint unsupported (HTTP {}: {}); Chat Completions fallback failed: {}",
                        status.as_u16(),
                        detail,
                        err
                    )
                });
        }
        return Err(format!(
            "AI Provider returned {}: {}",
            status.as_u16(),
            detail
        ));
    }
    agent_emit_phase(
        app,
        session_id,
        "streaming",
        "running",
        "Provider accepted request",
        "Provider accepted the request; waiting for text or tool calls",
    );
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
    let mut stream_read_error = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                if answer.trim().is_empty()
                    && reasoning.trim().is_empty()
                    && pending_answer_delta.trim().is_empty()
                    && pending_reasoning_delta.trim().is_empty()
                {
                    return Err(format!("AI stream read failed: {err}"));
                }
                stream_read_error =
                    format!("AI stream read interrupted after partial output: {err}");
                break;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if buffer.contains("\r\n") {
            buffer = buffer.replace("\r\n", "\n");
        }
        // Process each SSE data line as soon as it arrives; keep incomplete tail in buffer.
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
                agent_emit(
                    app,
                    session_id,
                    "message_delta",
                    json!({
                        "role": "assistant",
                        "kind": "text",
                        "content": answer.clone()
                    }),
                );
                break;
            }
        }
    }

    if answer.trim().is_empty() {
        return Err("stream completed without text".to_string());
    }
    if !stream_read_error.is_empty() && finish_reason.is_empty() {
        finish_reason = "stream_read_error".to_string();
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
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(tool_requests) = native_tools.feed(provider, &value) {
            flush_ai_stream_deltas(
                app,
                session_id,
                pending_answer_delta,
                pending_reasoning_delta,
                last_emit,
                true,
            );
            return AgentStreamFrameOutcome::Tool(tool_requests);
        }
        let (delta, reasoning_delta, next_usage, next_finish) = stream_text_delta(provider, &value);
        if !delta.is_empty() {
            let detection = detector.feed(&delta);
            if !detection.visible_delta.is_empty() {
                answer.push_str(&detection.visible_delta);
                pending_answer_delta.push_str(&detection.visible_delta);
            }
            flush_ai_stream_deltas(
                app,
                session_id,
                pending_answer_delta,
                pending_reasoning_delta,
                last_emit,
                false,
            );
            if let Some(tool_requests) = detection.tool_requests {
                flush_ai_stream_deltas(
                    app,
                    session_id,
                    pending_answer_delta,
                    pending_reasoning_delta,
                    last_emit,
                    true,
                );
                return AgentStreamFrameOutcome::Tool(tool_requests);
            }
        }
        if !reasoning_delta.is_empty() {
            reasoning.push_str(&reasoning_delta);
            pending_reasoning_delta.push_str(&reasoning_delta);
        }
        flush_ai_stream_deltas(
            app,
            session_id,
            pending_answer_delta,
            pending_reasoning_delta,
            last_emit,
            false,
        );
        if next_usage != Value::Null {
            *usage = next_usage;
        }
        if !next_finish.is_empty() {
            *finish_reason = next_finish;
        }
        if responses_stream_event_is_terminal(event_type) {
            return AgentStreamFrameOutcome::Done;
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
    let settings = request_settings_for_protocol(settings);
    let provider = settings.provider_type.trim().to_string();
    let model = provider_model(&settings);
    let url = endpoint_for(&settings)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|err| format!("failed to create agent stream client: {err}"))?;
    let mut payload = build_ai_payload(&settings, &request);
    enable_streaming(&mut payload);
    if agent_should_use_native_tools(&provider, &model) {
        enable_agent_native_tools(&provider, &mut payload);
    } else {
        enable_agent_step_protocol(&provider, &mut payload);
    }
    let cancel_token = agent_cancel_token_for(app, session_id);
    if cancel_token.load(Ordering::SeqCst) {
        return Err("agent cancelled by user".to_string());
    }
    let send = ai_http_request(&client, &url, &settings, &provider)
        .json(&payload)
        .send();
    let response = tokio::select! {
        _ = wait_agent_cancel_token(cancel_token.clone()) => {
            return Err("agent cancelled by user".to_string());
        }
        result = send => result.map_err(|err| {
            if err.is_timeout() {
                format!("agent stream request timed out: {url}")
            } else if err.is_connect() {
                format!(
                    "Cannot connect to AI Provider: {url}. Please check URL and service status."
                )
            } else {
                format!("agent stream request failed: {err}")
            }
        })?
    };
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let parsed =
            serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
        let detail = provider_error_detail(&parsed, text.as_str());
        if local_auto_responses(&settings) && responses_fallback_status(status) {
            agent_emit(
                app,
                session_id,
                "provider_retry",
                json!({
                    "channel": "Local model",
                    "model": model.clone(),
                    "reason": format!("Responses endpoint unsupported (HTTP {}); retrying Chat Completions.", status.as_u16()),
                }),
            );
            let fallback = local_chat_fallback_settings(&settings);
            return Box::pin(stream_agent_model_turn(app, session_id, fallback, request))
                .await
                .map_err(|err| {
                    format!(
                        "Responses endpoint unsupported (HTTP {}: {}); Chat Completions fallback failed: {}",
                        status.as_u16(),
                        detail,
                        err
                    )
                });
        }
        return Err(format!(
            "AI Provider returned {}: {}",
            status.as_u16(),
            detail
        ));
    }
    agent_emit_phase(
        app,
        session_id,
        "streaming",
        "running",
        "Provider accepted request",
        "Provider accepted the request; waiting for text or tool calls",
    );

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
    let mut stream_read_error = String::new();

    while let Some(chunk) = stream.next().await {
        if cancel_token.load(Ordering::SeqCst) || agent_session_is_cancel_requested(app, session_id)
        {
            return Err("agent cancelled by user".to_string());
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                if answer.trim().is_empty()
                    && reasoning.trim().is_empty()
                    && pending_answer_delta.trim().is_empty()
                    && pending_reasoning_delta.trim().is_empty()
                    && tool_requests.is_empty()
                {
                    return Err(format!("agent stream read failed: {err}"));
                }
                stream_read_error =
                    format!("agent stream read interrupted after partial output: {err}");
                break;
            }
        };
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
            if !parsed.tool_calls.is_empty() {
                tool_requests =
                    native_tool_requests_from_chat_message(&provider, &parsed.tool_calls);
                if !tool_requests.is_empty() {
                    if reasoning.trim().is_empty() {
                        reasoning = parsed.reasoning_summary;
                    }
                    if usage == Value::Null {
                        usage = parsed.usage;
                    }
                    if finish_reason.is_empty() {
                        finish_reason = parsed.finish_reason;
                    }
                    break;
                }
            }
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
                agent_emit(
                    app,
                    session_id,
                    "message_delta",
                    json!({
                        "role": "assistant",
                        "kind": "text",
                        "content": answer.clone()
                    }),
                );
                break;
            }
        }
    }

    if answer.trim().is_empty() && tool_requests.is_empty() {
        return Err("agent stream completed without text or tool call".to_string());
    }
    if !stream_read_error.is_empty() && finish_reason.is_empty() {
        finish_reason = "stream_read_error".to_string();
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

async fn ide_ai_request_single(
    settings: connector::IdeSettings,
    request: IdeAiRequest,
    _stream: Option<bool>,
    agent_tools: bool,
    cancel_token: Option<Arc<AtomicBool>>,
) -> Result<IdeAiResponse, String> {
    let settings = request_settings_for_protocol(settings);
    let provider = settings.provider_type.trim().to_string();
    let model = provider_model(&settings);
    let url = endpoint_for(&settings)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|err| format!("failed to create AI client: {err}"))?;
    let mut payload = build_ai_payload(&settings, &request);
    if agent_tools {
        if agent_should_use_native_tools(&provider, &model) {
            enable_agent_native_tools(&provider, &mut payload);
        } else {
            enable_agent_step_protocol(&provider, &mut payload);
        }
    }
    if cancel_token
        .as_ref()
        .map(|token| token.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        return Err("agent cancelled by user".to_string());
    }
    let send = ai_http_request(&client, &url, &settings, &provider)
        .json(&payload)
        .send();
    let response = if let Some(token) = cancel_token.clone() {
        tokio::select! {
            _ = wait_agent_cancel_token(token) => {
                return Err("agent cancelled by user".to_string());
            }
            result = send => result
        }
    } else {
        send.await
    }
    .map_err(|err| {
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
    let parsed =
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        let detail = provider_error_detail(&parsed, text.as_str());
        if local_auto_responses(&settings) && responses_fallback_status(status) {
            let fallback = local_chat_fallback_settings(&settings);
            return Box::pin(ide_ai_request_single(
                fallback,
                request,
                _stream,
                agent_tools,
                cancel_token,
            ))
            .await
            .map_err(|err| {
                format!(
                    "Responses endpoint unsupported (HTTP {}: {}); Chat Completions fallback failed: {}",
                    status.as_u16(),
                    detail,
                    err
                )
            });
        }
        return Err(format!(
            "AI Provider returned {}: {}",
            status.as_u16(),
            detail
        ));
    }
    Ok(parse_ai_response(&provider, &model, parsed))
}

#[tauri::command]
pub async fn ide_ai_request(
    settings: connector::IdeSettings,
    request: IdeAiRequest,
    stream: Option<bool>,
) -> Result<IdeAiResponse, String> {
    if settings.channels.is_empty() {
        return ide_ai_request_single(settings, request, stream, false, None).await;
    }
    let model = settings.model.trim().to_string();
    let candidates = provider_channel_candidates(&settings, "chat", Some(model.as_str()));
    if candidates.is_empty() {
        return Err(if model.is_empty() {
            "No enabled chat provider channel is configured.".to_string()
        } else {
            format!("No enabled channel provides model {model}. Refresh or enable it in channel management.")
        });
    }
    let mut errors = Vec::new();
    for channel in candidates {
        let routed = settings_for_channel(&settings, &channel, Some(model.as_str()));
        match ide_ai_request_single(routed, request.clone(), stream, false, None).await {
            Ok(response) => return Ok(response),
            Err(error) => errors.push(format!("{}: {}", channel.name, error)),
        }
    }
    Err(format!(
        "All candidate channels failed: {}",
        errors.join(" | ")
    ))
}

#[tauri::command]
pub async fn ide_test_provider(settings: connector::IdeSettings) -> Result<IdeAiResponse, String> {
    ide_ai_request(
        settings,
        IdeAiRequest {
            messages: vec![IdeAiMessage::new("user", "Reply with exactly: ok")],
            temperature: Some(0.0),
            max_tokens: Some(128),
        },
        Some(false),
    )
    .await
}

fn clean_code_completion_text(answer: &str, line_prefix: &str) -> String {
    let mut text = answer.trim().trim_start_matches("```").trim().to_string();
    if let Some(index) = text.find('\n') {
        let first = text[..index].trim().to_ascii_lowercase();
        if matches!(
            first.as_str(),
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "typescript"
                | "javascript"
                | "rust"
                | "python"
                | "html"
                | "css"
                | "json"
        ) {
            text = text[index + 1..].to_string();
        }
    }
    if let Some(stripped) = text.strip_suffix("```") {
        text = stripped.to_string();
    }
    if !line_prefix.is_empty() && text.starts_with(line_prefix) {
        text = text[line_prefix.len()..].to_string();
    }
    text.lines()
        .take(12)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

#[tauri::command]
pub async fn ide_code_completion(request: Value) -> Result<Value, String> {
    let settings = connector::load_ide_settings();
    if !settings.code_completion.enabled {
        return Ok(json!({ "text": "", "message": "AI code completion is disabled." }));
    }
    let path = request.get("path").and_then(Value::as_str).unwrap_or("");
    let language = request
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let prefix = request.get("prefix").and_then(Value::as_str).unwrap_or("");
    let suffix = request.get("suffix").and_then(Value::as_str).unwrap_or("");
    let line_prefix = request
        .get("linePrefix")
        .or_else(|| request.get("line_prefix"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let requested_model = settings.code_completion.model.trim().to_string();
    let candidates = provider_channel_candidates(
        &settings,
        "codeCompletion",
        if requested_model.is_empty() {
            None
        } else {
            Some(requested_model.as_str())
        },
    );
    if candidates.is_empty() {
        return Err("No enabled channel is configured for code completion.".to_string());
    }
    let started = Instant::now();
    let completion_prompt = if settings.code_completion.prompt.trim().is_empty() {
        CodeCompletionPrompt::default_text().to_string()
    } else {
        settings.code_completion.prompt.clone()
    };
    let prompt = [
        completion_prompt.as_str(),
        "",
        &format!("File: {path}"),
        &format!("Language: {language}"),
        "",
        "<before_cursor>",
        prefix,
        "</before_cursor>",
        "<after_cursor>",
        suffix,
        "</after_cursor>",
        "",
        &format!("Current line prefix: {line_prefix}"),
    ]
    .join("\n");
    let ai_request = IdeAiRequest {
        messages: vec![
            IdeAiMessage::new(
                "system",
                "Return only inline code completion text. No prose. No Markdown fences.",
            ),
            IdeAiMessage::new("user", prompt),
        ],
        temperature: Some(0.0),
        max_tokens: Some(160),
    };
    let mut errors = Vec::new();
    for channel in candidates {
        let channel_model = if !requested_model.is_empty() {
            requested_model.clone()
        } else if !channel.code_completion_model.trim().is_empty() {
            channel.code_completion_model.clone()
        } else {
            channel.default_model.clone()
        };
        let mut routed = settings_for_channel(&settings, &channel, Some(channel_model.as_str()));
        routed.reasoning_mode = "off".to_string();
        match ide_ai_request_single(routed, ai_request.clone(), Some(false), false, None).await {
            Ok(response) => {
                return Ok(json!({
                    "text": clean_code_completion_text(&response.answer, line_prefix),
                    "channelId": channel.id,
                    "channelName": channel.name,
                    "model": response.model,
                    "durationMs": started.elapsed().as_millis() as u64
                }))
            }
            Err(error) => errors.push(format!("{}: {}", channel.name, error)),
        }
    }
    Err(format!(
        "Code completion failed across all enabled channels: {}",
        errors.join(" | ")
    ))
}

struct CodeCompletionPrompt;

impl CodeCompletionPrompt {
    fn default_text() -> &'static str {
        "You are AutoCode IDE inline code completion engine. Return only the code that should be inserted at the cursor. No prose. No Markdown fences. Do not repeat existing prefix text."
    }
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
            request = request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        } else {
            request = request.bearer_auth(key);
        }
    }
    for (name, value) in settings.custom_headers.iter() {
        if !name.trim().is_empty() && !value.trim().is_empty() {
            request = request.header(name.trim(), value.trim());
        }
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("model list request failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("failed to read model list: {err}"))?;
    let parsed =
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        if is_local_openai_provider(settings.provider_type.as_str())
            && responses_fallback_status(status)
        {
            let tags_url = format!("{}/api/tags", local_provider_root_url(&settings)?);
            let mut tags_request = client.get(&tags_url);
            let key = settings.api_key.trim();
            if !key.is_empty() {
                tags_request = tags_request.bearer_auth(key);
            }
            for (name, value) in settings.custom_headers.iter() {
                if !name.trim().is_empty() && !value.trim().is_empty() {
                    tags_request = tags_request.header(name.trim(), value.trim());
                }
            }
            let tags_response = tags_request
                .send()
                .await
                .map_err(|err| format!("model list fallback request failed: {err}"))?;
            let tags_status = tags_response.status();
            let tags_text = tags_response
                .text()
                .await
                .map_err(|err| format!("failed to read model list fallback: {err}"))?;
            let tags_parsed = serde_json::from_str::<Value>(&tags_text)
                .unwrap_or_else(|_| Value::String(tags_text.clone()));
            if tags_status.is_success() {
                return Ok(tags_parsed);
            }
            return Err(format!(
                "model list returned {} from /v1/models and {} from /api/tags: {}",
                status.as_u16(),
                tags_status.as_u16(),
                tags_text
            ));
        }
        return Err(format!("model list returned {}: {}", status.as_u16(), text));
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn ide_provider_model_refresh(settings: connector::IdeSettings) -> Result<Value, String> {
    ide_list_provider_models(settings).await
}

#[tauri::command]
pub async fn ide_provider_account_status(
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    let path = match settings.provider_type.as_str() {
        "deepseek" => "/user/balance",
        "kimi" => "/v1/users/me/balance",
        "xai-grok" => "/v1/language-models",
        _ => {
            return Ok(json!({
                "supported": false,
                "provider": settings.provider_type,
                "message": "This provider does not expose an account balance endpoint."
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
    let response = request
        .send()
        .await
        .map_err(|err| format!("account status request failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("failed to read account status: {err}"))?;
    let parsed =
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        return Err(format!(
            "account status returned {}: {}",
            status.as_u16(),
            text
        ));
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

fn tail_chars(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    if total <= max_chars {
        return value.to_string();
    }
    value
        .chars()
        .skip(total.saturating_sub(max_chars))
        .collect()
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

fn agent_tool_call_ok(call: &Value) -> bool {
    call.get("status").and_then(Value::as_str).unwrap_or("ok") != "error"
        && call
            .get("error")
            .and_then(Value::as_str)
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
}

fn agent_tool_call_error(call: &Value) -> String {
    call.get("error")
        .and_then(Value::as_str)
        .unwrap_or("宸ュ叿鎵ц澶辫触")
        .to_string()
}

fn agent_emit(app: &AppHandle, session_id: &str, event_type: &str, payload: Value) {
    let event_id = {
        let state = app.state::<IdeRuntimeState>();
        state.next_agent_event_id.fetch_add(1, Ordering::SeqCst) + 1
    };
    let payload = if session_id.is_empty()
        || payload.get("requestId").is_some()
        || payload.get("request_id").is_some()
    {
        payload
    } else {
        let request_id = {
            let state = app.state::<IdeRuntimeState>();
            let sessions = state.agent_sessions.lock().unwrap();
            sessions
                .get(session_id)
                .and_then(|session| session.get("activeRequestId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        if let Some(request_id) = request_id.filter(|value| !value.trim().is_empty()) {
            let mut next = payload;
            if let Some(object) = next.as_object_mut() {
                object.insert("requestId".to_string(), Value::String(request_id));
            }
            next
        } else {
            payload
        }
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
    let _ = app.emit("ide://agent-event", event.clone());
    let _ = app.emit("ide-agent-event", event);
}

fn agent_emit_phase(
    app: &AppHandle,
    session_id: &str,
    phase: &str,
    status: &str,
    label: &str,
    detail: &str,
) {
    agent_emit(
        app,
        session_id,
        "agent_phase",
        json!({
            "phase": phase,
            "status": status,
            "label": label,
            "detail": detail,
            "startedAt": agent_now()
        }),
    );
}

fn agent_session_active_request_id(app: &AppHandle, session_id: &str) -> String {
    let state = app.state::<IdeRuntimeState>();
    let sessions = state.agent_sessions.lock().unwrap();
    sessions
        .get(session_id)
        .and_then(|session| session.get("activeRequestId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn agent_session_storage_dir() -> PathBuf {
    ide_data_dir().join("agent-sessions")
}

fn agent_session_snapshot_path(session_id: &str) -> PathBuf {
    let safe = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    agent_session_storage_dir().join(format!("{safe}.json"))
}

const AGENT_SESSION_LOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;
const AGENT_SESSION_PERSIST_MAX_STRING_CHARS: usize = 240_000;
const AGENT_SESSION_PERSIST_MAX_MESSAGE_CHARS: usize = 80_000;

fn agent_checkpoint_storage_dir(session_id: &str) -> PathBuf {
    agent_session_storage_dir().join("checkpoints").join(
        session_id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>(),
    )
}

fn persist_agent_session_value(session: &Value) {
    if let Some(session_id) = session.get("id").and_then(Value::as_str) {
        let snapshot = compact_agent_session_for_persist(session);
        let _ = write_json_pretty(&agent_session_snapshot_path(session_id), &snapshot);
    }
}

fn truncate_json_string(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated = value.chars().take(max_chars).collect::<String>();
    format!("{truncated}\n...[truncated by AutoCode session persistence]")
}

fn truncate_agent_json_strings(value: &mut Value, max_chars: usize, depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        Value::String(text) => {
            if text.chars().count() > max_chars {
                *text = truncate_json_string(text, max_chars);
            }
        }
        Value::Array(items) => {
            for item in items {
                truncate_agent_json_strings(item, max_chars, depth + 1);
            }
        }
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                let child_limit = match key.as_str() {
                    "text" | "content" | "output" | "result" | "error" | "reasoning"
                    | "summary" => AGENT_SESSION_PERSIST_MAX_MESSAGE_CHARS,
                    _ => max_chars,
                };
                truncate_agent_json_strings(child, child_limit, depth + 1);
            }
        }
        _ => {}
    }
}

fn trim_agent_array_field(session: &mut Value, key: &str, keep: usize) {
    let Some(items) = session.get_mut(key).and_then(Value::as_array_mut) else {
        return;
    };
    if items.len() > keep {
        let remove_count = items.len().saturating_sub(keep);
        items.drain(0..remove_count);
    }
}

fn compact_agent_session_for_persist(session: &Value) -> Value {
    let mut snapshot = session.clone();
    trim_agent_array_field(&mut snapshot, "messages", 36);
    trim_agent_array_field(&mut snapshot, "toolCalls", 120);
    trim_agent_array_field(&mut snapshot, "events", 120);
    trim_agent_array_field(&mut snapshot, "timeline", 120);
    trim_agent_array_field(&mut snapshot, "permissions", 40);
    trim_agent_array_field(&mut snapshot, "patchPreviews", 8);
    trim_agent_array_field(&mut snapshot, "checkpoints", 30);
    trim_agent_array_field(&mut snapshot, "subagents", 30);
    trim_agent_array_field(&mut snapshot, "processes", 30);
    trim_agent_array_field(&mut snapshot, "memoryRefs", 40);
    trim_agent_array_field(&mut snapshot, "diagnostics", 80);
    truncate_agent_json_strings(&mut snapshot, AGENT_SESSION_PERSIST_MAX_STRING_CHARS, 0);
    snapshot
}

fn agent_session_numeric_id(session_id: &str) -> Option<u64> {
    session_id.strip_prefix("agent-")?.parse::<u64>().ok()
}

fn normalize_loaded_agent_session(mut session: Value) -> Value {
    let status = session
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_string();
    let pending_tools = session
        .get("pendingTools")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let pending_continuation = session
        .get("pendingContinuation")
        .map(|value| !value.is_null())
        .unwrap_or(false);
    let approved_tool_running = session
        .get("approvedToolRunning")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cancel_requested = session
        .get("cancelRequested")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recovered_at = agent_now();
    if let Some(obj) = session.as_object_mut() {
        if cancel_requested || status == "cancelling" {
            obj.insert("status".to_string(), Value::String("cancelled".to_string()));
            obj.insert("cancelRequested".to_string(), Value::Bool(false));
            obj.insert("cancelRequestedAt".to_string(), Value::Null);
            obj.insert("pendingTools".to_string(), json!([]));
            obj.insert("pendingContinuation".to_string(), Value::Null);
            obj.insert("pendingQuestion".to_string(), Value::Null);
            obj.insert("activeRequestId".to_string(), Value::String(String::new()));
            obj.insert("recoveredAt".to_string(), Value::String(recovered_at));
            obj.insert(
                "resumeReason".to_string(),
                Value::String(
                    "Recovered an interrupted cancellation and finalized it.".to_string(),
                ),
            );
        } else if approved_tool_running
            || pending_tools
            || matches!(
                status.as_str(),
                "running" | "compacting" | "waiting_permission"
            )
        {
            obj.insert("status".to_string(), Value::String("failed".to_string()));
            obj.insert("cancelRequested".to_string(), Value::Bool(false));
            obj.insert("cancelRequestedAt".to_string(), Value::Null);
            obj.insert("approvedToolRunning".to_string(), Value::Bool(false));
            obj.insert("pendingTools".to_string(), json!([]));
            obj.insert("pendingContinuation".to_string(), Value::Null);
            obj.insert("pendingQuestion".to_string(), Value::Null);
            obj.insert("activeRequestId".to_string(), Value::String(String::new()));
            obj.insert("recoveredAt".to_string(), Value::String(recovered_at));
            obj.insert(
                "resumeReason".to_string(),
                Value::String(
                    "Recovered a stale Agent runtime after app restart; pending actions were cleared."
                        .to_string(),
                ),
            );
        } else if pending_continuation && status != "paused_step_limit" {
            obj.insert("status".to_string(), Value::String("paused".to_string()));
            obj.insert("approvedToolRunning".to_string(), Value::Bool(false));
            obj.insert("activeRequestId".to_string(), Value::String(String::new()));
            obj.insert("recoveredAt".to_string(), Value::String(recovered_at));
            obj.insert(
                "resumeReason".to_string(),
                Value::String(
                    "Recovered an interrupted Agent run; user can continue or fork the session."
                        .to_string(),
                ),
            );
        }
        obj.entry("pendingTools".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("pendingContinuation".to_string())
            .or_insert(Value::Null);
        obj.entry("toolCalls".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("messages".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("permissions".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("checkpoints".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("subagents".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("processes".to_string())
            .or_insert_with(|| json!([]));
        obj.entry("activeRequestId".to_string())
            .or_insert(Value::String(String::new()));
        obj.entry("lastRequestId".to_string())
            .or_insert(Value::String(String::new()));
    }
    session
}

fn load_persisted_agent_sessions(state: &State<'_, IdeRuntimeState>) {
    let dir = agent_session_storage_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut sessions = state.agent_sessions.lock().unwrap();
    let mut max_id = state.next_agent_id.load(Ordering::SeqCst);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(file_id) = path.file_stem().and_then(|value| value.to_str()) {
            if let Some(numeric) = agent_session_numeric_id(file_id) {
                max_id = max_id.max(numeric);
            }
        }
        if path
            .metadata()
            .map(|metadata| metadata.len() > AGENT_SESSION_LOAD_MAX_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(id) = session
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        if let Some(numeric) = agent_session_numeric_id(&id) {
            max_id = max_id.max(numeric);
        }
        let normalized = normalize_loaded_agent_session(session);
        persist_agent_session_value(&normalized);
        sessions.entry(id).or_insert(normalized);
    }
    state.next_agent_id.store(max_id, Ordering::SeqCst);
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

fn set_agent_session_status(app: &AppHandle, session_id: &str, status: &str) {
    update_agent_session(app, session_id, |session| {
        let current = session.get("status").and_then(Value::as_str).unwrap_or("");
        // Forced cancel must not be overwritten by a late model/tool completion.
        if current == "cancelled" && status != "cancelled" {
            return;
        }
        if session
            .get("cancelRequested")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && status == "running"
        {
            session["status"] = Value::String("cancelling".to_string());
            return;
        }
        session["status"] = Value::String(status.to_string());
    });
}

fn agent_session_is_cancel_requested(app: &AppHandle, session_id: &str) -> bool {
    if agent_cancel_token_for(app, session_id).load(Ordering::SeqCst) {
        return true;
    }
    let state = app.state::<IdeRuntimeState>();
    let sessions = state.agent_sessions.lock().unwrap();
    sessions
        .get(session_id)
        .map(|session| {
            session
                .get("cancelRequested")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || session
                    .get("status")
                    .and_then(Value::as_str)
                    .map(|status| matches!(status, "cancelling" | "cancelled"))
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn agent_cancel_token_for(app: &AppHandle, session_id: &str) -> Arc<AtomicBool> {
    let state = app.state::<IdeRuntimeState>();
    let mut tokens = state.agent_cancel_tokens.lock().unwrap();
    tokens
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn reset_agent_cancel_token(app: &AppHandle, session_id: &str) {
    agent_cancel_token_for(app, session_id).store(false, Ordering::SeqCst);
}

fn request_agent_cancellation_token(app: &AppHandle, session_id: &str) {
    agent_cancel_token_for(app, session_id).store(true, Ordering::SeqCst);
}

async fn wait_agent_cancel_token(token: Arc<AtomicBool>) {
    while !token.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn kill_process_tree_by_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn register_agent_child_process(
    app: &AppHandle,
    session_id: &str,
    pid: u32,
    kind: &str,
    label: &str,
) -> String {
    let id = format!("agent-child-{kind}-{pid}");
    let state = app.state::<IdeRuntimeState>();
    state.agent_child_processes.lock().unwrap().insert(
        id.clone(),
        AgentChildProcess {
            session_id: session_id.to_string(),
            pid,
            kind: kind.to_string(),
            label: label.to_string(),
            started_at: agent_now(),
        },
    );
    id
}

fn unregister_agent_child_process(app: &AppHandle, id: &str) {
    let state = app.state::<IdeRuntimeState>();
    state.agent_child_processes.lock().unwrap().remove(id);
}

fn kill_registered_agent_children(app: &AppHandle, session_id: &str) -> Vec<Value> {
    let children = {
        let state = app.state::<IdeRuntimeState>();
        let mut registry = state.agent_child_processes.lock().unwrap();
        let ids = registry
            .iter()
            .filter(|(_, child)| child.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| registry.remove(&id).map(|child| (id, child)))
            .collect::<Vec<_>>()
    };
    let mut killed = Vec::new();
    for (id, child) in children {
        kill_process_tree_by_pid(child.pid);
        killed.push(json!({
            "id": id,
            "pid": child.pid,
            "kind": child.kind,
            "label": child.label,
            "startedAt": child.started_at,
            "status": "killed"
        }));
    }
    killed
}

fn kill_agent_background_processes_for_session(app: &AppHandle, session_id: &str) -> Vec<Value> {
    let process_ids = {
        let state = app.state::<IdeRuntimeState>();
        let processes = state.agent_processes.lock().unwrap();
        processes
            .iter()
            .filter(|(_, process)| process.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    let state = app.state::<IdeRuntimeState>();
    let mut killed = Vec::new();
    for process_id in process_ids {
        if let Ok(value) = kill_agent_process_value(app, &state, process_id) {
            killed.push(value);
        }
    }
    killed
}

fn finalize_agent_turn(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    status: &str,
    finish_reason: &str,
    message: &str,
    mut payload: Value,
    clear_pending_continuation: bool,
) -> Value {
    let message = repair_cjk_mojibake(message);
    let mut cleared_pending_tools = 0usize;
    let mut cleared_pending_question = false;
    let mut cleared_pending_continuation = false;
    let mut cleared_active_request = false;
    let mut effective_status = status.to_string();
    let mut effective_finish_reason = finish_reason.to_string();
    let resolved_request_id = if request_id.trim().is_empty() {
        agent_session_active_request_id(app, session_id)
    } else {
        request_id.trim().to_string()
    };
    update_agent_session(app, session_id, |session| {
        let active_request_id = session
            .get("activeRequestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let current_status = session
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let request_matches = resolved_request_id.is_empty()
            || active_request_id.is_empty()
            || active_request_id == resolved_request_id;
        if current_status == "cancelled" && status != "cancelled" {
            effective_status = "cancelled".to_string();
            effective_finish_reason = "cancelled".to_string();
        } else if request_matches {
            session["status"] = Value::String(status.to_string());
        }
        if request_matches {
            session["activeRequestId"] = Value::String(String::new());
            cleared_active_request = !active_request_id.is_empty();
            session["lastRequestId"] = Value::String(resolved_request_id.clone());
            session["cancelRequested"] = Value::Bool(false);
            session["cancelRequestedAt"] = Value::Null;
            session["approvedToolRunning"] = Value::Bool(false);
            cleared_pending_tools = session
                .get("pendingTools")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            if cleared_pending_tools > 0 {
                session["pendingTools"] = json!([]);
            }
            cleared_pending_question = !session
                .get("pendingQuestion")
                .map(Value::is_null)
                .unwrap_or(true);
            if cleared_pending_question {
                session["pendingQuestion"] = Value::Null;
            }
            cleared_pending_continuation = clear_pending_continuation
                && !session
                    .get("pendingContinuation")
                    .map(Value::is_null)
                    .unwrap_or(true);
            if clear_pending_continuation {
                session["pendingContinuation"] = Value::Null;
            }
        }
    });
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "requestId".to_string(),
            Value::String(resolved_request_id.clone()),
        );
        object.insert(
            "status".to_string(),
            Value::String(effective_status.clone()),
        );
        object.insert(
            "finishReason".to_string(),
            Value::String(effective_finish_reason.clone()),
        );
        if !message.is_empty() {
            object.insert("message".to_string(), Value::String(message.clone()));
        }
        object.insert(
            "cleanup".to_string(),
            json!({
                "clearedActiveRequest": cleared_active_request,
                "clearedPendingTools": cleared_pending_tools,
                "clearedPendingQuestion": cleared_pending_question,
                "clearedPendingContinuation": cleared_pending_continuation
            }),
        );
    }
    agent_emit(app, session_id, "session_done", payload.clone());
    payload
}

fn finalize_agent_cancellation(app: &AppHandle, session_id: &str) {
    update_agent_session(app, session_id, |session| {
        session["status"] = Value::String("cancelled".to_string());
        session["cancelRequested"] = Value::Bool(false);
        session["cancelRequestedAt"] = Value::Null;
        session["approvedToolRunning"] = Value::Bool(false);
        session["activeRequestId"] = Value::String(String::new());
        session["pendingContinuation"] = Value::Null;
        session["pendingTools"] = json!([]);
        session["pendingQuestion"] = Value::Null;
    });
}

const AGENT_CANCEL_FORCE_AFTER_SECS: u64 = 5;

fn force_finalize_agent_cancellation(app: &AppHandle, session_id: &str, reason: &str) {
    request_agent_cancellation_token(app, session_id);
    let killed_children = kill_registered_agent_children(app, session_id);
    let killed_processes = kill_agent_background_processes_for_session(app, session_id);
    let active_request_id = agent_session_active_request_id(app, session_id);
    let reason = repair_cjk_mojibake(reason);
    agent_emit(
        app,
        session_id,
        "cancellation_requested",
        json!({
            "requestId": active_request_id.clone(),
            "status": "cancelled",
            "finishReason": "cancelled",
            "forced": true,
            "message": reason.clone(),
            "fullyStopped": true,
            "killedChildren": killed_children,
            "killedProcesses": killed_processes
        }),
    );
    finalize_agent_turn(
        app,
        session_id,
        &active_request_id,
        "cancelled",
        "cancelled",
        &reason,
        json!({
            "ok": false,
            "forced": true,
            "fullyStopped": true
        }),
        true,
    );
}

#[allow(dead_code)]
fn agent_session_string_list(session: &Value, key: &str, limit: usize) -> Vec<String> {
    session
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .rev()
                .take(limit)
                .filter_map(|item| {
                    if let Some(text) = item.as_str() {
                        Some(text.to_string())
                    } else {
                        Some(item.to_string())
                    }
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default()
}

fn build_rule_based_compaction(session: &Value, reason: &str) -> Value {
    let messages = session
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .rev()
                .take(10)
                .filter_map(|item| {
                    let role = item
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("message");
                    let content = item
                        .get("content")
                        .or_else(|| item.get("text"))
                        .map(collect_text)
                        .unwrap_or_default();
                    if content.trim().is_empty() {
                        None
                    } else {
                        Some(format!(
                            "{role}: {}",
                            content.chars().take(1200).collect::<String>()
                        ))
                    }
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let tool_summaries = session
        .get("toolCalls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .rev()
                .take(24)
                .map(|call| {
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let status = call.get("status").and_then(Value::as_str).unwrap_or("ok");
                    let input = call.get("input").cloned().unwrap_or_else(|| json!({}));
                    let error = call.get("error").and_then(Value::as_str).unwrap_or("");
                    format!(
                        "{name} [{status}] input={}{}",
                        input,
                        if error.is_empty() {
                            String::new()
                        } else {
                            format!(" error={error}")
                        }
                    )
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pending = session
        .get("pendingTools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let summary = format!(
        "Reason: {reason}\nStatus: {}\nGoal/Profile: {}\n\nRecent messages:\n{}\n\nRecent tools:\n{}\n\nPending approvals: {}",
        session.get("status").and_then(Value::as_str).unwrap_or("running"),
        session.get("profileId").and_then(Value::as_str).unwrap_or("build"),
        if messages.is_empty() { "-".to_string() } else { messages.join("\n") },
        if tool_summaries.is_empty() { "-".to_string() } else { tool_summaries.join("\n") },
        Value::Array(pending).to_string()
    );
    json!({
        "id": format!("compact-{}", agent_now()),
        "reason": reason,
        "summary": summary,
        "messageCount": messages.len(),
        "toolCount": tool_summaries.len(),
        "createdAt": agent_now()
    })
}

fn compact_agent_session(app: &AppHandle, session_id: &str, reason: &str) -> Result<Value, String> {
    agent_emit(
        app,
        session_id,
        "context_compaction_start",
        json!({ "reason": reason }),
    );
    let compacted = {
        let state = app.state::<IdeRuntimeState>();
        let mut sessions = state.agent_sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "agent session not found".to_string())?;
        session["status"] = Value::String("compacting".to_string());
        let compacted = build_rule_based_compaction(session, reason);
        let count = session
            .get("compactionCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        session["compactionCount"] = json!(count);
        session["compactedSummary"] = compacted.clone();
        if let Some(items) = session.get_mut("compactions").and_then(Value::as_array_mut) {
            items.push(compacted.clone());
        } else {
            session["compactions"] = json!([compacted.clone()]);
        }
        session["updatedAt"] = Value::String(agent_now());
        let snapshot = session.clone();
        persist_agent_session_value(&snapshot);
        compacted
    };
    agent_emit(
        app,
        session_id,
        "context_compaction_result",
        compacted.clone(),
    );
    Ok(compacted)
}

fn compacted_agent_continuation_messages(
    compacted: &Value,
    system_prompt: Option<&str>,
) -> Vec<IdeAiMessage> {
    let system = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("You are AutoCode local IDE coding agent. Continue from the compacted task state below. Do not repeat tool calls that are already completed.");
    vec![
        IdeAiMessage::new("system", system),
        IdeAiMessage::new(
            "user",
            format!(
                "[compacted continuation]\n{}\n\nContinue the original task. Use tools if needed; output the final answer when complete.",
                compacted
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ),
        ),
    ]
}

fn agent_request_system_prompt(request: &IdeAiRequest) -> Option<&str> {
    request
        .messages
        .iter()
        .find(|message| message.role == "system" && !message.content.trim().is_empty())
        .map(|message| message.content.as_str())
}

fn estimate_agent_request_tokens(request: &IdeAiRequest) -> u64 {
    let chars = request.messages.iter().fold(0usize, |total, message| {
        total
            + message.role.chars().count()
            + message.content.chars().count()
            + message.reasoning_content.chars().count()
            + message.tool_call_id.chars().count()
            + serde_json::to_string(&message.tool_calls)
                .map(|value| value.chars().count())
                .unwrap_or(0)
            + 32
    });
    ((chars + 3) / 4).max(request.messages.len() * 8) as u64
}

fn provider_model_context_window(provider: &str, model: &str) -> u64 {
    let provider = provider.trim().to_ascii_lowercase();
    let model = model.trim().to_ascii_lowercase();
    if provider.contains("deepseek") || model.contains("deepseek") {
        return 64_000;
    }
    if provider.contains("kimi") || model.contains("kimi") || model.contains("moonshot") {
        return 128_000;
    }
    if provider.contains("anthropic") || model.contains("claude") {
        return 200_000;
    }
    if provider.contains("openai")
        || model.starts_with("gpt-5")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
    {
        return 128_000;
    }
    64_000
}

fn value_context_window(value: &Value) -> Option<u64> {
    for key in [
        "context_window",
        "contextWindow",
        "context_tokens",
        "contextTokens",
        "max_context_tokens",
        "maxContextTokens",
        "max_input_tokens",
        "maxInputTokens",
    ] {
        if let Some(window) = value.get(key).and_then(Value::as_u64).filter(|value| *value > 0) {
            return Some(window);
        }
    }
    None
}

fn model_capability_context_window(capabilities: &Value, model: &str) -> Option<u64> {
    let model = model.trim();
    if model.is_empty() {
        return None;
    }
    for key in ["model_context_windows", "modelContextWindows", "contextWindows"] {
        if let Some(window) = capabilities
            .get(key)
            .and_then(|value| value.get(model))
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            return Some(window);
        }
    }
    for key in ["models", "modelCapabilities"] {
        if let Some(window) = capabilities
            .get(key)
            .and_then(|value| value.get(model))
            .and_then(value_context_window)
        {
            return Some(window);
        }
    }
    None
}

fn channel_context_window(channel: &connector::ProviderChannel, selected_model: &str) -> u64 {
    let model = selected_model
        .trim()
        .is_empty()
        .then(|| select_channel_model(channel))
        .flatten()
        .unwrap_or_else(|| selected_model.trim().to_string());
    if let Some(value) = model_capability_context_window(&channel.capabilities, &model) {
        return value;
    }
    if let Some(value) = value_context_window(&channel.capabilities) {
        return value;
    }
    provider_model_context_window(&channel.provider_type, &model)
}

fn channel_compaction_threshold(channel: &connector::ProviderChannel, selected_model: &str) -> u64 {
    let window = channel_context_window(channel, selected_model).max(8_000);
    let output_reserve = 8_000u64;
    let working_window = window.saturating_sub(output_reserve).max(window / 2);
    (working_window * 7 / 10).clamp(4_000, 1_000_000)
}

fn agent_compaction_threshold(settings: &connector::IdeSettings) -> u64 {
    let settings_threshold = (if settings.auto_compact_threshold > 0 {
        settings.auto_compact_threshold
    } else if settings.context_budget > 0 {
        settings.context_budget
    } else {
        24_000
    })
    .clamp(4_000, 1_000_000);
    let selected_model = settings.model.trim();
    let channel_threshold = provider_channel_candidates(settings, "agent", Some(selected_model))
        .iter()
        .map(|channel| channel_compaction_threshold(channel, selected_model))
        .min()
        .or_else(|| {
            settings
                .channels
                .iter()
                .filter(|channel| channel.enabled)
                .map(|channel| channel_compaction_threshold(channel, selected_model))
                .min()
        })
        .unwrap_or_else(|| {
            let legacy = provider_model_context_window(&settings.provider_type, selected_model);
            (legacy.saturating_sub(8_000).max(legacy / 2) * 7 / 10).clamp(4_000, 1_000_000)
        });
    settings_threshold.min(channel_threshold)
}

fn summarize_compaction_message_content(content: &str, max_chars: usize) -> String {
    let count = content.chars().count();
    if count <= max_chars {
        return content.to_string();
    }
    let head_chars = max_chars / 2;
    let tail_chars = max_chars.saturating_sub(head_chars);
    let head = content.chars().take(head_chars).collect::<String>();
    let tail = content
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}\n...[middle truncated by AutoCode pre-request compaction: {count} chars]...\n{tail}")
}

fn build_request_compaction_summary(
    request: &IdeAiRequest,
    reason: &str,
    estimated_tokens: u64,
    threshold: u64,
) -> Value {
    let first_user = request
        .messages
        .iter()
        .find(|message| message.role == "user" && !message.content.trim().is_empty());
    let mut lines = Vec::new();
    lines.push(format!("Reason: {reason}"));
    lines.push(format!(
        "Estimated request tokens before compaction: {estimated_tokens}; threshold: {threshold}"
    ));
    lines.push(format!("Message count before compaction: {}", request.messages.len()));
    if let Some(message) = first_user {
        lines.push(format!(
            "\nOriginal user/task context:\n{}",
            summarize_compaction_message_content(&message.content, 8_000)
        ));
    }
    lines.push("\nRecent conversation and tool state:".to_string());
    let recent_messages = request
        .messages
        .iter()
        .enumerate()
        .rev()
        .take(14)
        .collect::<Vec<_>>();
    for (index, message) in recent_messages.into_iter().rev() {
        if message.role == "system" {
            continue;
        }
        let mut content = summarize_compaction_message_content(&message.content, 4_000);
        if !message.tool_calls.is_empty() {
            let tool_calls = serde_json::to_string(&message.tool_calls).unwrap_or_default();
            if !tool_calls.is_empty() {
                content.push_str("\n[tool_calls]\n");
                content.push_str(&summarize_compaction_message_content(&tool_calls, 2_000));
            }
        }
        lines.push(format!("- message #{index} role={}\n{}", message.role, content));
    }
    json!({
        "id": format!("compact-{}", agent_now()),
        "reason": reason,
        "summary": lines.join("\n"),
        "messageCount": request.messages.len(),
        "estimatedTokens": estimated_tokens,
        "threshold": threshold,
        "createdAt": agent_now()
    })
}

fn agent_request_already_compacted(request: &IdeAiRequest) -> bool {
    request.messages.len() <= 2
        && request
            .messages
            .iter()
            .any(|message| message.content.contains("[compacted continuation]"))
}

fn compact_agent_request_before_send(
    app: &AppHandle,
    session_id: &str,
    settings: &connector::IdeSettings,
    request: &mut IdeAiRequest,
    reason: &str,
) -> Result<bool, String> {
    if agent_request_already_compacted(request) {
        return Ok(false);
    }
    let threshold = agent_compaction_threshold(settings);
    let estimated_tokens = estimate_agent_request_tokens(request);
    if estimated_tokens < threshold {
        return Ok(false);
    }
    agent_emit(
        app,
        session_id,
        "context_compaction_start",
        json!({
            "reason": reason,
            "estimatedTokens": estimated_tokens,
            "threshold": threshold
        }),
    );
    let compacted = build_request_compaction_summary(request, reason, estimated_tokens, threshold);
    let system_prompt = agent_request_system_prompt(request).map(str::to_string);
    request.messages = compacted_agent_continuation_messages(&compacted, system_prompt.as_deref());
    update_agent_session(app, session_id, |session| {
        session["status"] = Value::String("running".to_string());
        let count = session
            .get("compactionCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        session["compactionCount"] = json!(count);
        session["compactedSummary"] = compacted.clone();
        if let Some(items) = session.get_mut("compactions").and_then(Value::as_array_mut) {
            items.push(compacted.clone());
        } else {
            session["compactions"] = json!([compacted.clone()]);
        }
        session["updatedAt"] = Value::String(agent_now());
    });
    agent_emit(
        app,
        session_id,
        "context_compaction_result",
        compacted.clone(),
    );
    agent_emit(
        app,
        session_id,
        "provider_retry",
        json!({
            "channel": "Agent",
            "model": provider_model(settings),
            "reason": format!(
                "Context compacted before provider request: estimated {} tokens exceeded threshold {}.",
                estimated_tokens, threshold
            )
        }),
    );
    Ok(true)
}

fn memory_file_candidate_paths(root_path: &str) -> Vec<(String, String)> {
    let mut paths = vec![
        (
            ".autocode/AGENTS.md".to_string(),
            "project_rules".to_string(),
        ),
        (".autocode/memory.md".to_string(), "memory".to_string()),
        (
            ".autocode/settings.json".to_string(),
            "settings".to_string(),
        ),
    ];
    if let Ok(root) = connector::resolve_authorized_root(root_path) {
        let dir = root.join(".autocode");
        if let Ok(entries) = fs::read_dir(dir) {
            let mut shards = entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .filter(|name| {
                    name.starts_with("memory-") && name.ends_with(".md") && name != "memory.md"
                })
                .map(|name| (format!(".autocode/{name}"), "memory".to_string()))
                .collect::<Vec<_>>();
            shards.sort_by(|a, b| a.0.cmp(&b.0));
            for shard in shards {
                if !paths.iter().any(|(path, _)| path == &shard.0) {
                    paths.push(shard);
                }
            }
        }
    }
    paths
}

fn memory_file_candidates(root_path: &str) -> Vec<(String, String)> {
    memory_file_candidate_paths(root_path)
        .into_iter()
        .filter_map(|(path, kind)| {
            connector::read_workspace_file(root_path, &path)
                .ok()
                .map(|file| {
                    (
                        path.clone(),
                        kind,
                        file.content.chars().take(20000).collect::<String>(),
                    )
                })
        })
        .map(|(path, kind, content)| {
            let block = format!("[memory:{kind}:{path}]\n{content}");
            (path, block)
        })
        .collect()
}

fn read_agent_memory_for_context(root_path: &str) -> (String, Vec<Value>) {
    let mut blocks = Vec::new();
    let mut refs = Vec::new();
    for (path, block) in memory_file_candidates(root_path) {
        blocks.push(block);
        refs.push(json!({ "path": path, "readAt": agent_now() }));
    }
    (blocks.join("\n\n---\n\n"), refs)
}

fn parse_paths_from_diff(diff: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in diff.lines() {
        let candidate = line
            .strip_prefix("+++ b/")
            .or_else(|| line.strip_prefix("--- a/"));
        if let Some(path) = candidate {
            if path != "/dev/null" && !paths.iter().any(|item| item == path) {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

fn parse_paths_from_codex_patch(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        let candidate = line
            .strip_prefix("*** Add File: ")
            .or_else(|| line.strip_prefix("*** Update File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "));
        if let Some(path) = candidate {
            let path = path.trim();
            if !path.is_empty() && !paths.iter().any(|item| item == path) {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

fn parse_paths_from_agent_patch(patch: &str) -> Vec<String> {
    let codex = parse_paths_from_codex_patch(patch);
    if codex.is_empty() {
        parse_paths_from_diff(patch)
    } else {
        codex
    }
}

fn patch_preview_summary(patch: &str) -> String {
    let plus = patch
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .count();
    let minus = patch
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .count();
    let files = parse_paths_from_agent_patch(patch).len().max(1);
    let kind = if patch.contains("*** Begin Patch") {
        "codex"
    } else {
        "unified"
    };
    format!("{kind} patch 路 {files} file(s) 路 +{plus} / -{minus}")
}

fn extract_fenced_patch(text: &str) -> Option<String> {
    let mut in_fence = false;
    let mut fence_lang = String::new();
    let mut buffer = String::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            if in_fence {
                if fence_lang.contains("diff") || fence_lang.contains("patch") {
                    return Some(buffer);
                }
                in_fence = false;
                fence_lang.clear();
                buffer.clear();
            } else {
                fence_lang = trimmed.trim_matches('`').trim().to_ascii_lowercase();
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

fn normalize_agent_unified_patch(raw: &str) -> Result<String, String> {
    let mut patch = extract_fenced_patch(raw).unwrap_or_else(|| raw.to_string());
    patch = patch.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return Err("patch cannot be empty".to_string());
    }
    let has_codex_begin = trimmed.contains("*** Begin Patch");
    let has_codex_end = trimmed.contains("*** End Patch");
    let looks_like_codex_body = trimmed.lines().any(|line| {
        line.starts_with("*** Add File: ")
            || line.starts_with("*** Update File: ")
            || line.starts_with("*** Delete File: ")
    });
    if has_codex_begin || has_codex_end || looks_like_codex_body {
        let mut codex = trimmed.trim_end().to_string();
        if !has_codex_begin {
            codex = format!("*** Begin Patch\n{codex}");
        }
        if !has_codex_end {
            codex = format!("{codex}\n*** End Patch");
        }
        return Ok(format!("{}\n", codex.trim_end()));
    }
    let lines = trimmed.lines().collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| {
            line.starts_with("diff --git ")
                || line.starts_with("--- ")
                || line.starts_with("Index: ")
        })
        .unwrap_or(0);
    patch = lines[start..].join("\n");
    let has_file_header = patch.lines().any(|line| line.starts_with("diff --git "))
        || (patch.lines().any(|line| line.starts_with("--- "))
            && patch.lines().any(|line| line.starts_with("+++ ")));
    let has_hunk = patch.lines().any(|line| line.starts_with("@@ "));
    if !has_file_header || !has_hunk {
        return Err(
            "patch is not a valid unified diff; include diff --git/---/+++ and @@ hunk lines, or use a complete Codex *** Begin Patch block".to_string(),
        );
    }
    Ok(format!("{}\n", patch.trim_end()))
}

fn strip_diff_prefix(path: &str) -> String {
    normalize_agent_rel_path(
        path.trim()
            .trim_start_matches("a/")
            .trim_start_matches("b/")
            .trim_matches('"'),
    )
}

fn workspace_file_exists(root_path: &str, path: &str) -> bool {
    connector::read_workspace_file(root_path, path).is_ok()
}

fn workspace_path_is_dir(root_path: &str, path: &str) -> bool {
    let Ok(root) = connector::resolve_authorized_root(root_path) else {
        return false;
    };
    let path = normalize_agent_rel_path(path);
    if path.is_empty() {
        return true;
    }
    let candidate = root.join(path);
    candidate.is_dir()
}

fn find_unique_workspace_suffix(root: &Path, suffix: &str) -> Option<String> {
    let suffix = normalize_agent_rel_path(suffix);
    if suffix.is_empty() {
        return None;
    }
    let skip_dirs = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".venv",
        "venv",
        "__pycache__",
    ];
    let mut stack = vec![root.to_path_buf()];
    let mut found = Vec::<String>::new();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if skip_dirs
                    .iter()
                    .any(|item| item.eq_ignore_ascii_case(&name))
                {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = normalize_agent_rel_path(&relative.to_string_lossy());
            if relative == suffix || relative.ends_with(&format!("/{suffix}")) {
                found.push(relative);
                if found.len() > 1 {
                    return None;
                }
            }
        }
    }
    found.into_iter().next()
}

fn resolve_patch_path(root_path: &str, path: &str, focus_paths: &[String]) -> String {
    let path = strip_diff_prefix(path);
    if path.is_empty() || path == "/dev/null" || path == "dev/null" {
        return path;
    }
    if workspace_file_exists(root_path, &path) {
        return path;
    }
    let basename = path.rsplit('/').next().unwrap_or(path.as_str());
    for focus in focus_paths {
        let focus = normalize_agent_rel_path(focus);
        if focus.is_empty() {
            continue;
        }
        let candidate = if workspace_file_exists(root_path, &focus) {
            let parent = focus
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or("");
            if parent.is_empty() {
                basename.to_string()
            } else {
                format!("{parent}/{basename}")
            }
        } else if workspace_path_is_dir(root_path, &focus) {
            format!("{}/{}", focus.trim_end_matches('/'), basename)
        } else {
            format!("{}/{}", focus.trim_end_matches('/'), basename)
        };
        if workspace_file_exists(root_path, &candidate) || workspace_path_is_dir(root_path, &focus)
        {
            return candidate;
        }
    }
    let Ok(root) = connector::resolve_authorized_root(root_path) else {
        return path;
    };
    find_unique_workspace_suffix(&root, &path).unwrap_or(path)
}

fn rewrite_unified_patch_paths(root_path: &str, patch: &str, focus_paths: &[String]) -> String {
    let mut path_map = HashMap::<String, String>::new();
    for path in parse_paths_from_diff(patch) {
        let resolved = resolve_patch_path(root_path, &path, focus_paths);
        if resolved != path {
            path_map.insert(path, resolved);
        }
    }
    if path_map.is_empty() {
        return patch.to_string();
    }
    let mut out = Vec::new();
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            if parts.len() >= 2 {
                let left = strip_diff_prefix(parts[0]);
                let right = strip_diff_prefix(parts[1]);
                let next_left = path_map.get(&left).cloned().unwrap_or(left);
                let next_right = path_map.get(&right).cloned().unwrap_or(right);
                out.push(format!("diff --git a/{next_left} b/{next_right}"));
                continue;
            }
        }
        if let Some(path) = line.strip_prefix("--- ") {
            let marker = path.trim();
            if marker != "/dev/null" {
                let clean = strip_diff_prefix(marker);
                if let Some(next) = path_map.get(&clean) {
                    out.push(format!("--- a/{next}"));
                    continue;
                }
            }
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            let marker = path.trim();
            if marker != "/dev/null" {
                let clean = strip_diff_prefix(marker);
                if let Some(next) = path_map.get(&clean) {
                    out.push(format!("+++ b/{next}"));
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    format!("{}\n", out.join("\n").trim_end())
}

fn collect_patch_resolution_focus_paths(
    app: Option<&AppHandle>,
    session_id: Option<&str>,
    input: &Value,
) -> Vec<String> {
    let mut focus_paths = app
        .zip(session_id)
        .map(|(app, session_id)| session_focus_paths(app, session_id))
        .unwrap_or_default();
    for key in ["path", "file", "target"] {
        if let Some(path) = input.get(key).and_then(Value::as_str) {
            let path = normalize_agent_rel_path(path);
            if !path.is_empty() && !focus_paths.iter().any(|item| item == &path) {
                focus_paths.push(path);
            }
        }
    }
    for key in ["paths", "files"] {
        if let Some(items) = input.get(key).and_then(Value::as_array) {
            for item in items.iter().filter_map(Value::as_str) {
                let path = normalize_agent_rel_path(item);
                if !path.is_empty() && !focus_paths.iter().any(|existing| existing == &path) {
                    focus_paths.push(path);
                }
            }
        }
    }
    focus_paths
}

fn rewrite_apply_patch_input_paths(
    app: Option<&AppHandle>,
    session_id: Option<&str>,
    root_path: &str,
    input: &Value,
) -> Value {
    let Some(patch) = input
        .get("patch")
        .or_else(|| input.get("diff"))
        .and_then(Value::as_str)
    else {
        return input.clone();
    };
    let focus_paths = collect_patch_resolution_focus_paths(app, session_id, input);
    let rewritten = rewrite_unified_patch_paths(root_path, patch, &focus_paths);
    if rewritten == patch {
        return input.clone();
    }
    let mut next = input.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert("patch".to_string(), Value::String(rewritten));
        object.remove("diff");
        object.insert("pathResolved".to_string(), Value::Bool(true));
    }
    next
}

fn rewrite_patch_preview_value(root_path: &str, preview: Value, focus_paths: &[String]) -> Value {
    let Some(patch) = preview.get("patch").and_then(Value::as_str) else {
        return preview;
    };
    let rewritten = rewrite_unified_patch_paths(root_path, patch, focus_paths);
    if rewritten == patch {
        return preview;
    }
    let mut next = preview;
    if let Some(object) = next.as_object_mut() {
        object.insert("patch".to_string(), Value::String(rewritten.clone()));
        object.insert(
            "files".to_string(),
            json!(parse_paths_from_agent_patch(&rewritten)),
        );
        object.insert("pathResolved".to_string(), Value::Bool(true));
    }
    next
}

fn find_line_sequence(lines: &[String], needle: &[String], start: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(start.min(lines.len()));
    }
    if needle.len() > lines.len() {
        return None;
    }
    (start.min(lines.len())..=lines.len().saturating_sub(needle.len()))
        .find(|index| &lines[*index..index + needle.len()] == needle)
        .or_else(|| {
            (0..start.min(lines.len())).find(|index| &lines[*index..index + needle.len()] == needle)
        })
}

fn find_line_sequence_trimmed(lines: &[String], needle: &[String], start: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(start.min(lines.len()));
    }
    if needle.len() > lines.len() {
        return None;
    }
    let matches_at = |index: usize| {
        lines[index..index + needle.len()]
            .iter()
            .zip(needle.iter())
            .all(|(left, right)| left.trim_end() == right.trim_end())
    };
    (start.min(lines.len())..=lines.len().saturating_sub(needle.len()))
        .find(|index| matches_at(*index))
        .or_else(|| (0..start.min(lines.len())).find(|index| matches_at(*index)))
}

fn find_line_sequence_scored(lines: &[String], needle: &[String], start: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(start.min(lines.len()));
    }
    if needle.len() > lines.len() {
        return None;
    }
    let threshold = ((needle.len() * 3) / 4).max(1);
    let mut best: Option<(usize, usize)> = None;
    let range = (start.min(lines.len())..=lines.len().saturating_sub(needle.len()))
        .chain(0..start.min(lines.len()));
    for index in range {
        let score = lines[index..index + needle.len()]
            .iter()
            .zip(needle.iter())
            .filter(|(left, right)| left.trim() == right.trim())
            .count();
        if score >= threshold && best.map(|(_, current)| score > current).unwrap_or(true) {
            best = Some((index, score));
        }
    }
    best.map(|(index, _)| index)
}

fn apply_codex_update_hunks(
    path: &str,
    original: &str,
    hunks: &[Vec<(char, String)>],
) -> Result<String, String> {
    let mut lines = original.lines().map(str::to_string).collect::<Vec<_>>();
    let mut search_start = 0usize;
    for hunk in hunks {
        let old_lines = hunk
            .iter()
            .filter(|(op, _)| *op == ' ' || *op == '-')
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        let new_lines = hunk
            .iter()
            .filter(|(op, _)| *op == ' ' || *op == '+')
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        let Some(index) = find_line_sequence(&lines, &old_lines, search_start)
            .or_else(|| find_line_sequence_trimmed(&lines, &old_lines, search_start))
            .or_else(|| find_line_sequence_scored(&lines, &old_lines, search_start))
        else {
            if let Some(applied_index) = find_line_sequence(&lines, &new_lines, search_start)
                .or_else(|| find_line_sequence_trimmed(&lines, &new_lines, search_start))
            {
                search_start = applied_index + new_lines.len();
                continue;
            }
            return Err(format!(
                "Codex patch hunk did not match current file content: {path}. The file may have changed after the patch was generated; ask the Agent to reread this file and regenerate the patch against the current content."
            ));
        };
        lines.splice(index..index + old_lines.len(), new_lines.clone());
        search_start = index + new_lines.len();
    }
    let mut next = lines.join("\n");
    if original.ends_with('\n') || !next.is_empty() {
        next.push('\n');
    }
    Ok(next)
}

fn apply_codex_agent_patch(root_path: &str, patch: &str) -> Result<Value, String> {
    let text = patch.replace("\r\n", "\n").replace('\r', "\n");
    if !text.contains("*** Begin Patch") || !text.contains("*** End Patch") {
        return Err("Codex patch must include *** Begin Patch and *** End Patch".to_string());
    }
    let lines = text.lines().collect::<Vec<_>>();
    let mut index = 0usize;
    let mut changed = Vec::new();
    while index < lines.len() {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let path = path.trim();
            index += 1;
            let mut content = Vec::new();
            while index < lines.len() && !lines[index].starts_with("*** ") {
                let item = lines[index];
                if let Some(text) = item.strip_prefix('+') {
                    content.push(text.to_string());
                } else if !item.trim().is_empty() {
                    content.push(item.to_string());
                }
                index += 1;
            }
            let saved = connector::save_workspace_file(
                root_path,
                path,
                &format!("{}\n", content.join("\n")),
                None,
                None,
            )?;
            changed.push(json!({ "path": saved.path, "operation": "create", "size": saved.size }));
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            let path = path.trim();
            connector::delete_workspace_entry(root_path, path, false)?;
            changed.push(json!({ "path": path, "operation": "delete" }));
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            let path = path.trim();
            index += 1;
            let mut hunks: Vec<Vec<(char, String)>> = Vec::new();
            let mut current: Vec<(char, String)> = Vec::new();
            while index < lines.len() && !lines[index].starts_with("*** ") {
                let item = lines[index];
                if item.starts_with("@@") {
                    if !current.is_empty() {
                        hunks.push(current);
                        current = Vec::new();
                    }
                } else if item == "*** End of File" {
                    break;
                } else if let Some(rest) = item.strip_prefix('+') {
                    current.push(('+', rest.to_string()));
                } else if let Some(rest) = item.strip_prefix('-') {
                    current.push(('-', rest.to_string()));
                } else if let Some(rest) = item.strip_prefix(' ') {
                    current.push((' ', rest.to_string()));
                } else if item.trim().is_empty() {
                    current.push((' ', String::new()));
                } else {
                    return Err(format!("unsupported Codex patch line for {path}: {item}"));
                }
                index += 1;
            }
            if !current.is_empty() {
                hunks.push(current);
            }
            if hunks.is_empty() {
                return Err(format!("Codex update patch has no hunks: {path}"));
            }
            let file = connector::read_workspace_file(root_path, path)?;
            let next = apply_codex_update_hunks(path, &file.content, &hunks)?;
            let saved = connector::save_workspace_file(
                root_path,
                path,
                &next,
                Some(file.encoding),
                Some(file.line_ending),
            )?;
            changed.push(json!({ "path": saved.path, "operation": "update", "size": saved.size }));
            continue;
        }
        index += 1;
    }
    if changed.is_empty() {
        return Err("Codex patch did not contain any file operations".to_string());
    }
    Ok(json!({
        "ok": true,
        "message": "Codex patch applied",
        "patchKind": "codex",
        "summary": patch_change_summary(&changed),
        "diagnostics": [],
        "changed": changed
    }))
}

fn patch_change_summary(changed: &[Value]) -> String {
    let creates = changed
        .iter()
        .filter(|item| item.get("operation").and_then(Value::as_str) == Some("create"))
        .count();
    let updates = changed
        .iter()
        .filter(|item| item.get("operation").and_then(Value::as_str) == Some("update"))
        .count();
    let deletes = changed
        .iter()
        .filter(|item| item.get("operation").and_then(Value::as_str) == Some("delete"))
        .count();
    let mut parts = Vec::new();
    if creates > 0 {
        parts.push(format!("{creates} create"));
    }
    if updates > 0 {
        parts.push(format!("{updates} update"));
    }
    if deletes > 0 {
        parts.push(format!("{deletes} delete"));
    }
    if parts.is_empty() {
        "no file changes".to_string()
    } else {
        parts.join(", ")
    }
}

fn validate_codex_agent_patch_without_apply(root_path: &str, patch: &str) -> Result<Value, String> {
    let text = patch.replace("\r\n", "\n").replace('\r', "\n");
    if !text.contains("*** Begin Patch") || !text.contains("*** End Patch") {
        return Err("Codex patch must include *** Begin Patch and *** End Patch".to_string());
    }
    let lines = text.lines().collect::<Vec<_>>();
    let mut index = 0usize;
    let mut changed = Vec::new();
    while index < lines.len() {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let path = normalize_agent_rel_path(path.trim());
            if path.is_empty() {
                return Err("Codex add-file patch has an empty path".to_string());
            }
            if workspace_file_exists(root_path, &path) {
                return Err(format!(
                    "Codex add-file target already exists: {path}. Use Update File or write instead."
                ));
            }
            changed.push(json!({ "path": path, "operation": "create" }));
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            let path = normalize_agent_rel_path(path.trim());
            if path.is_empty() {
                return Err("Codex delete-file patch has an empty path".to_string());
            }
            if !workspace_file_exists(root_path, &path) {
                return Err(format!("Codex delete-file target does not exist: {path}"));
            }
            changed.push(json!({ "path": path, "operation": "delete" }));
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            let path = normalize_agent_rel_path(path.trim());
            if path.is_empty() {
                return Err("Codex update patch has an empty path".to_string());
            }
            index += 1;
            let mut hunks: Vec<Vec<(char, String)>> = Vec::new();
            let mut current: Vec<(char, String)> = Vec::new();
            while index < lines.len() && !lines[index].starts_with("*** ") {
                let item = lines[index];
                if item.starts_with("@@") {
                    if !current.is_empty() {
                        hunks.push(current);
                        current = Vec::new();
                    }
                } else if item == "*** End of File" {
                    break;
                } else if let Some(rest) = item.strip_prefix('+') {
                    current.push(('+', rest.to_string()));
                } else if let Some(rest) = item.strip_prefix('-') {
                    current.push(('-', rest.to_string()));
                } else if let Some(rest) = item.strip_prefix(' ') {
                    current.push((' ', rest.to_string()));
                } else if item.trim().is_empty() {
                    current.push((' ', String::new()));
                } else {
                    return Err(format!("unsupported Codex patch line for {path}: {item}"));
                }
                index += 1;
            }
            if !current.is_empty() {
                hunks.push(current);
            }
            if hunks.is_empty() {
                return Err(format!("Codex update patch has no hunks: {path}"));
            }
            let file = connector::read_workspace_file(root_path, &path)?;
            let _ = apply_codex_update_hunks(&path, &file.content, &hunks)?;
            changed.push(json!({ "path": path, "operation": "update" }));
            continue;
        }
        index += 1;
    }
    if changed.is_empty() {
        return Err("Codex patch did not contain any file operations".to_string());
    }
    Ok(json!({
        "ok": true,
        "patchKind": "codex",
        "summary": patch_change_summary(&changed),
        "diagnostics": [],
        "changed": changed
    }))
}

fn normalize_memory_patch_path(path: &str) -> String {
    path.trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .replace('\\', "/")
}

fn allowed_agent_memory_path(path: &str) -> bool {
    matches!(
        normalize_memory_patch_path(path).as_str(),
        ".autocode/AGENTS.md" | ".autocode/memory.md" | ".autocode/settings.json"
    )
}

fn validate_agent_memory_patch(patch: &str) -> Result<Vec<String>, String> {
    let paths = parse_paths_from_agent_patch(patch);
    if paths.is_empty() {
        return Err("memory patch must target .autocode/AGENTS.md, .autocode/memory.md, or .autocode/settings.json".to_string());
    }
    let invalid = paths
        .iter()
        .map(|path| normalize_memory_patch_path(path))
        .filter(|path| !allowed_agent_memory_path(path))
        .collect::<Vec<_>>();
    if !invalid.is_empty() {
        return Err(format!(
            "memory patch cannot modify non-memory files: {}",
            invalid.join(", ")
        ));
    }
    Ok(paths)
}

const AGENT_MEMORY_ROLLOVER_BYTES: usize = 64 * 1024;

fn rollover_agent_memory_if_needed(root_path: &str) -> Result<Option<Value>, String> {
    let file = match connector::read_workspace_file(root_path, ".autocode/memory.md") {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    if file.content.as_bytes().len() <= AGENT_MEMORY_ROLLOVER_BYTES {
        return Ok(None);
    }
    let stamp = agent_now();
    let archive_path = format!(".autocode/memory-{stamp}.md");
    let archive_content = format!(
        "# AutoCode 椤圭洰璁板繂褰掓。 {stamp}\n\n> 鑷姩褰掓。鑷?`.autocode/memory.md`锛屽師鏂囦欢瓒呰繃 {} KB銆俓n\n{}",
        AGENT_MEMORY_ROLLOVER_BYTES / 1024,
        file.content
    );
    let archive = connector::save_workspace_file(
        root_path,
        &archive_path,
        &archive_content,
        Some("utf-8".to_string()),
        Some("lf".to_string()),
    )?;
    let active_content = format!(
        "# AutoCode 椤圭洰璁板繂\n\n杩欎釜鏂囦欢淇濆瓨褰撳墠娲昏穬鐨勯暱鏈熼」鐩蹇嗐€傚巻鍙茶蹇嗗凡鑷姩褰掓。鍒?`{archive_path}`锛屽悗缁?Agent 浼氬悓鏃惰鍙?`memory.md` 鍜?`memory-*.md`銆俓n\n## 宸茬‘璁や簨瀹瀄n-\n\n## 鐢ㄦ埛鍋忓ソ\n-\n\n## 鍐崇瓥璁板綍\n-\n"
    );
    let active = connector::save_workspace_file(
        root_path,
        ".autocode/memory.md",
        &active_content,
        Some("utf-8".to_string()),
        Some("lf".to_string()),
    )?;
    Ok(Some(json!({
        "archivePath": archive.path,
        "activePath": active.path,
        "archiveSize": archive.size,
        "activeSize": active.size,
        "thresholdBytes": AGENT_MEMORY_ROLLOVER_BYTES
    })))
}

fn checkpoint_snapshot_files(root_path: &str) -> Vec<Value> {
    let changed = connector::run_workspace_command(root_path, "git status --short", Some(20))
        .ok()
        .map(|result| result.output)
        .unwrap_or_default();
    changed
        .lines()
        .take(100)
        .filter_map(|path| {
            let path = path
                .get(3..)
                .unwrap_or(path)
                .trim()
                .split(" -> ")
                .last()
                .unwrap_or("")
                .replace('\\', "/");
            if path.is_empty() {
                return None;
            }
            connector::read_workspace_file(root_path, &path)
                .ok()
                .map(|file| {
                    json!({
                        "path": file.path,
                        "content": file.content,
                        "encoding": file.encoding,
                        "lineEnding": file.line_ending,
                        "size": file.size
                    })
                })
        })
        .collect()
}

fn checkpoint_snapshot_for_paths(root_path: &str, paths: Vec<String>) -> Vec<Value> {
    let mut seen = Vec::<String>::new();
    paths
        .into_iter()
        .filter_map(|path| {
            let path = path.trim().trim_start_matches('/').replace('\\', "/");
            if path.is_empty() || seen.iter().any(|item| item == &path) {
                return None;
            }
            seen.push(path.clone());
            match connector::read_workspace_file(root_path, &path) {
                Ok(file) => Some(json!({
                    "path": file.path,
                    "exists": true,
                    "content": file.content,
                    "encoding": file.encoding,
                    "lineEnding": file.line_ending,
                    "size": file.size,
                    "modifiedAt": file.modified_at
                })),
                Err(_) => Some(json!({
                    "path": path,
                    "exists": false
                })),
            }
        })
        .collect()
}

fn checkpoint_paths_for_tool(tool: &str, input: &Value) -> Vec<String> {
    match tool {
        "write" => input
            .get("path")
            .or_else(|| input.get("file"))
            .and_then(Value::as_str)
            .map(|path| vec![path.to_string()])
            .unwrap_or_default(),
        "apply_patch" => input
            .get("patch")
            .or_else(|| input.get("diff"))
            .and_then(Value::as_str)
            .map(parse_paths_from_diff)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn create_agent_checkpoint_for_tool(
    app: &AppHandle,
    session_id: &str,
    root_path: &str,
    tool: &str,
    input: &Value,
) -> Result<Option<Value>, String> {
    if !matches!(tool, "write" | "apply_patch") {
        return Ok(None);
    }
    let files = checkpoint_snapshot_for_paths(root_path, checkpoint_paths_for_tool(tool, input));
    if files.is_empty() {
        return Ok(None);
    }
    let checkpoint_id = format!("checkpoint-{}", agent_now());
    let checkpoint = json!({
        "id": checkpoint_id,
        "sessionId": session_id,
        "rootPath": root_path,
        "label": format!("Before {tool}"),
        "tool": tool,
        "input": input,
        "files": files,
        "createdAt": agent_now()
    });
    let dir = agent_checkpoint_storage_dir(session_id);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create checkpoint directory: {err}"))?;
    fs::write(
        dir.join(format!("{checkpoint_id}.json")),
        serde_json::to_vec_pretty(&checkpoint).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("failed to write checkpoint: {err}"))?;
    update_agent_session(app, session_id, |session| {
        if let Some(items) = session.get_mut("checkpoints").and_then(Value::as_array_mut) {
            items.push(checkpoint.clone());
        } else {
            session["checkpoints"] = json!([checkpoint.clone()]);
        }
    });
    agent_emit(app, session_id, "checkpoint_created", checkpoint.clone());
    Ok(Some(checkpoint))
}

#[allow(dead_code)]
fn agent_emit_tool_result(app: &AppHandle, session_id: &str, call: &Value) {
    agent_emit(
        app,
        session_id,
        "tool_call_start",
        json!({
            "id": call.get("id").cloned().unwrap_or(Value::Null),
            "name": call.get("name").cloned().unwrap_or(Value::Null),
            "input": call.get("input").cloned().unwrap_or(Value::Null),
            "status": "running"
        }),
    );
    agent_emit(app, session_id, "tool_call_result", call.clone());
    update_agent_session(app, session_id, |session| {
        if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
            items.push(call.clone());
        }
    });
}

fn custom_permission_decision(settings: &connector::IdeSettings, tool: &str) -> Option<String> {
    let policy = settings.permission_policy.as_object()?;
    let rule = policy.get(tool).or_else(|| policy.get("*"))?;
    if let Some(decision) = rule.as_str() {
        return Some(decision.to_string());
    }
    rule.get("decision")
        .or_else(|| rule.get("mode"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn permission_policy_for_tool(
    profile_id: &str,
    settings: Option<&connector::IdeSettings>,
    tool: &str,
) -> String {
    if let Some(settings) = settings {
        if settings.approval_mode.eq_ignore_ascii_case("custom") {
            if let Some(decision) = custom_permission_decision(settings, tool) {
                return decision;
            }
        }
    }
    let profile = profile_id.to_ascii_lowercase();
    let read_only_profile = matches!(profile.as_str(), "plan" | "review" | "explore" | "docs");
    let execution_profile = matches!(profile.as_str(), "build" | "debug" | "test" | "refactor");
    if tool == "memory_update" {
        return if read_only_profile { "deny" } else { "allow" }.to_string();
    }
    if matches!(
        tool,
        "read"
            | "glob"
            | "grep"
            | "list_files"
            | "read_file"
            | "git_diff"
            | "terminal_output"
            | "workspace_context"
            | "todowrite"
            | "memory_update"
            | "question"
            | "symbol_search"
            | "process_manager"
            | "browser_preview"
            | "lsp"
    ) {
        return "allow".to_string();
    }
    if matches!(tool, "diagnostics" | "test_runner") {
        return if read_only_profile { "ask" } else { "allow" }.to_string();
    }
    if read_only_profile && matches!(tool, "edit" | "write" | "apply_patch" | "bash" | "mcp_call") {
        return "deny".to_string();
    }
    let approval_mode = settings
        .map(|value| value.approval_mode.as_str())
        .unwrap_or("autoEdit")
        .to_ascii_lowercase();
    if approval_mode == "suggest" && matches!(tool, "edit" | "write" | "apply_patch" | "bash") {
        return "ask".to_string();
    }
    if approval_mode == "fullauto" && matches!(tool, "edit" | "write" | "apply_patch" | "bash") {
        return if execution_profile { "allow" } else { "ask" }.to_string();
    }
    if matches!(tool, "edit" | "write" | "apply_patch" | "bash") {
        return "ask".to_string();
    }
    "ask".to_string()
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
    if [
        "&&",
        "||",
        ";",
        "|",
        ">",
        "<",
        "`",
        "$(",
        "%comspec%",
        "\n",
        "\r",
    ]
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

fn project_autocode_settings(root_path: &str) -> Value {
    connector::read_workspace_file(root_path, ".autocode/settings.json")
        .ok()
        .and_then(|file| serde_json::from_str::<Value>(&file.content).ok())
        .unwrap_or_else(|| json!({}))
}

fn merged_mcp_servers(root_path: &str) -> Vec<Value> {
    let global = connector::load_ide_settings();
    let project_settings = project_autocode_settings(root_path);
    let mut servers = Vec::new();
    if let Some(items) = global.mcp_servers.as_array() {
        servers.extend(items.iter().cloned());
    }
    if let Some(items) = project_settings
        .get("mcpServers")
        .or_else(|| project_settings.get("mcp_servers"))
        .and_then(Value::as_array)
    {
        servers.extend(items.iter().cloned());
    }
    servers
}

fn mcp_server_name(server: &Value, index: usize) -> String {
    server
        .get("name")
        .or_else(|| server.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("mcp-{index}"))
}

fn mcp_server_enabled(server: &Value) -> bool {
    if server.get("disabled").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    server
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn write_mcp_frame(writer: &mut dyn Write, value: &Value) -> Result<(), String> {
    let mut body = serde_json::to_vec(value).map_err(|err| err.to_string())?;
    body.push(b'\n');
    writer.write_all(&body).map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

fn spawn_mcp_frame_reader(reader: impl Read + Send + 'static) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(value) = trimmed
                .strip_prefix("Content-Length:")
                .or_else(|| trimmed.strip_prefix("content-length:"))
            {
                let content_length = value.trim().parse::<usize>().unwrap_or(0);
                loop {
                    let mut header_line = String::new();
                    match reader.read_line(&mut header_line) {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {}
                    }
                    if header_line.trim_end().is_empty() {
                        break;
                    }
                }
                if content_length == 0 {
                    continue;
                }
                let mut body = vec![0u8; content_length];
                if reader.read_exact(&mut body).is_err() {
                    return;
                }
                if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                    let _ = tx.send(value);
                }
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                let _ = tx.send(value);
            }
        }
    });
    rx
}

fn spawn_mcp_stderr_reader(mut reader: impl Read + Send + 'static) -> Arc<Mutex<String>> {
    let output = Arc::new(Mutex::new(String::new()));
    let output_for_thread = output.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(count) => {
                    let chunk = String::from_utf8_lossy(&buffer[..count]).to_string();
                    let mut text = output_for_thread.lock().unwrap();
                    text.push_str(&chunk);
                    if text.len() > 16000 {
                        let keep_from = text.len().saturating_sub(16000);
                        *text = text[keep_from..].to_string();
                    }
                }
            }
        }
    });
    output
}

fn mcp_stderr_tail(stderr: Option<&Arc<Mutex<String>>>) -> String {
    stderr
        .and_then(|value| value.lock().ok().map(|text| text.trim().to_string()))
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn wait_mcp_response(
    rx: &mpsc::Receiver<Value>,
    id: u64,
    timeout: Duration,
    cancel_token: Option<&Arc<AtomicBool>>,
    stderr: Option<&Arc<Mutex<String>>>,
) -> Result<Value, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if cancel_token
            .map(|token| token.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            return Err("MCP request cancelled by user".to_string());
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(message) => {
                if message.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    return Err(format!("MCP error: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
                let stderr = mcp_stderr_tail(stderr);
                return if stderr.is_empty() {
                    Err("MCP server closed stdout without stderr. Check the MCP command, args, and working directory.".to_string())
                } else {
                    Err(format!("MCP server closed stdout: {stderr}"))
                };
            }
        }
    }
    Err("MCP request timed out".to_string())
}

fn stop_mcp_child_process(
    app: Option<&AppHandle>,
    child: &mut std::process::Child,
    registry_id: Option<&str>,
) {
    kill_process_tree_by_pid(child.id());
    let _ = child.kill();
    let _ = child.wait();
    if let (Some(app), Some(id)) = (app, registry_id) {
        unregister_agent_child_process(app, id);
    }
}

fn stop_mcp_child_on_error<T>(
    result: Result<T, String>,
    app: Option<&AppHandle>,
    child: &mut std::process::Child,
    registry_id: Option<&str>,
) -> Result<T, String> {
    match result {
        Ok(value) => Ok(value),
        Err(err) => {
            stop_mcp_child_process(app, child, registry_id);
            Err(err)
        }
    }
}

fn execute_mcp_call(
    app: Option<&AppHandle>,
    session_id: Option<&str>,
    root_path: &str,
    input: &Value,
) -> Result<Value, String> {
    let servers = merged_mcp_servers(root_path);
    let requested_server = input
        .get("server")
        .or_else(|| input.get("serverName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if mcp_call_is_tool_list(input) {
        return Ok(mcp_list_configured_servers(root_path, requested_server));
    }
    let server_name = if let Some(server_name) = requested_server {
        server_name.to_string()
    } else {
        let enabled = servers
            .iter()
            .enumerate()
            .filter(|(_, server)| mcp_server_enabled(server))
            .collect::<Vec<_>>();
        if enabled.len() == 1 {
            mcp_server_name(enabled[0].1, enabled[0].0)
        } else if enabled.is_empty() {
            return Err(
                "mcp_call requires server; no enabled MCP server is configured for this workspace."
                    .to_string(),
            );
        } else {
            return Err(
                "mcp_call requires server because multiple MCP servers are configured.".to_string(),
            );
        }
    };
    let (server_index, server) = servers
        .iter()
        .enumerate()
        .find(|(index, server)| mcp_server_name(server, *index) == server_name)
        .ok_or_else(|| format!("MCP server not configured: {server_name}"))?;
    if !mcp_server_enabled(server) {
        return Err(format!("MCP server is disabled: {server_name}"));
    }
    let command = server
        .get("command")
        .or_else(|| server.get("cmd"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "MCP server {} has no command",
                mcp_server_name(server, server_index)
            )
        })?;
    let args = server
        .get("args")
        .or_else(|| server.get("arguments"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let root = connector::resolve_authorized_root(root_path)?;
    let cwd = server
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .unwrap_or_else(|| root.clone());
    let cwd = connector::resolve_authorized_root(&cwd.to_string_lossy())?;
    let mut child_command = Command::new(command);
    child_command
        .args(args.iter())
        .current_dir(shell_path(&cwd))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = server.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                child_command.env(key, value);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child_command.creation_flags(0x08000000);
    }
    let mut child = child_command
        .spawn()
        .map_err(|err| format!("failed to start MCP server {server_name}: {err}"))?;
    let child_registry_id = app.and_then(|app| {
        session_id.map(|session_id| {
            register_agent_child_process(app, session_id, child.id(), "mcp", &server_name)
        })
    });
    let cancel_token = app
        .zip(session_id)
        .map(|(app, session_id)| agent_cancel_token_for(app, session_id));
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_mcp_child_process(app, &mut child, child_registry_id.as_deref());
            return Err("MCP stdout unavailable".to_string());
        }
    };
    let stderr_log = child.stderr.take().map(spawn_mcp_stderr_reader);
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            stop_mcp_child_process(app, &mut child, child_registry_id.as_deref());
            return Err("MCP stdin unavailable".to_string());
        }
    };
    let rx = spawn_mcp_frame_reader(stdout);
    let requested_tool_name = input
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let is_tool_list = mcp_call_is_tool_list(input);
    let timeout = Duration::from_secs(
        input
            .get("timeoutSecs")
            .or_else(|| input.get("timeout"))
            .and_then(Value::as_u64)
            .unwrap_or(if is_tool_list { 15 } else { 45 })
            .clamp(5, 240),
    );
    stop_mcp_child_on_error(
        write_mcp_frame(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "AutoCode IDE", "version": connector::VERSION }
                }
            }),
        ),
        app,
        &mut child,
        child_registry_id.as_deref(),
    )?;
    let initialize =
        match wait_mcp_response(&rx, 1, timeout, cancel_token.as_ref(), stderr_log.as_ref()) {
            Ok(value) => value,
            Err(err) => {
                stop_mcp_child_process(app, &mut child, child_registry_id.as_deref());
                return Err(err);
            }
        };
    let _ = write_mcp_frame(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    );
    let action = input
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("call");
    let (method, params) = if is_tool_list || action == "list" || action == "tools/list" {
        ("tools/list", json!({}))
    } else {
        let tool = requested_tool_name;
        if tool.is_empty() {
            stop_mcp_child_process(app, &mut child, child_registry_id.as_deref());
            return Err("mcp_call requires tool".to_string());
        }
        let arguments = input
            .get("arguments")
            .or_else(|| input.get("args"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        (
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
    };
    stop_mcp_child_on_error(
        write_mcp_frame(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": method,
                "params": params
            }),
        ),
        app,
        &mut child,
        child_registry_id.as_deref(),
    )?;
    let result =
        match wait_mcp_response(&rx, 2, timeout, cancel_token.as_ref(), stderr_log.as_ref()) {
            Ok(value) => value,
            Err(err) => {
                stop_mcp_child_process(app, &mut child, child_registry_id.as_deref());
                return Err(err);
            }
        };
    stop_mcp_child_process(app, &mut child, child_registry_id.as_deref());
    Ok(json!({
        "ok": true,
        "server": server_name,
        "command": command,
        "args": args,
        "method": method,
        "initialize": initialize,
        "result": result
    }))
}

fn merged_hooks(root_path: &str, settings: Option<&connector::IdeSettings>) -> Vec<Value> {
    let mut hooks = Vec::new();
    if let Some(global) = settings.and_then(|value| value.hooks.as_array()) {
        hooks.extend(global.iter().cloned());
    }
    if let Some(project) = project_autocode_settings(root_path)
        .get("hooks")
        .and_then(Value::as_array)
    {
        hooks.extend(project.iter().cloned());
    }
    hooks
}

fn hook_string_list(value: &Value, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn hook_matches_event_and_tool(hook: &Value, event: &str, tool: &str) -> bool {
    let hook_event = hook
        .get("event")
        .or_else(|| hook.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !hook_event.eq_ignore_ascii_case(event) {
        return false;
    }
    let hook_tool = hook.get("tool").and_then(Value::as_str).unwrap_or("*");
    hook_tool == "*" || hook_tool.eq_ignore_ascii_case(tool)
}

fn hook_name(hook: &Value, fallback: &str) -> String {
    hook.get("name")
        .or_else(|| hook.get("id"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn hook_command(hook: &Value) -> Option<String> {
    hook.get("command")
        .or_else(|| hook.get("cmd"))
        .or_else(|| hook.get("run"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn run_hook_commands(root_path: &str, event: &str, tool: &str, hooks: &[Value]) -> Vec<Value> {
    let mut results = Vec::new();
    for hook in hooks
        .iter()
        .filter(|hook| hook_matches_event_and_tool(hook, event, tool))
    {
        let Some(command) = hook_command(hook) else {
            continue;
        };
        let name = hook_name(hook, event);
        let block_on_failure = hook
            .get("blockOnFailure")
            .or_else(|| hook.get("block_on_failure"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !is_safe_auto_approved_bash(&command) {
            results.push(json!({
                "name": name,
                "event": event,
                "tool": tool,
                "command": command,
                "ok": false,
                "skipped": true,
                "blockOnFailure": block_on_failure,
                "reason": "hook command is outside the safe auto-run allowlist"
            }));
            continue;
        }
        let timeout = hook
            .get("timeoutSecs")
            .or_else(|| hook.get("timeout"))
            .and_then(Value::as_u64)
            .unwrap_or(30);
        match connector::run_workspace_command(root_path, &command, Some(timeout)) {
            Ok(result) => results.push(json!({
                "name": name,
                "event": event,
                "tool": tool,
                "command": result.command,
                "cwd": result.cwd,
                "ok": result.ok,
                "exitCode": result.exit_code,
                "output": result.output,
                "truncated": result.truncated,
                "blockOnFailure": block_on_failure
            })),
            Err(error) => results.push(json!({
                "name": name,
                "event": event,
                "tool": tool,
                "command": command,
                "ok": false,
                "error": error,
                "blockOnFailure": block_on_failure
            })),
        }
    }
    results
}

fn run_pre_tool_hooks(
    app: &AppHandle,
    session_id: &str,
    root_path: &str,
    settings: Option<&connector::IdeSettings>,
    tool: &str,
    input: &Value,
) -> Result<(), String> {
    let hooks = merged_hooks(root_path, settings);
    if hooks.is_empty() {
        return Ok(());
    }
    agent_emit(
        app,
        session_id,
        "hook_start",
        json!({
            "event": "PreToolUse",
            "tool": tool,
            "input": input,
            "count": hooks.len()
        }),
    );
    let blocked_by = evaluate_pre_tool_hook_block(&hooks, tool, input);
    if let Some(reason) = blocked_by {
        agent_emit(
            app,
            session_id,
            "hook_result",
            json!({
                "event": "PreToolUse",
                "tool": tool,
                "blocked": true,
                "reason": reason
            }),
        );
        return Err(format!("blocked by hook: {reason}"));
    }
    let command_results = run_hook_commands(root_path, "PreToolUse", tool, &hooks);
    if let Some(blocked) = command_results.iter().find(|item| {
        item.get("blockOnFailure")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && item.get("ok").and_then(Value::as_bool) != Some(true)
    }) {
        let reason = blocked
            .get("reason")
            .or_else(|| blocked.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("hook command failed");
        agent_emit(
            app,
            session_id,
            "hook_result",
            json!({
                "event": "PreToolUse",
                "tool": tool,
                "blocked": true,
                "reason": reason,
                "commands": command_results
            }),
        );
        return Err(format!("blocked by hook command: {reason}"));
    }
    agent_emit(
        app,
        session_id,
        "hook_result",
        json!({
            "event": "PreToolUse",
            "tool": tool,
            "blocked": false,
            "commands": command_results
        }),
    );
    Ok(())
}

fn evaluate_pre_tool_hook_block(hooks: &[Value], tool: &str, input: &Value) -> Option<String> {
    for hook in hooks {
        let event = hook
            .get("event")
            .or_else(|| hook.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !event.eq_ignore_ascii_case("PreToolUse") {
            continue;
        }
        let hook_tool = hook.get("tool").and_then(Value::as_str).unwrap_or("*");
        if hook_tool != "*" && !hook_tool.eq_ignore_ascii_case(tool) {
            continue;
        }
        if tool == "bash" {
            let command = input
                .get("command")
                .or_else(|| input.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let blocked_patterns = hook_string_list(
                &hook,
                &["denyContains", "blockContains", "dangerousCommands"],
            );
            if let Some(pattern) = blocked_patterns
                .iter()
                .find(|pattern| !pattern.is_empty() && command.contains(pattern.as_str()))
            {
                return Some(format!(
                    "{}: {}",
                    hook.get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("PreToolUse"),
                    pattern
                ));
            }
        }
    }
    None
}

fn emit_post_tool_hook(
    app: &AppHandle,
    session_id: &str,
    root_path: &str,
    settings: Option<&connector::IdeSettings>,
    tool: &str,
    call: &Value,
) {
    let hooks = merged_hooks(root_path, settings);
    let command_results = run_hook_commands(root_path, "PostToolUse", tool, &hooks);
    if !hooks.is_empty() {
        agent_emit(
            app,
            session_id,
            "hook_start",
            json!({
                "event": "PostToolUse",
                "tool": tool,
                "count": hooks.len()
            }),
        );
    }
    agent_emit(
        app,
        session_id,
        "hook_result",
        json!({
            "event": "PostToolUse",
            "tool": tool,
            "status": call.get("status").cloned().unwrap_or_else(|| json!("ok")),
            "error": call.get("error").cloned().unwrap_or(Value::Null),
            "commands": command_results
        }),
    );
}

fn emit_process_events_for_tool_call(app: &AppHandle, session_id: &str, call: &Value) {
    if call.get("name").and_then(Value::as_str) != Some("bash") {
        return;
    }
    let output = call.get("output").cloned().unwrap_or_else(|| json!({}));
    if output.get("background").and_then(Value::as_bool) != Some(true) {
        return;
    }
    let pid = output.get("pid").cloned().unwrap_or(Value::Null);
    agent_emit(
        app,
        session_id,
        "process_start",
        json!({
            "id": format!("process-{}", pid.as_u64().unwrap_or(0)),
            "pid": pid,
            "command": output.get("command").cloned().unwrap_or(Value::Null),
            "cwd": output.get("cwd").cloned().unwrap_or(Value::Null),
            "background": true
        }),
    );
}

fn spawn_agent_process_output_reader(
    app: AppHandle,
    session_id: String,
    process_id: String,
    stream_name: &'static str,
    mut reader: Box<dyn Read + Send>,
    last_output: Arc<Mutex<String>>,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(_) => break,
            };
            let data = String::from_utf8_lossy(&buffer[..read]).to_string();
            if data.is_empty() {
                continue;
            }
            {
                let mut output = last_output.lock().unwrap();
                output.push_str(&data);
                if output.chars().count() > 40000 {
                    *output = tail_chars(&output, 40000);
                }
            }
            agent_emit(
                &app,
                &session_id,
                "process_output",
                json!({
                    "id": process_id,
                    "sessionId": session_id,
                    "stream": stream_name,
                    "data": data,
                    "at": agent_now()
                }),
            );
        }
    });
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
            lower.starts_with(prefix)
                && (lower.contains(" run dev")
                    || lower.ends_with(" start")
                    || lower.contains(" run start"))
        } else {
            lower == *prefix || lower.starts_with(&format!("{prefix} "))
        }
    })
}

fn infer_npm_script_command(
    root_path: &str,
    package_path: &str,
    preferred: &[&str],
) -> Option<String> {
    let file = connector::read_workspace_file(root_path, package_path).ok()?;
    let parsed = serde_json::from_str::<Value>(&file.content).ok()?;
    let scripts = parsed.get("scripts").and_then(Value::as_object)?;
    let script = preferred
        .iter()
        .copied()
        .find(|name| scripts.contains_key(*name))?;
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

fn npm_script_exists(root_path: &str, package_path: &str, script: &str) -> bool {
    connector::read_workspace_file(root_path, package_path)
        .ok()
        .and_then(|file| serde_json::from_str::<Value>(&file.content).ok())
        .and_then(|parsed| parsed.get("scripts").and_then(Value::as_object).cloned())
        .map(|scripts| scripts.contains_key(script))
        .unwrap_or(false)
}

fn detect_diagnostics_command(root_path: &str) -> Option<String> {
    for script in ["typecheck", "lint", "build"] {
        if npm_script_exists(root_path, "package.json", script) {
            return Some(format!("npm run {script}"));
        }
    }
    if connector::read_workspace_file(root_path, "Cargo.toml").is_ok() {
        return Some("cargo check".to_string());
    }
    if connector::read_workspace_file(root_path, "pyproject.toml").is_ok() {
        return Some("python -m pytest --collect-only".to_string());
    }
    None
}

fn detect_test_command(root_path: &str) -> Option<String> {
    if npm_script_exists(root_path, "package.json", "test") {
        return Some("npm test".to_string());
    }
    if connector::read_workspace_file(root_path, "Cargo.toml").is_ok() {
        return Some("cargo test".to_string());
    }
    if connector::read_workspace_file(root_path, "pyproject.toml").is_ok()
        || connector::read_workspace_file(root_path, "pytest.ini").is_ok()
    {
        return Some("python -m pytest".to_string());
    }
    None
}

fn run_detected_workspace_command(
    root_path: &str,
    kind: &str,
    command: Option<String>,
    timeout_secs: u64,
) -> Result<Value, String> {
    let Some(command) = command else {
        return Ok(json!({
            "ok": false,
            "kind": kind,
            "supported": false,
            "message": format!("No {kind} command is configured for this workspace.")
        }));
    };
    if !is_safe_auto_approved_bash(&command) {
        return Ok(json!({
            "ok": false,
            "kind": kind,
            "supported": false,
            "command": command,
            "message": "Detected command is not in the safe auto-run allowlist."
        }));
    }
    let result = connector::run_workspace_command(root_path, &command, Some(timeout_secs))?;
    Ok(json!({
        "ok": result.ok,
        "kind": kind,
        "supported": true,
        "command": result.command,
        "cwd": result.cwd,
        "exitCode": result.exit_code,
        "output": result.output,
        "truncated": result.truncated
    }))
}

fn is_local_preview_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

fn html_title(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(open_end) = lower[start..].find('>').map(|index| start + index + 1) else {
        return String::new();
    };
    let Some(close) = lower[open_end..]
        .find("</title>")
        .map(|index| open_end + index)
    else {
        return String::new();
    };
    text[open_end..close]
        .replace('\n', " ")
        .replace('\r', " ")
        .trim()
        .chars()
        .take(180)
        .collect()
}

fn strip_html_for_preview(text: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
        if out.len() > 4000 {
            break;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn browser_preview_value(input: &Value) -> Result<Value, String> {
    let raw_url = input
        .get("url")
        .or_else(|| input.get("href"))
        .and_then(Value::as_str)
        .unwrap_or("http://localhost:5173")
        .trim();
    let parsed = url::Url::parse(raw_url).map_err(|err| format!("invalid preview URL: {err}"))?;
    if parsed.scheme() != "http" {
        return Err("browser_preview only supports local http:// URLs in this build".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "browser_preview URL requires a host".to_string())?;
    if !is_local_preview_host(host) {
        return Err("browser_preview only allows localhost, 127.0.0.1, or ::1".to_string());
    }
    let port = parsed.port_or_known_default().unwrap_or(80);
    let timeout = Duration::from_secs(
        input
            .get("timeoutSecs")
            .or_else(|| input.get("timeout"))
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .clamp(1, 30),
    );
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("failed to resolve local preview host: {err}"))?
        .next()
        .ok_or_else(|| "failed to resolve local preview host".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|err| format!("failed to connect preview server: {err}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let path = if let Some(query) = parsed.query() {
        format!("{}?{}", parsed.path(), query)
    } else if parsed.path().is_empty() {
        "/".to_string()
    } else {
        parsed.path().to_string()
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: AutoCode-IDE-Agent/0.4.8\r\nAccept: text/html,application/xhtml+xml,text/plain,*/*;q=0.8\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("failed to write preview request: {err}"))?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.len() > 256 * 1024 {
                    break;
                }
            }
            Err(err) => return Err(format!("failed to read preview response: {err}")),
        }
    }
    let text = String::from_utf8_lossy(&response).to_string();
    let (headers, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status_line = headers.lines().next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let content_type = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                .map(|(_, value)| value.trim().to_string())
        })
        .unwrap_or_default();
    let title = html_title(body);
    let text_preview = strip_html_for_preview(body);
    Ok(json!({
        "ok": (200..400).contains(&status),
        "url": parsed.as_str(),
        "status": status,
        "statusLine": status_line,
        "contentType": content_type,
        "title": title,
        "bodyBytes": body.len(),
        "snippet": text_preview.chars().take(1200).collect::<String>(),
        "truncated": response.len() > 256 * 1024,
        "message": if (200..400).contains(&status) { "Local preview responded successfully." } else { "Local preview returned a non-success status." }
    }))
}

fn infer_backend_start_command(root_path: &str) -> Option<String> {
    infer_npm_script_command(
        root_path,
        "server/package.json",
        &["dev", "start", "server", "backend"],
    )
    .or_else(|| {
        infer_npm_script_command(
            root_path,
            "backend/package.json",
            &["dev", "start", "server", "backend"],
        )
    })
    .or_else(|| {
        infer_npm_script_command(
            root_path,
            "api/package.json",
            &["dev", "start", "server", "backend"],
        )
    })
    .or_else(|| {
        infer_npm_script_command(
            root_path,
            "package.json",
            &[
                "server",
                "backend",
                "dev:server",
                "dev:backend",
                "start:server",
            ],
        )
    })
}

fn extract_direct_agent_command(root_path: &str, message: &str) -> Option<String> {
    let trimmed = message.trim();
    if let Some(command) = trimmed
        .strip_prefix('!')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(command.to_string());
    }
    let normalized = trimmed
        .replace('\u{ff1a}', ":")
        .replace('\u{ff0c}', " ")
        .replace('\u{3002}', " ")
        .replace('\n', " ");
    let lower = normalized.to_ascii_lowercase();
    let wants_execution = [
        "\u{8fd0}\u{884c}",
        "\u{6267}\u{884c}",
        "\u{542f}\u{52a8}",
        "\u{8dd1}\u{4e00}\u{4e2a}",
        "\u{53bb}\u{6267}\u{884c}",
        "\u{5e2e}\u{6211}\u{8dd1}",
        "\u{5e2e}\u{6211}\u{8fd0}\u{884c}",
        "\u{5e2e}\u{6211}\u{542f}\u{52a8}",
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
    if lower.contains("\u{540e}\u{7aef}") || lower.contains("backend") || lower.contains("server") {
        if let Some(command) = infer_backend_start_command(root_path) {
            return Some(command);
        }
    }
    if lower.contains("\u{5f00}\u{53d1}\u{6d4b}\u{8bd5}")
        || lower.contains("dev server")
        || lower.contains("\u{5f00}\u{53d1}\u{670d}\u{52a1}")
    {
        return Some("npm run dev".to_string());
    }
    None
}

fn spawn_agent_background_command(
    app: Option<&AppHandle>,
    session_id: Option<&str>,
    root_path: &str,
    command: &str,
) -> Result<Value, String> {
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let mut child = process
        .spawn()
        .map_err(|err| format!("failed to start background command: {err}"))?;
    let pid = child.id();
    let process_id = format!("process-{pid}");
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let last_output = Arc::new(Mutex::new(String::new()));
    if let Some(app) = app {
        let session_id = session_id.unwrap_or("").to_string();
        if let Some(stdout) = stdout {
            spawn_agent_process_output_reader(
                app.clone(),
                session_id.clone(),
                process_id.clone(),
                "stdout",
                Box::new(stdout),
                last_output.clone(),
            );
        }
        if let Some(stderr) = stderr {
            spawn_agent_process_output_reader(
                app.clone(),
                session_id.clone(),
                process_id.clone(),
                "stderr",
                Box::new(stderr),
                last_output.clone(),
            );
        }
        let state = app.state::<IdeRuntimeState>();
        state.agent_processes.lock().unwrap().insert(
            process_id.clone(),
            AgentProcess {
                child,
                session_id,
                root_path: root_path.to_string(),
                command: command.to_string(),
                cwd: shell_root.to_string_lossy().to_string(),
                started_at: agent_now(),
                last_output: last_output.clone(),
            },
        );
    }
    Ok(json!({
        "id": process_id,
        "command": command,
        "cwd": shell_root.to_string_lossy(),
        "ok": true,
        "background": true,
        "pid": pid,
        "message": "development server started in an Agent-managed background process"
    }))
}

fn extract_patch_preview(answer: &str) -> Option<Value> {
    let patch = normalize_agent_unified_patch(answer).ok()?;
    Some(json!({
        "id": format!("patch-{}", agent_now()),
        "patch": patch,
        "patchKind": if patch.contains("*** Begin Patch") { "codex" } else { "unified" },
        "summary": patch_preview_summary(&patch),
        "diagnostics": [],
        "requiresApproval": true,
        "files": parse_paths_from_agent_patch(&patch)
    }))
}

fn answer_contains_substantial_code_block(answer: &str) -> bool {
    let mut in_fence = false;
    let mut fence_lang = String::new();
    let mut line_count = 0usize;
    let mut char_count = 0usize;
    for line in answer.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            if in_fence {
                if line_count >= 8 || char_count >= 500 {
                    let lang = fence_lang.to_ascii_lowercase();
                    if !matches!(
                        lang.as_str(),
                        "" | "text"
                            | "txt"
                            | "log"
                            | "bash"
                            | "sh"
                            | "shell"
                            | "powershell"
                            | "cmd"
                    ) {
                        return true;
                    }
                }
                in_fence = false;
                fence_lang.clear();
                line_count = 0;
                char_count = 0;
            } else {
                in_fence = true;
                fence_lang = trimmed.trim_matches('`').trim().to_string();
                line_count = 0;
                char_count = 0;
            }
            continue;
        }
        if in_fence {
            line_count += 1;
            char_count += line.len();
        }
    }
    false
}

fn extract_agent_tool_requests(answer: &str) -> Vec<Value> {
    let mut candidates = Vec::new();
    let dsml = extract_dsml_tool_calls(answer);
    if !dsml.is_empty() {
        return dsml;
    }
    let mut detector = AgentStreamToolDetector::default();
    let detection = detector.feed(answer);
    if let Some(tool_requests) = detection.tool_requests {
        return tool_requests;
    }
    if let Some(tool_requests) = detector.finish().tool_requests {
        return tool_requests;
    }
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
                if fence_lang.contains("json")
                    || fence_lang.contains("tool")
                    || fence_lang.contains("agent")
                {
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
                    if let Some(AgentParsedStep::Final(content)) =
                        parse_agent_step_candidate(&buffer)
                    {
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
    if let Some(step) = value
        .get("action")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
    {
        let step = step.trim().to_ascii_lowercase();
        if matches!(
            step.as_str(),
            "final" | "final_answer" | "answer" | "message"
        ) {
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
            if let Some(items) = value
                .get("tools")
                .or_else(|| value.get("tool_calls"))
                .and_then(Value::as_array)
            {
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
                if input
                    .as_object()
                    .map(|object| object.is_empty())
                    .unwrap_or(false)
                {
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
        let normalized_action_tool = normalize_agent_tool_name(&step);
        if normalized_action_tool != step || agent_tool_name_is_builtin(&normalized_action_tool) {
            let mut input = tool_input(&value);
            if let Some(raw) = input.as_str() {
                input = parse_native_tool_arguments(raw);
            }
            if input
                .as_object()
                .map(|object| object.is_empty())
                .unwrap_or(false)
            {
                if let Some(command) = value.get("command").and_then(Value::as_str) {
                    input = json!({ "command": command });
                } else if let Some(path) = value
                    .get("path")
                    .or_else(|| value.get("file"))
                    .and_then(Value::as_str)
                {
                    input = json!({ "path": path });
                } else if let Some(query) = value.get("query").and_then(Value::as_str) {
                    input = json!({ "query": query });
                } else if let Some(patch) = value
                    .get("patch")
                    .or_else(|| value.get("diff"))
                    .and_then(Value::as_str)
                {
                    input = json!({ "patch": patch });
                }
            }
            return Some(AgentParsedStep::Tool(vec![json!({
                "tool": normalized_action_tool,
                "input": input,
                "source": "agent_action_tool"
            })]));
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
    let command = clean_agent_bash_command(content);
    if command.is_empty() {
        return None;
    }
    Some(json!({
        "tool": "bash",
        "input": { "command": command },
        "source": "fenced_shell_block"
    }))
}

fn native_tool_requests_from_chat_message(provider: &str, tool_calls: &[Value]) -> Vec<Value> {
    tool_calls
        .iter()
        .filter_map(|call| {
            let id = call
                .get("id")
                .or_else(|| call.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or("tool_call")
                .to_string();
            let name = call
                .pointer("/function/name")
                .or_else(|| call.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let arguments = call
                .pointer("/function/arguments")
                .or_else(|| call.get("arguments"))
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string())
                })
                .unwrap_or_default();
            native_tool_request(name, arguments, id, provider)
        })
        .collect()
}

fn native_tool_call_id(request: &Value, fallback: &str) -> String {
    request
        .pointer("/native/id")
        .or_else(|| request.get("id"))
        .or_else(|| request.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn native_chat_tool_call_from_request(request: &Value, fallback_id: &str) -> Value {
    let name = request
        .get("tool")
        .or_else(|| request.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let input = tool_input(request);
    let arguments = input
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| input.to_string());
    json!({
        "id": native_tool_call_id(request, fallback_id),
        "type": "function",
        "function": {
            "name": name,
            "arguments": arguments
        }
    })
}

fn provider_uses_chat_tool_messages(provider: &str) -> bool {
    provider_adapter(provider).chat_tool_messages()
}

fn agent_tool_result_message_content(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn deepseek_reasoning_tool_compat_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("deepseek")
        && (lower.contains("reasoning")
            || lower.contains("reasoning_content")
            || lower.contains("thinking"))
        && (lower.contains("tool")
            || lower.contains("tool_call")
            || lower.contains("tool_calls")
            || lower.contains("messages"))
}

fn provider_timeout_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("agent stream request timed out")
        || lower.contains("ai request timed out")
        || lower.contains("request or operation timed out")
        || lower.contains("operation timed out")
}

fn terminal_provider_request_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    if lower.contains("agent stream completed without text or tool call") {
        return false;
    }
    if provider_timeout_error(error) {
        return false;
    }
    let provider_request_failed = lower.contains("ai provider returned")
        || lower.contains("cannot connect to ai provider")
        || lower.contains("agent stream request failed")
        || lower.contains("ai request failed");
    provider_request_failed
        || lower.contains(" 500")
        || lower.contains(" 501")
        || lower.contains(" 502")
        || lower.contains(" 503")
        || lower.contains(" 504")
        || lower.contains(" 429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("insufficient")
        || lower.contains("insufficient_quota")
        || lower.contains("balance")
        || lower.contains("quota")
        || lower.contains("billing")
        || lower.contains("payment")
        || lower.contains("402")
        || lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || lower.contains("api key")
        || lower.contains("authentication")
        || lower.contains("璐︽埛浣欓")
        || lower.contains("浣欓涓嶈冻")
        || lower.contains("娆犺垂")
}

fn clean_agent_bash_command(command: &str) -> String {
    let mut lines = command
        .replace("\r\n", "\n")
        .lines()
        .map(|line| line.trim_end())
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && trimmed != "```" && !trimmed.starts_with("```")
        })
        .map(|line| {
            line.trim()
                .trim_start_matches("$ ")
                .trim_start_matches("> ")
                .to_string()
        })
        .collect::<Vec<_>>();
    if lines.len() > 1 {
        let mut kept = Vec::new();
        for line in lines {
            let trimmed = line.trim();
            if matches!(trimmed, "or:" | "then:" | "然后:" | "或:") {
                break;
            }
            if trimmed.starts_with("or:")
                || trimmed.starts_with("then:")
                || trimmed.starts_with("然后")
                || trimmed.starts_with("或:")
                || trimmed.starts_with("注意")
            {
                break;
            }
            kept.push(line);
        }
        lines = kept;
    }
    lines.join(" && ").trim().to_string()
}

fn sanitize_agent_bash_input(input: &mut Value) {
    let command = input
        .get("command")
        .or_else(|| input.get("cmd"))
        .and_then(Value::as_str)
        .map(clean_agent_bash_command);
    if let Some(command) = command.filter(|value| !value.trim().is_empty()) {
        if let Some(object) = input.as_object_mut() {
            object.insert("command".to_string(), Value::String(command));
            object.remove("cmd");
        }
    }
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

fn find_inline_agent_json_start(text: &str) -> Option<usize> {
    agent_json_start_patterns()
        .iter()
        .filter_map(|pattern| text.find(pattern))
        .min()
}

fn agent_json_start_patterns() -> [&'static str; 10] {
    [
        "{\"action\"",
        "{ \"action\"",
        "{\"tool\"",
        "{ \"tool\"",
        "{\"name\"",
        "{ \"name\"",
        "[{\"tool\"",
        "[ {\"tool\"",
        "[{\"action\"",
        "[ {\"action\"",
    ]
}

fn pending_agent_json_prefix_start(text: &str) -> Option<usize> {
    let mut starts = text
        .char_indices()
        .filter_map(|(index, ch)| {
            if ch == '{' || ch == '[' {
                Some(index)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    starts.reverse();
    for index in starts {
        let suffix = text[index..].trim_start();
        if suffix.len() > 40 {
            continue;
        }
        if agent_json_start_patterns()
            .iter()
            .any(|pattern| pattern.starts_with(suffix))
        {
            return Some(index);
        }
    }
    None
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
                    let fence_index = self.pending.find("```");
                    if let Some(index) = find_inline_agent_json_start(&self.pending)
                        .filter(|index| fence_index.map(|fence| *index < fence).unwrap_or(true))
                    {
                        if index > 0 {
                            let text = self.pending[..index].to_string();
                            self.mark_visible(&text);
                            visible_delta.push_str(&text);
                        }
                        let content = self.pending[index..].to_string();
                        self.pending.clear();
                        self.mode = AgentToolDetectorMode::RawJson { content };
                        continue;
                    }
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
                        } else if let Some(json_prefix) =
                            pending_agent_json_prefix_start(&self.pending)
                        {
                            self.pending.len().saturating_sub(json_prefix)
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
    fn detects_line_start_raw_json_tool() {
        let mut detector = AgentStreamToolDetector::default();
        let result = detector.feed("{\"tool\":\"read_file\",\"input\":{\"path\":\"src/main.rs\"}}");
        let tools = result.tool_requests.expect("tool should be detected");
        assert_eq!(
            tools[0].get("tool").and_then(Value::as_str),
            Some("read_file")
        );
        assert_eq!(
            tools[0].pointer("/input/path").and_then(Value::as_str),
            Some("src/main.rs")
        );
    }

    #[test]
    fn detects_action_named_tool_after_visible_text() {
        let mut detector = AgentStreamToolDetector::default();
        let first = detector.feed("I will apply this change. ");
        let second = detector.feed("{\"action\":\"apply_patch\",\"input\":{\"patch\":\"diff --git a/a.txt b/a.txt\\n--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n\"}}");
        assert_eq!(first.visible_delta, "I will apply this change. ");
        let tools = second.tool_requests.expect("tool should be detected");
        assert_eq!(
            tools[0].get("tool").and_then(Value::as_str),
            Some("apply_patch")
        );
        assert!(tools[0]
            .pointer("/input/patch")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("diff --git"));
    }

    #[test]
    fn detects_shell_fence_as_bash_tool() {
        let mut detector = AgentStreamToolDetector::default();
        let result = detector.feed("I will start.\n```bash\ncat package.json\n```");
        assert_eq!(result.visible_delta, "I will start.\n");
        let tools = result
            .tool_requests
            .expect("shell fence should become bash tool");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("bash"));
        assert_eq!(
            tools[0].pointer("/input/command").and_then(Value::as_str),
            Some("cat package.json")
        );
    }

    #[test]
    fn pending_question_requires_real_question_text() {
        assert!(pending_question_is_actionable(&json!({
            "input": { "question": "Allow reading `langchain1/`?" },
            "output": { "question": "Allow reading `langchain1/`?", "requiresUserResponse": true }
        })));
        assert!(!pending_question_is_actionable(&json!({
            "input": { "target": "question" },
            "output": { "question": "Need more information to continue.", "requiresUserResponse": true }
        })));
    }

    #[test]
    fn planning_question_requires_options_and_placeholder() {
        assert!(planning_question_input_is_valid(&json!({
            "question": "Choose the implementation direction.",
            "options": [
                { "label": "Recommended", "value": "recommended" },
                { "label": "Minimal", "value": "minimal" }
            ],
            "placeholder": "Add constraints or questions..."
        }))
        .is_ok());
        assert!(planning_question_input_is_valid(&json!({
            "question": "Choose the implementation direction.",
            "options": [{ "label": "Recommended", "value": "recommended" }],
            "placeholder": "Add constraints or questions..."
        }))
        .is_err());
        assert!(planning_question_input_is_valid(&json!({
            "question": "Choose the implementation direction.",
            "options": [
                { "label": "Recommended", "value": "recommended" },
                { "label": "Minimal", "value": "minimal" }
            ]
        }))
        .is_err());
    }

    #[test]
    fn planning_answer_detects_followup_constraints() {
        assert!(planning_answer_is_followup(
            "\u{6211}\u{60f3}\u{6539}\u{6210} B \u{65b9}\u{6848}"
        ));
        assert!(planning_answer_is_followup(
            "\u{8fd9}\u{6837}\u{4f1a}\u{4e0d}\u{4f1a}\u{5f71}\u{54cd}\u{6027}\u{80fd}\u{ff1f}"
        ));
        assert!(!planning_answer_is_followup("confirm recommended option"));
    }

    #[test]
    fn glob_cache_key_includes_pattern_and_limit() {
        let ts_key = agent_tool_cache_key(
            "glob",
            &json!({
                "path": "src",
                "pattern": "**/*.ts",
                "limit": 50,
                "__cacheHit": true,
                "__cacheKey": "ignored"
            }),
        );
        let rs_key = agent_tool_cache_key(
            "glob",
            &json!({
                "path": "src",
                "pattern": "**/*.rs",
                "limit": 50
            }),
        );
        let limited_key = agent_tool_cache_key(
            "glob",
            &json!({
                "path": "src",
                "pattern": "**/*.ts",
                "limit": 10
            }),
        );
        assert_ne!(ts_key, rs_key);
        assert_ne!(ts_key, limited_key);
        assert!(ts_key.contains("**/*.ts"));
        assert!(!ts_key.contains("__cacheHit"));
    }

    #[test]
    fn responses_completed_events_end_stream_without_done_marker() {
        assert!(responses_stream_event_is_terminal("response.completed"));
        assert!(responses_stream_event_is_terminal("response.incomplete"));
        assert!(responses_stream_event_is_terminal("response.failed"));
        assert!(responses_stream_event_is_terminal("response.cancelled"));
        assert!(!responses_stream_event_is_terminal(
            "response.output_text.delta"
        ));
    }

    #[test]
    fn planning_contract_requires_initial_question_card_and_complete_sections() {
        let contract = agent_profile_system_contract("plan");
        assert!(contract.contains("first planning turn MUST call the question tool"));
        assert!(contract.contains("exactly 2-3 concrete options"));
        assert!(contract.contains("Advisory-only analysis"));
        assert!(contract.contains("Summary（摘要）"));
        assert!(contract.contains("Key Changes（关键改动）"));
        assert!(contract.contains("Public Interfaces（公共接口）"));
        assert!(contract.contains("None（无）"));
        assert!(contract.contains("Do not end with phrases like"));
        assert!(contract.contains("do not call todowrite before the final confirmed plan"));
    }

    #[test]
    fn planning_turn_contract_starts_with_question_then_finalizes_plan() {
        let start = agent_profile_turn_contract(
            "plan",
            &json!({ "sessionSnapshot": { "profileId": "plan", "planningAnswers": [] } }),
        );
        assert!(start.contains("PLAN_MODE_START_PROTOCOL"));
        assert!(start.contains("must be a question tool call"));
        assert!(start.contains("Do not output advisory analysis"));

        let finalize = agent_profile_turn_contract(
            "plan",
            &json!({ "sessionSnapshot": { "profileId": "plan", "planningAnswers": ["确认开发目标"] } }),
        );
        assert!(finalize.contains("PLAN_MODE_FINALIZE_PROTOCOL"));
        assert!(finalize.contains("Produce the confirmed executable development plan"));
        assert!(finalize.contains("Summary（摘要）"));
        assert!(finalize.contains("todowrite"));
    }

    #[test]
    fn tool_budget_error_becomes_scope_question() {
        let question = agent_scope_question_for_guard_error(
            "glob",
            &json!({ "path": "", "maxDepth": 2 }),
            "Tool call budget exceeded for glob: 6/5. Narrow the search or summarize from current evidence.",
        )
        .expect("budget guard should become a question");
        assert!(question
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("预算保护"));
        assert!(question
            .get("options")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|option| option
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("workspace")));
    }

    #[test]
    fn chinese_scope_answer_allows_global_scan() {
        assert!(question_answer_allows_v2("允许全项目 workspace"));
        assert!(prompt_allows_global_scan_v2("允许全项目 workspace"));
        assert!(!question_answer_denies_v2("允许全项目 workspace"));
    }

    #[test]
    fn treats_mcp_picker_target_without_arguments_as_tool_list() {
        assert!(mcp_call_is_tool_list(&json!({
            "target": "filesystem - list_directory"
        })));
        assert!(mcp_call_is_tool_list(&json!({
            "tool": "tools/list",
            "target": "filesystem - list_directory"
        })));
        assert!(!mcp_call_is_tool_list(&json!({
            "tool": "list_directory",
            "server": "filesystem",
            "arguments": { "path": "." }
        })));
    }

    #[test]
    fn responses_provider_does_not_use_chat_tool_result_role() {
        assert!(!provider_uses_chat_tool_messages("openai-responses"));
        assert!(!provider_uses_chat_tool_messages("qwen-responses"));
        assert!(!provider_uses_chat_tool_messages("local-openai-compatible"));
        assert!(provider_uses_chat_tool_messages("openai-chat"));
        assert!(provider_uses_chat_tool_messages("deepseek"));
        assert!(provider_uses_chat_tool_messages("kimi"));
    }

    #[test]
    fn local_provider_defaults_to_responses_endpoint() {
        let mut settings = connector::IdeSettings::default();
        settings.provider_type = "local-openai-compatible".to_string();
        settings.api_protocol = "auto".to_string();
        settings.api_base_url = "http://127.0.0.1:11434".to_string();

        assert_eq!(
            endpoint_for(&settings).unwrap(),
            "http://127.0.0.1:11434/v1/responses"
        );
    }

    #[test]
    fn local_provider_can_force_chat_completions() {
        let mut settings = connector::IdeSettings::default();
        settings.provider_type = "local-openai-compatible".to_string();
        settings.api_protocol = "chat_completions".to_string();
        settings.api_base_url = "http://127.0.0.1:11434".to_string();

        let effective = request_settings_for_protocol(settings);
        assert_eq!(effective.provider_type, "custom-openai-compatible");
        assert_eq!(
            endpoint_for(&effective).unwrap(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
    }

    #[test]
    fn local_responses_fallback_statuses_match_unsupported_endpoints() {
        assert!(responses_fallback_status(reqwest::StatusCode::NOT_FOUND));
        assert!(responses_fallback_status(
            reqwest::StatusCode::METHOD_NOT_ALLOWED
        ));
        assert!(responses_fallback_status(reqwest::StatusCode::NOT_IMPLEMENTED));
        assert!(!responses_fallback_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!responses_fallback_status(
            reqwest::StatusCode::UNAUTHORIZED
        ));
    }

    #[test]
    fn local_provider_empty_api_key_does_not_send_authorization() {
        let client = reqwest::Client::new();
        let mut settings = connector::IdeSettings::default();
        settings.provider_type = "local-openai-compatible".to_string();
        settings.api_base_url = "http://127.0.0.1:11434".to_string();
        settings.api_key = String::new();

        let request = ai_http_request(
            &client,
            "http://127.0.0.1:11434/v1/responses",
            &settings,
            "local-openai-compatible",
        )
        .build()
        .unwrap();

        assert!(request.headers().get("authorization").is_none());
    }

    #[test]
    fn extracts_openai_and_ollama_model_lists() {
        assert_eq!(
            extract_provider_model_names(&json!({
                "data": [{ "id": "gpt-local" }]
            })),
            vec!["gpt-local".to_string()]
        );
        assert_eq!(
            extract_provider_model_names(&json!({
                "models": [{ "name": "llama3.1:8b" }, { "model": "qwen2.5-coder:7b" }]
            })),
            vec!["llama3.1:8b".to_string(), "qwen2.5-coder:7b".to_string()]
        );
    }

    #[test]
    fn local_responses_tool_events_are_detected() {
        let mut accumulator = AgentNativeToolAccumulator::default();
        let event = json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_local",
                "name": "read_file",
                "arguments": "{\"path\":\"README.md\"}"
            }
        });

        let requests = accumulator
            .feed("local-openai-compatible", &event)
            .expect("local Responses tool event should produce a tool request");

        assert_eq!(
            requests[0].get("tool").and_then(Value::as_str),
            Some("read_file")
        );
        assert_eq!(
            requests[0]
                .pointer("/native/provider")
                .and_then(Value::as_str),
            Some("local-openai-compatible")
        );
    }

    #[test]
    fn normalizes_fenced_unified_patch() {
        let patch = normalize_agent_unified_patch("Here is the patch:\n```diff\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n```\n")
            .expect("fenced unified diff should normalize");
        assert!(patch.starts_with("diff --git a/a.txt b/a.txt"));
        assert!(patch.contains("@@ -1 +1 @@"));
    }

    #[test]
    fn rejects_non_diff_payload_with_actionable_hint() {
        let err = normalize_agent_unified_patch("just some plain code\nfn main() {}\n")
            .expect_err("plain code should not normalize as a patch");
        assert!(err.contains("not a valid unified diff"));
        assert!(patch_error_is_format_issue(&err));
    }

    #[test]
    fn detects_openai_chat_native_tool_call() {
        let mut native = AgentNativeToolAccumulator::default();
        assert!(native.feed("openai-chat", &json!({
            "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "grep", "arguments": "{\"query\":\"TODO\"}" } }] } }]
        })).is_none());
        let tools = native
            .feed(
                "openai-chat",
                &json!({
                    "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
                }),
            )
            .expect("native tool should be detected");
        assert_eq!(tools[0].get("tool").and_then(Value::as_str), Some("grep"));
        assert_eq!(
            tools[0].pointer("/input/query").and_then(Value::as_str),
            Some("TODO")
        );
    }
}

fn normalize_agent_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "read" | "read_file" | "local_read_text_file" => "read_file".to_string(),
        "grep" | "search" | "search_code" => "grep".to_string(),
        "glob" | "list" | "list_files" => "glob".to_string(),
        "write" | "write_file" | "edit" => "write".to_string(),
        "patch" | "apply_patch" => "apply_patch".to_string(),
        "memory" | "memory_update" | "update_memory" | "project_memory" => {
            "memory_update".to_string()
        }
        "bash" | "run_command" | "shell" => "bash".to_string(),
        "git_diff" | "diff" => "git_diff".to_string(),
        "todo" | "todowrite" => "todowrite".to_string(),
        "diagnostic" | "diagnostics" | "problems" => "diagnostics".to_string(),
        "test" | "tests" | "test_runner" => "test_runner".to_string(),
        "symbol" | "symbols" | "symbol_search" => "symbol_search".to_string(),
        "process" | "processes" | "process_manager" => "process_manager".to_string(),
        "browser" | "preview" | "browser_preview" | "web_preview" => "browser_preview".to_string(),
        "language_server" | "lsp" => "lsp".to_string(),
        "mcp" | "mcp_tool" | "mcp_call" | "fetch" | "list_tools" | "list_mcp_tools"
        | "mcp_list_tools" | "tools/list" => "mcp_call".to_string(),
        "question" | "ask" => "question".to_string(),
        other => other.to_string(),
    }
}

fn agent_tool_name_is_builtin(name: &str) -> bool {
    matches!(
        normalize_agent_tool_name(name).as_str(),
        "read_file"
            | "grep"
            | "glob"
            | "write"
            | "apply_patch"
            | "memory_update"
            | "bash"
            | "git_diff"
            | "todowrite"
            | "diagnostics"
            | "test_runner"
            | "symbol_search"
            | "process_manager"
            | "browser_preview"
            | "lsp"
            | "mcp_call"
            | "question"
    )
}

fn tool_input(value: &Value) -> Value {
    value
        .get("input")
        .or_else(|| value.get("args"))
        .or_else(|| value.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn first_string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn normalize_agent_tool_input(tool: &str, mut input: Value, request: &Value) -> Value {
    if let Some(raw) = input.as_str() {
        let parsed = parse_native_tool_arguments(raw);
        if parsed
            .as_object()
            .map(|object| !object.is_empty())
            .unwrap_or(false)
        {
            input = parsed;
        } else {
            let raw = raw.trim();
            if raw.is_empty() {
                input = json!({});
            } else {
                input = match tool {
                    "read_file" => json!({ "path": raw }),
                    "grep" | "symbol_search" => json!({ "query": raw }),
                    "glob" => json!({ "pattern": raw }),
                    "bash" => json!({ "command": raw }),
                    "apply_patch" | "memory_update" => json!({ "patch": raw }),
                    "question" => json!({ "question": raw }),
                    _ => Value::String(raw.to_string()),
                };
            }
        }
    }
    if !input.is_object() {
        return input;
    }
    let mut next = input.clone();
    match tool {
        "read_file" => {
            let path = first_string_field(
                &input,
                &[
                    "path",
                    "file",
                    "file_path",
                    "filepath",
                    "filename",
                    "name",
                    "target",
                    "raw",
                ],
            )
            .or_else(|| {
                first_string_field(
                    request,
                    &[
                        "path",
                        "file",
                        "file_path",
                        "filepath",
                        "filename",
                        "name",
                        "target",
                        "raw",
                    ],
                )
            })
            .filter(|value| {
                !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "read_file" | "read" | "file" | "question"
                )
            });
            if let Some(path) = path {
                if let Some(object) = next.as_object_mut() {
                    object.insert("path".to_string(), Value::String(path.to_string()));
                }
            }
        }
        "grep" | "symbol_search" => {
            let query = first_string_field(
                &input,
                &["query", "pattern", "text", "keyword", "target", "raw"],
            )
            .or_else(|| {
                first_string_field(
                    request,
                    &["query", "pattern", "text", "keyword", "target", "raw"],
                )
            });
            if let Some(query) = query {
                if let Some(object) = next.as_object_mut() {
                    object.insert("query".to_string(), Value::String(query.to_string()));
                }
            }
        }
        "glob" => {
            let pattern = first_string_field(&input, &["pattern", "glob", "query", "raw"])
                .or_else(|| first_string_field(request, &["pattern", "glob", "query", "raw"]));
            let path =
                first_string_field(&input, &["path", "dir", "directory", "folder", "target"])
                    .or_else(|| {
                        first_string_field(
                            request,
                            &["path", "dir", "directory", "folder", "target"],
                        )
                    });
            if let Some(object) = next.as_object_mut() {
                if let Some(pattern) = pattern {
                    object.insert("pattern".to_string(), Value::String(pattern.to_string()));
                }
                if let Some(path) = path {
                    object.insert("path".to_string(), Value::String(path.to_string()));
                }
            }
        }
        "bash" => {
            let command = first_string_field(&input, &["command", "cmd", "shell", "target", "raw"])
                .or_else(|| {
                    first_string_field(request, &["command", "cmd", "shell", "target", "raw"])
                });
            if let Some(command) = command {
                if let Some(object) = next.as_object_mut() {
                    object.insert("command".to_string(), Value::String(command.to_string()));
                }
            }
        }
        "mcp_call" => {
            let server = first_string_field(
                &input,
                &["server", "serverName", "server_name", "mcpServer"],
            )
            .or_else(|| {
                first_string_field(
                    request,
                    &["server", "serverName", "server_name", "mcpServer"],
                )
            });
            let tool_name = first_string_field(&input, &["tool", "name", "method", "action"])
                .or_else(|| first_string_field(request, &["tool", "name", "method", "action"]));
            if let Some(object) = next.as_object_mut() {
                if let Some(server) = server {
                    object.insert("server".to_string(), Value::String(server.to_string()));
                }
                let lower_tool = tool_name.unwrap_or("").to_ascii_lowercase();
                if matches!(
                    lower_tool.as_str(),
                    "" | "fetch" | "list" | "list_tools" | "mcp_list_tools" | "tools/list"
                ) {
                    object.insert("action".to_string(), Value::String("list".to_string()));
                    object.remove("tool");
                } else if let Some(tool_name) = tool_name {
                    object.insert("tool".to_string(), Value::String(tool_name.to_string()));
                }
            }
        }
        "write" => {
            let path = first_string_field(
                &input,
                &[
                    "path",
                    "file",
                    "file_path",
                    "filepath",
                    "filename",
                    "target",
                ],
            )
            .or_else(|| {
                first_string_field(
                    request,
                    &[
                        "path",
                        "file",
                        "file_path",
                        "filepath",
                        "filename",
                        "target",
                    ],
                )
            });
            let content = first_string_field(&input, &["content", "text", "body"])
                .or_else(|| first_string_field(request, &["content", "text", "body"]));
            if let Some(object) = next.as_object_mut() {
                if let Some(path) = path {
                    object.insert("path".to_string(), Value::String(path.to_string()));
                }
                if let Some(content) = content {
                    object.insert("content".to_string(), Value::String(content.to_string()));
                }
            }
        }
        _ => {}
    }
    next
}

fn mcp_call_is_tool_list(input: &Value) -> bool {
    let action = input
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let tool = input
        .get("tool")
        .or_else(|| input.get("method"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let target = input
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let has_call_arguments = input
        .get("arguments")
        .or_else(|| input.get("args"))
        .map(|value| !value.is_null())
        .unwrap_or(false);
    let target_looks_like_picker_item = target.contains(" - ")
        && !has_call_arguments
        && (tool.is_empty()
            || matches!(
                tool.as_str(),
                "list" | "fetch" | "list_tools" | "mcp_list_tools" | "tools/list"
            ));
    action == "list"
        || action == "tools/list"
        || tool.is_empty()
        || matches!(
            tool.as_str(),
            "list" | "fetch" | "list_tools" | "mcp_list_tools" | "tools/list"
        )
        || target_looks_like_picker_item
}

fn mcp_list_configured_servers(root_path: &str, requested_server: Option<&str>) -> Value {
    let servers = merged_mcp_servers(root_path);
    let tools = servers
        .iter()
        .enumerate()
        .filter_map(|(index, server)| {
            let name = mcp_server_name(server, index);
            if requested_server
                .map(|requested| requested != name)
                .unwrap_or(false)
            {
                return None;
            }
            let command = server
                .get("command")
                .or_else(|| server.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = server
                .get("args")
                .or_else(|| server.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            Some(json!({
                "name": name,
                "server": name,
                "enabled": mcp_server_enabled(server),
                "command": command,
                "args": args,
                "description": server.get("description").and_then(Value::as_str).unwrap_or("Configured MCP server. Use mcp_call with this server and a concrete tool name to call it."),
                "callTool": "mcp_call",
                "requiresApprovalForCall": true
            }))
        })
        .collect::<Vec<_>>();
    json!({
        "ok": true,
        "method": "tools/list",
        "source": "configured_servers",
        "message": "MCP list returned from local configuration without starting external MCP processes. Call a concrete MCP tool to execute the server.",
        "tools": tools
    })
}

fn validate_agent_tool_input(tool: &str, input: &Value) -> Result<(), String> {
    match tool {
        "read_file" => {
            let path = input
                .get("path")
                .or_else(|| input.get("file"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if path.is_empty() {
                return Err("read_file requires path. Use {\"tool\":\"read_file\",\"input\":{\"path\":\"relative/path\"}}.".to_string());
            }
        }
        "grep" | "symbol_search" => {
            let query = input
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if query.is_empty() {
                return Err(format!("{tool} requires query"));
            }
        }
        "bash" => {
            let command = input
                .get("command")
                .or_else(|| input.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if command.is_empty() {
                return Err("bash requires command".to_string());
            }
        }
        "write" => {
            let path = input
                .get("path")
                .or_else(|| input.get("file"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let content = input.get("content").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() || content.is_empty() {
                return Err("write requires non-empty path and content".to_string());
            }
        }
        "apply_patch" => {
            let patch = input
                .get("patch")
                .or_else(|| input.get("diff"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if patch.is_empty() {
                return Err(
                    "apply_patch requires patch; provide a complete unified diff or Codex patch"
                        .to_string(),
                );
            }
        }
        "memory_update" => {
            let patch = input
                .get("patch")
                .or_else(|| input.get("diff"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if patch.is_empty() {
                return Err("memory_update requires patch".to_string());
            }
            validate_agent_memory_patch(patch)?;
        }
        _ => {}
    }
    Ok(())
}

fn agent_tool_requires_approval(
    profile_id: &str,
    settings: Option<&connector::IdeSettings>,
    tool: &str,
    input: &Value,
) -> (String, &'static str) {
    if tool == "mcp_call" && mcp_call_is_tool_list(input) {
        return ("allow".to_string(), "low");
    }
    if tool == "process_manager" {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("list")
            .to_ascii_lowercase();
        if action == "start" {
            let command = input
                .get("command")
                .or_else(|| input.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if looks_dangerous_command(command) {
                return ("deny".to_string(), "high");
            }
            let profile = profile_id.to_ascii_lowercase();
            let read_only_profile =
                matches!(profile.as_str(), "plan" | "review" | "explore" | "docs");
            let execution_profile =
                matches!(profile.as_str(), "build" | "debug" | "test" | "refactor");
            if read_only_profile {
                return ("deny".to_string(), "high");
            }
            if execution_profile && is_safe_auto_approved_bash(command) {
                return ("allow".to_string(), "low");
            }
            return ("ask".to_string(), "medium");
        }
        if action == "kill" || action == "stop" {
            return ("allow".to_string(), "low");
        }
    }
    if tool == "bash" {
        let command = input
            .get("command")
            .or_else(|| input.get("cmd"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if looks_dangerous_command(command) {
            return ("deny".to_string(), "high");
        }
        let profile = profile_id.to_ascii_lowercase();
        let execution_profile = matches!(profile.as_str(), "build" | "debug" | "test" | "refactor");
        if execution_profile && is_safe_auto_approved_bash(command) {
            return ("allow".to_string(), "low");
        }
    }
    let decision = permission_policy_for_tool(profile_id, settings, tool);
    let risk = if decision == "deny" {
        "high"
    } else if matches!(tool, "bash" | "write" | "apply_patch") {
        "medium"
    } else {
        "low"
    };
    (decision, risk)
}

fn agent_permission_target(tool: &str, input: &Value) -> String {
    if tool == "mcp_call" {
        let server = input
            .get("server")
            .or_else(|| input.get("serverName"))
            .and_then(Value::as_str)
            .unwrap_or("MCP");
        let action = input
            .get("tool")
            .or_else(|| input.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("tools/list");
        return format!("{server} - {action}");
    }
    input
        .get("command")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("target"))
        .or_else(|| input.get("patch").or_else(|| input.get("diff")))
        .and_then(Value::as_str)
        .map(|value| value.chars().take(240).collect::<String>())
        .unwrap_or_else(|| tool.to_string())
}

fn agent_permission_kind(tool: &str) -> &'static str {
    if tool == "bash" {
        "command"
    } else if matches!(
        tool,
        "mcp_call" | "browser_preview" | "process_manager" | "lsp"
    ) {
        "tool"
    } else if matches!(tool, "read" | "read_file" | "glob" | "grep" | "git_diff") {
        "read"
    } else {
        "write"
    }
}

fn agent_permission_reason(tool: &str, input: &Value) -> &'static str {
    if tool == "mcp_call" {
        if mcp_call_is_tool_list(input) {
            "Agent wants to inspect the configured MCP service tools."
        } else {
            "Agent wants to call an external MCP tool and needs approval."
        }
    } else {
        "Agent requested a tool that may modify the workspace or run a command and needs approval."
    }
}

fn pending_question_is_actionable(question: &Value) -> bool {
    let input = question.get("input").unwrap_or(&Value::Null);
    let output = question.get("output").unwrap_or(&Value::Null);
    let question_text = output
        .get("question")
        .or_else(|| input.get("question"))
        .or_else(|| input.get("prompt"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if question_text.is_empty() {
        return false;
    }
    let target = input
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if target.eq_ignore_ascii_case("question")
        && input.get("question").is_none()
        && input.get("prompt").is_none()
    {
        return false;
    }
    true
}

fn planning_question_input_is_valid(input: &Value) -> Result<(), String> {
    let question = input
        .get("question")
        .or_else(|| input.get("prompt"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if question.is_empty() {
        return Err("planning question requires a clear question string".to_string());
    }
    let option_count = input
        .get("options")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if !(2..=3).contains(&option_count) {
        return Err(
            "planning question requires exactly 2-3 options; include a recommended option first"
                .to_string(),
        );
    }
    let placeholder = input
        .get("placeholder")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if placeholder.is_empty() {
        return Err(
            "planning question requires a placeholder for free-form user input".to_string(),
        );
    }
    Ok(())
}

fn remembered_agent_permission_decision(
    app: &AppHandle,
    session_id: &str,
    tool: &str,
    input: &Value,
) -> Option<String> {
    let target = agent_permission_target(tool, input);
    let state = app.state::<IdeRuntimeState>();
    let sessions = state.agent_sessions.lock().unwrap();
    let session = sessions.get(session_id)?;
    let rules = session.get("permissionRules").and_then(Value::as_array)?;
    rules.iter().rev().find_map(|rule| {
        let rule_tool = rule.get("tool").and_then(Value::as_str).unwrap_or("*");
        if rule_tool != "*" && rule_tool != tool {
            return None;
        }
        let rule_target = rule.get("target").and_then(Value::as_str).unwrap_or("*");
        if rule_target != "*" && rule_target != target {
            return None;
        }
        let decision = rule.get("decision").and_then(Value::as_str).unwrap_or("");
        if matches!(decision, "allow" | "deny") {
            Some(decision.to_string())
        } else {
            None
        }
    })
}

fn remember_agent_permission_rule(
    session: &mut Value,
    tool: &str,
    input: &Value,
    scope: &str,
    decision: &str,
) {
    if !matches!(scope, "session" | "project" | "remember") || !matches!(decision, "allow" | "deny")
    {
        return;
    }
    let rule = json!({
        "tool": tool,
        "target": agent_permission_target(tool, input),
        "scope": if scope == "remember" { "project" } else { scope },
        "decision": decision,
        "createdAt": agent_now()
    });
    if let Some(items) = session
        .get_mut("permissionRules")
        .and_then(Value::as_array_mut)
    {
        items.push(rule);
    } else {
        session["permissionRules"] = json!([rule]);
    }
}

fn execute_agent_tool(
    app: Option<&AppHandle>,
    session_id: Option<&str>,
    root_path: &str,
    tool: &str,
    input: &Value,
) -> Result<Value, String> {
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
            let cache_key = input
                .get("__cacheKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if input
                .get("__cacheHit")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                if let (Some(app), Some(session_id)) = (app, session_id) {
                    if !cache_key.is_empty() {
                        if let Some(mut cached) = agent_tool_cache_get(app, session_id, &cache_key)
                        {
                            if let Some(object) = cached.as_object_mut() {
                                object.insert("cached".to_string(), Value::Bool(true));
                                object.insert(
                                    "message".to_string(),
                                    Value::String("Reused previous glob result from this turn; no budget was consumed.".to_string()),
                                );
                            }
                            return Ok(cached);
                        }
                    }
                }
            }
            let path = input.get("path").and_then(Value::as_str).unwrap_or("");
            let pattern = input
                .get("pattern")
                .or_else(|| input.get("glob"))
                .or_else(|| input.get("query"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let result = if !pattern.is_empty() {
                let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(120) as usize;
                let matches = connector::glob_workspace(root_path, path, pattern, limit)?;
                json!({
                    "path": path,
                    "pattern": pattern,
                    "count": matches.len(),
                    "entries": matches,
                    "message": "glob matched files by pattern. Prefer grep for symbol/text search and read_file for file contents."
                })
            } else if !path.trim().is_empty() {
                if let Ok(file) = connector::read_workspace_file(root_path, path) {
                    json!({
                        "path": file.path,
                        "count": 1,
                        "entries": [format!("file {}", file.path)],
                        "file": {
                            "path": file.path,
                            "size": file.size,
                            "languageHint": file.path.rsplit('.').next().unwrap_or("")
                        },
                        "message": "glob received a file path; returning the file entry instead of scanning. Use read_file when file content is needed."
                    })
                } else {
                    let depth = input
                        .get("maxDepth")
                        .or_else(|| input.get("depth"))
                        .and_then(Value::as_u64)
                        .unwrap_or(4) as usize;
                    let tree = connector::list_workspace_tree(root_path, path, depth)?;
                    let mut lines = Vec::new();
                    summarize_workspace_entries(&tree, 0, &mut lines, 300);
                    json!({ "path": path, "count": lines.len(), "entries": lines, "tree": tree })
                }
            } else {
                let depth = input
                    .get("maxDepth")
                    .or_else(|| input.get("depth"))
                    .and_then(Value::as_u64)
                    .unwrap_or(4) as usize;
                let tree = connector::list_workspace_tree(root_path, path, depth)?;
                let mut lines = Vec::new();
                summarize_workspace_entries(&tree, 0, &mut lines, 300);
                json!({ "path": path, "count": lines.len(), "entries": lines, "tree": tree })
            };
            if let (Some(app), Some(session_id)) = (app, session_id) {
                if !cache_key.is_empty() {
                    agent_tool_cache_set(app, session_id, &cache_key, result.clone());
                }
            }
            Ok(result)
        }
        "grep" => {
            let query = input
                .get("query")
                .or_else(|| input.get("pattern"))
                .and_then(Value::as_str)
                .ok_or_else(|| "grep requires query".to_string())?;
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(80) as usize;
            let mut results = connector::search_workspace(root_path, query, true, limit)?;
            if let Some(scopes) = input.get("focusPaths").and_then(Value::as_array) {
                let focus = scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(normalize_agent_rel_path)
                    .collect::<Vec<_>>();
                if !focus.is_empty() {
                    results.retain(|item| path_in_focus(&item.path, &focus));
                }
            }
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
        "diagnostics" => run_detected_workspace_command(
            root_path,
            "diagnostics",
            detect_diagnostics_command(root_path),
            input
                .get("timeoutSecs")
                .or_else(|| input.get("timeout"))
                .and_then(Value::as_u64)
                .unwrap_or(180),
        ),
        "test_runner" => run_detected_workspace_command(
            root_path,
            "test",
            detect_test_command(root_path),
            input
                .get("timeoutSecs")
                .or_else(|| input.get("timeout"))
                .and_then(Value::as_u64)
                .unwrap_or(180),
        ),
        "symbol_search" => {
            let query = input
                .get("query")
                .or_else(|| input.get("symbol"))
                .and_then(Value::as_str)
                .ok_or_else(|| "symbol_search requires query".to_string())?;
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(80) as usize;
            let mut results = connector::search_workspace(root_path, query, true, limit)?;
            if let Some(scopes) = input.get("focusPaths").and_then(Value::as_array) {
                let focus = scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(normalize_agent_rel_path)
                    .collect::<Vec<_>>();
                if !focus.is_empty() {
                    results.retain(|item| path_in_focus(&item.path, &focus));
                }
            }
            Ok(json!({ "query": query, "count": results.len(), "symbols": results }))
        }
        "process_manager" => {
            let Some(app) = app else {
                return Ok(
                    json!({ "processes": [], "message": "process registry is unavailable in this context" }),
                );
            };
            let state = app.state::<IdeRuntimeState>();
            match input
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("list")
                .to_ascii_lowercase()
                .as_str()
            {
                "list" => agent_processes_value(&state, Some(root_path)),
                "start" => {
                    let command = input
                        .get("command")
                        .or_else(|| input.get("cmd"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "process_manager start requires command".to_string())?;
                    let result =
                        spawn_agent_background_command(Some(app), session_id, root_path, command)?;
                    if let Some(session_id) = session_id {
                        agent_emit(
                            app,
                            session_id,
                            "process_start",
                            json!({
                                "id": result.get("id").cloned().unwrap_or(Value::Null),
                                "pid": result.get("pid").cloned().unwrap_or(Value::Null),
                                "command": result.get("command").cloned().unwrap_or(Value::Null),
                                "cwd": result.get("cwd").cloned().unwrap_or(Value::Null),
                                "background": true,
                                "managedBy": "process_manager"
                            }),
                        );
                    }
                    Ok(result)
                }
                "kill" | "stop" => {
                    let process_id = input
                        .get("processId")
                        .or_else(|| input.get("process_id"))
                        .or_else(|| input.get("id"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "process_manager kill requires processId".to_string())?
                        .to_string();
                    kill_agent_process_value(app, &state, process_id)
                }
                other => Err(format!("unsupported process_manager action: {other}")),
            }
        }
        "browser_preview" => browser_preview_value(input),
        "lsp" => {
            let method = input
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("diagnostics")
                .to_string();
            let params = input.get("params").cloned().unwrap_or_else(|| json!({}));
            let value = lsp_request_value(root_path, &method, params)?;
            if method.contains("rename") || method == "rename" {
                if let Some(patch) = value
                    .pointer("/result/patch")
                    .and_then(Value::as_str)
                    .filter(|patch| !patch.trim().is_empty())
                {
                    if let (Some(app), Some(session_id)) = (app, session_id) {
                        agent_emit(
                            app,
                            session_id,
                            "patch_preview",
                            json!({
                                "id": format!("lsp-rename-{}", agent_now()),
                                "patch": patch,
                                "files": parse_paths_from_diff(patch),
                                "kind": "rename",
                                "requiresApproval": true
                            }),
                        );
                    }
                }
            }
            Ok(value)
        }
        "mcp_call" => execute_mcp_call(app, session_id, root_path, input),
        "todowrite" => Ok(json!({
            "items": input.get("items").cloned().unwrap_or_else(|| json!([])),
            "summary": "todo updated"
        })),
        "question" => {
            let question_value = input
                .get("question")
                .or_else(|| input.get("prompt"))
                .cloned()
                .ok_or_else(|| {
                    "question requires a clear question or prompt; do not call it with target=question"
                        .to_string()
                })?;
            let question_text = question_value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "question requires a non-empty question or prompt".to_string())?;
            let options = input
                .get("options")
                .cloned()
                .filter(|value| {
                    value
                        .as_array()
                        .map(|items| !items.is_empty())
                        .unwrap_or(false)
                })
                .unwrap_or_else(|| Value::Array(infer_question_options(question_text)));
            Ok(json!({
                "question": question_value,
                "options": options,
                "placeholder": input
                    .get("placeholder")
                    .cloned()
                    .unwrap_or(Value::String("杈撳叆琛ュ厖璇存槑銆佽矾寰勬垨閫夋嫨鑼冨洿...".to_string())),
                "requiresUserResponse": true
            }))
        }
        "bash" => {
            let mut normalized_input = input.clone();
            sanitize_agent_bash_input(&mut normalized_input);
            let command = normalized_input
                .get("command")
                .or_else(|| normalized_input.get("cmd"))
                .and_then(Value::as_str)
                .ok_or_else(|| "bash requires command".to_string())?;
            if is_long_running_dev_command(command) {
                return spawn_agent_background_command(app, session_id, root_path, command);
            }
            let timeout = input
                .get("timeoutSecs")
                .or_else(|| input.get("timeout"))
                .and_then(Value::as_u64)
                .unwrap_or(120);
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
        "memory_update" => {
            let patch = input
                .get("patch")
                .or_else(|| input.get("diff"))
                .and_then(Value::as_str)
                .ok_or_else(|| "memory_update requires patch".to_string())?;
            let files = validate_agent_memory_patch(patch)?;
            let result = apply_agent_patch(root_path, patch)?;
            let rollover = rollover_agent_memory_if_needed(root_path)?;
            let rolled_over = rollover.is_some();
            let payload = json!({
                "ok": true,
                "files": files,
                "result": result,
                "rollover": rollover,
                "message": if rolled_over { "memory patch applied and archived" } else { "memory patch applied" }
            });
            if let (Some(app), Some(session_id)) = (app, session_id) {
                agent_emit(app, session_id, "memory_update_applied", payload.clone());
            }
            Ok(payload)
        }
        other => Err(format!("unsupported agent tool: {other}")),
    }
}

fn format_git_apply_error(phase: &str, stderr: &str, stdout: &str) -> String {
    let detail = format!("{stderr}{stdout}").trim().to_string();
    let lower = detail.to_ascii_lowercase();
    let mut hints = Vec::new();
    if lower.contains("does not exist in index")
        || lower.contains("no such file")
        || lower.contains("can't open")
        || lower.contains("failed to find")
    {
        hints.push("target file does not exist or the path is wrong; re-read the file or use write for full-file replacement");
    }
    if lower.contains("patch does not apply")
        || lower.contains("failed at")
        || lower.contains("hunk #")
        || lower.contains("while searching")
        || lower.contains("offset")
        || lower.contains("already exists")
    {
        hints.push("patch context does not match the current file; re-read the target file before regenerating the patch");
    }
    if lower.contains("corrupt")
        || lower.contains("malformed")
        || lower.contains("expected")
        || lower.contains("invalid")
    {
        hints.push("patch format is invalid; use a complete unified diff or complete Codex *** Begin Patch block");
    }
    if detail.is_empty() {
        hints.push("git apply returned no details; verify git is available and the patch is a valid unified diff");
    }
    let hint = if hints.is_empty() {
        "re-read the target file and retry apply_patch, or use write with complete file content"
            .to_string()
    } else {
        hints.join(" ")
    };
    if detail.is_empty() {
        format!("patch {phase} failed.\nhint: {hint}")
    } else {
        format!("patch {phase} failed:\n{detail}\n\nhint: {hint}")
    }
}

fn patch_error_is_format_issue(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("corrupt patch")
        || lower.contains("corrupt")
        || lower.contains("malformed")
        || lower.contains("not a valid unified diff")
        || lower.contains("missing file")
        || lower.contains("expected")
        || lower.contains("invalid patch")
        || lower.contains("patch format is invalid")
        || lower.contains("patch cannot be empty")
}

fn apply_agent_patch(root_path: &str, patch: &str) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(root_path)?;
    let mut patch = normalize_agent_unified_patch(patch)?;
    if patch.contains("*** Begin Patch") {
        return apply_codex_agent_patch(&root.to_string_lossy(), &patch);
    }
    patch = rewrite_unified_patch_paths(&root.to_string_lossy(), &patch, &[]);
    let changed: Vec<Value> = parse_paths_from_agent_patch(&patch)
        .into_iter()
        .map(|path| json!({ "path": path, "operation": "update" }))
        .collect();
    let check = Command::new("git")
        .arg("apply")
        .arg("--check")
        .arg("--whitespace=nowarn")
        .current_dir(shell_path(&root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(patch.as_bytes())?;
            }
            child.wait_with_output()
        })
        .map_err(|err| format!("failed to validate patch: {err}"))?;
    if !check.status.success() {
        let stdout = String::from_utf8_lossy(&check.stdout);
        let stderr = String::from_utf8_lossy(&check.stderr);
        return Err(format_git_apply_error("validation", &stderr, &stdout));
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
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "failed to open git apply stdin".to_string())?;
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
        return Err(format_git_apply_error("apply", &stderr, &stdout));
    }
    Ok(json!({
        "ok": true,
        "message": "patch applied",
        "patchKind": "unified",
        "summary": patch_change_summary(&changed),
        "diagnostics": [],
        "stdout": stdout,
        "stderr": stderr,
        "changed": changed
    }))
}

fn validate_agent_patch_without_apply(root_path: &str, patch: &str) -> Result<String, String> {
    let root = connector::resolve_authorized_root(root_path)?;
    let mut patch = normalize_agent_unified_patch(patch)?;
    if patch.contains("*** Begin Patch") {
        let _ = validate_codex_agent_patch_without_apply(&root.to_string_lossy(), &patch)?;
        return Ok(patch);
    }
    patch = rewrite_unified_patch_paths(&root.to_string_lossy(), &patch, &[]);
    let check = Command::new("git")
        .arg("apply")
        .arg("--check")
        .arg("--whitespace=nowarn")
        .current_dir(shell_path(&root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(patch.as_bytes())?;
            }
            child.wait_with_output()
        })
        .map_err(|err| format!("failed to validate patch: {err}"))?;
    if !check.status.success() {
        let stdout = String::from_utf8_lossy(&check.stdout);
        let stderr = String::from_utf8_lossy(&check.stderr);
        return Err(format_git_apply_error("validation", &stderr, &stdout));
    }
    Ok(format!("{}\n", patch.trim_end()))
}

fn summarize_workspace_entries(
    items: &[connector::WorkspaceEntry],
    level: usize,
    lines: &mut Vec<String>,
    limit: usize,
) {
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
    let input = normalize_agent_tool_input(tool, input, &json!({ "tool": tool }));
    agent_emit(
        app,
        session_id,
        "tool_call_start",
        json!({
            "id": tool_call_id,
            "name": tool,
            "input": input,
            "status": "running"
        }),
    );
    let mut call = match validate_agent_tool_input(tool, &input)
        .and_then(|_| execute_agent_tool(Some(app), Some(session_id), root_path, tool, &input))
    {
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
    settings: &connector::IdeSettings,
    command: &str,
) -> Result<Value, String> {
    let input = json!({ "command": command });
    let (decision, risk) = agent_tool_requires_approval(profile_id, Some(settings), "bash", &input);
    let tool_call_id = format!("tool-bash-{}", agent_now());
    if decision == "deny" {
        agent_emit(
            app,
            session_id,
            "permission_request",
            json!({
                "id": tool_call_id,
                "kind": "command",
                "target": command,
                "reason": "This command matched a dangerous command policy and was blocked.",
                "risk": risk,
                "decision": "deny"
            }),
        );
        agent_emit(
            app,
            session_id,
            "message_delta",
            json!({
                "role": "assistant",
                "kind": "text",
                "content": format!("Command `{command}` was blocked by the dangerous command policy.")
            }),
        );
        return Ok(json!({
            "ok": false,
            "requiresApproval": false,
            "error": "permission denied by policy"
        }));
    }
    if decision == "ask" {
        update_agent_session(app, session_id, |session| {
            if let Some(items) = session
                .get_mut("pendingTools")
                .and_then(Value::as_array_mut)
            {
                items.push(json!({ "id": tool_call_id, "tool": "bash", "input": input, "createdAt": agent_now() }));
            } else {
                session["pendingTools"] = json!([{ "id": tool_call_id, "tool": "bash", "input": input, "createdAt": agent_now() }]);
            }
        });
        agent_emit(
            app,
            session_id,
            "permission_request",
            json!({
                "id": tool_call_id,
                "kind": "command",
                "target": command,
                "reason": "Agent requested to run a workspace command and needs approval.",
                "risk": risk,
                "decision": "ask"
            }),
        );
        agent_emit(
            app,
            session_id,
            "message_delta",
            json!({
                "role": "assistant",
                "kind": "text",
                "content": format!("Approval is required before running `{command}`.")
            }),
        );
        return Ok(json!({
            "ok": true,
            "requiresApproval": true,
            "message": "waiting for command approval"
        }));
    }

    if let Err(err) = run_pre_tool_hooks(app, session_id, root_path, Some(settings), "bash", &input)
    {
        let call = agent_tool_call("bash", input.clone(), json!({}), Some(err.clone()));
        agent_emit(app, session_id, "tool_call_result", call);
        agent_emit(
            app,
            session_id,
            "message_delta",
            json!({
                "role": "assistant",
                "kind": "text",
                "content": format!("Command `{command}` was blocked by project hook: {err}")
            }),
        );
        return Ok(json!({ "ok": false, "requiresApproval": false, "error": err }));
    }
    let call = emit_agent_tool_execution(app, session_id, root_path, "bash", input);
    emit_post_tool_hook(app, session_id, root_path, Some(settings), "bash", &call);
    emit_process_events_for_tool_call(app, session_id, &call);
    let ok = call.get("status").and_then(Value::as_str).unwrap_or("ok") != "error";
    let output = call
        .pointer("/output/output")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let background = call
        .pointer("/output/background")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let summary = if background {
        let pid = call
            .pointer("/output/pid")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        format!("Started `{command}` in background. PID: {pid}.")
    } else if ok {
        format!(
            "`{command}` completed.\n\n{}",
            if output.is_empty() {
                "Command produced no output.".to_string()
            } else {
                output.chars().take(6000).collect::<String>()
            }
        )
    } else {
        format!(
            "`{command}` failed.\n\n{}",
            if output.is_empty() {
                call.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_string()
            } else {
                output.chars().take(6000).collect::<String>()
            }
        )
    };
    agent_emit(
        app,
        session_id,
        "message_delta",
        json!({
            "role": "assistant",
            "kind": "text",
            "content": summary
        }),
    );
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
                json!({ "path": file.path, "size": file.size, "summary": format!("璇诲彇 {}", path) }),
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

fn context_ref_path(value: &str) -> Option<String> {
    let first_line = value.lines().next().unwrap_or("").trim();
    let prefixes = [
        "@current_file ",
        "@file ",
        "@folder ",
        "@directory ",
        "@dir ",
    ];
    for prefix in prefixes {
        if let Some(path) = first_line.strip_prefix(prefix) {
            let clean = path.trim().trim_matches('"').trim_matches('\'');
            if !clean.is_empty() {
                return Some(clean.replace('\\', "/"));
            }
        }
    }
    None
}

fn normalize_agent_rel_path(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches("@")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .replace('\\', "/")
        .trim_end_matches(|ch: char| matches!(ch, ',' | ';' | ':' | ')'))
        .trim_end_matches('/')
        .to_string()
}

fn agent_path_exists(root_path: &str, path: &str) -> bool {
    let path = normalize_agent_rel_path(path);
    if path.is_empty() {
        return false;
    }
    connector::read_workspace_file(root_path, &path).is_ok()
        || connector::list_workspace_tree(root_path, &path, 1).is_ok()
}

fn infer_focus_paths_from_message(root_path: &str, message: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut push = |candidate: String| {
        let candidate = normalize_agent_rel_path(&candidate);
        if candidate.is_empty() || out.iter().any(|item| item == &candidate) {
            return;
        }
        if agent_path_exists(root_path, &candidate) {
            out.push(candidate);
        }
    };
    for token in message.split_whitespace() {
        if let Some(rest) = token.strip_prefix('@') {
            push(rest.to_string());
        }
    }
    out
}

fn focus_paths_from_context_refs(root_path: &str, context_refs: &Value) -> Vec<String> {
    let mut out = Vec::<String>::new();
    if let Some(items) = context_refs.as_array() {
        for item in items {
            let value = item
                .get("value")
                .or_else(|| item.get("label"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Some(path) = context_ref_path(value) {
                let path = normalize_agent_rel_path(&path);
                if !path.is_empty()
                    && !out.iter().any(|item| item == &path)
                    && agent_path_exists(root_path, &path)
                {
                    out.push(path);
                }
            }
        }
    }
    out
}

#[allow(dead_code)]
fn prompt_allows_global_scan(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    [
        "all files",
        "whole project",
        "entire project",
        "workspace",
        "repository",
        "repo overview",
        "global scan",
        "full scan",
        "全项目",
        "整个项目",
        "工作区",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn extract_backtick_paths(text: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut rest = text;
    while let Some(start) = rest.find('`') {
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('`') else {
            break;
        };
        let raw_candidate = after_start[..end].trim();
        let candidate = normalize_agent_rel_path(raw_candidate);
        if !candidate.is_empty()
            && (raw_candidate.contains('/')
                || raw_candidate.contains('\\')
                || raw_candidate.contains('.'))
            && !out.iter().any(|item| item == &candidate)
        {
            out.push(candidate);
        }
        rest = &after_start[end + 1..];
    }
    out
}

fn infer_scope_paths_from_text(root_path: &str, text: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut push = |candidate: &str| {
        let candidate = normalize_agent_rel_path(candidate);
        if candidate.is_empty() || out.iter().any(|item| item == &candidate) {
            return;
        }
        if agent_path_exists(root_path, &candidate) {
            out.push(candidate);
        }
    };
    for path in extract_backtick_paths(text) {
        push(&path);
    }
    for token in text.split(|ch: char| {
        ch.is_whitespace() || matches!(ch, ';' | ',' | ':' | '(' | ')' | '[' | ']' | '{' | '}')
    }) {
        let token = token.trim_matches('*').trim_matches('`');
        if token.contains('/') || token.contains('\\') || token.contains('.') {
            push(token);
        }
    }
    out
}

#[allow(dead_code)]
fn question_answer_denies(answer: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    [
        "deny",
        "no",
        "reject",
        "refuse",
        "not allow",
        "不允许",
        "不要",
        "拒绝",
        "不行",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

#[allow(dead_code)]
fn question_answer_allows(answer: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    [
        "ok", "yes", "allow", "approve", "continue", "允许", "可以", "同意", "继续", "确认",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn prompt_allows_global_scan_v2(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    [
        "all files",
        "whole project",
        "entire project",
        "workspace",
        "repository",
        "repo overview",
        "global scan",
        "full scan",
        "allow workspace",
        "允许全项目",
        "全项目",
        "整个项目",
        "工作区",
        "仓库",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn question_answer_denies_v2(answer: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    [
        "deny",
        "no",
        "reject",
        "refuse",
        "not allow",
        "不允许",
        "不要",
        "拒绝",
        "不行",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn question_answer_allows_v2(answer: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    [
        "ok", "yes", "allow", "approve", "continue", "允许", "可以", "同意", "继续", "确认",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn planning_answer_is_followup(answer: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    if answer.chars().any(|ch| matches!(ch, '?' | '\u{ff1f}')) {
        return true;
    }
    let chinese_followup_keywords = [
        "\u{4e3a}\u{4ec0}\u{4e48}",
        "\u{600e}\u{4e48}",
        "\u{5982}\u{4f55}",
        "\u{80fd}\u{4e0d}\u{80fd}",
        "\u{53ef}\u{4e0d}\u{53ef}\u{4ee5}",
        "\u{662f}\u{4e0d}\u{662f}",
        "\u{662f}\u{5426}",
        "\u{6211}\u{89c9}\u{5f97}",
        "\u{6211}\u{60f3}",
        "\u{4e0d}\u{8981}",
        "\u{4e0d}\u{60f3}",
        "\u{6539}\u{6210}",
        "\u{8fd8}\u{662f}",
        "\u{6216}\u{8005}",
        "\u{8865}\u{5145}",
        "\u{53e6}\u{5916}",
        "\u{4e0d}\u{786e}\u{5b9a}",
        "\u{7ea6}\u{675f}",
    ];
    if chinese_followup_keywords
        .iter()
        .any(|keyword| answer.contains(keyword))
    {
        return true;
    }
    answer.contains('?')
        || answer.contains('？')
        || [
            "why",
            "how",
            "what if",
            "instead",
            "but",
            "为什么",
            "怎么",
            "如何",
            "能不能",
            "可不可以",
            "是不是",
            "是否",
            "我觉得",
            "我想",
            "不要",
            "不想",
            "改成",
            "还是",
            "或者",
            "补充",
            "另外",
            "不确定",
        ]
        .iter()
        .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn record_planning_answer_on_session(session: &mut Value, answer: &str) {
    let is_followup = planning_answer_is_followup(answer);
    if !session
        .get("planningAnswers")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        session["planningAnswers"] = json!([]);
    }
    if let Some(items) = session
        .get_mut("planningAnswers")
        .and_then(Value::as_array_mut)
    {
        items.push(Value::String(answer.to_string()));
        if items.len() > 40 {
            let drain = items.len().saturating_sub(40);
            items.drain(0..drain);
        }
    }
    if !session
        .get("planningConfirmation")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        session["planningConfirmation"] = json!({
            "status": "idle",
            "answers": [],
            "openQuestions": [],
            "confirmedRequirements": []
        });
    }
    let confirmation = session.get_mut("planningConfirmation").unwrap();
    confirmation["status"] = Value::String(if is_followup {
        "answering_user_followup".to_string()
    } else {
        "waiting_user_confirmation".to_string()
    });
    if !confirmation
        .get("answers")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        confirmation["answers"] = json!([]);
    }
    if let Some(items) = confirmation
        .get_mut("answers")
        .and_then(Value::as_array_mut)
    {
        items.push(Value::String(answer.to_string()));
        if items.len() > 40 {
            let drain = items.len().saturating_sub(40);
            items.drain(0..drain);
        }
    }
    if is_followup {
        if !confirmation
            .get("openQuestions")
            .map(Value::is_array)
            .unwrap_or(false)
        {
            confirmation["openQuestions"] = json!([]);
        }
        if let Some(items) = confirmation
            .get_mut("openQuestions")
            .and_then(Value::as_array_mut)
        {
            items.push(Value::String(answer.to_string()));
            if items.len() > 20 {
                let drain = items.len().saturating_sub(20);
                items.drain(0..drain);
            }
        }
    } else {
        if !confirmation
            .get("confirmedRequirements")
            .map(Value::is_array)
            .unwrap_or(false)
        {
            confirmation["confirmedRequirements"] = json!([]);
        }
        if let Some(items) = confirmation
            .get_mut("confirmedRequirements")
            .and_then(Value::as_array_mut)
        {
            items.push(Value::String(answer.to_string()));
            if items.len() > 40 {
                let drain = items.len().saturating_sub(40);
                items.drain(0..drain);
            }
        }
    }
}

fn infer_question_options(question: &str) -> Vec<Value> {
    let mut options = Vec::<Value>::new();
    let mut seen = HashSet::<String>::new();
    let add_option = |options: &mut Vec<Value>,
                      seen: &mut HashSet<String>,
                      label: String,
                      value: String,
                      kind: &str| {
        if seen.insert(value.clone()) {
            options.push(json!({ "label": label, "value": value, "kind": kind }));
        }
    };
    let lower = question.to_ascii_lowercase();
    if lower.contains("whole project")
        || lower.contains("workspace")
        || lower.contains("全项目")
        || lower.contains("工作区")
    {
        add_option(
            &mut options,
            &mut seen,
            "Allow workspace".to_string(),
            "allow workspace".to_string(),
            "scope",
        );
    }
    for path in extract_backtick_paths(question).into_iter().take(4) {
        add_option(
            &mut options,
            &mut seen,
            format!("Allow {path}"),
            format!("allow {path}"),
            "scope",
        );
    }
    if lower.contains("allow")
        || lower.contains("approve")
        || lower.contains("允许")
        || lower.contains("确认")
    {
        add_option(
            &mut options,
            &mut seen,
            "Allow".to_string(),
            "allow".to_string(),
            "allow",
        );
        add_option(
            &mut options,
            &mut seen,
            "Deny".to_string(),
            "deny".to_string(),
            "deny",
        );
    }
    options.truncate(6);
    options
}

fn apply_question_answer_session_effects(
    session: &mut Value,
    root_path: &str,
    question: &Value,
    answer: &str,
) -> Value {
    let question_text = question
        .pointer("/output/question")
        .or_else(|| question.pointer("/input/question"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut focus_paths = infer_scope_paths_from_text(root_path, answer);
    if focus_paths.is_empty()
        && question_answer_allows_v2(answer)
        && !question_answer_denies_v2(answer)
    {
        for path in extract_backtick_paths(question_text) {
            let path = normalize_agent_rel_path(&path);
            if !path.is_empty()
                && agent_path_exists(root_path, &path)
                && !focus_paths.iter().any(|item| item == &path)
            {
                focus_paths.push(path);
            }
        }
    }
    let allow_global = !question_answer_denies_v2(answer)
        && prompt_allows_global_scan_v2(answer)
        && question_answer_allows_v2(answer);
    if !focus_paths.is_empty() {
        let mut next_focus = focus_paths.clone();
        next_focus.truncate(12);
        session["focusPaths"] = json!(next_focus);
    }
    session["turnAllowGlobalScan"] = Value::Bool(allow_global);
    if allow_global {
        session["focusPaths"] = json!([]);
    }
    json!({
        "answer": answer,
        "denied": question_answer_denies_v2(answer),
        "allowGlobalScan": allow_global,
        "focusPaths": focus_paths
    })
}

fn path_in_focus(path: &str, focus_paths: &[String]) -> bool {
    let path = normalize_agent_rel_path(path);
    if path.is_empty() || focus_paths.is_empty() {
        return true;
    }
    focus_paths.iter().any(|scope| {
        let scope = normalize_agent_rel_path(scope);
        path == scope
            || path.starts_with(&format!("{scope}/"))
            || scope.starts_with(&format!("{path}/"))
    })
}

fn root_common_agent_path(path: &str) -> bool {
    matches!(
        normalize_agent_rel_path(path).as_str(),
        ".autocode/AGENTS.md"
            | ".autocode/memory.md"
            | ".autocode/settings.json"
            | "package.json"
            | "pnpm-workspace.yaml"
            | "Cargo.toml"
            | "pyproject.toml"
            | "requirements.txt"
            | "README.md"
            | "README"
    )
}

fn session_focus_paths(app: &AppHandle, session_id: &str) -> Vec<String> {
    let state = app.state::<IdeRuntimeState>();
    let sessions = state.agent_sessions.lock().unwrap();
    sessions
        .get(session_id)
        .and_then(|session| session.get("focusPaths"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_agent_rel_path)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn session_allows_global_scan(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<IdeRuntimeState>();
    let sessions = state.agent_sessions.lock().unwrap();
    sessions
        .get(session_id)
        .and_then(|session| session.get("turnAllowGlobalScan"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn increment_agent_tool_budget(
    app: &AppHandle,
    session_id: &str,
    bucket: &str,
    limit: u64,
) -> Result<(), String> {
    let mut exceeded = 0u64;
    update_agent_session(app, session_id, |session| {
        if !session
            .get("turnToolBudget")
            .map(Value::is_object)
            .unwrap_or(false)
        {
            session["turnToolBudget"] = json!({});
        }
        let current = session
            .get("turnToolBudget")
            .and_then(|budget| budget.get(bucket))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1);
        session["turnToolBudget"][bucket] = json!(current);
        if current > limit {
            exceeded = current;
        }
    });
    if exceeded > limit {
        return Err(format!(
            "Tool call budget exceeded for {bucket}: {exceeded}/{limit}. Narrow the search or summarize from current evidence."
        ));
    }
    Ok(())
}

fn agent_tool_cache_key(tool: &str, input: &Value) -> String {
    let mut compact = serde_json::Map::new();
    if tool == "glob" {
        compact.insert(
            "path".to_string(),
            Value::String(
                input
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .replace('\\', "/"),
            ),
        );
        compact.insert(
            "pattern".to_string(),
            Value::String(
                input
                    .get("pattern")
                    .or_else(|| input.get("glob"))
                    .or_else(|| input.get("query"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .replace('\\', "/"),
            ),
        );
        compact.insert(
            "maxDepth".to_string(),
            json!(input
                .get("maxDepth")
                .or_else(|| input.get("depth"))
                .and_then(Value::as_u64)
                .unwrap_or(2)),
        );
        compact.insert(
            "limit".to_string(),
            json!(input.get("limit").and_then(Value::as_u64).unwrap_or(120)),
        );
        compact.insert(
            "scopeRewritten".to_string(),
            Value::Bool(
                input
                    .get("scopeRewritten")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
    } else {
        compact.insert("input".to_string(), input.clone());
    }
    format!("{tool}:{}", Value::Object(compact))
}

fn agent_tool_cache_get(app: &AppHandle, session_id: &str, key: &str) -> Option<Value> {
    let state = app.state::<IdeRuntimeState>();
    let sessions = state.agent_sessions.lock().unwrap();
    sessions
        .get(session_id)
        .and_then(|session| session.get("turnToolCache"))
        .and_then(|cache| cache.get(key))
        .cloned()
}

fn agent_tool_cache_set(app: &AppHandle, session_id: &str, key: &str, value: Value) {
    update_agent_session(app, session_id, |session| {
        if !session
            .get("turnToolCache")
            .map(Value::is_object)
            .unwrap_or(false)
        {
            session["turnToolCache"] = json!({});
        }
        session["turnToolCache"][key] = value.clone();
    });
}

fn agent_scope_question_for_guard_error(tool: &str, input: &Value, err: &str) -> Option<Value> {
    let is_budget = err.contains("Tool call budget exceeded");
    let is_focus_block = err.contains("workspace focus")
        || err.contains("outside current focus")
        || err.contains("Ask for global scan");
    if !is_budget && !is_focus_block {
        return None;
    }
    let path = input
        .get("path")
        .or_else(|| input.get("file"))
        .and_then(Value::as_str)
        .map(normalize_agent_rel_path)
        .unwrap_or_default();
    let target = if path.is_empty() {
        "workspace".to_string()
    } else {
        format!("`{path}`")
    };
    let question = if is_budget {
        format!(
            "{tool} 已触发本轮工具预算保护。为了继续，需要你选择：允许进行一次更大范围的工作区扫描，还是改为只检查更小的指定路径？"
        )
    } else {
        format!(
            "{tool} 需要访问当前焦点范围外的 {target}。是否允许扩大扫描/读取范围，或请指定一个更小的路径？"
        )
    };
    let mut options = vec![
        json!({
            "label": "允许全项目扫描",
            "value": "允许全项目 workspace",
            "kind": "scope"
        }),
        json!({
            "label": "我补充具体路径",
            "value": "我会补充具体路径",
            "kind": "freeform"
        }),
        json!({
            "label": "拒绝扩大范围",
            "value": "拒绝，不允许扩大范围",
            "kind": "deny"
        }),
    ];
    if !path.is_empty() && !is_budget {
        options[0] = json!({
            "label": format!("允许 {path}"),
            "value": format!("允许 `{path}`"),
            "kind": "scope"
        });
        options.insert(
            1,
            json!({
                "label": "允许全项目扫描",
                "value": "允许全项目 workspace",
                "kind": "scope"
            }),
        );
        options.truncate(3);
    }
    let placeholder = if is_budget {
        "例如：允许全项目扫描；或只看 src/ide/app.ts 和 src-tauri/src/ide.rs".to_string()
    } else {
        "例如：允许该路径；或改为只检查某个目录/文件".to_string()
    };
    Some(json!({
        "question": question,
        "options": options,
        "placeholder": placeholder,
        "source": "tool_guard",
        "originalTool": tool,
        "originalInput": input,
        "guardError": err
    }))
}

fn guard_agent_tool_scope(
    app: Option<&AppHandle>,
    session_id: Option<&str>,
    _root_path: &str,
    tool: &str,
    input: &Value,
) -> Result<Value, String> {
    let (Some(app), Some(session_id)) = (app, session_id) else {
        return Ok(input.clone());
    };
    let focus_paths = session_focus_paths(app, session_id);
    let allow_global = session_allows_global_scan(app, session_id);
    let mut next = input.clone();
    match tool {
        "read_file" => {
            increment_agent_tool_budget(app, session_id, "read", 18)?;
            let path = input
                .get("path")
                .or_else(|| input.get("file"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !allow_global
                && !focus_paths.is_empty()
                && !path_in_focus(path, &focus_paths)
                && !root_common_agent_path(path)
            {
                return Err(format!(
                    "Read blocked by workspace focus: {path} is outside current focus {}. Ask for global scan before reading outside focus.",
                    focus_paths.join(", ")
                ));
            }
        }
        "glob" => {
            let path = input.get("path").and_then(Value::as_str).unwrap_or("");
            if !allow_global && !focus_paths.is_empty() {
                if path.trim().is_empty() {
                    if let Some(object) = next.as_object_mut() {
                        object.insert("path".to_string(), Value::String(focus_paths[0].clone()));
                        object.insert("scopeRewritten".to_string(), Value::Bool(true));
                    }
                } else if !path_in_focus(path, &focus_paths) {
                    return Err(format!(
                        "Directory scan blocked by workspace focus: {path} is outside current focus {}. Ask for global scan or use a focused path.",
                        focus_paths.join(", ")
                    ));
                }
            }
            let depth = next
                .get("maxDepth")
                .or_else(|| next.get("depth"))
                .and_then(Value::as_u64)
                .unwrap_or(2)
                .min(if allow_global { 3 } else { 2 });
            if let Some(object) = next.as_object_mut() {
                object.insert("maxDepth".to_string(), json!(depth));
            }
            let cache_key = agent_tool_cache_key("glob", &next);
            if agent_tool_cache_get(app, session_id, &cache_key).is_some() {
                if let Some(object) = next.as_object_mut() {
                    object.insert("__cacheKey".to_string(), Value::String(cache_key));
                    object.insert("__cacheHit".to_string(), Value::Bool(true));
                }
                return Ok(next);
            }
            increment_agent_tool_budget(app, session_id, "glob", 5)?;
            if let Some(object) = next.as_object_mut() {
                object.insert("__cacheKey".to_string(), Value::String(cache_key));
            }
        }
        "grep" | "symbol_search" => {
            increment_agent_tool_budget(app, session_id, "search", 8)?;
            if !allow_global && !focus_paths.is_empty() {
                if let Some(object) = next.as_object_mut() {
                    object.insert("focusPaths".to_string(), json!(focus_paths));
                }
            }
        }
        _ => {}
    }
    Ok(next)
}

fn read_context_ref_path(
    root_path: &str,
    path: &str,
    tool_calls: &mut Vec<Value>,
    context: &mut Vec<String>,
) {
    if connector::read_workspace_file(root_path, path).is_ok() {
        read_agent_file(root_path, path, 24000, true, tool_calls, context);
        return;
    }
    let Ok(entries) = connector::list_workspace_tree(root_path, path, 2) else {
        tool_calls.push(agent_tool_call(
            "workspace_context",
            json!({ "kind": "context_ref_path", "path": path }),
            json!({}),
            Some(format!("explicit context path not found: {path}")),
        ));
        return;
    };
    let mut lines = Vec::new();
    summarize_workspace_entries(&entries, 0, &mut lines, 120);
    context.push(format!(
        "[explicit_context_dir:{path}]\n{}",
        lines.join("\n")
    ));
    tool_calls.push(agent_tool_call(
        "glob",
        json!({ "path": path, "maxDepth": 2 }),
        json!({ "count": lines.len(), "summary": format!("scanned explicit context directory {path}") }),
        None,
    ));
    let mut file_paths = Vec::new();
    collect_context_ref_files(&entries, &mut file_paths, 8);
    for file_path in file_paths {
        read_agent_file(root_path, &file_path, 18000, false, tool_calls, context);
    }
}

fn collect_context_ref_files(
    entries: &[connector::WorkspaceEntry],
    file_paths: &mut Vec<String>,
    limit: usize,
) {
    if file_paths.len() >= limit {
        return;
    }
    let preferred = [
        "py", "ts", "tsx", "js", "jsx", "rs", "go", "java", "c", "cpp", "h", "hpp", "json", "toml",
        "yaml", "yml", "md",
    ];
    for item in entries {
        if file_paths.len() >= limit {
            return;
        }
        if item.kind == "file" {
            let extension = item
                .path
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if preferred.contains(&extension.as_str())
                || item.name.eq_ignore_ascii_case("README.md")
                || item.name.eq_ignore_ascii_case("package.json")
            {
                file_paths.push(item.path.clone());
            }
        }
    }
    for item in entries {
        if file_paths.len() >= limit {
            return;
        }
        if item.kind == "dir" {
            collect_context_ref_files(&item.children, file_paths, limit);
        }
    }
}

fn should_collect_project_overview(
    prompt: &str,
    workspace_context: &Value,
    has_memory: bool,
) -> bool {
    let lower = prompt.to_ascii_lowercase();
    let project_keywords = [
        "project overview",
        "overview",
        "structure",
        "framework",
        "what is this project",
        "workspace",
        "项目结构",
        "项目概览",
        "工程概览",
    ];
    if project_keywords
        .iter()
        .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
    {
        return true;
    }
    let history_count = workspace_context
        .get("history")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let has_summary = workspace_context
        .get("sessionSnapshot")
        .and_then(|snapshot| snapshot.get("compactedSummary"))
        .is_some();
    history_count <= 1 && !has_memory && !has_summary
}

fn prompt_wants_git_diff(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    [
        "git", "diff", "review", "change", "modify", "fix", "patch", "build", "test", "提交",
        "变更", "修改", "修复",
    ]
    .iter()
    .any(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
}

fn collect_agent_context(
    root_path: &str,
    workspace_context: &Value,
    prompt: &str,
) -> (String, Vec<Value>) {
    let mut tool_calls = Vec::new();
    let mut context = Vec::new();
    context.push(format!("[workspace]\nroot={root_path}"));
    let (memory_context, memory_refs) = read_agent_memory_for_context(root_path);
    let has_memory = !memory_context.trim().is_empty();
    if !memory_context.trim().is_empty() {
        context.push(memory_context);
        tool_calls.push(agent_tool_call(
            "memory_read",
            json!({ "files": memory_refs }),
            json!({ "summary": "project memory loaded" }),
            None,
        ));
    }
    let focus_paths = workspace_context
        .get("focusPaths")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            workspace_context
                .get("sessionSnapshot")
                .and_then(|snapshot| snapshot.get("focusPaths"))
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(normalize_agent_rel_path))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if !focus_paths.is_empty() {
        context.push(format!(
            "[workspace_focus]\ncurrent focus paths: {}\nRead/search/list operations should stay inside these paths unless the user asks for a whole-workspace scan.",
            focus_paths.join(", ")
        ));
    }
    if let Some(summary) = workspace_context
        .get("sessionSnapshot")
        .and_then(|snapshot| snapshot.get("compactedSummary"))
        .and_then(|value| value.get("summary").or(Some(value)))
        .map(collect_text)
        .filter(|value| !value.trim().is_empty())
    {
        context.push(format!(
            "[compacted_session_summary]\n{}",
            summary.chars().take(20000).collect::<String>()
        ));
    }

    let collect_overview = should_collect_project_overview(prompt, workspace_context, has_memory);
    if collect_overview {
        match connector::list_workspace_tree(root_path, "", 2) {
            Ok(tree) => {
                let mut lines = Vec::new();
                summarize_workspace_entries(&tree, 0, &mut lines, 140);
                context.push(format!("[directory_tree]\n{}", lines.join("\n")));
                tool_calls.push(agent_tool_call(
                    "list_files",
                    json!({ "path": "", "maxDepth": 2, "reason": "project_overview" }),
                    json!({ "count": lines.len(), "summary": "鎵弿椤圭洰姒傝鐩綍" }),
                    None,
                ));
            }
            Err(err) => {
                tool_calls.push(agent_tool_call(
                    "list_files",
                    json!({ "path": "", "maxDepth": 2, "reason": "project_overview" }),
                    json!({}),
                    Some(err),
                ));
            }
        }
    } else {
        context.push("[context_strategy]\nThis turn did not pre-scan the full workspace. Prefer memory, explicit @ references, current file, and Git summary; use grep/glob/read_file when evidence is needed.".to_string());
    }

    let mut candidates = if collect_overview {
        vec![
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
        .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
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
        read_agent_file(
            root_path,
            &path,
            14000,
            record_missing,
            &mut tool_calls,
            &mut context,
        );
    }

    if let Some(selected) = workspace_context
        .get("selectedText")
        .and_then(Value::as_str)
    {
        if !selected.trim().is_empty() {
            context.push(format!(
                "[selected_text]\n{}",
                selected.chars().take(8000).collect::<String>()
            ));
            tool_calls.push(agent_tool_call(
                "workspace_context",
                json!({ "kind": "selection" }),
                json!({ "summary": "added editor selection context" }),
                None,
            ));
        }
    }
    if let Some(chips) = workspace_context
        .get("contextRefs")
        .and_then(Value::as_array)
    {
        if !chips.is_empty() {
            context.push(format!(
                "[explicit_context_refs]\n{}",
                Value::Array(chips.clone())
            ));
            tool_calls.push(agent_tool_call(
                "workspace_context",
                json!({ "kind": "contextRefs" }),
                json!({ "count": chips.len(), "summary": "added explicit context references" }),
                None,
            ));
            for chip in chips {
                let value = chip
                    .get("value")
                    .or_else(|| chip.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(path) = context_ref_path(value) {
                    read_context_ref_path(root_path, &path, &mut tool_calls, &mut context);
                }
            }
        }
    }
    if let Some(output) = workspace_context
        .get("terminalOutput")
        .and_then(Value::as_str)
    {
        if !output.trim().is_empty() {
            let mut recent = output.to_string();
            if recent.len() > 8000 {
                recent = recent
                    .chars()
                    .rev()
                    .take(8000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<String>();
            }
            context.push(format!("[recent_terminal_output]\n{recent}"));
            tool_calls.push(agent_tool_call(
                "terminal_output",
                json!({ "tail": 8000 }),
                json!({ "summary": "read recent terminal output" }),
                None,
            ));
        }
    }
    match connector::read_workspace_git_status(root_path) {
        Ok(git) => {
            let include_full_diff = prompt_wants_git_diff(prompt) || collect_overview;
            let diff_context = if include_full_diff {
                git.diff.chars().take(20000).collect::<String>()
            } else {
                git.status_short.chars().take(6000).collect::<String>()
            };
            context.push(format!(
                "[git]\nbranch={}\nstaged={}\nunstaged={}\nuntracked={}\n\n{}",
                git.branch, git.staged_count, git.unstaged_count, git.untracked_count, diff_context
            ));
            tool_calls.push(agent_tool_call(
                "git_diff",
                json!({}),
                json!({ "summary": format!("{} staged / {} unstaged / {} untracked", git.staged_count, git.unstaged_count, git.untracked_count), "fullDiff": include_full_diff }),
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
    let mut ai_request =
        serde_json::from_value::<IdeAiRequest>(request.clone()).unwrap_or_default();
    let root_path = workspace_context
        .get("root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "agent workspace root is required".to_string())?;
    connector::resolve_authorized_root(root_path)?;
    let prompt = ai_request
        .messages
        .iter()
        .rev()
        .find(|message| message.role != "system")
        .map(|message| message.content.clone())
        .or_else(|| {
            request
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Continue development based on the current workspace.".to_string());
    let (local_context, tool_calls) = collect_agent_context(root_path, &workspace_context, &prompt);
    let user_system = ai_request
        .messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let profile_id = workspace_context
        .pointer("/sessionSnapshot/profileId")
        .and_then(Value::as_str)
        .unwrap_or("build");
    let profile_contract = agent_profile_system_contract(profile_id);
    let turn_contract = agent_profile_turn_contract(profile_id, &workspace_context);
    let retrieval_contract = "Retrieval contract:\n- Prefer explicit context, current/open files, project memory, Git summary, and targeted grep before glob.\n- Use glob only for file discovery with a concrete pattern or focused path. Do not repeat the same glob after a cached result.\n- If a broad scan is blocked by focus or budget, ask a scope question instead of looping.\n- Use read_file only after locating the concrete file path; avoid bash for file reads when read_file/grep/glob can express the request.";
    let user_preference_contract = if user_system.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n\nUser custom preferences, lower priority than the profile/operational contracts:\n{}",
            user_system
        )
    };
    let agent_system = format!(
        "{}\n\n{}\n\n{}\n\n{}{}",
        profile_contract,
        "You are AutoCode local IDE coding agent, not a passive chat assistant. Decide from the task semantics whether the requested outcome changes the workspace, validates the workspace, or only explains something.\n\nLanguage contract:\n- The user is Chinese by default. Unless the user explicitly asks for another language, all visible final answers, concise reasoning summaries, tool summaries, questions, and status text must be in Simplified Chinese.\n- Code, file paths, commands, identifiers, and error messages may stay in their original language.\n\nOperational contract:\n- Profile contracts are mandatory and override user custom preferences when they conflict.\n- If the outcome requires creating, editing, replacing, fixing, wiring, running, or validating project code, use tools and perform the work in the workspace. Do not give copy-paste code as the primary answer when a workspace file can be changed.\n- Before changing a file, read the relevant file(s) unless their full current content is already present in explicit context.\n- Prefer write with {path, content} for file modifications because it is structured and avoids malformed diff failures. Use apply_patch only when you can produce a complete valid standard unified git diff or complete Codex patch including *** Begin Patch and *** End Patch. If any observation says apply_patch is malformed, corrupt, invalid, or disabled, immediately switch to write and do not call apply_patch again in that turn.\n- The permission gate will show the resulting file change to the user; do not ask the user to manually copy code.\n- If the user explicitly asks only for explanation, comparison, teaching, or an isolated snippet without project changes, answer normally.\n- If the target is ambiguous after reading available context, ask a concise Chinese question with the question tool instead of guessing.\n- Use read_file, grep, glob, git_diff, todowrite, bash, write, apply_patch, diagnostics, test_runner, symbol_search, process_manager, browser_preview, lsp, mcp_call, and question as needed.\n- If native tool calling is unavailable, output one JSON object per step: {\"action\":\"tool\",\"tool\":\"...\",\"input\":{...}}. When finished, output {\"action\":\"final\",\"content\":\"...\"}.\n- Do not output shell fences for commands the agent should run. Do not output large replacement files in chat when write/apply_patch is possible. Final answers should summarize in Chinese what was done and what still needs approval or verification.",
        "Project memory contract:\n- Treat .autocode/AGENTS.md and .autocode/memory*.md in context as durable project memory.\n- In plan/review/explore/docs profiles, do not call memory_update; those modes are read-only unless the user explicitly chooses a follow-up action that switches to an execution profile.\n- In execution profiles, when a turn establishes durable facts, stable user preferences, architectural decisions, recurring project commands, or confirmed fixes that will help future turns, call memory_update with a small patch for .autocode/memory.md.\n- Do not store transient step logs, raw tool output, secrets, credentials, one-off errors, or guesses.\n- memory_update is restricted to .autocode memory files; keep entries concise and organized under confirmed facts, user preferences, or decision records.",
        retrieval_contract,
        user_preference_contract
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
                    Some(IdeAiMessage::new(
                        role,
                        content.chars().take(12000).collect::<String>(),
                    ))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut messages = vec![IdeAiMessage::new("system", agent_system)];
    messages.extend(
        history
            .into_iter()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev(),
    );
    messages.push(IdeAiMessage::new(
        "user",
        if turn_contract.trim().is_empty() {
            format!(
                "{prompt}\n\n[AutoCode Local Agent Context]\n{local_context}\n\nUse the local context above to complete the request directly."
            )
        } else {
            format!(
                "{turn_contract}\n\n[User Request]\n{prompt}\n\n[AutoCode Local Agent Context]\n{local_context}\n\nUse the local context above while obeying the profile turn protocol."
            )
        },
    ));
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
        "approvalMode": settings.approval_mode,
        "contextBudget": settings.context_budget,
        "autoCompactThreshold": settings.auto_compact_threshold,
        "checkpointPolicy": settings.checkpoint_policy,
        "status": "idle",
        "stepCount": 0,
        "compactionCount": 0,
        "compactedSummary": Value::Null,
        "memoryRefs": [],
        "checkpoints": [],
        "todos": [],
        "messages": [],
        "pendingInjectedMessages": [],
        "toolCalls": [],
        "permissions": [],
        "permissionRules": [],
        "activeRequestId": "",
        "lastRequestId": "",
        "createdAt": now,
        "updatedAt": now,
    });
    state
        .agent_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session.clone());
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
        "approvalMode": settings.approval_mode,
        "contextBudget": settings.context_budget,
        "autoCompactThreshold": settings.auto_compact_threshold,
        "checkpointPolicy": settings.checkpoint_policy,
        "status": "idle",
        "stepCount": 0,
        "compactionCount": 0,
        "compactedSummary": Value::Null,
        "memoryRefs": [],
        "checkpoints": [],
        "todos": [],
        "messages": [],
        "pendingInjectedMessages": [],
        "toolCalls": [],
        "permissions": [],
        "permissionRules": [],
        "activeRequestId": "",
        "lastRequestId": "",
        "createdAt": now,
        "updatedAt": now,
    });
    state
        .agent_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session.clone());
    persist_agent_session_value(&session);
    Ok(session)
}

async fn agent_call_model(
    app: &AppHandle,
    session_id: &str,
    settings: connector::IdeSettings,
    ai_request: IdeAiRequest,
) -> Result<AgentModelTurn, String> {
    let selected_model = settings.model.trim().to_string();
    let candidates = if settings.channels.is_empty() {
        Vec::new()
    } else {
        provider_channel_candidates(&settings, "agent", Some(selected_model.as_str()))
    };
    if !settings.channels.is_empty() && candidates.is_empty() {
        return Err(format!(
            "No enabled channel provides Agent model {}.",
            selected_model
        ));
    }
    let attempts = if candidates.is_empty() {
        vec![None]
    } else {
        candidates.into_iter().map(Some).collect()
    };
    let mut errors = Vec::new();
    for candidate in attempts {
        let channel_name = candidate
            .as_ref()
            .map(|item| item.name.clone())
            .unwrap_or_else(|| "Current Provider".to_string());
        let routed = candidate
            .as_ref()
            .map(|channel| settings_for_channel(&settings, channel, Some(selected_model.as_str())))
            .unwrap_or_else(|| settings.clone());
        let routed_model = provider_model(&routed);
        agent_emit_phase(
            app,
            session_id,
            "model_request",
            "running",
            "Requesting Provider",
            &format!("{} / {}", routed.provider_type.trim(), routed_model.trim()),
        );
        match stream_agent_model_turn(app, session_id, routed.clone(), ai_request.clone()).await {
            Ok(turn) => return Ok(turn),
            Err(stream_err) => {
                let stream_err = stream_err.trim_start_matches("partial_output:").to_string();
                if agent_session_is_cancel_requested(app, session_id)
                    || stream_err.to_ascii_lowercase().contains("cancelled")
                {
                    return Err("agent cancelled by user".to_string());
                }
                agent_emit(
                    app,
                    session_id,
                    "provider_retry",
                    json!({
                        "channel": channel_name,
                        "model": selected_model,
                        "reason": stream_err,
                    }),
                );
                if terminal_provider_request_error(&stream_err) {
                    errors.push(format!("{}: {}", channel_name, stream_err));
                    continue;
                }
                if routed.provider_type == "deepseek"
                    && deepseek_reasoning_tool_compat_error(&stream_err)
                {
                    let mut retry_settings = routed.clone();
                    retry_settings.reasoning_mode = "off".to_string();
                    retry_settings.reasoning_effort.clear();
                    agent_emit(
                        app,
                        session_id,
                        "provider_retry",
                        json!({
                            "channel": channel_name,
                            "model": selected_model,
                            "reason": "DeepSeek thinking/tool-call compatibility error; retrying once with thinking disabled.",
                        }),
                    );
                    match stream_agent_model_turn(
                        app,
                        session_id,
                        retry_settings,
                        ai_request.clone(),
                    )
                    .await
                    {
                        Ok(turn) => return Ok(turn),
                        Err(retry_err) => errors.push(format!(
                            "{}: {}; reasoning retry: {}",
                            channel_name, stream_err, retry_err
                        )),
                    }
                }
                match ide_ai_request_single(
                    routed,
                    ai_request.clone(),
                    Some(false),
                    true,
                    Some(agent_cancel_token_for(app, session_id)),
                )
                .await
                {
                    Ok(mut response) => {
                        let native_tool_requests = native_tool_requests_from_chat_message(
                            &response.provider,
                            &response.tool_calls,
                        );
                        let tool_requests = if native_tool_requests.is_empty() {
                            extract_agent_tool_requests(&response.answer)
                        } else {
                            native_tool_requests
                        };
                        if tool_requests.is_empty() {
                            if let Some(final_answer) = extract_agent_final_answer(&response.answer)
                            {
                                response.answer = final_answer;
                            }
                        }
                        if !response.answer.trim().is_empty() && tool_requests.is_empty() {
                            agent_emit(
                                app,
                                session_id,
                                "message_part",
                                json!({
                                    "role": "assistant", "kind": "text", "content": response.answer.clone()
                                }),
                            );
                        }
                        return Ok(AgentModelTurn {
                            response: IdeAiResponse {
                                tool_calls: tool_requests.clone(),
                                ..response
                            },
                            tool_requests,
                        });
                    }
                    Err(error) => errors.push(format!(
                        "{}: {}; stream: {}",
                        channel_name, error, stream_err
                    )),
                }
            }
        }
    }
    Err(format!(
        "All Agent candidate channels failed: {}",
        errors.join(" | ")
    ))
}

const AGENT_LOOP_MAX_STEPS: usize = 30;

fn drain_pending_agent_injected_messages(
    app: &AppHandle,
    session_id: &str,
) -> Vec<IdeAiMessage> {
    let mut injected = Vec::new();
    update_agent_session(app, session_id, |session| {
        if let Some(items) = session
            .get_mut("pendingInjectedMessages")
            .and_then(Value::as_array_mut)
        {
            injected = items.drain(..).collect();
        } else {
            session["pendingInjectedMessages"] = json!([]);
        }
    });
    injected
        .into_iter()
        .filter_map(|item| {
            let content = item
                .get("content")
                .or_else(|| item.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if content.is_empty() {
                return None;
            }
            let context_refs = item
                .get("contextRefs")
                .or_else(|| item.get("context_refs"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            let mut message = format!(
                "AutoCode runtime intervention: The user injected this message while the current Agent run was still active. Incorporate it into this same run before continuing. Do not defer it to a later queued turn.\n\n[Injected User Message]\n{}",
                content
            );
            if context_refs.as_array().map(|items| !items.is_empty()).unwrap_or(false) {
                message.push_str("\n\n[Injected Context References]\n");
                message.push_str(&tail_chars(&context_refs.to_string(), 20000));
            }
            Some(IdeAiMessage::new("user", message))
        })
        .collect()
}

fn append_pending_agent_injected_messages(
    app: &AppHandle,
    session_id: &str,
    ai_request: &mut IdeAiRequest,
) -> usize {
    let messages = drain_pending_agent_injected_messages(app, session_id);
    let count = messages.len();
    if count > 0 {
        ai_request.messages.extend(messages);
        agent_emit_phase(
            app,
            session_id,
            "injected_message",
            "running",
            "Injected user message",
            "User intervention was added to the current Agent turn.",
        );
    }
    count
}

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
    let mut step_base = start_step;
    let mut copy_paste_repair_used = false;
    let mut malformed_patch_repair_count = 0usize;
    let mut force_write_after_bad_patch = false;
    let mut timeout_compaction_retry_used = false;
    loop {
        set_agent_session_status(app, session_id, "running");
        for step in step_base..AGENT_LOOP_MAX_STEPS {
            if agent_session_is_cancel_requested(app, session_id) {
                last_response.finish_reason = "cancelled".to_string();
                if last_response.answer.trim().is_empty() {
                    last_response.answer =
                        "Agent stopped as requested; current session history and completed tool results were preserved.".to_string();
                }
                finalize_agent_cancellation(app, session_id);
                return Ok(last_response);
            }
            update_agent_session(app, session_id, |session| {
                let cancel_requested = session
                    .get("cancelRequested")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || matches!(
                        session.get("status").and_then(Value::as_str).unwrap_or(""),
                        "cancelling" | "cancelled"
                    );
                if !cancel_requested {
                    session["status"] = Value::String("running".to_string());
                } else if session.get("status").and_then(Value::as_str) != Some("cancelled") {
                    session["status"] = Value::String("cancelling".to_string());
                }
                session["stepCount"] = json!(step + 1);
            });
            compact_agent_request_before_send(
                app,
                session_id,
                &settings,
                &mut ai_request,
                "pre_request_budget",
            )?;
            append_pending_agent_injected_messages(app, session_id, &mut ai_request);
            let turn = match agent_call_model(app, session_id, settings.clone(), ai_request.clone())
                .await
            {
                Ok(turn) => turn,
                Err(err)
                    if err.contains("agent cancelled by user")
                        || agent_session_is_cancel_requested(app, session_id) =>
                {
                    last_response.finish_reason = "cancelled".to_string();
                    if last_response.answer.trim().is_empty() {
                        last_response.answer =
                        "Agent stopped as requested; current session history and completed tool results were preserved.".to_string();
                    }
                    finalize_agent_cancellation(app, session_id);
                    return Ok(last_response);
                }
                Err(err) => {
                    if !timeout_compaction_retry_used && provider_timeout_error(&err) {
                        timeout_compaction_retry_used = true;
                        agent_emit(
                            app,
                            session_id,
                            "provider_retry",
                            json!({
                                "channel": "Agent",
                                "model": provider_model(&settings),
                                "reason": format!(
                                    "{}; compacting oversized context and retrying once.",
                                    err
                                ),
                            }),
                        );
                        let compacted = compact_agent_session(app, session_id, "provider_timeout")?;
                        let system_prompt =
                            agent_request_system_prompt(&ai_request).map(str::to_string);
                        ai_request.messages = compacted_agent_continuation_messages(
                            &compacted,
                            system_prompt.as_deref(),
                        );
                        continue;
                    }
                    return Err(err);
                }
            };
            let response = turn.response;
            let tool_requests = turn.tool_requests;
            last_response = response.clone();
            if agent_session_is_cancel_requested(app, session_id) {
                last_response.finish_reason = "cancelled".to_string();
                if last_response.answer.trim().is_empty() {
                    last_response.answer =
                        "Agent stopped as requested; current session history and completed tool results were preserved.".to_string();
                }
                finalize_agent_cancellation(app, session_id);
                return Ok(last_response);
            }
            if tool_requests.is_empty() {
                if !copy_paste_repair_used
                    && answer_contains_substantial_code_block(&response.answer)
                {
                    copy_paste_repair_used = true;
                    ai_request
                        .messages
                        .push(IdeAiMessage::new("assistant", response.answer.clone()));
                    ai_request.messages.push(IdeAiMessage::new(
                        "user",
                        "AutoCode runtime review: your last response included a substantial code block but no tool call. Re-evaluate the task semantics. If the requested outcome should change workspace files, call read_file/apply_patch/write now so the IDE can show a diff and ask for approval. If it is truly only an explanation or standalone snippet, return a final answer without modifying files.",
                    ));
                    continue;
                }
                set_agent_session_status(app, session_id, "finalizing");
                let injected_messages = drain_pending_agent_injected_messages(app, session_id);
                if !injected_messages.is_empty() {
                    if !response.answer.trim().is_empty() {
                        ai_request
                            .messages
                            .push(IdeAiMessage::new("assistant", response.answer.clone()));
                    }
                    ai_request.messages.extend(injected_messages);
                    agent_emit_phase(
                        app,
                        session_id,
                        "injected_message",
                        "running",
                        "Injected user message",
                        "User intervention arrived before finalization; continuing the current Agent turn.",
                    );
                    set_agent_session_status(app, session_id, "running");
                    continue;
                }
                set_agent_session_status(app, session_id, "completed");
                return Ok(response);
            }
            let mut observations = Vec::new();
            let use_chat_tool_messages = provider_uses_chat_tool_messages(&response.provider);
            for request in tool_requests {
                if agent_session_is_cancel_requested(app, session_id) {
                    last_response.finish_reason = "cancelled".to_string();
                    if last_response.answer.trim().is_empty() {
                        last_response.answer =
                        "Agent stopped as requested; current session history and completed tool results were preserved.".to_string();
                    }
                    finalize_agent_cancellation(app, session_id);
                    return Ok(last_response);
                }
                let raw_tool = request
                    .get("tool")
                    .or_else(|| request.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let tool = normalize_agent_tool_name(raw_tool);
                let mut input = normalize_agent_tool_input(&tool, tool_input(&request), &request);
                let tool_call_id = format!("tool-{tool}-{}", agent_now());
                let provider_tool_call_id = native_tool_call_id(&request, &tool_call_id);
                let tool_request_id = agent_session_active_request_id(app, session_id);
                let use_tool_message = use_chat_tool_messages && tool != "question";
                if !agent_tool_name_is_builtin(&tool) {
                    let err = format!(
                        "unsupported agent tool: {tool}. Use mcp_call with a configured server for MCP tools."
                    );
                    let mut call =
                        agent_tool_call(&tool, input.clone(), json!({}), Some(err.clone()));
                    if let Some(obj) = call.as_object_mut() {
                        obj.insert("id".to_string(), Value::String(tool_call_id.clone()));
                        obj.insert(
                            "requestId".to_string(),
                            Value::String(tool_request_id.clone()),
                        );
                    }
                    agent_emit(app, session_id, "tool_call_result", call);
                    let observation = json!({ "tool": tool, "ok": false, "error": err });
                    if use_tool_message {
                        ai_request.messages.push(IdeAiMessage::tool_result(
                            provider_tool_call_id,
                            agent_tool_result_message_content(&observation),
                        ));
                    }
                    observations.push(observation);
                    continue;
                }
                if use_tool_message {
                    ai_request.messages.push(IdeAiMessage::assistant_with_tools(
                        last_response.answer.clone(),
                        vec![native_chat_tool_call_from_request(
                            &request,
                            &provider_tool_call_id,
                        )],
                        last_response.reasoning_raw.clone(),
                    ));
                }
                if tool == "bash" {
                    sanitize_agent_bash_input(&mut input);
                }
                if let Err(err) = validate_agent_tool_input(&tool, &input) {
                    let observation = json!({
                        "tool": tool,
                        "ok": false,
                        "error": err,
                        "hint": "Fix the tool input and retry with the required parameters. Do not use bash as a fallback for reading a file unless read_file cannot express the request."
                    });
                    if use_tool_message {
                        ai_request.messages.push(IdeAiMessage::tool_result(
                            provider_tool_call_id,
                            agent_tool_result_message_content(&observation),
                        ));
                    }
                    observations.push(observation);
                    continue;
                }
                if tool == "apply_patch" && force_write_after_bad_patch {
                    let observation = json!({
                        "tool": tool,
                        "ok": false,
                        "error": "apply_patch is disabled for this turn after a malformed patch attempt",
                        "hint": "Use write with {path, content} for the target file. Do not call apply_patch again in this turn."
                    });
                    if use_tool_message {
                        ai_request.messages.push(IdeAiMessage::tool_result(
                            provider_tool_call_id,
                            agent_tool_result_message_content(&observation),
                        ));
                    }
                    observations.push(observation);
                    continue;
                }
                if tool == "apply_patch" {
                    let patch_value = input
                        .get("patch")
                        .or_else(|| input.get("diff"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    match normalize_agent_unified_patch(patch_value) {
                        Ok(normalized) => {
                            if let Some(object) = input.as_object_mut() {
                                object.insert("patch".to_string(), Value::String(normalized));
                                object.remove("diff");
                            }
                            input = rewrite_apply_patch_input_paths(
                                Some(app),
                                Some(session_id),
                                root_path,
                                &input,
                            );
                        }
                        Err(err) => {
                            malformed_patch_repair_count += 1;
                            force_write_after_bad_patch = true;
                            let observation = json!({
                                "tool": tool,
                                "ok": false,
                                "error": err,
                                "hint": "Your apply_patch payload is not valid. For the rest of this turn, do not call apply_patch again; use write with path/content for the complete target file."
                            });
                            if use_tool_message {
                                ai_request.messages.push(IdeAiMessage::tool_result(
                                    provider_tool_call_id,
                                    agent_tool_result_message_content(&observation),
                                ));
                            }
                            observations.push(observation);
                            continue;
                        }
                    }
                    let patch_value = input
                        .get("patch")
                        .or_else(|| input.get("diff"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    match validate_agent_patch_without_apply(root_path, patch_value) {
                        Ok(validated) => {
                            if let Some(object) = input.as_object_mut() {
                                object.insert("patch".to_string(), Value::String(validated));
                                object.remove("diff");
                            }
                        }
                        Err(err) => {
                            if patch_error_is_format_issue(&err) {
                                malformed_patch_repair_count += 1;
                                force_write_after_bad_patch = true;
                            }
                            let observation = json!({
                                "tool": tool,
                                "ok": false,
                                "error": err,
                                "hint": if force_write_after_bad_patch {
                                    "The patch failed preflight validation. Do not call apply_patch again in this turn. Use write with path/content for the full target file."
                                } else {
                                    "The patch failed preflight validation. Re-read the target file or use write with full file content."
                                }
                            });
                            if use_tool_message {
                                ai_request.messages.push(IdeAiMessage::tool_result(
                                    provider_tool_call_id,
                                    agent_tool_result_message_content(&observation),
                                ));
                            }
                            observations.push(observation);
                            continue;
                        }
                    }
                }
                input = match guard_agent_tool_scope(
                    Some(app),
                    Some(session_id),
                    root_path,
                    &tool,
                    &input,
                ) {
                    Ok(guarded) => guarded,
                    Err(err) => {
                        if let Some(question_input) =
                            agent_scope_question_for_guard_error(&tool, &input, &err)
                        {
                            let question_call_id = format!("tool-question-{}", agent_now());
                            let question_text = question_input
                                .get("question")
                                .and_then(Value::as_str)
                                .unwrap_or("需要你确认扫描范围后继续。")
                                .to_string();
                            let question_output = json!({
                                "question": question_text,
                                "options": question_input.get("options").cloned().unwrap_or_else(|| json!([])),
                                "placeholder": question_input.get("placeholder").cloned().unwrap_or_else(|| Value::String("输入补充路径或范围要求...".to_string())),
                                "requiresUserResponse": true,
                                "source": "tool_guard",
                                "originalTool": tool,
                                "guardError": err
                            });
                            let tool_observation = json!({
                                "tool": tool,
                                "ok": false,
                                "requiresUserScope": true,
                                "error": question_output.get("guardError").cloned().unwrap_or(Value::Null),
                                "hint": "The runtime paused for user scope confirmation. Continue after the user answers the question."
                            });
                            if use_tool_message {
                                ai_request.messages.push(IdeAiMessage::tool_result(
                                    provider_tool_call_id.clone(),
                                    agent_tool_result_message_content(&tool_observation),
                                ));
                            }
                            let mut question_call = agent_tool_call(
                                "question",
                                question_input.clone(),
                                question_output.clone(),
                                None,
                            );
                            if let Some(obj) = question_call.as_object_mut() {
                                obj.insert(
                                    "id".to_string(),
                                    Value::String(question_call_id.clone()),
                                );
                                obj.insert(
                                    "requestId".to_string(),
                                    Value::String(tool_request_id.clone()),
                                );
                            }
                            agent_emit(app, session_id, "tool_call_result", question_call.clone());
                            update_agent_session(app, session_id, |session| {
                                session["status"] = Value::String("waiting_question".to_string());
                                session["pendingQuestion"] = json!({
                                    "id": question_call_id,
                                    "input": question_input,
                                    "output": question_output,
                                    "createdAt": agent_now()
                                });
                                session["pendingContinuation"] = json!({
                                    "settings": settings.clone(),
                                    "aiRequest": ai_request.clone(),
                                    "step": step,
                                    "lastAnswer": last_response.answer.clone(),
                                    "profileId": profile_id,
                                    "rootPath": root_path
                                });
                                if let Some(items) =
                                    session.get_mut("toolCalls").and_then(Value::as_array_mut)
                                {
                                    items.push(question_call.clone());
                                }
                            });
                            agent_emit_phase(
                                app,
                                session_id,
                                "waiting_question",
                                "running",
                                "Waiting for scan scope confirmation",
                                &question_text,
                            );
                            last_response.finish_reason = "waiting_question".to_string();
                            if last_response.answer.trim().is_empty() {
                                last_response.answer = question_text;
                            }
                            return Ok(last_response);
                        }
                        agent_emit(
                            app,
                            session_id,
                            "tool_call_start",
                            json!({
                                "id": tool_call_id,
                                "name": tool,
                                "input": input.clone(),
                                "requestId": tool_request_id.clone(),
                                "status": "running"
                            }),
                        );
                        let mut call =
                            agent_tool_call(&tool, input.clone(), json!({}), Some(err.clone()));
                        if let Some(obj) = call.as_object_mut() {
                            obj.insert("id".to_string(), Value::String(tool_call_id.clone()));
                            obj.insert(
                                "requestId".to_string(),
                                Value::String(tool_request_id.clone()),
                            );
                        }
                        agent_emit(app, session_id, "tool_call_result", call.clone());
                        let observation = json!({
                            "tool": tool,
                            "ok": false,
                            "error": err,
                            "hint": "Stay inside the current focus path or ask the user for explicit whole-project scope."
                        });
                        if use_tool_message {
                            ai_request.messages.push(IdeAiMessage::tool_result(
                                provider_tool_call_id,
                                agent_tool_result_message_content(&observation),
                            ));
                        }
                        observations.push(observation);
                        continue;
                    }
                };
                if tool == "question" && profile_id.eq_ignore_ascii_case("plan") {
                    if let Err(err) = planning_question_input_is_valid(&input) {
                        let observation = json!({
                            "tool": tool,
                            "ok": false,
                            "error": err,
                            "hint": "Planning mode must ask with a question card: provide question, exactly 2-3 options, and placeholder. Retry the question tool; do not write plain-text confirmation."
                        });
                        if use_tool_message {
                            ai_request.messages.push(IdeAiMessage::tool_result(
                                provider_tool_call_id,
                                agent_tool_result_message_content(&observation),
                            ));
                        }
                        observations.push(observation);
                        continue;
                    }
                }
                let (mut decision, mut risk) =
                    agent_tool_requires_approval(profile_id, Some(&settings), &tool, &input);
                if let Some(remembered) =
                    remembered_agent_permission_decision(app, session_id, &tool, &input)
                {
                    decision = remembered;
                    risk = if decision == "deny" { "high" } else { "low" };
                }
                if decision == "deny" {
                    agent_emit(
                        app,
                        session_id,
                        "permission_request",
                        json!({
                            "id": tool_call_id,
                            "tool": tool,
                            "kind": agent_permission_kind(&tool),
                            "target": agent_permission_target(&tool, &input),
                            "reason": "This tool request was denied by permission policy.",
                            "risk": risk,
                            "decision": "deny"
                        }),
                    );
                    let observation = json!({ "tool": tool, "ok": false, "error": "permission denied by policy" });
                    if use_tool_message {
                        ai_request.messages.push(IdeAiMessage::tool_result(
                            provider_tool_call_id,
                            agent_tool_result_message_content(&observation),
                        ));
                    }
                    observations.push(observation);
                    continue;
                }
                if decision == "ask" {
                    if tool == "apply_patch" {
                        if let Some(patch) = input
                            .get("patch")
                            .or_else(|| input.get("diff"))
                            .and_then(Value::as_str)
                        {
                            agent_emit(
                                app,
                                session_id,
                                "patch_preview",
                                json!({
                                    "id": tool_call_id,
                                    "patch": patch,
                                    "patchKind": if patch.contains("*** Begin Patch") { "codex" } else { "unified" },
                                    "summary": patch_preview_summary(patch),
                                    "diagnostics": [],
                                    "files": parse_paths_from_agent_patch(patch),
                                    "requiresApproval": true
                                }),
                            );
                        }
                    }
                    update_agent_session(app, session_id, |session| {
                        session["status"] = Value::String("waiting_permission".to_string());
                        session["pendingContinuation"] = json!({
                            "settings": settings.clone(),
                            "aiRequest": ai_request.clone(),
                            "step": step,
                            "lastAnswer": last_response.answer.clone(),
                            "profileId": profile_id,
                            "rootPath": root_path
                        });
                        if let Some(items) = session
                            .get_mut("pendingTools")
                            .and_then(Value::as_array_mut)
                        {
                            items.push(json!({ "id": tool_call_id, "tool": tool, "input": input, "providerToolCallId": provider_tool_call_id, "requestId": tool_request_id.clone(), "createdAt": agent_now() }));
                        } else {
                            session["pendingTools"] = json!([{ "id": tool_call_id, "tool": tool, "input": input, "providerToolCallId": provider_tool_call_id, "requestId": tool_request_id.clone(), "createdAt": agent_now() }]);
                        }
                    });
                    agent_emit_phase(
                        app,
                        session_id,
                        "waiting_permission",
                        "running",
                        "Waiting for user confirmation",
                        &agent_permission_target(&tool, &input),
                    );
                    agent_emit(
                        app,
                        session_id,
                        "permission_request",
                        json!({
                            "id": tool_call_id,
                            "tool": tool,
                            "requestId": tool_request_id.clone(),
                            "kind": agent_permission_kind(&tool),
                            "target": agent_permission_target(&tool, &input),
                            "reason": agent_permission_reason(&tool, &input),
                            "risk": risk,
                            "decision": "ask"
                        }),
                    );
                    return Ok(last_response);
                }

                agent_emit(
                    app,
                    session_id,
                    "tool_call_start",
                    json!({
                        "id": tool_call_id,
                        "name": tool,
                        "input": input,
                        "requestId": tool_request_id.clone(),
                        "status": "running"
                    }),
                );
                agent_emit_phase(
                    app,
                    session_id,
                    "tool",
                    "running",
                    "Running tool",
                    &format!("{tool}"),
                );
                let call = match run_pre_tool_hooks(
                    app,
                    session_id,
                    root_path,
                    Some(&settings),
                    &tool,
                    &input,
                ) {
                    Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
                    Ok(_) => match create_agent_checkpoint_for_tool(
                        app, session_id, root_path, &tool, &input,
                    ) {
                        Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
                        Ok(_) => match execute_agent_tool(
                            Some(app),
                            Some(session_id),
                            root_path,
                            &tool,
                            &input,
                        ) {
                            Ok(output) => {
                                agent_tool_call(&tool, input.clone(), output.clone(), None)
                            }
                            Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
                        },
                    },
                };
                let mut call = call;
                if let Some(obj) = call.as_object_mut() {
                    obj.insert("id".to_string(), Value::String(tool_call_id.clone()));
                    obj.insert(
                        "requestId".to_string(),
                        Value::String(tool_request_id.clone()),
                    );
                }
                agent_emit(app, session_id, "tool_call_result", call.clone());
                emit_post_tool_hook(app, session_id, root_path, Some(&settings), &tool, &call);
                emit_process_events_for_tool_call(app, session_id, &call);
                update_agent_session(app, session_id, |session| {
                    if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut)
                    {
                        items.push(call.clone());
                    }
                });
                if use_tool_message {
                    ai_request.messages.push(IdeAiMessage::tool_result(
                        provider_tool_call_id.clone(),
                        agent_tool_result_message_content(&call),
                    ));
                }
                if tool == "question" {
                    if !agent_tool_call_ok(&call) {
                        observations.push(json!({
                            "tool": tool,
                            "ok": false,
                            "error": agent_tool_call_error(&call),
                            "hint": "Call question only with a clear question or prompt for the user. Do not use target=question."
                        }));
                        continue;
                    }
                    update_agent_session(app, session_id, |session| {
                        session["status"] = Value::String("waiting_question".to_string());
                        session["pendingQuestion"] = json!({
                            "id": tool_call_id,
                            "input": input,
                            "output": call.get("output").cloned().unwrap_or_else(|| json!({})),
                            "createdAt": agent_now()
                        });
                        session["pendingContinuation"] = json!({
                            "settings": settings.clone(),
                            "aiRequest": ai_request.clone(),
                            "step": step,
                            "lastAnswer": last_response.answer.clone(),
                            "profileId": profile_id,
                            "rootPath": root_path
                        });
                    });
                    last_response.finish_reason = "waiting_question".to_string();
                    if last_response.answer.trim().is_empty() {
                        let question = call
                            .pointer("/output/question")
                            .and_then(Value::as_str)
                            .unwrap_or("Need more information to continue.");
                        last_response.answer = question.to_string();
                    }
                    return Ok(last_response);
                }
                if tool == "apply_patch" && !agent_tool_call_ok(&call) {
                    let error = agent_tool_call_error(&call);
                    if patch_error_is_format_issue(&error) && malformed_patch_repair_count < 3 {
                        malformed_patch_repair_count += 1;
                        force_write_after_bad_patch = true;
                        observations.push(json!({
                            "tool": tool,
                            "ok": false,
                            "error": error,
                            "hint": "Patch formatting failed after execution preflight. Do not call apply_patch again in this turn; use write with path/content."
                        }));
                        continue;
                    }
                    last_response.finish_reason = "paused_patch_failed".to_string();
                    if last_response.answer.trim().is_empty() {
                        last_response.answer =
                            format!("Patch apply failed; automatic retry stopped.\n\n{error}");
                    }
                    update_agent_session(app, session_id, |session| {
                        session["status"] = Value::String("paused_patch_failed".to_string());
                        session["pendingContinuation"] = Value::Null;
                        session["pendingTools"] = json!([]);
                    });
                    return Ok(last_response);
                }
                observations.push(json!({ "tool": tool, "result": call }));
            }
            if !use_chat_tool_messages {
                ai_request
                    .messages
                    .push(IdeAiMessage::new("assistant", last_response.answer.clone()));
                ai_request.messages.push(IdeAiMessage::new(
                    "user",
                    format!(
                        "[tool observations step {}]\n{}\n\nContinue from these observations. If another tool is needed, output tool JSON. Otherwise output the final answer.",
                        step + 1,
                        Value::Array(observations).to_string()
                    ),
                ));
            }
        }
        let current_compactions = {
            let state = app.state::<IdeRuntimeState>();
            let count = state
                .agent_sessions
                .lock()
                .unwrap()
                .get(session_id)
                .and_then(|session| session.get("compactionCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            count
        };
        agent_emit(
            app,
            session_id,
            "step_limit_reached",
            json!({
                "maxSteps": AGENT_LOOP_MAX_STEPS,
                "compactionCount": current_compactions,
                "autoContinue": current_compactions < 3
            }),
        );
        let compacted = compact_agent_session(app, session_id, "step_limit_reached")?;
        if current_compactions >= 3 {
            update_agent_session(app, session_id, |session| {
                session["status"] = Value::String("paused_step_limit".to_string());
                session["pendingContinuation"] = json!({
                    "settings": settings.clone(),
                    "aiRequest": ai_request.clone(),
                    "step": 0,
                    "lastAnswer": last_response.answer.clone(),
                    "profileId": profile_id,
                    "rootPath": root_path,
                    "compactedSummary": compacted.clone()
                });
            });
            last_response.finish_reason = "step_limit_reached".to_string();
            if last_response.answer.trim().is_empty() {
                last_response.answer = "Agent reached the step limit and compacted context. It is paused; continue to resume from the compacted summary.".to_string();
            }
            return Ok(last_response);
        }
        let system_prompt = agent_request_system_prompt(&ai_request).map(str::to_string);
        ai_request =
            IdeAiRequest {
                messages: compacted_agent_continuation_messages(
                    &compacted,
                    system_prompt.as_deref(),
                ),
                ..ai_request
            };
        step_base = 0;
    }
}

fn spawn_agent_continuation(
    app: AppHandle,
    session_id: String,
    continuation: Value,
    observation: Value,
) {
    tauri::async_runtime::spawn(async move {
        let request_id = agent_session_active_request_id(&app, &session_id);
        let settings = match continuation
            .get("settings")
            .cloned()
            .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok())
        {
            Some(settings) => settings,
            None => {
                let message = "pending continuation is missing provider settings";
                agent_emit(
                    &app,
                    &session_id,
                    "error",
                    json!({ "requestId": request_id.clone(), "message": message }),
                );
                finalize_agent_turn(
                    &app,
                    &session_id,
                    &request_id,
                    "failed",
                    "continuation_error",
                    message,
                    json!({ "ok": false, "error": message }),
                    true,
                );
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
                let message = "pending continuation is missing AI request";
                agent_emit(
                    &app,
                    &session_id,
                    "error",
                    json!({ "requestId": request_id.clone(), "message": message }),
                );
                finalize_agent_turn(
                    &app,
                    &session_id,
                    &request_id,
                    "failed",
                    "continuation_error",
                    message,
                    json!({ "ok": false, "error": message }),
                    true,
                );
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
        let step = continuation
            .get("step")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let provider = settings.provider_type.trim().to_ascii_lowercase();
        let use_tool_result_message = provider_uses_chat_tool_messages(&provider);
        if use_tool_result_message {
            if let Some(provider_tool_call_id) = observation
                .get("providerToolCallId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                ai_request.messages.push(IdeAiMessage::tool_result(
                    provider_tool_call_id,
                    agent_tool_result_message_content(&observation),
                ));
            } else {
                ai_request.messages.push(IdeAiMessage::new(
                    "user",
                    format!(
                        "[tool observations after user action]\n{}\n\nContinue from this result. Respect any denied scope, focusPaths, or allowGlobalScan values in the observation. If another tool is needed, output tool JSON. Otherwise output the final answer.",
                        observation
                    ),
                ));
            }
        } else {
            if let Some(last_answer) = continuation
                .get("lastAnswer")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                ai_request
                    .messages
                    .push(IdeAiMessage::new("assistant", last_answer));
            }
            ai_request.messages.push(IdeAiMessage::new(
                "user",
                format!(
                    "[tool observations after user action]\n{}\n\nContinue from this result. Respect any denied scope, focusPaths, or allowGlobalScan values in the observation. If another tool is needed, output tool JSON. Otherwise output the final answer.",
                    observation
                ),
            ));
        }
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
                agent_emit(
                    &app,
                    &session_id,
                    "error",
                    json!({ "message": err.clone() }),
                );
                let request_id = agent_session_active_request_id(&app, &session_id);
                finalize_agent_turn(
                    &app,
                    &session_id,
                    &request_id,
                    "failed",
                    "provider_error",
                    &err,
                    json!({ "ok": false, "error": err }),
                    true,
                );
                return;
            }
        };
        if response.usage != Value::Null {
            agent_emit(&app, &session_id, "usage", response.usage.clone());
        }
        let response_finish_reason = response.finish_reason.clone();
        let cancelled = response.finish_reason == "cancelled";
        let waiting_question = response.finish_reason == "waiting_question";
        let paused_step_limit = response.finish_reason == "step_limit_reached";
        let paused_patch_failed = response.finish_reason == "paused_patch_failed";
        let requires_approval = {
            let state = app.state::<IdeRuntimeState>();
            let sessions = state.agent_sessions.lock().unwrap();
            sessions
                .get(&session_id)
                .and_then(|session| session.get("pendingTools"))
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        };
        let session_status = if cancelled {
            "cancelled"
        } else if waiting_question {
            "waiting_question"
        } else if paused_patch_failed {
            "paused_patch_failed"
        } else if paused_step_limit {
            "paused_step_limit"
        } else if requires_approval {
            "waiting_permission"
        } else {
            "completed"
        };
        let request_id = agent_session_active_request_id(&app, &session_id);
        let result = json!({
            "ok": !cancelled && !paused_patch_failed && !paused_step_limit,
            "requestId": request_id.clone(),
            "message": if cancelled { "agent stopped gracefully" } else if waiting_question { "agent is waiting for user answer" } else if paused_patch_failed { "patch apply failed; agent paused" } else if paused_step_limit { "agent paused at step limit" } else { "agent continuation ready" },
            "response": response,
            "requiresApproval": requires_approval,
            "paused": paused_step_limit,
            "status": session_status,
            "finishReason": response_finish_reason
        });
        update_agent_session(&app, &session_id, |session| {
            if let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({
                    "role": "assistant",
                    "content": result.pointer("/response/answer").cloned().unwrap_or(Value::Null),
                    "at": agent_now()
                }));
            }
            let current = session.get("status").and_then(Value::as_str).unwrap_or("");
            if current != "cancelled"
                && !matches!(
                    session_status,
                    "completed" | "cancelled" | "paused_patch_failed"
                )
            {
                session["status"] = Value::String(session_status.to_string());
            }
        });
        if matches!(
            session_status,
            "completed" | "cancelled" | "paused_patch_failed"
        ) {
            let finish_reason = result
                .get("finishReason")
                .and_then(Value::as_str)
                .unwrap_or(session_status)
                .to_string();
            let result_message = result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent continuation finished.")
                .to_string();
            finalize_agent_turn(
                &app,
                &session_id,
                &request_id,
                session_status,
                &finish_reason,
                &result_message,
                result,
                true,
            );
        } else {
            agent_emit(&app, &session_id, "session_done", result);
        }
    });
}

async fn run_agent_send_task(
    app: AppHandle,
    session_id: String,
    request_id: String,
    settings: connector::IdeSettings,
    message: String,
    context_refs: Value,
) -> Result<Value, String> {
    agent_emit_phase(
        &app,
        &session_id,
        "received",
        "running",
        "Request received",
        "Agent started processing this message",
    );
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
    agent_emit(
        &app,
        &session_id,
        "message_part",
        json!({
            "role": "user",
            "content": message.clone(),
            "kind": "text"
        }),
    );
    agent_emit_phase(
        &app,
        &session_id,
        "planning",
        "running",
        "Planning",
        "Preparing message, history, and workspace focus",
    );
    if let Some((question, continuation, answer_effects)) = {
        let state = app.state::<IdeRuntimeState>();
        let mut sessions = state.agent_sessions.lock().unwrap();
        sessions.get_mut(&session_id).and_then(|session| {
            let question = session.get("pendingQuestion").cloned();
            let continuation = session.get("pendingContinuation").cloned();
            if question
                .as_ref()
                .map(pending_question_is_actionable)
                .unwrap_or(false)
                && continuation.as_ref().map(|value| !value.is_null()).unwrap_or(false)
            {
                let question_value = question.unwrap_or_else(|| json!({}));
                let continuation_value = continuation.clone().unwrap_or_else(|| json!({}));
                let continuation_profile = continuation_value
                    .get("profileId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if continuation_profile.eq_ignore_ascii_case("plan") {
                    record_planning_answer_on_session(session, &message);
                }
                let answer_effects =
                    apply_question_answer_session_effects(session, &root_path, &question_value, &message);
                session["pendingQuestion"] = Value::Null;
                session["pendingContinuation"] = Value::Null;
                session["status"] = Value::String("running".to_string());
                session["cancelRequested"] = Value::Bool(false);
                session["cancelRequestedAt"] = Value::Null;
                session["turnToolBudget"] = json!({});
                session["turnToolCache"] = json!({});
                if let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) {
                    messages.push(json!({ "role": "user", "content": message.clone(), "at": agent_now(), "kind": "question_answer" }));
                }
                Some((question_value, continuation_value, answer_effects))
            } else {
                if question.is_some() {
                    session["pendingQuestion"] = Value::Null;
                    session["pendingContinuation"] = Value::Null;
                    session["pendingTools"] = json!([]);
                    session["status"] = Value::String("running".to_string());
                }
                None
            }
        })
    } {
        let question_tool_id = question
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut question_result_call = agent_tool_call(
            "question",
            question.get("input").cloned().unwrap_or_else(|| json!({})),
            json!({
                "answer": message.clone(),
                "summary": "User answered the pending question; continuing the original task",
                "answered": true,
                "answerEffects": answer_effects.clone()
            }),
            None,
        );
        if !question_tool_id.is_empty() {
            if let Some(obj) = question_result_call.as_object_mut() {
                obj.insert("id".to_string(), Value::String(question_tool_id));
            }
        }
        agent_emit(&app, &session_id, "tool_call_result", question_result_call);
        spawn_agent_continuation(
            app.clone(),
            session_id.clone(),
            continuation,
            json!({
                "tool": "question",
                "answer": message,
                "question": question.pointer("/output/question").cloned().unwrap_or(Value::Null),
                "answerEffects": answer_effects
            }),
        );
        return Ok(
            json!({ "ok": true, "message": "question answer accepted; agent continuation started", "status": "running" }),
        );
    }
    update_agent_session(&app, &session_id, |session| {
        session["cancelRequested"] = Value::Bool(false);
        session["cancelRequestedAt"] = Value::Null;
        session["status"] = Value::String("running".to_string());
        session["pendingContinuation"] = Value::Null;
        session["pendingTools"] = json!([]);
        session["pendingQuestion"] = Value::Null;
    });
    if let Some(command) = extract_direct_agent_command(&root_path, &message) {
        let result = handle_direct_agent_command(
            &app,
            &session_id,
            &root_path,
            &profile_id,
            &settings,
            &command,
        )?;
        update_agent_session(&app, &session_id, |session| {
            if let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({ "role": "user", "content": message, "at": agent_now() }));
                if let Some(answer) = result.pointer("/response/answer").and_then(Value::as_str) {
                    messages
                        .push(json!({ "role": "assistant", "content": answer, "at": agent_now() }));
                }
            }
        });
        agent_emit(&app, &session_id, "session_done", result.clone());
        return Ok(result);
    }
    let mut inferred_focus = focus_paths_from_context_refs(&root_path, &context_refs);
    for path in infer_focus_paths_from_message(&root_path, &message) {
        if !inferred_focus.iter().any(|item| item == &path) {
            inferred_focus.push(path);
        }
    }
    let allow_global_scan = prompt_allows_global_scan_v2(&message);
    update_agent_session(&app, &session_id, |session| {
        if !inferred_focus.is_empty() {
            let mut next_focus = inferred_focus.clone();
            next_focus.truncate(8);
            session["focusPaths"] = json!(next_focus);
        } else {
            session["focusPaths"] = json!([]);
        }
        session["turnToolBudget"] = json!({});
        session["turnToolCache"] = json!({});
        session["turnAllowGlobalScan"] = Value::Bool(allow_global_scan);
    });
    if !inferred_focus.is_empty() {
        agent_emit(
            &app,
            &session_id,
            "tool_call_result",
            agent_tool_call(
                "workspace_context",
                json!({ "focusPaths": inferred_focus, "allowGlobalScan": allow_global_scan }),
                json!({ "summary": "workspace focus prepared" }),
                None,
            ),
        );
    }
    agent_emit_phase(
        &app,
        &session_id,
        "planning",
        "running",
        "Planning",
        "Preparing message, history, and workspace focus",
    );
    let todo_call_id = format!("tool-todowrite-{}", agent_now());
    agent_emit(
        &app,
        &session_id,
        "tool_call_start",
        json!({
            "id": todo_call_id,
            "name": "todowrite",
            "status": "running",
            "input": { "items": ["Understand request", "Collect project context", "Request model", "Prepare response"] }
        }),
    );
    let mut todo_call = agent_tool_call(
        "todowrite",
        json!({ "items": ["Understand request", "Collect project context", "Request model", "Prepare response"] }),
        json!({ "summary": "created initial agent todo" }),
        None,
    );
    if let Some(obj) = todo_call.as_object_mut() {
        obj.insert("id".to_string(), Value::String(todo_call_id));
    }
    agent_emit(&app, &session_id, "tool_call_result", todo_call);
    let request = json!({
        "messages": [{ "role": "user", "content": message.clone() }]
    });
    let effective_focus_paths = {
        let state = app.state::<IdeRuntimeState>();
        let sessions = state.agent_sessions.lock().unwrap();
        sessions
            .get(&session_id)
            .and_then(|session| session.get("focusPaths"))
            .cloned()
            .unwrap_or_else(|| json!([]))
    };
    let workspace_context = json!({
        "root": root_path,
        "contextRefs": context_refs,
        "history": history,
        "sessionSnapshot": session,
        "focusPaths": effective_focus_paths.clone()
    });
    agent_emit_phase(
        &app,
        &session_id,
        "context",
        "running",
        "Collecting context",
        "Reading memory, explicit references, and workspace focus",
    );
    let (ai_request, _, context_tool_calls) =
        match build_agent_ai_request(request, workspace_context) {
            Ok(result) => result,
            Err(err) => {
                agent_emit_phase(
                    &app,
                    &session_id,
                    "failed",
                    "error",
                    "Context collection failed",
                    &err,
                );
                agent_emit(&app, &session_id, "error", json!({ "message": err }));
                return Err(err);
            }
        };
    if !context_tool_calls.is_empty() {
        let names = context_tool_calls
            .iter()
            .filter_map(|call| call.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let mut context_call = agent_tool_call(
            "workspace_context",
            json!({ "sources": names, "focusPaths": effective_focus_paths }),
            json!({ "summary": "Workspace context collected; prefetched content is hidden from the main tool timeline.", "count": context_tool_calls.len() }),
            None,
        );
        if let Some(obj) = context_call.as_object_mut() {
            obj.insert(
                "id".to_string(),
                Value::String(format!("tool-workspace-context-{}", agent_now())),
            );
        }
        agent_emit(&app, &session_id, "tool_call_result", context_call.clone());
        update_agent_session(&app, &session_id, |session| {
            if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
                items.push(context_call.clone());
            }
            if let Some(memory_call) = context_tool_calls
                .iter()
                .find(|call| call.get("name").and_then(Value::as_str) == Some("memory_read"))
            {
                session["memoryRefs"] = memory_call
                    .pointer("/input/files")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
            }
        });
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
        let focus_paths = session_focus_paths(&app, &session_id);
        let preview = rewrite_patch_preview_value(&root_path, preview, &focus_paths);
        agent_emit(&app, &session_id, "patch_preview", preview.clone());
        agent_emit(
            &app,
            &session_id,
            "permission_request",
            json!({
                "id": preview.get("id").cloned().unwrap_or(Value::Null),
                "kind": "write",
                "target": "workspace patch",
                "reason": "AI returned an applicable patch. Approval is required before applying it.",
                "risk": "medium",
                "decision": permission_policy_for_tool(&profile_id, Some(&settings), "apply_patch")
            }),
        );
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
    let paused_step_limit = response.finish_reason == "step_limit_reached";
    let cancelled = response.finish_reason == "cancelled";
    let waiting_question = response.finish_reason == "waiting_question";
    let paused_patch_failed = response.finish_reason == "paused_patch_failed";
    if paused_step_limit {
        requires_approval = true;
    }
    let session_status = if cancelled {
        "cancelled"
    } else if waiting_question {
        "waiting_question"
    } else if paused_patch_failed {
        "paused_patch_failed"
    } else if paused_step_limit {
        "paused_step_limit"
    } else if requires_approval {
        "waiting_permission"
    } else {
        "completed"
    };
    let result = json!({
        "ok": !paused_step_limit && !cancelled && !paused_patch_failed,
        "requestId": request_id.clone(),
        "message": if cancelled { "agent stopped gracefully" } else if waiting_question { "agent is waiting for user answer" } else if paused_patch_failed { "patch apply failed; agent paused" } else if paused_step_limit { "agent paused at step limit" } else { "agent response ready" },
        "response": response,
        "toolCalls": [],
        "requiresApproval": requires_approval,
        "paused": paused_step_limit,
        "status": session_status
    });
    let (phase_name, phase_status, phase_label) = if cancelled {
        ("failed", "error", "Agent stopped")
    } else if paused_patch_failed {
        ("failed", "error", "Patch failed; paused")
    } else if waiting_question {
        ("waiting_question", "running", "Waiting for user answer")
    } else if requires_approval {
        (
            "waiting_permission",
            "running",
            "Waiting for user confirmation",
        )
    } else {
        ("finalizing", "done", "Response finalized")
    };
    agent_emit_phase(
        &app,
        &session_id,
        phase_name,
        phase_status,
        phase_label,
        result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Agent turn finished."),
    );
    if matches!(
        session_status,
        "completed" | "cancelled" | "paused_patch_failed"
    ) {
        update_agent_session(&app, &session_id, |active| {
            if let Some(messages) = active.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({ "role": "user", "content": message, "at": agent_now() }));
                messages.push(json!({ "role": "assistant", "content": result.pointer("/response/answer").cloned().unwrap_or(Value::Null), "at": agent_now() }));
            }
        });
        finalize_agent_turn(
            &app,
            &session_id,
            &request_id,
            session_status,
            result
                .get("finishReason")
                .and_then(Value::as_str)
                .unwrap_or(session_status),
            result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent turn finished."),
            result.clone(),
            true,
        );
    } else {
        let state = app.state::<IdeRuntimeState>();
        let mut sessions = state.agent_sessions.lock().unwrap();
        if let Some(active) = sessions.get_mut(&session_id) {
            if let Some(messages) = active.get_mut("messages").and_then(Value::as_array_mut) {
                messages.push(json!({ "role": "user", "content": message, "at": agent_now() }));
                messages.push(json!({ "role": "assistant", "content": result.pointer("/response/answer").cloned().unwrap_or(Value::Null), "at": agent_now() }));
            }
            let current = active.get("status").and_then(Value::as_str).unwrap_or("");
            // Do not resurrect a force-cancelled session when a late model turn finishes.
            if current != "cancelled" {
                active["status"] = Value::String(session_status.to_string());
            }
            active["activeRequestId"] = Value::String(String::new());
            active["lastRequestId"] = Value::String(request_id.clone());
            active["updatedAt"] = Value::String(agent_now());
            persist_agent_session_value(active);
        }
        agent_emit(&app, &session_id, "session_done", result.clone());
    }
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
    reset_agent_cancel_token(&app, &session_id);
    update_agent_session(&app, &session_id, |session| {
        session["activeRequestId"] = Value::String(request_id.clone());
        session["lastRequestId"] = Value::String(request_id.clone());
    });
    let task_request_id = request_id.clone();
    let app_task = app.clone();
    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_agent_send_task(
            app_task.clone(),
            task_session_id.clone(),
            task_request_id.clone(),
            settings,
            message,
            context_refs,
        )
        .await
        {
            agent_emit_phase(
                &app_task,
                &task_session_id,
                "failed",
                "error",
                "Agent execution failed",
                &err,
            );
            agent_emit(
                &app_task,
                &task_session_id,
                "error",
                json!({ "message": err.clone() }),
            );
            finalize_agent_turn(
                &app_task,
                &task_session_id,
                &task_request_id,
                "failed",
                "provider_error",
                &err,
                json!({ "ok": false, "error": err }),
                true,
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
pub fn ide_agent_message_inject(
    app: AppHandle,
    session_id: String,
    message: String,
    context_refs: Value,
) -> Result<Value, String> {
    let content = message.trim().to_string();
    if content.is_empty() {
        return Err("injected message is empty".to_string());
    }
    let now = agent_now();
    let injected_id = format!("agent-injected-{}", now);
    let record = json!({
        "id": injected_id,
        "role": "user",
        "content": content,
        "contextRefs": context_refs,
        "at": now,
        "kind": "injected_user_message"
    });
    {
        let state = app.state::<IdeRuntimeState>();
        let mut sessions = state.agent_sessions.lock().unwrap();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "agent session not found".to_string())?;
        let status = session.get("status").and_then(Value::as_str).unwrap_or("");
        let active_request_id = session
            .get("activeRequestId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let has_continuation = session
            .get("pendingContinuation")
            .map(|value| !value.is_null())
            .unwrap_or(false);
        if matches!(
            status,
            "idle" | "completed" | "cancelled" | "failed" | "finalizing"
        ) {
            return Err("agent is not accepting current-turn injections".to_string());
        }
        if active_request_id.trim().is_empty()
            && !has_continuation
            && !matches!(
                status,
                "running"
                    | "compacting"
                    | "waiting_permission"
                    | "waiting_question"
                    | "paused_step_limit"
                    | "paused_patch_failed"
            )
        {
            return Err("agent is not running; send a normal queued message instead".to_string());
        }
        if !session
            .get("pendingInjectedMessages")
            .and_then(Value::as_array)
            .is_some()
        {
            session["pendingInjectedMessages"] = json!([]);
        }
        if let Some(items) = session
            .get_mut("pendingInjectedMessages")
            .and_then(Value::as_array_mut)
        {
            items.push(record.clone());
        }
        if let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) {
            messages.push(json!({
                "role": "user",
                "content": message,
                "at": now,
                "kind": "injected_user_message"
            }));
        }
        session["updatedAt"] = Value::String(agent_now());
        persist_agent_session_value(session);
    }
    agent_emit(
        &app,
        &session_id,
        "agent_injected_message",
        json!({
            "id": injected_id,
            "status": "queued_for_current_turn"
        }),
    );
    Ok(json!({
        "ok": true,
        "injected": true,
        "sessionId": session_id,
        "id": injected_id
    }))
}

#[tauri::command]
pub fn ide_agent_approve(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    approval_id: String,
    granted: bool,
) -> Result<Value, String> {
    ide_agent_approve_with_decision(
        app,
        state,
        session_id,
        approval_id,
        granted,
        "once".to_string(),
    )
}

fn spawn_approved_agent_tool_execution(
    app: AppHandle,
    session_id: String,
    root_path: String,
    approval_id: String,
    approval_request_id: String,
    provider_tool_call_id: String,
    tool: String,
    input: Value,
    approval_settings: Option<connector::IdeSettings>,
    pending_continuation: Option<Value>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let mut call = match run_pre_tool_hooks(
            &app,
            &session_id,
            &root_path,
            approval_settings.as_ref(),
            &tool,
            &input,
        ) {
            Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
            Ok(_) => {
                match create_agent_checkpoint_for_tool(&app, &session_id, &root_path, &tool, &input)
                {
                    Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
                    Ok(_) => match execute_agent_tool(
                        Some(&app),
                        Some(&session_id),
                        &root_path,
                        &tool,
                        &input,
                    ) {
                        Ok(output) => agent_tool_call(&tool, input.clone(), output, None),
                        Err(err) => agent_tool_call(&tool, input.clone(), json!({}), Some(err)),
                    },
                }
            }
        };
        if let Some(obj) = call.as_object_mut() {
            obj.insert("id".to_string(), Value::String(approval_id.clone()));
            obj.insert(
                "requestId".to_string(),
                Value::String(approval_request_id.clone()),
            );
        }
        agent_emit(&app, &session_id, "tool_call_result", call.clone());
        emit_post_tool_hook(
            &app,
            &session_id,
            &root_path,
            approval_settings.as_ref(),
            &tool,
            &call,
        );
        emit_process_events_for_tool_call(&app, &session_id, &call);
        update_agent_session(&app, &session_id, |session| {
            session["approvedToolRunning"] = Value::Bool(false);
            if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
                items.push(call.clone());
            }
        });
        if agent_session_is_cancel_requested(&app, &session_id) {
            finalize_agent_turn(
                &app,
                &session_id,
                &approval_request_id,
                "cancelled",
                "cancelled",
                "Agent stopped after the approved tool returned; continuation was skipped.",
                json!({
                    "ok": false,
                    "fullyStopped": true
                }),
                true,
            );
            return;
        }
        let tool_ok = agent_tool_call_ok(&call);
        let tool_error = if tool_ok {
            None
        } else {
            Some(agent_tool_call_error(&call))
        };
        if tool == "apply_patch" && !tool_ok {
            let message = tool_error.clone().unwrap_or_else(|| {
                "Patch application failed. Regenerate the patch or use write.".to_string()
            });
            finalize_agent_turn(
                &app,
                &session_id,
                &approval_request_id,
                "paused_patch_failed",
                "paused_patch_failed",
                "Patch application failed; the agent is paused.",
                json!({
                    "ok": false,
                    "error": message,
                    "requiresApproval": false
                }),
                true,
            );
        } else if let Some(continuation) = pending_continuation.filter(|value| !value.is_null()) {
            spawn_agent_continuation(
                app.clone(),
                session_id.clone(),
                continuation,
                json!({ "tool": tool, "result": call, "providerToolCallId": provider_tool_call_id }),
            );
        } else {
            let status = if tool_ok { "completed" } else { "failed" };
            let message = if tool_ok {
                "Approved tool completed."
            } else {
                "Approved tool failed."
            };
            finalize_agent_turn(
                &app,
                &session_id,
                &approval_request_id,
                status,
                status,
                message,
                json!({
                    "ok": tool_ok,
                    "error": tool_error.unwrap_or_default(),
                    "requiresApproval": false
                }),
                true,
            );
        }
    });
}

fn ide_agent_approve_with_decision(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    approval_id: String,
    granted: bool,
    decision_scope: String,
) -> Result<Value, String> {
    let (root_path, pending_tool, pending_continuation, snapshot) = {
        let mut sessions = state.agent_sessions.lock().unwrap();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "agent session not found".to_string())?;
        let approval = json!({ "id": approval_id, "granted": granted, "scope": decision_scope, "at": agent_now() });
        if let Some(items) = session.get_mut("permissions").and_then(Value::as_array_mut) {
            items.push(approval);
        }
        let root_path = session
            .get("rootPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut pending_tool = None;
        if let Some(items) = session
            .get_mut("pendingTools")
            .and_then(Value::as_array_mut)
        {
            if let Some(index) = items.iter().position(|item| {
                item.get("id").and_then(Value::as_str) == Some(approval_id.as_str())
            }) {
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
        if let Some(tool) = pending_tool.as_ref() {
            let tool_name = tool.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let input = tool.get("input").cloned().unwrap_or_else(|| json!({}));
            if granted {
                remember_agent_permission_rule(
                    session,
                    tool_name,
                    &input,
                    &decision_scope,
                    "allow",
                );
            } else if matches!(decision_scope.as_str(), "remember" | "project") {
                remember_agent_permission_rule(session, tool_name, &input, &decision_scope, "deny");
            }
        }
        session["updatedAt"] = Value::String(agent_now());
        (
            root_path,
            pending_tool,
            pending_continuation,
            session.clone(),
        )
    };
    persist_agent_session_value(&snapshot);

    if !granted {
        let provider_tool_call_id = pending_tool
            .as_ref()
            .and_then(|tool| tool.get("providerToolCallId"))
            .and_then(Value::as_str)
            .unwrap_or(approval_id.as_str())
            .to_string();
        let original_request_id = pending_tool
            .as_ref()
            .and_then(|tool| tool.get("requestId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| agent_session_active_request_id(&app, &session_id));
        let approval_request_id = format!("agent-approval-{}", agent_now());
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
            "requestId": approval_request_id.clone(),
            "originalRequestId": original_request_id,
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
            update_agent_session(&app, &session_id, |session| {
                session["status"] = Value::String("running".to_string());
                session["activeRequestId"] = Value::String(approval_request_id.clone());
                session["lastRequestId"] = Value::String(approval_request_id.clone());
            });
            spawn_agent_continuation(
                app.clone(),
                session_id.clone(),
                continuation,
                json!({ "tool": tool_name, "result": call, "providerToolCallId": provider_tool_call_id }),
            );
        } else {
            finalize_agent_turn(
                &app,
                &session_id,
                &approval_request_id,
                "failed",
                "approval_denied",
                "User denied the requested Agent tool permission.",
                json!({
                    "ok": false,
                    "error": "user denied permission",
                    "requiresApproval": false
                }),
                true,
            );
        }
        return Ok(json!({ "id": approval_id, "granted": false, "executed": false, "ok": true }));
    }

    if let Some(pending) = pending_tool {
        let provider_tool_call_id = pending
            .get("providerToolCallId")
            .and_then(Value::as_str)
            .unwrap_or(approval_id.as_str())
            .to_string();
        let original_request_id = pending
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| agent_session_active_request_id(&app, &session_id));
        let approval_request_id = format!("agent-approval-{}", agent_now());
        let tool = pending
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let tool = normalize_agent_tool_name(&tool);
        let mut input = normalize_agent_tool_input(
            &tool,
            pending.get("input").cloned().unwrap_or_else(|| json!({})),
            &pending,
        );
        if tool == "bash" {
            sanitize_agent_bash_input(&mut input);
        }
        if let Err(err) = validate_agent_tool_input(&tool, &input) {
            let call = json!({
                "id": approval_id,
                "name": tool,
                "status": "error",
                "input": input,
                "requestId": approval_request_id.clone(),
                "originalRequestId": original_request_id.clone(),
                "output": {},
                "error": err,
                "startedAt": agent_now(),
                "finishedAt": agent_now()
            });
            agent_emit(&app, &session_id, "tool_call_result", call.clone());
            update_agent_session(&app, &session_id, |session| {
                if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut) {
                    items.push(call.clone());
                }
            });
            finalize_agent_turn(
                &app,
                &session_id,
                &approval_request_id,
                "failed",
                "tool_error",
                "Approved tool input was invalid.",
                json!({
                    "ok": false,
                    "error": call.get("error").cloned().unwrap_or(Value::Null),
                    "requiresApproval": false
                }),
                true,
            );
            return Ok(
                json!({ "id": approval_id, "granted": true, "executed": false, "ok": false, "error": call.get("error").cloned().unwrap_or(Value::Null), "result": call }),
            );
        }
        if tool == "apply_patch" {
            input =
                rewrite_apply_patch_input_paths(Some(&app), Some(&session_id), &root_path, &input);
        }
        let input = match guard_agent_tool_scope(
            Some(&app),
            Some(&session_id),
            &root_path,
            &tool,
            &input,
        ) {
            Ok(guarded) => guarded,
            Err(err) => {
                let call = json!({
                    "id": approval_id,
                    "name": tool,
                    "status": "error",
                    "input": input,
                    "requestId": approval_request_id.clone(),
                    "originalRequestId": original_request_id.clone(),
                    "output": {},
                    "error": err,
                    "startedAt": agent_now(),
                    "finishedAt": agent_now()
                });
                agent_emit(&app, &session_id, "tool_call_result", call.clone());
                update_agent_session(&app, &session_id, |session| {
                    if let Some(items) = session.get_mut("toolCalls").and_then(Value::as_array_mut)
                    {
                        items.push(call.clone());
                    }
                });
                finalize_agent_turn(
                    &app,
                    &session_id,
                    &approval_request_id,
                    "failed",
                    "tool_error",
                    "Approved tool scope validation failed.",
                    json!({
                        "ok": false,
                        "error": call.get("error").cloned().unwrap_or(Value::Null),
                        "requiresApproval": false
                    }),
                    true,
                );
                return Ok(
                    json!({ "id": approval_id, "granted": true, "executed": false, "ok": false, "error": call.get("error").cloned().unwrap_or(Value::Null), "result": call }),
                );
            }
        };
        update_agent_session(&app, &session_id, |session| {
            session["status"] = Value::String("running".to_string());
            session["approvedToolRunning"] = Value::Bool(true);
            session["activeRequestId"] = Value::String(approval_request_id.clone());
            session["lastRequestId"] = Value::String(approval_request_id.clone());
        });
        let approval_settings = pending_continuation
            .as_ref()
            .and_then(|value| value.get("settings"))
            .cloned()
            .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok());
        agent_emit(
            &app,
            &session_id,
            "tool_call_start",
            json!({
                "id": approval_id,
                "name": tool,
                "input": input,
                "requestId": approval_request_id.clone(),
                "originalRequestId": original_request_id,
                "status": "running"
            }),
        );
        agent_emit_phase(
            &app,
            &session_id,
            "tool",
            "running",
            "Running approved tool",
            &format!("{tool}"),
        );
        spawn_approved_agent_tool_execution(
            app.clone(),
            session_id.clone(),
            root_path,
            approval_id.clone(),
            approval_request_id.clone(),
            provider_tool_call_id,
            tool.clone(),
            input,
            approval_settings,
            pending_continuation.filter(|value| !value.is_null()),
        );
        return Ok(json!({
            "id": approval_id,
            "granted": true,
            "accepted": true,
            "executed": false,
            "running": true,
            "ok": true,
            "tool": tool,
            "requestId": approval_request_id
        }));
    }

    let approval_request_id = agent_session_active_request_id(&app, &session_id);
    finalize_agent_turn(
        &app,
        &session_id,
        &approval_request_id,
        "failed",
        "approval_missing",
        "Approval target was not found; stale approval state was cleared.",
        json!({
            "ok": false,
            "error": "approval target not found",
            "requiresApproval": false
        }),
        true,
    );
    Ok(json!({
        "id": approval_id,
        "granted": true,
        "executed": false,
        "ok": false,
        "error": "approval target not found",
        "requestId": approval_request_id
    }))
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
    let scope = decision
        .get("scope")
        .or_else(|| decision.get("decision"))
        .and_then(Value::as_str)
        .unwrap_or(if granted { "once" } else { "deny" })
        .to_string();
    ide_agent_approve_with_decision(app, state, session_id, tool_call_id, granted, scope)
}

#[tauri::command]
pub fn ide_agent_cancel(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    request_id: String,
) -> Result<Value, String> {
    let active_request_id = agent_session_active_request_id(&app, &request_id);
    request_agent_cancellation_token(&app, &request_id);
    let (snapshot, immediate, force) = {
        let mut sessions = state.agent_sessions.lock().unwrap();
        let session = sessions
            .get_mut(&request_id)
            .ok_or_else(|| "agent session not found".to_string())?;
        let status = session
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("idle")
            .to_string();
        let already_cancelling = status == "cancelling"
            || session
                .get("cancelRequested")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let force = already_cancelling;
        let approved_tool_running = session
            .get("approvedToolRunning")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let immediate = force
            || approved_tool_running
            || !matches!(status.as_str(), "running" | "compacting" | "cancelling");
        session["cancelRequested"] = Value::Bool(true);
        if !already_cancelling {
            session["cancelRequestedAt"] = Value::String(agent_now());
        }
        session["status"] =
            Value::String(if immediate { "cancelled" } else { "cancelling" }.to_string());
        if immediate {
            session["cancelRequested"] = Value::Bool(false);
            session["cancelRequestedAt"] = Value::Null;
            session["approvedToolRunning"] = Value::Bool(false);
            session["activeRequestId"] = Value::String(String::new());
            session["pendingContinuation"] = Value::Null;
            session["pendingTools"] = json!([]);
            session["pendingQuestion"] = Value::Null;
        }
        session["updatedAt"] = Value::String(agent_now());
        (session.clone(), immediate, force)
    };
    persist_agent_session_value(&snapshot);
    let killed_children = kill_registered_agent_children(&app, &request_id);
    let killed_processes = kill_agent_background_processes_for_session(&app, &request_id);
    let message = if force {
        "Agent 已完全停止；待处理任务已清理，运行中的子进程已终止。".to_string()
    } else if immediate {
        "Agent 已完全停止；运行中的子进程已终止。".to_string()
    } else {
        format!(
            "已请求停止：Provider 请求已中断，子进程已终止；最多等待 {} 秒让 Agent 循环确认取消。",
            AGENT_CANCEL_FORCE_AFTER_SECS
        )
    };
    let _ = &message;
    let message = if force {
        "Agent 已完全停止；待处理任务已清理，运行中的子进程已终止。".to_string()
    } else if immediate {
        "Agent 已完全停止；运行中的子进程已终止。".to_string()
    } else {
        format!(
            "已请求停止：Provider 请求已中断，子进程已终止；最多等待 {} 秒让 Agent 循环确认取消。",
            AGENT_CANCEL_FORCE_AFTER_SECS
        )
    };
    let _repaired_message = repair_cjk_mojibake(&message);
    let message = if force {
        "Agent 已完全停止；待处理任务已清理，运行中的子进程已终止。".to_string()
    } else if immediate {
        "Agent 已完全停止；运行中的子进程已终止。".to_string()
    } else {
        format!(
            "已请求停止：Provider 请求已中断，子进程已终止；最多等待 {} 秒让 Agent 循环确认取消。",
            AGENT_CANCEL_FORCE_AFTER_SECS
        )
    };
    agent_emit(
        &app,
        &request_id,
        "cancellation_requested",
        json!({
            "requestId": active_request_id.clone(),
            "status": if immediate { "cancelled" } else { "cancelling" },
            "finishReason": if immediate { "cancelled" } else { "cancelling" },
            "forced": force,
            "message": message,
            "fullyStopped": immediate,
            "killedChildren": killed_children,
            "killedProcesses": killed_processes
        }),
    );
    if immediate {
        finalize_agent_turn(
            &app,
            &request_id,
            &active_request_id,
            "cancelled",
            "cancelled",
            &message,
            json!({
                "ok": false,
                "forced": force,
                "fullyStopped": true
            }),
            true,
        );
    } else {
        // Soft cancel timeout: if the loop never reaches a cancel checkpoint, force-stop later.
        let app_timeout = app.clone();
        let session_timeout = request_id.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(AGENT_CANCEL_FORCE_AFTER_SECS)).await;
            if !agent_session_is_cancel_requested(&app_timeout, &session_timeout) {
                return;
            }
            let still_cancelling = {
                let state = app_timeout.state::<IdeRuntimeState>();
                let sessions = state.agent_sessions.lock().unwrap();
                sessions
                    .get(&session_timeout)
                    .and_then(|session| session.get("status"))
                    .and_then(Value::as_str)
                    .map(|status| matches!(status, "cancelling" | "running" | "compacting"))
                    .unwrap_or(false)
            };
            if still_cancelling {
                force_finalize_agent_cancellation(
                    &app_timeout,
                    &session_timeout,
                    &format!(
                        "Agent {} 秒内未确认取消；已强制完成停止并清理运行中的子进程。",
                        AGENT_CANCEL_FORCE_AFTER_SECS
                    ),
                );
            }
        });
    }
    Ok(json!({
        "ok": true,
        "sessionId": request_id,
        "status": if immediate { "cancelled" } else { "cancelling" },
        "graceful": !force,
        "forced": force,
        "message": message
    }))
}

#[tauri::command]
pub fn ide_agent_session_fork(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    label: Option<String>,
) -> Result<Value, String> {
    let mut sessions = state.agent_sessions.lock().unwrap();
    let source = sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "agent session not found".to_string())?;
    let new_id = format!(
        "agent-{}",
        state.next_agent_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let now = agent_now();
    let mut forked = source.clone();
    if let Some(obj) = forked.as_object_mut() {
        obj.insert("id".to_string(), Value::String(new_id.clone()));
        obj.insert("forkedFrom".to_string(), Value::String(session_id.clone()));
        obj.insert(
            "forkLabel".to_string(),
            Value::String(label.unwrap_or_else(|| "Forked session".to_string())),
        );
        obj.insert("status".to_string(), Value::String("idle".to_string()));
        obj.insert("stepCount".to_string(), json!(0));
        obj.insert("pendingContinuation".to_string(), Value::Null);
        obj.insert("pendingTools".to_string(), json!([]));
        obj.insert("patchPreviews".to_string(), json!([]));
        obj.insert("createdAt".to_string(), Value::String(now.clone()));
        obj.insert("updatedAt".to_string(), Value::String(now));
    }
    sessions.insert(new_id.clone(), forked.clone());
    drop(sessions);
    persist_agent_session_value(&forked);
    Ok(forked)
}

#[tauri::command]
pub fn ide_agent_sessions(
    state: State<'_, IdeRuntimeState>,
    root_path: Option<String>,
) -> Result<Vec<Value>, String> {
    if let Some(root) = root_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        connector::resolve_authorized_root(root)?;
    }
    let sessions = state.agent_sessions.lock().unwrap();
    Ok(sessions
        .values()
        .filter(|session| {
            root_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|root| {
                    session
                        .get("rootPath")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        == root
                })
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
pub fn ide_agent_session_delete(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<Value, String> {
    let removed = state
        .agent_sessions
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "agent session not found".to_string())?;
    let path = agent_session_snapshot_path(&session_id);
    if path.exists() {
        fs::remove_file(&path).map_err(|err| format!("failed to delete agent session: {err}"))?;
    }
    let checkpoint_dir = agent_checkpoint_storage_dir(&session_id);
    if checkpoint_dir.exists() {
        fs::remove_dir_all(&checkpoint_dir)
            .map_err(|err| format!("failed to delete agent checkpoints: {err}"))?;
    }
    Ok(json!({
        "ok": true,
        "sessionId": session_id,
        "deletedAt": agent_now(),
        "rootPath": removed.get("rootPath").cloned().unwrap_or(Value::Null)
    }))
}

#[tauri::command]
pub fn ide_agent_session_state(root_path: String) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    Ok(json!({
        "ok": true,
        "rootPath": shell_path(&root).to_string_lossy().to_string(),
        "capabilities": ["read_file", "write_with_approval", "run_terminal", "apply_patch_with_approval", "memory_update_auto"],
        "toolCalls": [],
        "permissions": []
    }))
}

fn smoke_check_item(
    id: &str,
    title: &str,
    ok: bool,
    detail: impl Into<String>,
    meta: Value,
) -> Value {
    json!({
        "id": id,
        "title": title,
        "ok": ok,
        "status": if ok { "ok" } else { "warn" },
        "detail": detail.into(),
        "meta": meta
    })
}

#[tauri::command]
pub fn ide_agent_smoke_check(
    state: State<'_, IdeRuntimeState>,
    root_path: Option<String>,
    preview_url: Option<String>,
) -> Result<Value, String> {
    let settings = connector::load_ide_settings();
    let root = root_path
        .clone()
        .or_else(|| {
            if settings.last_workspace_path.trim().is_empty() {
                None
            } else {
                Some(settings.last_workspace_path.clone())
            }
        })
        .unwrap_or_default();
    let mut checks = Vec::new();
    let root_ok = !root.trim().is_empty() && connector::resolve_authorized_root(&root).is_ok();
    checks.push(smoke_check_item(
        "workspace",
        "Workspace",
        root_ok,
        if root_ok {
            root.clone()
        } else {
            "No authorized workspace root is open.".to_string()
        },
        json!({ "rootPath": root }),
    ));

    let sessions_snapshot = {
        let sessions = state.agent_sessions.lock().unwrap();
        sessions.values().cloned().collect::<Vec<_>>()
    };
    let workspace_sessions = sessions_snapshot
        .iter()
        .filter(|session| {
            root_ok
                && session
                    .get("rootPath")
                    .and_then(Value::as_str)
                    .map(|value| value == root)
                    .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();
    let pending_count = workspace_sessions
        .iter()
        .filter_map(|session| session.get("pendingTools").and_then(Value::as_array))
        .map(Vec::len)
        .sum::<usize>();
    checks.push(smoke_check_item(
        "agent-session",
        "Agent Session",
        !workspace_sessions.is_empty(),
        if workspace_sessions.is_empty() {
            "No persisted Agent session for this workspace.".to_string()
        } else {
            format!(
                "{} sessions; {} pending approvals",
                workspace_sessions.len(),
                pending_count
            )
        },
        json!({ "sessions": workspace_sessions.len(), "pendingApprovals": pending_count }),
    ));

    let tool_registry = agent_tool_registry(
        if root_ok { Some(root.as_str()) } else { None },
        "build",
        &settings,
    );
    let tools = tool_registry
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tool_names = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let required_tools = [
        "read_file",
        "grep",
        "glob",
        "bash",
        "apply_patch",
        "memory_update",
        "process_manager",
        "browser_preview",
        "lsp",
    ];
    let missing_tools = required_tools
        .iter()
        .filter(|name| !tool_names.iter().any(|tool| tool == *name))
        .copied()
        .collect::<Vec<_>>();
    checks.push(smoke_check_item(
        "tool-registry",
        "Tool Registry",
        missing_tools.is_empty(),
        if missing_tools.is_empty() {
            format!("{} builtin tools ready", tools.len())
        } else {
            format!("Missing tools: {}", missing_tools.join(", "))
        },
        json!({ "toolCount": tools.len(), "missing": missing_tools }),
    ));

    let processes = agent_processes_value(&state, if root_ok { Some(root.as_str()) } else { None })
        .unwrap_or_else(|err| json!({ "ok": false, "error": err, "processes": [] }));
    let process_count = processes
        .get("processes")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    checks.push(smoke_check_item(
        "processes",
        "Agent Processes",
        true,
        format!("{process_count} managed processes"),
        processes,
    ));

    if root_ok {
        let (memory_context, memory_refs) = read_agent_memory_for_context(&root);
        checks.push(smoke_check_item(
            "memory",
            "Memory Files",
            true,
            if memory_refs.is_empty() {
                "No .autocode memory files found.".to_string()
            } else {
                format!("{} memory files loaded", memory_refs.len())
            },
            json!({ "files": memory_refs, "bytes": memory_context.len() }),
        ));
        let git = connector::read_workspace_git_status(&root).ok();
        checks.push(smoke_check_item(
            "git",
            "Git State",
            git.is_some(),
            git.as_ref().map(|value| value.summary.clone()).unwrap_or_else(|| "Git status unavailable.".to_string()),
            git.map(|value| json!({ "branch": value.branch, "staged": value.staged_count, "unstaged": value.unstaged_count, "untracked": value.untracked_count })).unwrap_or(Value::Null),
        ));
    }

    let preview = preview_url
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            if settings.preview_url.trim().is_empty() {
                None
            } else {
                Some(settings.preview_url.clone())
            }
        });
    if let Some(url) = preview {
        match browser_preview_value(&json!({ "url": url, "timeoutSecs": 3 })) {
            Ok(result) => checks.push(smoke_check_item(
                "browser-preview",
                "Browser Preview",
                result.get("ok").and_then(Value::as_bool).unwrap_or(false),
                format!(
                    "{} 璺?{}",
                    result.get("status").and_then(Value::as_u64).unwrap_or(0),
                    result
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("local preview")
                ),
                result,
            )),
            Err(error) => checks.push(smoke_check_item(
                "browser-preview",
                "Browser Preview",
                false,
                error,
                json!({ "url": url }),
            )),
        }
    } else {
        checks.push(smoke_check_item(
            "browser-preview",
            "Browser Preview",
            true,
            "No preview URL configured; skipped.",
            json!({ "skipped": true }),
        ));
    }

    let ok_count = checks
        .iter()
        .filter(|item| item.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();
    Ok(json!({
        "ok": ok_count == checks.len(),
        "rootPath": root,
        "checkedAt": agent_now(),
        "checks": checks,
        "summary": format!("{ok_count}/{} checks passed", checks.len())
    }))
}

fn agent_process_snapshot(
    id: &str,
    process: &AgentProcess,
    status: &str,
    exit_code: Option<i32>,
) -> Value {
    let last_output = process
        .last_output
        .lock()
        .unwrap()
        .chars()
        .rev()
        .take(12000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    json!({
        "id": id,
        "sessionId": process.session_id,
        "rootPath": process.root_path,
        "command": process.command,
        "cwd": process.cwd,
        "pid": process.child.id(),
        "status": status,
        "exitCode": exit_code,
        "startedAt": process.started_at,
        "lastOutput": last_output
    })
}

fn agent_processes_value(
    state: &IdeRuntimeState,
    root_path: Option<&str>,
) -> Result<Value, String> {
    if let Some(root) = root_path.filter(|value| !value.trim().is_empty()) {
        connector::resolve_authorized_root(root)?;
    }
    let mut processes = state.agent_processes.lock().unwrap();
    let mut finished = Vec::new();
    let mut items = Vec::new();
    for (id, process) in processes.iter_mut() {
        if let Some(root) = root_path.filter(|value| !value.trim().is_empty()) {
            if process.root_path != root {
                continue;
            }
        }
        match process.child.try_wait() {
            Ok(Some(status)) => {
                items.push(agent_process_snapshot(id, process, "exited", status.code()));
                finished.push(id.clone());
            }
            Ok(None) => items.push(agent_process_snapshot(id, process, "running", None)),
            Err(err) => items.push(json!({
                "id": id,
                "sessionId": process.session_id,
                "rootPath": process.root_path,
                "command": process.command,
                "cwd": process.cwd,
                "pid": process.child.id(),
                "status": "error",
                "error": err.to_string(),
                "startedAt": process.started_at,
                "lastOutput": process.last_output.lock().unwrap().clone()
            })),
        }
    }
    for id in finished {
        processes.remove(&id);
    }
    Ok(json!({ "ok": true, "processes": items }))
}

#[tauri::command]
pub fn ide_agent_processes(
    state: State<'_, IdeRuntimeState>,
    root_path: Option<String>,
) -> Result<Value, String> {
    agent_processes_value(&state, root_path.as_deref())
}

#[tauri::command]
pub fn ide_agent_process_kill(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    process_id: String,
) -> Result<Value, String> {
    kill_agent_process_value(&app, &state, process_id)
}

fn kill_agent_process_value(
    app: &AppHandle,
    state: &IdeRuntimeState,
    process_id: String,
) -> Result<Value, String> {
    let mut process = state
        .agent_processes
        .lock()
        .unwrap()
        .remove(&process_id)
        .ok_or_else(|| "agent process not found".to_string())?;
    let pid = process.child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
    let last_output = process.last_output.lock().unwrap().clone();
    let result = json!({
        "ok": true,
        "id": process_id,
        "pid": pid,
        "command": process.command,
        "cwd": process.cwd,
        "status": "killed",
        "lastOutput": last_output,
        "finishedAt": agent_now()
    });
    agent_emit(app, &process.session_id, "process_exit", result.clone());
    Ok(result)
}

#[tauri::command]
pub fn ide_agent_tools(
    root_path: Option<String>,
    profile_id: Option<String>,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    if let Some(root) = root_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        connector::resolve_authorized_root(root)?;
    }
    let profile = profile_id.unwrap_or_else(|| "build".to_string());
    Ok(agent_tool_registry(
        root_path.as_deref(),
        &profile,
        &settings,
    ))
}

#[tauri::command]
pub fn ide_agent_continue(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<Value, String> {
    let continuation = {
        let sessions = state.agent_sessions.lock().unwrap();
        sessions
            .get(&session_id)
            .and_then(|session| session.get("pendingContinuation"))
            .cloned()
            .filter(|value| !value.is_null())
            .ok_or_else(|| "agent session has no pending continuation".to_string())?
    };
    update_agent_session(&app, &session_id, |session| {
        session["status"] = Value::String("running".to_string());
    });
    spawn_agent_continuation(
        app,
        session_id.clone(),
        continuation,
        json!({
            "type": "user_continue",
            "message": "User requested to continue the paused Agent task."
        }),
    );
    Ok(json!({ "ok": true, "accepted": true, "sessionId": session_id }))
}

#[tauri::command]
pub fn ide_agent_compact_session(
    app: AppHandle,
    session_id: String,
    reason: String,
) -> Result<Value, String> {
    compact_agent_session(
        &app,
        &session_id,
        if reason.trim().is_empty() {
            "manual"
        } else {
            reason.trim()
        },
    )
}

#[tauri::command]
pub fn ide_agent_checkpoint_create(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    label: Option<String>,
    paths: Option<Vec<String>>,
) -> Result<Value, String> {
    let root_path = {
        let sessions = state.agent_sessions.lock().unwrap();
        sessions
            .get(&session_id)
            .and_then(|session| session.get("rootPath"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if root_path.trim().is_empty() {
        return Err("agent session root is missing".to_string());
    }
    connector::resolve_authorized_root(&root_path)?;
    let checkpoint_id = format!("checkpoint-{}", agent_now());
    let files = if let Some(paths) = paths {
        checkpoint_snapshot_for_paths(&root_path, paths)
    } else {
        checkpoint_snapshot_files(&root_path)
    };
    let checkpoint = json!({
        "id": checkpoint_id,
        "sessionId": session_id,
        "rootPath": root_path,
        "label": label.unwrap_or_else(|| "Agent checkpoint".to_string()),
        "files": files,
        "createdAt": agent_now()
    });
    let dir = agent_checkpoint_storage_dir(&session_id);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create checkpoint directory: {err}"))?;
    fs::write(
        dir.join(format!("{checkpoint_id}.json")),
        serde_json::to_vec_pretty(&checkpoint).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("failed to write checkpoint: {err}"))?;
    update_agent_session(&app, &session_id, |session| {
        if let Some(items) = session.get_mut("checkpoints").and_then(Value::as_array_mut) {
            items.push(checkpoint.clone());
        } else {
            session["checkpoints"] = json!([checkpoint.clone()]);
        }
    });
    agent_emit(&app, &session_id, "checkpoint_created", checkpoint.clone());
    Ok(checkpoint)
}

#[tauri::command]
pub fn ide_agent_checkpoint_revert(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    checkpoint_id: String,
) -> Result<Value, String> {
    let root_path = {
        let sessions = state.agent_sessions.lock().unwrap();
        sessions
            .get(&session_id)
            .and_then(|session| session.get("rootPath"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if root_path.trim().is_empty() {
        return Err("agent session root is missing".to_string());
    }
    connector::resolve_authorized_root(&root_path)?;
    let path = agent_checkpoint_storage_dir(&session_id).join(format!("{checkpoint_id}.json"));
    let text =
        fs::read_to_string(&path).map_err(|err| format!("failed to read checkpoint: {err}"))?;
    let checkpoint =
        serde_json::from_str::<Value>(&text).map_err(|err| format!("invalid checkpoint: {err}"))?;
    let files = checkpoint
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut restored = Vec::new();
    for file in files {
        let Some(path) = file.get("path").and_then(Value::as_str) else {
            continue;
        };
        if file.get("exists").and_then(Value::as_bool) == Some(false) {
            if connector::stat_workspace_file(&root_path, path).is_ok() {
                connector::delete_workspace_entry(&root_path, path, true)?;
            }
            restored.push(json!({ "path": path, "deleted": true }));
            continue;
        }
        let content = file.get("content").and_then(Value::as_str).unwrap_or("");
        let encoding = file
            .get("encoding")
            .and_then(Value::as_str)
            .map(str::to_string);
        let line_ending = file
            .get("lineEnding")
            .and_then(Value::as_str)
            .map(str::to_string);
        let saved =
            connector::save_workspace_file(&root_path, path, content, encoding, line_ending)?;
        restored.push(json!({ "path": saved.path, "size": saved.size }));
    }
    update_agent_session(&app, &session_id, |session| {
        session["status"] = Value::String("paused".to_string());
        if let Some(items) = session.get_mut("reverts").and_then(Value::as_array_mut) {
            items.push(
                json!({ "checkpointId": checkpoint_id, "restored": restored, "at": agent_now() }),
            );
        } else {
            session["reverts"] =
                json!([{ "checkpointId": checkpoint_id, "restored": restored, "at": agent_now() }]);
        }
    });
    let result = json!({ "ok": true, "checkpointId": checkpoint_id, "restored": restored });
    agent_emit(&app, &session_id, "checkpoint_reverted", result.clone());
    Ok(result)
}

#[tauri::command]
pub fn ide_agent_memory_read(app: AppHandle, root_path: String) -> Result<Value, String> {
    connector::resolve_authorized_root(&root_path)?;
    let mut files = Vec::new();
    for (path, kind) in [
        (".autocode/AGENTS.md", "project_rules"),
        (".autocode/memory.md", "memory"),
        (".autocode/settings.json", "settings"),
    ] {
        match connector::read_workspace_file(&root_path, path) {
            Ok(file) => files.push(json!({
                "path": file.path,
                "kind": kind,
                "exists": true,
                "content": file.content,
                "size": file.size,
                "updatedAt": file.modified_at
            })),
            Err(_) => files.push(json!({
                "path": path,
                "kind": kind,
                "exists": false
            })),
        }
    }
    let result = json!({ "ok": true, "rootPath": root_path, "files": files });
    agent_emit(&app, "", "memory_read", result.clone());
    Ok(result)
}

#[tauri::command]
pub fn ide_agent_memory_update(
    app: AppHandle,
    root_path: String,
    patch: String,
) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    if patch.trim().is_empty() {
        return Err("memory patch cannot be empty".to_string());
    }
    let files = validate_agent_memory_patch(&patch)?;
    let result = apply_agent_patch(&root.to_string_lossy(), &patch)?;
    let rollover = rollover_agent_memory_if_needed(&root.to_string_lossy())?;
    let rolled_over = rollover.is_some();
    let payload = json!({
        "id": format!("memory-{}", agent_now()),
        "ok": true,
        "rootPath": root.to_string_lossy(),
        "files": files,
        "kind": "memory",
        "requiresApproval": false,
        "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
        "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
        "rollover": rollover,
        "message": if rolled_over { "memory patch applied and archived" } else { "memory patch applied" }
    });
    agent_emit(&app, "", "memory_update_applied", payload.clone());
    Ok(payload)
}

fn plan_slug_from_title(title: &str, fallback: &str) -> String {
    let mut slug = title
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else if ch.is_ascii_whitespace() || matches!(ch, '-' | '_' | '.') {
                '-'
            } else {
                '\0'
            }
        })
        .filter(|ch| *ch != '\0')
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug.chars().take(48).collect()
    }
}

#[tauri::command]
pub fn ide_agent_plan_save(
    app: AppHandle,
    root_path: String,
    plan: Value,
) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    let title = plan
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("approved-plan");
    let plan_id = plan.get("id").and_then(Value::as_str).unwrap_or("plan");
    let content = plan.get("content").and_then(Value::as_str).unwrap_or("");
    if content.trim().is_empty() {
        return Err("plan content cannot be empty".to_string());
    }
    let todos = plan.get("todos").cloned().unwrap_or_else(|| json!([]));
    let answers = plan.get("answers").cloned().unwrap_or_else(|| json!([]));
    let created_at = plan
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or_else(|| "");
    let stamp = agent_now()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>();
    let hash = plan_slug_from_title(plan_id, "plan");
    let slug = plan_slug_from_title(title, &hash);
    let path = format!(".autocode/plans/{stamp}-{slug}.md");
    let absolute = root.join(&path);
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create plan directory: {err}"))?;
    }
    let payload = format!(
        "# {title}\n\n\
Plan ID: `{plan_id}`\n\
Status: `approved`\n\
Created At: `{created_at}`\n\
Saved At: `{}`\n\n\
## Confirmed Answers\n\n```json\n{}\n```\n\n\
## Todo\n\n```json\n{}\n```\n\n\
## Plan\n\n{}\n",
        agent_now(),
        serde_json::to_string_pretty(&answers).unwrap_or_else(|_| "[]".to_string()),
        serde_json::to_string_pretty(&todos).unwrap_or_else(|_| "[]".to_string()),
        content
    );
    let saved = connector::save_workspace_file(
        &root.to_string_lossy(),
        &path,
        &payload,
        Some("utf-8".to_string()),
        Some("lf".to_string()),
    )?;
    let result = json!({
        "ok": true,
        "path": saved.path,
        "size": saved.size,
        "planId": plan_id,
        "title": title,
        "savedAt": agent_now()
    });
    agent_emit(
        &app,
        "",
        "tool_call_result",
        agent_tool_call(
            "plan_save",
            json!({ "path": path, "planId": plan_id }),
            result.clone(),
            None,
        ),
    );
    Ok(result)
}

#[tauri::command]
pub fn ide_agent_memory_apply(
    app: AppHandle,
    root_path: String,
    patch: String,
    _approvals: Value,
) -> Result<Value, String> {
    let root = connector::resolve_authorized_root(&root_path)?;
    if patch.trim().is_empty() {
        return Err("memory patch cannot be empty".to_string());
    }
    let files = validate_agent_memory_patch(&patch)?;
    let result = apply_agent_patch(&root.to_string_lossy(), &patch)?;
    let rollover = rollover_agent_memory_if_needed(&root.to_string_lossy())?;
    let rolled_over = rollover.is_some();
    let payload = json!({
        "ok": true,
        "rootPath": root.to_string_lossy(),
        "files": files,
        "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
        "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
        "rollover": rollover,
        "message": if rolled_over { "memory patch applied and archived" } else { "memory patch applied" }
    });
    agent_emit(&app, "", "memory_update_applied", payload.clone());
    Ok(payload)
}

fn run_subagent_tool(
    app: &AppHandle,
    session_id: &str,
    subagent_id: &str,
    root_path: &str,
    tool: &str,
    input: Value,
) -> Value {
    let tool = normalize_agent_tool_name(tool);
    let input = normalize_agent_tool_input(&tool, input, &json!({ "tool": tool }));
    let call_id = format!("subagent-tool-{}-{}", tool, agent_now());
    agent_emit(
        app,
        session_id,
        "tool_call_start",
        json!({
            "id": call_id,
            "name": tool,
            "input": input.clone(),
            "status": "running",
            "subagent": true,
            "subagentId": subagent_id
        }),
    );
    match validate_agent_tool_input(&tool, &input)
        .and_then(|_| execute_agent_tool(Some(app), Some(session_id), root_path, &tool, &input))
    {
        Ok(output) => {
            let payload = json!({ "tool": tool, "input": input, "output": output, "ok": true });
            agent_emit(
                app,
                session_id,
                "tool_call_result",
                json!({
                    "id": call_id,
                    "name": tool,
                    "input": payload.get("input").cloned().unwrap_or_else(|| json!({})),
                    "output": payload.get("output").cloned().unwrap_or(Value::Null),
                    "status": "ok",
                    "subagent": true,
                    "subagentId": subagent_id
                }),
            );
            payload
        }
        Err(error) => {
            let payload = json!({ "tool": tool, "input": input, "error": error, "ok": false });
            agent_emit(
                app,
                session_id,
                "tool_call_result",
                json!({
                    "id": call_id,
                    "name": tool,
                    "input": payload.get("input").cloned().unwrap_or_else(|| json!({})),
                    "error": payload.get("error").cloned().unwrap_or(Value::String(String::new())),
                    "status": "error",
                    "subagent": true,
                    "subagentId": subagent_id
                }),
            );
            payload
        }
    }
}

fn run_subagent_evidence(
    app: &AppHandle,
    session_id: &str,
    subagent_id: &str,
    root_path: &str,
    profile_id: &str,
) -> Vec<Value> {
    let profile = profile_id.to_ascii_lowercase();
    let mut evidence = Vec::new();
    evidence.push(run_subagent_tool(
        app,
        session_id,
        subagent_id,
        root_path,
        "git_diff",
        json!({}),
    ));
    if matches!(profile.as_str(), "explore" | "build" | "plan") {
        evidence.push(run_subagent_tool(
            app,
            session_id,
            subagent_id,
            root_path,
            "glob",
            json!({ "path": "", "maxDepth": 2 }),
        ));
        for path in [
            "README.md",
            "package.json",
            "Cargo.toml",
            "pyproject.toml",
            "vite.config.ts",
            "tsconfig.json",
        ] {
            if connector::stat_workspace_file(root_path, path)
                .map(|stat| stat.exists && stat.kind == "file")
                .unwrap_or(false)
            {
                evidence.push(run_subagent_tool(
                    app,
                    session_id,
                    subagent_id,
                    root_path,
                    "read_file",
                    json!({ "path": path }),
                ));
            }
        }
    }
    if matches!(profile.as_str(), "review" | "build" | "refactor") {
        evidence.push(run_subagent_tool(
            app,
            session_id,
            subagent_id,
            root_path,
            "grep",
            json!({ "query": "TODO", "limit": 40 }),
        ));
    }
    if matches!(profile.as_str(), "debug" | "build") {
        evidence.push(run_subagent_tool(
            app,
            session_id,
            subagent_id,
            root_path,
            "diagnostics",
            json!({ "timeoutSecs": 120 }),
        ));
        evidence.push(run_subagent_tool(
            app,
            session_id,
            subagent_id,
            root_path,
            "process_manager",
            json!({ "action": "list" }),
        ));
    }
    if matches!(profile.as_str(), "test" | "build") {
        evidence.push(run_subagent_tool(
            app,
            session_id,
            subagent_id,
            root_path,
            "test_runner",
            json!({ "timeoutSecs": 120 }),
        ));
    }
    if matches!(profile.as_str(), "docs") {
        evidence.push(run_subagent_tool(
            app,
            session_id,
            subagent_id,
            root_path,
            "grep",
            json!({ "query": "README", "limit": 40 }),
        ));
    }
    evidence
}

#[tauri::command]
pub fn ide_agent_subagent_run(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    session_id: String,
    profile_id: String,
    task: String,
    context_refs: Value,
) -> Result<Value, String> {
    let root_path = {
        let sessions = state.agent_sessions.lock().unwrap();
        sessions
            .get(&session_id)
            .and_then(|session| session.get("rootPath"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if root_path.trim().is_empty() {
        return Err("agent session root is missing".to_string());
    }
    connector::resolve_authorized_root(&root_path)?;
    let subagent_id = format!("subagent-{}-{}", profile_id.to_lowercase(), agent_now());
    agent_emit(
        &app,
        &session_id,
        "subagent_start",
        json!({
            "id": subagent_id,
            "profileId": profile_id,
            "task": task,
            "contextRefs": context_refs
        }),
    );
    let (memory, memory_refs) = read_agent_memory_for_context(&root_path);
    let evidence = run_subagent_evidence(&app, &session_id, &subagent_id, &root_path, &profile_id);
    let git_branch = evidence
        .iter()
        .find(|item| item.get("tool").and_then(Value::as_str) == Some("git_diff"))
        .and_then(|item| item.get("output"))
        .and_then(|output| output.get("branch"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let evidence_summary = evidence
        .iter()
        .map(|item| {
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            if let Some(error) = item.get("error").and_then(Value::as_str) {
                format!("{tool}: error {error}")
            } else {
                let output = item.get("output").cloned().unwrap_or(Value::Null);
                let count = output
                    .get("count")
                    .or_else(|| output.get("staged"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                format!("{tool}: ok {count}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let summary = format!(
        "{} subagent completed read-only exploration.\n\nTask: {}\nMemory refs: {}\nGit branch: {}\nEvidence: {}",
        profile_id,
        task,
        memory_refs.len(),
        git_branch,
        evidence_summary
    );
    let result = json!({
        "id": subagent_id,
        "profileId": profile_id,
        "task": task,
        "summary": summary,
        "evidence": {
            "memory": memory.chars().take(6000).collect::<String>(),
            "tools": evidence
        },
        "finishedAt": agent_now()
    });
    update_agent_session(&app, &session_id, |session| {
        if let Some(items) = session.get_mut("subagents").and_then(Value::as_array_mut) {
            items.push(result.clone());
        } else {
            session["subagents"] = json!([result.clone()]);
        }
    });
    agent_emit(&app, &session_id, "subagent_result", result.clone());
    Ok(result)
}

#[tauri::command]
pub fn ide_hook_run(event: String, payload: Value) -> Result<Value, String> {
    let root_path = payload
        .get("rootPath")
        .or_else(|| payload.get("root_path"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if root_path.trim().is_empty() {
        return Ok(json!({
            "ok": true,
            "event": event,
            "payload": payload,
            "handled": false,
            "message": "rootPath was not provided; hook evaluation skipped."
        }));
    }
    connector::resolve_authorized_root(&root_path)?;
    let settings = payload
        .get("settings")
        .cloned()
        .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok())
        .unwrap_or_else(connector::load_ide_settings);
    let hooks = merged_hooks(&root_path, Some(&settings));
    if event.eq_ignore_ascii_case("PreToolUse") {
        let tool = payload.get("tool").and_then(Value::as_str).unwrap_or("");
        let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
        let blocked = evaluate_pre_tool_hook_block(&hooks, tool, &input);
        let commands = if blocked.is_none() {
            run_hook_commands(&root_path, "PreToolUse", tool, &hooks)
        } else {
            Vec::new()
        };
        let command_blocked = commands.iter().find(|item| {
            item.get("blockOnFailure")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && item.get("ok").and_then(Value::as_bool) != Some(true)
        });
        return Ok(json!({
            "ok": true,
            "event": event,
            "handled": true,
            "rootPath": root_path,
            "tool": tool,
            "blocked": blocked.is_some() || command_blocked.is_some(),
            "reason": blocked.or_else(|| command_blocked.and_then(|item| item.get("reason").or_else(|| item.get("error")).and_then(Value::as_str).map(str::to_string))),
            "commands": commands,
            "count": hooks.len()
        }));
    }
    if event.eq_ignore_ascii_case("PostToolUse") {
        let tool = payload.get("tool").and_then(Value::as_str).unwrap_or("");
        let commands = run_hook_commands(&root_path, "PostToolUse", tool, &hooks);
        return Ok(json!({
            "ok": true,
            "event": event,
            "handled": !hooks.is_empty(),
            "rootPath": root_path,
            "tool": tool,
            "commands": commands,
            "count": hooks.len()
        }));
    }
    Ok(json!({
        "ok": true,
        "event": event,
        "payload": payload,
        "handled": !hooks.is_empty(),
        "count": hooks.len(),
        "message": "Hook registry loaded; this event has no local executor yet."
    }))
}

#[tauri::command]
pub fn ide_mcp_servers(root_path: String) -> Result<Value, String> {
    connector::resolve_authorized_root(&root_path)?;
    let servers = merged_mcp_servers(&root_path)
        .into_iter()
        .enumerate()
        .filter(|(_, server)| mcp_server_enabled(server))
        .map(|(index, server)| {
            json!({
                "id": format!("mcp:{}:{index}", mcp_server_name(&server, index)),
                "name": mcp_server_name(&server, index),
                "server": server,
                "implemented": true,
                "callTool": "mcp_call",
                "permission": "ask"
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "rootPath": root_path,
        "servers": servers
    }))
}

#[tauri::command]
pub fn ide_lsp_request(root_path: String, method: String, params: Value) -> Result<Value, String> {
    connector::resolve_authorized_root(&root_path)?;
    lsp_request_value(&root_path, &method, params)
}

fn lsp_relative_path(root_path: &str, params: &Value) -> Option<String> {
    let raw = params
        .get("path")
        .or_else(|| params.pointer("/textDocument/path"))
        .or_else(|| params.pointer("/textDocument/uri"))
        .or_else(|| params.get("uri"))
        .and_then(Value::as_str)?;
    let mut path = raw.trim().trim_start_matches("file://").replace('\\', "/");
    let root = root_path.replace('\\', "/");
    if path
        .to_ascii_lowercase()
        .starts_with(&root.to_ascii_lowercase())
    {
        path = path[root.len()..].trim_start_matches('/').to_string();
    }
    Some(path)
}

fn lsp_line_character(params: &Value) -> (usize, usize) {
    let line = params
        .pointer("/position/line")
        .or_else(|| params.get("line"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let character = params
        .pointer("/position/character")
        .or_else(|| params.get("character"))
        .or_else(|| params.get("column"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    (line, character)
}

fn lsp_word_at(line: &str, character: usize) -> String {
    let chars = line.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return String::new();
    }
    let mut index = character.min(chars.len().saturating_sub(1));
    if !is_symbol_char(chars[index]) && index > 0 {
        index -= 1;
    }
    let mut start = index;
    while start > 0 && is_symbol_char(chars[start - 1]) {
        start -= 1;
    }
    let mut end = index;
    while end < chars.len() && is_symbol_char(chars[end]) {
        end += 1;
    }
    chars[start..end].iter().collect::<String>()
}

fn is_symbol_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || value == '_' || value == '$'
}

fn lsp_symbol_from_params(root_path: &str, params: &Value) -> Result<String, String> {
    if let Some(symbol) = params
        .get("symbol")
        .or_else(|| params.get("name"))
        .or_else(|| params.get("query"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(symbol.trim().to_string());
    }
    let path = lsp_relative_path(root_path, params)
        .ok_or_else(|| "LSP request requires symbol/query or textDocument path".to_string())?;
    let file = connector::read_workspace_file(root_path, &path)?;
    let (line, character) = lsp_line_character(params);
    let text_line = file.content.lines().nth(line).unwrap_or("");
    let symbol = lsp_word_at(text_line, character);
    if symbol.trim().is_empty() {
        Err("could not infer symbol at position".to_string())
    } else {
        Ok(symbol)
    }
}

fn lsp_definition_candidates(
    root_path: &str,
    symbol: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let results =
        connector::search_workspace(root_path, symbol, true, limit.saturating_mul(4).max(20))?;
    let mut ranked = results
        .into_iter()
        .map(|item| {
            let preview = item.preview.trim().to_string();
            let lower = preview.to_ascii_lowercase();
            let score = if lower.contains(&format!("function {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("class {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("interface {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("type {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("const {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("let {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("fn {}", symbol.to_ascii_lowercase()))
                || lower.contains(&format!("struct {}", symbol.to_ascii_lowercase()))
            {
                0
            } else {
                1
            };
            (score, item)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.path.cmp(&right.1.path))
            .then(left.1.line.cmp(&right.1.line))
    });
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|(_, item)| {
            json!({
                "path": item.path,
                "line": item.line,
                "character": item.preview.find(symbol).unwrap_or(0),
                "preview": item.preview,
                "kind": "definitionCandidate"
            })
        })
        .collect())
}

fn lsp_reference_candidates(
    root_path: &str,
    symbol: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    Ok(connector::search_workspace(root_path, symbol, true, limit)?
        .into_iter()
        .map(|item| {
            json!({
                "path": item.path,
                "line": item.line,
                "character": item.preview.find(symbol).unwrap_or(0),
                "preview": item.preview,
                "kind": "reference"
            })
        })
        .collect())
}

fn replace_symbol_boundaries(text: &str, symbol: &str, replacement: &str) -> String {
    if symbol.is_empty() || symbol == replacement {
        return text.to_string();
    }
    let chars = text.chars().collect::<Vec<_>>();
    let symbol_chars = symbol.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        let matches = index + symbol_chars.len() <= chars.len()
            && chars[index..index + symbol_chars.len()] == symbol_chars[..]
            && (index == 0 || !is_symbol_char(chars[index - 1]))
            && (index + symbol_chars.len() >= chars.len()
                || !is_symbol_char(chars[index + symbol_chars.len()]));
        if matches {
            output.push_str(replacement);
            index += symbol_chars.len();
        } else {
            output.push(chars[index]);
            index += 1;
        }
    }
    output
}

fn append_full_file_unified_diff(patch: &mut String, path: &str, before: &str, after: &str) {
    let before_lines = before.lines().collect::<Vec<_>>();
    let after_lines = after.lines().collect::<Vec<_>>();
    patch.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
    patch.push_str(&format!(
        "@@ -1,{} +1,{} @@\n",
        before_lines.len().max(1),
        after_lines.len().max(1)
    ));
    for line in before_lines {
        patch.push('-');
        patch.push_str(line);
        patch.push('\n');
    }
    for line in after_lines {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
}

fn lsp_rename_patch(
    root_path: &str,
    symbol: &str,
    new_name: &str,
    refs: &[Value],
) -> Result<Value, String> {
    if new_name.trim().is_empty() {
        return Ok(
            json!({ "patch": "", "files": [], "message": "newName is required to generate a rename patch" }),
        );
    }
    let mut paths = Vec::<String>::new();
    for item in refs {
        let Some(path) = item.get("path").and_then(Value::as_str) else {
            continue;
        };
        if !paths.iter().any(|value| value == path) {
            paths.push(path.to_string());
        }
    }
    let mut patch = String::new();
    let mut changed_files = Vec::new();
    for path in paths.into_iter().take(40) {
        let file = connector::read_workspace_file(root_path, &path)?;
        if file.size > 1024 * 1024 {
            continue;
        }
        let after = replace_symbol_boundaries(&file.content, symbol, new_name);
        if after == file.content {
            continue;
        }
        append_full_file_unified_diff(&mut patch, &path, &file.content, &after);
        changed_files.push(json!({ "path": path, "operation": "update", "risk": "medium" }));
    }
    Ok(json!({
        "patch": patch,
        "files": changed_files,
        "message": "Rename patch preview generated; apply through patch approval."
    }))
}

fn lsp_hover_value(root_path: &str, params: &Value, symbol: &str) -> Result<Value, String> {
    let path = lsp_relative_path(root_path, params).unwrap_or_default();
    let current_line = if path.is_empty() {
        String::new()
    } else {
        let file = connector::read_workspace_file(root_path, &path)?;
        let (line, _) = lsp_line_character(params);
        file.content
            .lines()
            .nth(line)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let definitions = lsp_definition_candidates(root_path, symbol, 3)?;
    Ok(json!({
        "symbol": symbol,
        "path": path,
        "contents": current_line,
        "definitions": definitions,
        "adapter": "lightweight"
    }))
}

fn lsp_request_value(root_path: &str, method: &str, params: Value) -> Result<Value, String> {
    let result = match method {
        "diagnostics" | "textDocument/diagnostic" => {
            let output = run_detected_workspace_command(
                root_path,
                "diagnostics",
                detect_diagnostics_command(root_path),
                params
                    .get("timeoutSecs")
                    .or_else(|| params.get("timeout"))
                    .and_then(Value::as_u64)
                    .unwrap_or(180),
            )?;
            json!({
                "diagnostics": [],
                "commandResult": output,
                "adapter": "lightweight",
                "message": "Lightweight diagnostics adapter used project diagnostic command; full LSP server attach is pending."
            })
        }
        "workspace/symbol" | "symbols" | "symbol_search" => json!({
            "symbols": params
                .get("query")
                .and_then(Value::as_str)
                .map(|query| connector::search_workspace(root_path, query, true, params.get("limit").and_then(Value::as_u64).unwrap_or(80) as usize))
                .transpose()?
                .unwrap_or_default(),
            "query": params.get("query").cloned().unwrap_or(Value::Null),
            "adapter": "lightweight",
            "message": "Lightweight symbol search used workspace search; full LSP server attach is pending."
        }),
        "definition" | "textDocument/definition" => {
            let symbol = lsp_symbol_from_params(root_path, &params)?;
            json!({
                "symbol": symbol,
                "locations": lsp_definition_candidates(root_path, &symbol, params.get("limit").and_then(Value::as_u64).unwrap_or(12) as usize)?,
                "adapter": "lightweight"
            })
        }
        "references" | "textDocument/references" => {
            let symbol = lsp_symbol_from_params(root_path, &params)?;
            json!({
                "symbol": symbol,
                "locations": lsp_reference_candidates(root_path, &symbol, params.get("limit").and_then(Value::as_u64).unwrap_or(80) as usize)?,
                "adapter": "lightweight"
            })
        }
        "hover" | "textDocument/hover" => {
            let symbol = lsp_symbol_from_params(root_path, &params)?;
            lsp_hover_value(root_path, &params, &symbol)?
        }
        "rename" | "textDocument/prepareRename" | "textDocument/rename" => {
            let symbol = lsp_symbol_from_params(root_path, &params)?;
            let new_name = params
                .get("newName")
                .or_else(|| params.get("new_name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let refs = lsp_reference_candidates(
                root_path,
                &symbol,
                params.get("limit").and_then(Value::as_u64).unwrap_or(120) as usize,
            )?;
            let rename = lsp_rename_patch(root_path, &symbol, new_name, &refs)?;
            json!({
                "symbol": symbol,
                "newName": new_name,
                "editsPreview": refs,
                "patch": rename.get("patch").cloned().unwrap_or(Value::String(String::new())),
                "files": rename.get("files").cloned().unwrap_or_else(|| json!([])),
                "requiresApproval": true,
                "adapter": "lightweight",
                "message": "Rename preview only; applying edits must go through patch approval."
            })
        }
        other => json!({
            "result": Value::Null,
            "message": format!("LSP method {other} is not implemented by the local adapter yet.")
        }),
    };
    Ok(json!({ "ok": true, "rootPath": root_path, "method": method, "result": result }))
}

#[tauri::command]
pub fn ide_local_server_status(state: State<'_, IdeRuntimeState>) -> Result<Value, String> {
    let port = *state.local_server_port.lock().unwrap();
    let latest_event_id = state
        .next_agent_event_id
        .load(Ordering::SeqCst)
        .saturating_sub(1);
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
    reader
        .read_line(&mut first)
        .map_err(|err| err.to_string())?;
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
        if let Some(value) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|err| err.to_string())?;
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
        ("GET", "/health") => write_json_response(
            &mut stream,
            200,
            json!({
                "ok": true,
                "name": "AutoCode Local IDE Server",
                "version": connector::VERSION,
                "capabilities": ["project", "agents", "sessions", "events", "messages", "permissions", "files", "diff", "patch", "memory", "tools", "hooks", "processes", "preview", "smoke", "mcp", "lsp"]
            }),
        ),
        ("GET", "/smoke") => {
            let root_path =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"));
            let preview_url =
                query_param(query, "previewUrl").or_else(|| query_param(query, "preview_url"));
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_smoke_check(state, root_path, preview_url)?;
            write_json_response(&mut stream, 200, result)
        }
        ("GET", "/agents") | ("GET", "/profiles") => {
            let settings = connector::load_ide_settings();
            write_json_response(&mut stream, 200, agent_profile_registry(&settings))
        }
        ("GET", "/tools") => {
            let root_path =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"));
            let profile_id =
                query_param(query, "profileId").or_else(|| query_param(query, "profile_id"));
            let settings = connector::load_ide_settings();
            let result = ide_agent_tools(root_path, profile_id, settings)?;
            write_json_response(&mut stream, 200, result)
        }
        ("GET", "/project") => {
            let settings = connector::load_ide_settings();
            write_json_response(
                &mut stream,
                200,
                json!({
                    "ok": true,
                    "currentProject": settings.last_workspace_path,
                    "recentProjects": settings.recent_projects,
                    "defaultWorkspacePath": settings.default_workspace_path,
                    "previewUrl": settings.preview_url
                }),
            )
        }
        ("GET", "/files") => {
            let Some(root_path) =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"))
            else {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "rootPath is required" }),
                );
            };
            let path = query_param(query, "path").unwrap_or_default();
            if path.trim().is_empty() {
                let entries = connector::list_workspace_tree(&root_path, "", 1)?;
                return write_json_response(
                    &mut stream,
                    200,
                    json!({ "ok": true, "rootPath": root_path, "path": "", "kind": "dir", "entries": entries }),
                );
            }
            let stat = connector::stat_workspace_file(&root_path, &path)?;
            if stat.kind == "dir" {
                let entries = connector::list_workspace_tree(&root_path, &path, 1)?;
                write_json_response(
                    &mut stream,
                    200,
                    json!({ "ok": true, "rootPath": root_path, "path": path, "kind": "dir", "stat": stat, "entries": entries }),
                )
            } else {
                let file = connector::read_workspace_file(&root_path, &path)?;
                write_json_response(
                    &mut stream,
                    200,
                    json!({ "ok": true, "rootPath": root_path, "path": path, "kind": "file", "stat": stat, "file": file }),
                )
            }
        }
        ("GET", "/diff") => {
            let Some(root_path) =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"))
            else {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "rootPath is required" }),
                );
            };
            let diff = connector::read_workspace_git_status(&root_path)?;
            write_json_response(
                &mut stream,
                200,
                json!({ "ok": true, "rootPath": root_path, "git": diff }),
            )
        }
        ("GET", "/hooks") => {
            let Some(root_path) =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"))
            else {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "rootPath is required" }),
                );
            };
            connector::resolve_authorized_root(&root_path)?;
            let settings = connector::load_ide_settings();
            let hooks = merged_hooks(&root_path, Some(&settings));
            write_json_response(
                &mut stream,
                200,
                json!({ "ok": true, "rootPath": root_path, "hooks": hooks }),
            )
        }
        ("POST", "/hooks/run") => {
            let event_name = body_value
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or("PreToolUse")
                .to_string();
            let result = ide_hook_run(event_name, body_value.clone())?;
            write_json_response(&mut stream, 200, result)
        }
        ("GET", "/permissions") => {
            let Some(session_id) =
                query_param(query, "sessionId").or_else(|| query_param(query, "session_id"))
            else {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "sessionId is required" }),
                );
            };
            let state = app.state::<IdeRuntimeState>();
            let session = state
                .agent_sessions
                .lock()
                .unwrap()
                .get(&session_id)
                .cloned()
                .unwrap_or(Value::Null);
            if session == Value::Null {
                write_json_response(&mut stream, 404, json!({ "error": "session not found" }))
            } else {
                write_json_response(
                    &mut stream,
                    200,
                    json!({
                        "ok": true,
                        "sessionId": session_id,
                        "pendingTools": session.get("pendingTools").cloned().unwrap_or_else(|| json!([])),
                        "permissions": session.get("permissions").cloned().unwrap_or_else(|| json!([])),
                        "rememberedRules": session.get("rememberedPermissionRules").cloned().unwrap_or_else(|| json!([]))
                    }),
                )
            }
        }
        ("GET", "/sessions") => {
            let state = app.state::<IdeRuntimeState>();
            let sessions = state
                .agent_sessions
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect::<Vec<_>>();
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
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "rootPath is required" }),
                );
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
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/message")
                .trim_matches('/');
            let message = body_value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let settings = body_value
                .get("settings")
                .cloned()
                .and_then(|value| serde_json::from_value::<connector::IdeSettings>(value).ok())
                .unwrap_or_else(connector::load_ide_settings);
            let context_refs = body_value
                .get("contextRefs")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let result =
                ide_agent_send(app, session_id.to_string(), settings, message, context_refs)?;
            write_json_response(&mut stream, 202, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/continue") => {
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/continue")
                .trim_matches('/');
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_continue(app.clone(), state, session_id.to_string())?;
            write_json_response(&mut stream, 202, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/cancel") => {
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/cancel")
                .trim_matches('/');
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_cancel(app.clone(), state, session_id.to_string())?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/fork") => {
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/fork")
                .trim_matches('/');
            let label = body_value
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string);
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_session_fork(state, session_id.to_string(), label)?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/compact") => {
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/compact")
                .trim_matches('/');
            let reason = body_value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("manual")
                .to_string();
            let result = ide_agent_compact_session(app.clone(), session_id.to_string(), reason)?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/checkpoint") => {
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/checkpoint")
                .trim_matches('/');
            let label = body_value
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string);
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_checkpoint_create(
                app.clone(),
                state,
                session_id.to_string(),
                label,
                None,
            )?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path)
            if path.starts_with("/session/")
                && path.contains("/checkpoint/")
                && path.ends_with("/revert") =>
        {
            let parts = path
                .trim_start_matches("/session/")
                .split("/checkpoint/")
                .collect::<Vec<_>>();
            if parts.len() != 2 {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "invalid checkpoint path" }),
                );
            }
            let checkpoint_id = parts[1]
                .trim_end_matches("/revert")
                .trim_matches('/')
                .to_string();
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_checkpoint_revert(
                app.clone(),
                state,
                parts[0].to_string(),
                checkpoint_id,
            )?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.ends_with("/subagent") => {
            let session_id = path
                .trim_start_matches("/session/")
                .trim_end_matches("/subagent")
                .trim_matches('/');
            let profile_id = body_value
                .get("profileId")
                .or_else(|| body_value.get("profile_id"))
                .and_then(Value::as_str)
                .unwrap_or("Explore")
                .to_string();
            let task = body_value
                .get("task")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let context_refs = body_value
                .get("contextRefs")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_subagent_run(
                app.clone(),
                state,
                session_id.to_string(),
                profile_id,
                task,
                context_refs,
            )?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path) if path.starts_with("/session/") && path.contains("/permission/") => {
            let parts = path
                .trim_start_matches("/session/")
                .split("/permission/")
                .collect::<Vec<_>>();
            if parts.len() != 2 {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "invalid permission path" }),
                );
            }
            let permission_id = parts[1].trim_matches('/').to_string();
            let decision = if body_value.is_object() {
                body_value.clone()
            } else {
                json!({ "granted": body_value.as_bool().unwrap_or(false), "scope": "once" })
            };
            let app_for_approval = app.clone();
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_tool_approve(
                app_for_approval,
                state,
                parts[0].to_string(),
                permission_id,
                decision,
            )?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", "/patch/apply") => {
            let root_path = body_value
                .get("rootPath")
                .or_else(|| body_value.get("root_path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let patch = body_value
                .get("patch")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let approvals = body_value
                .get("approvals")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let result = ide_agent_apply_patch(root_path, patch, approvals)?;
            write_json_response(&mut stream, 200, result)
        }
        ("GET", "/memory") => {
            let Some(root_path) =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"))
            else {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "rootPath is required" }),
                );
            };
            let result = ide_agent_memory_read(app.clone(), root_path)?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", "/memory") => {
            let root_path = body_value
                .get("rootPath")
                .or_else(|| body_value.get("root_path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let patch = body_value
                .get("patch")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let result = ide_agent_memory_update(app.clone(), root_path, patch)?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", "/memory/apply") => {
            let root_path = body_value
                .get("rootPath")
                .or_else(|| body_value.get("root_path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let patch = body_value
                .get("patch")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let approvals = body_value
                .get("approvals")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let result = ide_agent_memory_apply(app.clone(), root_path, patch, approvals)?;
            write_json_response(&mut stream, 200, result)
        }
        ("GET", "/mcp") => {
            let Some(root_path) =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"))
            else {
                return write_json_response(
                    &mut stream,
                    400,
                    json!({ "error": "rootPath is required" }),
                );
            };
            let result = ide_mcp_servers(root_path)?;
            write_json_response(&mut stream, 200, result)
        }
        ("GET", "/processes") => {
            let root_path =
                query_param(query, "rootPath").or_else(|| query_param(query, "root_path"));
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_processes(state, root_path)?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", path) if path.starts_with("/process/") && path.ends_with("/kill") => {
            let process_id = path
                .trim_start_matches("/process/")
                .trim_end_matches("/kill")
                .trim_matches('/');
            let state = app.state::<IdeRuntimeState>();
            let result = ide_agent_process_kill(app.clone(), state, process_id.to_string())?;
            write_json_response(&mut stream, 200, result)
        }
        ("POST", "/lsp") => {
            let root_path = body_value
                .get("rootPath")
                .or_else(|| body_value.get("root_path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let method = body_value
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let params = body_value
                .get("params")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = ide_lsp_request(root_path, method, params)?;
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

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            Some(
                value
                    .replace("%5C", "\\")
                    .replace("%5c", "\\")
                    .replace("%3A", ":")
                    .replace("%3a", ":")
                    .replace("%2F", "/")
                    .replace("%2f", "/")
                    .replace("%20", " "),
            )
        } else {
            None
        }
    })
}

fn write_empty_response(stream: &mut TcpStream, status: u16) -> Result<(), String> {
    let reason = if status == 204 { "No Content" } else { "OK" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization, X-API-Key\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|err| err.to_string())
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
    stream
        .write_all(response.as_bytes())
        .map_err(|err| err.to_string())
}

fn write_sse_response(app: AppHandle, stream: &mut TcpStream, query: &str) -> Result<(), String> {
    let since = query
        .split('&')
        .find_map(|pair| {
            pair.strip_prefix("since=")
                .and_then(|value| value.parse::<u64>().ok())
        })
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
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("message");
            let frame = format!("id: {id}\nevent: {event_type}\ndata: {}\n\n", event);
            stream
                .write_all(frame.as_bytes())
                .map_err(|err| err.to_string())?;
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
                item.get("granted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
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
        "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
        "changed": result.get("changed").cloned().unwrap_or_else(|| json!([]))
    }))
}

fn mime_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "md" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "java" | "css" | "html" => {
            "text/plain"
        }
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
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to read attachment metadata: {err}"))?;
    let mime = mime_for_path(path);
    Ok(AttachmentInfo {
        kind: kind.to_string(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "attachment".to_string()),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        previewable: mime.starts_with("image/")
            || mime.starts_with("text/")
            || mime == "application/pdf",
        mime,
    })
}

fn offline_stt_dir() -> PathBuf {
    ide_data_dir().join("stt").join("sherpa-onnx")
}

fn offline_stt_models_dir() -> PathBuf {
    offline_stt_dir().join("models")
}

fn offline_stt_bin_dir() -> PathBuf {
    offline_stt_dir().join("bin")
}

fn offline_stt_model_catalog() -> Vec<OfflineSttModelSpec> {
    vec![
        OfflineSttModelSpec {
            id: "zh-streaming-small",
            name: "Chinese streaming small",
            description: "Small local Chinese streaming ASR model. Faster download and lower resource usage.",
            size_label: "about 230 MB",
            accuracy_label: "standard",
            latency_label: "low",
            archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2",
            archive_name: "sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2",
            extracted_dir: "sherpa-onnx-paraformer-zh-int8-2025-10-07",
            model_kind: "paraformer",
        },
        OfflineSttModelSpec {
            id: "zh-accurate",
            name: "Chinese high accuracy",
            description: "Larger local Chinese ASR model for longer recordings and complex scenes.",
            size_label: "about 500 MB+",
            accuracy_label: "high",
            latency_label: "medium",
            archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2025-10-07.tar.bz2",
            archive_name: "sherpa-onnx-paraformer-zh-2025-10-07.tar.bz2",
            extracted_dir: "sherpa-onnx-paraformer-zh-2025-10-07",
            model_kind: "paraformer",
        },
    ]
}

fn offline_stt_model_spec(model_id: &str) -> OfflineSttModelSpec {
    offline_stt_model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .unwrap_or_else(|| OfflineSttModelSpec {
            id: "zh-streaming-small",
            name: "Chinese streaming small",
            description: "Small local Chinese streaming ASR model. Faster download and lower resource usage.",
            size_label: "about 230 MB",
            accuracy_label: "standard",
            latency_label: "low",
            archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2",
            archive_name: "sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2",
            extracted_dir: "sherpa-onnx-paraformer-zh-int8-2025-10-07",
            model_kind: "paraformer",
        })
}

fn offline_stt_model_path(spec: &OfflineSttModelSpec) -> PathBuf {
    offline_stt_models_dir().join(spec.extracted_dir)
}

fn offline_stt_model_installed_at(dir: &Path) -> bool {
    dir.join("tokens.txt").exists()
        && (dir.join("model.int8.onnx").exists()
            || dir.join("model.onnx").exists()
            || dir.join("encoder-epoch-99-avg-1.onnx").exists())
}

fn offline_stt_model_candidates(
    spec: &OfflineSttModelSpec,
    app: Option<&AppHandle>,
) -> Vec<PathBuf> {
    let mut paths = vec![
        offline_stt_models_dir().join(spec.extracted_dir),
        offline_stt_models_dir().join(spec.id),
    ];
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            for root in [
                resource_dir.join("sherpa-onnx").join("models"),
                resource_dir
                    .join("resources")
                    .join("sherpa-onnx")
                    .join("models"),
            ] {
                paths.push(root.join(spec.extracted_dir));
                paths.push(root.join(spec.id));
            }
        }
    }
    paths
}

fn offline_stt_model_resolved_path(spec: &OfflineSttModelSpec, app: Option<&AppHandle>) -> PathBuf {
    offline_stt_model_candidates(spec, app)
        .into_iter()
        .find(|path| offline_stt_model_installed_at(path))
        .unwrap_or_else(|| offline_stt_model_path(spec))
}

fn offline_stt_model_installed(spec: &OfflineSttModelSpec) -> bool {
    offline_stt_model_installed_at(&offline_stt_model_path(spec))
}

fn cleanup_offline_stt_model_artifacts(spec: &OfflineSttModelSpec, archive_path: &Path) {
    let _ = fs::remove_file(archive_path);
    let _ = fs::remove_file(archive_path.with_extension("download"));

    let app_model_path = offline_stt_model_path(spec);
    if app_model_path.exists() {
        let _ = fs::remove_dir_all(&app_model_path);
    }

    let legacy_model_path = offline_stt_models_dir().join(spec.id);
    if legacy_model_path != app_model_path && legacy_model_path.exists() {
        let _ = fs::remove_dir_all(legacy_model_path);
    }
}

fn offline_stt_model_installed_app(spec: &OfflineSttModelSpec, app: Option<&AppHandle>) -> bool {
    offline_stt_model_candidates(spec, app)
        .iter()
        .any(|path| offline_stt_model_installed_at(path))
}

fn offline_stt_find_named_binary(app: Option<&AppHandle>, names: &[&str]) -> Option<PathBuf> {
    let mut roots = vec![offline_stt_bin_dir(), offline_stt_dir()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
            roots.push(parent.join("sherpa-onnx").join("bin"));
            roots.push(parent.join("resources").join("sherpa-onnx").join("bin"));
        }
    }
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            roots.push(resource_dir.join("sherpa-onnx").join("bin"));
            roots.push(resource_dir.join("sherpa-onnx"));
            roots.push(
                resource_dir
                    .join("resources")
                    .join("sherpa-onnx")
                    .join("bin"),
            );
            roots.push(resource_dir.join("resources").join("sherpa-onnx"));
        }
    }
    for root in roots {
        for name in names {
            let candidate = root.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for root in std::env::split_paths(&paths) {
            for name in names {
                let candidate = root.join(name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn offline_stt_find_binary(app: Option<&AppHandle>) -> Option<PathBuf> {
    offline_stt_find_named_binary(
        app,
        &[
            "sherpa-onnx-offline-parallel.exe",
            "sherpa-onnx-offline-parallel",
            "sherpa-onnx-offline.exe",
            "sherpa-onnx-offline",
            "sherpa-onnx.exe",
            "sherpa-onnx",
        ],
    )
}

fn offline_stt_find_websocket_server(app: Option<&AppHandle>) -> Option<PathBuf> {
    offline_stt_find_named_binary(
        app,
        &[
            "sherpa-onnx-offline-websocket-server.exe",
            "sherpa-onnx-offline-websocket-server",
        ],
    )
}

fn offline_stt_status_json(app: Option<&AppHandle>, active_model: &str) -> Value {
    let binary_path = offline_stt_find_binary(app);
    let models: Vec<Value> = offline_stt_model_catalog()
        .iter()
        .map(|model| {
            let path = offline_stt_model_resolved_path(model, app);
            json!({
                "id": model.id,
                "name": model.name,
                "description": model.description,
                "sizeLabel": model.size_label,
                "accuracyLabel": model.accuracy_label,
                "latencyLabel": model.latency_label,
                "kind": if model.id == "zh-streaming-small" { "recommended" } else { "downloadable" },
                "installed": offline_stt_model_installed_app(model, app),
                "path": path.to_string_lossy(),
                "downloadUrl": model.archive_url,
                "modelKind": model.model_kind,
                "active": model.id == active_model,
            })
        })
        .collect();
    let binary_found = binary_path.is_some();
    json!({
        "enabled": true,
        "engine": "sherpa-onnx",
        "activeModel": active_model,
        "binaryFound": binary_found,
        "binaryPath": binary_path.map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
        "dataDir": offline_stt_dir().to_string_lossy(),
        "models": models,
        "message": if binary_found {
            "Offline STT engine is ready."
        } else {
            "sherpa-onnx ASR engine was not found. Bundle it under resources/sherpa-onnx/bin or place it in AppData/stt/sherpa-onnx/bin."
        }
    })
}

#[tauri::command]
pub fn ide_offline_stt_status(
    app: AppHandle,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    let mut status = offline_stt_status_json(Some(&app), settings.offline_stt_model.trim());
    if let Some(object) = status.as_object_mut() {
        object.insert(
            "enabled".to_string(),
            Value::Bool(settings.offline_stt_enabled),
        );
    }
    Ok(status)
}

fn emit_offline_stt_download(
    app: &AppHandle,
    model_id: &str,
    phase: &str,
    bytes: u64,
    total_bytes: Option<u64>,
    message: &str,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((bytes as f64 / total as f64) * 100.0).clamp(0.0, 100.0));
    let _ = app.emit(
        "ide-offline-stt-download",
        json!({
            "modelId": model_id,
            "phase": phase,
            "bytes": bytes,
            "totalBytes": total_bytes,
            "percent": percent,
            "message": message,
            "at": agent_now(),
        }),
    );
}

async fn wait_offline_stt_cancel(cancel_flag: Arc<AtomicBool>) {
    while !cancel_flag.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

fn offline_stt_proxy_from_env() -> Option<String> {
    [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .iter()
    .filter_map(|name| std::env::var(name).ok())
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
}

fn offline_stt_download_client(
    proxy_url: Option<&str>,
) -> Result<(reqwest::Client, String), String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(1800));
    let proxy = proxy_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(offline_stt_proxy_from_env);
    if let Some(proxy) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(&proxy)
                .map_err(|err| format!("Invalid download proxy URL: {err}"))?,
        );
        Ok((
            builder
                .build()
                .map_err(|err| format!("Failed to create offline STT download client: {err}"))?,
            proxy,
        ))
    } else {
        Ok((
            builder
                .build()
                .map_err(|err| format!("Failed to create offline STT download client: {err}"))?,
            String::new(),
        ))
    }
}

#[tauri::command]
pub async fn ide_offline_stt_download_model(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    model_id: String,
    proxy_url: Option<String>,
) -> Result<Value, String> {
    let spec = offline_stt_model_spec(model_id.trim());
    fs::create_dir_all(offline_stt_models_dir())
        .map_err(|err| format!("Failed to create offline STT model directory: {err}"))?;
    let archive_path = offline_stt_models_dir().join(spec.archive_name);
    let started = Instant::now();
    let installed_path = offline_stt_model_resolved_path(&spec, Some(&app));

    if offline_stt_model_installed_at(&installed_path) {
        emit_offline_stt_download(
            &app,
            spec.id,
            "done",
            0,
            None,
            "Offline STT model is already installed.",
        );
        return Ok(json!({
            "ok": true,
            "modelId": spec.id,
            "path": installed_path.to_string_lossy(),
            "archivePath": archive_path.to_string_lossy(),
            "bytes": 0,
            "durationMs": started.elapsed().as_millis() as u64,
            "message": "Offline STT model is already installed."
        }));
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
        if let Some(previous) = cancels.insert(spec.id.to_string(), cancel_flag.clone()) {
            previous.store(true, Ordering::SeqCst);
        }
    }

    emit_offline_stt_download(
        &app,
        spec.id,
        "starting",
        0,
        None,
        "Preparing offline STT model download.",
    );
    if archive_path.exists() {
        let archive_len = archive_path.metadata().map(|meta| meta.len()).unwrap_or(0);
        if archive_len == 0 {
            cleanup_offline_stt_model_artifacts(&spec, &archive_path);
            emit_offline_stt_download(
                &app,
                spec.id,
                "starting",
                0,
                None,
                "Found an empty previous archive; cleaned it and will download again.",
            );
        } else {
            match extract_offline_stt_archive(&app, &spec, &archive_path, archive_len, started) {
                Ok(value) => {
                    let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
                    cancels.remove(spec.id);
                    return Ok(value);
                }
                Err(_) => {
                    cleanup_offline_stt_model_artifacts(&spec, &archive_path);
                    emit_offline_stt_download(
                        &app,
                        spec.id,
                        "starting",
                        0,
                        None,
                        "Previous archive could not be extracted; cleaned it and will download again.",
                    );
                }
            }
        }
    }

    if cancel_flag.load(Ordering::SeqCst) {
        let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
        cancels.remove(spec.id);
        emit_offline_stt_download(
            &app,
            spec.id,
            "canceled",
            0,
            None,
            "Offline STT model download was cancelled.",
        );
        return Ok(
            json!({ "ok": false, "canceled": true, "modelId": spec.id, "bytes": 0, "message": "Offline STT model download was cancelled." }),
        );
    }

    let (client, proxy_used) = match offline_stt_download_client(proxy_url.as_deref()) {
        Ok(value) => value,
        Err(err) => {
            let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
            cancels.remove(spec.id);
            emit_offline_stt_download(&app, spec.id, "error", 0, None, &err);
            return Err(err);
        }
    };
    let connect_message = if proxy_used.is_empty() {
        "Connecting to offline STT model download source. You can configure a local proxy such as http://127.0.0.1:7890 in settings.".to_string()
    } else {
        format!("Connecting to offline STT model download source through proxy: {proxy_used}")
    };
    emit_offline_stt_download(&app, spec.id, "connecting", 0, None, &connect_message);
    let send_future = client.get(spec.archive_url).send();
    let response = tokio::select! {
        result = send_future => {
            match result {
                Ok(response) => response,
                Err(err) => {
                    if cancel_flag.load(Ordering::SeqCst) {
                        let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
                        cancels.remove(spec.id);
                        emit_offline_stt_download(
                            &app,
                            spec.id,
                            "canceled",
                            0,
                            None,
                            "Offline STT model download was cancelled.",
                        );
                        return Ok(json!({ "ok": false, "canceled": true, "modelId": spec.id, "bytes": 0, "message": "Offline STT model download was cancelled." }));
                    }
                    let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
                    cancels.remove(spec.id);
                    emit_offline_stt_download(
                        &app,
                        spec.id,
                        "error",
                        0,
                        None,
                        "Failed to connect to the offline STT model download source. Check GitHub access or configure a proxy.",
                    );
                    return Err(format!("Failed to connect to offline STT model download source: {err}"));
                }
            }
        }
        _ = wait_offline_stt_cancel(cancel_flag.clone()) => {
            let download_path = archive_path.with_extension("download");
            let _ = fs::remove_file(&download_path);
            let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
            cancels.remove(spec.id);
            emit_offline_stt_download(
                &app,
                spec.id,
                "canceled",
                0,
                None,
                "Offline STT model download was cancelled.",
            );
            return Ok(json!({ "ok": false, "canceled": true, "modelId": spec.id, "bytes": 0, "message": "Offline STT model download was cancelled." }));
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
        cancels.remove(spec.id);
        emit_offline_stt_download(
            &app,
            spec.id,
            "error",
            0,
            None,
            "Offline STT model download failed.",
        );
        return Err(format!(
            "Offline STT model download failed with status {}: {}",
            status.as_u16(),
            text
        ));
    }

    let total_bytes = response.content_length();
    let download_path = archive_path.with_extension("download");
    let _ = fs::remove_file(&download_path);
    let mut file = fs::File::create(&download_path)
        .map_err(|err| format!("Failed to create offline STT archive file: {err}"))?;
    let mut stream = response.bytes_stream();
    let mut bytes = 0u64;
    let mut last_emit = Instant::now();
    emit_offline_stt_download(
        &app,
        spec.id,
        "downloading",
        0,
        total_bytes,
        "Downloading offline STT model file.",
    );
    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&download_path);
            let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
            cancels.remove(spec.id);
            emit_offline_stt_download(
                &app,
                spec.id,
                "canceled",
                bytes,
                total_bytes,
                "Offline STT model download was cancelled.",
            );
            return Ok(
                json!({ "ok": false, "canceled": true, "modelId": spec.id, "bytes": bytes, "message": "Offline STT model download was cancelled." }),
            );
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                if cancel_flag.load(Ordering::SeqCst) {
                    drop(file);
                    let _ = fs::remove_file(&download_path);
                    let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
                    cancels.remove(spec.id);
                    emit_offline_stt_download(
                        &app,
                        spec.id,
                        "canceled",
                        bytes,
                        total_bytes,
                        "Offline STT model download was cancelled.",
                    );
                    return Ok(
                        json!({ "ok": false, "canceled": true, "modelId": spec.id, "bytes": bytes, "message": "Offline STT model download was cancelled." }),
                    );
                }
                drop(file);
                let _ = fs::remove_file(&download_path);
                let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
                cancels.remove(spec.id);
                emit_offline_stt_download(
                    &app,
                    spec.id,
                    "error",
                    bytes,
                    total_bytes,
                    "Failed to read offline STT model download stream; cleaned temporary file.",
                );
                return Err(format!(
                    "Failed to read offline STT model download stream: {err}"
                ));
            }
        };
        bytes += chunk.len() as u64;
        if let Err(err) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&download_path);
            let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
            cancels.remove(spec.id);
            emit_offline_stt_download(
                &app,
                spec.id,
                "error",
                bytes,
                total_bytes,
                "Failed to write offline STT archive file.",
            );
            return Err(format!("Failed to write offline STT archive file: {err}"));
        }
        if last_emit.elapsed() >= Duration::from_millis(250) {
            emit_offline_stt_download(
                &app,
                spec.id,
                "downloading",
                bytes,
                total_bytes,
                "Downloading offline STT model file.",
            );
            last_emit = Instant::now();
        }
    }
    drop(file);
    if let Some(expected) = total_bytes {
        if expected != bytes {
            let _ = fs::remove_file(&download_path);
            let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
            cancels.remove(spec.id);
            emit_offline_stt_download(
                &app,
                spec.id,
                "error",
                bytes,
                Some(expected),
                "Offline STT model download is incomplete; cleaned temporary file.",
            );
            return Err(format!(
                "Offline STT model download is incomplete: downloaded {} bytes, expected {} bytes.",
                bytes, expected
            ));
        }
    }
    fs::rename(&download_path, &archive_path)
        .or_else(|_| {
            let _ = fs::remove_file(&archive_path);
            fs::rename(&download_path, &archive_path)
        })
        .map_err(|err| format!("Failed to save offline STT archive: {err}"))?;
    let result = extract_offline_stt_archive(&app, &spec, &archive_path, bytes, started);
    let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
    cancels.remove(spec.id);
    if result.is_err() {
        cleanup_offline_stt_model_artifacts(&spec, &archive_path);
    }
    result
}

#[tauri::command]
pub fn ide_offline_stt_cancel_download(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    model_id: String,
) -> Result<Value, String> {
    let spec = offline_stt_model_spec(model_id.trim());
    let canceled = {
        let mut cancels = state.offline_stt_download_cancels.lock().unwrap();
        if let Some(flag) = cancels.get(spec.id) {
            flag.store(true, Ordering::SeqCst);
            cancels.remove(spec.id);
            true
        } else {
            false
        }
    };
    if canceled {
        let archive_path = offline_stt_models_dir().join(spec.archive_name);
        let download_path = archive_path.with_extension("download");
        let _ = fs::remove_file(&download_path);
        emit_offline_stt_download(
            &app,
            spec.id,
            "canceled",
            0,
            None,
            "Offline STT model download was cancelled.",
        );
    }
    Ok(json!({
        "ok": canceled,
        "canceled": canceled,
        "modelId": spec.id,
        "message": if canceled { "Offline STT model download was cancelled." } else { "No offline STT model download is active." }
    }))
}

fn extract_offline_stt_archive(
    app: &AppHandle,
    spec: &OfflineSttModelSpec,
    archive_path: &Path,
    bytes: u64,
    started: Instant,
) -> Result<Value, String> {
    emit_offline_stt_download(
        app,
        spec.id,
        "extracting",
        bytes,
        Some(bytes).filter(|value| *value > 0),
        "Model downloaded; extracting archive.",
    );
    let mut command = Command::new("tar");
    command
        .arg("-xjf")
        .arg(archive_path)
        .arg("-C")
        .arg(offline_stt_models_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
        command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    let output = command.output().map_err(|err| {
        emit_offline_stt_download(
            app,
            spec.id,
            "error",
            bytes,
            Some(bytes).filter(|value| *value > 0),
            "Model downloaded, but system tar extraction failed.",
        );
        format!(
            "Model downloaded, but system tar extraction failed: {err}. Archive path: {}",
            archive_path.to_string_lossy()
        )
    })?;
    if !output.status.success() {
        emit_offline_stt_download(
            app,
            spec.id,
            "error",
            bytes,
            Some(bytes).filter(|value| *value > 0),
            "Model downloaded, but extraction failed.",
        );
        return Err(format!(
            "Model downloaded, but extraction failed: {}. Archive path: {}",
            String::from_utf8_lossy(&output.stderr),
            archive_path.to_string_lossy()
        ));
    }
    let ok = offline_stt_model_installed(&spec);
    emit_offline_stt_download(
        app,
        spec.id,
        if ok { "done" } else { "error" },
        bytes,
        Some(bytes).filter(|value| *value > 0),
        if ok {
            "Offline STT model downloaded and extracted."
        } else {
            "Model extracted, but expected model files were not found."
        },
    );
    Ok(json!({
        "ok": ok,
        "modelId": spec.id,
        "path": offline_stt_model_path(&spec).to_string_lossy(),
        "archivePath": archive_path.to_string_lossy(),
        "bytes": bytes,
        "durationMs": started.elapsed().as_millis() as u64,
        "message": if ok { "Offline STT model downloaded and extracted." } else { "Model extracted, but expected model files were not found." }
    }))
}

fn parse_sherpa_transcript(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    for line in trimmed.lines().rev() {
        let line = line.trim();
        if line.starts_with('{') {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    return text.to_string();
                }
            }
        }
    }
    trimmed
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.contains("sherpa-onnx"))
        .last()
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

fn offline_stt_thread_count() -> usize {
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .saturating_sub(1)
        .clamp(2, 6)
}

fn reserve_local_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|err| format!("Failed to reserve local STT port: {err}"))
}

fn wait_for_local_port(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(80));
    }
    false
}

fn ensure_offline_stt_server(
    app: &AppHandle,
    state: &IdeRuntimeState,
    spec: &OfflineSttModelSpec,
    tokens: &Path,
    model: &Path,
) -> Result<u16, String> {
    let mut server_guard = state.offline_stt_server.lock().unwrap();
    if let Some(server) = server_guard.as_mut() {
        let alive = server
            .child
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false);
        if alive && server.model_id == spec.id {
            return Ok(server.port);
        }
        let _ = server.child.kill();
        let _ = server.child.wait();
        *server_guard = None;
    }
    let Some(binary) = offline_stt_find_websocket_server(Some(app)) else {
        return Err("sherpa-onnx offline websocket server was not found.".to_string());
    };
    let port = reserve_local_port()?;
    let log_file = offline_stt_dir().join("offline-websocket-server.log");
    let thread_count = offline_stt_thread_count().to_string();
    let mut command = Command::new(binary);
    command
        .arg(format!("--port={port}"))
        .arg(format!("--num-work-threads={thread_count}"))
        .arg("--num-io-threads=1")
        .arg("--max-batch-size=1")
        .arg(format!("--tokens={}", tokens.to_string_lossy()))
        .arg(format!("--paraformer={}", model.to_string_lossy()))
        .arg("--model-type=paraformer")
        .arg("--debug=false")
        .arg("--print-args=false")
        .arg(format!("--log-file={}", log_file.to_string_lossy()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
        command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    let child = command
        .spawn()
        .map_err(|err| format!("Failed to start sherpa-onnx offline websocket server: {err}"))?;
    if !wait_for_local_port(port, Duration::from_secs(12)) {
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
        return Err("sherpa-onnx offline websocket server failed to start.".to_string());
    }
    *server_guard = Some(OfflineSttServer {
        child,
        model_id: spec.id.to_string(),
        port,
    });
    Ok(port)
}

fn read_wave_as_f32_payload(audio_path: &str) -> Result<(u32, Vec<f32>), String> {
    let mut reader = hound::WavReader::open(audio_path)
        .map_err(|err| format!("Failed to read wav file: {err}"))?;
    let spec = reader.spec();
    if spec.channels != 1 {
        return Err("Offline STT requires a mono wav file.".to_string());
    }
    let samples = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| value as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Failed to read PCM samples: {err}"))?,
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Failed to read float samples: {err}"))?,
        _ => return Err("Offline STT requires 16-bit PCM or 32-bit float wav.".to_string()),
    };
    Ok((spec.sample_rate, samples))
}

async fn transcribe_with_offline_stt_server(port: u16, audio_path: &str) -> Result<String, String> {
    let (sample_rate, samples) = read_wave_as_f32_payload(audio_path)?;
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        connect_async(format!("ws://127.0.0.1:{port}")),
    )
    .await
    .map_err(|_| "Timed out connecting to sherpa-onnx offline websocket server.".to_string())?
    .map_err(|err| format!("Failed to connect to sherpa-onnx offline websocket server: {err}"))?;
    let mut payload = Vec::with_capacity(8 + samples.len() * 4);
    payload.extend_from_slice(&sample_rate.to_le_bytes());
    payload.extend_from_slice(&((samples.len() * 4) as i32).to_le_bytes());
    for sample in samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    for chunk in payload.chunks(16 * 1024) {
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Binary(chunk.to_vec().into())),
        )
        .await
        .map_err(|_| {
            "Timed out sending audio to sherpa-onnx offline websocket server.".to_string()
        })?
        .map_err(|err| {
            format!("Failed to send audio to sherpa-onnx offline websocket server: {err}")
        })?;
    }
    let mut text = String::new();
    while let Some(message) = tokio::time::timeout(Duration::from_secs(20), socket.next())
        .await
        .map_err(|_| "Timed out waiting for sherpa-onnx offline websocket response.".to_string())?
    {
        let message = message.map_err(|err| {
            format!("Failed to read sherpa-onnx offline websocket message: {err}")
        })?;
        if let Message::Text(raw) = message {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                if let Some(candidate) = value.get("text").and_then(Value::as_str) {
                    text = candidate.to_string();
                    break;
                }
            } else if !raw.trim().is_empty() {
                text = raw.to_string();
                break;
            }
        }
    }
    let _ = socket.send(Message::Text("Done".into())).await;
    let _ = socket.close(None).await;
    Ok(text)
}

#[tauri::command]
pub async fn ide_offline_stt_transcribe(
    app: AppHandle,
    state: State<'_, IdeRuntimeState>,
    audio_path: String,
    model_id: Option<String>,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    if settings.offline_stt_enabled {
        if let Ok(value) =
            ide_offline_stt_transcribe_fast(&app, &state, &audio_path, model_id.clone(), &settings)
                .await
        {
            if value
                .get("text")
                .and_then(Value::as_str)
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false)
            {
                return Ok(value);
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        ide_offline_stt_transcribe_blocking(app, audio_path, model_id, settings)
    })
    .await
    .map_err(|err| format!("绂荤嚎璇煶杞枃瀛楀悗鍙颁换鍔″け璐ワ細{err}"))?
}

async fn ide_offline_stt_transcribe_fast(
    app: &AppHandle,
    state: &IdeRuntimeState,
    audio_path: &str,
    model_id: Option<String>,
    settings: &connector::IdeSettings,
) -> Result<Value, String> {
    let started = Instant::now();
    let path = Path::new(audio_path);
    if !path.exists() {
        return Err("Audio file does not exist.".to_string());
    }
    let active_model = model_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.offline_stt_model.clone());
    let spec = offline_stt_model_spec(active_model.trim());
    if spec.model_kind != "paraformer" || !offline_stt_model_installed_app(&spec, Some(app)) {
        return Err("Offline STT model is not installed.".to_string());
    }
    let model_dir = offline_stt_model_resolved_path(&spec, Some(app));
    let tokens = model_dir.join("tokens.txt");
    let model = if model_dir.join("model.int8.onnx").exists() {
        model_dir.join("model.int8.onnx")
    } else {
        model_dir.join("model.onnx")
    };
    let port = ensure_offline_stt_server(app, state, &spec, &tokens, &model)?;
    let transcript = transcribe_with_offline_stt_server(port, audio_path).await?;
    Ok(json!({
        "supported": !transcript.trim().is_empty(),
        "engine": "sherpa-onnx",
        "mode": "persistent-websocket",
        "modelId": spec.id,
        "model": spec.name,
        "text": transcript,
        "durationMs": started.elapsed().as_millis() as u64,
        "message": if transcript.trim().is_empty() { "sherpa-onnx returned no transcript." } else { "Offline STT transcription completed." }
    }))
}

fn ide_offline_stt_transcribe_blocking(
    app: AppHandle,
    audio_path: String,
    model_id: Option<String>,
    settings: connector::IdeSettings,
) -> Result<Value, String> {
    if !settings.offline_stt_enabled {
        return Ok(json!({
            "supported": false,
            "engine": "sherpa-onnx",
            "text": "",
            "message": "Offline STT is disabled."
        }));
    }
    let path = Path::new(&audio_path);
    if !path.exists() {
        return Err("Audio file does not exist.".to_string());
    }
    let active_model = model_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.offline_stt_model.clone());
    let spec = offline_stt_model_spec(active_model.trim());
    let Some(binary) = offline_stt_find_binary(Some(&app)) else {
        return Ok(json!({
            "supported": false,
            "engine": "sherpa-onnx",
            "modelId": spec.id,
            "text": "",
            "message": "sherpa-onnx offline ASR binary was not found. Bundle sherpa-onnx-offline-parallel.exe and DLLs under resources/sherpa-onnx/bin or AppData/stt/sherpa-onnx/bin."
        }));
    };
    if !offline_stt_model_installed_app(&spec, Some(&app)) {
        return Ok(json!({
            "supported": false,
            "engine": "sherpa-onnx",
            "modelId": spec.id,
            "text": "",
            "message": format!("Offline STT model {} is not installed. Download size: {}.", spec.name, spec.size_label)
        }));
    }
    let model_dir = offline_stt_model_resolved_path(&spec, Some(&app));
    let tokens = model_dir.join("tokens.txt");
    let model = if model_dir.join("model.int8.onnx").exists() {
        model_dir.join("model.int8.onnx")
    } else {
        model_dir.join("model.onnx")
    };
    let started = Instant::now();
    let thread_count = offline_stt_thread_count().to_string();
    let mut command = Command::new(&binary);
    if spec.model_kind == "paraformer" {
        command
            .arg(format!("--tokens={}", tokens.to_string_lossy()))
            .arg(format!("--paraformer={}", model.to_string_lossy()))
            .arg("--model-type=paraformer")
            .arg(format!("--num-threads={thread_count}"))
            .arg("--decoding-method=greedy_search")
            .arg("--debug=false")
            .arg("--print-args=false")
            .arg(audio_path);
    } else {
        return Ok(json!({
            "supported": false,
            "engine": "sherpa-onnx",
            "modelId": spec.id,
            "text": "",
            "message": "This offline STT model kind is not supported by the current local runner."
        }));
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|err| format!("Failed to run sherpa-onnx transcription: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Ok(json!({
            "supported": false,
            "engine": "sherpa-onnx",
            "modelId": spec.id,
            "text": "",
            "durationMs": started.elapsed().as_millis() as u64,
            "message": format!("sherpa-onnx transcription failed: {}", if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() })
        }));
    }
    let transcript = parse_sherpa_transcript(&stdout);
    Ok(json!({
        "supported": !transcript.trim().is_empty(),
        "engine": "sherpa-onnx",
        "modelId": spec.id,
        "model": spec.name,
        "text": transcript,
        "threads": thread_count,
        "durationMs": started.elapsed().as_millis() as u64,
        "raw": stdout,
        "message": if transcript.trim().is_empty() { "sherpa-onnx returned no transcript; audio attachment was kept." } else { "Offline STT transcription completed." }
    }))
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
    paths
        .iter()
        .map(|path| attachment_from_path(path, &kind))
        .collect()
}

#[tauri::command]
pub fn ide_read_attachment_preview(path: String) -> Result<Value, String> {
    let path = Path::new(&path);
    let info = attachment_from_path(path, "file")?;
    let mut text = String::new();
    let mut data_url = String::new();
    let mut note = String::new();
    if info.mime.starts_with("image/") && info.size <= 12 * 1024 * 1024 {
        let bytes =
            fs::read(path).map_err(|err| format!("failed to read attachment image: {err}"))?;
        data_url = format!(
            "data:{};base64,{}",
            info.mime,
            BASE64_STANDARD.encode(bytes)
        );
    } else if (info.mime.starts_with("text/")
        || matches!(
            path.extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "txt"
                | "md"
                | "json"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "css"
                | "html"
                | "py"
                | "rs"
                | "toml"
                | "yaml"
                | "yml"
                | "xml"
                | "csv"
                | "log"
        ))
        && info.size <= 2 * 1024 * 1024
    {
        let bytes = fs::read(path).unwrap_or_default();
        text = decode_attachment_text(&bytes)
            .chars()
            .take(240000)
            .collect::<String>();
        if text.is_empty() {
            note = "Text file preview is empty or unreadable.".to_string();
        }
    } else if info.mime.starts_with("image/") {
        note = "Image is larger than inline preview limit; metadata only.".to_string();
    } else {
        note = "Binary attachment metadata only; current model cannot read this file directly."
            .to_string();
    }
    Ok(json!({
        "path": info.path,
        "name": info.name,
        "mime": info.mime,
        "size": info.size,
        "previewable": info.previewable,
        "text": text,
        "dataUrl": data_url,
        "note": note
    }))
}

fn decode_attachment_text(bytes: &[u8]) -> String {
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
        .map_err(|_| "Timed out waiting for voice recorder to start.".to_string())??;
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
        "message": "Voice recording started."
    }))
}

#[tauri::command]
pub fn ide_voice_record_stop(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<Value, String> {
    let mut session = state
        .voice_sessions
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "Voice recording session was not found.".to_string())?;
    let _ = session.stop.send(());
    let join = session
        .join
        .take()
        .ok_or_else(|| "Voice recording worker was not found.".to_string())?;
    join.join()
        .map_err(|_| "Voice recording worker panicked.".to_string())?
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
        .ok_or_else(|| "No default audio input device was found.".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|err| format!("Failed to read default audio input config: {err}"))?;
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
                out.extend(
                    data.iter()
                        .map(|value| (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16),
                );
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
                out.extend(data.iter().map(|value| {
                    (*value as i32 - 32768).clamp(i16::MIN as i32, i16::MAX as i32) as i16
                }));
            },
            err_fn,
            None,
        ),
        other => {
            let message = format!("Unsupported audio sample format: {other:?}");
            let _ = ready_tx.send(Err(message.clone()));
            return Err(message);
        }
    }
    .map_err(|err| format!("Failed to build audio input stream: {err}"))?;
    stream
        .play()
        .map_err(|err| format!("Failed to start audio input stream: {err}"))?;
    let _ = ready_tx.send(Ok((sample_rate, channels)));
    let _ = stop_rx.recv();
    drop(stream);
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    let samples = samples.lock().unwrap().clone();
    if samples.is_empty() {
        return Err("No audio samples were recorded.".to_string());
    }
    let normalized_samples = normalize_voice_samples(&samples, channels, sample_rate);
    let path = std::env::temp_dir().join(format!("{session_id}.wav"));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, spec)
        .map_err(|err| format!("Failed to create recorded wav file: {err}"))?;
    for sample in normalized_samples {
        writer
            .write_sample(sample)
            .map_err(|err| format!("Failed to write recorded wav sample: {err}"))?;
    }
    writer
        .finalize()
        .map_err(|err| format!("Failed to finalize recorded wav file: {err}"))?;
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    Ok(json!({
        "supported": true,
        "path": path.to_string_lossy(),
        "name": path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "voice.wav".to_string()),
        "mime": "audio/wav",
        "size": size,
        "durationMs": elapsed_ms,
        "originalSampleRate": sample_rate,
        "originalChannels": channels,
        "sampleRate": 16000,
        "channels": 1,
        "message": "Voice recording saved as 16kHz mono PCM wav."
    }))
}

fn normalize_voice_samples(samples: &[i16], channels: u16, sample_rate: u32) -> Vec<i16> {
    let channels = channels.max(1) as usize;
    let mono: Vec<i16> = if channels == 1 {
        samples.to_vec()
    } else {
        samples
            .chunks(channels)
            .map(|frame| {
                let sum: i64 = frame.iter().map(|value| *value as i64).sum();
                (sum / frame.len().max(1) as i64).clamp(i16::MIN as i64, i16::MAX as i64) as i16
            })
            .collect()
    };
    if sample_rate == 16_000 || mono.len() < 2 {
        return mono;
    }
    let ratio = sample_rate as f64 / 16_000.0;
    let output_len = ((mono.len() as f64) / ratio).ceil().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_pos = index as f64 * ratio;
        let left_index = source_pos.floor() as usize;
        let right_index = (left_index + 1).min(mono.len() - 1);
        let fraction = source_pos - left_index as f64;
        let left = mono[left_index] as f64;
        let right = mono[right_index] as f64;
        output.push(
            (left + (right - left) * fraction)
                .round()
                .clamp(i16::MIN as f64, i16::MAX as f64) as i16,
        );
    }
    output
}

#[cfg(windows)]
fn run_windows_speech_transcribe(audio_path: &str, language: &str) -> Result<Value, String> {
    let path = Path::new(audio_path);
    if !path.exists() {
        return Err("Audio file does not exist; transcription cannot start.".to_string());
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
            .map_err(|err| format!("Failed to create speech script directory: {err}"))?;
    }
    let mut script_bytes = vec![0xEF, 0xBB, 0xBF];
    script_bytes.extend_from_slice(script.as_bytes());
    fs::write(&script_path, script_bytes)
        .map_err(|err| format!("Failed to write speech script: {err}"))?;
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
        .map_err(|err| format!("Failed to start Windows speech recognition: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(json!({
            "supported": false,
            "text": "",
            "language": language,
            "durationMs": started.elapsed().as_millis() as u64,
            "message": format!("Windows speech recognition unavailable: {stderr}")
        }));
    }
    let mut parsed = serde_json::from_str::<Value>(stdout.trim()).unwrap_or_else(|_| {
        json!({
            "supported": false,
            "text": "",
            "language": language,
            "message": if stderr.trim().is_empty() {
                "Windows speech recognition did not return a parseable result."
            } else {
                stderr.trim()
            }
        })
    });
    if let Some(object) = parsed.as_object_mut() {
        object.insert(
            "durationMs".to_string(),
            Value::Number(serde_json::Number::from(
                started.elapsed().as_millis() as u64
            )),
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
        "message": "Windows speech recognition is only available on Windows."
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
            "message": "Current provider does not advertise /v1/audio/transcriptions support; audio attachment was kept."
        }));
    }
    let path = Path::new(&audio_path);
    if !path.exists() {
        return Err("Audio file does not exist; transcription cannot start.".to_string());
    }
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "voice.wav".to_string());
    let bytes = fs::read(path).map_err(|err| format!("Failed to read audio file: {err}"))?;
    let mime = mime_for_path(path);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime)
        .map_err(|err| format!("Invalid audio MIME type: {err}"))?;
    let transcription_model = model.filter(|value| !value.trim().is_empty()).or_else(|| {
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
            "message": "Cloud transcription is disabled. Use an offline STT model in Voice settings, or configure a cloud transcription model."
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
        .map_err(|err| format!("Failed to create transcription client: {err}"))?;
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
        .map_err(|err| format!("Transcription request failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read transcription response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "Transcription returned HTTP {}: {}",
            status.as_u16(),
            text
        ));
    }
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "text": text }));
    let transcript = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if transcript.trim().is_empty() {
        return Err("Transcription succeeded but did not include a text field.".to_string());
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
        let mut started = match spawn_terminal_candidate(
            &app,
            &state,
            &shell_root,
            &shell_root_text,
            candidate,
        ) {
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
            "ide-terminal-output",
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
        let _ = app.emit(
            "ide-pty-output",
            TerminalOutputEvent {
                session_id: session_id.clone(),
                stream: "system".to_string(),
                data: format!("Started {label} in {cwd}\n"),
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
        args: vec!["/K".to_string(), "chcp 65001 > nul".to_string()],
        label: "cmd.exe".to_string(),
        probe: "echo __AUTOCODE_PTY_READY__ && cd\r\n".to_string(),
        pipe: false,
    }
}

fn terminal_shell_candidates(requested: &str) -> Vec<TerminalShellCandidate> {
    let normalized = requested.trim().to_lowercase();
    if cfg!(windows) {
        match normalized.as_str() {
            "" | "auto" => vec![
                powershell_candidate("powershell.exe", "PowerShell"),
                cmd_candidate(),
            ],
            "powershell" | "powershell.exe" => vec![
                powershell_candidate("powershell.exe", "PowerShell"),
                cmd_candidate(),
            ],
            "pwsh" | "pwsh.exe" => vec![
                powershell_candidate("pwsh.exe", "PowerShell 7"),
                cmd_candidate(),
            ],
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
    spawn_terminal_reader(
        app.clone(),
        session_id.clone(),
        "pty",
        reader,
        last_output.clone(),
    );
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
    spawn_terminal_reader(
        app.clone(),
        session_id.clone(),
        "stdout",
        stdout,
        last_output.clone(),
    );
    spawn_terminal_reader(
        app.clone(),
        session_id.clone(),
        "stderr",
        stderr,
        last_output.clone(),
    );
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
            Ok(child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(-1))
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
    (
        probe_output.contains("__AUTOCODE_PTY_READY__"),
        probe_output,
    )
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
pub fn ide_pty_probe(
    state: State<'_, IdeRuntimeState>,
    session_id: String,
) -> Result<Value, String> {
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
                        if recent.chars().count() > 12000 {
                            *recent = tail_chars(&recent, 12000);
                        }
                    }
                    let event = TerminalOutputEvent {
                        session_id: session_id.clone(),
                        stream: stream.clone(),
                        data,
                    };
                    let _ = app.emit("ide://terminal-output", event.clone());
                    let _ = app.emit("ide-terminal-output", event.clone());
                    let _ = app.emit("ide://pty-output", event.clone());
                    let _ = app.emit("ide-pty-output", event);
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
            "ide-terminal-exit",
            TerminalExitEvent {
                session_id: session_id.clone(),
                exit_code: code,
            },
        );
        let _ = app.emit(
            "ide://pty-exit",
            TerminalExitEvent {
                session_id: session_id.clone(),
                exit_code: code,
            },
        );
        let _ = app.emit(
            "ide-pty-exit",
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
pub fn ide_delete_workspace_entry(
    root_path: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
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
pub fn ide_stat_workspace_file(
    root_path: String,
    path: String,
) -> Result<connector::WorkspaceFileStat, String> {
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
            let _ = app.emit("connector-open-project", project.clone());
            let _ = app.emit("connector://deep-link", raw.to_string());
            let _ = app.emit("connector-deep-link", raw.to_string());
        }
        Ok(None) => {
            let _ = app.emit("connector://deep-link", raw.to_string());
            let _ = app.emit("connector-deep-link", raw.to_string());
        }
        Err(error) => {
            let _ = app.emit("connector://deep-link-error", error.clone());
            let _ = app.emit("connector-deep-link-error", error);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
