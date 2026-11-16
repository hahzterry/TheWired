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
//! child through its environment (never argv, never disk) and otherwise never
//! leaves this process: the webview does not talk to the engine's port at all.
//! Its chat requests come in over IPC ([`llm_request`]) and this module makes
//! the HTTP call, adds the key, and streams the answer back. So the webview
//! needs no loopback HTTP permission, in dev or in a packaged build, and the
//! key is in no status, event, or reply.

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
    /// A request arrived while the engine was not running.
    NotRunning,
    /// A request named a model other than the one that is loaded.
    ModelMismatch,
    /// A request for something the webview may not ask the engine for.
    NotAllowed,
    /// A download server answered with something that is not the pinned file.
    UnexpectedResponse,
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
    /// In-flight engine requests made for the webview: id → cancel switch.
    requests: Mutex<HashMap<String, watch::Sender<bool>>>,
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
            requests: Mutex::new(HashMap::new()),
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

    /// Where the running engine is and the key it wants. `model_id`, when
    /// given, must be the model that is loaded: the server answers with
    /// whatever it has loaded regardless of what a request names, so a caller
    /// that raced a model switch would otherwise get the wrong model's answer
    /// under the right model's label.
    fn endpoint(&self, model_id: Option<&str>) -> Result<EngineEndpoint, LlmError> {
        let (port, loaded) = {
            let lc = lock(&self.lifecycle);
            match (lc.phase(), lc.port(), lc.model_id()) {
                (Phase::Running, Some(port), Some(model)) => (port, model.to_string()),
                _ => return Err(not_running()),
            }
        };
        if model_id.is_some_and(|wanted| wanted != loaded) {
            return Err(LlmError::new(
                ErrorCode::ModelMismatch,
                "The engine is running a different model than the one this chat uses.",
            ));
        }
        let key = lock(&self.secret).clone().ok_or_else(not_running)?;
        Ok(EngineEndpoint { port, key })
    }

    fn register_request(&self, id: &str) -> Result<watch::Receiver<bool>, LlmError> {
        if id.is_empty() || id.len() > 64 {
            return Err(LlmError::new(ErrorCode::NotAllowed, "Invalid request id."));
        }
        let mut requests = lock(&self.requests);
        if requests.contains_key(id) {
            return Err(LlmError::new(ErrorCode::Busy, "That request is already in progress."));
        }
        let (tx, rx) = watch::channel(false);
        requests.insert(id.to_string(), tx);
        Ok(rx)
    }
}

fn not_running() -> LlmError {
    LlmError::new(ErrorCode::NotRunning, "The engine is not running.")
}

/// Removes an engine request's cancel switch when the request ends.
struct RequestGuard<'a> {
    inner: &'a Inner,
    id: String,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        lock(&self.inner.requests).remove(&self.id);
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
/// is what lands in the Redux store and in [`STATUS_EVENT`]. It carries neither
/// the key nor the port: the webview never connects to the engine itself.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineStatus {
    pub phase: Phase,
    pub model_id: Option<String>,
    /// Automatic restarts since the engine was started.
    pub restarts: u32,
    pub error: Option<LlmError>,
    pub engine_installed: bool,
    pub engine_build: &'static str,
}

fn emit_status(app: &AppHandle, inner: &Inner) {
    let base = base_dir(app).ok();
    let _ = app.emit(STATUS_EVENT, inner.status(base.as_deref()));
}

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
        let mut detail = Some(supervisor::crash_detail(&inner.log_snapshot(), &exit));
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
    for cancel in lock(&inner.requests).values() {
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

// ── requests on the webview's behalf ───────────────────────────────────────

/// The loaded engine's address and key. Never serialized, never leaves this
/// process.
struct EngineEndpoint {
    port: u16,
    key: Zeroizing<String>,
}

/// Largest request body accepted from the webview (a full context window of
/// chat history plus tool schemas is well under this).
const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The ONLY things the webview may ask the engine for. This is a fixed table,
/// not a path prefix: there is no way to reach any other endpoint, port or
/// host through [`llm_request`].
fn allowed_route(method: &str, path: &str) -> Option<reqwest::Method> {
    match (method, path) {
        ("POST", "/v1/chat/completions") => Some(reqwest::Method::POST),
        ("GET", "/v1/models") => Some(reqwest::Method::GET),
        _ => None,
    }
}

/// What the webview receives for one request, in order: the status line, the
/// body as text pieces, then `End`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProxyEvent {
    Head { status: u16 },
    Chunk { text: String },
    End,
}

