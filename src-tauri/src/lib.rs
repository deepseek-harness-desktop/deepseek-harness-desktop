mod harness;
mod plugins;

use harness::{HarnessController, HarnessLaunchInfo, HarnessStatus, RuntimeStatus};
use plugins::{InstalledPlugin, PluginCatalogItem, PluginManager, PluginOperation};
use tauri::{AppHandle, Manager, State, WindowEvent};

#[derive(Default)]
pub struct AppState {
    harness: HarnessController,
    plugins: PluginManager,
}

#[tauri::command]
fn list_plugin_catalog(state: State<'_, AppState>) -> Vec<PluginCatalogItem> {
    state.plugins.catalog()
}

#[tauri::command]
fn list_installed_plugins(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledPlugin>, String> {
    state.plugins.installed(&app)
}

#[tauri::command]
fn start_harness(app: AppHandle, state: State<'_, AppState>) -> Result<HarnessLaunchInfo, String> {
    state.harness.start(&app)
}

#[tauri::command]
fn stop_harness(state: State<'_, AppState>) -> Result<(), String> {
    state.harness.stop()
}

#[tauri::command]
fn get_harness_status(state: State<'_, AppState>) -> HarnessStatus {
    state.harness.status()
}

#[tauri::command]
fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    harness::runtime_status(&app)
}

#[tauri::command]
fn install_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<PluginOperation, String> {
    state.plugins.start_operation(
        &app,
        state.harness.clone(),
        &id,
        plugins::PluginAction::Install,
    )
}

#[tauri::command]
fn remove_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<PluginOperation, String> {
    state.plugins.start_operation(
        &app,
        state.harness.clone(),
        &id,
        plugins::PluginAction::Remove,
    )
}

#[tauri::command]
fn update_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<PluginOperation, String> {
    state.plugins.start_operation(
        &app,
        state.harness.clone(),
        &id,
        plugins::PluginAction::Update,
    )
}

#[tauri::command]
fn get_plugin_operation(state: State<'_, AppState>, id: String) -> Result<PluginOperation, String> {
    state.plugins.operation(&id)
}

#[tauri::command]
fn read_plugin_log(state: State<'_, AppState>, id: String) -> Result<String, String> {
    state.plugins.log(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_plugin_catalog,
            list_installed_plugins,
            start_harness,
            stop_harness,
            get_harness_status,
            get_runtime_status,
            install_plugin,
            remove_plugin,
            update_plugin,
            get_plugin_operation,
            read_plugin_log
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                let state = window.app_handle().state::<AppState>();
                let _ = state.plugins.stop();
                let _ = state.harness.stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
