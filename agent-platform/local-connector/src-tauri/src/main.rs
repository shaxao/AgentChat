#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

mod connector;
mod ide;

use ide::{
    handle_deep_link as handle_ide_deep_link, ide_agent_apply_patch, ide_agent_approve,
    ide_agent_cancel, ide_agent_checkpoint_create, ide_agent_checkpoint_revert,
    ide_agent_compact_session, ide_agent_continue, ide_agent_memory_apply, ide_agent_memory_read,
    ide_agent_memory_update, ide_agent_message_send, ide_agent_plan_save, ide_agent_process_kill,
    ide_agent_processes, ide_agent_profiles, ide_agent_run, ide_agent_send,
    ide_agent_session_create, ide_agent_session_delete, ide_agent_session_fork,
    ide_agent_session_snapshot, ide_agent_session_start, ide_agent_session_state,
    ide_agent_sessions, ide_agent_smoke_check, ide_agent_subagent_run, ide_agent_tool_approve,
    ide_agent_tools, ide_ai_cancel, ide_ai_request, ide_api_request, ide_bootstrap,
    ide_channel_account_status, ide_channel_delete, ide_channel_refresh_models, ide_channel_save,
    ide_channel_test, ide_channels_list, ide_code_completion, ide_create_workspace_entry,
    ide_delete_workspace_entry, ide_format_workspace_content, ide_git_commit, ide_git_commit_show,
    ide_git_file_diff, ide_git_init, ide_git_stage, ide_git_status, ide_git_unstage, ide_hook_run,
    ide_initialize_autocode_project_files, ide_list_provider_models, ide_list_workspace,
    ide_local_server_status, ide_lsp_request, ide_mcp_servers, ide_offline_stt_cancel_download,
    ide_offline_stt_download_model, ide_offline_stt_status, ide_offline_stt_transcribe,
    ide_open_path, ide_open_url, ide_open_workspace, ide_pick_attachments, ide_pick_workspace,
    ide_provider_account_status, ide_provider_model_refresh, ide_provider_route, ide_pty_kill,
    ide_pty_probe, ide_pty_resize, ide_pty_start, ide_pty_write, ide_read_attachment_preview,
    ide_read_workspace_file, ide_reload_deep_link, ide_rename_workspace_entry,
    ide_run_workspace_command, ide_save_settings, ide_save_workspace_file, ide_search_workspace,
    ide_session_clear, ide_session_load, ide_session_save, ide_shell_execute,
    ide_stat_workspace_file, ide_terminal_kill, ide_terminal_resize,
    ide_terminal_set_default_shell, ide_terminal_start, ide_terminal_write, ide_test_provider,
    ide_transcribe_audio, ide_update_check, ide_update_install, ide_voice_record_start,
    ide_voice_record_stop, ide_windows_speech_transcribe, ide_workspace_file_index,
    start_ide_local_server, IdeRuntimeState,
};

const AUTOCODE_WORKSPACE_WINDOW: &str = "autocode-workspace";

#[tauri::command]
fn ide_play_notification_sound() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = r#"
$sound = 'C:\Windows\Media\Windows Notify System Generic.wav'
try {
  if (Test-Path $sound) {
    $player = New-Object System.Media.SoundPlayer $sound
    $player.PlaySync()
  } else {
    [console]::beep(880, 160)
  }
} catch {
  try { [console]::beep(880, 160) } catch {}
}
"#;
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("failed to play notification sound: {err}"))?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
struct UiStatus {
    status: String,
    detail: String,
    server: String,
    session: String,
    project: String,
    redacted_ws_url: String,
    version: String,
    min_version: String,
    last_error: String,
    last_heartbeat_at: String,
    connected: bool,
    running: bool,
    needs_project: bool,
}

fn idle_status() -> UiStatus {
    UiStatus {
        status: "ready".to_string(),
        detail: "Ready. Waiting for browser launch.".to_string(),
        server: String::new(),
        session: String::new(),
        project: String::new(),
        redacted_ws_url: String::new(),
        version: connector::VERSION.to_string(),
        min_version: String::new(),
        last_error: String::new(),
        last_heartbeat_at: String::new(),
        connected: false,
        running: false,
        needs_project: false,
    }
}

