//! Managed local AI engine: a `llama-server` child process the app downloads,
//! starts, supervises and stops, so local models work without the user
//! installing Ollama or LM Studio.
//!
//! - [`engine`] fetches the pinned runtime, [`catalog`] lists the vetted
//!   models, [`download`] does resumable, checksum-verified downloads.
//! - [`supervisor`] is the lifecycle state machine and the child's command line.
//! - This file owns the real process and exposes the IPC commands.
//!
//! Isolation: the server binds `127.0.0.1` on a port the OS picks per launch
//! and requires a random key generated per launch. The key is handed to the
//! child through its environment (never argv, never disk), kept in this
//! process's memory, and given to the webview only through
//! [`llm_server_connection`]. It is not part of [`EngineStatus`], which is what
//! the UI stores, and it is not in any event.

pub mod catalog;
pub mod download;
pub mod engine;
pub mod supervisor;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::watch;
use zeroize::Zeroizing;

use catalog::CatalogModel;
use download::{DownloadEvent, DownloadSpec};
use supervisor::{CrashDecision, Lifecycle, Phase, ServerConfig};

/// Emitted to the webview whenever the engine's state changes. Payload:
/// [`EngineStatus`] (never the key).
pub const STATUS_EVENT: &str = "llm-engine-status";

/// The download id of the engine runtime itself (model downloads use the
/// catalogue id).
const ENGINE_DOWNLOAD_ID: &str = "engine";

const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
const HEALTH_POLL: Duration = Duration::from_millis(300);
const EXIT_POLL: Duration = Duration::from_millis(500);
const PORT_ATTEMPTS: u32 = 3;
const LOG_TAIL_LINES: usize = 40;

// ── errors ─────────────────────────────────────────────────────────────────

/// Machine-readable failure classes. The settings UI branches on these, so the
/// serialized names are part of the IPC contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// No engine build for this OS/architecture.
    UnsupportedPlatform,
    /// The machine has less memory than the model needs.
    InsufficientMemory,
    InsufficientDisk,
    /// A download or an installed file is not the pinned file.
    HashMismatch,
    /// The engine archive or binary failed its integrity checks.
    EngineInvalid,
    Network,
    Cancelled,
    /// The engine runtime or the model has not been downloaded.
    NotInstalled,
    UnknownModel,
    Busy,
    /// The engine process started but never became usable.
    StartupFailed,
    /// No local port could be bound.
    PortUnavailable,
    /// The engine kept dying and automatic restarts were exhausted.
    Crashed,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LlmError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needed_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
}

impl LlmError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        LlmError { code, message: message.into(), needed_bytes: None, available_bytes: None }
    }

    pub fn io(action: &str, e: std::io::Error) -> Self {
        LlmError::new(ErrorCode::Io, format!("Could not {action}: {e}"))
    }
}

fn cancelled() -> LlmError {
    LlmError::new(ErrorCode::Cancelled, "Cancelled.")
}

fn unknown_model() -> LlmError {
    LlmError::new(ErrorCode::UnknownModel, "That model is not in the catalogue.")
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── paths ──────────────────────────────────────────────────────────────────

/// `<app_local_data_dir>/llm[_<instance>]` — engine runtime, models and the
/// pid record. Outside the app bundle, so the app's own signature is untouched.
fn base_dir(app: &AppHandle) -> Result<PathBuf, LlmError> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| LlmError::new(ErrorCode::Io, format!("app data directory: {e}")))?
        .join(format!("llm{}", crate::keystore::instance_suffix()));
    std::fs::create_dir_all(&base).map_err(|e| LlmError::io("create the AI data folder", e))?;
    Ok(base)
}

fn model_path(base: &Path, model: &CatalogModel) -> PathBuf {
    base.join("models").join(model.local_file_name())
}

fn pid_file(base: &Path) -> PathBuf {
    base.join("engine.pid")
}

// ── hardware ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct HardwareInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub total_ram_bytes: u64,
    pub cpu_cores: u32,
    /// Free space on the volume that holds models (`None` when unknown).
    pub free_disk_bytes: Option<u64>,
    /// `"metal"` on Apple Silicon, otherwise `"cpu"`.
    pub acceleration: &'static str,
    /// Whether a managed engine build exists for this OS/architecture.
    pub engine_supported: bool,
    pub engine_build: &'static str,
    pub engine_download_bytes: Option<u64>,
}

fn total_ram_bytes() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory()
}

/// Free space of the mount that contains `path`: the longest mount point that
/// is a prefix of it.
fn free_on_mount(path: &Path, mounts: &[(PathBuf, u64)]) -> Option<u64> {
    mounts
        .iter()
        .filter(|(mount, _)| path.starts_with(mount))
        .max_by_key(|(mount, _)| mount.components().count())
        .map(|(_, free)| *free)
}

fn free_disk_bytes(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mounts: Vec<(PathBuf, u64)> = disks
        .iter()
        .map(|d| (d.mount_point().to_path_buf(), d.available_space()))
        .collect();
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    free_on_mount(&resolved, &mounts)
}

fn acceleration(os: &str, arch: &str) -> &'static str {
    if os == "macos" && arch == "aarch64" {
        "metal"
    } else {
        "cpu"
    }
}

fn check_memory(model: &CatalogModel, total_ram: u64) -> Result<(), LlmError> {
    // A reading of 0 means "unknown": do not block on it.
    if total_ram != 0 && total_ram < model.min_ram_bytes {
        return Err(LlmError {
            needed_bytes: Some(model.min_ram_bytes),
            available_bytes: Some(total_ram),
            ..LlmError::new(
                ErrorCode::InsufficientMemory,
                format!("{} needs more memory than this machine has.", model.name),
            )
        });
    }
    Ok(())
}

