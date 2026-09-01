use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const EXPECTED_NODE_VERSION_PREFIX: &str = "v24.";
const EXPECTED_PNPM_VERSION_PREFIX: &str = "11.7.0";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum HarnessStatus {
    #[serde(rename = "starting")]
    Starting { log_path: String },
    #[serde(rename = "ready")]
    Ready { url: String, port: u16 },
    #[serde(rename = "failed")]
    Failed { message: String, log_path: String },
    #[serde(rename = "stopped")]
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessLaunchInfo {
    pub url: String,
    pub port: u16,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToolStatus {
    pub path: String,
    pub available: bool,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ready: bool,
    pub platform: String,
    pub node: RuntimeToolStatus,
    pub pnpm: RuntimeToolStatus,
    pub dsh: RuntimeToolStatus,
}

struct HarnessInner {
    child: Option<Child>,
    status: HarnessStatus,
    log_path: Option<PathBuf>,
}

#[derive(Clone)]
pub struct HarnessController {
    inner: Arc<Mutex<HarnessInner>>,
}

impl Default for HarnessController {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HarnessInner {
                child: None,
                status: HarnessStatus::Stopped,
                log_path: None,
            })),
        }
    }
}

impl HarnessController {
    pub fn start(&self, app: &AppHandle) -> Result<HarnessLaunchInfo, String> {
        self.refresh_process();
        {
            let state = self
                .inner
                .lock()
                .map_err(|_| "Harness 状态锁不可用".to_string())?;
            if matches!(state.status, HarnessStatus::Ready { .. }) {
                if let HarnessStatus::Ready { url, port } = &state.status {
                    return Ok(HarnessLaunchInfo {
                        url: url.clone(),
                        port: *port,
                        version: dsh_version(app),
                    });
                }
            }
            if matches!(state.status, HarnessStatus::Starting { .. }) {
                drop(state);
                return self.wait_until_ready(app, Duration::from_secs(15));
            }
        }

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        let log_dir = data_dir.join("logs");
        fs::create_dir_all(&log_dir)
            .map_err(|error| format!("无法创建 Harness 日志目录：{error}"))?;
        let log_path = log_dir.join(format!("harness-{}.log", timestamp()));
        let node = runtime_node(app);
        let dsh_entry = runtime_dsh_entry(app);
        let dsh_home = data_dir.join("dsh");
        fs::create_dir_all(&dsh_home)
            .map_err(|error| format!("无法创建 Harness 数据目录：{error}"))?;
        fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;

        let mut command = Command::new(&node);
        command
            .arg(&dsh_entry)
            .args(["web", "--host", "127.0.0.1", "--port", "0", "--no-open"])
            .current_dir(&data_dir)
            .env("DSH_HOME", &dsh_home)
            .env("DSH_NODE_PATH", &node)
            .env("DSH_DESKTOP_RUNTIME", "1")
            .envs(runtime_environment(&node, app));
        configure_process_group(&mut command);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            format!(
                "无法启动内置 Node/Harness：{error}（Node: {}; entry: {}）",
                node.display(),
                dsh_entry.display()
            )
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|error| format!("无法打开 Harness 日志：{error}"))?;
        let shared = self.inner.clone();
        {
            let mut state = shared
                .lock()
                .map_err(|_| "Harness 状态锁不可用".to_string())?;
            state.child = Some(child);
            state.log_path = Some(log_path.clone());
            state.status = HarnessStatus::Starting {
                log_path: log_path.display().to_string(),
            };
        }

        if let Some(stdout) = stdout {
            spawn_log_reader(stdout, shared.clone(), log_path.clone());
        }
        if let Some(stderr) = stderr {
            spawn_log_reader(stderr, shared.clone(), log_path.clone());
        }

