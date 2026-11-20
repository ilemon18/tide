use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::proc;
use crate::state::{assert_inside, resolve_in_root, AppState, RootRelease};

/// Max bytes per file read (larger files are rejected to protect memory)
const MAX_READ_BYTES: u64 = 20 * 1024 * 1024;
/// Image preview cap: images go whole into the webview, hungrier than text
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
/// Image extensions previewed directly (SVG is text, so it stays in the text editor)
const IMAGE_EXTS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "jfif"];
/// Max entries per directory page
const MAX_PAGE: usize = 500;
/// Max entries scanned per directory, so pathological dirs (100k entries) cannot stall it
const MAX_DIR_SCAN: usize = 20_000;
/// Cap for the quick-open file index (large repos still need deep files; 50k entries is a few MB)
const MAX_INDEX_FILES: usize = 50_000;
/// Max directory depth for the index walk
const MAX_INDEX_DEPTH: usize = 24;

/// Heavy directories skipped during the walk
const SKIP_DIRS: [&str; 14] = [
    "node_modules",
    ".git",
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
    "Pods",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
    pub is_git_repo: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: i64,
    /// Whether it matches .gitignore (the frontend greys it out)
    pub ignored: bool,
    /// Whether it is hidden. On Windows this is an attribute bit (not a `.` prefix), so the
    /// backend must compute it, otherwise "hide hidden files" is a no-op there.
    pub hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirPage {
    pub entries: Vec<DirEntryInfo>,
    pub total: usize,
    pub has_more: bool,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    pub content: String,
    pub size: u64,
    pub mtime: i64,
    /// Treated as binary when a NUL byte is found
    pub binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub size: u64,
    pub mtime: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndex {
    pub files: Vec<FileHit>,
    /// Hit the cap, so the index is incomplete
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub is_dir: bool,
    pub is_file: bool,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartTarget {
    pub roots: Vec<String>,
    pub file: Option<String>,
}

/// Metadata only: checking for external edits does not need the content
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    pub mtime: i64,
}

fn mtime_of(meta: Option<&fs::Metadata>) -> i64 {
    meta.and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

fn dir_entry_info(rel: &str, entry: fs::DirEntry) -> Option<DirEntryInfo> {
    let name = entry.file_name().to_string_lossy().to_string();
    if name == ".DS_Store" {
        return None;
    }
    // DirEntry::metadata does not follow symlinks, so linked directories remain leaf entries and
    // directory cycles cannot be expanded from the tree.
    let md = entry.metadata().ok();
    let is_symlink = md
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let hidden = md
        .as_ref()
        .map(|m| paths::is_hidden(&name, m))
        .unwrap_or(false);
    Some(DirEntryInfo {
        path: join_rel(rel, &name),
        name,
        is_dir,
        is_symlink,
        size: md.as_ref().map(|m| m.len()).unwrap_or(0),
        mtime: mtime_of(md.as_ref()),
        ignored: false,
        hidden,
    })
}

/// Metadata for commands that read file contents. Keep the workspace containment check first so
/// an escaping symlink still reports `path.outsideWorkspace`, then reject a symlink at the final
/// path component. Reads never follow links on the user's behalf.
fn readable_metadata(root: &Path, path: &Path) -> AppResult<fs::Metadata> {
    assert_inside(root, path)?;
    let meta = fs::symlink_metadata(path).map_err(|e| AppError::io(path, e))?;
    if meta.file_type().is_symlink() {
        return Err(AppError::c("fs.symlinkUnsupported"));
    }
    Ok(meta)
}

fn human_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= MB {
        format!("{:.1} MB", bytes as f64 / MB)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

fn looks_like_repo(root: &Path) -> bool {
    let mut probe = Some(root);
    let mut depth = 0;
    while let Some(dir) = probe {
        if dir.join(".git").exists() {
            return true;
        }
        probe = dir.parent();
        depth += 1;
        if depth > 8 {
            break;
        }
    }
    false
}

/// Batch-check which entries are .gitignore'd, reusing system git (`check-ignore --no-index`):
/// one subprocess per directory with VSCode semantics instead of a hand-rolled matcher.
fn ignored_set(root: &Path, rels: &[String]) -> HashSet<String> {
    use std::process::Stdio;

    if rels.is_empty() || !looks_like_repo(root) {
        return HashSet::new();
    }

    let mut child = match proc::command("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "--stdin", "-z", "--no-index"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return HashSet::new(),
    };

    if let Some(mut stdin) = child.stdin.take() {
        for rel in rels {
            let _ = stdin.write_all(rel.as_bytes());
            let _ = stdin.write_all(&[0]);
        }
    }

    let out = match child.wait_with_output() {
        Ok(out) => out,
        Err(_) => return HashSet::new(),
    };

    out.stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect()
}

#[tauri::command(async)]
pub fn open_folder(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    // One project per window: if another window already has (or is opening) this dir, switch to
    // it instead of opening a second copy. The frontend claims first; this is the last guard.
    if let Some(owner) = state.owner_window_of(Path::new(&path)) {
        if owner != window.label() {
            crate::focus_window(&app, &owner);
            return Err(AppError::c("workspace.openInOtherWindow"));
        }
    }
    let (canon, count, newly) = state.register_root(window.label(), Path::new(&path))?;
    // Pending claim becomes real: the project now has a real grant, no placeholder needed
    state.release_pending(window.label(), &canon);
    // The first window holding the directory starts the watcher; shared windows keep one
    if newly && count == 1 {
        if let Some(handle) = crate::watcher::start(app, canon.clone()) {
            state.watchers.lock().insert(canon.clone(), handle);
        }
    }
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canon.to_string_lossy().to_string());
    // Windows are told apart by title; macOS hiddenTitle does not affect Mission Control or the menu
    let _ = window.set_title(&format!("{name} — Tide"));
    Ok(WorkspaceInfo {
        is_git_repo: looks_like_repo(&canon),
        root: canon.to_string_lossy().to_string(),
        name,
    })
}

#[tauri::command(async)]
pub fn close_folder(window: tauri::Window, state: State<'_, AppState>, root: String) {
    // Last reference released: stop the watcher.
    // No canonicalize here: the watchers key is the path registered by open_folder
    if state.unregister_root(window.label(), &root) == RootRelease::Last {
        if let Some(handle) = state.watchers.lock().remove(&PathBuf::from(&root)) {
            handle.stop();
        }
    }
    // Reset the title once every project is closed, so it cannot show a closed project's name
    if !state.window_has_roots(window.label()) {
        let _ = window.set_title("Tide");
    }
}

#[tauri::command(async)]
pub fn read_dir(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    offset: usize,
    limit: usize,
) -> AppResult<DirPage> {
    let root_path = state.authorize(&root)?;
    let dir = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &dir)?;

    let meta = fs::metadata(&dir).map_err(|e| AppError::io(&dir, e))?;
    if !meta.is_dir() {
        return Err(AppError::p("fs.notADirectory", [("path", dir.display().to_string())]));
    }

    let mut dirs: Vec<DirEntryInfo> = Vec::new();
    let mut files: Vec<DirEntryInfo> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;

    for entry in fs::read_dir(&dir).map_err(|e| AppError::io(&dir, e))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        scanned += 1;
        if scanned > MAX_DIR_SCAN {
            truncated = true;
            break;
        }
        let Some(item) = dir_entry_info(&rel, entry) else {
            continue;
        };
        if item.is_dir {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }

    // Directories first, then case-insensitive lexicographic order (sorted here, free for the frontend)
    dirs.sort_by_key(|a| a.name.to_lowercase());
    files.sort_by_key(|a| a.name.to_lowercase());
    let total = dirs.len() + files.len();
    let mut all = dirs;
    all.extend(files);

    // Only gitignore-check the current page, so thousands of entries cost nothing
    let take = limit.clamp(1, MAX_PAGE);
    let mut page: Vec<DirEntryInfo> = all.into_iter().skip(offset).take(take).collect();
    let has_more = offset + page.len() < total;
    if !page.is_empty() {
        let paths: Vec<String> = page.iter().map(|e| e.path.clone()).collect();
        let ignored = ignored_set(&root_path, &paths);
        if !ignored.is_empty() {
            for item in page.iter_mut() {
                item.ignored = ignored.contains(&item.path);
            }
        }
    }

    Ok(DirPage {
        entries: page,
        total,
        has_more,
        truncated,
    })
}

/// Collapse single-child folder chains: starting at `rel`, keep descending while a directory holds
/// exactly one visible entry and that entry is a directory. Returns the deepest rel of the chain
/// (the start dir itself when it already branches).
///
/// Done in one IPC round-trip on purpose: probing level by level from the frontend would run a
/// `git check-ignore` subprocess per level through `read_dir`, which this only needs names for.
#[tauri::command(async)]
pub fn resolve_dir_chain(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    show_hidden: bool,
    max_depth: usize,
) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let mut current = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &current)?;
    let mut deepest = rel;

    // Depth cap: a pathological chain (10k nested dirs) must not stall the tree
    let mut depth = 0;
    while depth < max_depth {
        depth += 1;
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => break,
        };

        let mut only: Option<(String, bool)> = None;
        let mut count = 0usize;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Must mirror exactly what the tree lists, .DS_Store aside: hidden means a dot prefix, since a
            // Windows attribute-hidden file is still drawn (merging a folder while hiding one of its entries
            // would make that entry unreachable)
            if name == ".DS_Store" {
                continue;
            }
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            // DirEntry::metadata does not follow symlinks, so a linked dir is not a descent target
            let md = match entry.metadata() {
                Ok(md) => md,
                Err(_) => continue,
            };
            count += 1;
            if count > 1 {
                break;
            }
            only = Some((name, md.is_dir()));
        }

        // Exactly one visible entry and it is a folder: descend one level
        let Some((name, is_dir)) = only else { break };
        if count != 1 || !is_dir {
            break;
        }
        let next = join_rel(&deepest, &name);
        let path = match resolve_in_root(&root_path, &next) {
            Ok(path) => path,
            Err(_) => break,
        };
        if assert_inside(&root_path, &path).is_err() {
            break;
        }
        current = path;
        deepest = next;
    }

    Ok(deepest)
}

