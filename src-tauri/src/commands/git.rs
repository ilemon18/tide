use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::proc;
use crate::state::AppState;

/// Timeout for network operations (pull / push)
const NET_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// Single-char status: M A D R C T U
    pub status: String,
}

/// Git operation in progress (merge / cherry-pick / revert / rebase)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    /// merge | cherry-pick | revert | rebase | am; the frontend maps it to a localized label
    pub kind: String,
    pub can_skip: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub head: String,
    pub ahead: i32,
    pub behind: i32,
    pub staged: Vec<GitFile>,
    pub changes: Vec<GitFile>,
    pub untracked: Vec<GitFile>,
    /// Unmerged (conflicted) files; status is porcelain v2 two-letter XY: UU/AA/DU/UD/AU/UA/DD
    pub conflicts: Vec<GitFile>,
    pub operation: Option<GitOperation>,
    /// Commit message waiting for the in-progress operation (from MERGE_MSG / rebase message)
    pub pending_message: String,
    pub error: Option<String>,
}

impl GitStatus {
    /// Empty state on failure: is_repo comes from the caller (a repo whose status failed is still
    /// a repo, otherwise the frontend would treat a transient failure as "not in a git repo")
    fn empty(is_repo: bool, message: Option<String>) -> Self {
        Self {
            is_repo,
            branch: String::new(),
            head: String::new(),
            ahead: 0,
            behind: 0,
            staged: Vec::new(),
            changes: Vec::new(),
            untracked: Vec::new(),
            conflicts: Vec::new(),
            operation: None,
            pending_message: String::new(),
            error: message,
        }
    }
}

/// Single git invocation wrapper: `GIT_TERMINAL_PROMPT=0` blocks interactive credential prompts
/// (otherwise commands hang), and `GIT_OPTIONAL_LOCKS=0` keeps status from taking index.lock so it
/// coexists with the IDE's own refresh.
fn git_cmd(root: &str) -> Command {
    let mut cmd = proc::command("git");
    cmd.arg("-C").arg(root);
    // git must never open an editor: --continue / commit would hang on it
    cmd.args(["-c", "core.editor=true"]);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_EDITOR", "true");
    cmd.env("GIT_SEQUENCE_EDITOR", "true");
    cmd.env("GIT_MERGE_AUTOEDIT", "no");
    cmd.env("LC_ALL", "C");
    cmd.env("GIT_PAGER", "cat");
    cmd.stdin(Stdio::null());
    cmd
}

fn spawn_error(e: std::io::Error) -> AppError {
    AppError::p("git.spawnFailed", [("error", e.to_string())])
}

fn run_bytes(root: &str, args: &[&str]) -> AppResult<(bool, Vec<u8>, String)> {
    let out = git_cmd(root).args(args).output().map_err(spawn_error)?;
    Ok((
        out.status.success(),
        out.stdout,
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

fn run_text(root: &str, args: &[&str]) -> AppResult<(bool, String)> {
    let (ok, stdout, stderr) = run_bytes(root, args)?;
    let mut text = String::from_utf8_lossy(&stdout).to_string();
    if !ok {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    Ok((ok, text))
}

/// Variant with a timeout, for pull / push which may block on the network
fn run_with_timeout(root: &str, args: &[&str], timeout: Duration) -> AppResult<(bool, String)> {
    let mut child = git_cmd(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(AppError::from)? {
            Some(_) => break,
            None => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::c("git.timeout"));
                }
                std::thread::sleep(Duration::from_millis(60));
            }
        }
    }

    let out = child.wait_with_output().map_err(AppError::from)?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&err);
        }
    }
    Ok((out.status.success(), text))
}

/// Repo top-level directory + the real git dir: for worktree / submodule the gitdir is not under
/// `<top>/.git`, and state files like MERGE_MSG / CHERRY_PICK_HEAD live in the gitdir. One rev-parse
/// gets both.
struct RepoPaths {
    toplevel: String,
    gitdir: std::path::PathBuf,
}

fn repo_paths(root: &str) -> Option<RepoPaths> {
    let (ok, stdout, _) = run_bytes(root, &["rev-parse", "--show-toplevel", "--absolute-git-dir"]).ok()?;
    if !ok {
        return None;
    }
    let text = String::from_utf8_lossy(&stdout);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let toplevel = lines.next()?.to_string();
    let gitdir = lines
        .next()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(&toplevel).join(".git"));
    Some(RepoPaths { toplevel, gitdir })
}


/// Operation in progress. rebase first: its intermediate state can also leave CHERRY_PICK_HEAD.
fn detect_operation(gitdir: &Path) -> Option<GitOperation> {
    let op = |kind: &str, can_skip: bool| {
        Some(GitOperation {
            kind: kind.to_string(),
            can_skip,
        })
    };
    if gitdir.join("rebase-merge").is_dir() {
        return op("rebase", true);
    }
    if gitdir.join("rebase-apply").is_dir() {
        // git am and rebase share one state directory; the applying marker tells them apart
        return if gitdir.join("rebase-apply/applying").is_file() {
            op("am", true)
        } else {
            op("rebase", true)
        };
    }
    if gitdir.join("CHERRY_PICK_HEAD").is_file() {
        return op("cherry-pick", true);
    }
    if gitdir.join("REVERT_HEAD").is_file() {
        return op("revert", true);
    }
    if gitdir.join("MERGE_HEAD").is_file() {
        return op("merge", false);
    }
    None
}