fn unsupported_platform() -> LlmError {
    LlmError::new(
        ErrorCode::UnsupportedPlatform,
        "The built-in engine is not available for this operating system yet.",
    )
}

// ── process ────────────────────────────────────────────────────────────────

type LogTail = Arc<Mutex<VecDeque<String>>>;

struct Proc {
    child: tokio::process::Child,
    #[cfg(unix)]
    watchdog: Option<std::process::Child>,
    log: LogTail,
}

impl Proc {
    /// Synchronous kill (usable from the app-exit hook). The watchdog goes
    /// first so it cannot fire at a pid we are about to free.
    fn kill_now(&mut self) {
        #[cfg(unix)]
        if let Some(mut watchdog) = self.watchdog.take() {
            let _ = watchdog.kill();
            let _ = watchdog.wait();
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.kill_now();
    }
}

/// Kills the engine if this app dies without running its exit hook (crash,
/// force quit, `kill -9`). The helper blocks reading a pipe whose only write
/// end this process holds; when the app goes away for ANY reason the kernel
/// closes it, the read returns, and the helper kills the engine. macOS has no
/// parent-death signal, so this is the portable way to never leave a
/// multi-gigabyte orphan behind.
#[cfg(unix)]
fn spawn_watchdog(engine_pid: u32) -> std::io::Result<std::process::Child> {
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("read _; kill -9 \"$1\" 2>/dev/null")
        .arg("wired-llm-watchdog")
        .arg(engine_pid.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn drain_output<R>(reader: R, log: LogTail, key: Zeroizing<String>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        // Keep draining for the life of the process so its pipe never fills.
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(clean) = supervisor::sanitize_log_line(&line, &key) {
                let mut tail = lock(&log);
                if tail.len() == LOG_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(clean);
            }
        }
    });
}

#[derive(Clone)]
struct LaunchPlan {
    base: PathBuf,
    binary: PathBuf,
    model_path: PathBuf,
    alias: String,
    ctx_size: u32,
}

fn spawn_engine(plan: &LaunchPlan, port: u16, key: &Zeroizing<String>) -> Result<Proc, LlmError> {
    let cfg = ServerConfig {
        model_path: plan.model_path.clone(),
        alias: plan.alias.clone(),
        port,
        ctx_size: plan.ctx_size,
    };
    let mut command = tokio::process::Command::new(&plan.binary);
    command
        .args(supervisor::server_args(&cfg))
        .envs(supervisor::server_env(key))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = plan.binary.parent() {
        command.current_dir(dir);
    }
    let mut child = command
        .spawn()
        .map_err(|e| LlmError::new(ErrorCode::StartupFailed, format!("Could not launch the engine: {e}")))?;

    let log = LogTail::default();
    if let Some(out) = child.stdout.take() {
        drain_output(out, log.clone(), key.clone());
    }
    if let Some(err) = child.stderr.take() {
        drain_output(err, log.clone(), key.clone());
    }
    #[cfg(unix)]
    let watchdog = child.id().and_then(|pid| spawn_watchdog(pid).ok());
    if let Some(pid) = child.id() {
        write_pid_record(&plan.base, pid, &plan.binary);
    }
    Ok(Proc {
        child,
        #[cfg(unix)]
        watchdog,
        log,
    })
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PidRecord {
    pid: u32,
    exe: PathBuf,
}

fn write_pid_record(base: &Path, pid: u32, exe: &Path) {
    if let Ok(json) = serde_json::to_vec(&PidRecord { pid, exe: exe.to_path_buf() }) {
        let _ = std::fs::write(pid_file(base), json);
    }
}

/// Only ever kill a process that is running the exact engine binary we
/// recorded, from inside our own data directory. A recycled pid that now
/// belongs to anything else is left alone.
fn is_our_engine(actual_exe: Option<&Path>, recorded_exe: &Path, base: &Path) -> bool {
    actual_exe.is_some_and(|exe| {
        exe == recorded_exe
            && exe.starts_with(base)
            && exe.file_name().is_some_and(|n| n == "llama-server")
    })
}

/// Kill an engine left behind by a previous run of the app, if its pid record
/// is still on disk and still points at our binary.
fn reap_stale_engine(base: &Path) {
    let path = pid_file(base);
    let Ok(raw) = std::fs::read(&path) else { return };
    let _ = std::fs::remove_file(&path);
    let Ok(record) = serde_json::from_slice::<PidRecord>(&raw) else { return };
    let pid = sysinfo::Pid::from_u32(record.pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    if let Some(process) = sys.process(pid) {
        if is_our_engine(process.exe(), &record.exe, base) {
            process.kill();
        }
    }
}

// ── shared state ───────────────────────────────────────────────────────────

struct Inner {
    lifecycle: Mutex<Lifecycle>,
    proc: Mutex<Option<Proc>>,
    /// The running engine's access key. Memory only.
    secret: Mutex<Option<Zeroizing<String>>>,
    /// In-flight downloads: id → cancel switch.
    downloads: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// Ports already granted to the webview's HTTP scope this session.
    #[cfg_attr(dev, allow(dead_code))]
    granted_ports: Mutex<HashSet<u16>>,
}

/// Managed Tauri state for the engine.
pub struct LlmState(Arc<Inner>);

impl Default for LlmState {
    fn default() -> Self {
        LlmState(Arc::new(Inner {
            lifecycle: Mutex::new(Lifecycle::default()),
            proc: Mutex::new(None),
            secret: Mutex::new(None),
            downloads: Mutex::new(HashMap::new()),
            granted_ports: Mutex::new(HashSet::new()),
        }))
    }
}

impl Inner {
    fn is_current(&self, generation: u64) -> bool {
        lock(&self.lifecycle).is_current(generation)
    }

    /// `Some(description)` once the engine process has exited (or is gone).
    fn proc_exit(&self) -> Option<String> {
        match lock(&self.proc).as_mut() {
            None => Some("no process".to_string()),
            Some(proc) => match proc.child.try_wait() {
                Ok(None) => None,
                Ok(Some(status)) => Some(status.to_string()),
                Err(e) => Some(format!("unknown ({e})")),
            },
        }
    }

    fn log_snapshot(&self) -> Vec<String> {
        lock(&self.proc)
            .as_ref()
            .map(|p| lock(&p.log).iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Kill and reap the current process, if any, and forget its key.
    async fn kill_proc(&self) {
        lock(&self.secret).take();
        let taken = lock(&self.proc).take();
        if let Some(mut proc) = taken {
            proc.kill_now();
            let _ = tokio::time::timeout(Duration::from_secs(5), proc.child.wait()).await;
        }
    }

    fn status(&self, base: Option<&Path>) -> EngineStatus {
        let lc = lock(&self.lifecycle);
        EngineStatus {
            phase: lc.phase(),
            model_id: lc.model_id().map(str::to_owned),
            port: lc.port(),
            restarts: lc.restarts(),
            error: lc.error().cloned(),
            engine_installed: base.is_some_and(|b| engine::installed_binary(b).is_some()),
            engine_build: engine::PINNED_BUILD,
        }
    }

    fn register_download(&self, id: &str) -> Result<watch::Receiver<bool>, LlmError> {
        let mut downloads = lock(&self.downloads);
        if downloads.contains_key(id) {
            return Err(LlmError::new(ErrorCode::Busy, "That download is already in progress."));
        }
        let (tx, rx) = watch::channel(false);
        downloads.insert(id.to_string(), tx);
        Ok(rx)
    }
}

/// Removes a download's cancel switch when the download ends, however it ends.
struct DownloadGuard<'a> {
    inner: &'a Inner,
    id: String,
}

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        lock(&self.inner.downloads).remove(&self.id);
    }
}

// ── status ─────────────────────────────────────────────────────────────────

/// Everything the UI shows about the engine. Non-secret by construction: this
/// is what lands in the Redux store and in [`STATUS_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineStatus {
    pub phase: Phase,
    pub model_id: Option<String>,
    pub port: Option<u16>,
    /// Automatic restarts since the engine was started.
    pub restarts: u32,
    pub error: Option<LlmError>,
    pub engine_installed: bool,
    pub engine_build: &'static str,
}

