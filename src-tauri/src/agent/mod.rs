//! Built-in agent runtimes.
//!
//! Rust owns one bidirectional local CLI process per turn, including native approvals.

pub mod claude;
pub mod transport;
pub mod codex;
pub mod providers;
pub mod question;
pub mod skills;
pub mod store;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionAction {
    #[default]
    New,
    Resume,
    Fork,
}

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPermissionMode {
    ReadOnly,
    #[default]
    WorkspaceWrite,
    FullAccess,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub chat_id: String,
    pub run_id: String,
    /// Workspace root id (canonical absolute path), authorized before spawn
    pub root: String,
    pub provider: String,
    /// Required: callers must explicitly choose native session semantics.
    pub session_action: AgentSessionAction,
    /// CLI session to resume; absent on the first turn
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub mentions: Vec<AgentMention>,
    /// Planning and its question-answer follow-ups must not be able to modify the workspace.
    #[serde(default)]
    pub read_only: bool,
    pub permission_mode: AgentPermissionMode,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    pub chat_id: String,
    pub run_id: String,
    pub sequence: u64,
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
    /// Tokens currently occupying the provider's context window. Missing when the provider does
    /// not report this turn's context pressure; never derived from cumulative session usage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    /// Provider-reported context window for the current model. Missing when the CLI does not
    /// expose one, so the UI never substitutes a fixed context limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
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
    ToolOutputDelta {
        #[serde(rename = "itemId")]
        item_id: String,
        text: String,
    },
    ItemComplete {
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    PermissionRequest {
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        operation: String,
        detail: String,
        reason: String,
    },
    PermissionResolved {
        #[serde(rename = "requestId")]
        request_id: String,
        allowed: bool,
    },
    ToolEnd {
        #[serde(rename = "itemId")]
        item_id: String,
        ok: bool,
        output: Option<String>,
    },
    Question {
        #[serde(rename = "itemId")]
        item_id: String,
        header: String,
        question: String,
        #[serde(rename = "multiSelect")]
        multi_select: bool,
        options: Vec<question::QuestionOption>,
    },
    QuestionInvalid {
        /// Original marker text, also restored separately as ordinary assistant text.
        text: String,
    },
    Failure { error: serde_json::Value },
    Notice {
        text: String,
    },
    Stderr {
        text: String,
    },
    Usage {
        usage: AgentUsage,
        /// Provider-reported cumulative usage for this native session, when available.
        #[serde(rename = "sessionUsage", skip_serializing_if = "Option::is_none")]
        session_usage: Option<AgentUsage>,
    },
    Done {
        ok: bool,
        cancelled: bool,
        /// Process exit code; absent when a signal terminated it
        code: Option<i32>,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        #[serde(rename = "completedAt")]
        completed_at: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_defaults_to_false() {
        let request: AgentTurnRequest = serde_json::from_str(
            r#"{"chatId":"chat-1","runId":"run-1","root":"/tmp","provider":"codex","sessionAction":"new","sessionId":null,"model":null,"effort":null,"prompt":"hi","mentions":[],"permissionMode":"workspace-write"}"#,
        )
        .expect("request should deserialize");
        assert!(!request.read_only);
        assert!(matches!(request.session_action, AgentSessionAction::New));
    }

    #[test]
    fn read_only_deserializes_from_camel_case() {
        let request: AgentTurnRequest = serde_json::from_str(
            r#"{"chatId":"chat-1","runId":"run-1","root":"/tmp","provider":"codex","sessionAction":"new","sessionId":null,"model":null,"effort":null,"prompt":"hi","mentions":[],"readOnly":true,"permissionMode":"full-access"}"#,
        )
        .expect("request should deserialize");
        assert!(request.read_only);
        assert_eq!(request.permission(), AgentPermissionMode::ReadOnly);
    }

    #[test]
    fn session_action_deserializes_from_kebab_case() {
        let request: AgentTurnRequest = serde_json::from_str(
            r#"{"chatId":"chat-1","runId":"run-1","root":"/tmp","provider":"codex","sessionAction":"fork","sessionId":"thread-1","model":null,"effort":null,"prompt":"hi","mentions":[],"permissionMode":"workspace-write"}"#,
        )
        .expect("request should deserialize");
        assert!(matches!(request.session_action, AgentSessionAction::Fork));
    }
    #[test]
    fn missing_session_action_is_rejected_instead_of_resetting_a_session() {
        assert!(serde_json::from_str::<AgentTurnRequest>(
            r#"{"chatId":"chat-1","runId":"run-1","root":"/tmp","provider":"codex","sessionId":"existing","prompt":"hi","permissionMode":"workspace-write"}"#
        ).is_err());
    }

    #[test]
    fn missing_permission_mode_is_rejected() {
        assert!(serde_json::from_str::<AgentTurnRequest>(
            r#"{"chatId":"chat-1","runId":"run-1","root":"/tmp","provider":"codex","sessionAction":"new","prompt":"hi"}"#
        ).is_err());
    }
}

impl AgentTurnRequest {
    pub fn permission(&self) -> AgentPermissionMode {
        if self.read_only { AgentPermissionMode::ReadOnly } else { self.permission_mode }
    }
}
