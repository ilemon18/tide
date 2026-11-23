use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::paths;

/// Read-modify-write lock for session.json: windows may open projects / drop recents together.
static SESSION_LOCK: Mutex<()> = Mutex::new(());

/// Write lock for settings.json: when several windows (or concurrent saves in one window) flush,
/// the later write must fully overwrite the earlier one instead of clobbering its temp file.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Temp file counter: concurrent writes in one process each use their own temp file (see paths::write_atomic).

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    /// Per-command key overrides; an empty array explicitly removes the default.
    #[serde(deserialize_with = "deserialize_shortcut_overrides")]
    pub shortcut_overrides: serde_json::Map<String, serde_json::Value>,
    /// UI language (en / zh-CN / ja / es): native text such as the Dock menu follows it.
    pub locale: String,
    /// tide | dark-modern | dracula | one-dark | monokai | github-dark | nord
    /// | solarized-dark | light | github-light | xcode-light | solarized-light
    /// | one-light | catppuccin-latte | rose-pine-dawn | eyecare | system
    pub theme: String,
    /// File icon set: material | minimal | none
    pub icon_theme: String,
    /// Code font: jetbrains | system
    pub font_family: String,
    /// UI font size
    pub ui_font_size: u32,
    pub font_size: u32,
    pub terminal_font_size: u32,
    /// Terminal scrollback lines
    pub terminal_scrollback: u32,
    /// Terminal shell: empty = pick per platform (macOS / Linux use $SHELL,
    /// Windows tries pwsh / powershell / cmd in order). Windows users can set a Git Bash or WSL path.
    pub terminal_shell: String,
    pub tab_size: u32,
    pub auto_save: bool,
    pub word_wrap: bool,
    /// Strip trailing whitespace / ensure a final newline on save
    pub trim_trailing_whitespace: bool,
    pub insert_final_newline: bool,
    /// Editor indent guides
    pub indent_guides: bool,
    /// Draw == / => and similar pairs as one ligature glyph (off by default)
    pub ligatures: bool,
    /// When to format: off | manual | onSave
    pub format_mode: String,
    /// Formatter: auto (picked by extension) | prettier | rustfmt | gofmt | black
    pub format_tool: String,
    pub show_hidden: bool,
    /// Folders holding no files (just one subfolder each) draw as a single row; on by default
    pub compact_folders: bool,
    /// GitLens-style inline blame, on by default
    pub inline_blame: bool,
    /// Terminal WebGL renderer (uses more VRAM, off by default)
    pub terminal_webgl: bool,
    /// Lightweight mode: smaller caches, fewer background jobs (off by default)
    pub lightweight_mode: bool,
    /// Download application updates in the background, but always ask before installing
    pub auto_update: bool,
    /// Built-in agent service: title-bar entry, explorer double-click entry, chat tabs
    pub agent_enabled: bool,
    /// Project task discovery, execution and Problems diagnostics
    #[serde(deserialize_with = "deserialize_tasks_enabled")]
    pub tasks_enabled: bool,
    /// Show the lazily loaded project agent history list
    pub agent_history_enabled: bool,
    /// Last chosen provider / model / effort: new chats start here (empty = auto / CLI default)
    pub agent_default_provider: String,
    pub agent_default_model: String,
    pub agent_default_effort: String,
    /// Last explicit permission choice; invalid values must not reset the rest of the config.
    #[serde(deserialize_with = "deserialize_agent_permission_mode")]
    pub agent_default_permission_mode: String,
    /// Manual minimum height of the agent composer textarea; long drafts may grow taller
    pub agent_composer_height: u32,
    pub sidebar_width: u32,
    pub panel_height: u32,
    pub sidebar_visible: bool,
    pub panel_visible: bool,
    /// Keep fields this version does not know and write them back on the next save.
    /// Without it, config saved by a newer version is "reset" once an older version opens it.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn deserialize_tasks_enabled<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_bool().unwrap_or(true))
}