/// How to reach the running engine. Returned only by
/// [`llm_server_connection`]; the caller keeps it in memory.
#[derive(serde::Serialize)]
pub struct EngineConnection {
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
}

fn emit_status(app: &AppHandle, inner: &Inner) {
    let base = base_dir(app).ok();
    let _ = app.emit(STATUS_EVENT, inner.status(base.as_deref()));
}

/// The one loopback URL pattern the webview's HTTP client is allowed to reach
/// for an engine on `port`.
#[cfg_attr(dev, allow(dead_code))]
fn engine_http_scope(port: u16) -> serde_json::Value {
    serde_json::json!({ "url": format!("http://{}:{port}/**", supervisor::BIND_HOST) })
}

/// Production builds serve the UI from an origin whose HTTP scope is HTTPS-only
/// (`capabilities/localhost.json`), so loopback is unreachable by default. Grant
/// exactly this engine's port, to the main window on the app origin, instead of
/// opening every local port statically.
#[cfg(not(dev))]
fn grant_http_scope(app: &AppHandle, inner: &Inner, port: u16) {
    if !lock(&inner.granted_ports).insert(port) {
        return;
    }
    let capability = tauri::ipc::CapabilityBuilder::new(format!("llm-engine-{port}"))
        .local(false)
        .remote(format!("http://localhost:{}", crate::localhost::PORT))
        .window("main")
        .permission_scoped(
            "http:default",
            vec![engine_http_scope(port)],
            Vec::<serde_json::Value>::new(),
        );
    if let Err(e) = app.add_capability(capability) {
        log::error!("could not grant the AI engine's HTTP scope: {e}");
    }
}

/// `tauri dev` runs on the local origin, whose capability already allows
/// loopback HTTP.
#[cfg(dev)]
fn grant_http_scope(_app: &AppHandle, _inner: &Inner, _port: u16) {}

// ── launching ──────────────────────────────────────────────────────────────

fn local_client() -> Result<reqwest::Client, LlmError> {
    reqwest::Client::builder()
        // Never send loopback traffic (and the key) through a system proxy.
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| LlmError::new(ErrorCode::Io, format!("http client: {e}")))
}

fn download_client() -> Result<reqwest::Client, LlmError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("TheWired/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| LlmError::new(ErrorCode::Io, format!("http client: {e}")))
}