/// 一路本地执行会话的运行时句柄。每个 session_id 对应一个独立的连接循环，
/// 各自维护状态与代次，互不抢占——这是多项目 / 单项目多会话并发的核心。
struct RunnerHandle {
    status: UiStatus,
    config: connector::LaunchConfig,
    // 每会话代次：仅当**同一个 session_id** 重连时才递增，让该会话的旧循环
    // 侦测到代次变化后优雅退出；不同会话持有各自的 Arc，永不互相干扰。
    generation: Arc<AtomicU64>,
}

struct ConnectorState {
    // 按 session_id 索引的活跃会话表。多项目 / 多会话在此并存。
    runners: HashMap<String, RunnerHandle>,
    // 已收到深链但尚未选择项目目录的待定启动（按 session_id 并存，互不覆盖）。
    pending_launches: HashMap<String, connector::LaunchConfig>,
    pending_statuses: HashMap<String, UiStatus>,
    // 最近一次活跃的会话，供只能显示单条状态的旧 UI（main.ts）回退展示。
    last_active_session: Option<String>,
    // 最近一次进入“等待选目录”的 session，供“选择目录并连接”按钮默认处理。
    last_pending_session: Option<String>,
}

impl Default for ConnectorState {
    fn default() -> Self {
        Self {
            runners: HashMap::new(),
            pending_launches: HashMap::new(),
            pending_statuses: HashMap::new(),
            last_active_session: None,
            last_pending_session: None,
        }
    }
}

impl ConnectorState {
    /// 为只能展示单条状态的旧 UI 挑一条“最有代表性”的状态：
    /// 优先最近活跃会话 → 任一已连接会话 → 最近待定授权 → 任一会话 → 空闲默认。
    fn representative_status(&self) -> UiStatus {
        if let Some(sid) = &self.last_pending_session {
            if let Some(status) = self.pending_statuses.get(sid) {
                return status.clone();
            }
        }
        if let Some(status) = self.pending_statuses.values().next() {
            return status.clone();
        }
        if let Some(sid) = &self.last_active_session {
            if let Some(handle) = self.runners.get(sid) {
                return handle.status.clone();
            }
        }
        if let Some(handle) = self.runners.values().find(|h| h.status.connected) {
            return handle.status.clone();
        }
        if let Some(handle) = self.runners.values().next() {
            return handle.status.clone();
        }
        idle_status()
    }

    fn take_pending_launch(&mut self, session_id: Option<&str>) -> Option<connector::LaunchConfig> {
        let sid = session_id
            .map(|s| s.to_string())
            .or_else(|| self.last_pending_session.clone())
            .or_else(|| self.pending_launches.keys().next().cloned())?;
        let config = self.pending_launches.remove(&sid)?;
        self.pending_statuses.remove(&sid);
        if self.last_pending_session.as_deref() == Some(sid.as_str()) {
            self.last_pending_session = self.pending_launches.keys().next().cloned();
        }
        Some(config)
    }

    fn refresh_last_active_session(&mut self, disconnected_session: &str) {
        if self.last_active_session.as_deref() != Some(disconnected_session) {
            return;
        }
        self.last_active_session = self
            .runners
            .iter()
            .find(|(_, handle)| handle.status.connected)
            .map(|(sid, _)| sid.clone())
            .or_else(|| {
                self.runners
                    .keys()
                    .find(|sid| sid.as_str() != disconnected_session)
                    .cloned()
            });
    }