/// Lightweight stat: compare mtime / size first and skip reading when unchanged
#[tauri::command(async)]
pub fn stat_file(state: State<'_, AppState>, root: String, rel: String) -> AppResult<FileStat> {
    let root_path = state.authorize(&root)?;
    let path = resolve_in_root(&root_path, &rel)?;
    let meta = readable_metadata(&root_path, &path)?;
    Ok(FileStat {
        size: meta.len(),
        mtime: mtime_of(Some(&meta)),
    })
}

#[tauri::command(async)]
pub fn read_text_file(state: State<'_, AppState>, root: String, rel: String) -> AppResult<FilePayload> {
    let root_path = state.authorize(&root)?;
    let path = resolve_in_root(&root_path, &rel)?;
    let meta = readable_metadata(&root_path, &path)?;
    if meta.is_dir() {
        return Err(AppError::p("fs.folderAsText", [("path", path.display().to_string())]));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(AppError::p(
            "fs.tooLarge",
            [("size", human_size(meta.len())), ("limit", "20MB".to_string())],
        ));
    }

    let bytes = fs::read(&path).map_err(|e| AppError::io(&path, e))?;
    let binary = bytes.iter().take(8192).any(|b| *b == 0);
    let content = if binary {
        String::new()
    } else {
        // Prefer the zero-copy UTF-8 path; only fall back to lossy conversion on invalid encoding
        let mut text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
        };
        if text.starts_with('\u{feff}') {
            text.replace_range(0..'\u{feff}'.len_utf8(), "");
        }
        text
    };

    Ok(FilePayload {
        content,
        size: meta.len(),
        mtime: mtime_of(Some(&meta)),
        binary,
    })
}

