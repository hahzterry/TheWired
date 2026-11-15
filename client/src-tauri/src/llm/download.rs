//! Resumable, verified downloads for the managed engine and its models.
//!
//! A download lands in `<dest>.part`, is hashed in full once complete, and is
//! renamed to `<dest>` only when its size and SHA-256 match the pinned values.
//! A file at `<dest>` has therefore always been verified at least once. A
//! `<dest>.ok` fingerprint (size + mtime at verification time) lets later
//! launches skip re-hashing a multi-gigabyte file unless it changed on disk.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

use super::{ErrorCode, LlmError};

/// Headroom kept free on the volume beyond the bytes still to fetch.
pub const DISK_MARGIN_BYTES: u64 = 256 * 1024 * 1024;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub struct DownloadSpec {
    pub url: String,
    pub dest: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Progress reported to the webview over a `tauri::ipc::Channel`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DownloadEvent {
    Progress { downloaded: u64, total: u64 },
    Verifying,
    Done,
}

pub fn part_path(dest: &Path) -> PathBuf {
    with_suffix(dest, ".part")
}

pub fn fingerprint_path(dest: &Path) -> PathBuf {
    with_suffix(dest, ".ok")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// What to do with whatever is already in `<dest>.part`.
#[derive(Debug, PartialEq, Eq)]
pub enum ResumePlan {
    /// Nothing usable on disk: fetch from byte 0.
    Fresh,
    /// Continue an interrupted download.
    Resume { from: u64 },
    /// Every byte is already there: only verification is left.
    VerifyOnly,
    /// The partial file is larger than the pinned size, so it cannot be a
    /// prefix of the real file. Discard it and start over.
    Restart,
}

pub fn resume_plan(part_len: Option<u64>, expected: u64) -> ResumePlan {
    match part_len {
        None | Some(0) => ResumePlan::Fresh,
        Some(len) if len < expected => ResumePlan::Resume { from: len },
        Some(len) if len == expected => ResumePlan::VerifyOnly,
        Some(_) => ResumePlan::Restart,
    }
}

/// How to treat the response body given the byte offset we asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum BodyAction {
    /// The server honoured the range: append to the partial file.
    Append,
    /// The server sent the whole file (no range, or it ignored ours).
    Overwrite,
    /// `416 Range Not Satisfiable`: our partial file does not line up with the
    /// server's copy. Discard it and fetch from byte 0.
    Restart,
}

pub fn body_action(
    requested_from: u64,
    status: u16,
    content_range: Option<&str>,
) -> Result<BodyAction, LlmError> {
    match status {
        200 => Ok(BodyAction::Overwrite),
        206 => {
            let start = content_range.and_then(parse_content_range_start);
            match start {
                Some(s) if s == requested_from => {
                    Ok(if s == 0 { BodyAction::Overwrite } else { BodyAction::Append })
                }
                // No header on a from-zero request is still the whole file.
                None if requested_from == 0 => Ok(BodyAction::Overwrite),
                _ => Err(LlmError::new(
                    ErrorCode::Network,
                    "The download server answered with a different byte range than requested.",
                )),
            }
        }
        416 if requested_from > 0 => Ok(BodyAction::Restart),
        other => Err(LlmError::new(
            ErrorCode::Network,
            format!("The download server answered with HTTP {other}."),
        )),
    }
}

/// `bytes 100-999/1000` → `100`.
pub fn parse_content_range_start(value: &str) -> Option<u64> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, _total) = rest.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    start.trim().parse().ok()
}

/// Refuse to start (or resume) a download the volume cannot hold. An unknown
/// free-space figure does not block: the write itself will fail if it must.
pub fn check_disk(expected: u64, part_len: u64, free: Option<u64>) -> Result<(), LlmError> {
    let remaining = expected.saturating_sub(part_len.min(expected));
    let needed = remaining.saturating_add(DISK_MARGIN_BYTES);
    match free {
        Some(available) if available < needed => Err(LlmError {
            needed_bytes: Some(needed),
            available_bytes: Some(available),
            ..LlmError::new(
                ErrorCode::InsufficientDisk,
                "Not enough free disk space for this download.",
            )
        }),
        _ => Ok(()),
    }
}

