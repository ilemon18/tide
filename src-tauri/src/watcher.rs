use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

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
    /// Paths were truncated/lost, or the backend requested a rescan.
    rescan: bool,
    /// Git exclude/config changes can alter ignored decorations without touching the worktree.
    ignore_changed: bool,
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
    (is_git_path(path) && file.ends_with(".lock"))
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

fn summarize(root: &Path, git_dir: Option<&Path>, pending: &HashSet<PathBuf>, lost: bool) -> FsChanged {
    let mut batch = FsChanged {
        root: root.to_string_lossy().to_string(),
        git: lost,
        worktree: lost,
        paths: Vec::new(),
        rescan: lost,
        ignore_changed: false,
    };
    // Classify every path before capping the payload. HashSet iteration order is arbitrary.
    for path in pending {
        let git_rel = git_dir.and_then(|dir| path.strip_prefix(dir).ok());
        if is_git_path(path) || git_rel.is_some() {
            batch.git = true;
            batch.ignore_changed |= git_rel.is_some_and(|rel| {
                rel == Path::new("info/exclude") || rel == Path::new("config")
            }) || path.ends_with(".git/info/exclude") || path.ends_with(".git/config");
            continue;
        }
        batch.worktree = true;
        match paths::rel_in(root, path) {
            Some(rel) if !rel.is_empty() => {
                if batch.paths.len() < MAX_PATHS {
                    batch.paths.push(rel);
                } else {
                    batch.rescan = true;
                }
            }
            _ => batch.rescan = true,
        }
    }
    batch.paths.sort();
    batch
}

fn enqueue(tx: &SyncSender<PathBuf>, lost: &AtomicBool, path: PathBuf) {
    if tx.try_send(path).is_err() {
        lost.store(true, Ordering::Relaxed);
    }
}

fn enqueue_notification(tx: &SyncSender<PathBuf>, lost: &AtomicBool, root: &Path, result: notify::Result<notify::Event>) {
    let event = match result {
        Ok(event) => event,
        Err(_) => {
            lost.store(true, Ordering::Relaxed);
            enqueue(tx, lost, root.to_path_buf());
            return;
        }
    };
    if event.need_rescan() {
        lost.store(true, Ordering::Relaxed);
        enqueue(tx, lost, root.to_path_buf());
    }
    if matches!(event.kind, notify::EventKind::Access(_)) {
        return;
    }
    for path in event.paths {
        if !ignore_path(&path) { enqueue(tx, lost, path); }
    }
}

fn flush_due(deadline: Option<Instant>, now: Instant) -> bool {
    deadline.is_some_and(|deadline| now >= deadline)
}

fn emit(app: &AppHandle, batch: FsChanged) {
    if batch.worktree || batch.rescan {
        if let Some(state) = app.try_state::<crate::state::AppState>() { state.live.notify(&batch.root); }
    }
    if batch.git || batch.worktree || batch.rescan {
        let _ = app.emit("fs:changed", batch);
    }
}

/// Start watching for one workspace root. Returns None on failure (main flow keeps working, the frontend still polls as fallback).
pub fn start(app: AppHandle, root: PathBuf) -> Option<WatchHandle> {
    // Bounded queue: one checkout can fire tens of thousands of path events at once.
    // Overflow requests a full refresh instead of silently losing changes.
    let (tx, rx) = sync_channel::<PathBuf>(1024);
    let lost = Arc::new(AtomicBool::new(false));
    let callback_lost = lost.clone();
    let callback_root = root.clone();
    let git_dir = git_dir_of(&root);

    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        enqueue_notification(&tx, &callback_lost, &callback_root, result);
    })
    .ok()?;

    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        eprintln!("[Tide] cannot watch workspace: {}", root.display());
        return None;
    }

    // The workspace may be a repo subdirectory with .git in one of its parents, so watch that separately
    if let Some(git_dir) = &git_dir {
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
            // Check even while events keep arriving: a continuous stream must not starve the flush.
            if flush_due(deadline, Instant::now()) {
                let batch = summarize(&root_thread, git_dir.as_deref(), &pending, lost.swap(false, Ordering::Relaxed));
                emit(&app_handle, batch);
                pending.clear();
                deadline = None;
            }
            let timeout = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_millis(500));

            match rx.recv_timeout(timeout) {
                Ok(path) => {
                    // Upper bound: in extreme cases (full rebuild of a big repo) keep only the first few
                    if pending.len() < 2048 {
                        pending.insert(path);
                    } else {
                        lost.store(true, Ordering::Relaxed);
                    }
                    if deadline.is_none() {
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Also deliver loss-only batches, even if no path could be queued.
                    if deadline.is_none() && lost.load(Ordering::Relaxed) {
                        deadline = Some(Instant::now());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_still_classifies_git_and_ignore_changes() {
        let root = Path::new("/repo");
        let mut paths: HashSet<PathBuf> = (0..80).map(|i| root.join(format!("src/f{i}"))).collect();
        paths.insert(root.join(".git/info/exclude"));
        let batch = summarize(root, Some(&root.join(".git")), &paths, false);
        assert_eq!(batch.paths.len(), MAX_PATHS);
        assert!(batch.rescan && batch.worktree && batch.git && batch.ignore_changed);
    }

    #[test]
    fn queue_overflow_and_watcher_errors_request_a_full_rescan() {
        let (tx, rx) = sync_channel(1);
        let lost = AtomicBool::new(false);
        enqueue(&tx, &lost, PathBuf::from("/repo/one"));
        enqueue(&tx, &lost, PathBuf::from("/repo/two"));
        assert!(lost.load(Ordering::Relaxed));
        let batch = summarize(Path::new("/repo"), None, &HashSet::new(), lost.swap(false, Ordering::Relaxed));
        assert!(batch.rescan && batch.git && batch.worktree);
        let _ = rx.try_recv();
        enqueue_notification(&tx, &lost, Path::new("/repo"), Err(notify::Error::generic("lost watcher")));
        assert!(lost.load(Ordering::Relaxed));
        assert_eq!(rx.try_recv().ok(), Some(PathBuf::from("/repo")));
    }

    #[test]
    fn continuous_notifications_do_not_extend_the_flush_deadline() {
        let start = Instant::now();
        let deadline = Some(start + DEBOUNCE);
        assert!(!flush_due(deadline, start + Duration::from_millis(299)));
        // The receive loop checks this before receiving even when the queue never becomes empty.
        assert!(flush_due(deadline, start + DEBOUNCE));
        assert!(flush_due(deadline, start + Duration::from_secs(1)));
    }

    #[test]
    fn normal_worktree_lock_files_are_not_git_lock_noise() {
        assert!(!ignore_path(Path::new("/repo/pnpm-lock.yaml")));
        assert!(!ignore_path(Path::new("/repo/Cargo.lock")));
        assert!(!ignore_path(Path::new("/repo/data.lock")));
        assert!(ignore_path(Path::new("/repo/.git/index.lock")));
        assert!(ignore_path(Path::new("/repo/.git/objects/ab/cd")));
    }

    #[test]
    fn explicit_rescan_and_external_git_excludes_are_not_lost() {
        let (tx, rx) = sync_channel(4);
        let lost = AtomicBool::new(false);
        let event = notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
        enqueue_notification(&tx, &lost, Path::new("/repo"), Ok(event));
        assert!(lost.load(Ordering::Relaxed));
        assert!(rx.try_recv().is_ok());
        let batch = summarize(Path::new("/repo"), Some(Path::new("/meta")), &HashSet::from([PathBuf::from("/meta/info/exclude")]), false);
        assert!(batch.git && batch.ignore_changed && !batch.worktree);
    }
}