    fn disconnect_session_id(&mut self, session_id: &str, _detail: &str) -> bool {
        let sid = session_id.trim();
        if sid.is_empty() {
            return false;
        }
        let mut changed = false;
        if let Some(handle) = self.runners.remove(sid) {
            handle.generation.fetch_add(1, Ordering::SeqCst);
            changed = true;
        }
        if self.pending_launches.remove(sid).is_some() {
            changed = true;
        }
        if self.pending_statuses.remove(sid).is_some() {
            changed = true;
        }
        if self.last_pending_session.as_deref() == Some(sid) {
            self.last_pending_session = self.pending_launches.keys().next().cloned();
        }
        self.refresh_last_active_session(sid);
        changed
    }
}

type SharedState = Arc<Mutex<ConnectorState>>;

#[tauri::command]
fn connector_status(state: State<'_, SharedState>) -> UiStatus {
    state.lock().unwrap().representative_status()
}

/// 返回全部会话状态（每个 session 一条），供多会话 UI 展示。
/// 若存在待选目录的待定启动，也附加一条 needs_project 记录。
#[tauri::command]
fn connector_sessions(state: State<'_, SharedState>) -> Vec<UiStatus> {
    let guard = state.lock().unwrap();
    let mut out: Vec<UiStatus> = guard.runners.values().map(|h| h.status.clone()).collect();
    out.extend(guard.pending_statuses.values().cloned());
    out
}

#[tauri::command]
fn connector_diagnostics(state: State<'_, SharedState>) -> String {
    let guard = state.lock().unwrap();
    let status = guard.representative_status();
    let session_count = guard.runners.len();
    let connected_count = guard
        .runners
        .values()
        .filter(|h| h.status.connected)
        .count();
    format!(
        "AutoCode Local Connector diagnostics\nversion={}\nmin_version={}\nsessions={}\nconnected_sessions={}\nstatus={}\nconnected={}\nrunning={}\nneeds_project={}\nserver={}\nsession={}\nproject={}\nws_url={}\nlast_heartbeat_at={}\nlast_error={}\ndetail={}",
        status.version,
        status.min_version,
        session_count,
        connected_count,
        status.status,
        status.connected,
        status.running,
        status.needs_project,
        status.server,
        status.session,
        status.project,
        status.redacted_ws_url,
        status.last_heartbeat_at,
        status.last_error,
        status.detail,
    )
}

#[tauri::command]
fn local_project_grants() -> Vec<connector::LocalProjectGrant> {
    connector::load_local_project_grants()
}

#[tauri::command]
fn open_local_project_grant(grant_id: String) -> Result<(), String> {
    let grants = connector::load_local_project_grants();
    let grant = grants
        .into_iter()
        .find(|item| item.grant_id == grant_id)
        .ok_or_else(|| "本地项目授权不存在或已清理".to_string())?;
    connector::open_url(&connector::grant_open_url(&grant))
}

fn workspace_url_for_grant(grant: &connector::LocalProjectGrant) -> Result<Url, String> {
    let url = connector::grant_open_url(grant);
    if url.trim().is_empty() {
        return Err("该本地目录已授权，但还没有 AutoCode 服务地址。请先从网页端连接一次，或在网页端打开“导入本地项目”。".to_string());
    }
    Url::parse(&url).map_err(|err| format!("invalid AutoCode workspace URL: {err}"))
}

fn pick_workspace_grant(
    state: &ConnectorState,
    grant_id: Option<&str>,
) -> Option<connector::LocalProjectGrant> {
    let grants = connector::load_local_project_grants();
    if grants.is_empty() {
        return None;
    }
    if let Some(grant_id) = grant_id.filter(|value| !value.trim().is_empty()) {
        if let Some(grant) = grants.iter().find(|grant| grant.grant_id == grant_id) {
            return Some(grant.clone());
        }
    }
    if let Some(session_id) = &state.last_active_session {
        if let Some(handle) = state.runners.get(session_id) {
            let active_grant_id = handle.config.grant_id.trim();
            if !active_grant_id.is_empty() {
                if let Some(grant) = grants
                    .iter()
                    .find(|grant| grant.grant_id == active_grant_id)
                {
                    return Some(grant.clone());
                }
            }
            let active_project = handle.config.project.trim();
            if !active_project.is_empty() {
                if let Some(grant) = grants
                    .iter()
                    .find(|grant| grant.project_root == active_project)
                {
                    return Some(grant.clone());
                }
            }
        }
    }
    grants.into_iter().next()
}

