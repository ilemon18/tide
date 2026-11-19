use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::paths;
use crate::proc;

/// Debounce window: one git checkout fires dozens of events in a row, fold them into one refresh
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Max paths carried back to the frontend per event batch (the frontend only needs to know roughly which dirs changed)
const MAX_PATHS: usize = 32;

/// Ignore paths containing these directory names outright, so `pnpm install` / builds don't flood us
const SKIP_DIRS: [&str; 12] = [
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".turbo",
    ".cache",
    ".idea",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChanged {
    root: String,
    /// Hit .git (branch switch / staging / commit / fetch)
    git: bool,
    /// Worktree file changes
    worktree: bool,
    /// Worktree-relative paths; the frontend refreshes incrementally by parent directory
    paths: Vec<String>,
}

pub struct WatchHandle {
    /// Must be kept alive: dropping it stops watching
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl WatchHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// High-churn noise directories inside `.git` (object store, reflog, submodules)
const GIT_NOISE: [&str; 3] = ["objects", "logs", "modules"];

/// Whether the path lives inside `.git`.
/// Do not compare strings here: Windows uses `\` as separator, so `text.contains("/.git/")`
/// never matches, and big-repo checkouts then flood events and the Git panel stops refreshing.
fn is_git_path(path: &Path) -> bool {
    path.components()
        .any(|part| matches!(part, Component::Normal(name) if name == OsStr::new(".git")))
}

/// Changes in internal dirs like `.git/objects`, `.git/logs`, `.git/modules` are meaningless
fn is_git_noise(path: &Path) -> bool {
    let mut in_git = false;
    for part in path.components() {
        let Component::Normal(name) = part else {
            continue;
        };
        if name == OsStr::new(".git") {
            in_git = true;
            continue;
        }
        if in_git {
            return GIT_NOISE
                .iter()
                .any(|skip| name == OsStr::new(skip));
        }
    }
    false
}

fn ignore_path(path: &Path) -> bool {
    if is_git_noise(path) {
        return true;
    }

    for component in path.components() {
        if let Component::Normal(name) = component {
            if SKIP_DIRS.iter().any(|skip| name == OsStr::new(skip)) {
                return true;
            }
        }
    }

    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    file.ends_with(".lock")
        || file.ends_with(".swp")
        || file.ends_with(".tmp")
        || file.starts_with(".goutputstream-")
        || file == ".DS_Store"
        // Windows Explorer / thumbnail caches; refreshing on their events is pointless
        || file == "Thumbs.db"
        || file == "desktop.ini"
}

/// Find the workspace's real .git directory (the workspace may be a subdirectory of the repo)
fn git_dir_of(root: &Path) -> Option<PathBuf> {
    let output = proc::command("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--absolute-git-dir"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

fn emit(app: &AppHandle, root: &Path, pending: &HashSet<PathBuf>) {
    let mut git = false;
    let mut worktree = false;
    let mut paths: Vec<String> = Vec::new();

    for path in pending.iter().take(MAX_PATHS) {
        // Things happening in .git (branch switch / staging / commit) only set the flag, they are
        // not reported as worktree file changes
        if is_git_path(path) {
            git = true;
            continue;
        }
        worktree = true;
        // Only return paths relative to the worktree; changes elsewhere in the repo are covered by the git flag
        if let Some(rel) = paths::rel_in(root, path) {
            if !rel.is_empty() {
                paths.push(rel);
            }
        }
    }

    if !git && !worktree {
        return;
    }

    let _ = app.emit(
        "fs:changed",
        FsChanged {
            root: root.to_string_lossy().to_string(),
            git,
            worktree,
            paths,
        },
    );
}

/// Start watching for one workspace root. Returns None on failure (main flow keeps working, the frontend still polls as fallback).
pub fn start(app: AppHandle, root: PathBuf) -> Option<WatchHandle> {
    // Bounded queue: one checkout can fire tens of thousands of path events at once.
    // Drop when full (the frontend only needs to know "which directory changed") instead of growing forever.
    let (tx, rx) = sync_channel::<PathBuf>(1024);

    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        // Just reading / opening a file is not a change
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        for path in event.paths {
            if ignore_path(&path) {
                continue;
            }
            let _ = tx.try_send(path);
        }
    })
    .ok()?;

    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        eprintln!("[Tide] cannot watch workspace: {}", root.display());
        return None;
    }

    // The workspace may be a repo subdirectory with .git in one of its parents, so watch that separately
    if let Some(git_dir) = git_dir_of(&root) {
        if !paths::is_inside(&root, &git_dir) {
            let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let app_handle = app.clone();
    let root_thread = root.clone();

    std::thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut deadline: Option<Instant> = None;

        loop {
            if stop_thread.load(Ordering::Relaxed) {
                break;
            }
            let timeout = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_millis(500));

            match rx.recv_timeout(timeout) {
                Ok(path) => {
                    // Upper bound: in extreme cases (full rebuild of a big repo) keep only the first few
                    if pending.len() < 2048 {
                        pending.insert(path);
                    }
                    if deadline.is_none() {
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(d) = deadline {
                        if Instant::now() >= d {
                            if !pending.is_empty() {
                                emit(&app_handle, &root_thread, &pending);
                                pending.clear();
                            }
                            deadline = None;
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Some(WatchHandle {
        _watcher: watcher,
        stop,
    })
}