/// Read the operation's own commit message and drop the `# Conflicts:` comment lines git adds
fn read_pending_message(gitdir: &Path, kind: &str) -> String {
    let candidates: Vec<std::path::PathBuf> = match kind {
        "rebase" => vec![
            gitdir.join("rebase-merge/message"),
            gitdir.join("MERGE_MSG"),
            gitdir.join("rebase-apply/msg"),
            gitdir.join("rebase-apply/final-commit"),
        ],
        // In sequencer mode (cherry-pick / revert queue) the message may land here too
        _ => vec![
            gitdir.join("MERGE_MSG"),
            gitdir.join("sequencer/MERGE_MSG"),
            gitdir.join("SQUASH_MSG"),
        ],
    };
    for path in candidates {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let cleaned = text
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n");
        let trimmed = cleaned.trim_end().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    String::new()
}

/// Before `--continue`, write the message the user edited back into git's own message file.
/// A failure here does not affect the operation (git still continues with the original message).
fn write_pending_message(gitdir: &Path, kind: &str, message: &str) {
    let path = if kind == "rebase" && gitdir.join("rebase-merge").is_dir() {
        gitdir.join("rebase-merge/message")
    } else if kind == "rebase" && gitdir.join("rebase-apply").is_dir() {
        gitdir.join("rebase-apply/msg")
    } else {
        gitdir.join("MERGE_MSG")
    };
    let mut text = message.trim_end().to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let _ = std::fs::write(path, text);
}

/// Convert a repo-relative path to a workspace-relative one; when the workspace is only a
/// subdirectory of the repo, only files inside it are shown. git always emits `/`, so on Windows
/// only the case may differ from the prefix; compare case-insensitively.
fn to_workspace_rel(path: &str, prefix: &str) -> Option<String> {
    if prefix.is_empty() {
        return Some(path.to_string());
    }
    if path.len() < prefix.len() {
        return None;
    }
    let (head, rest) = path.split_at(prefix.len());
    let same = if cfg!(windows) {
        head.eq_ignore_ascii_case(prefix)
    } else {
        head == prefix
    };
    same.then(|| rest.to_string())
}

fn push_pair(
    staged: &mut Vec<GitFile>,
    changes: &mut Vec<GitFile>,
    xy: &str,
    path: &str,
    prefix: &str,
) {
    let Some(rel) = to_workspace_rel(path, prefix) else {
        return;
    };
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if x != '.' && x != ' ' {
        staged.push(GitFile {
            path: rel.clone(),
            status: x.to_string(),
        });
    }
    if y != '.' && y != ' ' {
        changes.push(GitFile {
            path: rel,
            status: y.to_string(),
        });
    }
}

#[tauri::command(async)]
pub fn git_status(state: State<'_, AppState>, root: String) -> AppResult<GitStatus> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();

    let Some(paths) = repo_paths(&root_str) else {
        return Ok(GitStatus::empty(false, None));
    };
    let toplevel = paths.toplevel.clone();

    let prefix = match paths::canon(Path::new(&toplevel)) {
        Ok(repo_canon) if repo_canon != root_path => paths::rel_in(&repo_canon, &root_path)
            .map(|s| {
                if s.is_empty() {
                    String::new()
                } else {
                    format!("{s}/")
                }
            })
            .unwrap_or_default(),
        _ => String::new(),
    };

    let (ok, stdout, stderr) = run_bytes(
        &root_str,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            // -uall: list untracked directories file by file. The default normal collapses a whole
            // new directory into `? src/new/`, which looks like tracking a folder and opens no diff
            // (same as VSCode).
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;

    if !ok {
        return Ok(GitStatus::empty(true, if stderr.trim().is_empty() {
            None
        } else {
            Some(stderr.trim().to_string())
        }));
    }

    // Operation state needs only a few tiny files; not worth another git process
    let operation = detect_operation(&paths.gitdir);
    let pending_message = operation
        .as_ref()
        .map(|op| read_pending_message(&paths.gitdir, &op.kind))
        .unwrap_or_default();

    let mut status = GitStatus {
        is_repo: true,
        branch: String::new(),
        head: String::new(),
        ahead: 0,
        behind: 0,
        staged: Vec::new(),
        changes: Vec::new(),
        untracked: Vec::new(),
        conflicts: Vec::new(),
        operation,
        pending_message,
        error: None,
    };

    let records: Vec<&[u8]> = stdout.split(|b| *b == 0).collect();
    let mut i = 0usize;
    while i < records.len() {
        let raw = records[i];
        i += 1;
        if raw.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(raw).to_string();

        if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = rest.to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            status.head = if rest == "(initial)" { String::new() } else { rest.to_string() };
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(v) = part.strip_prefix('+') {
                    status.ahead = v.parse().unwrap_or(0);
                } else if let Some(v) = part.strip_prefix('-') {
                    status.behind = v.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if line.starts_with("# ") {
            continue;
        }

        if line.starts_with("1 ") {
            let mut it = line.splitn(9, ' ');
            it.next();
            let xy = it.next().unwrap_or("..").to_string();
            for _ in 0..6 {
                it.next();
            }
            if let Some(path) = it.next() {
                push_pair(&mut status.staged, &mut status.changes, &xy, path, &prefix);
            }
            continue;
        }

        if line.starts_with("2 ") {
            let mut it = line.splitn(10, ' ');
            it.next();
            let xy = it.next().unwrap_or("..").to_string();
            for _ in 0..6 {
                it.next();
            }
            it.next(); // rename/copy similarity score
            if let Some(path) = it.next() {
                push_pair(&mut status.staged, &mut status.changes, &xy, path, &prefix);
            }
            // In -z mode the original path is its own record, so skip it
            i += 1;
            continue;
        }

        if line.starts_with("u ") {
            let mut it = line.splitn(11, ' ');
            it.next();
            // Keep both XY letters (UU / AA / DU / ...) so the UI can tell conflict types apart
            let xy = it.next().unwrap_or("UU").to_string();
            for _ in 0..8 {
                it.next();
            }
            if let Some(path) = it.next() {
                if let Some(rel) = to_workspace_rel(path, &prefix) {
                    // Conflicted files get their own group: mixing them into changes would let
                    // "stage all" mark a file still holding <<<<<<< as resolved
                    status.conflicts.push(GitFile { path: rel, status: xy });
                }
            }
            continue;
        }

        if let Some(path) = line.strip_prefix("? ") {
            // Untracked nested repos are still reported as directories (trailing slash); strip it
            if let Some(rel) = to_workspace_rel(path.trim_end_matches('/'), &prefix) {
                status.untracked.push(GitFile {
                    path: rel,
                    status: "?".to_string(),
                });
            }
            continue;
        }
    }

    if status.branch.is_empty() {
        status.branch = "(detached)".to_string();
    }
    status.staged.sort_by(|a, b| a.path.cmp(&b.path));
    status.changes.sort_by(|a, b| a.path.cmp(&b.path));
    status.untracked.sort_by(|a, b| a.path.cmp(&b.path));
    status.conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(status)
}

#[tauri::command(async)]
pub fn git_diff(state: State<'_, AppState>, root: String, rel: String, staged: bool) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let rel_owned = rel.clone();

    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&rel_owned);

    let (_, stdout, stderr) = run_bytes(&root_str, &args)?;
    let text = String::from_utf8_lossy(&stdout).to_string();
    if !text.trim().is_empty() {
        return Ok(text);
    }

    // Same as above: a tracked file with no changes, or no staged change for the file, must not
    // be treated as a whole-file addition
    if staged || is_tracked(&root_str, &rel_owned)? {
        if !stderr.trim().is_empty() {
            return Err(AppError::new(stderr.trim().to_string()));
        }
        // Empty patch: the diff view renders its own localized "no changes" state
        return Ok(String::new());
    }

    // Untracked file: diff against /dev/null, which equals "whole file added"
    let (_, raw, _) = run_bytes(
        &root_str,
        &["diff", "--no-color", "--no-index", "--", "/dev/null", &rel_owned],
    )?;
    let fallback = String::from_utf8_lossy(&raw).to_string();
    if fallback.trim().is_empty() {
        if !stderr.trim().is_empty() {
            return Err(AppError::new(stderr.trim().to_string()));
        }
        return Ok(String::new());
    }
    Ok(fallback)
}

/// Full patch for the side-by-side view: context large enough to equal the whole file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFull {
    pub patch: String,
    pub binary: bool,
    /// Patch too large, fell back to -U3: the frontend can only show hunks, not the whole file
    pub truncated: bool,
}

/// Above this byte count, stop rendering the whole file and fall back to a 3-line-context patch
const MAX_FULL_DIFF_BYTES: usize = 4 * 1024 * 1024;

/// Whether the file is already in the index (= tracked by git).
///
/// This is the only way to tell "untracked": `git diff` outputs nothing both for a tracked file
/// with no changes and for a new untracked file, and the difference shows up only here.
fn is_tracked(root: &str, rel: &str) -> AppResult<bool> {
    let (ok, _, _) = run_bytes(root, &["ls-files", "--error-unmatch", "--", rel])?;
    Ok(ok)
}

fn diff_args<'a>(context: &'a str, staged: bool) -> Vec<&'a str> {
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", context];
    if staged {
        args.push("--cached");
    }
    args
}