fn open_workspace_window<R: Runtime>(app: &tauri::AppHandle<R>, url: Url) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(AUTOCODE_WORKSPACE_WINDOW) {
        window
            .navigate(url)
            .map_err(|err| format!("failed to navigate AutoCode workspace: {err}"))?;
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, AUTOCODE_WORKSPACE_WINDOW, WebviewUrl::External(url))
        .title("AutoCode Workspace")
        .inner_size(1280.0, 820.0)
        .resizable(true)
        .focused(true)
        .build()
        .map_err(|err| format!("failed to open AutoCode workspace: {err}"))?;
    Ok(())
}

#[tauri::command]
async fn open_autocode_workspace<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, SharedState>,
    grant_id: Option<String>,
) -> Result<String, String> {
    let grant = {
        let guard = state.lock().unwrap();
        pick_workspace_grant(&guard, grant_id.as_deref())
    }
    .ok_or_else(|| "No authorized AutoCode project is available yet.".to_string())?;
    let url = workspace_url_for_grant(&grant)?;
    let opened = url.to_string();
    open_workspace_window(&app, url)?;
    Ok(opened)
}

#[tauri::command]
fn choose_local_project(
    state: State<'_, SharedState>,
    server_base: Option<String>,
) -> Result<connector::LocalProjectGrant, String> {
    let Some(project) = connector::pick_project_dir() else {
        return Err("Project selection was cancelled.".to_string());
    };
    let status = {
        let guard = state.lock().unwrap();
        guard.representative_status()
    };
    let grants = connector::load_local_project_grants();
    let server_base = if let Some(value) = server_base.filter(|value| !value.trim().is_empty()) {
        value.trim().trim_end_matches('/').to_string()
    } else if !status.server.trim().is_empty() {
        status.server.trim().trim_end_matches('/').to_string()
    } else {
        grants
            .iter()
            .find_map(|grant| {
                let server = grant.server_base.trim();
                if server.is_empty() {
                    None
                } else {
                    Some(server.to_string())
                }
            })
            .unwrap_or_default()
    };
    let open_url = grants
        .iter()
        .find_map(|grant| {
            let url = grant.open_url.trim();
            if url.is_empty() {
                None
            } else {
                Some(url.to_string())
            }
        })
        .unwrap_or_else(|| {
            if !status.server.trim().is_empty() {
                connector::local_import_open_url(
                    status.server.trim(),
                    "",
                    &project.to_string_lossy(),
                    "",
                )
            } else {
                String::new()
            }
        });
    connector::create_local_project_grant(&project, &server_base, &open_url)
}

#[tauri::command]
fn update_local_project_grant_server(
    grant_id: String,
    server_base: String,
) -> Result<connector::LocalProjectGrant, String> {
    connector::update_local_project_grant_server(&grant_id, &server_base)
}

#[tauri::command]
fn disconnect_session(
    state: State<'_, SharedState>,
    session_id: String,
) -> Result<UiStatus, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("session_id is required".to_string());
    }
    let mut guard = state.lock().unwrap();
    if !guard.disconnect_session_id(&sid, "Connection disconnected by user.") {
        return Err("session not found".to_string());
    }
    Ok(guard.representative_status())
}

#[tauri::command]
fn disconnect_all_sessions(state: State<'_, SharedState>) -> UiStatus {
    let mut guard = state.lock().unwrap();
    let runner_ids = guard.runners.keys().cloned().collect::<Vec<_>>();
    let pending_ids = guard.pending_launches.keys().cloned().collect::<Vec<_>>();
    for sid in runner_ids.iter().chain(pending_ids.iter()) {
        guard.disconnect_session_id(sid, "All connections disconnected by user.");
    }
    guard.representative_status()
}

