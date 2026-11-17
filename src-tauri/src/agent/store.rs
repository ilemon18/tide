//! Chat transcript and open-tab persistence.
//!
//! Transcripts are opaque frontend-owned JSON: the message model can gain fields without a
//! Rust change. Only the id and the size are checked here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::paths;

const MAX_CHAT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentTabRef {
    pub id: String,
    pub root: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentTabs {
    pub tabs: Vec<AgentTabRef>,
    pub active: Option<String>,
}

fn agent_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::p("config.noDir", [("error", e.to_string())]))?;
    let dir = base.join("agent");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Ids become file names: reject anything that could climb out of the chat directory.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn chat_path(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    if !valid_id(id) {
        return Err(AppError::c("agent.invalidId"));
    }
    let dir = agent_dir(app)?.join("chats");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{id}.json")))
}

pub fn save_chat(app: &AppHandle, id: &str, body: &str) -> AppResult<()> {
    if body.len() > MAX_CHAT_BYTES {
        return Err(AppError::c("agent.chatTooLarge"));
    }
    let path = chat_path(app, id)?;
    paths::write_atomic(&path, body.as_bytes())?;
    Ok(())
}

pub fn load_chat(app: &AppHandle, id: &str) -> Option<String> {
    let path = chat_path(app, id).ok()?;
    std::fs::read_to_string(path).ok()
}

pub fn delete_chat(app: &AppHandle, id: &str) -> AppResult<()> {
    let path = chat_path(app, id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn tabs_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(agent_dir(app)?.join("tabs.json"))
}

pub fn save_tabs(app: &AppHandle, tabs: &AgentTabs) -> AppResult<()> {
    let mut trimmed = AgentTabs {
        tabs: tabs.tabs.iter().take(8).cloned().collect(),
        active: tabs.active.clone(),
    };
    if trimmed
        .active
        .as_ref()
        .is_some_and(|active| !trimmed.tabs.iter().any(|tab| &tab.id == active))
    {
        trimmed.active = None;
    }
    let text = serde_json::to_vec_pretty(&trimmed)
        .map_err(|e| AppError::p("config.serializeFailed", [("error", e.to_string())]))?;
    paths::write_atomic(&tabs_path(app)?, &text)?;
    Ok(())
}

pub fn load_tabs(app: &AppHandle) -> AgentTabs {
    let Ok(path) = tabs_path(app) else {
        return AgentTabs::default();
    };
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_the_chat_directory() {
        assert!(valid_id("chat-1750000000-ab12"));
        assert!(valid_id("a"));
        assert!(!valid_id(""));
        assert!(!valid_id("../x"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(".hidden"));
        assert!(!valid_id(&"x".repeat(65)));
    }
}
