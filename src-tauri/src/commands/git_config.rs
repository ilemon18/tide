use super::{
    git::{run_text_with_timeout, run_with_timeout, NET_TIMEOUT},
    git_ui::{validate_identity, GitIdentity},
};
use crate::{
    error::{AppError, AppResult},
    proc,
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPreferences {
    pub merge_auto_commit: bool,
    pub merge_log: bool,
    pub merge_no_ff: bool,
    pub pull_rebase: bool,
    pub auto_refresh: bool,
    pub background_fetch: bool,
    pub disable_submodule_recursion: bool,
}
impl Default for GitPreferences {
    fn default() -> Self {
        Self {
            merge_auto_commit: true,
            merge_log: false,
            merge_no_ff: false,
            pull_rebase: false,
            auto_refresh: true,
            background_fetch: false,
            disable_submodule_recursion: false,
        }
    }
}
static CACHE: parking_lot::Mutex<Option<GitPreferences>> = parking_lot::Mutex::new(None);
// Native preference cache is bounded; UI/store entries live only for open roots.
const PROJECT_CACHE_LIMIT: usize = 16;
static PROJECT_CACHE: parking_lot::Mutex<VecDeque<(String, GitPreferences)>> =
    parking_lot::Mutex::new(VecDeque::new());
static WRITE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
pub(super) fn cached() -> GitPreferences {
    CACHE.lock().clone().unwrap_or_default()
}
pub(super) fn cached_for(root: &str) -> GitPreferences {
    PROJECT_CACHE
        .lock()
        .iter()
        .find(|entry| entry.0 == root)
        .map(|entry| entry.1.clone())
        .unwrap_or_else(cached)
}
fn store_project(root: &str, value: &GitPreferences) {
    let mut entries = PROJECT_CACHE.lock();
    entries.retain(|entry| entry.0 != root);
    entries.push_front((root.to_owned(), value.clone()));
    entries.truncate(PROJECT_CACHE_LIMIT);
}
fn global_git(args: &[&str], file: Option<&Path>) -> AppResult<(bool, String)> {
    context_git(args, file, None)
}
fn context_git(
    args: &[&str],
    file: Option<&Path>,
    root: Option<&str>,
) -> AppResult<(bool, String)> {
    let mut command = proc::command("git");
    if let Some(root) = root {
        command.args(["-C", root]);
    }
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(file) = file {
        command.env("GIT_CONFIG_GLOBAL", file);
    }
    let mut child = command
        .spawn()
        .map_err(|e| AppError::p("git.spawnFailed", [("error", e.to_string())]))?;
    let started = Instant::now();
    while child.try_wait()?.is_none() {
        if started.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::c("git.readTimeout"));
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    let output = child.wait_with_output()?;
    let text = if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    };
    Ok((
        output.status.success(),
        String::from_utf8_lossy(text).trim().to_owned(),
    ))
}
#[cfg(test)]
fn value(key: &str, file: Option<&Path>) -> AppResult<String> {
    let (ok, text) = global_git(&["config", "--global", "--get", key], file)?;
    Ok(if ok { text } else { String::new() })
}
fn truth(value: &str, fallback: bool) -> bool {
    match value {
        "true" | "yes" | "on" | "1" => true,
        "false" | "no" | "off" | "0" => false,
        "" => fallback,
        other => other.parse::<u32>().map(|v| v > 0).unwrap_or(fallback),
    }
}
const PREFERENCE_KEYS: &str = "^(merge\\.(log|ff)|pull\\.rebase|submodule\\.recurse|tide\\.(mergeautocommit|autorefresh|backgroundfetch|disablesubmodulerecursion))$";
fn config_values(file: Option<&Path>, root: Option<&str>) -> AppResult<HashMap<String, String>> {
    let args = if root.is_some() {
        vec!["config", "--null", "--get-regexp", PREFERENCE_KEYS]
    } else {
        vec![
            "config",
            "--global",
            "--includes",
            "--null",
            "--get-regexp",
            PREFERENCE_KEYS,
        ]
    };
    let (ok, text) = context_git(&args, file, root)?;
    if !ok && !text.is_empty() {
        return Err(AppError::new(text));
    }
    Ok(text
        .split('\0')
        .filter_map(|entry| entry.split_once('\n'))
        .map(|(key, value)| (key.to_lowercase(), value.to_owned()))
        .collect())
}
fn from_values(values: &HashMap<String, String>, fallback: &GitPreferences) -> GitPreferences {
    let boolean = |key: &str, default: bool| {
        values
            .get(key)
            .map(|value| value.is_empty() || truth(value, default))
            .unwrap_or(default)
    };
    GitPreferences {
        merge_auto_commit: boolean("tide.mergeautocommit", fallback.merge_auto_commit),
        merge_log: boolean("merge.log", fallback.merge_log),
        merge_no_ff: values
            .get("merge.ff")
            .map(|value| value != "only" && !truth(value, true))
            .unwrap_or(fallback.merge_no_ff),
        pull_rebase: values
            .get("pull.rebase")
            .map(|value| {
                matches!(
                    value.as_str(),
                    "true" | "1" | "merges" | "preserve" | "interactive"
                )
            })
            .unwrap_or(fallback.pull_rebase),
        auto_refresh: boolean("tide.autorefresh", fallback.auto_refresh),
        background_fetch: boolean("tide.backgroundfetch", fallback.background_fetch),
        disable_submodule_recursion: if values.contains_key("tide.disablesubmodulerecursion") {
            boolean(
                "tide.disablesubmodulerecursion",
                fallback.disable_submodule_recursion,
            )
        } else {
            values
                .get("submodule.recurse")
                .map(|value| !truth(value, true))
                .unwrap_or(fallback.disable_submodule_recursion)
        },
    }
}
#[cfg(target_os = "macos")]
fn sourcetree_boolean(key: &str) -> Option<bool> {
    // Read only the requested boolean from the existing application's preferences, never its account data.
    let output = proc::command("defaults")
        .args(["read", "com.torusknot.SourceTreeNotMAS", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}
#[cfg(not(target_os = "macos"))]
fn sourcetree_boolean(_: &str) -> Option<bool> {
    None
}
fn read_preferences(file: Option<&Path>) -> AppResult<GitPreferences> {
    let values = config_values(file, None)?;
    let mut fallback = GitPreferences::default();
    if file.is_none() {
        if !values.contains_key("merge.log") {
            if let Some(value) = sourcetree_boolean("gitIncludeMessagesFromCommits") {
                fallback.merge_log = value;
            }
        }
        if !values.contains_key("pull.rebase") {
            if let Some(value) = sourcetree_boolean("gitRebaseTrackingBranches") {
                fallback.pull_rebase = value;
            }
        }
    }
    Ok(from_values(&values, &fallback))
}
fn project_fallback(root: &str, mut fallback: GitPreferences) -> GitPreferences {
    use std::io::Read;
    if let Ok(gitdir) = super::git::metadata_directory(root) {
        if let Ok(file) = std::fs::File::open(gitdir.join("sourcetreeconfig")) {
            let mut text = String::new();
            if file.take(64 * 1024).read_to_string(&mut text).is_ok() {
                for line in text.lines() {
                    if let Some((key, value)) = line.split_once('=') {
                        match key.trim() {
                            "autorefresh" => {
                                fallback.auto_refresh = truth(value.trim(), fallback.auto_refresh)
                            }
                            "autorefreshremotes" => {
                                fallback.background_fetch =
                                    truth(value.trim(), fallback.background_fetch)
                            }
                            "disablerecursiveoperations" => {
                                fallback.disable_submodule_recursion =
                                    truth(value.trim(), fallback.disable_submodule_recursion)
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    fallback
}
pub(super) fn load_project(root: &str) -> AppResult<GitPreferences> {
    let fallback = project_fallback(root, read_preferences(None)?);
    let value = from_values(&config_values(None, Some(root))?, &fallback);
    store_project(root, &value);
    Ok(value)
}
#[tauri::command(async)]
pub fn git_project_preferences(
    state: State<'_, AppState>,
    root: String,
) -> AppResult<GitPreferences> {
    let root = state.authorize(&root)?;
    load_project(&root.to_string_lossy())
}
#[tauri::command(async)]
pub fn git_set_project_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    changes: HashMap<String, bool>,
) -> AppResult<GitPreferences> {
    let root = state.authorize(&root)?;
    let root = root.to_string_lossy();
    let _guard = WRITE_LOCK.lock();
    let entries = changes
        .iter()
        .map(|(key, value)| option(key, *value))
        .collect::<AppResult<Vec<_>>>()?;
    for (key, value) in entries {
        let (ok, text) = context_git(&["config", "--local", key, value], None, Some(&root))?;
        if !ok {
            return Err(AppError::new(text));
        }
    }
    let value = load_project(&root)?;
    let _ = app.emit("git:config-changed", ());
    Ok(value)
}
fn option(key: &str, enabled: bool) -> AppResult<(&'static str, &'static str)> {
    let (key, value) = match key {
        "mergeAutoCommit" => ("tide.mergeAutoCommit", enabled),
        "mergeLog" => ("merge.log", enabled),
        "mergeNoFf" => ("merge.ff", !enabled),
        "pullRebase" => ("pull.rebase", enabled),
        "autoRefresh" => ("tide.autoRefresh", enabled),
        "backgroundFetch" => ("tide.backgroundFetch", enabled),
        "disableSubmoduleRecursion" => ("tide.disableSubmoduleRecursion", enabled),
        _ => return Err(AppError::c("git.invalidPreference")),
    };
    Ok((key, if value { "true" } else { "false" }))
}
#[tauri::command(async)]
pub fn git_preferences() -> AppResult<GitPreferences> {
    let value = read_preferences(None)?;
    *CACHE.lock() = Some(value.clone());
    PROJECT_CACHE.lock().clear();
    Ok(value)
}
#[tauri::command(async)]
pub fn git_set_preferences(
    app: AppHandle,
    changes: HashMap<String, bool>,
) -> AppResult<GitPreferences> {
    let _guard = WRITE_LOCK.lock();
    let entries = changes
        .iter()
        .map(|(key, value)| option(key, *value))
        .collect::<AppResult<Vec<_>>>()?;
    for (key, value) in entries {
        let (ok, text) = global_git(&["config", "--global", key, value], None)?;
        if !ok {
            return Err(AppError::new(text));
        }
    }
    let value = read_preferences(None)?;
    *CACHE.lock() = Some(value.clone());
    PROJECT_CACHE.lock().clear();
    let _ = app.emit("git:config-changed", ());
    Ok(value)
}
#[derive(Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}
pub(super) fn remotes(root: &str) -> AppResult<Vec<GitRemote>> {
    let (ok, names) = run_text_with_timeout(root, &["remote"])?;
    if !ok {
        return Err(AppError::new(names));
    }
    let mut result = Vec::new();
    for name in names.lines() {
        let (ok, url) = run_text_with_timeout(root, &["remote", "get-url", "--", name])?;
        if ok {
            result.push(GitRemote {
                name: name.to_owned(),
                url: url.trim().to_owned(),
            });
        }
    }
    Ok(result)
}
#[tauri::command(async)]
pub fn git_remotes(state: State<'_, AppState>, root: String) -> AppResult<Vec<GitRemote>> {
    let root = state.authorize(&root)?;
    remotes(&root.to_string_lossy())
}
fn check_remote(root: &str, name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.starts_with('-')
        || !run_text_with_timeout(
            root,
            &["check-ref-format", &format!("refs/remotes/{name}/probe")],
        )?
        .0
    {
        return Err(AppError::c("git.invalidRemote"));
    }
    Ok(())
}
#[tauri::command(async)]
pub fn git_set_remote(
    state: State<'_, AppState>,
    root: String,
    old_name: Option<String>,
    name: String,
    url: String,
) -> AppResult<()> {
    let root = state.authorize(&root)?;
    let root = root.to_string_lossy();
    check_remote(&root, &name)?;
    if url.trim().is_empty() || url.contains(['\0', '\n', '\r']) || url.trim().starts_with("ext::")
    {
        return Err(AppError::c("git.invalidRemote"));
    }
    let args = if let Some(old) = &old_name {
        check_remote(&root, old)?;
        if old != &name {
            let (ok, text) =
                run_with_timeout(&root, &["remote", "rename", "--", old, &name], NET_TIMEOUT)?;
            if !ok {
                return Err(AppError::new(text));
            }
        }
        vec!["remote", "set-url", "--", name.as_str(), url.trim()]
    } else {
        vec!["remote", "add", "--", name.as_str(), url.trim()]
    };
    let (ok, text) = run_with_timeout(&root, &args, NET_TIMEOUT)?;
    if !ok {
        return Err(AppError::new(text));
    }
    Ok(())
}
#[tauri::command(async)]
pub fn git_remove_remote(state: State<'_, AppState>, root: String, name: String) -> AppResult<()> {
    let root = state.authorize(&root)?;
    let root = root.to_string_lossy();
    check_remote(&root, &name)?;
    let (ok, text) = run_with_timeout(&root, &["remote", "remove", "--", &name], NET_TIMEOUT)?;
    if !ok {
        return Err(AppError::new(text));
    }
    Ok(())
}
#[tauri::command(async)]
pub fn git_set_identity(
    app: AppHandle,
    state: State<'_, AppState>,
    root: Option<String>,
    use_global: bool,
    identity: Option<GitIdentity>,
) -> AppResult<()> {
    let _guard = WRITE_LOCK.lock();
    if let Some(identity) = &identity {
        validate_identity(identity)?;
    }
    if let Some(root) = root {
        let root = state.authorize(&root)?;
        let root = root.to_string_lossy();
        if use_global {
            for key in ["user.name", "user.email"] {
                let _ = run_text_with_timeout(&root, &["config", "--local", "--unset-all", key])?;
            }
        } else {
            let identity = identity.ok_or_else(|| AppError::c("git.invalidIdentity"))?;
            for (key, value) in [
                ("user.name", identity.name.as_str()),
                ("user.email", identity.email.as_str()),
            ] {
                let (ok, text) = run_text_with_timeout(&root, &["config", "--local", key, value])?;
                if !ok {
                    return Err(AppError::new(text));
                }
            }
        }
        let (ok, text) = run_text_with_timeout(
            &root,
            &[
                "config",
                "--local",
                "tide.useGlobalIdentity",
                if use_global { "true" } else { "false" },
            ],
        )?;
        if !ok {
            return Err(AppError::new(text));
        }
    } else {
        let identity = identity.ok_or_else(|| AppError::c("git.invalidIdentity"))?;
        for (key, value) in [
            ("user.name", identity.name.as_str()),
            ("user.email", identity.email.as_str()),
        ] {
            let (ok, text) = global_git(&["config", "--global", key, value], None)?;
            if !ok {
                return Err(AppError::new(text));
            }
        }
    }
    let _ = app.emit("git:config-changed", ());
    Ok(())
}
pub(super) fn global_path() -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("GIT_CONFIG_GLOBAL") {
        return Ok(PathBuf::from(path));
    }
    if let Ok((true, paths)) = global_git(&["var", "GIT_CONFIG_GLOBAL"], None) {
        let paths: Vec<_> = paths.lines().map(PathBuf::from).collect();
        if let Some(path) = paths.iter().find(|path| path.exists()) {
            return Ok(path.clone());
        }
        if let Some(path) = paths.first() {
            return Ok(path.clone());
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| AppError::c("git.configUnavailable"))?;
    let home = PathBuf::from(home);
    let primary = home.join(".gitconfig");
    let secondary = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("git/config");
    Ok(if primary.exists() || !secondary.exists() {
        primary
    } else {
        secondary
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn global_preferences_preserve_non_boolean_modes_and_unrelated_records() {
        let path = std::env::temp_dir().join(format!(
            "tide-global-git-{}-{:?}.config",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&path, "[merge]\n ff = only\n log = 25\n[pull]\n rebase = merges\n[alias]\n custom = status -sb\n[tide]\n autoRefresh = false\n").unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        let preferences = read_preferences(Some(&path)).unwrap();
        assert!(preferences.merge_log && preferences.pull_rebase);
        assert!(
            !preferences.merge_no_ff && !preferences.auto_refresh && !preferences.background_fetch
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        let (key, value) = option("backgroundFetch", true).unwrap();
        assert!(
            global_git(&["config", "--global", key, value], Some(&path))
                .unwrap()
                .0
        );
        assert_eq!(super::value("merge.ff", Some(&path)).unwrap(), "only");
        assert_eq!(super::value("merge.log", Some(&path)).unwrap(), "25");
        assert_eq!(super::value("pull.rebase", Some(&path)).unwrap(), "merges");
        assert_eq!(
            super::value("alias.custom", Some(&path)).unwrap(),
            "status -sb"
        );
        assert!(option("core.hooksPath", true).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