/// Wait until the engine answers, then prove it is enforcing its key: a request
/// without the key must be refused and one with it must succeed. An engine that
/// would serve anyone on this machine is killed rather than used.
async fn wait_ready(inner: &Inner, generation: u64, port: u16, key: &str) -> Result<(), LlmError> {
    let client = local_client()?;
    let origin = format!("http://{}:{port}", supervisor::BIND_HOST);
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if !inner.is_current(generation) {
            return Err(cancelled());
        }
        if let Some(exit) = inner.proc_exit() {
            // Let the output readers catch the process's last words.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let tail = inner.log_snapshot();
            let code = supervisor::classify_startup_failure(&tail);
            let message = match (code, supervisor::failure_detail(&tail)) {
                (ErrorCode::PortUnavailable, _) => "The engine could not bind its local port.".to_string(),
                (_, Some(detail)) => format!("The engine exited while starting ({exit}): {detail}"),
                (_, None) => format!("The engine exited while starting ({exit})."),
            };
            return Err(LlmError::new(code, message));
        }
        if Instant::now() >= deadline {
            return Err(LlmError::new(
                ErrorCode::StartupFailed,
                "The engine did not become ready in time.",
            ));
        }
        let healthy = client
            .get(format!("{origin}/health"))
            .send()
            .await
            .is_ok_and(|r| r.status() == reqwest::StatusCode::OK);
        if healthy {
            break;
        }
        tokio::time::sleep(HEALTH_POLL).await;
    }

    let models = format!("{origin}/v1/models");
    let anonymous = client.get(&models).send().await;
    if anonymous.is_ok_and(|r| r.status().is_success()) {
        return Err(LlmError::new(
            ErrorCode::StartupFailed,
            "The engine accepted a request without its access key, so it was not used.",
        ));
    }
    let authed = client.get(&models).bearer_auth(key).send().await;
    if !authed.is_ok_and(|r| r.status().is_success()) {
        return Err(LlmError::new(
            ErrorCode::StartupFailed,
            "The engine rejected its own access key.",
        ));
    }
    // Whatever answered must be OUR process, still alive, not a squatter that
    // took the port after ours failed to bind it.
    if inner.proc_exit().is_some() {
        return Err(LlmError::new(
            ErrorCode::PortUnavailable,
            "The engine lost its local port while starting.",
        ));
    }
    Ok(())
}

/// Spawn the engine and wait for it to be usable. A fresh port and a fresh key
/// for every attempt; a lost race for the port is retried on another port.
async fn launch_once(inner: &Inner, generation: u64, plan: &LaunchPlan) -> Result<u16, LlmError> {
    let mut last_error = None;
    for _ in 0..PORT_ATTEMPTS {
        if !inner.is_current(generation) {
            return Err(cancelled());
        }
        inner.kill_proc().await;
        reap_stale_engine(&plan.base);

        let port = supervisor::pick_free_port()?;
        let key = Zeroizing::new(supervisor::generate_api_key());
        let proc = spawn_engine(plan, port, &key)?;
        *lock(&inner.proc) = Some(proc);
        // A Stop that raced the spawn found nothing to kill; clean up for it.
        if !inner.is_current(generation) {
            inner.kill_proc().await;
            return Err(cancelled());
        }

        match wait_ready(inner, generation, port, &key).await {
            Ok(()) => {
                *lock(&inner.secret) = Some(key);
                return Ok(port);
            }
            Err(e) => {
                inner.kill_proc().await;
                if e.code != ErrorCode::PortUnavailable {
                    return Err(e);
                }
                last_error = Some(e);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        LlmError::new(ErrorCode::PortUnavailable, "The engine could not bind a local port.")
    }))
}

/// Watches a running engine. When it dies on its own, restart it within the
/// policy's limits; when the limits are exhausted, leave it `Failed`. Exits as
/// soon as its generation is stale (the user stopped or restarted the engine).
async fn supervise(inner: Arc<Inner>, app: AppHandle, generation: u64, plan: LaunchPlan) {
    loop {
        // Wait for the process to exit by itself.
        let exit = loop {
            tokio::time::sleep(EXIT_POLL).await;
            if !inner.is_current(generation) {
                return;
            }
            if let Some(exit) = inner.proc_exit() {
                break exit;
            }
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        let mut detail = supervisor::failure_detail(&inner.log_snapshot())
            .or_else(|| Some(format!("exit status: {exit}")));
        log::warn!("AI engine exited unexpectedly ({exit})");

        // Relaunch until it is healthy again or the policy says stop.
        loop {
            let decision = lock(&inner.lifecycle).on_exit(generation, Instant::now(), detail.take());
            let Some(decision) = decision else { return };
            inner.kill_proc().await;
            emit_status(&app, &inner);
            let delay = match decision {
                CrashDecision::GiveUp => {
                    let _ = std::fs::remove_file(pid_file(&plan.base));
                    return;
                }
                CrashDecision::Restart { delay, .. } => delay,
            };
            tokio::time::sleep(delay).await;
            if !inner.is_current(generation) {
                return;
            }
            match launch_once(&inner, generation, &plan).await {
                Ok(port) => {
                    if !lock(&inner.lifecycle).mark_running(generation, port) {
                        // Stopped while relaunching: Stop already cleaned up, but
                        // this process was installed after it looked.
                        if !inner.is_current(generation) {
                            inner.kill_proc().await;
                        }
                        return;
                    }
                    grant_http_scope(&app, &inner, port);
                    emit_status(&app, &inner);
                    break;
                }
                Err(e) if e.code == ErrorCode::Cancelled => return,
                Err(e) => detail = Some(e.message),
            }
        }
    }
}

async fn stop_engine(app: &AppHandle, inner: &Inner) {
    let had_process = lock(&inner.lifecycle).begin_stop();
    if had_process {
        emit_status(app, inner);
    }
    inner.kill_proc().await;
    if let Ok(base) = base_dir(app) {
        let _ = std::fs::remove_file(pid_file(&base));
    }
    lock(&inner.lifecycle).finish_stop();
    emit_status(app, inner);
}

/// App-exit hook: kill the engine synchronously. Called from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<LlmState>() else { return };
    let inner = &state.0;
    lock(&inner.lifecycle).begin_stop();
    lock(&inner.secret).take();
    if let Some(mut proc) = lock(&inner.proc).take() {
        proc.kill_now();
    }
    for cancel in lock(&inner.downloads).values() {
        let _ = cancel.send(true);
    }
    if let Ok(base) = base_dir(app) {
        let _ = std::fs::remove_file(pid_file(&base));
    }
}

