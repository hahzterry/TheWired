//! The managed engine's lifecycle as a pure state machine, plus how the child
//! process is invoked. Nothing here spawns or waits: `llm.rs` drives real
//! processes and asks this module what each event means, so every transition
//! and every restart decision is unit-tested without a `llama-server`.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::{ErrorCode, LlmError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Stopped,
    /// First launch requested by the user; waiting for the model to load.
    Starting,
    Running,
    /// The process died on its own and is being brought back.
    Restarting,
    Stopping,
    /// Gave up: the first launch failed, or it kept crashing.
    Failed,
}

#[derive(Debug, Clone, Copy)]
pub struct RestartPolicy {
    /// Automatic restarts allowed inside `window` before giving up.
    pub max_restarts: u32,
    pub window: Duration,
    /// Delay before the first restart; doubles each time, capped at `max_delay`.
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        RestartPolicy {
            max_restarts: 3,
            window: Duration::from_secs(10 * 60),
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(8),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashDecision {
    Restart { attempt: u32, delay: Duration },
    GiveUp,
}

/// One engine's lifecycle. Every start and stop bumps `generation`; background
/// tasks carry the generation they were started for and every transition they
/// request is ignored once it is stale, so a late health check or a supervisor
/// that outlived a Stop can never resurrect or overwrite newer state.
#[derive(Debug)]
pub struct Lifecycle {
    phase: Phase,
    model_id: Option<String>,
    port: Option<u16>,
    error: Option<LlmError>,
    crashes: VecDeque<Instant>,
    policy: RestartPolicy,
    generation: u64,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new(RestartPolicy::default())
    }
}

impl Lifecycle {
    pub fn new(policy: RestartPolicy) -> Self {
        Lifecycle {
            phase: Phase::Stopped,
            model_id: None,
            port: None,
            error: None,
            crashes: VecDeque::new(),
            policy,
            generation: 0,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
    }
    pub fn port(&self) -> Option<u16> {
        self.port
    }
    pub fn error(&self) -> Option<&LlmError> {
        self.error.as_ref()
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }
    /// An engine process may exist (or be about to).
    pub fn is_active(&self) -> bool {
        matches!(self.phase, Phase::Starting | Phase::Running | Phase::Restarting | Phase::Stopping)
    }

    /// Automatic restarts that happened inside the policy window.
    pub fn restarts(&self) -> u32 {
        self.crashes.len() as u32
    }

    /// The user asked to start `model_id`. Only valid from rest; returns the
    /// generation the launch must present to every later transition.
    pub fn begin_start(&mut self, model_id: &str) -> Result<u64, LlmError> {
        match self.phase {
            Phase::Stopped | Phase::Failed => {
                self.generation += 1;
                self.phase = Phase::Starting;
                self.model_id = Some(model_id.to_string());
                self.port = None;
                self.error = None;
                self.crashes.clear();
                Ok(self.generation)
            }
            _ => Err(LlmError::new(
                ErrorCode::Busy,
                "The engine is already starting or running. Stop it first.",
            )),
        }
    }

    /// The process is healthy and enforcing its key on `port`.
    pub fn mark_running(&mut self, generation: u64, port: u16) -> bool {
        if !self.is_current(generation) || !matches!(self.phase, Phase::Starting | Phase::Restarting) {
            return false;
        }
        self.phase = Phase::Running;
        self.port = Some(port);
        self.error = None;
        true
    }

    /// The user's own start attempt failed: report it, do not auto-retry.
    pub fn fail_start(&mut self, generation: u64, error: LlmError) -> bool {
        if !self.is_current(generation) || self.phase != Phase::Starting {
            return false;
        }
        self.phase = Phase::Failed;
        self.port = None;
        self.error = Some(error);
        true
    }

    /// The process exited without being asked to (or an automatic relaunch
    /// failed). Returns what to do, or `None` when the event is stale.
    pub fn on_exit(&mut self, generation: u64, now: Instant, detail: Option<String>) -> Option<CrashDecision> {
        if !self.is_current(generation) || !matches!(self.phase, Phase::Running | Phase::Restarting) {
            return None;
        }
        self.port = None;
        while self
            .crashes
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) > self.policy.window)
        {
            self.crashes.pop_front();
        }
        if self.crashes.len() as u32 >= self.policy.max_restarts {
            self.phase = Phase::Failed;
            let mut message = format!(
                "The engine stopped unexpectedly {} times in a row and was not restarted again.",
                self.crashes.len() + 1
            );
            if let Some(d) = detail.filter(|d| !d.trim().is_empty()) {
                message.push(' ');
                message.push_str(d.trim());
            }
            self.error = Some(LlmError::new(ErrorCode::Crashed, message));
            return Some(CrashDecision::GiveUp);
        }
        self.crashes.push_back(now);
        let attempt = self.crashes.len() as u32;
        let delay = self
            .policy
            .base_delay
            .saturating_mul(1u32 << (attempt - 1).min(16))
            .min(self.policy.max_delay);
        self.phase = Phase::Restarting;
        Some(CrashDecision::Restart { attempt, delay })
    }