#[tauri::command]
fn delete_local_project_grant(
    state: State<'_, SharedState>,
    grant_id: String,
) -> Result<UiStatus, String> {
    let removed = connector::remove_local_project_grant(&grant_id)?
        .ok_or_else(|| "本地项目授权不存在或已清理".to_string())?;
    let removed_grant_id = removed.grant_id.trim().to_string();
    let removed_project = removed.project_root.trim().to_string();
    let mut guard = state.lock().unwrap();
    let runner_ids = guard
        .runners
        .iter()
        .filter(|(_, handle)| {
            handle.config.grant_id == removed_grant_id
                || handle.config.project == removed_project
                || handle.status.project == removed_project
        })
        .map(|(sid, _)| sid.clone())
        .collect::<Vec<_>>();
    for sid in runner_ids {
        guard.disconnect_session_id(&sid, "Local project authorization was removed.");
    }
    let pending_ids = guard
        .pending_launches
        .iter()
        .filter(|(_, config)| {
            config.grant_id == removed_grant_id || config.project == removed_project
        })
        .map(|(sid, _)| sid.clone())
        .collect::<Vec<_>>();
    for sid in pending_ids {
        guard.disconnect_session_id(&sid, "Local project authorization was removed.");
    }
    Ok(guard.representative_status())
}

#[tauri::command]
fn choose_project_and_connect(state: State<'_, SharedState>) -> Result<UiStatus, String> {
    let config = {
        let mut guard = state.lock().unwrap();
        guard
            .take_pending_launch(None)
            .ok_or_else(|| "No browser connect request has been received yet.".to_string())?
    };
    let Some(project) = connector::pick_project_dir() else {
        // 用户取消选目录：把该 pending 塞回去，允许再次点击选择。
        let mut guard = state.lock().unwrap();
        let sid = config.session.clone();
        guard.pending_statuses.insert(
            sid.clone(),
            UiStatus {
                status: "project_required".to_string(),
                detail: "Project selection was cancelled. Please choose the local project folder to authorize.".to_string(),
                server: config.server.clone(),
                session: config.session.clone(),
                project: String::new(),
                redacted_ws_url: config.redacted_websocket_url().unwrap_or_default(),
                version: connector::VERSION.to_string(),
                min_version: config.min_version.clone(),
                last_error: String::new(),
                last_heartbeat_at: String::new(),
                connected: false,
                running: false,
                needs_project: true,
            },
        );
        guard.pending_launches.insert(sid.clone(), config);
        guard.last_pending_session = Some(sid);
        return Err("Project selection was cancelled.".to_string());
    };
    let session_id = config.session.clone();
    start_runner(state.inner().clone(), config, project)?;
    let guard = state.lock().unwrap();
    Ok(guard
        .runners
        .get(&session_id)
        .map(|handle| handle.status.clone())
        .unwrap_or_else(|| guard.representative_status()))
}

