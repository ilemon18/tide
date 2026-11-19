use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::commands::agent::{kill_turns, AgentTurn};
use crate::commands::terminal::PtySession;
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
    /// Projects whose window exists but the frontend has not called `open_folder` yet. A window
    /// takes a few hundred ms to load, and in that gap another window clicking the same project
    /// must still switch to this not-yet-registered window.
    pending: Mutex<HashMap<PathBuf, String>>,
    /// Lock for "open project" decisions: dedupe, reserve and window creation must be one step,
    /// otherwise two windows clicking the same project each decide nobody has it open and each
    /// opens one — a project should occupy exactly one window.
    opens: Mutex<()>,
    pub ptys: Mutex<HashMap<String, Arc<PtySession>>>,
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
        if last {
            grants.counts.remove(&path);
            RootRelease::Last
        } else {
            RootRelease::StillHeld
        }
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

    /// Validate and return the canonicalized workspace root
    pub fn authorize(&self, root: &str) -> AppResult<PathBuf> {
        if root.is_empty() {
            return Err(AppError::c("workspace.notOpen"));
        }
        let canon = paths::canon(Path::new(root)).map_err(|_| AppError::c("workspace.inaccessible"))?;
        if !self.grants.lock().counts.contains_key(&canon) {
            return Err(AppError::c("workspace.notAuthorized"));
        }
        Ok(canon)
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
}
