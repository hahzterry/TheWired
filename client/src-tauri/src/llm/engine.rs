//! Download-on-enable of the `llama-server` runtime.
//!
//! Same pattern as `cloudflared.rs`: the runtime is a separate process fetched
//! into the app's data directory the first time the user asks for it, never
//! bundled (the app's own signature and size are untouched, and only people
//! who use local AI pay for it).
//!
//! Supply chain: one upstream llama.cpp build is PINNED, and every archive we
//! can select has its exact size and SHA-256 in [`asset_for`]. The archive is
//! verified before a single byte is unpacked, unpacked into a staging directory
//! with a strict entry filter, and only then moved into place. We execute this
//! binary with the user's privileges, so TLS alone is not enough.

use std::path::{Component, Path, PathBuf};

use tokio::sync::watch;

use super::download::{download_verified, remove_all, DownloadEvent, DownloadSpec};
use super::{ErrorCode, LlmError};

/// The llama.cpp build we install (the binary build published with v1.0.0).
///
/// To bump: pick a build tag on <https://github.com/ggml-org/llama.cpp/releases>,
/// then refresh EVERY entry in [`asset_for`] from that release's asset list —
/// `gh api repos/ggml-org/llama.cpp/releases/tags/<tag>
/// --jq '.assets[] | "\(.name) \(.size) \(.digest)"'` — and spot-check one
/// archive with `shasum -a 256`. Re-run the app's managed-engine QA afterwards:
/// `server_args` in `supervisor.rs` depends on this build's command line.
pub const PINNED_BUILD: &str = "b12359";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineAsset {
    pub name: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}

/// The release archive for an OS/architecture pair, or `None` when we do not
/// ship the managed engine there. CPU/Metal builds only: they need nothing
/// installed beyond the OS. Windows archives are `.zip` and are not wired up.
pub fn asset_for(os: &str, arch: &str) -> Option<EngineAsset> {
    Some(match (os, arch) {
        ("macos", "aarch64") => EngineAsset {
            name: "llama-b12359-bin-macos-arm64.tar.gz",
            size_bytes: 16_907_811,
            sha256: "82b00abc740160e1b9980e6cc79c117345fa34af058c80e6c0a69aa8ddccde75",
        },
        ("macos", "x86_64") => EngineAsset {
            name: "llama-b12359-bin-macos-x64.tar.gz",
            size_bytes: 12_661_621,
            sha256: "25320d529077ef5a3d16e7b5da26438f221d88c8c0930a32b0c79457f5eede56",
        },
        ("linux", "x86_64") => EngineAsset {
            name: "llama-b12359-bin-ubuntu-x64.tar.gz",
            size_bytes: 23_311_084,
            sha256: "0bc1f091e8916102b6d8f2cf944233a620e90a0f856c72d0ce41150c65c2e72e",
        },
        ("linux", "aarch64") => EngineAsset {
            name: "llama-b12359-bin-ubuntu-arm64.tar.gz",
            size_bytes: 18_949_862,
            sha256: "dc7aa17a67884619b7223870aca9fd6addbc01717713b04a714add1c31137359",
        },
        _ => return None,
    })
}

pub fn asset_for_this_platform() -> Option<EngineAsset> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn download_url(asset: &EngineAsset) -> String {
    format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{PINNED_BUILD}/{}",
        asset.name
    )
}

const SERVER_NAME: &str = "llama-server";
/// Written last, inside the staging directory, so a directory that has it was
/// fully unpacked and checked before it was moved into place.
const INSTALLED_MARKER: &str = ".installed";

fn engine_root(base: &Path) -> PathBuf {
    base.join("engine")
}

pub fn install_dir(base: &Path) -> PathBuf {
    engine_root(base).join(PINNED_BUILD)
}

/// The installed `llama-server` for the pinned build, if any.
pub fn installed_binary(base: &Path) -> Option<PathBuf> {
    let dir = install_dir(base);
    let asset = asset_for_this_platform()?;
    let marker = std::fs::read_to_string(dir.join(INSTALLED_MARKER)).ok()?;
    if marker.trim() != asset.sha256 {
        return None;
    }
    find_server_binary(&dir)
}

/// Locate `llama-server` at most three levels below `dir` (release archives
/// have put it at the top level and under `build/bin/` over time).
pub fn find_server_binary(dir: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: u8) -> Option<PathBuf> {
        let direct = dir.join(SERVER_NAME);
        if std::fs::symlink_metadata(&direct).is_ok_and(|m| m.is_file()) {
            return Some(direct);
        }
        if depth == 0 {
            return None;
        }
        let mut subdirs: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        subdirs.into_iter().find_map(|d| walk(&d, depth - 1))
    }
    walk(dir, 3)
}

