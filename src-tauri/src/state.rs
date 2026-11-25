use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::commands::agent::{kill_turns, AgentTurn};
use crate::commands::terminal::PtySession;
use crate::commands::tasks::TaskProcess;
use crate::error::{AppError, AppResult};
use crate::paths;
use crate::watcher::WatchHandle;

/// Workspace grant table: refcounts plus which directories each window holds. Two windows can
/// hold the same directory, so one closing must not revoke the other; on close or crash the
/// backend releases everything per owner, without a matching close_folder from the frontend.
#[derive(Default)]
struct RootGrants {
    counts: HashMap<PathBuf, usize>,
    owners: HashMap<String, HashSet<PathBuf>>,
}

/// Result of close_folder.
#[derive(Debug, PartialEq, Eq)]
pub enum RootRelease {
    /// This window no longer holds it and no window does
    Last,
    /// This window no longer holds it, but other windows still do
    StillHeld,
    /// This window never held it (duplicate or stale close); nothing was done
    NotOwned,
}

/// Global state: `grants` is the workspace allow-list every file command must hit (the
/// permission boundary); `ptys` is the terminal session table (processes owned by the backend).
#[derive(Default)]
pub struct AppState {
    grants: Mutex<RootGrants>,
    /// Exact external-file grants, per window. A file opened outside every workspace gets its
    /// own entry instead of granting the whole parent directory; reads/writes must match exactly.
    file_grants: Mutex<HashMap<String, HashSet<PathBuf>>>,
    /// Projects whose window exists but the frontend has not called `open_folder` yet. A window
    /// takes a few hundred ms to load, and in that gap another window clicking the same project
    /// must still switch to this not-yet-registered window.
    pending: Mutex<HashMap<PathBuf, String>>,
    /// Lock for "open project" decisions: dedupe, reserve and window creation must be one step,
    /// otherwise two windows clicking the same project each decide nobody has it open and each
    /// opens one — a project should occupy exactly one window.
    opens: Mutex<()>,
    pub ptys: Mutex<HashMap<String, Arc<PtySession>>>,
    /// Running project tasks, keyed by task id.
    pub tasks: Mutex<HashMap<String, Arc<TaskProcess>>>,
    /// Running agent CLIs, keyed by chat id (one turn per chat)
    pub agent_turns: Mutex<HashMap<String, Arc<AgentTurn>>>,
    /// One file watcher per workspace root (removed when its refcount hits zero).
    pub watchers: Mutex<HashMap<PathBuf, WatchHandle>>,
}

impl AppState {
    /// Serializes the "open project" decision and window creation; dedupe + reserve are safe
    /// while it is held.
    pub fn begin_open(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.opens.lock()
    }

    /// Reserve the project for the window about to be created. Returns the canonicalized path
    /// (no reservation if canonicalization fails).
    pub fn reserve_root(&self, owner: &str, path: &Path) -> Option<PathBuf> {
        let canon = paths::canon(path).ok()?;
        self.pending.lock().insert(canon.clone(), owner.to_string());
        Some(canon)
    }

    /// Drop a reservation (frontend cancel / open failure / window failure). Only our own, never
    /// someone else's.
    pub fn release_pending(&self, owner: &str, path: &Path) {
        let Ok(canon) = paths::canon(path) else {
            return;
        };
        let mut pending = self.pending.lock();
        if pending.get(&canon).map(String::as_str) == Some(owner) {
            pending.remove(&canon);
        }
    }

    /// Does this window hold a reservation with no registered workspace yet (counts when
    /// deciding "blank window")?
    pub fn window_has_pending(&self, owner: &str) -> bool {
        self.pending.lock().values().any(|value| value == owner)
    }

    /// Register a window's hold on a directory. Returns (canonical path, refcount, newly held).
    /// Reopening the same directory in the same window does not count twice.
    pub fn register_root(&self, owner: &str, path: &Path) -> AppResult<(PathBuf, usize, bool)> {
        let canon = paths::canon(path)
            .map_err(|_| AppError::p("workspace.openFailed", [("path", path.display().to_string())]))?;
        if !canon.is_dir() {
            return Err(AppError::c("fs.notAFolder"));
        }
        let mut grants = self.grants.lock();
        let newly = grants
            .owners
            .entry(owner.to_string())
            .or_default()
            .insert(canon.clone());
        let count = grants.counts.entry(canon.clone()).or_insert(0);
        if newly {
            *count += 1;
        }
        Ok((canon, *count, newly))
    }

    /// Grant one exact file for a window. The parent must exist; the file may be missing so
    /// "Save As" can name a new target. Returns the normalized absolute path.
    pub fn register_file(&self, owner: &str, path: &Path) -> AppResult<PathBuf> {
        let target = paths::normalize_file_target(path).map_err(|e| file_target_error(path, e))?;
        self.file_grants
            .lock()
            .entry(owner.to_string())
            .or_default()
            .insert(target.clone());
        Ok(target)
    }

