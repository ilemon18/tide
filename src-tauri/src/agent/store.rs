//! Chat transcript and open-tab persistence.
//!
//! The on-disk `v:1` record remains frontend-owned, but Rust owns its top-level shape so a page
//! can be read or patched without dropping messages that are outside the webview's working set.
//! Unknown header and message fields survive every read/write round trip.

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::paths;

const MAX_CHAT_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT: usize = 80;
const MAX_PAGE_LIMIT: usize = 500;
const RECENT_TEXT_BUDGET: usize = 512 * 1024;

// Shared by all windows; weak entries do not retain deleted chats forever.
fn document_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Mutex::default).lock();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}

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

pub type AgentChatRecord = Map<String, Value>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatPage {
    pub header: AgentChatRecord,
    pub messages: Vec<Value>,
    pub has_earlier: bool,
    pub has_later: bool,
    pub total: usize,
    pub has_pending_question: bool,
    pub pending_message_id: Option<String>,
    pub has_unhandled_plan_action: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatPatch {
    #[serde(default)]
    pub header: AgentChatRecord,
    #[serde(default)]
    pub upserts: Vec<Value>,
    #[serde(default)]
    pub remove_message_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatSummary {
    pub id: String,
    pub root: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub updated_at: f64,
    pub message_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatListPage {
    pub chats: Vec<AgentChatSummary>,
    pub next_offset: Option<usize>,
    pub total: usize,
}

fn chat_list_page(chats: Vec<AgentChatSummary>, offset: usize, limit: usize) -> AgentChatListPage {
    let limit = limit.clamp(1, 50);
    let total = chats.len();
    let next_offset = (offset.saturating_add(limit) < total).then_some(offset.saturating_add(limit));
    let chats = chats.into_iter().skip(offset).take(limit).collect();
    AgentChatListPage { chats, next_offset, total }
}

// List only metadata: skip message values without allocating transcripts for any project.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatListRecord {
    root: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    updated_at: f64,
    #[serde(deserialize_with = "count_messages")]
    messages: usize,
}

fn count_messages<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    struct Counter;
    impl<'de> serde::de::Visitor<'de> for Counter {
        type Value = usize;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an array of chat messages")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<usize, A::Error> {
            let mut count = 0;
            while seq.next_element::<serde::de::IgnoredAny>()?.is_some() { count += 1; }
            Ok(count)
        }
    }
    deserializer.deserialize_seq(Counter)
}

fn read_summary(path: &Path) -> AppResult<Option<AgentChatSummary>> {
    let lock = document_lock(path);
    let _guard = lock.lock();
    read_summary_unlocked(path)
}

fn read_summary_unlocked(path: &Path) -> AppResult<Option<AgentChatSummary>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > MAX_CHAT_BYTES as u64 { return Ok(None); }
    let record: ChatListRecord = match serde_json::from_reader(std::io::BufReader::new(file)) {
        Ok(record) => record,
        Err(_) => return Ok(None), // Preserve corrupt files; one bad record must not hide the rest.
    };
    let Some(id) = path.file_stem().and_then(|id| id.to_str()).filter(|id| valid_id(id)) else { return Ok(None); };
    Ok(Some(AgentChatSummary { id: id.into(), root: record.root, title: record.title,
        provider: record.provider, model: record.model, updated_at: record.updated_at, message_count: record.messages }))
}