fn deserialize_shortcut_overrides<'de, D>(
    deserializer: D,
) -> Result<serde_json::Map<String, serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(id, value)| {
                    let values = value.as_array()?;
                    let valid: Vec<_> = values.iter().filter(|value| value.is_string()).cloned().collect();
                    if !values.is_empty() && valid.is_empty() {
                        return None;
                    }
                    Some((id.clone(), serde_json::Value::Array(valid)))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn deserialize_agent_permission_mode<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some(mode @ ("read-only" | "workspace-write" | "full-access")) => mode,
        _ => "workspace-write",
    }
    .to_owned())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 0,
            shortcut_overrides: serde_json::Map::new(),
            locale: "en".into(),
            theme: "tide".into(),
            icon_theme: "material".into(),
            font_family: "jetbrains".into(),
            ui_font_size: 13,
            font_size: 13,
            terminal_font_size: 12,
            terminal_scrollback: 2000,
            terminal_shell: String::new(),
            tab_size: 2,
            auto_save: false,
            word_wrap: false,
            trim_trailing_whitespace: false,
            insert_final_newline: false,
            indent_guides: true,
            ligatures: false,
            format_mode: "off".into(),
            format_tool: "auto".into(),
            show_hidden: true,
            compact_folders: true,
            inline_blame: false,
            terminal_webgl: false,
            lightweight_mode: false,
            auto_update: false,
            agent_enabled: true,
            tasks_enabled: true,
            agent_history_enabled: true,
            agent_default_provider: String::new(),
            agent_default_model: String::new(),
            agent_default_effort: String::new(),
            agent_default_permission_mode: "workspace-write".into(),
            agent_composer_height: 90,
            sidebar_width: 220,
            panel_height: 240,
            sidebar_visible: true,
            panel_visible: false,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentWorkspace {
    pub path: String,
    pub name: String,
    pub opened_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedTab {
    /// Path relative to the workspace root
    pub rel: String,
    /// Cursor line / column to restore after restart (1-based)
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub recent: Vec<RecentWorkspace>,
    pub last_workspace: Option<String>,
    /// Multi-root workspace: every root opened last time
    pub roots: Vec<String>,
    pub active_root: Option<String>,
    /// Files open last time (restore the editing scene on restart)
    pub tabs: Vec<SavedTab>,
    /// Which root those files belong to
    pub open_root: Option<String>,
    /// Active file last time (relative path)
    pub active_tab: Option<String>,
    /// Same as above: keep unknown fields so alternating versions does not lose the session
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::p("config.noDir", [("error", e.to_string())]))?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

/// Atomic write: write a temp file then rename, so config is never left corrupted.
fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let dir = path.parent().ok_or_else(|| AppError::c("config.invalidPath"))?;
    fs::create_dir_all(dir)?;
    let text = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::p("config.serializeFailed", [("error", e.to_string())]))?;
    // Temp name carries pid + counter: two windows writing the same config never share a file,
    // otherwise the first rename eats the other's temp file and one save is silently lost.
    paths::write_atomic(path, &text)?;
    Ok(())
}

pub fn read_settings(app: &AppHandle) -> Settings {
    let path = config_dir(app)
        .map(|d| d.join("settings.json"))
        .unwrap_or_else(|_| PathBuf::from("settings.json"));
    read_json(&path)
}

pub fn read_session(app: &AppHandle) -> Session {
    let path = config_dir(app)
        .map(|d| d.join("session.json"))
        .unwrap_or_else(|_| PathBuf::from("session.json"));
    read_json(&path)
}

#[tauri::command(async)]
pub fn load_settings(app: AppHandle) -> Settings {
    read_settings(&app)
}

/// When schemaVersion changes (upgrade / migration / downgrade), keep the old file as `settings.json.bak`.
/// A bad migration or a version rollback can then recover the original settings from it.
fn backup_before_schema_change(path: &Path, next_version: u32) {
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let previous = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("schemaVersion").and_then(|v| v.as_u64()))
        .unwrap_or(0) as u32;
    if previous == next_version {
        return;
    }
    let _ = fs::write(path.with_file_name("settings.json.bak"), &bytes);
}

#[tauri::command(async)]
pub fn save_settings(app: AppHandle, settings: Settings) -> AppResult<()> {
    // Serialize writes: IPC commands run concurrently on the thread pool, so theme (immediate)
    // and layout (debounced) saves may arrive together; last wins, but the file must be complete.
    {
        let _guard = SETTINGS_LOCK.lock();
        let dir = config_dir(&app)?;
        let path = dir.join("settings.json");
        backup_before_schema_change(&path, settings.schema_version);
        write_json(&path, &settings)?;
    }
    // Broadcast to other windows: appearance settings like theme / icon set must stay global;
    // windows only apply them and never write back, so they cannot overwrite each other (outside the lock so others can write now).
    let _ = app.emit("settings:changed", &settings);
    Ok(())
}

/// Theme id -> native window appearance (titlebar / scrollbars / traffic lights); 'system' returns None to follow the OS.
pub fn native_theme(theme: &str) -> Option<tauri::Theme> {
    match theme {
        "tide" | "light-modern" | "light" | "github-light" | "xcode-light" | "solarized-light"
        | "one-light" | "catppuccin-latte" | "rose-pine-dawn" | "eyecare" => {
            Some(tauri::Theme::Light)
        }
        "system" => None,
        _ => Some(tauri::Theme::Dark),
    }
}