    /// Release a window's hold on a directory.
    /// Only decrement when this window really held it, so a stale / duplicate close cannot drop
    /// another window's reference.
    pub fn unregister_root(&self, owner: &str, root: &str) -> RootRelease {
        // The frontend sends back the canonical string open_folder gave it, so match exactly.
        // No re-canonicalize: after a delete / rename it fails and the count never drops.
        let path = PathBuf::from(root);
        let mut grants = self.grants.lock();

        let owns = match grants.owners.get_mut(owner) {
            Some(paths) => paths.remove(&path),
            None => false,
        };
        if !owns {
            return RootRelease::NotOwned;
        }
        let owner_empty = grants
            .owners
            .get(owner)
            .map(|paths| paths.is_empty())
            .unwrap_or(false);
        if owner_empty {
            grants.owners.remove(owner);
        }

        let last = match grants.counts.get_mut(&path) {
            Some(count) => {
                *count = count.saturating_sub(1);
                *count == 0
            }
            // Count and ownership disagree: treat as unused so the caller also stops the watcher
            None => true,
        };
        let released = if last {
            grants.counts.remove(&path);
            RootRelease::Last
        } else {
            RootRelease::StillHeld
        };
        drop(grants);
        self.kill_root_tasks(owner, &path);
        released
    }

    /// Project roots open in any window (deduped + sorted by path; sorting is only for stable
    /// output, the caller decides display order).
    pub fn open_roots(&self) -> Vec<PathBuf> {
        let grants = self.grants.lock();
        let mut roots: Vec<PathBuf> = grants.counts.keys().cloned().collect();
        roots.sort();
        roots
    }

    /// Which window has this directory open: a new window opening an open project just focuses it.
    /// Exact root only — a subdirectory is another project; use split tabs to view one repo twice.
    pub fn owner_window_of(&self, path: &Path) -> Option<String> {
        let canon = paths::canon(path).ok()?;
        // A window still opening wins: no grant yet, but the project is already its own
        if let Some(owner) = self.pending.lock().get(&canon) {
            return Some(owner.clone());
        }
        let grants = self.grants.lock();
        grants
            .owners
            .iter()
            .find(|(_, paths)| paths.contains(&canon))
            .map(|(owner, _)| owner.clone())
    }

    /// Does this window still hold any directory (decides whether to reset the window title)?
    pub fn window_has_roots(&self, owner: &str) -> bool {
        self.grants
            .lock()
            .owners
            .get(owner)
            .map(|paths| !paths.is_empty())
            .unwrap_or(false)
    }

    /// Window destroyed: release every directory it held and stop the watchers nobody uses.
    pub fn release_window(&self, owner: &str) {
        // Also clear reservations without a grant, or a dead window keeps holding projects
        self.pending.lock().retain(|_, value| value != owner);
        // External files have no watcher/refcount: the window owns them outright.
        self.file_grants.lock().remove(owner);
        let zero = {
            let mut grants = self.grants.lock();
            let Some(paths) = grants.owners.remove(owner) else {
                return;
            };
            let mut zero: Vec<PathBuf> = Vec::new();
            for path in paths {
                let last = match grants.counts.get_mut(&path) {
                    Some(count) => {
                        *count = count.saturating_sub(1);
                        *count == 0
                    }
                    None => true,
                };
                if last {
                    zero.push(path);
                }
            }
            for path in &zero {
                grants.counts.remove(path);
            }
            zero
        };
        if zero.is_empty() {
            return;
        }

        // grants is released before taking watchers, avoiding a lock-order issue with open_folder
        let mut watchers = self.watchers.lock();
        for path in zero {
            if let Some(handle) = watchers.remove(&path) {
                handle.stop();
            }
        }
    }