/// Raw image bytes for the frontend preview. Uses binary IPC (`tauri::ipc::Response`), not base64,
/// saving a third of the payload; the frontend picks the mime by extension and shows a blob URL.
#[tauri::command(async)]
pub fn read_image_file(
    state: State<'_, AppState>,
    root: String,
    rel: String,
) -> AppResult<tauri::ipc::Response> {
    let root_path = state.authorize(&root)?;
    let path = resolve_in_root(&root_path, &rel)?;
    let meta = readable_metadata(&root_path, &path)?;

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(AppError::p("fs.unsupportedImage", [("ext", ext.clone())]));
    }

    if meta.is_dir() {
        return Err(AppError::p("fs.folderAsImage", [("path", path.display().to_string())]));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(AppError::p(
            "fs.imageTooLarge",
            [("size", human_size(meta.len())), ("limit", "32MB".to_string())],
        ));
    }

    Ok(tauri::ipc::Response::new(
        fs::read(&path).map_err(|e| AppError::io(&path, e))?,
    ))
}

#[tauri::command(async)]
pub fn write_text_file(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    content: String,
) -> AppResult<SavedFile> {
    let root_path = state.authorize(&root)?;
    let path = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &path)?;

    if path.exists() && fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
        return Err(AppError::c("fs.targetIsFolder"));
    }
    if path.parent().is_none() {
        return Err(AppError::c("fs.targetInvalid"));
    }

    // Atomic write: temp file + rename, so a mid-write crash cannot corrupt the source
    paths::write_atomic(&path, content.as_bytes()).map_err(|e| AppError::io(&path, e))?;

    let meta = fs::metadata(&path).map_err(|e| AppError::io(&path, e))?;
    Ok(SavedFile {
        size: meta.len(),
        mtime: mtime_of(Some(&meta)),
    })
}