#[derive(Clone, Debug, Default)]
struct ChatDocument {
    header: AgentChatRecord,
    messages: Vec<Value>,
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
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
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

fn message_id(message: &Value) -> Option<&str> {
    message.get("id").and_then(Value::as_str)
}

fn parse_document(bytes: &[u8]) -> Option<ChatDocument> {
    let mut root: AgentChatRecord = serde_json::from_slice(bytes).ok()?;
    let messages = root
        .remove("messages")
        .and_then(|value| value.as_array().cloned())?;
    Some(ChatDocument {
        header: root,
        messages,
    })
}

fn serialize_document(document: &ChatDocument) -> AppResult<Vec<u8>> {
    let mut root = document.header.clone();
    root.insert(
        "messages".to_string(),
        Value::Array(document.messages.clone()),
    );
    serde_json::to_vec_pretty(&root)
        .map_err(|e| AppError::p("config.serializeFailed", [("error", e.to_string())]))
}

fn page_document(document: &ChatDocument, start: usize, limit: usize) -> AgentChatPage {
    page_range(
        document,
        start,
        start.saturating_add(limit.clamp(1, MAX_PAGE_LIMIT)),
        false,
    )
}

/// Bound count and serialized bytes. A single oversized record stands alone.
fn page_range(document: &ChatDocument, start: usize, end: usize, backwards: bool) -> AgentChatPage {
    let total = document.messages.len();
    let mut start = start.min(total);
    let mut end = end.min(total).max(start);
    let mut bytes = 2usize;
    let mut accepted = 0usize;
    let indices: Box<dyn Iterator<Item = usize>> = if backwards {
        Box::new((start..end).rev())
    } else {
        Box::new(start..end)
    };
    for index in indices {
        let size = serde_json::to_vec(&document.messages[index]).map_or(0, |v| v.len());
        let next = bytes
            .saturating_add(size)
            .saturating_add(usize::from(accepted > 0));
        if accepted > 0 && next > RECENT_TEXT_BUDGET {
            break;
        }
        bytes = next;
        accepted += 1;
    }
    if backwards {
        start = end - accepted;
    } else {
        end = start + accepted;
    }
    let pending_message_id = document
        .messages
        .iter()
        .find(|message| {
            find_pending_question(std::slice::from_ref(*message))
        })
        .or_else(|| document.messages.iter().find(|message| find_unhandled_plan_action(std::slice::from_ref(*message))))
        .and_then(message_id)
        .map(str::to_string);
    AgentChatPage {
        header: document.header.clone(),
        messages: document.messages[start..end].to_vec(),
        has_earlier: start > 0,
        has_later: end < total,
        total,
        has_pending_question: find_pending_question(&document.messages),
        pending_message_id,
        has_unhandled_plan_action: find_unhandled_plan_action(&document.messages),
    }
}

fn recent_page(document: &ChatDocument, requested: usize) -> AgentChatPage {
    let limit = if requested == 0 {
        DEFAULT_PAGE_LIMIT
    } else {
        requested.clamp(1, MAX_PAGE_LIMIT)
    };
    page_range(
        document,
        document.messages.len().saturating_sub(limit),
        document.messages.len(),
        true,
    )
}

fn cursor_page(
    document: &ChatDocument,
    before: Option<&str>,
    after: Option<&str>,
    limit: usize,
) -> AppResult<AgentChatPage> {
    if before.is_some() && after.is_some() {
        return Err(AppError::c("agent.invalidId"));
    }
    let limit = if limit == 0 {
        DEFAULT_PAGE_LIMIT
    } else {
        limit.clamp(1, MAX_PAGE_LIMIT)
    };
    if let Some(cursor) = before.or(after) {
        let index = document
            .messages
            .iter()
            .position(|m| message_id(m) == Some(cursor))
            .ok_or_else(|| AppError::c("agent.invalidId"))?;
        return Ok(if before.is_some() {
            page_range(document, index.saturating_sub(limit), index, true)
        } else {
            page_document(document, index + 1, limit)
        });
    }
    Ok(recent_page(document, limit))
}

fn read_document(path: &Path) -> AppResult<Option<ChatDocument>> {
    match std::fs::read(path) {
        Ok(bytes) => parse_document(&bytes)
            .map(Some)
            .ok_or_else(|| AppError::c("agent.invalidChat")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_document(path: &Path, document: &ChatDocument) -> AppResult<()> {
    let bytes = serialize_document(document)?;
    if bytes.len() > MAX_CHAT_BYTES {
        return Err(AppError::c("agent.chatTooLarge"));
    }
    paths::write_atomic(path, &bytes)?;
    Ok(())
}

fn find_pending_question(messages: &[Value]) -> bool {
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(items) = message.get("items").and_then(Value::as_array) else {
            continue;
        };
        for item in items.iter().rev() {
            if item.get("type").and_then(Value::as_str) != Some("question") {
                continue;
            }
            // New streamed questions are persisted before the turn's final event. They become
            // actionable only after the frontend marks them complete; missing metadata is kept
            // compatible with older transcripts.
            if item.get("complete").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let answer = item
                .get("answer")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if answer.is_empty() {
                return true;
            }
        }
    }
    false
}

fn find_unhandled_plan_action(messages: &[Value]) -> bool {
    messages.iter().rev().any(|message| {
        message
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("plan")
                        && (item.get("resolved").and_then(Value::as_bool) != Some(true)
                            || item.get("actionState").and_then(Value::as_str) == Some("launching"))
                })
            })
    })
}