/// Turns network chunks into valid UTF-8 text pieces. A chunk boundary can
/// fall inside a multi-byte character; the unfinished tail is held back until
/// the rest arrives, so no character is ever corrupted in transit.
#[derive(Default)]
struct Utf8Chunker {
    pending: Vec<u8>,
}

impl Utf8Chunker {
    fn push(&mut self, bytes: &[u8]) -> Option<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(&String::from_utf8_lossy(&self.pending[..valid]));
                    match e.error_len() {
                        // Bytes that can never be valid: replace and carry on.
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..valid + bad);
                        }
                        // An unfinished character at the end: wait for more.
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }
        (!out.is_empty()).then_some(out)
    }

    /// Whatever is left when the stream ends (an unfinished character).
    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        Some(rest)
    }
}

fn request_client() -> Result<reqwest::Client, LlmError> {
    reqwest::Client::builder()
        // Never send loopback traffic (and the key) through a system proxy.
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        // Between chunks, not overall: a long answer may stream for minutes,
        // and a large prompt can take a while before the first token.
        .read_timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| LlmError::new(ErrorCode::Io, format!("http client: {e}")))
}

/// Resolves once `cancel` is `true` (or its sender is gone, which never is).
async fn request_cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Make one request to the engine and stream the answer to `on_event`.
async fn forward_request(
    endpoint: &EngineEndpoint,
    method: reqwest::Method,
    path: &str,
    body: Option<String>,
    cancel: &mut watch::Receiver<bool>,
    on_event: &mut (dyn FnMut(ProxyEvent) + Send),
) -> Result<(), LlmError> {
    let unreachable = |e: reqwest::Error| {
        LlmError::new(ErrorCode::Network, format!("The engine did not answer: {}", e.without_url()))
    };
    let client = request_client()?;
    let url = format!("http://{}:{}{path}", supervisor::BIND_HOST, endpoint.port);
    let mut request = client.request(method, url).bearer_auth(endpoint.key.as_str());
    if let Some(body) = body {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
    }
    let mut response = tokio::select! {
        r = request.send() => r.map_err(unreachable)?,
        _ = request_cancelled(cancel) => return Err(cancelled()),
    };
    on_event(ProxyEvent::Head { status: response.status().as_u16() });

    let mut chunker = Utf8Chunker::default();
    loop {
        let chunk = tokio::select! {
            c = response.chunk() => c.map_err(unreachable)?,
            _ = request_cancelled(cancel) => return Err(cancelled()),
        };
        match chunk {
            Some(bytes) => {
                if let Some(text) = chunker.push(&bytes) {
                    on_event(ProxyEvent::Chunk { text });
                }
            }
            None => break,
        }
    }
    if let Some(text) = chunker.finish() {
        on_event(ProxyEvent::Chunk { text });
    }
    on_event(ProxyEvent::End);
    Ok(())
}

/// Ask the running engine something on the webview's behalf and stream the
/// answer back. The webview supplies only a method + path from a fixed table,
/// a JSON body, and (for chat) the model it expects to be loaded; the address
/// and the key are added here.
#[tauri::command]
pub async fn llm_request(
    state: State<'_, LlmState>,
    request_id: String,
    method: String,
    path: String,
    body: Option<String>,
    model_id: Option<String>,
    on_event: Channel<ProxyEvent>,
) -> Result<(), LlmError> {
    let route = allowed_route(&method, &path).ok_or_else(|| {
        LlmError::new(ErrorCode::NotAllowed, "That engine request is not allowed.")
    })?;
    if body.as_ref().is_some_and(|b| b.len() > MAX_REQUEST_BODY_BYTES) {
        return Err(LlmError::new(ErrorCode::NotAllowed, "That request is too large."));
    }
    let inner = &state.0;
    let endpoint = inner.endpoint(model_id.as_deref())?;
    let mut cancel = inner.register_request(&request_id)?;
    let _guard = RequestGuard { inner, id: request_id };
    forward_request(&endpoint, route, &path, body, &mut cancel, &mut |event| {
        let _ = on_event.send(event);
    })
    .await
}