#[tauri::command(async)]
pub fn create_entry(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    kind: String,
) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    if rel.is_empty() {
        return Err(AppError::c("fs.missingName"));
    }
    validate_rel_name(&rel)?;
    let path = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &path)?;
    if path.exists() {
        return Err(AppError::c("fs.alreadyExists"));
    }
    if kind == "dir" {
        fs::create_dir_all(&path)?;
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn rename_entry(
    state: State<'_, AppState>,
    root: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    if from.is_empty() || to.is_empty() {
        return Err(AppError::c("path.empty"));
    }
    validate_rel_name(&to)?;
    let src = resolve_in_root(&root_path, &from)?;
    let dst = resolve_in_root(&root_path, &to)?;
    assert_inside(&root_path, &src)?;
    assert_inside(&root_path, &dst)?;
    if !src.exists() {
        return Err(AppError::p("fs.sourceMissing", [("path", src.display().to_string())]));
    }
    if dst.exists() {
        return Err(AppError::p("fs.targetExists", [("path", dst.display().to_string())]));
    }
    // rename can fail transiently on Windows when the file is held (antivirus / indexer); retry
    paths::rename_retry(&src, &dst).map_err(|e| AppError::io(&dst, e))?;
    Ok(())
}

#[tauri::command(async)]
pub fn delete_entry(state: State<'_, AppState>, root: String, rel: String) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    if rel.is_empty() {
        return Err(AppError::c("fs.cannotDeleteRoot"));
    }
    let path = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &path)?;
    // Use symlink_metadata to delete the link itself, not its target
    let meta = fs::symlink_metadata(&path).map_err(|e| AppError::io(&path, e))?;
    if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| AppError::io(&path, e))?;
    } else {
        fs::remove_file(&path).map_err(|e| AppError::io(&path, e))?;
    }
    Ok(())
}