/// App-start hook: an engine that survived a previous run (the watchdog covers
/// this on unix; this is the fallback) must not keep holding memory.
pub fn reap_on_startup(app: &AppHandle) {
    if let Ok(base) = base_dir(app) {
        reap_stale_engine(&base);
    }
}

// ── commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn llm_hardware_info(app: AppHandle) -> Result<HardwareInfo, LlmError> {
    let base = base_dir(&app)?;
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let asset = engine::asset_for(os, arch);
    Ok(HardwareInfo {
        os,
        arch,
        total_ram_bytes: total_ram_bytes(),
        cpu_cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
        free_disk_bytes: free_disk_bytes(&base),
        acceleration: acceleration(os, arch),
        engine_supported: asset.is_some(),
        engine_build: engine::PINNED_BUILD,
        engine_download_bytes: asset.map(|a| a.size_bytes),
    })
}

#[derive(serde::Serialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Hugging Face repository the file comes from (display only).
    pub source: &'static str,
    pub license: &'static str,
    pub size_bytes: u64,
    pub min_ram_bytes: u64,
    pub recommended_ram_bytes: u64,
    pub reasoning: bool,
    /// Downloaded and verified.
    pub installed: bool,
    /// Bytes of an unfinished download waiting to be resumed.
    pub partial_bytes: u64,
    pub downloading: bool,
}

#[tauri::command]
pub async fn llm_models_list(app: AppHandle, state: State<'_, LlmState>) -> Result<Vec<ModelInfo>, LlmError> {
    let base = base_dir(&app)?;
    let downloading: HashSet<String> = lock(&state.0.downloads).keys().cloned().collect();
    Ok(catalog::CATALOG
        .iter()
        .map(|m| {
            let dest = model_path(&base, m);
            ModelInfo {
                id: m.id,
                name: m.name,
                description: m.description,
                source: m.repo,
                license: m.license,
                size_bytes: m.size_bytes,
                min_ram_bytes: m.min_ram_bytes,
                recommended_ram_bytes: m.recommended_ram_bytes,
                reasoning: m.reasoning,
                installed: dest.is_file() && download::fingerprint_path(&dest).is_file(),
                partial_bytes: std::fs::metadata(download::part_path(&dest)).map(|x| x.len()).unwrap_or(0),
                downloading: downloading.contains(m.id),
            }
        })
        .collect())
}

/// Download (or resume) a catalogue model. The webview names the model; the
/// URL, size and digest come from the catalogue compiled into this binary.
#[tauri::command]
pub async fn llm_model_download(
    app: AppHandle,
    state: State<'_, LlmState>,
    model_id: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), LlmError> {
    let model = catalog::find(&model_id).ok_or_else(unknown_model)?;
    let base = base_dir(&app)?;
    let inner = &state.0;
    let mut cancel = inner.register_download(model.id)?;
    let _guard = DownloadGuard { inner, id: model.id.to_string() };
    let spec = DownloadSpec {
        url: model.url(),
        dest: model_path(&base, model),
        size_bytes: model.size_bytes,
        sha256: model.sha256.to_string(),
    };
    let client = download_client()?;
    let free = free_disk_bytes(&base);
    download::download_verified(&client, &spec, &mut cancel, free, &mut |event| {
        let _ = on_event.send(event);
    })
    .await
}

