//! The vetted model catalogue for the managed engine.
//!
//! Every entry is PINNED: a Hugging Face repository at an exact commit, an
//! exact byte size and an exact SHA-256. The webview only ever names a model
//! by `id`; URLs and digests never cross the IPC boundary, so injected script
//! cannot point the downloader at a file of its choosing.
//!
//! To add or bump a model: take `sha` (the commit) and the file's `size` and
//! `lfs.sha256` from `https://huggingface.co/api/models/<repo>?blobs=true`,
//! then download the file once and confirm `shasum -a 256` matches. Prefer the
//! publisher's own GGUF repository and a permissive licence.

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug)]
pub struct CatalogModel {
    /// Stable id (also the on-disk file stem). `[a-z0-9.-]` only.
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Hugging Face `owner/name`.
    pub repo: &'static str,
    /// Exact commit of `repo` (40 hex). Never a branch name.
    pub revision: &'static str,
    /// File within the repository.
    pub file: &'static str,
    pub size_bytes: u64,
    /// SHA-256 of the file (64 hex, lower-case).
    pub sha256: &'static str,
    /// Below this much system memory the engine refuses to load the model.
    pub min_ram_bytes: u64,
    /// At or above this the model runs comfortably alongside the app.
    pub recommended_ram_bytes: u64,
    /// Context window the engine is started with.
    pub ctx_size: u32,
    pub license: &'static str,
    /// Emits `<think>` reasoning before its answer.
    pub reasoning: bool,
}

/// Ordered smallest first; the UI lists them in this order.
pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen2.5-1.5b-instruct-q4",
        name: "Qwen2.5 1.5B Instruct",
        description: "Small and fast. Good for quick questions and summaries on any recent machine.",
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        revision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        size_bytes: 1_117_320_736,
        sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
        min_ram_bytes: 4 * GIB,
        recommended_ram_bytes: 8 * GIB,
        ctx_size: 8192,
        license: "Apache-2.0",
        reasoning: false,
    },
    CatalogModel {
        id: "qwen3-4b-q4",
        name: "Qwen3 4B",
        description: "Balanced. Reasons before answering and handles tools more reliably.",
        repo: "Qwen/Qwen3-4B-GGUF",
        revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
        file: "Qwen3-4B-Q4_K_M.gguf",
        size_bytes: 2_497_280_256,
        sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        min_ram_bytes: 8 * GIB,
        recommended_ram_bytes: 16 * GIB,
        ctx_size: 8192,
        license: "Apache-2.0",
        reasoning: true,
    },
    CatalogModel {
        id: "qwen3-8b-q4",
        name: "Qwen3 8B",
        description: "Most capable of the three. Needs a machine with plenty of memory.",
        repo: "Qwen/Qwen3-8B-GGUF",
        revision: "7c41481f57cb95916b40956ab2f0b139b296d974",
        file: "Qwen3-8B-Q4_K_M.gguf",
        size_bytes: 5_027_783_488,
        sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        min_ram_bytes: 12 * GIB,
        recommended_ram_bytes: 16 * GIB,
        ctx_size: 8192,
        license: "Apache-2.0",
        reasoning: true,
    },
];

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

impl CatalogModel {
    /// The pinned download URL (`/resolve/<commit>/`, never a moving branch).
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, self.file
        )
    }

    /// File name under the models directory.
    pub fn local_file_name(&self) -> String {
        format!("{}.gguf", self.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn is_hex(s: &str, len: usize) -> bool {
        s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    #[test]
    fn every_model_is_pinned_to_a_commit_size_and_digest() {
        assert!(!CATALOG.is_empty());
        for m in CATALOG {
            assert!(is_hex(m.revision, 40), "{}: revision must be a full commit", m.id);
            assert!(is_hex(m.sha256, 64), "{}: sha256 must be 64 lower-case hex", m.id);
            assert!(m.size_bytes > 100 * 1024 * 1024, "{}: implausible size", m.id);
            let url = m.url();
            assert!(url.starts_with("https://huggingface.co/"), "{url}");
            assert!(url.contains(&format!("/resolve/{}/", m.revision)), "{url}");
            assert!(!url.contains("/resolve/main/"), "{url}");
            assert!(url.ends_with(".gguf"), "{url}");
        }
    }

    #[test]
    fn ids_are_unique_and_safe_as_file_names() {
        let ids: BTreeSet<&str> = CATALOG.iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), CATALOG.len(), "duplicate model id");
        for m in CATALOG {
            assert!(
                m.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'),
                "{}",
                m.id
            );
            assert!(!m.id.starts_with('.') && !m.id.contains(".."), "{}", m.id);
            assert_eq!(m.local_file_name(), format!("{}.gguf", m.id));
        }
    }

    #[test]
    fn memory_guidance_is_coherent_and_the_list_is_smallest_first() {
        for m in CATALOG {
            assert!(m.min_ram_bytes <= m.recommended_ram_bytes, "{}", m.id);
            // A model can never fit in less memory than its own weights.
            assert!(m.min_ram_bytes > m.size_bytes, "{}", m.id);
            assert!(m.ctx_size >= 4096, "{}", m.id);
        }
        for pair in CATALOG.windows(2) {
            assert!(pair[0].size_bytes <= pair[1].size_bytes);
        }
    }

    #[test]
    fn lookup_is_exact() {
        assert!(find(CATALOG[0].id).is_some());
        assert!(find("").is_none());
        assert!(find("../../etc/passwd").is_none());
        assert!(find(&CATALOG[0].id.to_uppercase()).is_none());
    }
}
