use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::harness::{runtime_dsh_entry, runtime_environment, runtime_node, HarnessController};

const CATALOG_JSON: &str = include_str!("../resources/plugin-catalog.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub source_url: String,
    pub install_spec: String,
    pub package_name: String,
    pub version: String,
    pub category: String,
    pub dsh_version_range: String,
    pub platforms: Vec<String>,
    pub capabilities: Vec<String>,
    pub license: String,
    pub verified_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub package_name: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PluginOperation {
    #[serde(rename = "running")]
    Running { operation_id: String, log_path: String },
    #[serde(rename = "success")]
    Success { operation_id: String, requires_restart: bool },
    #[serde(rename = "failed")]
    Failed { operation_id: String, message: String, log_path: String },
}

#[derive(Clone, Copy)]
pub enum PluginAction {
    Install,
    Remove,
    Update,
}

#[derive(Clone)]
pub struct PluginManager {
    catalog: Arc<Vec<PluginCatalogItem>>,
    operations: Arc<Mutex<HashMap<String, PluginOperation>>>,
    log_paths: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl Default for PluginManager {
    fn default() -> Self {
        let catalog = serde_json::from_str(CATALOG_JSON).unwrap_or_default();
        Self {
            catalog: Arc::new(catalog),
            operations: Arc::new(Mutex::new(HashMap::new())),
            log_paths: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl PluginManager {
    pub fn catalog(&self) -> Vec<PluginCatalogItem> {
        self.catalog.as_ref().clone()
    }

    pub fn installed(&self, app: &AppHandle) -> Result<Vec<InstalledPlugin>, String> {
        let profile = profile_dir(app)?;
        let mut installed = Vec::new();
        for plugin in self.catalog.iter() {
            let package_json = profile
                .join("node_modules")
                .join(&plugin.package_name)
                .join("package.json");
            let Ok(content) = fs::read_to_string(package_json) else { continue };
            let Ok(package) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
            let version = package
                .get("version")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&plugin.version)
                .to_string();
            installed.push(InstalledPlugin {
                id: plugin.id.clone(),
                name: plugin.name.clone(),
                package_name: plugin.package_name.clone(),
                version,
            });
        }
        Ok(installed)
    }

    pub fn start_operation(
        &self,
        app: &AppHandle,
        harness: HarnessController,
        id: &str,
        action: PluginAction,
    ) -> Result<PluginOperation, String> {
        let plugin = self
            .catalog
            .iter()
            .find(|plugin| plugin.id == id)
            .cloned()
            .ok_or_else(|| format!("插件不在精选清单中：{id}"))?;
        let operation_id = format!("{}-{}", plugin.id, timestamp());
        let log_path = operation_log_path(app, &operation_id)?;
        let running = PluginOperation::Running {
            operation_id: operation_id.clone(),
            log_path: log_path.display().to_string(),
        };
        self.operations
            .lock()
            .map_err(|_| "插件操作状态锁不可用".to_string())?
            .insert(operation_id.clone(), running.clone());
        self.log_paths
            .lock()
            .map_err(|_| "插件日志状态锁不可用".to_string())?
            .insert(operation_id.clone(), log_path.clone());

        let manager = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            let result = perform_operation(&app, &harness, &plugin, action, &log_path);
            let operation = match result {
                Ok(requires_restart) => PluginOperation::Success {
                    operation_id: operation_id.clone(),
                    requires_restart,
                },
                Err(message) => PluginOperation::Failed {
                    operation_id: operation_id.clone(),
                    message,
                    log_path: log_path.display().to_string(),
                },
            };
            if let Ok(mut operations) = manager.operations.lock() {
                operations.insert(operation_id, operation);
            }
        });

        Ok(running)
    }

    pub fn operation(&self, id: &str) -> Result<PluginOperation, String> {
        self.operations
            .lock()
            .map_err(|_| "插件操作状态锁不可用".to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("找不到插件操作：{id}"))
    }

    pub fn log(&self, id: &str) -> Result<String, String> {
        let path = self
            .log_paths
            .lock()
            .map_err(|_| "插件日志状态锁不可用".to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("找不到插件日志：{id}"))?;
        fs::read_to_string(path).map_err(|error| format!("无法读取插件日志：{error}"))
    }
}

fn perform_operation(
    app: &AppHandle,
    harness: &HarnessController,
    plugin: &PluginCatalogItem,
    action: PluginAction,
    log_path: &PathBuf,
) -> Result<bool, String> {
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("无法创建插件操作日志：{error}"))?;
    writeln!(log, "插件：{} v{}", plugin.name, plugin.version).ok();
    writeln!(log, "来源：{}", plugin.source_url).ok();
    writeln!(log, "操作：{}", action_label(action)).ok();

    let was_running = harness.is_running();
    if was_running {
        writeln!(log, "停止 Harness 以更新 web profile...").ok();
        harness.stop()?;
    }

    let result = run_dsh_plugin_command(app, plugin, action, log_path);
    if result.is_err() {
        if was_running {
            let _ = harness.start(app);
        }
        return result.map(|_| false);
    }

    if was_running {
        writeln!(log, "重新启动 Harness...").ok();
        harness.start(app).map_err(|error| format!("插件已写入，但 Harness 重启失败：{error}"))?;
    }
    Ok(false)
}

fn run_dsh_plugin_command(
    app: &AppHandle,
    plugin: &PluginCatalogItem,
    action: PluginAction,
    log_path: &PathBuf,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let dsh_home = data_dir.join("dsh");
    fs::create_dir_all(&dsh_home).map_err(|error| format!("无法创建 DSH_HOME：{error}"))?;
    let node = runtime_node(app);
    let dsh_entry = runtime_dsh_entry(app);
    let action_arg = match action {
        PluginAction::Install => "add",
        PluginAction::Remove => "remove",
        PluginAction::Update => "update",
    };
    let package_arg = match action {
        PluginAction::Install => plugin.install_spec.as_str(),
        PluginAction::Remove | PluginAction::Update => plugin.package_name.as_str(),
    };
    let mut command = Command::new(&node);
    command
        .arg(&dsh_entry)
        .args(["plugin", "--profile", "web", action_arg, package_arg])
        .current_dir(&data_dir)
        .env("DSH_HOME", &dsh_home)
        .env("DSH_NODE_PATH", &node)
        .env("DSH_DESKTOP_RUNTIME", "1")
        .envs(runtime_environment(&node, app))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    writeln!(
        OpenOptions::new().append(true).open(log_path).map_err(|error| format!("无法写入插件日志：{error}"))?,
        "执行：node <dsh-entry> plugin --profile web {action_arg} {package_arg}"
    )
    .ok();
    let mut child = command.spawn().map_err(|error| format!("无法启动插件安装命令：{error}"))?;
    let log = Arc::new(Mutex::new(
        OpenOptions::new().append(true).open(log_path).map_err(|error| format!("无法打开插件日志：{error}"))?,
    ));
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(spawn_reader(stdout, log.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(spawn_reader(stderr, log));
    }
    let status = child.wait().map_err(|error| format!("插件命令等待失败：{error}"))?;
    for reader in readers {
        let _ = reader.join();
    }
    if !status.success() {
        return Err(format!("插件命令退出码：{status}"));
    }
    Ok(())
}

fn spawn_reader<R: std::io::Read + Send + 'static>(reader: R, log: Arc<Mutex<File>>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let line = redact_sensitive(&line);
            if let Ok(mut file) = log.lock() {
                let _ = writeln!(file, "{line}");
            }
        }
    })
}

fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(data_dir.join("dsh/profiles/web"))
}

fn operation_log_path(app: &AppHandle, operation_id: &str) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建插件日志目录：{error}"))?;
    Ok(log_dir.join(format!("plugin-{operation_id}.log")))
}

fn action_label(action: PluginAction) -> &'static str {
    match action {
        PluginAction::Install => "安装",
        PluginAction::Remove => "卸载",
        PluginAction::Update => "更新",
    }
}

fn timestamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis()).unwrap_or_default()
}

fn redact_sensitive(input: &str) -> String {
    let mut output = input.to_string();
    for marker in ["token=", "token:", "api_key=", "apiKey=", "DEEPSEEK_API_KEY=", "OPENAI_API_KEY="] {
        if let Some(start) = output.find(marker) {
            let value_start = start + marker.len();
            let value_end = output[value_start..]
                .find(|character: char| character.is_whitespace() || ['&', '"', '\'', ')', ','].contains(&character))
                .map(|offset| value_start + offset)
                .unwrap_or(output.len());
            output = format!("{}[REDACTED]{}", &output[..value_start], &output[value_end..]);
        }
    }
    output
}
