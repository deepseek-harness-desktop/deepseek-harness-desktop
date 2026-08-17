use serde_json::{json, Value};
use std::{collections::HashMap, env, path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, Command}, sync::{oneshot, Mutex}};

struct RuntimeState {
    process: Mutex<Option<RuntimeProcess>>,
}

struct RuntimeProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
}

#[derive(serde::Deserialize)]
struct RpcResponse {
    id: Option<String>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
}

fn runtime_command(app: &AppHandle) -> (String, Vec<String>) {
    if let Ok(command) = env::var("DSH_DESKTOP_RUNTIME") {
        return (command, vec!["--profile".into(), "desktop".into()]);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let mut sidecar = PathBuf::from(resource_dir);
        sidecar.push(format!("dsh-desktop-runtime-{}", env!("DSH_DESKTOP_TARGET_TRIPLE")));
        if cfg!(target_os = "windows") { sidecar.set_extension("exe"); }
        if sidecar.exists() {
            return (sidecar.to_string_lossy().into_owned(), vec!["--profile".into(), "desktop".into()]);
        }
    }
    ("dsh".into(), vec!["--profile".into(), "desktop".into()])
}

async fn start_process(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let mut guard = state.process.lock().await;
    if guard.is_some() { return Ok(()); }
    let (program, args) = runtime_command(app);
    let mut child = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to start dsh desktop runtime: {e}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("runtime stdin unavailable")?));
    let stdout = child.stdout.take().ok_or("runtime stdout unavailable")?;
    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>> = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    let app_reader = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let parsed: Result<RpcResponse, _> = serde_json::from_str(&line);
            let Ok(message) = parsed else { continue };
            if let Some(id) = message.id {
                if let Some(sender) = pending_reader.lock().await.remove(&id) {
                    let value = match (message.result, message.error) {
                        (Some(value), _) => Ok(value),
                        (_, Some(error)) => Err(error.to_string()),
                        _ => Err("runtime response had no result or error".into()),
                    };
                    let _ = sender.send(value);
                }
            } else {
                let _ = app_reader.emit("dsh://runtime-notification", json!({
                    "method": message.method.unwrap_or_default(),
                    "params": message.params.unwrap_or(Value::Null)
                }));
            }
        }
        let mut pending = pending_reader.lock().await;
        for (_, sender) in pending.drain() { let _ = sender.send(Err("desktop runtime exited".into())); }
    });
    *guard = Some(RuntimeProcess { child, stdin, pending });
    Ok(())
}

async fn request(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    start_process(app).await?;
    let state = app.state::<RuntimeState>();
    let guard = state.process.lock().await;
    let runtime = guard.as_ref().ok_or("desktop runtime is not running")?;
    let stdin = runtime.stdin.clone();
    let pending = runtime.pending.clone();
    drop(guard);
    let id = format!("desktop-{}", uuid());
    let (sender, receiver) = oneshot::channel();
    pending.lock().await.insert(id.clone(), sender);
    let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    stdin.lock().await.write_all(format!("{}\n", frame).as_bytes()).await.map_err(|e| e.to_string())?;
    receiver.await.map_err(|_| String::from("desktop runtime response channel closed"))?
}

fn uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_string()
}

#[tauri::command]
async fn runtime_start(app: AppHandle) -> Result<Value, String> {
    start_process(&app).await?;
    let cwd = env::current_dir().map_err(|e| e.to_string())?;
    request(&app, "runtime.initialize", json!({"cwd": cwd})).await
}

#[tauri::command]
async fn runtime_bundle(app: AppHandle, id: String) -> Result<Value, String> {
    request(&app, "client.bundle", json!({"id": id})).await
}

#[tauri::command]
async fn runtime_invoke(app: AppHandle, channel: String, endpoint: String, payload: Value) -> Result<Value, String> {
    request(&app, "api.invoke", json!({"channel": channel, "endpoint": endpoint, "request": payload})).await
}

#[tauri::command]
async fn runtime_open_stream(app: AppHandle, stream_id: String, stream: String, payload: Value) -> Result<(), String> {
    request(&app, "api.stream.open", json!({"streamId": stream_id, "stream": stream, "request": payload})).await.map(|_| ())
}

#[tauri::command]
async fn runtime_cancel(app: AppHandle, request_id: String) -> Result<(), String> {
    request(&app, "api.cancel", json!({"requestId": request_id})).await.map(|_| ())
}

#[tauri::command]
async fn runtime_close_stream(app: AppHandle, stream_id: String) -> Result<(), String> {
    request(&app, "api.stream.close", json!({"streamId": stream_id})).await.map(|_| ())
}

#[tauri::command]
async fn runtime_shutdown(app: AppHandle) -> Result<(), String> {
    let result = request(&app, "runtime.shutdown", json!({})).await.map(|_| ());
    let state = app.state::<RuntimeState>();
    if let Some(mut runtime) = state.process.lock().await.take() {
        let _ = runtime.child.kill().await;
        let _ = runtime.child.wait().await;
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState { process: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![runtime_start, runtime_bundle, runtime_invoke, runtime_open_stream, runtime_cancel, runtime_close_stream, runtime_shutdown])
        .run(tauri::generate_context!())
        .expect("error while running DeepSeek Harness Desktop");
}