/// SHA-256 of a file, streamed (never loads a multi-gigabyte model in memory).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Size first (a truncated or padded file is rejected without hashing it), then
/// the digest. Any mismatch is `hash_mismatch`: the file is not the pinned one.
pub fn verify_file(path: &Path, expected_size: u64, expected_sha256: &str) -> Result<(), LlmError> {
    let len = std::fs::metadata(path)
        .map_err(|e| LlmError::io("read the downloaded file", e))?
        .len();
    if len != expected_size {
        return Err(LlmError::new(
            ErrorCode::HashMismatch,
            format!("The file is {len} bytes but {expected_size} were expected."),
        ));
    }
    let got = sha256_file(path).map_err(|e| LlmError::io("hash the downloaded file", e))?;
    if got.len() == expected_sha256.len() && got.eq_ignore_ascii_case(expected_sha256) {
        Ok(())
    } else {
        Err(LlmError::new(
            ErrorCode::HashMismatch,
            "The file does not match its expected checksum.",
        ))
    }
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct Fingerprint {
    size: u64,
    mtime_ns: u128,
    sha256: String,
}

fn stat_fingerprint(path: &Path, sha256: &str) -> Option<Fingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ns = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(Fingerprint { size: meta.len(), mtime_ns, sha256: sha256.to_ascii_lowercase() })
}

/// Record that `dest` (as it is on disk right now) passed verification.
pub fn write_fingerprint(dest: &Path, sha256: &str) -> Result<(), LlmError> {
    let fp = stat_fingerprint(dest, sha256)
        .ok_or_else(|| LlmError::new(ErrorCode::Io, "Could not read the verified file's metadata."))?;
    let json = serde_json::to_vec(&fp).map_err(|e| LlmError::new(ErrorCode::Io, e.to_string()))?;
    std::fs::write(fingerprint_path(dest), json).map_err(|e| LlmError::io("record verification", e))
}

/// True when `dest` is byte-for-byte unchanged (by size and mtime) since it was
/// verified against this exact digest.
pub fn fingerprint_matches(dest: &Path, sha256: &str) -> bool {
    let Some(current) = stat_fingerprint(dest, sha256) else { return false };
    let Ok(raw) = std::fs::read(fingerprint_path(dest)) else { return false };
    serde_json::from_slice::<Fingerprint>(&raw).is_ok_and(|saved| saved == current)
}

/// Make sure an installed file is still the pinned one. Cheap when untouched;
/// re-hashes when the file changed since it was verified. A file that fails is
/// removed so it can never be loaded and a fresh download can replace it.
pub fn ensure_verified(dest: &Path, expected_size: u64, expected_sha256: &str) -> Result<(), LlmError> {
    if fingerprint_matches(dest, expected_sha256) {
        return Ok(());
    }
    match verify_file(dest, expected_size, expected_sha256) {
        Ok(()) => write_fingerprint(dest, expected_sha256),
        Err(e) => {
            if e.code == ErrorCode::HashMismatch {
                remove_all(dest);
            }
            Err(e)
        }
    }
}

/// Remove a download and everything derived from it.
pub fn remove_all(dest: &Path) {
    let _ = std::fs::remove_file(dest);
    let _ = std::fs::remove_file(part_path(dest));
    let _ = std::fs::remove_file(fingerprint_path(dest));
}

fn cancelled() -> LlmError {
    LlmError::new(ErrorCode::Cancelled, "Download cancelled.")
}

fn network(context: &str, e: reqwest::Error) -> LlmError {
    // `without_url`: a redirect target can carry a signed query string.
    LlmError::new(ErrorCode::Network, format!("{context}: {}", e.without_url()))
}