#[tauri::command(async)]
pub fn git_diff_full(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    staged: bool,
) -> AppResult<GitDiffFull> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let rel_owned = rel.clone();

    let collect = |context: &str| -> AppResult<String> {
        let mut args = diff_args(context, staged);
        args.push("--");
        args.push(&rel_owned);
        let (_, stdout, stderr) = run_bytes(&root_str, &args)?;
        let text = String::from_utf8_lossy(&stdout).to_string();
        if !text.trim().is_empty() {
            return Ok(text);
        }

        // Empty diff != whole file added: an unchanged tracked file also gives an empty `git diff`,
        // so diffing /dev/null again would treat the whole file as added (a full-height green bar).
        // Only untracked files take the fallback.
        if staged || is_tracked(&root_str, &rel_owned)? {
            if !stderr.trim().is_empty() {
                return Err(AppError::new(stderr.trim().to_string()));
            }
            return Ok(String::new());
        }

        // Untracked file: diff against /dev/null, which equals "whole file added"
        let args = ["diff", "--no-color", "--no-index", context, "--", "/dev/null", &rel_owned];
        let (_, raw, _) = run_bytes(&root_str, &args)?;
        let fallback = String::from_utf8_lossy(&raw).to_string();
        if fallback.trim().is_empty() {
            if !stderr.trim().is_empty() {
                return Err(AppError::new(stderr.trim().to_string()));
            }
            return Ok(String::new());
        }
        Ok(fallback)
    };

    let mut patch = collect("-U100000")?;
    let mut truncated = false;
    if patch.len() > MAX_FULL_DIFF_BYTES {
        patch = collect("-U3")?;
        truncated = true;
    }
    let binary = patch.as_bytes().iter().take(8192).any(|b| *b == 0)
        || patch.lines().any(|line| line.starts_with("Binary files"));
    Ok(GitDiffFull { patch, binary, truncated })
}