fn apply_document(mut document: ChatDocument, patch: AgentChatPatch) -> AppResult<ChatDocument> {
    document.header.extend(
        patch
            .header
            .into_iter()
            .filter(|(key, _)| key != "messages"),
    );
    let removed: HashSet<&str> = patch
        .remove_message_ids
        .iter()
        .map(String::as_str)
        .collect();
    if !removed.is_empty() {
        document
            .messages
            .retain(|message| message_id(message).is_none_or(|id| !removed.contains(id)));
    }
    let mut positions: HashMap<String, usize> = document
        .messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| message_id(message).map(|id| (id.to_string(), index)))
        .collect();
    for message in patch.upserts {
        let Some(id) = message_id(&message).map(str::to_string) else {
            continue;
        };
        if let Some(index) = positions.get(&id).copied() {
            if let (Some(existing), Some(update)) = (
                document.messages[index].as_object_mut(),
                message.as_object(),
            ) {
                existing.extend(update.clone());
            }
        } else {
            positions.insert(id, document.messages.len());
            document.messages.push(message);
        }
    }
    Ok(document)
}

pub fn open_chat(
    app: &AppHandle,
    id: &str,
    recent_limit: usize,
) -> AppResult<Option<AgentChatPage>> {
    let path = chat_path(app, id)?;
    let Some(document) = read_document(&path)? else {
        return Ok(None);
    };
    let requested = if recent_limit == 0 {
        DEFAULT_PAGE_LIMIT
    } else {
        recent_limit
    };
    Ok(Some(recent_page(&document, requested)))
}

pub fn open_project_chat(app: &AppHandle, id: &str, limit: usize, root: &str) -> AppResult<Option<AgentChatPage>> {
    let path = chat_path(app, id)?;
    let Some(summary) = read_summary(&path)? else { return Ok(None); };
    if summary.root != root { return Err(AppError::c("agent.invalidId")); }
    let Some(document) = read_document(&path)? else { return Ok(None); };
    if document.header.get("root").and_then(Value::as_str) != Some(root) {
        return Err(AppError::c("agent.invalidId"));
    }
    Ok(Some(recent_page(&document, limit)))
}

pub fn page_chat(
    app: &AppHandle,
    id: &str,
    before_id: Option<&str>,
    after_id: Option<&str>,
    limit: usize,
) -> AppResult<Option<AgentChatPage>> {
    let path = chat_path(app, id)?;
    let Some(document) = read_document(&path)? else {
        return Ok(None);
    };
    cursor_page(&document, before_id, after_id, limit).map(Some)
}

fn apply_path(path: &Path, patch: AgentChatPatch) -> AppResult<ChatDocument> {
    let lock = document_lock(path);
    let _guard = lock.lock();
    let existing = read_document(path)?.unwrap_or_default();
    let document = apply_document(existing, patch)?;
    write_document(path, &document)?;
    Ok(document)
}