/// Cancel an in-flight download (`"engine"` or a model id). The partial file is
/// kept so the next download resumes.
#[tauri::command]
pub async fn llm_download_cancel(state: State<'_, LlmState>, id: String) -> Result<(), LlmError> {
    if let Some(cancel) = lock(&state.0.downloads).get(&id) {
        let _ = cancel.send(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn llm_model_delete(
    app: AppHandle,
    state: State<'_, LlmState>,
    model_id: String,
) -> Result<(), LlmError> {
    let model = catalog::find(&model_id).ok_or_else(unknown_model)?;
    let inner = &state.0;
    if lock(&inner.downloads).contains_key(model.id) {
        return Err(LlmError::new(ErrorCode::Busy, "Cancel the download before deleting this model."));
    }
    {
        let lc = lock(&inner.lifecycle);
        if lc.is_active() && lc.model_id() == Some(model.id) {
            return Err(LlmError::new(ErrorCode::Busy, "Stop the engine before deleting the model it is using."));
        }
    }
    let base = base_dir(&app)?;
    download::remove_all(&model_path(&base, model));
    Ok(())
}

/// Download and install the pinned engine runtime if it is not there yet.
#[tauri::command]
pub async fn llm_engine_ensure(
    app: AppHandle,
    state: State<'_, LlmState>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), LlmError> {
    let base = base_dir(&app)?;
    let inner = &state.0;
    let mut cancel = inner.register_download(ENGINE_DOWNLOAD_ID)?;
    let _guard = DownloadGuard { inner, id: ENGINE_DOWNLOAD_ID.to_string() };
    let client = download_client()?;
    let free = free_disk_bytes(&base);
    engine::install(&client, &base, &mut cancel, free, &mut |event| {
        let _ = on_event.send(event);
    })
    .await?;
    emit_status(&app, inner);
    Ok(())
}

/// Start the engine with a downloaded model (idempotent for the model already
/// running; switching models stops the current one first).
#[tauri::command]
pub async fn llm_server_start(
    app: AppHandle,
    state: State<'_, LlmState>,
    model_id: String,
) -> Result<EngineStatus, LlmError> {
    let model = catalog::find(&model_id).ok_or_else(unknown_model)?;
    let base = base_dir(&app)?;
    let inner = state.0.clone();

    if engine::asset_for_this_platform().is_none() {
        return Err(unsupported_platform());
    }
    check_memory(model, total_ram_bytes())?;
    let binary = engine::installed_binary(&base).ok_or_else(|| {
        LlmError::new(ErrorCode::NotInstalled, "The engine has not been downloaded yet.")
    })?;
    let path = model_path(&base, model);
    if !path.is_file() {
        return Err(LlmError::new(ErrorCode::NotInstalled, "That model has not been downloaded yet."));
    }

    {
        let lc = lock(&inner.lifecycle);
        if lc.phase() == Phase::Running && lc.model_id() == Some(model.id) {
            drop(lc);
            return Ok(inner.status(Some(&base)));
        }
    }

    // Integrity before every launch: instant when the file is untouched since
    // it was verified, a full re-hash when it changed. A file that fails is
    // deleted, so it can never be loaded.
    {
        let (path, size, sha) = (path.clone(), model.size_bytes, model.sha256);
        tokio::task::spawn_blocking(move || download::ensure_verified(&path, size, sha))
            .await
            .map_err(|e| LlmError::new(ErrorCode::Io, format!("verification task failed: {e}")))?
            .map_err(|e| match e.code {
                ErrorCode::HashMismatch => LlmError::new(
                    ErrorCode::HashMismatch,
                    "The model file was changed or damaged on disk, so it was removed. Download it again.",
                ),
                _ => e,
            })?;
    }

    if lock(&inner.lifecycle).phase() == Phase::Running {
        // A different model is loaded: swap.
        stop_engine(&app, &inner).await;
    }
    let generation = lock(&inner.lifecycle).begin_start(model.id)?;
    emit_status(&app, &inner);

    let plan = LaunchPlan {
        base: base.clone(),
        binary,
        model_path: path,
        alias: model.id.to_string(),
        ctx_size: model.ctx_size,
    };
    match launch_once(&inner, generation, &plan).await {
        Ok(port) => {
            if !lock(&inner.lifecycle).mark_running(generation, port) {
                if !inner.is_current(generation) {
                    inner.kill_proc().await;
                }
                return Err(cancelled());
            }
            grant_http_scope(&app, &inner, port);
            emit_status(&app, &inner);
            tauri::async_runtime::spawn(supervise(inner.clone(), app.clone(), generation, plan));
            Ok(inner.status(Some(&base)))
        }
        Err(e) => {
            if lock(&inner.lifecycle).fail_start(generation, e.clone()) {
                let _ = std::fs::remove_file(pid_file(&base));
                emit_status(&app, &inner);
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn llm_server_stop(app: AppHandle, state: State<'_, LlmState>) -> Result<EngineStatus, LlmError> {
    stop_engine(&app, &state.0).await;
    let base = base_dir(&app).ok();
    Ok(state.0.status(base.as_deref()))
}

#[tauri::command]
pub async fn llm_server_status(app: AppHandle, state: State<'_, LlmState>) -> Result<EngineStatus, LlmError> {
    let base = base_dir(&app)?;
    Ok(state.0.status(Some(&base)))
}

/// The running engine's address and key, or `None` when it is not running. The
/// webview keeps this in memory only (never in its store).
#[tauri::command]
pub async fn llm_server_connection(state: State<'_, LlmState>) -> Result<Option<EngineConnection>, LlmError> {
    let inner = &state.0;
    let (port, model_id) = {
        let lc = lock(&inner.lifecycle);
        match (lc.phase(), lc.port(), lc.model_id()) {
            (Phase::Running, Some(port), Some(model)) => (port, model.to_string()),
            _ => return Ok(None),
        }
    };
    let Some(api_key) = lock(&inner.secret).as_ref().map(|k| k.to_string()) else {
        return Ok(None);
    };
    Ok(Some(EngineConnection {
        base_url: format!("http://{}:{port}/v1", supervisor::BIND_HOST),
        api_key,
        model_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn error_codes_serialize_to_the_names_the_ui_branches_on() {
        let cases = [
            (ErrorCode::UnsupportedPlatform, "unsupported_platform"),
            (ErrorCode::InsufficientMemory, "insufficient_memory"),
            (ErrorCode::InsufficientDisk, "insufficient_disk"),
            (ErrorCode::HashMismatch, "hash_mismatch"),
            (ErrorCode::EngineInvalid, "engine_invalid"),
            (ErrorCode::Network, "network"),
            (ErrorCode::Cancelled, "cancelled"),
            (ErrorCode::NotInstalled, "not_installed"),
            (ErrorCode::UnknownModel, "unknown_model"),
            (ErrorCode::Busy, "busy"),
            (ErrorCode::StartupFailed, "startup_failed"),
            (ErrorCode::PortUnavailable, "port_unavailable"),
            (ErrorCode::Crashed, "crashed"),
            (ErrorCode::Io, "io"),
        ];
        for (code, name) in cases {
            assert_eq!(serde_json::to_value(code).unwrap(), serde_json::json!(name));
        }
        let err = LlmError {
            needed_bytes: Some(10),
            available_bytes: Some(4),
            ..LlmError::new(ErrorCode::InsufficientDisk, "full")
        };
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({"code": "insufficient_disk", "message": "full", "needed_bytes": 10, "available_bytes": 4})
        );
        assert_eq!(
            serde_json::to_value(LlmError::new(ErrorCode::Busy, "b")).unwrap(),
            serde_json::json!({"code": "busy", "message": "b"})
        );
    }

    #[test]
    fn the_status_the_ui_stores_carries_no_key() {
        // Whatever state the engine is in, the serialized status has exactly
        // these fields. The key lives in `Inner.secret` and leaves only through
        // `llm_server_connection`.
        let state = LlmState::default();
        let key = supervisor::generate_api_key();
        *lock(&state.0.secret) = Some(Zeroizing::new(key.clone()));
        {
            let mut lc = lock(&state.0.lifecycle);
            let gen = lc.begin_start("qwen2.5-1.5b-instruct-q4").unwrap();
            lc.mark_running(gen, 50123);
        }
        let json = serde_json::to_value(state.0.status(None)).unwrap();
        let mut fields: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        fields.sort();
        assert_eq!(
            fields,
            ["engine_build", "engine_installed", "error", "model_id", "phase", "port", "restarts"]
        );
        assert_eq!(json["phase"], "running");
        assert_eq!(json["port"], 50123);
        assert!(!json.to_string().contains(&key));
    }

    #[test]
    fn phases_serialize_to_the_names_the_ui_expects() {
        for (phase, name) in [
            (Phase::Stopped, "stopped"),
            (Phase::Starting, "starting"),
            (Phase::Running, "running"),
            (Phase::Restarting, "restarting"),
            (Phase::Stopping, "stopping"),
            (Phase::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), serde_json::json!(name));
        }
    }

    #[test]
    fn free_space_comes_from_the_most_specific_mount() {
        let mounts = vec![
            (PathBuf::from("/"), 100),
            (PathBuf::from("/System/Volumes/Data"), 200),
            (PathBuf::from("/Volumes/External"), 300),
        ];
        assert_eq!(free_on_mount(Path::new("/System/Volumes/Data/Users/a/llm"), &mounts), Some(200));
        assert_eq!(free_on_mount(Path::new("/Volumes/External/models"), &mounts), Some(300));
        assert_eq!(free_on_mount(Path::new("/Users/a/llm"), &mounts), Some(100));
        // A name that merely starts with a mount's name is not on that mount.
        assert_eq!(free_on_mount(Path::new("/Volumes/ExternalDrive2/x"), &mounts), Some(100));
        assert_eq!(free_on_mount(Path::new("relative/path"), &mounts), None);
        assert_eq!(free_on_mount(Path::new("/x"), &[]), None);
    }

    #[test]
    fn this_machine_reports_real_memory_and_disk_figures() {
        assert!(total_ram_bytes() > 512 * 1024 * 1024);
        let tmp = tempfile::tempdir().unwrap();
        // Known or unknown, never a nonsense value.
        if let Some(free) = free_disk_bytes(tmp.path()) {
            assert!(free > 0);
        }
    }

    #[test]
    fn a_model_is_refused_on_a_machine_with_too_little_memory() {
        let small = &catalog::CATALOG[0];
        assert!(check_memory(small, small.min_ram_bytes).is_ok());
        assert!(check_memory(small, 64 * GIB).is_ok());
        let err = check_memory(small, small.min_ram_bytes - 1).unwrap_err();
        assert_eq!(err.code, ErrorCode::InsufficientMemory);
        assert_eq!(err.needed_bytes, Some(small.min_ram_bytes));
        assert_eq!(err.available_bytes, Some(small.min_ram_bytes - 1));
        // An unknown reading never blocks.
        assert!(check_memory(small, 0).is_ok());
        // An 8 GB machine: the small model yes, the large one no.
        let large = catalog::CATALOG.last().unwrap();
        assert!(check_memory(small, 8 * GIB).is_ok());
        assert!(check_memory(large, 8 * GIB).is_err());
    }

    #[test]
    fn acceleration_is_metal_only_on_apple_silicon() {
        assert_eq!(acceleration("macos", "aarch64"), "metal");
        assert_eq!(acceleration("macos", "x86_64"), "cpu");
        assert_eq!(acceleration("linux", "x86_64"), "cpu");
    }

    #[test]
    fn the_http_scope_is_exactly_one_loopback_port() {
        let scope = engine_http_scope(50123);
        assert_eq!(scope, serde_json::json!({ "url": "http://127.0.0.1:50123/**" }));
        let url = scope["url"].as_str().unwrap();
        assert!(!url.contains(":*"), "no port wildcard");
        assert!(!url.contains("localhost") && !url.contains("0.0.0.0"));
    }

    #[test]
    fn only_our_own_engine_binary_is_ever_reaped() {
        let base = Path::new("/data/app/llm");
        let exe = base.join("engine/b1/llama-b1/llama-server");
        assert!(is_our_engine(Some(&exe), &exe, base));
        // The pid was recycled by something else.
        assert!(!is_our_engine(Some(Path::new("/usr/bin/ssh")), &exe, base));
        assert!(!is_our_engine(None, &exe, base));
        // A tampered record pointing outside our directory, or at another name.
        let outside = Path::new("/usr/local/bin/llama-server");
        assert!(!is_our_engine(Some(outside), outside, base));
        let other = base.join("engine/b1/other-tool");
        assert!(!is_our_engine(Some(&other), &other, base));
    }

    #[test]
    fn a_stale_pid_record_for_a_dead_or_foreign_process_is_just_removed() {
        let tmp = tempfile::tempdir().unwrap();
        // Our own test process is alive but is not llama-server: must survive.
        write_pid_record(tmp.path(), std::process::id(), Path::new("/nowhere/llama-server"));
        reap_stale_engine(tmp.path());
        assert!(!pid_file(tmp.path()).exists());
        // Garbage record.
        std::fs::write(pid_file(tmp.path()), b"not json").unwrap();
        reap_stale_engine(tmp.path());
        assert!(!pid_file(tmp.path()).exists());
        // No record at all.
        reap_stale_engine(tmp.path());
    }

    #[test]
    fn downloads_are_exclusive_per_id_and_released_when_they_end() {
        let state = LlmState::default();
        let inner = &state.0;
        let mut rx = inner.register_download("m").unwrap();
        assert_eq!(inner.register_download("m").unwrap_err().code, ErrorCode::Busy);
        assert!(inner.register_download("engine").is_ok());
        // Cancelling flips the switch the download is watching.
        lock(&inner.downloads).get("m").unwrap().send(true).unwrap();
        assert!(*rx.borrow_and_update());
        {
            let _guard = DownloadGuard { inner, id: "m".to_string() };
        }
        assert!(inner.register_download("m").is_ok(), "released by the guard");
    }

    #[cfg(unix)]
    fn alive(child: &mut std::process::Child) -> bool {
        child.try_wait().unwrap().is_none()
    }

    #[cfg(unix)]
    fn wait_dead(child: &mut std::process::Child) -> bool {
        for _ in 0..100 {
            if !alive(child) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn the_watchdog_kills_the_engine_when_the_app_side_of_the_pipe_closes() {
        // Stand-in engine: something that would otherwise outlive us.
        let mut engine = std::process::Command::new("sleep").arg("600").spawn().unwrap();
        let mut watchdog = spawn_watchdog(engine.id()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(alive(&mut engine), "nothing happens while the app holds the pipe");

        // The app "dies": its end of the pipe closes.
        drop(watchdog.stdin.take());
        assert!(wait_dead(&mut engine), "the engine must not outlive the app");
        let _ = watchdog.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_dismissed_watchdog_never_fires() {
        let mut engine = std::process::Command::new("sleep").arg("600").spawn().unwrap();
        let mut watchdog = spawn_watchdog(engine.id()).unwrap();
        // Normal stop path: the watchdog is killed BEFORE its pipe closes.
        watchdog.kill().unwrap();
        watchdog.wait().unwrap();
        drop(watchdog);
        std::thread::sleep(Duration::from_millis(300));
        assert!(alive(&mut engine), "killing the watchdog must not kill the engine");
        engine.kill().unwrap();
        engine.wait().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn killing_a_process_handle_kills_the_child_and_dismisses_its_watchdog() {
        let mut child = tokio::process::Command::new("sleep")
            .arg("600")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let watchdog = spawn_watchdog(pid).ok();
        assert!(child.try_wait().unwrap().is_none());
        let mut proc = Proc { child, watchdog, log: LogTail::default() };

        proc.kill_now();
        let status = tokio::time::timeout(Duration::from_secs(5), proc.child.wait()).await;
        assert!(status.is_ok(), "the child must exit promptly");
        assert!(proc.watchdog.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_engine_that_exits_while_starting_is_reported_with_its_last_words() {
        // A stand-in "engine" that prints an error and exits at once.
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("llama-server");
        std::fs::write(&fake, "#!/bin/sh\necho 'error: failed to load model' >&2\nexit 3\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let state = LlmState::default();
        let inner = &state.0;
        let generation = lock(&inner.lifecycle).begin_start("m").unwrap();
        let plan = LaunchPlan {
            base: tmp.path().to_path_buf(),
            binary: fake,
            model_path: tmp.path().join("m.gguf"),
            alias: "m".into(),
            ctx_size: 4096,
        };
        let err = launch_once(inner, generation, &plan).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::StartupFailed);
        assert!(err.message.contains("failed to load model"), "{}", err.message);
        assert!(lock(&inner.proc).is_none(), "nothing is left running");
        assert!(lock(&inner.secret).is_none(), "no key is kept for an engine that never ran");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_launch_superseded_by_stop_leaves_no_process_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("llama-server");
        // Never becomes healthy: just sits there.
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 600\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let state = LlmState::default();
        let inner = state.0.clone();
        let generation = lock(&inner.lifecycle).begin_start("m").unwrap();
        let plan = LaunchPlan {
            base: tmp.path().to_path_buf(),
            binary: fake,
            model_path: tmp.path().join("m.gguf"),
            alias: "m".into(),
            ctx_size: 4096,
        };
        let launching = {
            let inner = inner.clone();
            tokio::spawn(async move { launch_once(&inner, generation, &plan).await })
        };
        // Give it time to spawn, then stop as the user would.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(lock(&inner.proc).is_some(), "the stand-in engine is running");
        lock(&inner.lifecycle).begin_stop();
        inner.kill_proc().await;
        lock(&inner.lifecycle).finish_stop();

        let result = tokio::time::timeout(Duration::from_secs(5), launching).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(lock(&inner.proc).is_none());
        assert_eq!(lock(&inner.lifecycle).phase(), Phase::Stopped);
    }
}