fn start_runner(
    state: SharedState,
    mut config: connector::LaunchConfig,
    project: PathBuf,
) -> Result<(), String> {
    let root = connector::resolve_authorized_root(&project.to_string_lossy())?;
    let session_id = config.session.clone();
    config.project = root.to_string_lossy().to_string();

    let (generation, gen_arc) = {
        let mut guard = state.lock().unwrap();
        // 若这次启动正是此前待选目录的那一个，清掉待定态。
        guard.pending_launches.remove(&session_id);
        guard.pending_statuses.remove(&session_id);
        if guard.last_pending_session.as_deref() == Some(session_id.as_str()) {
            guard.last_pending_session = guard.pending_launches.keys().next().cloned();
        }
        // 同一会话重连 → 递增其代次抢占旧循环；新会话 → 全新代次，互不影响。
        let (generation, gen_arc) = match guard.runners.get(&session_id) {
            Some(handle) => {
                let generation = handle.generation.fetch_add(1, Ordering::SeqCst) + 1;
                (generation, handle.generation.clone())
            }
            None => (1u64, Arc::new(AtomicU64::new(1))),
        };
        let status = UiStatus {
            status: "connecting".to_string(),
            detail: "Project selected. Connecting to AutoCode...".to_string(),
            server: config.server.clone(),
            session: session_id.clone(),
            project: root.to_string_lossy().to_string(),
            redacted_ws_url: config.redacted_websocket_url().unwrap_or_default(),
            version: connector::VERSION.to_string(),
            min_version: config.min_version.clone(),
            last_error: String::new(),
            last_heartbeat_at: String::new(),
            connected: false,
            running: true,
            needs_project: false,
        };
        guard.runners.insert(
            session_id.clone(),
            RunnerHandle {
                status,
                config: config.clone(),
                generation: gen_arc.clone(),
            },
        );
        guard.last_active_session = Some(session_id.clone());
        (generation, gen_arc)
    };

    let session_for_thread = session_id;
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(err) => {
                let mut guard = state.lock().unwrap();
                if let Some(handle) = guard.runners.get_mut(&session_for_thread) {
                    handle.status.detail = format!("Failed to start async runtime: {err}");
                }
                return;
            }
        };
        let state_for_updates = state.clone();
        let gen_for_updates = gen_arc.clone();
        let sid_for_updates = session_for_thread.clone();
        let result = rt.block_on(connector::run_connector_loop(
            config,
            root,
            generation,
            gen_arc.clone(),
            move |snapshot| {
                // 已被同会话的更新连接接管时，丢弃过期回调，避免覆盖新循环状态。
                if gen_for_updates.load(Ordering::SeqCst) != generation {
                    return;
                }
                let is_connected = snapshot.connected;
                let mut guard = state_for_updates.lock().unwrap();
                let min_version = guard
                    .runners
                    .get(&sid_for_updates)
                    .map(|h| h.config.min_version.clone())
                    .unwrap_or_default();
                if let Some(handle) = guard.runners.get_mut(&sid_for_updates) {
                    handle.status = UiStatus {
                        status: snapshot.status,
                        detail: snapshot.detail,
                        server: snapshot.server,
                        session: snapshot.session,
                        project: snapshot.project,
                        redacted_ws_url: snapshot.redacted_ws_url,
                        version: snapshot.version,
                        min_version,
                        last_error: snapshot.last_error,
                        last_heartbeat_at: snapshot.last_heartbeat_at,
                        connected: snapshot.connected,
                        running: snapshot.running,
                        needs_project: false,
                    };
                }
                if is_connected {
                    guard.last_active_session = Some(sid_for_updates.clone());
                }
            },
        ));
        // 只有仍是当前代次时才回写终态，否则说明该会话已被新连接接管。
        if gen_arc.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut guard = state.lock().unwrap();
        if let Some(handle) = guard.runners.get_mut(&session_for_thread) {
            match result {
                Ok(()) => {
                    handle.status.connected = false;
                    handle.status.running = false;
                    if handle.status.status != "ready" {
                        handle.status.status = "ready".to_string();
                        handle.status.detail = "Ready. Waiting for browser launch.".to_string();
                    }
                }
                Err(err) => {
                    handle.status.status = "error".to_string();
                    handle.status.detail = err;
                    handle.status.connected = false;
                    handle.status.running = false;
                }
            }
        }
    });
    Ok(())
}

fn set_pending_project_required(
    state: &SharedState,
    config: &connector::LaunchConfig,
    detail: String,
    last_error: String,
) {
    let mut guard = state.lock().unwrap();
    let sid = config.session.clone();
    guard.pending_launches.insert(sid.clone(), config.clone());
    guard.pending_statuses.insert(
        sid.clone(),
        UiStatus {
            status: "project_required".to_string(),
            detail,
            server: config.server.clone(),
            session: config.session.clone(),
            project: String::new(),
            redacted_ws_url: config.redacted_websocket_url().unwrap_or_default(),
            version: connector::VERSION.to_string(),
            min_version: config.min_version.clone(),
            last_error,
            last_heartbeat_at: String::new(),
            connected: false,
            running: false,
            needs_project: true,
        },
    );
    guard.last_pending_session = Some(sid);
}