pub fn apply_chat(app: &AppHandle, id: &str, patch: AgentChatPatch) -> AppResult<AgentChatPage> {
    let path = chat_path(app, id)?;
    let document = apply_path(&path, patch)?;
    Ok(recent_page(&document, DEFAULT_PAGE_LIMIT))
}

/// Reset a chat in place while retaining its id, root, provider and unknown header fields.
///
/// This is intentionally separate from a partial message patch: a loaded page may not contain
/// the complete transcript, so removing only the visible message ids could resurrect older
/// history when the chat is reopened.
pub fn reset_chat(
    app: &AppHandle,
    id: &str,
    header: AgentChatRecord,
) -> AppResult<AgentChatPage> {
    let path = chat_path(app, id)?;
    let lock = document_lock(&path);
    let _guard = lock.lock();
    let mut document = read_document(&path)?.unwrap_or_default();
    document.header.extend(header.into_iter().filter(|(key, _)| key != "messages"));
    document.messages.clear();
    write_document(&path, &document)?;
    Ok(recent_page(&document, DEFAULT_PAGE_LIMIT))
}

pub fn clone_chat(
    app: &AppHandle,
    from_id: &str,
    header: AgentChatRecord,
) -> AppResult<AgentChatPage> {
    let source_path = chat_path(app, from_id)?;
    let source = read_document(&source_path)?.ok_or_else(|| AppError::c("agent.invalidId"))?;
    let target_id = header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::c("agent.invalidId"))?;
    let target_path = chat_path(app, target_id)?;
    if target_path == source_path {
        return Err(AppError::c("agent.invalidId"));
    }
    let lock = document_lock(&target_path);
    let _guard = lock.lock();
    if target_path.exists() {
        return Err(AppError::c("agent.invalidId"));
    }
    let mut cloned_header = source.header;
    for (key, value) in header {
        cloned_header.insert(key, value);
    }
    let document = ChatDocument {
        header: cloned_header,
        messages: source.messages,
    };
    write_document(&target_path, &document)?;
    Ok(recent_page(&document, DEFAULT_PAGE_LIMIT))
}

pub fn list_chats(app: &AppHandle, root: &str, offset: usize, limit: usize, query: &str) -> AppResult<AgentChatListPage> {
    let dir = agent_dir(app)?.join("chats");
    std::fs::create_dir_all(&dir)?;
    list_chats_in_dir(&dir, root, offset, limit, query)
}

