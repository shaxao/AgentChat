#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;

mod connector;

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

struct ConnectorState {
    status: UiStatus,
    last_launch: Option<connector::LaunchConfig>,
    // 当前活跃会话的代次。每次浏览器唤起新连接都会递增，旧的连接循环
    // 侦测到代次变化后会优雅断开退出，从而实现会话的无缝切换。
    active_generation: Arc<AtomicU64>,
}

impl Default for ConnectorState {
    fn default() -> Self {
        Self {
            status: UiStatus {
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
            },
            last_launch: None,
            active_generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

type SharedState = Arc<Mutex<ConnectorState>>;

#[tauri::command]
fn connector_status(state: State<'_, SharedState>) -> UiStatus {
    state.lock().unwrap().status.clone()
}

#[tauri::command]
fn connector_diagnostics(state: State<'_, SharedState>) -> String {
    let guard = state.lock().unwrap();
    let status = &guard.status;
    format!(
        "AutoCode Local Connector diagnostics\nversion={}\nmin_version={}\nstatus={}\nconnected={}\nrunning={}\nneeds_project={}\nserver={}\nsession={}\nproject={}\nws_url={}\nlast_heartbeat_at={}\nlast_error={}\ndetail={}",
        status.version,
        status.min_version,
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

#[tauri::command]
fn choose_project_and_connect(state: State<'_, SharedState>) -> Result<UiStatus, String> {
    let config = {
        let guard = state.lock().unwrap();
        guard
            .last_launch
            .clone()
            .ok_or_else(|| "No browser connect request has been received yet.".to_string())?
    };
    let Some(project) = connector::pick_project_dir() else {
        return Err("Project selection was cancelled.".to_string());
    };
    start_runner(state.inner().clone(), config, project)?;
    Ok(state.lock().unwrap().status.clone())
}

fn start_runner(state: SharedState, mut config: connector::LaunchConfig, project: PathBuf) -> Result<(), String> {
    let root = connector::resolve_authorized_root(&project.to_string_lossy())?;
    let (generation, active_generation) = {
        let mut guard = state.lock().unwrap();
        // 递增代次即抢占：任何仍在运行的旧循环会侦测到代次变化并退出。
        let generation = guard.active_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let active_generation = guard.active_generation.clone();
        config.project = root.to_string_lossy().to_string();
        guard.last_launch = Some(config.clone());
        guard.status = UiStatus {
            status: "connecting".to_string(),
            detail: "Project selected. Connecting to AutoCode...".to_string(),
            server: config.server.clone(),
            session: config.session.clone(),
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
        (generation, active_generation)
    };

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(err) => {
                state.lock().unwrap().status.detail = format!("Failed to start async runtime: {err}");
                return;
            }
        };
        let state_for_updates = state.clone();
        let gen_for_updates = active_generation.clone();
        let result = rt.block_on(connector::run_connector_loop(
            config,
            root,
            generation,
            active_generation.clone(),
            move |snapshot| {
                // 已被更新的会话接管时，丢弃过期回调，避免覆盖新会话状态。
                if gen_for_updates.load(Ordering::SeqCst) != generation {
                    return;
                }
                let mut guard = state_for_updates.lock().unwrap();
                guard.status = UiStatus {
                    status: snapshot.status,
                    detail: snapshot.detail,
                    server: snapshot.server,
                    session: snapshot.session,
                    project: snapshot.project,
                    redacted_ws_url: snapshot.redacted_ws_url,
                    version: snapshot.version,
                    min_version: guard.last_launch.as_ref().map(|c| c.min_version.clone()).unwrap_or_default(),
                    last_error: snapshot.last_error,
                    last_heartbeat_at: snapshot.last_heartbeat_at,
                    connected: snapshot.connected,
                    running: snapshot.running,
                    needs_project: false,
                };
            },
        ));
        // 只有仍是当前代次时才回写终态，否则说明已被新会话接管。
        if active_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut guard = state.lock().unwrap();
        match result {
            Ok(()) => {
                guard.status.connected = false;
                guard.status.running = false;
                if guard.status.status != "ready" {
                    guard.status.status = "ready".to_string();
                    guard.status.detail = "Ready. Waiting for browser launch.".to_string();
                }
            }
            Err(err) => {
                guard.status.status = "error".to_string();
                guard.status.detail = err;
                guard.status.connected = false;
                guard.status.running = false;
            }
        }
    });
    Ok(())
}

fn handle_deep_link<R: Runtime>(app: &tauri::AppHandle<R>, raw: &str) {
    let state = app.state::<SharedState>().inner().clone();
    match connector::LaunchConfig::from_deep_link(raw).and_then(|config| {
        let _ = config.websocket_url()?;
        Ok(config)
    }) {
        Ok(config) => {
            if config.needs_project_selection() {
                let mut guard = state.lock().unwrap();
                guard.last_launch = Some(config.clone());
                guard.status = UiStatus {
                    status: "project_required".to_string(),
                    detail: "Browser request received. Please choose the local project folder to authorize.".to_string(),
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
                };
                return;
            }
            let project = PathBuf::from(config.project.clone());
            if let Err(err) = start_runner(state.clone(), config.clone(), project) {
                let mut guard = state.lock().unwrap();
                guard.last_launch = Some(config.clone());
                guard.status = UiStatus {
                    status: "project_required".to_string(),
                    detail: format!("{err}. Please choose the project folder manually."),
                    server: config.server.clone(),
                    session: config.session.clone(),
                    project: String::new(),
                    redacted_ws_url: config.redacted_websocket_url().unwrap_or_default(),
                    version: connector::VERSION.to_string(),
                    min_version: config.min_version.clone(),
                    last_error: err,
                    last_heartbeat_at: String::new(),
                    connected: false,
                    running: false,
                    needs_project: true,
                };
            }
        }
        Err(error) => {
            let mut guard = state.lock().unwrap();
            guard.status.status = "error".to_string();
            guard.status.detail = format!("Invalid connect request: {error}");
            guard.status.last_error = error;
            guard.status.connected = false;
            guard.status.running = false;
        }
    }
}

fn start_device_presence_loop(state: SharedState) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let _ = rt.block_on(connector::run_device_presence_loop(move |config| {
            let project = PathBuf::from(config.project.clone());
            let _ = start_runner(state.clone(), config, project);
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
                }
            }
        }));
    }

    builder
        .manage(shared_state)
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            start_device_presence_loop(app.state::<SharedState>().inner().clone());
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    handle_deep_link(&handle, url.as_str());
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&handle, url.as_str());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connector_status,
            connector_diagnostics,
            choose_project_and_connect,
            local_project_grants,
            open_local_project_grant
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