        self.wait_until_ready(app, Duration::from_secs(15))
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Harness 状态锁不可用".to_string())?;
        if let Some(mut child) = state.child.take() {
            terminate_process_tree(&mut child)?;
        }
        state.status = HarnessStatus::Stopped;
        Ok(())
    }

    pub fn status(&self) -> HarnessStatus {
        self.refresh_process();
        self.inner
            .lock()
            .map(|state| state.status.clone())
            .unwrap_or(HarnessStatus::Failed {
                message: "Harness 状态锁不可用".to_string(),
                log_path: String::new(),
            })
    }

    pub fn is_running(&self) -> bool {
        self.refresh_process();
        self.inner
            .lock()
            .map(|state| state.child.is_some())
            .unwrap_or(false)
    }

    fn wait_until_ready(
        &self,
        app: &AppHandle,
        timeout: Duration,
    ) -> Result<HarnessLaunchInfo, String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            self.refresh_process();
            let status = self.status();
            match status {
                HarnessStatus::Ready { url, port } => {
                    if wait_for_http(&url, Duration::from_secs(2)) {
                        return Ok(HarnessLaunchInfo {
                            url,
                            port,
                            version: dsh_version(app),
                        });
                    }
                }
                HarnessStatus::Failed { message, log_path } => {
                    return Err(format!("{message}（日志：{log_path}）"));
                }
                HarnessStatus::Stopped => return Err("Harness 进程已停止".to_string()),
                HarnessStatus::Starting { .. } => {}
            }
            if std::time::Instant::now() >= deadline {
                let log_path = self
                    .inner
                    .lock()
                    .ok()
                    .and_then(|state| state.log_path.clone())
                    .map(|path| path.display().to_string())
                    .unwrap_or_default();
                return Err(format!("Harness 启动超时（日志：{log_path}）"));
            }
            thread::sleep(Duration::from_millis(150));
        }
    }

    fn refresh_process(&self) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        let Some(child) = state.child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(exit)) => {
                let log_path = state
                    .log_path
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default();
                state.status = HarnessStatus::Failed {
                    message: format!("Harness 进程退出：{exit}"),
                    log_path,
                };
                state.child = None;
            }
            Ok(None) | Err(_) => {}
        }
    }
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    reader: R,
    shared: Arc<Mutex<HarnessInner>>,
    log_path: PathBuf,
) {
    thread::spawn(move || {
        let mut file = match OpenOptions::new().create(true).append(true).open(log_path) {
            Ok(file) => file,
            Err(_) => return,
        };
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let line = redact_sensitive(&line);
            let _ = writeln!(file, "{line}");
            if let Some((url, port)) = parse_harness_url(&line) {
                if let Ok(mut state) = shared.lock() {
                    state.status = HarnessStatus::Ready { url, port };
                }
            }
        }
    });
}

fn parse_harness_url(line: &str) -> Option<(String, u16)> {
    let start = line.find("http://127.0.0.1:")?;
    let url = line[start..]
        .split_whitespace()
        .next()?
        .trim_end_matches([')', ',', '"', '\'']);
    let port = url.rsplit(':').next()?.parse().ok()?;
    Some((url.to_string(), port))
}

fn wait_for_http(url: &str, timeout: Duration) -> bool {
    let Some(port) = url
        .rsplit(':')
        .next()
        .and_then(|part| part.parse::<u16>().ok())
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

pub fn runtime_node(app: &AppHandle) -> PathBuf {
    let packaged = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime").join("node").join(node_binary_name()));
    packaged
        .filter(|path| path.is_file())
        .or_else(|| std::env::var_os("DSH_NODE_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(node_binary_name()))
}

pub fn runtime_pnpm(app: &AppHandle) -> PathBuf {
    let packaged = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime").join("bin").join(pnpm_binary_name()));
    packaged
        .filter(|path| path.is_file())
        .or_else(|| std::env::var_os("DSH_PNPM_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(pnpm_binary_name()))
}

pub fn runtime_dsh_entry(app: &AppHandle) -> PathBuf {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime/server/node_modules/@deepseek-ai/dsh/lib/bin.js"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../node_modules/@deepseek-ai/dsh/lib/bin.js")
        })
}

pub fn runtime_environment(node: &Path, app: &AppHandle) -> Vec<(String, String)> {
    let runtime_bin = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime/bin"));
    let mut paths = Vec::new();
    if let Some(path) = runtime_bin {
        paths.push(path);
    }
    if let Some(parent) = node.parent() {
        paths.push(parent.to_path_buf());
    }
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(paths).unwrap_or_default();
    vec![("PATH".to_string(), joined.to_string_lossy().to_string())]
}

pub fn runtime_status(app: &AppHandle) -> RuntimeStatus {
    let node_path = runtime_node(app);
    let mut node_command = Command::new(&node_path);
    node_command
        .arg("--version")
        .envs(runtime_environment(&node_path, app));
    let (node_available, node_version) = probe_version(node_command, EXPECTED_NODE_VERSION_PREFIX);

    let pnpm_path = runtime_pnpm(app);
    let (pnpm_available, pnpm_version) = if let Some(pnpm_cli) = runtime_pnpm_cli(app) {
        let mut command = Command::new(&node_path);
        command
            .arg(pnpm_cli)
            .arg("--version")
            .envs(runtime_environment(&node_path, app));
        probe_version(command, EXPECTED_PNPM_VERSION_PREFIX)
    } else {
        let mut command = Command::new(&pnpm_path);
        command
            .arg("--version")
            .envs(runtime_environment(&node_path, app));
        probe_version(command, EXPECTED_PNPM_VERSION_PREFIX)
    };

    let dsh_path = runtime_dsh_entry(app);
    let dsh_version = dsh_version(app);
    let dsh_available = dsh_path.is_file() && dsh_version != "unknown";

    RuntimeStatus {
        ready: node_available && pnpm_available && dsh_available,
        platform: current_platform().to_string(),
        node: RuntimeToolStatus {
            path: node_path.display().to_string(),
            available: node_available,
            version: node_version,
        },
        pnpm: RuntimeToolStatus {
            path: pnpm_path.display().to_string(),
            available: pnpm_available,
            version: pnpm_version,
        },
        dsh: RuntimeToolStatus {
            path: dsh_path.display().to_string(),
            available: dsh_available,
            version: dsh_version,
        },
    }
}

fn runtime_pnpm_cli(app: &AppHandle) -> Option<PathBuf> {
    let packaged = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime/pnpm/bin/pnpm.cjs"));
    packaged
        .filter(|path| path.is_file())
        .or_else(|| std::env::var_os("DSH_PNPM_CLI_PATH").map(PathBuf::from))
        .filter(|path| path.is_file())
        .or_else(|| {
            let path =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules/pnpm/bin/pnpm.cjs");
            path.is_file().then_some(path)
        })
}

fn probe_version(mut command: Command, expected_prefix: &str) -> (bool, String) {
    match command.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = stdout
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(str::trim)
                .unwrap_or_else(|| {
                    stderr
                        .lines()
                        .find(|line| !line.trim().is_empty())
                        .unwrap_or("")
                })
                .to_string();
            let available = output.status.success() && version.starts_with(expected_prefix);
            (
                available,
                if version.is_empty() {
                    "不可用".to_string()
                } else {
                    version
                },
            )
        }
        Err(error) => (false, format!("不可用：{error}")),
    }
}