fn list_chats_in_dir(dir: &Path, root: &str, offset: usize, limit: usize, query: &str) -> AppResult<AgentChatListPage> {
    let query = query.trim().to_lowercase();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(summary) = read_summary(&path)? else {
            continue;
        };
        if summary.root != root {
            continue;
        }
        if !query.is_empty() && !summary.title.to_lowercase().contains(&query) {
            continue;
        }
        out.push(summary);
    }
    out.sort_by(|a, b| {
        b.updated_at
            .total_cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(chat_list_page(out, offset, limit))
}

pub fn delete_chat(app: &AppHandle, id: &str, root: &str) -> AppResult<()> {
    let path = chat_path(app, id)?;
    delete_project_chat(&path, root)
}

fn delete_project_chat(path: &Path, root: &str) -> AppResult<()> {
    let lock = document_lock(path);
    let _guard = lock.lock();
    // Validate and remove under the same document lock. Preserve corrupt/unverifiable records.
    match read_summary_unlocked(path)? {
        Some(summary) if summary.root == root => {},
        None if !path.exists() => return Ok(()),
        _ => return Err(AppError::c("agent.invalidId")),
    }
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
    use serde_json::json;

    fn message(id: &str, role: &str, text: &str) -> Value {
        json!({ "id": id, "role": role, "at": 1, "text": text })
    }

    #[test]
    fn history_list_pages_fifteen_summaries_and_reports_filtered_total() {
        for total in [0, 15, 16, 30, 31] {
            let summaries: Vec<AgentChatSummary> = (0..total).map(|index| AgentChatSummary {
                id: format!("chat-{index}"), root: "/tmp/project".into(), title: String::new(),
                provider: "codex".into(), model: String::new(), updated_at: index as f64,
                message_count: 0,
            }).collect();
            for offset in [0, 15, 30] {
                let page = chat_list_page(summaries.clone(), offset, 15);
                assert_eq!(page.total, total);
                assert_eq!(page.chats.len(), total.saturating_sub(offset).min(15));
                assert_eq!(page.next_offset, (offset + 15 < total).then_some(offset + 15));
            }
        }
    }

    #[test]
    fn history_search_filters_all_project_summaries_before_sorting_and_paging() {
        let dir = std::env::temp_dir().join(format!(
            "tide-chat-history-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for index in 0..31 {
            let mut doc = document();
            doc.header.insert("root".into(), json!("/tmp/project"));
            doc.header.insert("title".into(), json!(format!("NeEdLe {index}")));
            doc.header.insert("updatedAt".into(), json!(index));
            doc.messages = vec![message("m1", "user", "body-only keyword")];
            write_document(&dir.join(format!("chat-{index}.json")), &doc).expect("seed");
        }
        let mut other = document();
        other.header.insert("root".into(), json!("/other/project"));
        other.header.insert("title".into(), json!("Needle"));
        write_document(&dir.join("other.json"), &other).expect("other project");
        std::fs::write(dir.join("corrupt.json"), b"invalid json").expect("corrupt seed");

        let first = list_chats_in_dir(&dir, "/tmp/project", 0, 15, "  NEEDLE  ").expect("search first");
        assert_eq!(first.total, 31);
        assert_eq!(first.chats.len(), 15);
        assert_eq!(first.chats[0].id, "chat-30");
        let second = list_chats_in_dir(&dir, "/tmp/project", 15, 15, "needle").expect("search second");
        assert_eq!(second.chats.len(), 15);
        assert_eq!(second.chats[0].id, "chat-15");
        assert_eq!(second.next_offset, Some(30));
        let last = list_chats_in_dir(&dir, "/tmp/project", 30, 15, "needle").expect("search last");
        assert_eq!(last.chats.len(), 1);
        assert_eq!(last.next_offset, None);

        let id = list_chats_in_dir(&dir, "/tmp/project", 0, 15, "CHAT-30").expect("id excluded");
        assert_eq!(id.total, 0);
        assert!(id.chats.is_empty());
        assert_eq!(list_chats_in_dir(&dir, "/tmp/project", 0, 15, "body-only").expect("body excluded").total, 0);
        assert_eq!(list_chats_in_dir(&dir, "/tmp/project", 0, 15, "codex").expect("provider excluded").total, 0);
        assert_eq!(list_chats_in_dir(&dir, "/tmp/project", 0, 15, "   ").expect("empty search").total, 31);

        let mut unicode = document();
        unicode.header.insert("root".into(), json!("/tmp/project"));
        unicode.header.insert("title".into(), json!("修复登录 [literal].*"));
        write_document(&dir.join("unicode.json"), &unicode).expect("unicode seed");
        assert_eq!(list_chats_in_dir(&dir, "/tmp/project", 0, 15, "登录").expect("unicode search").total, 1);
        assert_eq!(list_chats_in_dir(&dir, "/tmp/project", 0, 15, "[literal].*").expect("literal search").total, 1);
        assert_eq!(list_chats_in_dir(&dir, "/tmp/project", 0, 15, "unmatched").expect("empty result").total, 0);
        assert!(dir.join("corrupt.json").exists());
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    fn document() -> ChatDocument {
        ChatDocument {
            header: serde_json::from_value(json!({
                "v": 1,
                "id": "chat-1",
                "root": "/tmp/project",
                "title": "Test",
                "provider": "codex",
                "model": "gpt",
                "unknownHeader": true
            }))
            .expect("header"),
            messages: vec![
                message("m1", "user", "one"),
                message("m2", "assistant", "two"),
                message("m3", "user", "three"),
            ],
        }
    }

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

    #[test]
    fn deletion_checks_the_project_and_preserves_unverifiable_files() {
        let dir = std::env::temp_dir().join(format!(
            "tide-chat-delete-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("chat-1.json");
        write_document(&path, &document()).expect("seed");
        let original = std::fs::read(&path).expect("original");
        assert!(delete_project_chat(&path, "/other/project").is_err());
        assert_eq!(std::fs::read(&path).expect("preserved"), original);
        delete_project_chat(&path, "/tmp/project").expect("delete owned chat");
        assert!(!path.exists());
        delete_project_chat(&path, "/tmp/project").expect("already deleted");

        std::fs::write(&path, b"invalid json").expect("corrupt record");
        assert!(delete_project_chat(&path, "/tmp/project").is_err());
        assert_eq!(std::fs::read(&path).expect("preserved corrupt record"), b"invalid json");
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn parses_legacy_whole_file_chat() {
        let bytes = serde_json::to_vec(&json!({
            "v": 1,
            "id": "chat-1",
            "root": "/tmp/project",
            "messages": [message("m1", "user", "one")],
            "futureField": { "kept": true }
        }))
        .expect("json");
        let parsed = parse_document(&bytes).expect("legacy chat");
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(parsed.header["futureField"]["kept"], true);
        assert!(!parsed.header.contains_key("messages"));
    }

    #[test]
    fn page_keeps_order_and_reports_both_directions() {
        let page = page_document(&document(), 1, 1);
        assert_eq!(message_id(&page.messages[0]), Some("m2"));
        assert!(page.has_earlier);
        assert!(page.has_later);
        assert_eq!(page.total, 3);
    }

    #[test]
    fn before_and_after_pages_are_exclusive() {
        let doc = document();
        for limit in [1, 80, 500] {
            let before = cursor_page(&doc, Some("m2"), None, limit).expect("before");
            assert_eq!(before.messages.len(), 1);
            assert_eq!(message_id(&before.messages[0]), Some("m1"));
            let after = cursor_page(&doc, None, Some("m2"), limit).expect("after");
            assert_eq!(after.messages.len(), 1);
            assert_eq!(message_id(&after.messages[0]), Some("m3"));
        }
        assert!(cursor_page(&doc, Some("m1"), None, 80)
            .expect("first")
            .messages
            .is_empty());
        assert!(cursor_page(&doc, None, Some("m3"), 80)
            .expect("last")
            .messages
            .is_empty());
        assert!(cursor_page(&doc, Some("missing"), None, 80).is_err());
        assert!(cursor_page(&doc, Some("m2"), Some("m1"), 80).is_err());
    }

    #[test]
    fn pages_obey_byte_budget_in_both_directions_and_allow_one_large_record() {
        let mut doc = document();
        doc.messages = (0..90)
            .map(|i| message(&format!("m{i}"), "user", &"x".repeat(100_000)))
            .collect();
        for page in [
            recent_page(&doc, 80),
            cursor_page(&doc, Some("m80"), None, 80).expect("before"),
            cursor_page(&doc, None, Some("m0"), 80).expect("after"),
        ] {
            assert_eq!(page.messages.len(), 5);
            assert!(serde_json::to_vec(&page.messages).expect("bytes").len() <= RECENT_TEXT_BUDGET);
        }
        doc.messages.push(message(
            "large",
            "assistant",
            &"x".repeat(RECENT_TEXT_BUDGET + 1),
        ));
        let page = recent_page(&doc, 80);
        assert_eq!(page.messages.len(), 1);
        assert_eq!(message_id(&page.messages[0]), Some("large"));
        doc.messages = (0..100)
            .map(|i| message(&format!("m{i}"), "user", "small"))
            .collect();
        assert_eq!(recent_page(&doc, 0).messages.len(), 80);
    }

    #[test]
    fn partial_header_and_message_updates_preserve_unknown_fields() {
        let mut doc = document();
        doc.messages[0]["futureMessage"] = json!({"keep": true});
        let patch = serde_json::from_value(json!({"header": {"title": "changed"},
            "upserts": [{"id": "m1", "text": "new"}]}))
        .expect("patch");
        let result = apply_document(doc, patch).expect("apply");
        assert_eq!(result.header["unknownHeader"], true);
        assert_eq!(result.header["title"], "changed");
        assert_eq!(result.messages[0]["futureMessage"]["keep"], true);
        assert_eq!(result.messages[0]["role"], "user");
    }

    #[test]
    fn apply_upserts_by_id_without_reordering() {
        let patch: AgentChatPatch = serde_json::from_value(json!({
            "header": document().header,
            "upserts": [
                { "id": "m2", "role": "assistant", "at": 1, "text": "updated", "new": true },
                { "id": "m4", "role": "user", "at": 2, "text": "four" }
            ],
            "removeMessageIds": []
        }))
        .expect("patch");
        let updated = apply_document(document(), patch).expect("apply");
        assert_eq!(updated.messages.len(), 4);
        assert_eq!(message_id(&updated.messages[1]), Some("m2"));
        assert_eq!(updated.messages[1]["text"], "updated");
        assert_eq!(updated.messages[1]["new"], true);
        assert_eq!(message_id(&updated.messages[3]), Some("m4"));
    }

    #[test]
    fn apply_removes_only_requested_messages_and_keeps_unloaded_history() {
        let patch: AgentChatPatch = serde_json::from_value(json!({
            "header": {},
            "upserts": [{ "id": "m1", "role": "user", "at": 1, "text": "edited" }],
            "removeMessageIds": ["m2"]
        }))
        .expect("patch");
        let updated = apply_document(document(), patch).expect("apply");
        assert_eq!(updated.messages.len(), 2);
        assert_eq!(message_id(&updated.messages[0]), Some("m1"));
        assert_eq!(updated.messages[0]["text"], "edited");
        assert_eq!(message_id(&updated.messages[1]), Some("m3"));
    }

    #[test]
    fn serializing_round_trips_unknown_fields() {
        let bytes = serialize_document(&document()).expect("serialize");
        let parsed = parse_document(&bytes).expect("parse");
        assert_eq!(parsed.header["unknownHeader"], true);
        assert_eq!(parsed.messages[1]["text"], "two");
    }

    #[test]
    fn context_snapshots_survive_partial_patches_serialization_and_paging() {
        let mut doc = document();
        let attachments = json!([{
            "id": "context-1", "kind": "terminal-selection", "sourceRoot": "/tmp/project",
            "capturedAt": 1, "label": "Terminal", "startupRel": "src", "text": "captured\nerror"
        }]);
        doc.messages[0]["attachments"] = attachments.clone();
        let patch: AgentChatPatch = serde_json::from_value(json!({
            "header": {}, "upserts": [{ "id": "m2", "role": "assistant", "at": 1, "text": "updated" }]
        })).expect("patch");
        let updated = apply_document(doc, patch).expect("partial patch");
        let parsed = parse_document(&serialize_document(&updated).expect("serialize")).expect("parse");
        let page = page_document(&parsed, 0, 1);
        assert_eq!(page.messages[0]["attachments"], attachments);
        assert_eq!(page.messages.len(), 1);
    }

    #[test]
    fn detects_pending_questions_across_full_history() {
        let mut doc = document();
        doc.messages.push(json!({
            "id": "m4",
            "role": "assistant",
            "at": 2,
            "items": [{ "id": "q1", "type": "question", "question": "Choose" }]
        }));
        assert!(find_pending_question(&doc.messages));
        doc.messages[3]["items"][0]["answer"] = json!("A");
        assert!(!find_pending_question(&doc.messages));
    }

    #[test]
    fn ignores_questions_until_the_streamed_turn_completes() {
        let mut doc = document();
        doc.messages.push(json!({
            "id": "partial",
            "role": "assistant",
            "at": 2,
            "items": [{ "id": "q1", "type": "question", "complete": false, "question": "Choose" }]
        }));
        assert!(!find_pending_question(&doc.messages));
        doc.messages[3]["items"][0]["complete"] = json!(true);
        assert!(find_pending_question(&doc.messages));
    }

    #[test]
    fn detects_unhandled_plan_cards() {
        let mut doc = document();
        doc.messages.push(json!({
            "id": "m4",
            "role": "assistant",
            "at": 2,
            "items": [{ "id": "plan-action:m4", "type": "plan", "text": "" }]
        }));
        assert!(find_unhandled_plan_action(&doc.messages));
        doc.messages[3]["items"][0]["resolved"] = json!(true);
        assert!(!find_unhandled_plan_action(&doc.messages));
    }

    #[test]
    fn questions_take_priority_and_interrupted_plan_actions_still_block() {
        let mut doc = document();
        doc.messages.push(json!({ "id": "plan", "role": "assistant", "items": [
            { "id": "choice", "type": "plan", "resolved": true, "actionState": "launching" }
        ] }));
        doc.messages.push(json!({ "id": "question", "role": "assistant", "items": [
            { "id": "q", "type": "question", "question": "Which?" }
        ] }));
        let page = recent_page(&doc, 1);
        assert!(page.has_unhandled_plan_action && page.has_pending_question);
        assert_eq!(page.pending_message_id.as_deref(), Some("question"));
    }

    #[test]
    fn atomic_write_replaces_complete_document() {
        let dir = std::env::temp_dir().join(format!(
            "tide-agent-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("chat.json");
        write_document(&path, &document()).expect("first write");
        let mut next = document();
        next.messages.push(message("m4", "user", "four"));
        write_document(&path, &next).expect("second write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(parse_document(&bytes).expect("parse").messages.len(), 4);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
    #[test]
    fn concurrent_patches_keep_every_message_and_failed_writes_keep_original() {
        let dir = std::env::temp_dir().join(format!(
            "tide-chat-concurrent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp");
        let path = dir.join("chat.json");
        write_document(&path, &document()).expect("seed");
        std::thread::scope(|scope| {
            for i in 0..16 {
                let path = &path;
                scope.spawn(move || {
                    let patch = serde_json::from_value(
                        json!({"upserts": [message(&format!("new{i}"), "user", "test")]}),
                    )
                    .expect("patch");
                    apply_path(path, patch).expect("write");
                });
            }
        });
        assert_eq!(
            read_document(&path)
                .expect("read")
                .expect("exists")
                .messages
                .len(),
            19
        );
        let original = std::fs::read(&path).expect("bytes");
        let patch = serde_json::from_value(
            json!({"upserts": [message("oversized", "user", &"x".repeat(MAX_CHAT_BYTES))]}),
        )
        .expect("patch");
        assert!(apply_path(&path, patch).is_err());
        assert_eq!(std::fs::read(&path).expect("preserved"), original);
        // A directory at the target cannot be replaced by an atomic transcript write.
        let blocked = dir.join("blocked");
        std::fs::create_dir(&blocked).expect("directory");
        std::fs::write(blocked.join("keep"), b"original").expect("sentinel");
        assert!(write_document(&blocked, &document()).is_err());
        assert_eq!(
            std::fs::read(blocked.join("keep")).expect("sentinel"),
            b"original"
        );
        std::fs::write(&path, b"broken json").expect("corrupt");
        let patch =
            serde_json::from_value(json!({"header": {"title": "replacement"}})).expect("patch");
        assert!(apply_path(&path, patch).is_err());
        assert_eq!(std::fs::read(&path).expect("preserved"), b"broken json");
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}