/// Stop streaming an engine request (the user pressed Stop).
#[tauri::command]
pub async fn llm_request_cancel(state: State<'_, LlmState>, request_id: String) -> Result<(), LlmError> {
    if let Some(cancel) = lock(&state.0.requests).get(&request_id) {
        let _ = cancel.send(true);
    }
    Ok(())
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
            (ErrorCode::NotRunning, "not_running"),
            (ErrorCode::ModelMismatch, "model_mismatch"),
            (ErrorCode::NotAllowed, "not_allowed"),
            (ErrorCode::UnexpectedResponse, "unexpected_response"),
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
        // these fields. The key lives in `Inner.secret` and never leaves this
        // process.
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
            ["engine_build", "engine_installed", "error", "model_id", "phase", "restarts"]
        );
        assert_eq!(json["phase"], "running");
        assert!(!json.to_string().contains(&key));
        assert!(!json.to_string().contains("50123"), "the port stays native too");
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

    // ── requests on the webview's behalf ───────────────────────────────────

    #[test]
    fn only_two_engine_routes_exist_for_the_webview() {
        assert_eq!(allowed_route("POST", "/v1/chat/completions"), Some(reqwest::Method::POST));
        assert_eq!(allowed_route("GET", "/v1/models"), Some(reqwest::Method::GET));
        for (method, path) in [
            ("GET", "/v1/chat/completions"),
            ("POST", "/v1/models"),
            ("POST", "/v1/completions"),
            ("POST", "/v1/embeddings"),
            ("GET", "/health"),
            ("GET", "/slots"),
            ("POST", "/props"),
            ("DELETE", "/v1/models"),
            ("post", "/v1/chat/completions"),
            ("POST", "/v1/chat/completions/"),
            ("POST", "/v1/chat/completions?x=1"),
            ("POST", "//evil.example/v1/chat/completions"),
            ("POST", "@evil.example/v1/chat/completions"),
            ("POST", "/v1/../v1/chat/completions"),
            ("POST", "http://evil.example/v1/chat/completions"),
            ("POST", ""),
        ] {
            assert_eq!(allowed_route(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn the_engine_endpoint_exists_only_while_running_the_expected_model() {
        let state = LlmState::default();
        let inner = &state.0;
        assert_eq!(inner.endpoint(None).err().unwrap().code, ErrorCode::NotRunning);

        let generation = lock(&inner.lifecycle).begin_start("model-a").unwrap();
        // Starting: no port yet, so nothing may be sent.
        assert_eq!(inner.endpoint(None).err().unwrap().code, ErrorCode::NotRunning);
        lock(&inner.lifecycle).mark_running(generation, 50123);
        // Running but the key is not in place (never happens, but must fail closed).
        assert_eq!(inner.endpoint(None).err().unwrap().code, ErrorCode::NotRunning);

        *lock(&inner.secret) = Some(Zeroizing::new("k".repeat(64)));
        let endpoint = inner.endpoint(Some("model-a")).unwrap();
        assert_eq!(endpoint.port, 50123);
        assert_eq!(endpoint.key.as_str(), "k".repeat(64));
        assert!(inner.endpoint(None).is_ok());
        // A chat that expects another model must not be answered by this one.
        assert_eq!(inner.endpoint(Some("model-b")).err().unwrap().code, ErrorCode::ModelMismatch);

        // Crashed and restarting: nothing may be sent until it is back.
        lock(&inner.lifecycle).on_exit(generation, Instant::now(), None);
        assert_eq!(inner.endpoint(Some("model-a")).err().unwrap().code, ErrorCode::NotRunning);
    }

    #[test]
    fn engine_requests_are_exclusive_per_id_and_released_when_they_end() {
        let state = LlmState::default();
        let inner = &state.0;
        let _rx = inner.register_request("r1").unwrap();
        assert_eq!(inner.register_request("r1").unwrap_err().code, ErrorCode::Busy);
        assert_eq!(inner.register_request("").unwrap_err().code, ErrorCode::NotAllowed);
        assert_eq!(inner.register_request(&"x".repeat(65)).unwrap_err().code, ErrorCode::NotAllowed);
        {
            let _guard = RequestGuard { inner, id: "r1".to_string() };
        }
        assert!(inner.register_request("r1").is_ok());
    }

    #[test]
    fn text_is_never_split_inside_a_character() {
        let text = "héllo → 日本語 🎉";
        let bytes = text.as_bytes();
        // Every possible two-way split of the byte stream gives the same text.
        for cut in 0..=bytes.len() {
            let mut chunker = Utf8Chunker::default();
            let mut out = String::new();
            for piece in [&bytes[..cut], &bytes[cut..]] {
                if let Some(t) = chunker.push(piece) {
                    assert!(!t.contains(char::REPLACEMENT_CHARACTER), "cut {cut}");
                    out.push_str(&t);
                }
            }
            assert_eq!(chunker.finish(), None, "cut {cut}");
            assert_eq!(out, text, "cut {cut}");
        }
        // One byte at a time.
        let mut chunker = Utf8Chunker::default();
        let out: String = bytes.iter().filter_map(|b| chunker.push(&[*b])).collect();
        assert_eq!(out, text);

        // Bytes that can never be valid are replaced, and the stream continues.
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(b"a\xffb").unwrap(), "a\u{fffd}b");
        // A stream that ends mid-character flushes what it has.
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(&"é".as_bytes()[..1]), None);
        assert_eq!(chunker.finish().unwrap(), "\u{fffd}");
    }

    /// A stand-in engine: checks the bearer key like the real one and streams a
    /// scripted body. Records what it was asked.
    fn fake_engine(
        key: &'static str,
        chunks: Vec<&'static [u8]>,
    ) -> (u16, Arc<Mutex<Vec<(String, String, String)>>>) {
        struct Scripted {
            chunks: std::collections::VecDeque<&'static [u8]>,
        }
        impl std::io::Read for Scripted {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                match self.chunks.pop_front() {
                    None => Ok(0),
                    Some(chunk) => {
                        buf[..chunk.len()].copy_from_slice(chunk);
                        Ok(chunk.len())
                    }
                }
            }
        }
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let auth = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_default();
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                log.lock().unwrap().push((format!("{} {}", request.method(), request.url()), auth.clone(), body));
                if auth != format!("Bearer {key}") {
                    let _ = request.respond(
                        tiny_http::Response::from_string(r#"{"error":{"message":"Invalid API Key"}}"#)
                            .with_status_code(401),
                    );
                    continue;
                }
                let reader = Scripted { chunks: chunks.clone().into() };
                // No length: chunked, like a streamed completion.
                let _ = request.respond(tiny_http::Response::new(
                    tiny_http::StatusCode(200),
                    vec![],
                    reader,
                    None,
                    None,
                ));
            }
        });
        (port, seen)
    }

    const TEST_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn a_forwarded_chat_carries_the_key_and_streams_the_answer_in_order() {
        let (port, seen) = fake_engine(
            TEST_KEY,
            vec![b"data: {\"a\":1}\n\n", b"data: caf\xc3", b"\xa9\n\n", b"data: [DONE]\n\n"],
        );
        let endpoint = EngineEndpoint { port, key: Zeroizing::new(TEST_KEY.to_string()) };
        let (_tx, mut cancel) = watch::channel(false);
        let mut events = Vec::new();
        forward_request(
            &endpoint,
            reqwest::Method::POST,
            "/v1/chat/completions",
            Some(r#"{"model":"m","stream":true}"#.to_string()),
            &mut cancel,
            &mut |e| events.push(e),
        )
        .await
        .unwrap();

        assert_eq!(events.first(), Some(&ProxyEvent::Head { status: 200 }));
        assert_eq!(events.last(), Some(&ProxyEvent::End));
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                ProxyEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        // The "é" split across two network chunks arrives whole.
        assert_eq!(text, "data: {\"a\":1}\n\ndata: café\n\ndata: [DONE]\n\n");
        // The key reached the engine, and only as the bearer token.
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "POST /v1/chat/completions");
        assert_eq!(seen[0].1, format!("Bearer {TEST_KEY}"));
        assert_eq!(seen[0].2, r#"{"model":"m","stream":true}"#);
        // ...and is in nothing the webview is sent.
        assert!(!serde_json::to_string(&events).unwrap().contains(TEST_KEY));
    }

    #[tokio::test]
    async fn an_engine_error_status_is_passed_through_not_hidden() {
        let (port, _seen) = fake_engine(TEST_KEY, vec![]);
        // A wrong key (cannot happen in the app; proves the status is relayed).
        let endpoint = EngineEndpoint { port, key: Zeroizing::new("wrong".to_string()) };
        let (_tx, mut cancel) = watch::channel(false);
        let mut events = Vec::new();
        forward_request(&endpoint, reqwest::Method::GET, "/v1/models", None, &mut cancel, &mut |e| events.push(e))
            .await
            .unwrap();
        assert_eq!(events[0], ProxyEvent::Head { status: 401 });
        assert!(matches!(&events[1], ProxyEvent::Chunk { text } if text.contains("Invalid API Key")));
        assert_eq!(events.last(), Some(&ProxyEvent::End));
    }

    /// A stand-in engine that trickles an endless event stream, flushing each
    /// event as a real server does while generating.
    fn slow_stream_engine() -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match stream.read(&mut byte) {
                        Ok(1) => head.push(byte[0]),
                        _ => break,
                    }
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
                );
                for _ in 0..500 {
                    let event = b"data: 1\n\n";
                    let sent = stream
                        .write_all(format!("{:x}\r\n", event.len()).as_bytes())
                        .and_then(|_| stream.write_all(event))
                        .and_then(|_| stream.write_all(b"\r\n"))
                        .and_then(|_| stream.flush());
                    if sent.is_err() {
                        break; // the client hung up
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn cancelling_stops_a_stream_in_flight() {
        let port = slow_stream_engine();
        let endpoint = EngineEndpoint { port, key: Zeroizing::new(TEST_KEY.to_string()) };
        let (tx, mut cancel) = watch::channel(false);
        let mut chunks = 0usize;
        let started = Instant::now();
        let result = forward_request(
            &endpoint,
            reqwest::Method::POST,
            "/v1/chat/completions",
            Some("{}".to_string()),
            &mut cancel,
            &mut |e| {
                if matches!(e, ProxyEvent::Chunk { .. }) {
                    chunks += 1;
                    if chunks == 2 {
                        let _ = tx.send(true);
                    }
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(chunks >= 2 && chunks < 100, "the stream stopped early ({chunks} chunks)");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn an_engine_that_is_gone_is_a_clear_error() {
        // A port nothing listens on (bound, then released).
        let port = supervisor::pick_free_port().unwrap();
        let endpoint = EngineEndpoint { port, key: Zeroizing::new(TEST_KEY.to_string()) };
        let (_tx, mut cancel) = watch::channel(false);
        let mut events = Vec::new();
        let err = forward_request(&endpoint, reqwest::Method::GET, "/v1/models", None, &mut cancel, &mut |e| events.push(e))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Network);
        assert!(events.is_empty(), "no status is invented for a request that never connected");
        assert!(!err.message.contains(TEST_KEY));
    }

    #[test]
    fn the_engine_has_no_build_specific_code_path() {
        // The webview reaches the engine only through IPC, so nothing here may
        // depend on whether this is a dev or a packaged build. (An earlier
        // design granted loopback HTTP at runtime in packaged builds only, which
        // no dev run could ever exercise.)
        for (name, source) in [
            ("llm.rs", include_str!("llm.rs")),
            ("llm/engine.rs", include_str!("llm/engine.rs")),
            ("llm/download.rs", include_str!("llm/download.rs")),
            ("llm/supervisor.rs", include_str!("llm/supervisor.rs")),
            ("llm/catalog.rs", include_str!("llm/catalog.rs")),
        ] {
            let needle_dev = ["cfg(", "dev)"].concat();
            let needle_not_dev = ["cfg(not(", "dev))"].concat();
            let needle_capability = ["add_", "capability"].concat();
            assert!(!source.contains(&needle_dev), "{name} has dev-only code");
            assert!(!source.contains(&needle_not_dev), "{name} has packaged-only code");
            assert!(!source.contains(&needle_capability), "{name} grants a capability at runtime");
        }
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