fn dsh_version(app: &AppHandle) -> String {
    let package = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime/server/node_modules/@deepseek-ai/dsh/package.json"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../node_modules/@deepseek-ai/dsh/package.json")
        });
    fs::read_to_string(package)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|package| {
            package
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn redact_sensitive(input: &str) -> String {
    let mut output = input.to_string();
    for marker in [
        "token=",
        "token:",
        "api_key=",
        "apiKey=",
        "DEEPSEEK_API_KEY=",
        "OPENAI_API_KEY=",
    ] {
        output = redact_after_marker(&output, marker);
    }
    let mut result = String::with_capacity(output.len());
    let mut cursor = 0;
    while let Some(relative) = output[cursor..].find("sk-") {
        let start = cursor + relative;
        result.push_str(&output[cursor..start]);
        result.push_str("sk-[REDACTED]");
        let mut end = start + 3;
        while end < output.len() && output.as_bytes()[end].is_ascii_alphanumeric() {
            end += 1;
        }
        cursor = end;
    }
    result.push_str(&output[cursor..]);
    result
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let Some(start) = input.find(marker) else {
        return input.to_string();
    };
    let value_start = start + marker.len();
    let value_end = input[value_start..]
        .find(|character: char| {
            character.is_whitespace() || ['&', '"', '\'', ')', ','].contains(&character)
        })
        .map(|offset| value_start + offset)
        .unwrap_or(input.len());
    format!("{}[REDACTED]{}", &input[..value_start], &input[value_end..])
}

fn node_binary_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn pnpm_binary_name() -> &'static str {
    if cfg!(windows) {
        "pnpm.cmd"
    } else {
        "pnpm"
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn current_platform() -> &'static str {
    "macos-arm64"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn current_platform() -> &'static str {
    "macos-x64"
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn current_platform() -> &'static str {
    "windows-x64"
}

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
pub fn current_platform() -> &'static str {
    "unsupported"
}

pub fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                // Keep the Harness process in its own group so closing the desktop can
                // terminate Node and any plugin child processes together.
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }
}

fn terminate_process_tree(child: &mut Child) -> Result<(), String> {
    terminate_process_by_pid(child.id())?;
    let _ = child.wait();
    Ok(())
}

pub fn terminate_process_by_pid(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = pid as i32;
        let result = unsafe { libc::kill(-pid, libc::SIGTERM) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                let direct_result = unsafe { libc::kill(pid, libc::SIGTERM) };
                if direct_result != 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return Err(format!(
                        "无法终止进程树：{}",
                        std::io::Error::last_os_error()
                    ));
                }
            }
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("无法终止 Harness 进程树：{error}"))?;
        if !status.success() {
            return Err(format!("无法终止进程树，taskkill 退出码：{status}"));
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    Ok(())
}