    /// The user asked to stop (or the app is quitting). Invalidates every
    /// background task. Returns whether there may be a process to kill.
    pub fn begin_stop(&mut self) -> bool {
        self.generation += 1;
        let was_active = self.is_active();
        self.phase = if was_active { Phase::Stopping } else { Phase::Stopped };
        self.port = None;
        if !was_active {
            self.model_id = None;
            self.error = None;
            self.crashes.clear();
        }
        was_active
    }

    pub fn finish_stop(&mut self) {
        if self.phase == Phase::Stopping {
            self.phase = Phase::Stopped;
            self.model_id = None;
            self.error = None;
            self.crashes.clear();
        }
    }
}

/// Everything `llama-server` is told on its command line. The access key is
/// deliberately NOT here: argv is readable by every local user (`ps`), so the
/// key travels in the child's environment instead ([`server_env`]).
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub model_path: PathBuf,
    /// The name the server reports under `/v1/models` (our catalogue id).
    pub alias: String,
    pub port: u16,
    pub ctx_size: u32,
}

/// Loopback only. Never a routable or wildcard address.
pub const BIND_HOST: &str = "127.0.0.1";
pub const API_KEY_ENV: &str = "LLAMA_API_KEY";

pub fn server_args(cfg: &ServerConfig) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    let mut flag = |name: &str, value: OsString| {
        args.push(name.into());
        args.push(value);
    };
    flag("--host", BIND_HOST.into());
    flag("--port", cfg.port.to_string().into());
    flag("--model", cfg.model_path.clone().into_os_string());
    flag("--alias", cfg.alias.clone().into());
    flag("--ctx-size", cfg.ctx_size.to_string().into());
    // One slot: the whole context window belongs to the single conversation
    // in flight instead of being split between parallel slots.
    flag("--parallel", "1".into());
    // Chat templates with tool-call support, so the app's tools work.
    args.push("--jinja".into());
    // No bundled web UI: the only client is this app.
    args.push("--no-webui".into());
    args
}

pub fn server_env(api_key: &str) -> [(&'static str, String); 1] {
    [(API_KEY_ENV, api_key.to_string())]
}

/// A fresh 256-bit key, hex-encoded. Generated for every launch and never
/// written to disk.
pub fn generate_api_key() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Ask the OS for a free loopback port. The listener is closed again before
/// the engine binds it; if something else takes the port in between, the
/// engine fails to start and the launch is retried on another port.
pub fn pick_free_port() -> Result<u16, LlmError> {
    let listener = std::net::TcpListener::bind((BIND_HOST, 0))
        .map_err(|e| LlmError::new(ErrorCode::PortUnavailable, format!("No free local port: {e}")))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| LlmError::new(ErrorCode::PortUnavailable, format!("No free local port: {e}")))
}

/// Scrub one line of engine output before it is kept for error messages: the
/// key itself is replaced, and lines that talk about keys are dropped whole
/// (the server prints a masked form of it at startup).
pub fn sanitize_log_line(line: &str, api_key: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    if lower.contains("api_key") || lower.contains("api key") || lower.contains("api-key") {
        return None;
    }
    let cleaned = if api_key.is_empty() { line.to_string() } else { line.replace(api_key, "[redacted]") };
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(300).collect())
}