/// Download `spec.url` to `spec.dest`, resuming a previous attempt when one is
/// on disk, and verify it before it becomes visible at `spec.dest`.
///
/// Cancelling (`cancel` flips to `true`) and network failures keep the partial
/// file so the next call resumes; a checksum failure deletes it.
pub async fn download_verified(
    client: &reqwest::Client,
    spec: &DownloadSpec,
    cancel: &mut watch::Receiver<bool>,
    free_space: Option<u64>,
    on_event: &mut (dyn FnMut(DownloadEvent) + Send),
) -> Result<(), LlmError> {
    if spec.dest.is_file() && fingerprint_matches(&spec.dest, &spec.sha256) {
        on_event(DownloadEvent::Done);
        return Ok(());
    }
    if *cancel.borrow() {
        return Err(cancelled());
    }
    if let Some(parent) = spec.dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LlmError::io("create the download folder", e))?;
    }

    let part = part_path(&spec.dest);
    let part_len = std::fs::metadata(&part).ok().map(|m| m.len());
    let mut from = match resume_plan(part_len, spec.size_bytes) {
        ResumePlan::Fresh => Some(0),
        ResumePlan::Resume { from } => Some(from),
        ResumePlan::VerifyOnly => None,
        ResumePlan::Restart => {
            let _ = std::fs::remove_file(&part);
            Some(0)
        }
    };

    if let Some(offset) = from {
        check_disk(spec.size_bytes, offset, free_space)?;
    }

    // At most two passes: the second only after a 416 told us to start over.
    let mut restarted = false;
    while let Some(offset) = from {
        match fetch_into(client, spec, &part, offset, cancel, on_event).await? {
            FetchOutcome::Complete => from = None,
            FetchOutcome::Restart if !restarted => {
                restarted = true;
                let _ = std::fs::remove_file(&part);
                from = Some(0);
            }
            FetchOutcome::Restart => {
                return Err(LlmError::new(
                    ErrorCode::Network,
                    "The download server keeps rejecting the requested byte range.",
                ));
            }
        }
    }

    on_event(DownloadEvent::Verifying);
    let (verify_path, size, sha) = (part.clone(), spec.size_bytes, spec.sha256.clone());
    let verified = tokio::task::spawn_blocking(move || verify_file(&verify_path, size, &sha))
        .await
        .map_err(|e| LlmError::new(ErrorCode::Io, format!("verification task failed: {e}")))?;
    if let Err(e) = verified {
        // Never keep bytes that are not the pinned file: a resume would only
        // append to the same bad prefix.
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }

    std::fs::rename(&part, &spec.dest).map_err(|e| LlmError::io("finish the download", e))?;
    write_fingerprint(&spec.dest, &spec.sha256)?;
    on_event(DownloadEvent::Done);
    Ok(())
}

enum FetchOutcome {
    Complete,
    Restart,
}

async fn fetch_into(
    client: &reqwest::Client,
    spec: &DownloadSpec,
    part: &Path,
    from: u64,
    cancel: &mut watch::Receiver<bool>,
    on_event: &mut (dyn FnMut(DownloadEvent) + Send),
) -> Result<FetchOutcome, LlmError> {
    let mut request = client.get(&spec.url);
    if from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
    }
    let mut response = tokio::select! {
        r = request.send() => r.map_err(|e| network("Could not reach the download server", e))?,
        _ = wait_cancelled(cancel) => return Err(cancelled()),
    };

    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let action = body_action(from, response.status().as_u16(), content_range.as_deref())?;

    let mut downloaded = match action {
        BodyAction::Restart => return Ok(FetchOutcome::Restart),
        BodyAction::Append => from,
        BodyAction::Overwrite => 0,
    };
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(action == BodyAction::Append)
        .truncate(action == BodyAction::Overwrite)
        .open(part)
        .await
        .map_err(|e| LlmError::io("open the partial download", e))?;

    on_event(DownloadEvent::Progress { downloaded, total: spec.size_bytes });
    let mut last_emit = Instant::now();
    loop {
        let chunk = tokio::select! {
            c = response.chunk() => c,
            _ = wait_cancelled(cancel) => {
                let _ = file.flush().await;
                return Err(cancelled());
            }
        };
        let chunk = match chunk {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(e) => {
                let _ = file.flush().await;
                return Err(network("The download was interrupted", e));
            }
        };
        downloaded += chunk.len() as u64;
        if downloaded > spec.size_bytes {
            drop(file);
            let _ = std::fs::remove_file(part);
            return Err(LlmError::new(
                ErrorCode::HashMismatch,
                "The server sent more data than the expected file size.",
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| LlmError::io("write the download to disk", e))?;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            on_event(DownloadEvent::Progress { downloaded, total: spec.size_bytes });
        }
    }
    file.flush().await.map_err(|e| LlmError::io("write the download to disk", e))?;
    file.sync_all().await.map_err(|e| LlmError::io("write the download to disk", e))?;
    on_event(DownloadEvent::Progress { downloaded, total: spec.size_bytes });

    if downloaded < spec.size_bytes {
        return Err(LlmError::new(
            ErrorCode::Network,
            "The connection closed before the download finished. Start it again to resume.",
        ));
    }
    Ok(FetchOutcome::Complete)
}