const MAX_ENTRIES: usize = 10_000;
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// A relative path made only of normal components (`./` prefixes dropped).
fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// A symlink is kept only when it points at a sibling by bare file name
/// (`libllama.dylib -> libllama.0.dylib`). Anything with a directory in it
/// could leave the install directory.
fn safe_link_target(target: &Path) -> bool {
    let mut components = target.components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    )
}

/// Unpack a `.tar.gz` into `dest` (which must not exist yet). Only regular
/// files, directories and sibling symlinks with in-tree relative paths are
/// accepted; anything else fails the whole install.
pub fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), LlmError> {
    let invalid = |why: String| LlmError::new(ErrorCode::EngineInvalid, why);
    let file = std::fs::File::open(archive).map_err(|e| LlmError::io("open the engine archive", e))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    std::fs::create_dir_all(dest).map_err(|e| LlmError::io("create the engine folder", e))?;

    let mut entries = 0usize;
    let mut unpacked = 0u64;
    for entry in tar.entries().map_err(|e| invalid(format!("unreadable engine archive: {e}")))? {
        let mut entry = entry.map_err(|e| invalid(format!("unreadable engine archive: {e}")))?;
        entries += 1;
        unpacked = unpacked.saturating_add(entry.header().size().unwrap_or(0));
        if entries > MAX_ENTRIES || unpacked > MAX_UNPACKED_BYTES {
            return Err(invalid("engine archive is implausibly large".into()));
        }
        let raw = entry
            .path()
            .map_err(|e| invalid(format!("bad path in engine archive: {e}")))?
            .into_owned();
        let Some(rel) = safe_relative(&raw) else {
            if raw.components().all(|c| matches!(c, Component::CurDir)) {
                continue; // the archive's own "./" entry
            }
            return Err(invalid(format!("unsafe path in engine archive: {}", raw.display())));
        };
        let out = dest.join(&rel);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| LlmError::io("unpack the engine", e))?;
        } else if kind.is_file() {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| LlmError::io("unpack the engine", e))?;
            }
            entry.unpack(&out).map_err(|e| LlmError::io("unpack the engine", e))?;
        } else if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|e| invalid(format!("bad link in engine archive: {e}")))?
                .map(|t| t.into_owned());
            match target {
                Some(t) if safe_link_target(&t) => {
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| LlmError::io("unpack the engine", e))?;
                    }
                    entry.unpack(&out).map_err(|e| LlmError::io("unpack the engine", e))?;
                }
                _ => return Err(invalid(format!("unsafe link in engine archive: {}", rel.display()))),
            }
        } else {
            return Err(invalid(format!("unexpected entry in engine archive: {}", rel.display())));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), LlmError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| LlmError::io("mark the engine executable", e))
}
#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), LlmError> {
    Ok(())
}