#[tauri::command(async)]
pub fn git_stage(state: State<'_, AppState>, root: String, paths: Vec<String>) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["add".into(), "-A".into(), "--".into()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (ok, text) = run_text(&root_str, &refs)?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_unstage(state: State<'_, AppState>, root: String, paths: Vec<String>) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
    args.extend(paths.clone());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (ok, text) = run_text(&root_str, &refs)?;
    if ok {
        return Ok(());
    }
    // No HEAD before the first commit; fall back to removing from the index
    let mut fallback: Vec<String> = vec!["rm".into(), "--cached".into(), "-r".into(), "-q".into(), "--".into()];
    fallback.extend(paths);
    let frefs: Vec<&str> = fallback.iter().map(|s| s.as_str()).collect();
    let (ok2, text2) = run_text(&root_str, &frefs)?;
    if !ok2 {
        return Err(AppError::new(format!("{}\n{}", text.trim(), text2.trim())));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_discard(state: State<'_, AppState>, root: String, paths: Vec<String>) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    if paths.is_empty() {
        return Ok(());
    }

    // `git restore` fails on conflicted files; the old code swallowed the error while the UI
    // reported "discarded"
    let mut check: Vec<&str> = vec!["ls-files", "-u", "-z", "--"];
    check.extend(paths.iter().map(|p| p.as_str()));
    let (_, unmerged, _) = run_bytes(&root_str, &check)?;
    if !unmerged.is_empty() {
        return Err(AppError::c("git.conflictCannotDiscard"));
    }

    let mut args: Vec<String> = vec![
        "restore".into(),
        "--worktree".into(),
        "--source=HEAD".into(),
        "--".into(),
    ];
    args.extend(paths.clone());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let _ = run_text(&root_str, &refs);

    // Untracked files are deleted outright (this dangerous operation was already confirmed)
    for rel in paths {
        let tracked = run_text(&root_str, &["ls-files", "--error-unmatch", "--", &rel]);
        let is_tracked = matches!(tracked, Ok((true, _)));
        if !is_tracked {
            let abs = crate::state::resolve_in_root(&root_path, &rel)?;
            crate::state::assert_inside(&root_path, &abs)?;
            if abs.is_file() {
                std::fs::remove_file(&abs)?;
            }
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_commit(state: State<'_, AppState>, root: String, message: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    if message.trim().is_empty() {
        return Err(AppError::c("git.emptyMessage"));
    }

    // git_cmd() sends stdin to /dev/null by default, but commit -F - reads the message from stdin:
    // this must be a pipe, otherwise git sees EOF and wrongly reports "empty commit message".
    let mut child = git_cmd(&root_str)
        .args(["commit", "-F", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;

    {
        // After take() the pipe closes at the end of this scope, so git sees EOF and commits
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::c("git.messagePipe"))?;
        let mut text = message.trim_end().to_string();
        if !text.ends_with('\n') {
            text.push('\n');
        }
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| AppError::p("git.messageWriteFailed", [("error", e.to_string())]))?;
        stdin.flush().map_err(AppError::from)?;
    }

    let out = child.wait_with_output().map_err(AppError::from)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(friendly_commit_error(msg.trim()));
    }
    Ok(stdout.trim().to_string())
}

/// git's own English hints do not help users much, so the known ones become actionable errors.
/// The real cause (message never reaching git) was fixed in git_commit; this is just a fallback.
fn friendly_commit_error(raw: &str) -> AppError {
    if raw.contains("Aborting commit due to empty commit message") {
        return AppError::c("git.emptyCommitMessage");
    }
    if raw.contains("nothing to commit") || raw.contains("no changes added to commit") {
        return AppError::c("git.nothingStaged");
    }
    // Anything else is git's own output: show it as-is, no translation
    AppError::new(raw)
}

/// Undo the last commit: changes stay staged, and the full message of the undone commit is
/// returned so the frontend can refill the commit box. For the only commit, delete the branch ref
/// (back to unborn) and leave index and worktree untouched.
#[tauri::command(async)]
pub fn git_undo_commit(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();

    // No history rewriting while merge / rebase etc. is running; let the user finish it first
    match repo_paths(&root_str) {
        Some(paths) => {
            if let Some(op) = detect_operation(&paths.gitdir) {
                // One code per operation so each language can phrase it naturally
                let code = match op.kind.as_str() {
                    "rebase" => "git.rebaseInProgress",
                    "am" => "git.amInProgress",
                    "cherry-pick" => "git.cherryPickInProgress",
                    "revert" => "git.revertInProgress",
                    _ => "git.mergeInProgress",
                };
                return Err(AppError::c(code));
            }
            // Batch revert / cherry-pick have no CHERRY_PICK_HEAD, only the sequencer directory
            if paths.gitdir.join("sequencer").is_dir() {
                return Err(AppError::c("git.sequencerRunning"));
            }
        }
        None => return Err(AppError::c("git.notRepo")),
    }

    // HEAD must exist
    let (head_ok, _) = run_text(&root_str, &["rev-parse", "--verify", "HEAD"])?;
    if !head_ok {
        return Err(AppError::c("git.noCommitToUndo"));
    }

    // Read the message first: after reset only the reflog is left
    let (msg_ok, message) = run_text(&root_str, &["log", "-1", "--format=%B"])?;
    let message = if msg_ok { message.trim().to_string() } else { String::new() };

    let (parent_ok, _) = run_text(&root_str, &["rev-parse", "--verify", "HEAD~1"])?;
    let (ok, text) = if parent_ok {
        // soft: index and worktree untouched, so the user can commit again right away
        run_text(&root_str, &["reset", "--soft", "HEAD~1"])?
    } else {
        // The only commit: delete the branch ref back to unborn, index and worktree untouched
        // (files stay staged). A detached HEAD has no ref to delete, so reject it explicitly.
        let (on_branch, _) = run_text(&root_str, &["symbolic-ref", "--quiet", "HEAD"])?;
        if !on_branch {
            return Err(AppError::c("git.detachedUndo"));
        }
        run_text(&root_str, &["update-ref", "-d", "HEAD"])?
    };
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(message)
}

#[tauri::command(async)]
pub fn git_pull(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let (ok, text) = run_with_timeout(&root_str, &["pull", "--ff-only"], NET_TIMEOUT)?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

#[tauri::command(async)]
pub fn git_push(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let (ok, text) = run_with_timeout(&root_str, &["push"], NET_TIMEOUT)?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}
/// Sync remote branches only: no merge, no push, just update remote-tracking refs
#[tauri::command(async)]
pub fn git_fetch(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    // No point running fetch without a remote; give a clear message instead
    let (remote_ok, remotes) = run_text(&root_str, &["remote"])?;
    if !remote_ok || remotes.trim().is_empty() {
        return Err(AppError::c("git.noRemote"));
    }
    let (ok, text) = run_with_timeout(&root_str, &["fetch", "--all", "--prune"], NET_TIMEOUT)?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub additions: i32,
    pub deletions: i32,
    pub binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<CommitFile>,
    pub additions: i32,
    pub deletions: i32,
    /// Diff snippet of the current file in this commit (hunk content only, truncated)
    pub file_diff: String,
    pub merge: bool,
}

const MAX_HUNK_LINES: usize = 80;

/// Parse the new-file start line and count from "@@ -a,b +c,d @@"
fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let mut parts = rest[..end].split(' ');
    let _old = parts.next()?;
    let new = parts.next()?;
    let mut new_parts = new.strip_prefix('+')?.split(',');
    let start: u32 = new_parts.next()?.parse().ok()?;
    let count: u32 = new_parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
    Some((start, count))
}

/// Commit details for the inline blame hover card: gathered in one call to avoid extra IPC
#[tauri::command(async)]
pub fn git_commit_detail(
    state: State<'_, AppState>,
    root: String,
    sha: String,
    rel: Option<String>,
    line: Option<u32>,
    orig_line: Option<u32>,
) -> AppResult<CommitDetail> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let sha = sha.trim();
    if sha.is_empty() || sha.len() > 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::c("git.invalidSha"));
    }

    // rel comes from the frontend, so it still goes through the workspace boundary check
    if let Some(rel) = rel.as_deref().filter(|v| !v.is_empty()) {
        let abs = crate::state::resolve_in_root(&root_path, rel)?;
        crate::state::assert_inside(&root_path, &abs)?;
    }

    // Basic info: fields are NUL separated, so newlines in the commit body cannot break parsing
    let (ok, stdout, stderr) = run_bytes(
        &root_str,
        &[
            "show",
            "-s",
            // %P comes along so merge detection needs no separate rev-list call
            "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%b%x00%P",
            sha,
        ],
    )?;
    if !ok {
        return Err(AppError::new(stderr.trim().to_string()));
    }
    let text = String::from_utf8_lossy(&stdout);
    let mut parts = text.split('\0');
    let full_sha = parts.next().unwrap_or("").trim().to_string();
    let short_sha = parts.next().unwrap_or("").trim().to_string();
    let author = parts.next().unwrap_or("").to_string();
    let email = parts.next().unwrap_or("").to_string();
    let author_time = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
    let commit_time = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
    let subject = parts.next().unwrap_or("").to_string();
    let body = parts.next().unwrap_or("").trim().to_string();
    let parents = parts.next().unwrap_or("");

    // Parent count: >1 means a merge commit, whose numstat is usually empty
    let parent_count = parents.split_whitespace().count().saturating_sub(1);
    let merge = parent_count > 1;
    // Merge commits are shown against the first parent
    let parent_sha = format!("{sha}^1");

    // For a per-file inline blame card, skip the repo-wide numstat: the card shows no file list
    // or add/delete totals, and one more git call only makes the hover slower
    let want_stat = rel.is_none();
    let num_result = if !want_stat {
        (false, Vec::new(), String::new())
    } else if merge {
        run_bytes(
            &root_str,
            &["diff", "--numstat", "-M", parent_sha.as_str(), sha],
        )?
    } else {
        run_bytes(
            &root_str,
            &["show", "--numstat", "--format=", "--root", "-M", sha],
        )?
    };
    let (num_ok, num_out, _) = num_result;
    let mut files = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    if num_ok {
        for line in String::from_utf8_lossy(&num_out).lines() {
            let mut it = line.split('\t');
            let add = it.next().unwrap_or("");
            let del = it.next().unwrap_or("");
            let path = it.next().unwrap_or("");
            if path.is_empty() {
                continue;
            }
            let binary = add == "-" || del == "-";
            let a: i32 = add.parse().unwrap_or(0);
            let d: i32 = del.parse().unwrap_or(0);
            additions += a;
            deletions += d;
            // The card lists only the first 200 files; totals still use everything
            if files.len() < 200 {
                files.push(CommitFile {
                    path: path.to_string(),
                    additions: a,
                    deletions: d,
                    binary,
                });
            }
        }
    }

    // Changes of the current file in this commit: hunks only, at most 80 lines
    let mut file_diff = String::new();
    if let Some(rel) = rel.as_deref().filter(|v| !v.is_empty()) {
        let diff_result = if merge {
            run_bytes(
                &root_str,
                &[
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--unified=2",
                    "-M",
                    parent_sha.as_str(),
                    sha,
                    "--",
                    rel,
                ],
            )?
        } else {
            run_bytes(
                &root_str,
                &[
                    "show",
                    "--format=",
                    "--root",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--unified=2",
                    "-M",
                    sha,
                    "--",
                    rel,
                ],
            )?
        };
        let (diff_ok, diff_out, _) = diff_result;
        if diff_ok {
            let text = String::from_utf8_lossy(&diff_out);
            let lines: Vec<&str> = text.lines().collect();

            // Split on @@ headers: record the new-file start line, count, and span indices in lines
            let mut hunks: Vec<(u32, u32, usize, usize)> = Vec::new();
            let mut open: Option<(u32, u32, usize)> = None;
            for (index, current) in lines.iter().enumerate() {
                if !current.starts_with("@@") {
                    continue;
                }
                if let Some((start, count, begin)) = open.take() {
                    hunks.push((start, count, begin, index));
                }
                if let Some((start, count)) = parse_hunk_header(current) {
                    open = Some((start, count, index));
                }
            }
            if let Some((start, count, begin)) = open {
                hunks.push((start, count, begin, lines.len()));
            }

            let contains = |target: Option<u32>, start: u32, count: u32| -> bool {
                match target {
                    Some(n) if n > 0 => {
                        if count == 0 {
                            n >= start && n <= start.saturating_add(1)
                        } else {
                            n >= start && n < start.saturating_add(count)
                        }
                    }
                    _ => false,
                }
            };

            let wanted = orig_line.filter(|v| *v > 0).or(line.filter(|v| *v > 0));
            // Prefer blame's original line number: it maps to the file version in the commit,
            // matching diff's +c,d
            let mut selected = orig_line
                .filter(|v| *v > 0)
                .and_then(|n| hunks.iter().find(|(s, c, _, _)| contains(Some(n), *s, *c)))
                .map(|(_, _, begin, end)| (*begin, *end));
            if selected.is_none() {
                selected = line
                    .filter(|v| *v > 0)
                    .and_then(|n| hunks.iter().find(|(s, c, _, _)| contains(Some(n), *s, *c)))
                    .map(|(_, _, begin, end)| (*begin, *end));
            }
            // If no hunk matched (later commits edited those lines), fall back to the nearest hunk
            if selected.is_none() {
                selected = wanted.and_then(|n| {
                    hunks
                        .iter()
                        .min_by_key(|(s, c, _, _)| {
                            if n < *s {
                                *s - n
                            } else if n >= s.saturating_add(*c) {
                                n - s.saturating_add(*c)
                            } else {
                                0
                            }
                        })
                        .map(|(_, _, begin, end)| (*begin, *end))
                });
            }
            if selected.is_none() {
                selected = hunks.first().map(|(_, _, begin, end)| (*begin, *end));
            }

            if let Some((begin, end)) = selected {
                // The card shows only the change at the cursor line: advance the new-file line number
                // from the hunk header and pick the entry for orig_line; fall back to the first actual
                // change when the line number does not match
                let hunk = &lines[begin..end.min(begin + MAX_HUNK_LINES)];
                let target = orig_line.filter(|v| *v > 0);
                let mut new_no: u32 = 0;
                let mut chosen: Option<&str> = None;
                for current in hunk {
                    if current.starts_with("@@") {
                        match parse_hunk_header(current) {
                            Some((start, _count)) => new_no = start,
                            None => continue,
                        }
                        continue;
                    }
                    // Marker lines like "\ No newline at end of file" do not consume a line number
                    if current.starts_with('\\') {
                        continue;
                    }
                    let marker = current.chars().next().unwrap_or(' ');
                    let on_new_side = marker != '-';
                    let line_no = new_no;
                    if on_new_side {
                        new_no = new_no.saturating_add(1);
                    }
                    if let Some(n) = target {
                        if on_new_side && line_no == n {
                            chosen = Some(current);
                            break;
                        }
                    }
                }
                let fallback = hunk
                    .iter()
                    .find(|line| line.starts_with('+') || line.starts_with('-'))
                    .copied();
                file_diff = chosen.or(fallback).unwrap_or("").to_string();
            }
        }
    }

    Ok(CommitDetail {
        sha: full_sha,
        short_sha,
        author,
        email,
        author_time,
        commit_time,
        subject,
        body,
        files,
        additions,
        deletions,
        file_diff,
        merge,
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// Local branches use the short name (main); remote branches carry the remote (origin/main)
    pub name: String,
    /// local | remote
    pub kind: String,
    pub current: bool,
    pub upstream: String,
    pub sha: String,
    pub time: i64,
    pub subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: String,
    pub detached: bool,
    pub branches: Vec<GitBranch>,
}

#[tauri::command(async)]
pub fn git_branches(state: State<'_, AppState>, root: String) -> AppResult<GitBranches> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();

    // rev-parse returns the literal HEAD when detached
    let current = match run_text(&root_str, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok((true, text)) => text.trim().to_string(),
        _ => String::new(),
    };
    let detached = current.is_empty() || current == "HEAD";

    let (ok, stdout, stderr) = run_bytes(
        &root_str,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:unix)%00%(contents:subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    if !ok {
        return Err(AppError::new(stderr.trim().to_string()));
    }

    let text = String::from_utf8_lossy(&stdout);
    let mut branches: Vec<GitBranch> = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\0');
        let full = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        let head = parts.next().unwrap_or("").trim();
        let upstream = parts.next().unwrap_or("");
        let sha = parts.next().unwrap_or("");
        let time = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
        let subject = parts.next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let is_remote = full.starts_with("refs/remotes/");
        // origin/HEAD is just a symref, not a switchable branch
        if is_remote && full.ends_with("/HEAD") {
            continue;
        }
        branches.push(GitBranch {
            name: name.to_string(),
            kind: if is_remote { "remote".to_string() } else { "local".to_string() },
            current: head == "*",
            upstream: upstream.to_string(),
            sha: sha.to_string(),
            time,
            subject: subject.to_string(),
        });
    }

    // Local branches first, each sorted by name
    branches.sort_by(|a, b| {
        let rank = |k: &str| if k == "local" { 0u8 } else { 1u8 };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(GitBranches {
        current,
        detached,
        branches,
    })
}

#[tauri::command(async)]
pub fn git_checkout(
    state: State<'_, AppState>,
    root: String,
    branch: String,
    kind: String,
) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let name = branch.trim();
    if name.is_empty() {
        return Err(AppError::c("git.emptyBranch"));
    }
    // A name starting with - would be read by git as an option
    if name.starts_with('-') {
        return Err(AppError::c("git.invalidBranch"));
    }

    if kind == "remote" {
        // origin/feature -> feature: switch to a local branch of the same name, else create a tracking one
        let local = name.split_once('/').map(|(_, rest)| rest).unwrap_or(name);
        let exists = run_text(
            &root_str,
            &["rev-parse", "--verify", &format!("refs/heads/{local}")],
        )
        .map(|(ok, _)| ok)
        .unwrap_or(false);
        let (ok, text) = if exists {
            run_text(&root_str, &["checkout", local])?
        } else {
            run_text(&root_str, &["checkout", "-t", name])?
        };
        if !ok {
            return Err(AppError::new(text.trim().to_string()));
        }
        return Ok(text.trim().to_string());
    }

    let (ok, text) = run_text(&root_str, &["checkout", name])?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

/// Create a branch from the current HEAD and switch to it. Validation is left to git; errors go to
/// the frontend as a toast.
#[tauri::command(async)]
pub fn git_branch_create(
    state: State<'_, AppState>,
    root: String,
    branch: String,
) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let name = branch.trim();
    if name.is_empty() {
        return Err(AppError::c("git.emptyBranch"));
    }
    // A name starting with - would be read by git as an option
    if name.starts_with('-') {
        return Err(AppError::c("git.invalidBranch"));
    }

    // Validate the name first so failures show git's own hint, clearer than checkout's error
    let (valid, text) = run_text(&root_str, &["check-ref-format", "--branch", name])?;
    if !valid {
        return Err(AppError::new(text.trim().to_string()));
    }

    let (ok, text) = run_text(&root_str, &["checkout", "-b", name])?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

/// Whether a file is currently unmerged (conflicted).
/// The frontend asks only when the content really has conflict markers, so normal file opens
/// are not slowed down.
#[tauri::command(async)]
pub fn git_unmerged(state: State<'_, AppState>, root: String, rel: String) -> AppResult<bool> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let abs = crate::state::resolve_in_root(&root_path, &rel)?;
    crate::state::assert_inside(&root_path, &abs)?;
    let (ok, stdout, _) = run_bytes(&root_str, &["ls-files", "-u", "-z", "--", &rel])?;
    Ok(ok && !stdout.is_empty())
}

/// Continue the operation in progress. When message is non-empty it is written back into git's
/// message file first, so what the user edited becomes the final commit message.
#[tauri::command(async)]
pub fn git_continue(
    state: State<'_, AppState>,
    root: String,
    message: Option<String>,
) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let paths = repo_paths(&root_str).ok_or_else(|| AppError::c("git.notRepo"))?;
    let op = detect_operation(&paths.gitdir).ok_or_else(|| AppError::c("git.noOperation"))?;

    if let Some(text) = message.filter(|m| !m.trim().is_empty()) {
        write_pending_message(&paths.gitdir, &op.kind, text.trim());
    }

    let args: Vec<&str> = match op.kind.as_str() {
        // merge has no --continue; commit picks up MERGE_MSG (already written back)
        "merge" => vec!["commit", "--no-edit"],
        "cherry-pick" => vec!["cherry-pick", "--continue"],
        "revert" => vec!["revert", "--continue"],
        "rebase" => vec!["rebase", "--continue"],
        "am" => vec!["am", "--continue"],
        other => {
            return Err(AppError::p(
                "git.unsupportedContinue",
                [("operation", other.to_string())],
            ))
        }
    };

    let (ok, text) = run_with_timeout(&root_str, &args, Duration::from_secs(120))?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

#[tauri::command(async)]
pub fn git_abort(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let paths = repo_paths(&root_str).ok_or_else(|| AppError::c("git.notRepo"))?;
    let op = detect_operation(&paths.gitdir).ok_or_else(|| AppError::c("git.noOperation"))?;
    let args = vec![op.kind.as_str(), "--abort"];
    let (ok, text) = run_with_timeout(&root_str, &args, Duration::from_secs(120))?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

#[tauri::command(async)]
pub fn git_skip(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let paths = repo_paths(&root_str).ok_or_else(|| AppError::c("git.notRepo"))?;
    let op = detect_operation(&paths.gitdir).ok_or_else(|| AppError::c("git.noOperation"))?;
    if !op.can_skip {
        return Err(AppError::c("git.mergeCannotSkip"));
    }
    let args = vec![op.kind.as_str(), "--skip"];
    let (ok, text) = run_with_timeout(&root_str, &args, Duration::from_secs(120))?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(text.trim().to_string())
}

/// Regenerate conflict markers from the index: restore a file the user mangled back into
/// <<<<<<< / ======= / >>>>>>> form
#[tauri::command(async)]
pub fn git_conflict_reset(
    state: State<'_, AppState>,
    root: String,
    rel: String,
) -> AppResult<()> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();
    let abs = crate::state::resolve_in_root(&root_path, &rel)?;
    crate::state::assert_inside(&root_path, &abs)?;
    let (ok, text) = run_text(&root_str, &["checkout", "--merge", "--", &rel])?;
    if !ok {
        return Err(AppError::new(text.trim().to_string()));
    }
    Ok(())
}