#[tauri::command(async)]
pub fn load_session(app: AppHandle) -> Session {
    read_session(&app)
}

#[tauri::command(async)]
pub fn save_session(app: AppHandle, session: Session) -> AppResult<()> {
    let _guard = SESSION_LOCK.lock();
    let dir = config_dir(&app)?;
    let path = dir.join("session.json");
    // recent is maintained by remember_recent / remove_recent only:
    // here we store layout fields only, so windows cannot overwrite each other with stale lists.
    let mut stored: Session = read_json(&path);
    stored.last_workspace = session.last_workspace;
    stored.roots = session.roots;
    stored.active_root = session.active_root;
    write_json(&path, &stored)
}

/// Keeps "files open last time" separately: it runs on every cursor move,
/// so it cannot share a write with layout fields or the two writes clobber each other.
#[tauri::command(async)]
pub fn save_open_tabs(
    app: AppHandle,
    root: Option<String>,
    tabs: Vec<SavedTab>,
    active: Option<String>,
) -> AppResult<()> {
    let _guard = SESSION_LOCK.lock();
    let dir = config_dir(&app)?;
    let path = dir.join("session.json");
    let mut stored: Session = read_json(&path);
    stored.open_root = root;
    stored.tabs = tabs;
    stored.active_tab = active;
    write_json(&path, &stored)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Move the path to the top of "recent" when a project opens; returns the new list.
#[tauri::command(async)]
pub fn remember_recent(
    app: AppHandle,
    path: String,
    name: String,
) -> AppResult<Vec<RecentWorkspace>> {
    let _guard = SESSION_LOCK.lock();
    let dir = config_dir(&app)?;
    let file = dir.join("session.json");
    let mut session: Session = read_json(&file);
    session.recent.retain(|r| r.path != path);
    session.recent.insert(
        0,
        RecentWorkspace {
            path,
            name,
            opened_at: now_millis(),
        },
    );
    session.recent.truncate(16);
    write_json(&file, &session)?;
    let list = session.recent.clone();
    let _ = app.emit("session:recent-changed", &list);
    Ok(list)
}

/// Remove one "recent" entry; returns the new list.
#[tauri::command(async)]
pub fn remove_recent(app: AppHandle, path: String) -> AppResult<Vec<RecentWorkspace>> {
    let _guard = SESSION_LOCK.lock();
    let dir = config_dir(&app)?;
    let file = dir.join("session.json");
    let mut session: Session = read_json(&file);
    session.recent.retain(|r| r.path != path);
    write_json(&file, &session)?;
    let list = session.recent.clone();
    let _ = app.emit("session:recent-changed", &list);
    Ok(list)
}
#[cfg(test)]
mod compat {
    //! Config compatibility: upgrades / downgrades / field changes must never "reset" user settings.

    use super::{Session, Settings};

    /// Fields written by a newer version that this one does not know must survive a read-write roundtrip
    #[test]
    fn unknown_settings_fields_survive_roundtrip() {
        let raw = r#"{
            "schemaVersion": 6,
            "theme": "dracula",
            "formatMode": "off",
            "futureFeatureFlag": true,
            "futureNested": { "a": 1 }
        }"#;
        let mut settings: Settings = serde_json::from_str(raw).expect("parse");
        settings.theme = "nord".into();
        let out = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(out["theme"], "nord");
        assert_eq!(out["futureFeatureFlag"], true);
        assert_eq!(out["futureNested"]["a"], 1);
        assert!(out.get("extra").is_none(), "flatten must not add an extra key");
    }

    /// Fields missing from an old config fall back to defaults; existing values stay untouched
    #[test]
    fn missing_settings_fields_fall_back_to_defaults() {
        let settings: Settings = serde_json::from_str(r#"{"theme":"nord"}"#).expect("parse");
        assert_eq!(settings.theme, "nord");
        assert_eq!(settings.format_mode, "off");
        assert_eq!(settings.format_tool, "auto");
        assert_eq!(settings.tab_size, 2);
        assert_eq!(settings.agent_composer_height, 90);
        assert_eq!(settings.agent_default_permission_mode, "workspace-write");
        assert!(settings.agent_history_enabled);
        assert!(!settings.auto_save);
    }

    #[test]
    fn agent_preferences_survive_roundtrip() {
        for mode in ["read-only", "workspace-write", "full-access"] {
            let raw = serde_json::json!({
                "schemaVersion": 11,
                "agentDefaultProvider": "codex",
                "agentDefaultModel": "custom-model",
                "agentDefaultEffort": "high",
                "agentDefaultPermissionMode": mode,
                "futurePreference": true
            });
            let settings: Settings = serde_json::from_value(raw).expect("parse settings");
            let out = serde_json::to_value(&settings).expect("serialize settings");
            assert_eq!(out["agentDefaultProvider"], "codex");
            assert_eq!(out["agentDefaultModel"], "custom-model");
            assert_eq!(out["agentDefaultEffort"], "high");
            assert_eq!(out["agentDefaultPermissionMode"], mode);
            assert_eq!(out["futurePreference"], true);
        }
    }

    #[test]
    fn agent_history_preference_defaults_on_and_round_trips_off() {
        let legacy: Settings = serde_json::from_str(r#"{"schemaVersion":12}"#).expect("legacy settings");
        assert!(legacy.agent_history_enabled);
        let settings: Settings = serde_json::from_value(serde_json::json!({ "agentHistoryEnabled": false }))
            .expect("settings");
        let out = serde_json::to_value(settings).expect("serialize settings");
        assert_eq!(out["agentHistoryEnabled"], false);
    }

    #[test]
    fn task_preferences_default_on_round_trip_off_and_tolerate_invalid_values() {
        let legacy: Settings = serde_json::from_str(r#"{"schemaVersion":14}"#).unwrap();
        assert!(legacy.tasks_enabled);
        for invalid in [serde_json::json!(null), serde_json::json!(7), serde_json::json!("broken")] {
            let settings: Settings = serde_json::from_value(serde_json::json!({ "tasksEnabled": invalid, "fontSize": 19 })).unwrap();
            assert!(settings.tasks_enabled);
            assert_eq!(settings.font_size, 19);
        }
        let disabled: Settings = serde_json::from_str(r#"{"tasksEnabled":false}"#).unwrap();
        assert_eq!(serde_json::to_value(disabled).unwrap()["tasksEnabled"], false);
    }

    #[test]
    fn invalid_agent_permissions_preserve_other_settings() {
        for invalid in [
            serde_json::json!("unknown"),
            serde_json::json!(""),
            serde_json::json!(null),
            serde_json::json!(7),
        ] {
            let settings: Settings = serde_json::from_value(serde_json::json!({
                "fontSize": 17,
                "agentDefaultModel": "custom-model",
                "agentDefaultPermissionMode": invalid
            }))
            .expect("parse settings with invalid permissions");
            assert_eq!(settings.agent_default_permission_mode, "workspace-write");
            assert_eq!(settings.agent_default_model, "custom-model");
            assert_eq!(settings.font_size, 17);
        }
    }

    #[test]
    fn shortcuts_tolerate_invalid_fields_and_preserve_explicit_removals() {
        for invalid in [serde_json::json!(null), serde_json::json!(7), serde_json::json!([])] {
            let settings: Settings = serde_json::from_value(serde_json::json!({
                "fontSize": 19, "shortcutOverrides": invalid
            })).expect("invalid shortcut field must not reset settings");
            assert_eq!(settings.font_size, 19);
            assert!(settings.shortcut_overrides.is_empty());
        }
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "shortcutOverrides": { "agent.ask": ["Mod+Shift+p"], "view.commands": [],
                "future.command": ["Mod+Shift+i"], "broken": 7, "mixed": [7, "Mod+s"] }
        })).expect("shortcut overrides");
        let out = serde_json::to_value(settings).expect("serialize settings");
        assert_eq!(out["shortcutOverrides"]["view.commands"], serde_json::json!([]));
        assert_eq!(out["shortcutOverrides"]["future.command"], serde_json::json!(["Mod+Shift+i"]));
        assert_eq!(out["shortcutOverrides"]["mixed"], serde_json::json!(["Mod+s"]));
        assert!(out["shortcutOverrides"].get("broken").is_none());
    }

    /// A corrupted file must only yield Err and let read_json fall back to defaults, never panic
    #[test]
    fn broken_settings_are_rejected_not_panicking() {
        assert!(serde_json::from_str::<Settings>("{ not json").is_err());
    }

    /// Session files must preserve unknown fields too
    #[test]
    fn unknown_session_fields_survive_roundtrip() {
        let raw = r#"{"lastWorkspace":"/tmp/p","futureField":[1,2,3]}"#;
        let session: Session = serde_json::from_str(raw).expect("parse");
        let out = serde_json::to_value(&session).expect("serialize");
        assert_eq!(out["lastWorkspace"], "/tmp/p");
        assert_eq!(out["futureField"][2], 3);
    }
}