    /// Validate and return the canonicalized workspace root, or the exact path of a granted
    /// external file. Missing paths are only valid when they match a registered file grant (the
    /// "Save As" target that does not exist yet).
    pub fn authorize(&self, root: &str) -> AppResult<PathBuf> {
        if root.is_empty() {
            return Err(AppError::c("workspace.notOpen"));
        }
        let requested = Path::new(root);
        let canon = match paths::canon(requested) {
            Ok(path) => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let target = paths::normalize_file_target(requested)
                    .map_err(|e| file_target_error(requested, e))?;
                if self.file_grants.lock().values().any(|paths| paths.contains(&target)) {
                    return Ok(target);
                }
                return Err(AppError::c("workspace.notAuthorized"));
            }
            Err(_) => return Err(AppError::c("workspace.inaccessible")),
        };
        if self.grants.lock().counts.contains_key(&canon)
            || self.file_grants.lock().values().any(|paths| paths.contains(&canon))
        {
            return Ok(canon);
        }
        Err(AppError::c("workspace.notAuthorized"))
    }

    pub fn kill_all_watchers(&self) {
        let handles: Vec<WatchHandle> = self.watchers.lock().drain().map(|(_, h)| h).collect();
        for handle in handles {
            handle.stop();
        }
    }

    pub fn kill_all_ptys(&self) {
        let sessions: Vec<Arc<PtySession>> = self.ptys.lock().drain().map(|(_, v)| v).collect();
        for s in sessions {
            s.kill();
        }
    }

    pub fn kill_all_tasks(&self) {
        let tasks: Vec<Arc<TaskProcess>> = self.tasks.lock().drain().map(|(_, task)| task).collect();
        for task in tasks { task.stop(); }
    }

    pub fn kill_window_tasks(&self, owner: &str) {
        let mut running = self.tasks.lock();
        let ids: Vec<String> = running.iter().filter(|(_, task)| task.owner == owner).map(|(id, _)| id.clone()).collect();
        let tasks: Vec<Arc<TaskProcess>> = ids.iter().filter_map(|id| running.remove(id)).collect();
        drop(running);
        for task in tasks { task.stop(); }
    }

    fn kill_root_tasks(&self, owner: &str, root: &Path) {
        let mut running = self.tasks.lock();
        let ids: Vec<String> = running.iter().filter(|(_, task)| task.owner == owner && task.root.as_path() == root).map(|(id, _)| id.clone()).collect();
        let tasks: Vec<Arc<TaskProcess>> = ids.iter().filter_map(|id| running.remove(id)).collect();
        drop(running);
        for task in tasks { task.stop(); }
    }

    /// Stop every agent CLI (app exit).
    pub fn kill_all_agent_turns(&self) {
        let mut turns = self.agent_turns.lock();
        kill_turns(&mut turns, None);
    }

    /// Reap the agent turns a destroyed window started.
    pub fn kill_window_agent_turns(&self, owner: &str) {
        let mut turns = self.agent_turns.lock();
        kill_turns(&mut turns, Some(owner));
    }

    /// Reap the terminals a destroyed window opened.
    /// Otherwise the shell keeps running after the window closes and its reader keeps pushing data.
    pub fn kill_window_ptys(&self, owner: &str) {
        let mut ptys = self.ptys.lock();
        let ids: Vec<String> = ptys
            .iter()
            .filter(|(_, session)| session.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        let sessions: Vec<Arc<PtySession>> = ids.iter().filter_map(|id| ptys.remove(id)).collect();
        drop(ptys);
        for s in sessions {
            s.kill();
        }
    }
}

fn file_target_error(path: &Path, error: paths::FileTargetError) -> AppError {
    match error {
        paths::FileTargetError::Relative | paths::FileTargetError::Invalid => {
            AppError::p("path.invalid", [("path", path.display().to_string())])
        }
        paths::FileTargetError::NotFile => {
            AppError::p("fs.notAFile", [("path", path.display().to_string())])
        }
        paths::FileTargetError::Symlink => AppError::c("fs.symlinkUnsupported"),
        paths::FileTargetError::Io(err) => AppError::io(path, err),
    }
}

/// Join a relative path onto root; reject absolute paths and `..` to block traversal.
pub fn resolve_in_root(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            _ => return Err(AppError::p("path.invalid", [("path", rel.to_string())])),
        }
    }
    Ok(out)
}

/// Keep symlinks inside the workspace from pointing outside it.
///
/// Look only at the nearest existing ancestor: the target may not exist yet, or may be mid-rename
/// by someone else. This **only checks containment**; existence is left to the real file operation
/// — with `exists()` + `canonicalize()` a rename in between reports a live file as missing.
pub fn assert_inside(root: &Path, path: &Path) -> AppResult<()> {
    // Canonicalize both sides so symlinks cannot escape the root. dunce keeps the Windows `\\?\`
    // prefix for long / non-Unicode paths; the shared comparison treats equivalent prefix forms as equal.
    let root = paths::canon(root)?;
    let mut probe = path;
    loop {
        match paths::canon(probe) {
            Ok(canon) => {
                return if paths::is_inside(&root, &canon) {
                    Ok(())
                } else {
                    Err(AppError::p(
                        "path.outsideWorkspace",
                        [("path", path.display().to_string())],
                    ))
                };
            }
            // This level (or an ancestor) does not exist: keep walking up to the nearest one
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        match probe.parent() {
            Some(p) => probe = p,
            None => return Err(AppError::c("path.invalidEmpty")),
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn assert_inside_accepts_verbatim_root() {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = root.join("tide-assert-inside-test");
        super::assert_inside(&root, &path).unwrap();
    }

    #[test]
    fn file_grants_authorize_exact_missing_targets() {
        let state = super::AppState::default();
        let root = std::env::temp_dir();
        let missing = root.join("tide-file-grant-test-not-created.txt");
        let _ = std::fs::remove_file(&missing);
        let granted = state.register_file("w1", &missing).unwrap();
        assert_eq!(state.authorize(granted.to_string_lossy().as_ref()).unwrap(), granted);
        let sibling = root.join("tide-file-grant-test-sibling.txt");
        assert!(state.authorize(sibling.to_string_lossy().as_ref()).is_err());
        state.release_window("w1");
        assert!(state.authorize(granted.to_string_lossy().as_ref()).is_err());
    }
}
