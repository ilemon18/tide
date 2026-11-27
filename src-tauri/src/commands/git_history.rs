use crate::{
    error::{AppError, AppResult},
    paths,
    state::AppState,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};

// Product limit requested by the developer; this file owns native storage bounds.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageLimits {
    pub recent: usize,
    pub templates: usize,
    pub message_bytes: usize,
    pub scan_commits: usize,
    pub query_bytes: usize,
}
pub(crate) fn limits() -> &'static MessageLimits {
    static LIMITS: std::sync::OnceLock<MessageLimits> = std::sync::OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/lib/commitMessageLimits.json"))
            .expect("checked-in commit message limits")
    })
}
pub(crate) fn normalize_templates(messages: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for message in messages {
        if result.len() >= limits().templates {
            break;
        }
        let message = message.trim();
        if !message.is_empty()
            && message.len() <= limits().message_bytes
            && !result.iter().any(|item| item == message)
        {
            result.push(message.to_owned());
        }
    }
    result
}
static HISTORY_LOCK: Mutex<()> = Mutex::new(());
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct History {
    messages: Vec<String>,
    used_templates: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistory {
    pub messages: Vec<String>,
    pub limit: usize,
    pub used_templates: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub output: String,
    pub history_error: Option<AppError>,
}
fn history_path(app: &AppHandle, root: &Path) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::p("config.noDir", [("error", error.to_string())]))?;
    let key = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    Ok(dir.join("commit-history").join(format!("{key}.json")))
}
fn read(path: &Path) -> AppResult<History> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(History::default()),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take((limits().recent * limits().message_bytes * 6 + 1025) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limits().recent * limits().message_bytes * 6 + 1024 {
        return Ok(History::default());
    }
    let parsed: History = serde_json::from_slice(&bytes).unwrap_or_default();
    let mut messages = Vec::new();
    for message in parsed.messages {
        if messages.len() >= limits().recent {
            break;
        }
        let message = message.trim().to_owned();
        if !message.is_empty()
            && message.len() <= limits().message_bytes
            && !messages.contains(&message)
        {
            messages.push(message);
        }
    }
    let used_templates = parsed
        .used_templates
        .into_iter()
        .filter(|key| key.len() == 8 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .take(limits().templates)
        .collect();
    Ok(History {
        messages,
        used_templates,
    })
}
pub(super) fn message_key(message: &str) -> String {
    let hash = message
        .trim()
        .as_bytes()
        .iter()
        .fold(0x811c9dc5u32, |hash, byte| {
            (hash ^ u32::from(*byte)).wrapping_mul(0x01000193)
        });
    format!("{hash:08x}")
}
fn mark_used(history: &mut History, message: &str) {
    let key = message_key(message);
    history.used_templates.retain(|old| old != &key);
    history.used_templates.insert(0, key);
    history.used_templates.truncate(limits().templates);
}
fn regroup(history: &mut History, templates: &[String]) {
    let recent = std::mem::take(&mut history.messages);
    for message in recent.iter().rev() {
        if templates.contains(message) {
            mark_used(history, message);
        }
    }
    history.messages = recent
        .into_iter()
        .filter(|message| !templates.contains(message))
        .collect();
    history
        .used_templates
        .retain(|key| templates.iter().any(|message| message_key(message) == *key));
}
fn write(path: &Path, history: &History) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(history)
        .map_err(|error| AppError::p("config.serializeFailed", [("error", error.to_string())]))?;
    paths::write_atomic(path, &bytes)?;
    Ok(())
}
#[cfg(test)]
pub(super) fn remember_at(path: &Path, message: &str) -> AppResult<()> {
    remember_with_templates(path, message, &[])
}
fn remember_with_templates(path: &Path, message: &str, templates: &[String]) -> AppResult<()> {
    let message = message.trim();
    if message.is_empty() {
        return Ok(());
    }
    if message.len() > limits().message_bytes {
        return Err(AppError::p(
            "git.historyMessageTooLarge",
            [("limit", (limits().message_bytes / 1024).to_string())],
        ));
    }
    let mut history = read(path)?;
    regroup(&mut history, templates);
    history.messages.retain(|previous| previous != message);
    if templates.iter().any(|template| template == message) {
        mark_used(&mut history, message);
    } else {
        history.messages.insert(0, message.to_owned());
        history.messages.truncate(limits().recent);
    }
    write(path, &history)
}
fn recent_from_git(root: &str, history: &mut History, templates: &[String]) -> AppResult<()> {
    let count = format!("--max-count={}", limits().scan_commits);
    let (ok, output) = super::git::run_text_limited(
        root,
        &["log", &count, "--no-show-signature", "--format=%B%x00"],
        limits().query_bytes,
    )?;
    if !ok {
        return Ok(());
    } // Unborn repositories still support common messages.
    let mut messages = Vec::new();
    let mut used = Vec::new();
    // A byte-limited tail may end mid-message; keep only complete NUL-delimited records.
    for record in output
        .split_terminator('\0')
        .take(output.matches('\0').count())
    {
        let message = record.trim();
        if message.is_empty() || message.len() > limits().message_bytes {
            continue;
        }
        if templates.iter().any(|template| template == message) {
            let key = message_key(message);
            if !used.contains(&key) {
                used.push(key);
            }
        } else if messages.len() < limits().recent && !messages.iter().any(|value| value == message)
        {
            messages.push(message.to_owned());
        }
    }
    regroup(history, templates);
    for key in &history.used_templates {
        if !used.contains(key) {
            used.push(key.clone());
        }
    }
    used.truncate(limits().templates);
    history.used_templates = used;
    for message in &history.messages {
        if messages.len() < limits().recent && !messages.contains(message) {
            messages.push(message.clone());
        }
    }
    history.messages = messages;
    Ok(())
}
pub(super) fn committed(
    app: &AppHandle,
    root: &Path,
    message: &str,
    output: String,
) -> CommitResult {
    // History failures never turn a completed Git commit into an apparent failure/retry.
    let _guard = HISTORY_LOCK.lock();
    let templates = super::theme::read_settings(app).commit_message_templates;
    let history_error = history_path(app, root)
        .and_then(|path| remember_with_templates(&path, message, &templates))
        .err();
    CommitResult {
        output,
        history_error,
    }
}
#[tauri::command(async)]
pub fn git_commit_history(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> AppResult<CommitHistory> {
    let root = state.authorize(&root)?;
    let _guard = HISTORY_LOCK.lock();
    let path = history_path(&app, &root)?;
    let templates = super::theme::read_settings(&app).commit_message_templates;
    let mut history = read(&path)?;
    recent_from_git(&root.to_string_lossy(), &mut history, &templates)?;
    // Compact snapshots replace the previous record, never accumulate in memory.
    write(&path, &history)?;
    Ok(CommitHistory {
        messages: history.messages,
        used_templates: history.used_templates,
        limit: limits().recent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn common_messages_do_not_consume_recent_slots_and_used_markers_stay_bounded() {
        let dir = std::env::temp_dir().join(format!("tide-common-history-{}", std::process::id()));
        let path = dir.join("history.json");
        let _ = std::fs::remove_dir_all(&dir);
        let templates = (0..limits().templates)
            .map(|index| format!("common {index}"))
            .collect::<Vec<_>>();
        remember_with_templates(&path, "recent", &templates).unwrap();
        for message in &templates {
            remember_with_templates(&path, message, &templates).unwrap();
        }
        remember_with_templates(&path, "recent", &templates).unwrap();
        remember_with_templates(&path, &templates[0], &templates).unwrap();
        let history = read(&path).unwrap();
        assert_eq!(history.messages, vec!["recent"]);
        assert_eq!(history.used_templates.len(), limits().templates);
        assert_eq!(history.used_templates[0], message_key(&templates[0]));
        assert_eq!(message_key("common"), "4d5b0474");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn recent_messages_are_persistent_unique_and_bounded() {
        let dir = std::env::temp_dir().join(format!("tide-commit-history-{}", std::process::id()));
        let path = dir.join("history.json");
        let _ = std::fs::remove_dir_all(&dir);
        for index in 0..limits().recent + 3 {
            remember_at(&path, &format!("message {index}\n\nbody")).unwrap();
        }
        let history = read(&path).unwrap();
        assert_eq!(history.messages.len(), limits().recent);
        assert!(history.messages[0].starts_with(&format!("message {}", limits().recent + 2)));
        assert!(history.messages[limits().recent - 1].starts_with("message 3"));
        remember_at(&path, "message 5\n\nbody").unwrap();
        let history = read(&path).unwrap();
        assert_eq!(history.messages[0], "message 5\n\nbody");
        assert_eq!(history.messages.len(), limits().recent);
        let before = std::fs::read(&path).unwrap();
        assert!(remember_at(&path, &"x".repeat(limits().message_bytes + 1)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, "broken").unwrap();
        assert!(read(&path).unwrap().messages.is_empty());
        remember_at(&path, "recovered").unwrap();
        assert_eq!(read(&path).unwrap().messages, vec!["recovered"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