/// macOS refuses to run arm64 code with a missing or broken signature, and a
/// file we wrote ourselves carries no quarantine flag for Gatekeeper to act on,
/// so check the seal explicitly. The pinned SHA-256 of the archive is what
/// establishes *whose* code this is; this confirms it unpacked intact.
#[cfg(target_os = "macos")]
async fn verify_macos_signature(path: &Path) -> Result<(), LlmError> {
    let out = tokio::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .output()
        .await
        .map_err(|e| LlmError::io("check the engine's code signature", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(LlmError::new(
            ErrorCode::EngineInvalid,
            "The engine's code signature is missing or broken.",
        ))
    }
}

/// Remove everything in the engine folder that is not the pinned build: builds
/// from earlier app versions (hundreds of megabytes each), abandoned staging
/// directories and leftover archives. Only ever called once the pinned build
/// has verified and installed, so nothing removed here can still be needed.
/// Returns how many entries were removed.
pub fn prune_other_builds(base: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(engine_root(base)) else { return 0 };
    let mut removed = 0;
    for entry in entries.filter_map(|e| e.ok()) {
        if entry.file_name() == PINNED_BUILD {
            continue;
        }
        let path = entry.path();
        // `symlink_metadata`: a link is removed as a link, never followed.
        let is_real_dir = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
        let gone = if is_real_dir {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if gone {
            removed += 1;
        }
    }
    removed
}

/// Download (resumably), verify, unpack and publish the pinned engine.
/// Returns the path of `llama-server`.
pub async fn install(
    client: &reqwest::Client,
    base: &Path,
    cancel: &mut watch::Receiver<bool>,
    free_space: Option<u64>,
    on_event: &mut (dyn FnMut(DownloadEvent) + Send),
) -> Result<PathBuf, LlmError> {
    if let Some(bin) = installed_binary(base) {
        on_event(DownloadEvent::Done);
        return Ok(bin);
    }
    let asset = asset_for_this_platform().ok_or_else(|| {
        LlmError::new(
            ErrorCode::UnsupportedPlatform,
            "The built-in engine is not available for this operating system yet.",
        )
    })?;
    let root = engine_root(base);
    let archive = root.join(asset.name);
    let spec = DownloadSpec {
        url: download_url(&asset),
        dest: archive.clone(),
        size_bytes: asset.size_bytes,
        sha256: asset.sha256.to_string(),
    };
    // `Done` is ours to send, once the engine is actually usable.
    let mut relay = |e: DownloadEvent| {
        if e != DownloadEvent::Done {
            on_event(e)
        }
    };
    download_verified(client, &spec, cancel, free_space, &mut relay).await?;

    let staging = root.join(format!("{PINNED_BUILD}.staging"));
    let _ = std::fs::remove_dir_all(&staging);
    let unpack = {
        let (archive, staging) = (archive.clone(), staging.clone());
        tokio::task::spawn_blocking(move || extract_tar_gz(&archive, &staging)).await
    };
    let result = async {
        unpack.map_err(|e| LlmError::new(ErrorCode::Io, format!("unpack task failed: {e}")))??;
        let bin = find_server_binary(&staging).ok_or_else(|| {
            LlmError::new(ErrorCode::EngineInvalid, "The engine archive does not contain llama-server.")
        })?;
        make_executable(&bin)?;
        #[cfg(target_os = "macos")]
        verify_macos_signature(&bin).await?;
        std::fs::write(staging.join(INSTALLED_MARKER), asset.sha256)
            .map_err(|e| LlmError::io("finish installing the engine", e))?;
        let final_dir = install_dir(base);
        let _ = std::fs::remove_dir_all(&final_dir);
        std::fs::rename(&staging, &final_dir).map_err(|e| LlmError::io("finish installing the engine", e))?;
        Ok::<(), LlmError>(())
    }
    .await;

    // The archive is only an intermediate: drop it whether or not we succeeded
    // (on failure the next attempt re-downloads 20 MB rather than trust it).
    remove_all(&archive);
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let bin = installed_binary(base).ok_or_else(|| {
        LlmError::new(ErrorCode::EngineInvalid, "The engine did not install correctly.")
    })?;
    // The new build is verified and in place: earlier builds are dead weight.
    prune_other_builds(base);
    on_event(DownloadEvent::Done);
    Ok(bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGETS: &[(&str, &str)] = &[
        ("macos", "aarch64"),
        ("macos", "x86_64"),
        ("linux", "x86_64"),
        ("linux", "aarch64"),
    ];

    #[test]
    fn every_selectable_archive_is_pinned_by_build_size_and_digest() {
        assert!(PINNED_BUILD.starts_with('b') && PINNED_BUILD[1..].bytes().all(|b| b.is_ascii_digit()));
        for (os, arch) in TARGETS {
            let asset = asset_for(os, arch).unwrap_or_else(|| panic!("{os}/{arch}"));
            assert!(asset.name.contains(PINNED_BUILD), "{}", asset.name);
            assert!(asset.name.ends_with(".tar.gz"), "{}", asset.name);
            assert_eq!(asset.sha256.len(), 64, "{}", asset.name);
            assert!(asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()), "{}", asset.name);
            assert!(asset.size_bytes > 1024 * 1024, "{}", asset.name);
            let url = download_url(&asset);
            assert!(url.starts_with("https://github.com/ggml-org/llama.cpp/releases/download/"), "{url}");
            assert!(url.contains(&format!("/download/{PINNED_BUILD}/")), "{url}");
            assert!(!url.contains("/latest/"), "{url}");
        }
    }

    #[test]
    fn unsupported_platforms_get_no_archive_at_all() {
        // No table entry means no download — never a guess at "close enough".
        for (os, arch) in [("windows", "x86_64"), ("windows", "aarch64"), ("linux", "arm"), ("freebsd", "x86_64"), ("", "")] {
            assert!(asset_for(os, arch).is_none(), "{os}/{arch}");
        }
    }

    #[test]
    fn relative_paths_and_link_targets_are_filtered() {
        assert_eq!(safe_relative(Path::new("llama/llama-server")), Some(PathBuf::from("llama/llama-server")));
        assert_eq!(safe_relative(Path::new("./llama/libllama.dylib")), Some(PathBuf::from("llama/libllama.dylib")));
        assert_eq!(safe_relative(Path::new("../evil")), None);
        assert_eq!(safe_relative(Path::new("a/../../evil")), None);
        assert_eq!(safe_relative(Path::new("/etc/passwd")), None);
        assert_eq!(safe_relative(Path::new("./")), None);

        assert!(safe_link_target(Path::new("libllama.0.dylib")));
        assert!(!safe_link_target(Path::new("../libllama.dylib")));
        assert!(!safe_link_target(Path::new("sub/libllama.dylib")));
        assert!(!safe_link_target(Path::new("/usr/lib/libSystem.dylib")));
        assert!(!safe_link_target(Path::new("")));
    }

    enum Item<'a> {
        File(&'a str, &'a [u8], u32),
        Dir(&'a str),
        Symlink(&'a str, &'a str),
        Hardlink(&'a str, &'a str),
    }

    /// Build a `.tar.gz` with raw header paths (so tests can include paths the
    /// `tar` crate's own builder would refuse to write).
    fn tgz(dir: &Path, items: &[Item]) -> PathBuf {
        let path = dir.join("engine.tar.gz");
        let gz = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(gz);
        let set_path = |header: &mut tar::Header, name: &str| {
            let bytes = name.as_bytes();
            header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
        };
        for item in items {
            let mut header = tar::Header::new_gnu();
            match item {
                Item::File(name, data, mode) => {
                    set_path(&mut header, name);
                    header.set_entry_type(tar::EntryType::Regular);
                    header.set_mode(*mode);
                    header.set_size(data.len() as u64);
                    header.set_cksum();
                    builder.append(&header, *data).unwrap();
                }
                Item::Dir(name) => {
                    set_path(&mut header, name);
                    header.set_entry_type(tar::EntryType::Directory);
                    header.set_mode(0o755);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, std::io::empty()).unwrap();
                }
                Item::Symlink(name, target) | Item::Hardlink(name, target) => {
                    set_path(&mut header, name);
                    header.set_entry_type(if matches!(item, Item::Symlink(..)) {
                        tar::EntryType::Symlink
                    } else {
                        tar::EntryType::Link
                    });
                    let t = target.as_bytes();
                    header.as_old_mut().linkname[..t.len()].copy_from_slice(t);
                    header.set_mode(0o777);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, std::io::empty()).unwrap();
                }
            }
        }
        builder.into_inner().unwrap().finish().unwrap();
        path
    }

    #[test]
    fn a_well_formed_archive_unpacks_and_the_server_is_found() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tgz(
            tmp.path(),
            &[
                Item::Dir("llama-b1/"),
                Item::File("llama-b1/llama-server", b"#!/bin/sh\necho hi\n", 0o755),
                Item::File("llama-b1/libllama.0.dylib", b"lib", 0o644),
                Item::Symlink("llama-b1/libllama.dylib", "libllama.0.dylib"),
                Item::File("./llama-b1/LICENSE", b"MIT", 0o644),
            ],
        );
        let dest = tmp.path().join("out");
        extract_tar_gz(&archive, &dest).unwrap();
        let bin = find_server_binary(&dest).unwrap();
        assert_eq!(bin, dest.join("llama-b1").join(SERVER_NAME));
        assert_eq!(std::fs::read(dest.join("llama-b1/libllama.dylib")).unwrap(), b"lib");
        assert!(dest.join("llama-b1/LICENSE").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(&bin).unwrap().permissions().mode() & 0o100, 0);
        }
    }

    #[test]
    fn archives_that_try_to_leave_the_install_directory_are_refused() {
        let cases: Vec<(&str, Vec<Item>)> = vec![
            ("parent traversal", vec![Item::File("../escape", b"x", 0o644)]),
            ("nested traversal", vec![Item::File("a/../../escape", b"x", 0o644)]),
            ("absolute path", vec![Item::File("/tmp/wired-llm-escape", b"x", 0o644)]),
            ("symlink out", vec![Item::Symlink("link", "../../outside")]),
            ("absolute symlink", vec![Item::Symlink("link", "/etc")]),
            ("symlink into a subdirectory", vec![Item::Symlink("link", "sub/target")]),
            ("hard link", vec![Item::Hardlink("link", "llama-server")]),
        ];
        for (name, items) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let archive = tgz(tmp.path(), &items);
            let dest = tmp.path().join("nested").join("out");
            let err = extract_tar_gz(&archive, &dest).unwrap_err();
            assert_eq!(err.code, ErrorCode::EngineInvalid, "{name}");
            assert!(!tmp.path().join("escape").exists(), "{name}");
            assert!(!tmp.path().join("nested").join("escape").exists(), "{name}");
        }
    }

    #[test]
    fn a_file_written_through_an_earlier_symlink_cannot_escape() {
        // Classic two-step: plant a link, then write "through" it. The link is
        // refused outright, so the second entry never gets the chance.
        let tmp = tempfile::tempdir().unwrap();
        let archive = tgz(
            tmp.path(),
            &[Item::Symlink("d", ".."), Item::File("d/escape", b"x", 0o644)],
        );
        assert!(extract_tar_gz(&archive, &tmp.path().join("out")).is_err());
        assert!(!tmp.path().join("escape").exists());
    }

    #[test]
    fn garbage_is_not_an_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("engine.tar.gz");
        std::fs::write(&path, b"this is not gzip").unwrap();
        assert_eq!(
            extract_tar_gz(&path, &tmp.path().join("out")).unwrap_err().code,
            ErrorCode::EngineInvalid
        );
    }

    #[test]
    fn an_install_counts_only_with_its_marker_for_the_pinned_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = install_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SERVER_NAME), b"bin").unwrap();
        // Unpacked but never marked complete (crash mid-install): not usable.
        assert!(installed_binary(tmp.path()).is_none());
        // Marked for some other archive (older pin): not usable.
        std::fs::write(dir.join(INSTALLED_MARKER), "0".repeat(64)).unwrap();
        assert!(installed_binary(tmp.path()).is_none());
        if let Some(asset) = asset_for_this_platform() {
            std::fs::write(dir.join(INSTALLED_MARKER), asset.sha256).unwrap();
            assert_eq!(installed_binary(tmp.path()), Some(dir.join(SERVER_NAME)));
        }
    }

    #[test]
    fn installing_a_new_build_leaves_only_that_build_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = engine_root(tmp.path());
        let current = install_dir(tmp.path());
        let old_build = root.join("b10001");
        let older_build = root.join("b9000");
        for dir in [&current, &old_build, &older_build] {
            std::fs::create_dir_all(dir.join("llama")).unwrap();
            std::fs::write(dir.join("llama").join(SERVER_NAME), b"bin").unwrap();
            std::fs::write(dir.join(INSTALLED_MARKER), "x").unwrap();
        }
        // Debris from interrupted installs of other versions.
        std::fs::create_dir_all(root.join("b10001.staging/half")).unwrap();
        std::fs::write(root.join("llama-b10001-bin-macos-arm64.tar.gz"), b"old archive").unwrap();
        std::fs::write(root.join("llama-b10001-bin-macos-arm64.tar.gz.part"), b"partial").unwrap();
        // Something outside the engine folder that must never be touched.
        let models = tmp.path().join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("model.gguf"), b"weights").unwrap();
        // A link inside the engine folder pointing out of it: removed as a
        // link, its target left alone.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&models, root.join("b8000")).unwrap();

        let removed = prune_other_builds(tmp.path());
        assert_eq!(removed, if cfg!(unix) { 6 } else { 5 });

        let left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec![PINNED_BUILD.to_string()], "only the pinned build remains");
        assert!(current.join("llama").join(SERVER_NAME).is_file(), "the pinned build is intact");
        assert_eq!(std::fs::read(models.join("model.gguf")).unwrap(), b"weights");

        // Nothing left to prune; a missing engine folder is fine too.
        assert_eq!(prune_other_builds(tmp.path()), 0);
        assert_eq!(prune_other_builds(&tmp.path().join("nowhere")), 0);
    }

    #[test]
    fn the_server_binary_search_ignores_directories_and_is_depth_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        // A DIRECTORY named llama-server is not the binary.
        std::fs::create_dir_all(tmp.path().join(SERVER_NAME)).unwrap();
        assert!(find_server_binary(tmp.path()).is_none());
        let deep = tmp.path().join("a/b/c/d");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join(SERVER_NAME), b"x").unwrap();
        assert!(find_server_binary(tmp.path()).is_none(), "four levels down is out of range");
        let ok = tmp.path().join("build/bin");
        std::fs::create_dir_all(&ok).unwrap();
        std::fs::write(ok.join(SERVER_NAME), b"x").unwrap();
        assert_eq!(find_server_binary(tmp.path()), Some(ok.join(SERVER_NAME)));
    }
}
