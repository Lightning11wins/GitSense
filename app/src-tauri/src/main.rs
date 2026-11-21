#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod machines;
mod settings;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use gitsense_client::{ClientEvent, ConnectOptions, Connection, HelperBinary, Transport};
use gitsense_protocol::Event;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::Mutex;

static HELPER: &[u8] = include_bytes!(env!("GITSENSE_HELPER_PATH"));

struct AppState {
    helper: HelperBinary,
    /// Connections by window label. One machine per window.
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    next_window: AtomicUsize,
    settings: settings::Store,
    /// Webview storage, kept with the config so separate config dirs do not share it.
    webview_dir: PathBuf,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WindowEventPayload {
    Helper { event: Event },
    Disconnected { reason: String },
}

#[derive(Serialize)]
struct ConnectedInfo {
    machine: machines::Machine,
    helper_version: String,
    git_version: String,
    home: String,
}

#[tauri::command]
fn list_machines() -> Vec<machines::Machine> {
    machines::list()
}

#[tauri::command]
fn settings(state: tauri::State<'_, AppState>) -> settings::Settings {
    state.settings.get()
}

/// Saves the auto-fetch interval and sends the new settings to every window.
#[tauri::command]
fn set_auto_fetch_minutes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    minutes: u32,
) -> Result<(), String> {
    state.settings.update(|s| s.auto_fetch_minutes = minutes);
    app.emit("settings", state.settings.get()).map_err(|e| e.to_string())
}

#[tauri::command]
fn last_machine(state: tauri::State<'_, AppState>) -> Option<String> {
    state.settings.get().last_machine
}

#[tauri::command]
async fn connect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    machine_id: String,
) -> Result<ConnectedInfo, String> {
    let machine = machines::find(&machine_id).ok_or_else(|| format!("Failed to find machine '{machine_id}'."))?;
    let transport = match &machine.host {
        None => Transport::Local,
        Some(host) => Transport::Ssh { host: host.clone() },
    };
    let mut options = ConnectOptions::default();
    if let Some(home) = std::env::var_os("GITSENSE_HOME") {
        options.env.push(("GITSENSE_HOME".into(), home.to_string_lossy().into_owned()));
    }
    let label = window.label().to_string();
    state.connections.lock().await.remove(&label);
    let (connection, mut events) =
        gitsense_client::connect(&transport, &state.helper, &options).await.map_err(|e| e.to_string())?;
    let info = connection.info().clone();
    state.connections.lock().await.insert(label.clone(), Arc::new(connection));
    state.settings.update(|s| s.last_machine = Some(machine.id.clone()));

    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let payload = match event {
                ClientEvent::Helper(event) => WindowEventPayload::Helper { event },
                ClientEvent::Disconnected { reason } => WindowEventPayload::Disconnected { reason },
            };
            let _ = app.emit_to(EventTarget::webview_window(&label), "gitsense", payload);
        }
    });
    window.set_title(&format!("{} - GitSense", machine.label)).map_err(|e| e.to_string())?;
    Ok(ConnectedInfo { machine, helper_version: info.helper_version, git_version: info.git_version, home: info.home })
}

/// Relays a protocol request from the window's UI to its machine's helper.
#[tauri::command]
async fn request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let connection = state
        .connections
        .lock()
        .await
        .get(window.label())
        .cloned()
        .ok_or_else(|| format!("Failed to call '{method}': not connected."))?;
    connection.call_raw(&method, params).await.map_err(|e| e.to_string())
}

/// Text on the system clipboard, or None when it holds no text. Unlike the webview's clipboard API, this
/// reads text copied from other programs.
#[tauri::command]
async fn read_clipboard(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_text(move |_, text| {
            let _ = send.send(text.map(String::from));
        });
    })
    .map_err(|e| format!("Failed to read the clipboard: {e}"))?;
    receive.await.map_err(|e| format!("Failed to read the clipboard: {e}"))
}

#[tauri::command]
fn new_window(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    open_window(&app, &state, false).map_err(|e| e.to_string())
}

fn open_window(app: &tauri::AppHandle, state: &AppState, auto_connect: bool) -> tauri::Result<()> {
    let n = state.next_window.fetch_add(1, Ordering::Relaxed);
    let url = if auto_connect { "index.html?autoconnect=1" } else { "index.html" };
    WebviewWindowBuilder::new(app, format!("window-{n}"), WebviewUrl::App(url.into()))
        .title("GitSense")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 500.0)
        .data_directory(state.webview_dir.clone())
        .build()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let (config_dir, webview_dir) = match std::env::var_os("GITSENSE_CONFIG_DIR") {
                Some(dir) => (PathBuf::from(&dir), PathBuf::from(dir).join("webview")),
                None => (app.path().app_config_dir()?, app.path().app_local_data_dir()?),
            };
            app.manage(AppState {
                helper: HelperBinary::new(HELPER),
                connections: Mutex::new(HashMap::new()),
                next_window: AtomicUsize::new(1),
                settings: settings::Store::load(config_dir.join("settings.json")),
                webview_dir,
            });
            open_window(app.handle(), &app.state::<AppState>(), true)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                let label = window.label().to_string();
                tauri::async_runtime::block_on(state.connections.lock()).remove(&label);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_machines,
            settings,
            set_auto_fetch_minutes,
            last_machine,
            connect,
            request,
            read_clipboard,
            new_window
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run GitSense");
}
