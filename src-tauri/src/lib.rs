mod core;
mod harness;
mod plugins;

use core::{CoreActionResult, CoreManager, CoreVersion};
use harness::{HarnessController, HarnessLaunchInfo, HarnessStatus, RuntimeStatus};
use plugins::{InstalledPlugin, PluginCatalogItem, PluginManager, PluginOperation};
use tauri::{AppHandle, Manager, State, WindowEvent};

#[derive(Default)]
pub struct AppState {
    cores: CoreManager,
    harness: HarnessController,
    plugins: PluginManager,
}

#[tauri::command]
fn list_core_versions(app: AppHandle, state: State<'_, AppState>) -> Vec<CoreVersion> {
    state.cores.versions(&app)
}

#[tauri::command]
async fn install_core(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<CoreVersion, String> {
    let manager = state.cores.clone();
    tauri::async_runtime::spawn_blocking(move || manager.install(&app, &id))
        .await
        .map_err(|error| format!("核心版本安装任务失败：{error}"))?
}

#[tauri::command]
fn activate_core(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<CoreActionResult, String> {
    switch_core(&app, &state, &id)
}

#[tauri::command]
async fn upgrade_core(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CoreActionResult, String> {
    let id = state
        .cores
        .latest_id(&app)
        .ok_or_else(|| "当前平台没有可用的 Harness 核心版本".to_string())?;
    let should_install = id != "builtin"
        && !state
            .cores
            .versions(&app)
            .into_iter()
            .any(|version| version.id == id && version.installed);
    if should_install {
        let manager = state.cores.clone();
        let app_for_download = app.clone();
        let id_for_download = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            manager.install(&app_for_download, &id_for_download)
        })
        .await
        .map_err(|error| format!("核心版本升级任务失败：{error}"))??;
    }
    switch_core(&app, &state, &id)
}

#[tauri::command]
fn remove_core(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.cores.remove(&app, &id)
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

fn switch_core(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &str,
) -> Result<CoreActionResult, String> {
    let previous_id = state.cores.active_id(app);
    if previous_id == id {
        return Ok(CoreActionResult {
            version: state.cores.active_version(app),
            restarted: false,
            launch: None,
        });
    }
    let was_running = state.harness.is_running();
    if was_running {
        state.harness.stop()?;
    }
    if let Err(error) = state.cores.activate(app, id) {
        if was_running {
            let _ = state.harness.start(app);
        }
        return Err(error);
    }

    let launch = if was_running {
        match state.harness.start(app) {
            Ok(launch) => Some(launch),
            Err(error) => {
                let rollback = state.cores.activate(app, &previous_id);
                let recovery = state.harness.start(app);
                let recovery_message = match (rollback, recovery) {
                    (Ok(_), Ok(_)) => "已自动恢复原核心版本和 Harness 服务".to_string(),
                    (Err(rollback_error), _) => {
                        format!("原核心版本恢复失败：{rollback_error}")
                    }
                    (_, Err(recovery_error)) => {
                        format!("原 Harness 服务恢复失败：{recovery_error}")
                    }
                };
                return Err(format!("新核心版本启动失败：{error}；{recovery_message}"));
            }
        }
    } else {
        None
    };

    Ok(CoreActionResult {
        version: state.cores.active_version(app),
        restarted: was_running,
        launch,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_core_versions,
            install_core,
            activate_core,
            upgrade_core,
            remove_core,
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