/// Why did a launch die before it became healthy? A lost race for the port is
/// worth another port; anything else is reported as is.
pub fn classify_startup_failure(log_tail: &[String]) -> ErrorCode {
    let port_lost = log_tail.iter().any(|line| {
        let l = line.to_ascii_lowercase();
        l.contains("address already in use")
            || l.contains("couldn't bind")
            || l.contains("could not bind")
            || l.contains("failed to bind")
            || l.contains("bind failed")
    });
    if port_lost {
        ErrorCode::PortUnavailable
    } else {
        ErrorCode::StartupFailed
    }
}

/// The last line of engine output that mentions a failure, if any.
pub fn error_line(log_tail: &[String]) -> Option<String> {
    log_tail
        .iter()
        .rev()
        .find(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("error") || l.contains("failed") || l.contains("unable") || l.contains("invalid")
        })
        .cloned()
}

/// The most useful line to show a person: the last one that mentions a failure,
/// else simply the last one.
pub fn failure_detail(log_tail: &[String]) -> Option<String> {
    error_line(log_tail).or_else(|| log_tail.last().cloned())
}

/// Why a RUNNING engine went away, as a sentence: what it said if it said
/// anything about a failure, otherwise how it exited. A healthy engine's last
/// line is routine chatter, which would only mislead.
pub fn crash_detail(log_tail: &[String], exit: &str) -> String {
    match error_line(log_tail) {
        Some(line) => format!("Last output: {line}"),
        None => format!("It exited with {exit}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> RestartPolicy {
        RestartPolicy {
            max_restarts: 3,
            window: Duration::from_secs(600),
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(8),
        }
    }

    fn running(lc: &mut Lifecycle) -> u64 {
        let gen = lc.begin_start("m").unwrap();
        assert!(lc.mark_running(gen, 4242));
        gen
    }

    // ── state machine ──────────────────────────────────────────────────────

    #[test]
    fn a_clean_start_and_stop_walks_every_phase() {
        let mut lc = Lifecycle::new(policy());
        assert_eq!(lc.phase(), Phase::Stopped);
        assert!(!lc.is_active());

        let gen = lc.begin_start("model-a").unwrap();
        assert_eq!(lc.phase(), Phase::Starting);
        assert_eq!(lc.model_id(), Some("model-a"));
        assert_eq!(lc.port(), None);

        assert!(lc.mark_running(gen, 51234));
        assert_eq!(lc.phase(), Phase::Running);
        assert_eq!(lc.port(), Some(51234));

        assert!(lc.begin_stop());
        assert_eq!(lc.phase(), Phase::Stopping);
        assert_eq!(lc.port(), None, "a stopping engine no longer advertises a port");
        lc.finish_stop();
        assert_eq!(lc.phase(), Phase::Stopped);
        assert_eq!(lc.model_id(), None);
    }

    #[test]
    fn a_second_start_is_refused_while_one_is_in_flight_or_running() {
        let mut lc = Lifecycle::new(policy());
        let gen = lc.begin_start("a").unwrap();
        assert_eq!(lc.begin_start("b").unwrap_err().code, ErrorCode::Busy);
        assert_eq!(lc.model_id(), Some("a"), "the refused start changed nothing");
        lc.mark_running(gen, 1);
        assert_eq!(lc.begin_start("b").unwrap_err().code, ErrorCode::Busy);
        lc.on_exit(gen, Instant::now(), None);
        assert_eq!(lc.phase(), Phase::Restarting);
        assert_eq!(lc.begin_start("b").unwrap_err().code, ErrorCode::Busy);
        lc.begin_stop();
        assert_eq!(lc.begin_start("b").unwrap_err().code, ErrorCode::Busy, "still stopping");
        lc.finish_stop();
        assert!(lc.begin_start("b").is_ok());
    }

    #[test]
    fn a_failed_first_start_is_reported_and_not_retried_automatically() {
        let mut lc = Lifecycle::new(policy());
        let gen = lc.begin_start("m").unwrap();
        assert!(lc.fail_start(gen, LlmError::new(ErrorCode::StartupFailed, "bad model")));
        assert_eq!(lc.phase(), Phase::Failed);
        assert_eq!(lc.error().unwrap().code, ErrorCode::StartupFailed);
        assert!(!lc.is_active());
        // No restart is ever scheduled out of Failed.
        assert_eq!(lc.on_exit(gen, Instant::now(), None), None);
        // The user can simply try again, which clears the error.
        let gen2 = lc.begin_start("m").unwrap();
        assert!(gen2 > gen);
        assert!(lc.error().is_none());
    }

    #[test]
    fn crashes_restart_with_backoff_then_give_up_at_the_limit() {
        let mut lc = Lifecycle::new(policy());
        let gen = running(&mut lc);
        let t0 = Instant::now();

        let expected = [1u64, 2, 4];
        for (i, secs) in expected.iter().enumerate() {
            let decision = lc.on_exit(gen, t0 + Duration::from_secs(i as u64 * 20), None).unwrap();
            assert_eq!(
                decision,
                CrashDecision::Restart { attempt: i as u32 + 1, delay: Duration::from_secs(*secs) }
            );
            assert_eq!(lc.phase(), Phase::Restarting);
            assert_eq!(lc.port(), None);
            assert_eq!(lc.restarts(), i as u32 + 1);
            assert!(lc.mark_running(gen, 5000 + i as u16), "the relaunch reports back under the same generation");
        }

        // Fourth crash inside the window: no more restarts.
        let decision = lc.on_exit(gen, t0 + Duration::from_secs(80), Some("  Last output: error: out of memory \n".into()));
        assert_eq!(decision, Some(CrashDecision::GiveUp));
        assert_eq!(lc.phase(), Phase::Failed);
        let err = lc.error().unwrap();
        assert_eq!(err.code, ErrorCode::Crashed);
        assert!(err.message.contains("4 times"), "{}", err.message);
        assert!(err.message.ends_with("again. Last output: error: out of memory"), "{}", err.message);
        // Terminal until the user acts.
        assert_eq!(lc.on_exit(gen, t0 + Duration::from_secs(81), None), None);
        assert!(!lc.mark_running(gen, 1));
    }

    #[test]
    fn the_backoff_is_capped() {
        let mut lc = Lifecycle::new(RestartPolicy { max_restarts: 10, ..policy() });
        let gen = running(&mut lc);
        let t0 = Instant::now();
        let mut delays = Vec::new();
        for i in 0..7u64 {
            match lc.on_exit(gen, t0 + Duration::from_secs(i), None).unwrap() {
                CrashDecision::Restart { delay, .. } => delays.push(delay.as_secs()),
                CrashDecision::GiveUp => panic!("gave up early"),
            }
            lc.mark_running(gen, 1);
        }
        assert_eq!(delays, vec![1, 2, 4, 8, 8, 8, 8]);
    }

    #[test]
    fn crashes_older_than_the_window_are_forgotten() {
        let mut lc = Lifecycle::new(policy());
        let gen = running(&mut lc);
        let t0 = Instant::now();
        for i in 0..3u64 {
            assert!(matches!(lc.on_exit(gen, t0 + Duration::from_secs(i), None), Some(CrashDecision::Restart { .. })));
            lc.mark_running(gen, 1);
        }
        // Eleven minutes of stable running later, a crash is a first crash again.
        let later = t0 + Duration::from_secs(11 * 60);
        assert_eq!(
            lc.on_exit(gen, later, None),
            Some(CrashDecision::Restart { attempt: 1, delay: Duration::from_secs(1) })
        );
        assert_eq!(lc.restarts(), 1);
    }

    #[test]
    fn a_failed_relaunch_counts_against_the_same_limit() {
        let mut lc = Lifecycle::new(policy());
        let gen = running(&mut lc);
        let t0 = Instant::now();
        assert!(matches!(lc.on_exit(gen, t0, None), Some(CrashDecision::Restart { attempt: 1, .. })));
        // The relaunch itself dies (phase is still Restarting): attempts 2, 3.
        assert!(matches!(lc.on_exit(gen, t0, None), Some(CrashDecision::Restart { attempt: 2, .. })));
        assert!(matches!(lc.on_exit(gen, t0, None), Some(CrashDecision::Restart { attempt: 3, .. })));
        assert_eq!(lc.on_exit(gen, t0, None), Some(CrashDecision::GiveUp));
        assert_eq!(lc.phase(), Phase::Failed);
    }

    #[test]
    fn stopping_invalidates_everything_a_background_task_might_still_do() {
        let mut lc = Lifecycle::new(policy());
        let gen = running(&mut lc);
        lc.on_exit(gen, Instant::now(), None);
        assert_eq!(lc.phase(), Phase::Restarting);

        // The user stops during the restart backoff.
        assert!(lc.begin_stop());
        assert!(!lc.is_current(gen));
        // The supervisor wakes up and tries to carry on: all ignored.
        assert!(!lc.mark_running(gen, 9999));
        assert_eq!(lc.on_exit(gen, Instant::now(), None), None);
        assert!(!lc.fail_start(gen, LlmError::new(ErrorCode::StartupFailed, "late")));
        assert_eq!(lc.phase(), Phase::Stopping);
        assert_eq!(lc.port(), None);
        lc.finish_stop();
        assert_eq!(lc.phase(), Phase::Stopped);
        assert_eq!(lc.restarts(), 0);
    }

    #[test]
    fn stopping_during_the_first_start_cancels_it() {
        let mut lc = Lifecycle::new(policy());
        let gen = lc.begin_start("m").unwrap();
        assert!(lc.begin_stop());
        lc.finish_stop();
        // The launch finally becomes healthy / fails: neither may apply.
        assert!(!lc.mark_running(gen, 1234));
        assert!(!lc.fail_start(gen, LlmError::new(ErrorCode::StartupFailed, "late")));
        assert_eq!(lc.phase(), Phase::Stopped);
    }

    #[test]
    fn a_stale_launch_cannot_mark_a_newer_one_running() {
        let mut lc = Lifecycle::new(policy());
        let old = lc.begin_start("a").unwrap();
        lc.begin_stop();
        lc.finish_stop();
        let new = lc.begin_start("b").unwrap();
        assert!(!lc.mark_running(old, 1111));
        assert_eq!(lc.phase(), Phase::Starting);
        assert!(lc.mark_running(new, 2222));
        assert_eq!(lc.port(), Some(2222));
        assert_eq!(lc.model_id(), Some("b"));
    }

    #[test]
    fn stopping_at_rest_or_after_a_failure_clears_the_error() {
        let mut lc = Lifecycle::new(policy());
        assert!(!lc.begin_stop(), "nothing to kill");
        assert_eq!(lc.phase(), Phase::Stopped);

        let gen = lc.begin_start("m").unwrap();
        lc.fail_start(gen, LlmError::new(ErrorCode::StartupFailed, "x"));
        assert!(!lc.begin_stop());
        assert_eq!(lc.phase(), Phase::Stopped);
        assert!(lc.error().is_none());
        assert_eq!(lc.model_id(), None);
    }

    #[test]
    fn mark_running_requires_a_launch_in_flight() {
        let mut lc = Lifecycle::new(policy());
        assert!(!lc.mark_running(0, 1), "nothing was started");
        let gen = running(&mut lc);
        assert!(!lc.mark_running(gen, 2), "already running");
        assert_eq!(lc.port(), Some(4242));
    }

    // ── argument construction ──────────────────────────────────────────────

    fn config() -> ServerConfig {
        ServerConfig {
            model_path: PathBuf::from("/data/My Models/qwen.gguf"),
            alias: "qwen2.5-1.5b-instruct-q4".into(),
            port: 49152,
            ctx_size: 8192,
        }
    }

    fn value_of<'a>(args: &'a [OsString], flag: &str) -> &'a OsString {
        let i = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("missing {flag}"));
        &args[i + 1]
    }

    #[test]
    fn the_server_binds_loopback_on_the_chosen_port() {
        let args = server_args(&config());
        assert_eq!(value_of(&args, "--host"), "127.0.0.1");
        assert_eq!(value_of(&args, "--port"), "49152");
        for a in &args {
            let s = a.to_string_lossy();
            assert!(s != "0.0.0.0" && s != "::" && s != "localhost", "{s}");
        }
    }

    #[test]
    fn the_model_path_is_one_argument_even_with_spaces() {
        let args = server_args(&config());
        assert_eq!(value_of(&args, "--model"), "/data/My Models/qwen.gguf");
        assert_eq!(value_of(&args, "--alias"), "qwen2.5-1.5b-instruct-q4");
        assert_eq!(value_of(&args, "--ctx-size"), "8192");
        assert_eq!(value_of(&args, "--parallel"), "1");
        assert!(args.iter().any(|a| a == "--jinja"));
        assert!(args.iter().any(|a| a == "--no-webui"));
    }

    #[test]
    fn the_access_key_never_appears_on_the_command_line() {
        let key = generate_api_key();
        let args = server_args(&config());
        for a in &args {
            let s = a.to_string_lossy();
            assert!(!s.contains(&key), "key leaked into argv");
            assert!(!s.contains("api-key"), "no key flag at all: {s}");
        }
        assert_eq!(server_env(&key), [("LLAMA_API_KEY", key.clone())]);
    }

    #[test]
    fn keys_are_long_random_and_different_every_launch() {
        let a = generate_api_key();
        let b = generate_api_key();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert_ne!(a, "0".repeat(64));
    }

    #[test]
    fn a_picked_port_is_a_usable_loopback_port() {
        let port = pick_free_port().unwrap();
        assert!(port >= 1024);
        // It was released: we can bind it ourselves.
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    // ── log handling ───────────────────────────────────────────────────────

    #[test]
    fn engine_output_is_scrubbed_of_the_key() {
        let key = "deadbeef".repeat(8);
        assert_eq!(
            sanitize_log_line(&format!("auth header was {key} ok"), &key).unwrap(),
            "auth header was [redacted] ok"
        );
        assert_eq!(sanitize_log_line("srv  init: api_keys: ****cdef", &key), None);
        assert_eq!(sanitize_log_line("main: API key loaded", &key), None);
        assert_eq!(sanitize_log_line("   ", &key), None);
        assert_eq!(sanitize_log_line("  model loaded  ", &key).unwrap(), "model loaded");
        assert_eq!(sanitize_log_line(&"x".repeat(1000), &key).unwrap().len(), 300);
        assert_eq!(sanitize_log_line("plain", "").unwrap(), "plain");
    }

    #[test]
    fn startup_failures_are_classified_and_summarised() {
        let bind = vec!["loading model".to_string(), "main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 5000".to_string()];
        assert_eq!(classify_startup_failure(&bind), ErrorCode::PortUnavailable);
        assert_eq!(
            classify_startup_failure(&["bind: Address already in use".to_string()]),
            ErrorCode::PortUnavailable
        );
        let model = vec![
            "llama_model_load: error loading model: invalid magic".to_string(),
            "main: exiting".to_string(),
        ];
        assert_eq!(classify_startup_failure(&model), ErrorCode::StartupFailed);
        assert_eq!(failure_detail(&model).unwrap(), "llama_model_load: error loading model: invalid magic");
        assert_eq!(failure_detail(&["just this".to_string()]).unwrap(), "just this");
        assert_eq!(classify_startup_failure(&[]), ErrorCode::StartupFailed);
        assert_eq!(failure_detail(&[]), None);
    }

    #[test]
    fn a_crash_is_described_by_its_error_or_else_by_how_it_exited() {
        // Killed from outside: its last line is routine, so say how it exited.
        let routine = vec!["srv  server_on_li: listening on http://127.0.0.1:59026".to_string()];
        assert_eq!(error_line(&routine), None);
        assert_eq!(
            crash_detail(&routine, "signal: 9 (SIGKILL)"),
            "It exited with signal: 9 (SIGKILL)."
        );
        // It said why: quote that.
        let oom = vec!["listening".to_string(), "ggml_metal: error: insufficient memory".to_string(), "bye".to_string()];
        assert_eq!(
            crash_detail(&oom, "exit status: 1"),
            "Last output: ggml_metal: error: insufficient memory"
        );
        assert_eq!(crash_detail(&[], "exit status: 0"), "It exited with exit status: 0.");
    }
}