/// Resolves once the cancel flag is `true` (or its sender is gone).
async fn wait_cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            // Sender dropped without cancelling: never resolve.
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const GIB: u64 = 1024 * 1024 * 1024;

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn payload(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    // ── resume planning ────────────────────────────────────────────────────

    #[test]
    fn resume_plan_covers_every_partial_file_size() {
        assert_eq!(resume_plan(None, 100), ResumePlan::Fresh);
        assert_eq!(resume_plan(Some(0), 100), ResumePlan::Fresh);
        assert_eq!(resume_plan(Some(1), 100), ResumePlan::Resume { from: 1 });
        assert_eq!(resume_plan(Some(99), 100), ResumePlan::Resume { from: 99 });
        assert_eq!(resume_plan(Some(100), 100), ResumePlan::VerifyOnly);
        // Larger than the pinned size: cannot be a prefix of the real file.
        assert_eq!(resume_plan(Some(101), 100), ResumePlan::Restart);
    }

    #[test]
    fn body_action_appends_only_when_the_server_honours_the_exact_range() {
        assert_eq!(body_action(0, 200, None).unwrap(), BodyAction::Overwrite);
        assert_eq!(body_action(0, 206, Some("bytes 0-99/100")).unwrap(), BodyAction::Overwrite);
        assert_eq!(body_action(0, 206, None).unwrap(), BodyAction::Overwrite);
        assert_eq!(body_action(40, 206, Some("bytes 40-99/100")).unwrap(), BodyAction::Append);
        // Range ignored: the body is the whole file, so the partial is replaced.
        assert_eq!(body_action(40, 200, None).unwrap(), BodyAction::Overwrite);
        // Partial file no longer lines up with the server's copy.
        assert_eq!(body_action(40, 416, None).unwrap(), BodyAction::Restart);
        // A range we did not ask for must never be appended.
        assert_eq!(body_action(40, 206, Some("bytes 0-99/100")).unwrap_err().code, ErrorCode::Network);
        assert_eq!(body_action(40, 206, Some("bytes 41-99/100")).unwrap_err().code, ErrorCode::Network);
        assert_eq!(body_action(40, 206, None).unwrap_err().code, ErrorCode::Network);
        assert_eq!(body_action(0, 416, None).unwrap_err().code, ErrorCode::Network);
        for status in [301, 401, 403, 404, 429, 500, 503] {
            assert_eq!(body_action(0, status, None).unwrap_err().code, ErrorCode::Network, "{status}");
        }
    }

    #[test]
    fn content_range_start_is_parsed_strictly() {
        assert_eq!(parse_content_range_start("bytes 100-999/1000"), Some(100));
        assert_eq!(parse_content_range_start("bytes 0-0/1"), Some(0));
        assert_eq!(parse_content_range_start(" bytes 7-9/* "), Some(7));
        assert_eq!(parse_content_range_start("bytes */1000"), None);
        assert_eq!(parse_content_range_start("items 0-9/10"), None);
        assert_eq!(parse_content_range_start("bytes -5-9/10"), None);
        assert_eq!(parse_content_range_start(""), None);
    }

    // ── disk space ─────────────────────────────────────────────────────────

    #[test]
    fn disk_check_counts_only_the_bytes_still_to_fetch_plus_a_margin() {
        assert!(check_disk(GIB, 0, Some(GIB + DISK_MARGIN_BYTES)).is_ok());
        let err = check_disk(GIB, 0, Some(GIB + DISK_MARGIN_BYTES - 1)).unwrap_err();
        assert_eq!(err.code, ErrorCode::InsufficientDisk);
        assert_eq!(err.needed_bytes, Some(GIB + DISK_MARGIN_BYTES));
        assert_eq!(err.available_bytes, Some(GIB + DISK_MARGIN_BYTES - 1));

        // Resuming needs only the remainder.
        let half = GIB / 2;
        assert!(check_disk(GIB, half, Some(half + DISK_MARGIN_BYTES)).is_ok());
        assert!(check_disk(GIB, half, Some(half)).is_err());
        // A partial larger than the file never underflows.
        assert!(check_disk(GIB, 2 * GIB, Some(DISK_MARGIN_BYTES)).is_ok());
        // Unknown free space does not block.
        assert!(check_disk(GIB, 0, None).is_ok());
        assert!(check_disk(GIB, 0, Some(0)).is_err());
    }

    // ── hash verification ──────────────────────────────────────────────────

    #[test]
    fn verify_file_accepts_the_exact_file_only() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("m.gguf");
        let data = payload(300_000);
        std::fs::write(&path, &data).unwrap();
        let digest = sha(&data);

        assert!(verify_file(&path, data.len() as u64, &digest).is_ok());
        assert!(verify_file(&path, data.len() as u64, &digest.to_uppercase()).is_ok());

        // Bad: same length, one byte flipped.
        let mut bad = data.clone();
        bad[150_000] ^= 0xff;
        std::fs::write(&path, &bad).unwrap();
        assert_eq!(verify_file(&path, data.len() as u64, &digest).unwrap_err().code, ErrorCode::HashMismatch);

        // Truncated: a valid prefix of the real file.
        std::fs::write(&path, &data[..data.len() - 1]).unwrap();
        let err = verify_file(&path, data.len() as u64, &digest).unwrap_err();
        assert_eq!(err.code, ErrorCode::HashMismatch);
        assert!(err.message.contains("bytes"), "{}", err.message);
        // ...and its own digest must not rescue it when the size is wrong.
        let prefix_digest = sha(&data[..data.len() - 1]);
        assert!(verify_file(&path, data.len() as u64, &prefix_digest).is_err());

        // Padded.
        let mut long = data.clone();
        long.push(0);
        std::fs::write(&path, &long).unwrap();
        assert_eq!(verify_file(&path, data.len() as u64, &digest).unwrap_err().code, ErrorCode::HashMismatch);

        // Empty digest / wrong digest / missing file.
        std::fs::write(&path, &data).unwrap();
        assert!(verify_file(&path, data.len() as u64, "").is_err());
        assert!(verify_file(&path, data.len() as u64, &sha(b"other")).is_err());
        assert_eq!(
            verify_file(&tmp.path().join("missing"), 1, &digest).unwrap_err().code,
            ErrorCode::Io
        );
    }

    #[test]
    fn sha256_file_matches_a_known_vector() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_file_changed_after_verification_is_rehashed_and_removed_when_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("m.gguf");
        let data = payload(200_000);
        let digest = sha(&data);
        std::fs::write(&dest, &data).unwrap();

        // First use: no fingerprint yet, so it is hashed and recorded.
        assert!(!fingerprint_matches(&dest, &digest));
        ensure_verified(&dest, data.len() as u64, &digest).unwrap();
        assert!(fingerprint_matches(&dest, &digest));
        // A bumped catalogue digest invalidates the old fingerprint.
        assert!(!fingerprint_matches(&dest, &sha(b"new pin")));

        // Corrupt in place, keeping the size (as `dd conv=notrunc` would), and
        // make sure the mtime differs even on coarse filesystems.
        let mut bad = data.clone();
        bad[10] ^= 1;
        std::fs::write(&dest, &bad).unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options().write(true).open(&dest).unwrap().set_modified(later).unwrap();

        assert!(!fingerprint_matches(&dest, &digest));
        let err = ensure_verified(&dest, data.len() as u64, &digest).unwrap_err();
        assert_eq!(err.code, ErrorCode::HashMismatch);
        assert!(!dest.exists(), "a corrupt model must not stay loadable");
        assert!(!fingerprint_path(&dest).exists());
    }

    // ── end-to-end against a local HTTP server ─────────────────────────────

    #[derive(Clone, Default)]
    struct ServerOpts {
        /// Ignore `Range` and always answer 200 with the whole file.
        ignore_range: bool,
        /// Answer every ranged request with 416.
        reject_range: bool,
        /// Trickle the body so a test can cancel mid-stream.
        slow: bool,
    }

    struct TestServer {
        url: String,
        ranges: Arc<Mutex<Vec<Option<u64>>>>,
        hits: Arc<AtomicUsize>,
        opts: Arc<Mutex<ServerOpts>>,
    }

    struct SlowReader {
        data: std::io::Cursor<Vec<u8>>,
    }
    impl Read for SlowReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            std::thread::sleep(Duration::from_millis(20));
            let n = buf.len().min(4096);
            self.data.read(&mut buf[..n])
        }
    }

    /// A raw-socket server for the one thing `tiny_http` cannot do: promise a
    /// full body, send only `cut_after` bytes of it, and drop the connection.
    /// Every later connection is served properly, honouring `Range`.
    fn serve_cut_then_ok(body: Vec<u8>, cut_after: usize) -> (String, Arc<Mutex<Vec<Option<u64>>>>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let seen = ranges.clone();
        std::thread::spawn(move || {
            for (index, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { continue };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match stream.read(&mut byte) {
                        Ok(1) => head.push(byte[0]),
                        _ => break,
                    }
                }
                let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                let from = head
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .and_then(|v| v.trim().trim_end_matches('-').parse::<u64>().ok());
                seen.lock().unwrap().push(from);
                let start = from.unwrap_or(0) as usize;
                let slice = &body[start.min(body.len())..];
                let header = match from {
                    Some(_) => format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nConnection: close\r\n\r\n",
                        slice.len(),
                        body.len() - 1,
                        body.len()
                    ),
                    None => format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    ),
                };
                let _ = stream.write_all(header.as_bytes());
                let send = if index == 0 { &slice[..cut_after.min(slice.len())] } else { slice };
                let _ = stream.write_all(send);
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });
        (format!("http://127.0.0.1:{port}/file"), ranges)
    }

    fn serve(body: Vec<u8>, opts: ServerOpts) -> TestServer {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let opts = Arc::new(Mutex::new(opts));
        let (r2, h2, o2) = (ranges.clone(), hits.clone(), opts.clone());
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                h2.fetch_add(1, Ordering::SeqCst);
                let opts = o2.lock().unwrap().clone();
                let from = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .and_then(|h| h.value.as_str().strip_prefix("bytes=").map(str::to_owned))
                    .and_then(|v| v.trim_end_matches('-').parse::<u64>().ok());
                r2.lock().unwrap().push(from);

                let total = body.len();
                let start = match from {
                    Some(_) if opts.reject_range => {
                        let _ = request.respond(tiny_http::Response::empty(416));
                        continue;
                    }
                    Some(f) if !opts.ignore_range => f as usize,
                    _ => 0,
                };
                if start > total {
                    let _ = request.respond(tiny_http::Response::empty(416));
                    continue;
                }
                let slice = body[start..].to_vec();
                let len = slice.len();
                let ranged = from.is_some() && !opts.ignore_range;
                let status = if ranged { 206 } else { 200 };
                let mut headers = Vec::new();
                if ranged {
                    headers.push(
                        tiny_http::Header::from_bytes(
                            &b"Content-Range"[..],
                            format!("bytes {start}-{}/{total}", total.saturating_sub(1)).as_bytes(),
                        )
                        .unwrap(),
                    );
                }
                let reader: Box<dyn Read + Send> = if opts.slow {
                    Box::new(SlowReader { data: std::io::Cursor::new(slice) })
                } else {
                    Box::new(std::io::Cursor::new(slice))
                };
                let response = tiny_http::Response::new(
                    tiny_http::StatusCode(status),
                    headers,
                    reader,
                    Some(len),
                    None,
                );
                let _ = request.respond(response);
            }
        });
        TestServer { url: format!("http://127.0.0.1:{port}/file"), ranges, hits, opts }
    }

    fn client() -> reqwest::Client {
        // The read timeout is a safety net: no test may wait on a socket forever.
        reqwest::Client::builder()
            .no_proxy()
            .read_timeout(Duration::from_secs(10))
            .build()
            .unwrap()
    }

    fn spec(server: &TestServer, dir: &Path, data: &[u8]) -> DownloadSpec {
        DownloadSpec {
            url: server.url.clone(),
            dest: dir.join("model.gguf"),
            size_bytes: data.len() as u64,
            sha256: sha(data),
        }
    }

    async fn run(spec: &DownloadSpec, free: Option<u64>) -> (Result<(), LlmError>, Vec<DownloadEvent>) {
        let (_tx, mut rx) = watch::channel(false);
        let mut events = Vec::new();
        let result = download_verified(&client(), spec, &mut rx, free, &mut |e| events.push(e)).await;
        (result, events)
    }

    #[tokio::test]
    async fn a_fresh_download_is_verified_then_published() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(400_000);
        let server = serve(data.clone(), ServerOpts::default());
        let spec = spec(&server, tmp.path(), &data);

        let (result, events) = run(&spec, None).await;
        result.unwrap();
        assert_eq!(std::fs::read(&spec.dest).unwrap(), data);
        assert!(!part_path(&spec.dest).exists());
        assert!(fingerprint_matches(&spec.dest, &spec.sha256));
        assert_eq!(server.ranges.lock().unwrap().as_slice(), &[None]);
        // Progress, then verification, then done — in that order.
        let verifying = events.iter().position(|e| *e == DownloadEvent::Verifying).unwrap();
        assert!(matches!(events[0], DownloadEvent::Progress { downloaded: 0, .. }));
        assert_eq!(events.last(), Some(&DownloadEvent::Done));
        assert!(events[..verifying].contains(&DownloadEvent::Progress {
            downloaded: data.len() as u64,
            total: data.len() as u64
        }));

        // Already installed and untouched: no second request.
        let (again, events) = run(&spec, None).await;
        again.unwrap();
        assert_eq!(events, vec![DownloadEvent::Done]);
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_interrupted_download_resumes_from_the_partial_file() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(500_000);
        let (url, ranges) = serve_cut_then_ok(data.clone(), 120_000);
        let spec = DownloadSpec {
            url,
            dest: tmp.path().join("model.gguf"),
            size_bytes: data.len() as u64,
            sha256: sha(&data),
        };

        // The connection drops after 120 000 of 500 000 bytes.
        let (first, _) = run(&spec, None).await;
        assert_eq!(first.unwrap_err().code, ErrorCode::Network);
        assert!(!spec.dest.exists(), "an unfinished download is never published");
        let partial = std::fs::metadata(part_path(&spec.dest)).unwrap().len();
        assert!(partial > 0 && partial <= 120_000, "{partial}");
        // What is on disk is a true prefix of the file.
        assert_eq!(std::fs::read(part_path(&spec.dest)).unwrap(), &data[..partial as usize]);

        let (second, events) = run(&spec, None).await;
        second.unwrap();
        assert_eq!(std::fs::read(&spec.dest).unwrap(), data);
        assert_eq!(ranges.lock().unwrap().as_slice(), &[None, Some(partial)]);
        assert!(matches!(events[0], DownloadEvent::Progress { downloaded, .. } if downloaded == partial));
    }

    #[tokio::test]
    async fn cancelling_keeps_the_partial_file_and_the_next_run_resumes() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(600_000);
        let server = serve(data.clone(), ServerOpts { slow: true, ..Default::default() });
        let spec = spec(&server, tmp.path(), &data);

        let (tx, mut rx) = watch::channel(false);
        let mut seen = 0u64;
        let result = download_verified(&client(), &spec, &mut rx, None, &mut |e| {
            if let DownloadEvent::Progress { downloaded, .. } = e {
                seen = downloaded;
                if downloaded > 0 {
                    let _ = tx.send(true);
                }
            }
        })
        .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(seen > 0 && seen < data.len() as u64);
        assert!(!spec.dest.exists());
        let partial = std::fs::metadata(part_path(&spec.dest)).unwrap().len();
        assert!(partial > 0 && partial < data.len() as u64);

        server.opts.lock().unwrap().slow = false;
        let (resumed, _) = run(&spec, None).await;
        resumed.unwrap();
        assert_eq!(std::fs::read(&spec.dest).unwrap(), data);
        assert_eq!(server.ranges.lock().unwrap().last(), Some(&Some(partial)));
    }

    #[tokio::test]
    async fn a_cancel_requested_before_the_start_never_touches_the_network() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(10_000);
        let server = serve(data.clone(), ServerOpts::default());
        let spec = spec(&server, tmp.path(), &data);
        let (_tx, mut rx) = watch::channel(true);
        let result = download_verified(&client(), &spec, &mut rx, None, &mut |_| {}).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(server.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_corrupted_partial_file_fails_verification_and_is_discarded() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(300_000);
        let server = serve(data.clone(), ServerOpts::default());
        let spec = spec(&server, tmp.path(), &data);

        // A partial whose bytes are NOT a prefix of the real file.
        std::fs::write(part_path(&spec.dest), vec![0xAAu8; 100_000]).unwrap();
        let (result, events) = run(&spec, None).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::HashMismatch);
        assert!(events.contains(&DownloadEvent::Verifying));
        assert!(!events.contains(&DownloadEvent::Done));
        assert!(!spec.dest.exists(), "unverified bytes must never be published");
        assert!(!part_path(&spec.dest).exists(), "the bad partial must not be resumed again");

        // The retry starts clean and succeeds.
        let (retry, _) = run(&spec, None).await;
        retry.unwrap();
        assert_eq!(std::fs::read(&spec.dest).unwrap(), data);
    }

    #[tokio::test]
    async fn a_server_serving_the_wrong_bytes_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let real = payload(200_000);
        let mut served = real.clone();
        served[77] ^= 0x01;
        let server = serve(served, ServerOpts::default());
        let spec = spec(&server, tmp.path(), &real);
        let (result, _) = run(&spec, None).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::HashMismatch);
        assert!(!spec.dest.exists());
        assert!(!part_path(&spec.dest).exists());
    }

    #[tokio::test]
    async fn a_server_sending_more_than_the_pinned_size_is_cut_off() {
        let tmp = tempfile::tempdir().unwrap();
        let served = payload(300_000);
        let server = serve(served.clone(), ServerOpts::default());
        let mut spec = spec(&server, tmp.path(), &served);
        spec.size_bytes = 50_000;
        let (result, _) = run(&spec, None).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::HashMismatch);
        assert!(!part_path(&spec.dest).exists());
    }

    #[tokio::test]
    async fn a_server_that_ignores_range_restarts_the_file_instead_of_appending() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(250_000);
        let server = serve(data.clone(), ServerOpts { ignore_range: true, ..Default::default() });
        let spec = spec(&server, tmp.path(), &data);
        std::fs::write(part_path(&spec.dest), &data[..90_000]).unwrap();

        let (result, _) = run(&spec, None).await;
        result.unwrap();
        // Appending the full body to the prefix would have produced 340 000 bytes.
        assert_eq!(std::fs::read(&spec.dest).unwrap(), data);
    }

    #[tokio::test]
    async fn a_rejected_range_discards_the_partial_and_starts_over_once() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(150_000);
        let server = serve(data.clone(), ServerOpts { reject_range: true, ..Default::default() });
        let spec = spec(&server, tmp.path(), &data);
        std::fs::write(part_path(&spec.dest), &data[..50_000]).unwrap();

        let (result, _) = run(&spec, None).await;
        result.unwrap();
        assert_eq!(std::fs::read(&spec.dest).unwrap(), data);
        assert_eq!(server.ranges.lock().unwrap().as_slice(), &[Some(50_000), None]);
    }

    #[tokio::test]
    async fn an_oversized_partial_is_thrown_away_and_a_complete_one_is_only_verified() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(120_000);
        let server = serve(data.clone(), ServerOpts::default());
        let spec = spec(&server, tmp.path(), &data);

        let mut oversized = data.clone();
        oversized.extend_from_slice(b"junk");
        std::fs::write(part_path(&spec.dest), &oversized).unwrap();
        let (result, _) = run(&spec, None).await;
        result.unwrap();
        assert_eq!(server.ranges.lock().unwrap().as_slice(), &[None]);

        // Complete partial (e.g. the app quit during verification): no request.
        std::fs::remove_file(&spec.dest).unwrap();
        std::fs::write(part_path(&spec.dest), &data).unwrap();
        let (result, events) = run(&spec, None).await;
        result.unwrap();
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
        assert_eq!(events, vec![DownloadEvent::Verifying, DownloadEvent::Done]);
    }

    #[tokio::test]
    async fn too_little_disk_space_fails_before_any_request() {
        let tmp = tempfile::tempdir().unwrap();
        let data = payload(100_000);
        let server = serve(data.clone(), ServerOpts::default());
        let spec = spec(&server, tmp.path(), &data);
        let (result, events) = run(&spec, Some(1024)).await;
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::InsufficientDisk);
        assert_eq!(err.available_bytes, Some(1024));
        assert!(events.is_empty());
        assert_eq!(server.hits.load(Ordering::SeqCst), 0);
        assert!(!part_path(&spec.dest).exists());
    }

    #[tokio::test]
    async fn an_http_error_is_a_network_failure_and_publishes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let _ = request.respond(tiny_http::Response::empty(404));
            }
        });
        let spec = DownloadSpec {
            url: format!("http://127.0.0.1:{port}/missing"),
            dest: tmp.path().join("m.gguf"),
            size_bytes: 10,
            sha256: sha(b"0123456789"),
        };
        let (result, _) = run(&spec, None).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Network);
        assert!(!spec.dest.exists());
    }
}