/// Index from `git ls-files`: respects .gitignore and scans large repos in tens of ms.
/// Only tracked plus non-ignored untracked files, so build artifacts never eat the quota.
fn git_index(root: &Path, cap: usize) -> Option<(Vec<FileHit>, bool)> {
    use std::process::Stdio;

    let out = proc::command("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }

    let mut files: Vec<FileHit> = out
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| FileHit {
            path: String::from_utf8_lossy(s).to_string(),
        })
        .collect();
    // Submodules / repos over the cap: truncate before sorting so results stay stable
    let truncated = files.len() > cap;
    if truncated {
        files.truncate(cap);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Some((files, truncated))
}

/// Fallback index: walk by .gitignore rules for non-git repos, skipping heavy directories.
fn walk_index(root: &Path, cap: usize) -> (Vec<FileHit>, bool) {
    let mut out: Vec<FileHit> = Vec::with_capacity(256);
    let mut stack: Vec<(std::path::PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    let mut truncated = false;

    while let Some((dir, rel, depth)) = stack.pop() {
        if out.len() >= cap {
            truncated = true;
            break;
        }
        if depth > MAX_INDEX_DEPTH {
            continue;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if out.len() >= cap {
                truncated = true;
                break;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".DS_Store" {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                stack.push((entry.path(), join_rel(&rel, &name), depth + 1));
            } else {
                out.push(FileHit {
                    path: join_rel(&rel, &name),
                });
            }
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    (out, truncated)
}

/// Lightweight index for quick open. git first (fast, respects .gitignore), else a directory walk.
/// Returns relative path strings only; the frontend derives names on demand to save memory.
#[tauri::command(async)]
pub fn list_files(state: State<'_, AppState>, root: String, limit: usize) -> AppResult<FileIndex> {
    let root_path = state.authorize(&root)?;
    let cap = limit.clamp(1, MAX_INDEX_FILES);

    let (files, truncated) = if looks_like_repo(&root_path) {
        git_index(&root_path, cap).unwrap_or_else(|| walk_index(&root_path, cap))
    } else {
        walk_index(&root_path, cap)
    };

    Ok(FileIndex { files, truncated })
}

/// Metadata only, used to tell whether a dropped item is a file or a folder
#[tauri::command(async)]
pub fn path_info(path: String) -> AppResult<PathInfo> {
    let p = Path::new(&path);
    let meta = fs::metadata(p)?;
    Ok(PathInfo {
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

/// Turn startup args into "workspace roots to open + file to open".
///
/// Only resolves candidate paths: authorization + watcher registration happen when the window
/// calls open_folder, otherwise the same directory is registered twice and the watcher never starts.
pub fn parse_start_args(args: impl Iterator<Item = String>) -> StartTarget {
    let mut roots: Vec<String> = Vec::new();
    let mut file: Option<String> = None;

    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let path = std::path::PathBuf::from(&arg);
        if path.is_dir() {
            if let Ok(canon) = paths::canon(&path) {
                roots.push(canon.to_string_lossy().to_string());
            }
        } else if path.is_file() {
            let parent = match path.parent() {
                Some(parent) => parent.to_path_buf(),
                None => continue,
            };
            if let Ok(canon) = paths::canon(&parent) {
                roots.push(canon.to_string_lossy().to_string());
                file = path.file_name().map(|n| n.to_string_lossy().to_string());
            }
        }
    }

    StartTarget { roots, file }
}

/// Open from CLI / file manager: `tide <dir or file>...` (several allowed, giving multi-root)
#[tauri::command(async)]
pub fn start_target(_state: State<'_, AppState>) -> AppResult<StartTarget> {
    Ok(parse_start_args(std::env::args().skip(1)))
}

/// Name validation for create / rename: reject Windows invalid chars and reserved device names
/// up front, otherwise the syscall returns an opaque IO error.
fn validate_rel_name(rel: &str) -> AppResult<()> {
    for segment in rel.split('/') {
        if let Some(reason) = paths::invalid_name_reason(segment) {
            return Err(AppError::p(
                "fs.invalidName",
                [
                    ("name", segment.to_string()),
                    ("reason", reason.to_string()),
                ],
            ));
        }
    }
    Ok(())
}

/// Reveal a path in the system file manager.
/// The three platforms differ a lot, and Windows explorer returns non-zero even on success,
/// so whether to check the exit status is per platform too.
#[cfg(target_os = "macos")]
fn open_in_file_manager(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = proc::command("open");
    cmd.arg("-R").arg(path);
    cmd.status()
}

#[cfg(windows)]
fn open_in_file_manager(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = proc::command("explorer");
    // `/select,` must be joined with the path in one argument
    cmd.arg(format!("/select,{}", path.display()));
    cmd.status()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    let dir = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let mut cmd = proc::command("xdg-open");
    cmd.arg(dir);
    cmd.status()
}

/// explorer.exe returns non-zero even on success, so exit status cannot mean failure on Windows
const REVEAL_CHECKS_STATUS: bool = !cfg!(windows);

#[tauri::command(async)]
pub fn reveal_in_finder(state: State<'_, AppState>, root: String, rel: String) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    // empty rel = reveal the workspace root itself
    let path = if rel.is_empty() {
        root_path
    } else {
        let path = resolve_in_root(&root_path, &rel)?;
        assert_inside(&root_path, &path)?;
        path
    };
    let status = open_in_file_manager(&path)
        .map_err(|e| AppError::p("fs.revealFailed", [("error", e.to_string())]))?;
    if REVEAL_CHECKS_STATUS && !status.success() {
        return Err(AppError::c("fs.revealStatus"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{dir_entry_info, readable_metadata};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        root: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let ordinal = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tide-fs-symlink-{}-{timestamp}-{ordinal}",
                std::process::id(),
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self {
                root: crate::paths::canon(&root).unwrap(),
            }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn regular_files_and_directories_pass_the_read_guard() {
        let dir = TestDir::new();
        let file = dir.root.join("file.txt");
        let folder = dir.root.join("folder");
        std::fs::write(&file, "text").unwrap();
        std::fs::create_dir(&folder).unwrap();

        assert!(readable_metadata(&dir.root, &file).unwrap().is_file());
        assert!(readable_metadata(&dir.root, &folder).unwrap().is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_leaf_entries_and_fail_the_read_guard() {
        use std::os::unix::fs::symlink;

        let dir = TestDir::new();
        let outside = TestDir::new();
        std::fs::write(dir.root.join("target.txt"), "target").unwrap();
        std::fs::create_dir(dir.root.join("target-dir")).unwrap();
        std::fs::write(outside.root.join("secret.txt"), "secret").unwrap();
        symlink("target.txt", dir.root.join("file-link")).unwrap();
        symlink("target-dir", dir.root.join("dir-link")).unwrap();
        symlink("missing", dir.root.join("dangling-link")).unwrap();
        symlink(outside.root.join("secret.txt"), dir.root.join("escape-link")).unwrap();

        let entries: Vec<_> = std::fs::read_dir(&dir.root)
            .unwrap()
            .map(|entry| dir_entry_info("", entry.unwrap()).unwrap())
            .collect();
        let entry = |name: &str| entries.iter().find(|entry| entry.name == name).unwrap();

        assert!(!entry("target.txt").is_symlink);
        assert!(!entry("target.txt").is_dir);
        assert!(!entry("target-dir").is_symlink);
        assert!(entry("target-dir").is_dir);
        for name in ["file-link", "dir-link", "dangling-link", "escape-link"] {
            assert!(entry(name).is_symlink, "{name} should be marked as a symlink");
            assert!(!entry(name).is_dir, "{name} should remain a leaf entry");
        }

        for name in ["file-link", "dir-link", "dangling-link"] {
            let error = readable_metadata(&dir.root, &dir.root.join(name)).unwrap_err();
            assert_eq!(error.code, "fs.symlinkUnsupported");
        }

        // Workspace containment stays the first security boundary, even for symlinks.
        let error = readable_metadata(&dir.root, &dir.root.join("escape-link")).unwrap_err();
        assert_eq!(error.code, "path.outsideWorkspace");
    }
}