fn handle_deep_link<R: Runtime>(app: &tauri::AppHandle<R>, raw: &str) {
    let state = app.state::<SharedState>().inner().clone();
    match connector::LaunchConfig::from_deep_link(raw).and_then(|config| {
        let _ = config.websocket_url()?;
        Ok(config)
    }) {
        Ok(config) => {
            if config.needs_project_selection() {
                set_pending_project_required(
                    &state,
                    &config,
                    "Browser request received. Please choose the local project folder to authorize.".to_string(),
                    String::new(),
                );
                return;
            }
            let project = PathBuf::from(config.project.clone());
            if let Err(err) = start_runner(state.clone(), config.clone(), project) {
                set_pending_project_required(
                    &state,
                    &config,
                    format!("{err}. Please choose the project folder manually."),
                    err,
                );
            } else if !config.grant_id.trim().is_empty() {
                if let Some(grant) = connector::load_local_project_grants()
                    .into_iter()
                    .find(|grant| grant.grant_id == config.grant_id)
                {
                    if let Ok(url) = workspace_url_for_grant(&grant) {
                        let _ = open_workspace_window(app, url);
                    }
                }
            }
        }
        Err(error) => {
            let mut guard = state.lock().unwrap();
            let sid = format!(
                "invalid-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            );
            guard.pending_statuses.insert(
                sid.clone(),
                UiStatus {
                    status: "error".to_string(),
                    detail: format!("Invalid connect request: {error}"),
                    last_error: error,
                    session: sid.clone(),
                    ..idle_status()
                },
            );
            guard.last_pending_session = Some(sid);
        }
    }
}

fn start_device_presence_loop(state: SharedState) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        // 单路设备通道即可接收面向多个 task/项目的 connect_request，
        // 每个请求都 spawn 一路独立 runner（按 session_id 去重/抢占）。
        let _ = rt.block_on(connector::run_device_presence_loop(move |config| {
            if config.needs_project_selection() {
                set_pending_project_required(
                    &state,
                    &config,
                    "Browser request received. Please choose the local project folder to authorize.".to_string(),
                    String::new(),
                );
                return;
            }
            let project = PathBuf::from(config.project.clone());
            if let Err(err) = start_runner(state.clone(), config.clone(), project) {
                set_pending_project_required(
                    &state,
                    &config,
                    format!("{err}. Please choose the project folder manually."),
                    err,
                );
            }
        }));
    });
}

