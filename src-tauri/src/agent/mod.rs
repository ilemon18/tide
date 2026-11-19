//! Built-in agent runtimes.
//!
//! Tide does not speak the agents' protocols itself: each turn is a short-lived headless
//! invocation of a local CLI (`claude -p` / `codex exec`), with a resume id for follow-ups.
//! That keeps the backend small, survives restarts, and lets the CLIs own auth, models and
//! their tool loops. The modules here only build arguments, translate their JSONL into one
//! provider-neutral event stream, and store transcripts.

pub mod claude;
pub mod codex;
pub mod providers;
pub mod skills;
pub mod store;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A CLI invocation built from one provider's flags. The two providers return the same shape so
/// the command layer can spawn either without branching on the concrete module type.
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMention {
    /// Workspace-relative path; a directory carries no trailing slash
    pub rel: String,
    pub is_dir: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub chat_id: String,
    /// Workspace root id (canonical absolute path), authorized before spawn
    pub root: String,
    pub provider: String,
    /// CLI session to resume; absent on the first turn
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub mentions: Vec<AgentMention>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    pub chat_id: String,
    pub event: AgentEvent,
}

/// Provider-reported usage for one assistant turn. `cost_usd` stays optional because some CLIs
/// do not return a price at all; an explicit provider zero is `Some(0.0)` and must stay distinct.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: Option<f64>,
}

/// One provider-neutral stream event. The frontend reducer appends text to an item id,
/// upserts tool cards by id, and closes the turn on `done`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    TextDelta {
        #[serde(rename = "itemId")]
        item_id: String,
        text: String,
    },
    Thinking {
        #[serde(rename = "itemId")]
        item_id: String,
        text: String,
    },
    ToolStart {
        #[serde(rename = "itemId")]
        item_id: String,
        title: String,
    },
    ToolDetail {
        #[serde(rename = "itemId")]
        item_id: String,
        detail: String,
    },
    ToolEnd {
        #[serde(rename = "itemId")]
        item_id: String,
        ok: bool,
        output: Option<String>,
    },
    Notice {
        text: String,
    },
    Stderr {
        text: String,
    },
    Usage {
        usage: AgentUsage,
    },
    Done {
        ok: bool,
        cancelled: bool,
        /// Process exit code; absent when a signal terminated it
        code: Option<i32>,
    },
}

pub fn workspace_note(root: &Path) -> String {
    format!(
        "You are running inside the Tide editor. The workspace root is {}. Keep file changes \
         inside that directory unless the user explicitly asks otherwise. Prefer reading files \
         from the workspace instead of guessing.",
        root.display()
    )
}

/// The user text plus an explicit list of the mentions. Relative paths are resolved by the
/// agent against its cwd (the workspace root), so a chip survives edits and renames.
pub fn build_prompt(prompt: &str, mentions: &[AgentMention]) -> String {
    if mentions.is_empty() {
        return prompt.to_string();
    }
    let mut out = String::from("Referenced paths (relative to the workspace root):\n");
    for mention in mentions {
        if mention.is_dir {
            out.push_str("- ");
            out.push_str(&mention.rel);
            out.push_str("/ (directory)\n");
        } else {
            out.push_str("- ");
            out.push_str(&mention.rel);
            out.push('\n');
        }
    }
    out.push('\n');
    out.push_str(prompt);
    out
}

/// Claude's `--session-id` needs a UUID. `std` has no RNG, and pulling a crate just for this
/// is not worth it: urandom on Unix, a time/pid/counter mix elsewhere.
pub fn uuid_v4() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);

    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
            if file.read_exact(&mut bytes).is_ok() {
                return format_uuid(bytes);
            }
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut seed = nanos
        ^ (std::process::id() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ SEQ.fetch_add(1, Ordering::Relaxed);
    for slot in bytes.iter_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *slot = seed as u8;
    }
    format_uuid(bytes)
}

fn format_uuid(mut bytes: [u8; 16]) -> String {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