fn main() {
    let shared_state: SharedState = Arc::new(Mutex::new(ConnectorState::default()));
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv {
                if arg.starts_with("muhuo-autocode://") {
                    handle_deep_link(app, &arg);
                    handle_ide_deep_link(app, &arg);
                }
            }
        }));
    }

    builder
        .manage(shared_state)
        .manage(IdeRuntimeState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            start_device_presence_loop(app.state::<SharedState>().inner().clone());
            start_ide_local_server(handle.clone());
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    handle_deep_link(&handle, url.as_str());
                    handle_ide_deep_link(&handle, url.as_str());
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&handle, url.as_str());
                    handle_ide_deep_link(&handle, url.as_str());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connector_status,
            connector_sessions,
            connector_diagnostics,
            choose_local_project,
            update_local_project_grant_server,
            disconnect_session,
            disconnect_all_sessions,
            delete_local_project_grant,
            choose_project_and_connect,
            local_project_grants,
            open_local_project_grant,
            open_autocode_workspace,
            ide_play_notification_sound,
            ide_bootstrap,
            ide_initialize_autocode_project_files,
            ide_save_settings,
            ide_pick_workspace,
            ide_open_workspace,
            ide_list_workspace,
            ide_workspace_file_index,
            ide_read_workspace_file,
            ide_save_workspace_file,
            ide_run_workspace_command,
            ide_git_status,
            ide_git_init,
            ide_git_stage,
            ide_git_unstage,
            ide_git_commit,
            ide_git_file_diff,
            ide_git_commit_show,
            ide_session_load,
            ide_session_save,
            ide_session_clear,
            ide_api_request,
            ide_ai_request,
            ide_ai_cancel,
            ide_agent_run,
            ide_agent_session_create,
            ide_agent_session_fork,
            ide_agent_session_start,
            ide_agent_message_send,
            ide_agent_send,
            ide_agent_continue,
            ide_agent_compact_session,
            ide_agent_checkpoint_create,
            ide_agent_checkpoint_revert,
            ide_agent_memory_read,
            ide_agent_memory_apply,
            ide_agent_memory_update,
            ide_agent_plan_save,
            ide_agent_profiles,
            ide_agent_processes,
            ide_agent_process_kill,
            ide_agent_subagent_run,
            ide_agent_tools,
            ide_agent_tool_approve,
            ide_agent_approve,
            ide_agent_sessions,
            ide_agent_session_delete,
            ide_agent_smoke_check,
            ide_agent_session_snapshot,
            ide_agent_cancel,
            ide_agent_apply_patch,
            ide_agent_session_state,
            ide_local_server_status,
            ide_channels_list,
            ide_channel_save,
            ide_channel_delete,
            ide_channel_test,
            ide_channel_refresh_models,
            ide_channel_account_status,
            ide_provider_route,
            ide_code_completion,
            ide_format_workspace_content,
            ide_hook_run,
            ide_mcp_servers,
            ide_lsp_request,
            ide_list_provider_models,
            ide_provider_model_refresh,
            ide_provider_account_status,
            ide_test_provider,
            ide_pick_attachments,
            ide_read_attachment_preview,
            ide_voice_record_start,
            ide_voice_record_stop,
            ide_offline_stt_status,
            ide_offline_stt_download_model,
            ide_offline_stt_cancel_download,
            ide_offline_stt_transcribe,
            ide_windows_speech_transcribe,
            ide_transcribe_audio,
            ide_pty_start,
            ide_pty_write,
            ide_pty_probe,
            ide_pty_resize,
            ide_pty_kill,
            ide_terminal_start,
            ide_terminal_write,
            ide_terminal_resize,
            ide_terminal_kill,
            ide_terminal_set_default_shell,
            ide_update_check,
            ide_update_install,
            ide_create_workspace_entry,
            ide_rename_workspace_entry,
            ide_delete_workspace_entry,
            ide_search_workspace,
            ide_stat_workspace_file,
            ide_open_path,
            ide_open_url,
            ide_shell_execute,
            ide_reload_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(session: &str, project: &str, connected: bool, needs_project: bool) -> UiStatus {
        UiStatus {
            status: if needs_project {
                "project_required"
            } else {
                "connected"
            }
            .to_string(),
            detail: String::new(),
            server: "http://localhost:8000".to_string(),
            session: session.to_string(),
            project: project.to_string(),
            redacted_ws_url: String::new(),
            version: connector::VERSION.to_string(),
            min_version: String::new(),
            last_error: String::new(),
            last_heartbeat_at: String::new(),
            connected,
            running: connected,
            needs_project,
        }
    }

    #[test]
    fn representative_status_prefers_pending_project_request() {
        let mut state = ConnectorState::default();
        state.runners.insert(
            "connected-session".to_string(),
            RunnerHandle {
                status: status("connected-session", "D:\\Github", true, false),
                config: connector::LaunchConfig {
                    session: "connected-session".to_string(),
                    project: "D:\\Github".to_string(),
                    ..Default::default()
                },
                generation: Arc::new(AtomicU64::new(1)),
            },
        );
        state.last_active_session = Some("connected-session".to_string());
        state.pending_statuses.insert(
            "pending-session".to_string(),
            status("pending-session", "", false, true),
        );
        state.last_pending_session = Some("pending-session".to_string());

        let representative = state.representative_status();

        assert_eq!(representative.session, "pending-session");
        assert!(representative.needs_project);
    }
}
