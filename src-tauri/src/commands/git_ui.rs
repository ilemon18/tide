use super::git::{read_status, run_text_with_timeout, run_with_timeout, NET_TIMEOUT};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityInfo {
    pub global: GitIdentity,
    pub effective: GitIdentity,
    pub use_global: bool,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GitCommitOptions {
    pub amend: bool,
    pub skip_hooks: bool,
    pub identity: Option<GitIdentity>,
    pub reset_author: bool,
}
#[derive(Clone, Deserialize)]
pub struct BranchTarget {
    pub name: String,
    pub kind: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteResult {
    pub local_deleted: bool,
    pub remote_deleted: bool,
    pub error: Option<AppError>,
}
#[derive(Serialize)]
pub struct StashEntry {
    pub selector: String,
    pub sha: String,
    pub time: i64,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashPage {
    pub entries: Vec<StashEntry>,
    pub has_more: bool,
}

pub(super) fn validate_identity(identity: &GitIdentity) -> AppResult<()> {
    if identity.name.trim().is_empty()
        || identity.name.chars().count() > 200
        || identity.name.contains(['\0', '\n', '\r', '<', '>'])
        || identity.email.len() > 320
        || !identity.email.contains('@')
        || identity.email.starts_with('@')
        || identity.email.ends_with('@')
        || identity
            .email
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '\0' | '<' | '>'))
    {
        return Err(AppError::c("git.invalidIdentity"));
    }
    Ok(())
}

fn config(root: &str, key: &str, global: bool) -> AppResult<String> {
    let args = if global {
        vec!["config", "--global", "--includes", "--get", key]
    } else {
        vec!["config", "--get", key]
    };
    let (ok, value) = run_text_with_timeout(root, &args)?;
    Ok(if ok {
        value.trim().to_owned()
    } else {
        String::new()
    })
}
fn run(root: &str, args: Vec<String>) -> AppResult<String> {
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    let (ok, text) = run_with_timeout(root, &refs, NET_TIMEOUT)?;
    if !ok {
        return Err(AppError::new(text.trim().to_owned()));
    }
    Ok(text.trim().to_owned())
}

#[tauri::command(async)]
pub fn git_stash_list(
    state: State<'_, AppState>,
    root: String,
    offset: usize,
) -> AppResult<StashPage> {
    let _guard = super::git::STASH_LOCK.lock();
    let root = state.authorize(&root)?;
    let text = run(
        &root.to_string_lossy(),
        vec![
            "stash".into(),
            "list".into(),
            format!("--skip={offset}"),
            "--max-count=101".into(),
            "--format=%gd%x00%H%x00%ct%x00%gs".into(),
        ],
    )?;
    let mut entries: Vec<_> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\0');
            Some(StashEntry {
                selector: parts.next()?.to_owned(),
                sha: parts.next()?.to_owned(),
                time: parts.next()?.parse().unwrap_or(0),
                message: parts.next()?.to_owned(),
            })
        })
        .collect();
    let has_more = entries.len() > 100;
    entries.truncate(100);
    Ok(StashPage { entries, has_more })
}
#[tauri::command(async)]
pub fn git_stash_clear(state: State<'_, AppState>, root: String) -> AppResult<()> {
    let _guard = super::git::STASH_LOCK.lock();
    let root = state.authorize(&root)?;
    run(
        &root.to_string_lossy(),
        vec!["stash".into(), "clear".into()],
    )?;
    Ok(())
}
fn current(root: &str) -> AppResult<String> {
    let (ok, name) = run_text_with_timeout(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !ok {
        return Err(AppError::c("git.noCurrentBranch"));
    }
    Ok(name.trim().to_owned())
}
fn validate_name(root: &str, name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::c("git.invalidBranch"));
    }
    let (ok, _) =
        run_text_with_timeout(root, &["check-ref-format", &format!("refs/heads/{name}")])?;
    if !ok {
        return Err(AppError::c("git.invalidBranch"));
    }
    Ok(())
}
fn full_ref(root: &str, target: &BranchTarget) -> AppResult<String> {
    validate_name(root, &target.name)?;
    let prefix = match target.kind.as_str() {
        "local" => "refs/heads",
        "remote" => "refs/remotes",
        _ => return Err(AppError::c("git.invalidBranch")),
    };
    let full = format!("{prefix}/{}", target.name);
    let (ok, _) = run_text_with_timeout(root, &["show-ref", "--verify", "--quiet", &full])?;
    if !ok {
        return Err(AppError::c("git.invalidBranch"));
    }
    Ok(full)
}
fn oid(root: &str, full: &str) -> AppResult<String> {
    let (ok, value) = run_text_with_timeout(root, &["rev-parse", "--verify", full])?;
    if !ok {
        return Err(AppError::c("git.invalidBranch"));
    }
    Ok(value.trim().to_owned())
}
fn remote_ref(root: &str, full: &str) -> AppResult<(String, String, String)> {
    let name = full
        .strip_prefix("refs/remotes/")
        .ok_or_else(|| AppError::c("git.noUpstream"))?;
    let (ok, remotes) = run_text_with_timeout(root, &["remote"])?;
    if !ok {
        return Err(AppError::c("git.unknownRemote"));
    }
    let mut remotes: Vec<_> = remotes
        .lines()
        .filter(|r| !r.is_empty() && !r.starts_with('-'))
        .collect();
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    for remote in remotes {
        if let Some(branch) = name.strip_prefix(&format!("{remote}/")) {
            validate_name(root, branch)?;
            return Ok((
                remote.to_owned(),
                format!("refs/heads/{branch}"),
                oid(root, full)?,
            ));
        }
    }
    Err(AppError::c("git.unknownRemote"))
}
fn upstream(root: &str, name: &str) -> AppResult<String> {
    let (ok, text) = run_text_with_timeout(
        root,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{name}"),
        ],
    )?;
    if !ok || text.trim().is_empty() {
        return Err(AppError::c("git.noUpstream"));
    }
    Ok(text.trim().to_owned())
}

pub(super) fn read_identity(root: &str) -> AppResult<GitIdentityInfo> {
    let local_name = run_text_with_timeout(
        root,
        &["config", "--local", "--includes", "--get", "user.name"],
    )?;
    let local_email = run_text_with_timeout(
        root,
        &["config", "--local", "--includes", "--get", "user.email"],
    )?;
    Ok(GitIdentityInfo {
        global: GitIdentity {
            name: config(root, "user.name", true)?,
            email: config(root, "user.email", true)?,
        },
        effective: GitIdentity {
            name: config(root, "user.name", false)?,
            email: config(root, "user.email", false)?,
        },
        use_global: !local_name.0 && !local_email.0,
    })
}
#[tauri::command(async)]
pub fn git_identity(state: State<'_, AppState>, root: String) -> AppResult<GitIdentityInfo> {
    let root = state.authorize(&root)?;
    read_identity(&root.to_string_lossy())
}
#[tauri::command(async)]
pub fn git_last_message(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root = state.authorize(&root)?;
    run(
        &root.to_string_lossy(),
        vec!["log".into(), "-1".into(), "--format=%B".into()],
    )
}
pub(super) fn force_push(root: &str) -> AppResult<String> {
    let name = current(root)?;
    let (remote, dest, expected) = remote_ref(root, &upstream(root, &name)?)?;
    let source = oid(root, "HEAD")?;
    run(
        root,
        vec![
            "push".into(),
            format!("--force-with-lease={dest}:{expected}"),
            remote,
            format!("{source}:{dest}"),
        ],
    )
}
#[tauri::command(async)]
pub fn git_force_push(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let root = state.authorize(&root)?;
    force_push(&root.to_string_lossy())
}
pub(super) fn fetch_branch(root: &str, target: &BranchTarget) -> AppResult<String> {
    super::git_config::load_project(root)?;
    let full = full_ref(root, target)?;
    let remote_full = if target.kind == "local" {
        match upstream(root, &target.name) {
            Ok(value) => value,
            Err(error) if error.code == "git.noUpstream" => {
                return run(root, vec!["fetch".into(), "--all".into(), "--prune".into()])
            }
            Err(error) => return Err(error),
        }
    } else {
        full
    };
    let (remote, dest, _) = remote_ref(root, &remote_full)?;
    run(
        root,
        vec![
            "fetch".into(),
            "--prune".into(),
            remote,
            format!("+{dest}:{remote_full}"),
        ],
    )
}
#[tauri::command(async)]
pub fn git_fetch_branch(
    state: State<'_, AppState>,
    root: String,
    target: BranchTarget,
) -> AppResult<String> {
    let root = state.authorize(&root)?;
    fetch_branch(&root.to_string_lossy(), &target)
}
pub(super) fn rename_branch(root: &str, target: &BranchTarget, name: &str) -> AppResult<String> {
    let full = full_ref(root, target)?;
    validate_name(root, name)?;
    if target.kind == "local" {
        return run(
            root,
            vec![
                "branch".into(),
                "-m".into(),
                target.name.clone(),
                name.to_owned(),
            ],
        );
    }
    let (remote, old, expected) = remote_ref(root, &full)?;
    let new = format!("refs/heads/{name}");
    let new_tracking = format!("refs/remotes/{remote}/{name}");
    if run_text_with_timeout(root, &["show-ref", "--verify", "--quiet", &new_tracking])?.0 {
        return Err(AppError::c("git.branchExists"));
    }
    let text = run(
        root,
        vec![
            "push".into(),
            "--atomic".into(),
            format!("--force-with-lease={old}:{expected}"),
            format!("--force-with-lease={new}:"),
            remote.clone(),
            format!("{expected}:{new}"),
            format!(":{old}"),
        ],
    )?;
    // Successful push may already update/delete the local tracking refs. Respect that and leases.
    if !run_text_with_timeout(root, &["show-ref", "--verify", "--quiet", &new_tracking])?.0 {
        run(
            root,
            vec![
                "update-ref".into(),
                new_tracking.clone(),
                expected.clone(),
                String::new(),
            ],
        )?;
    }
    if run_text_with_timeout(root, &["show-ref", "--verify", "--quiet", &full])?.0 {
        run(
            root,
            vec!["update-ref".into(), "-d".into(), full.clone(), expected],
        )?;
    }
    let (_, locals) = run_text_with_timeout(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:strip=2)%00%(upstream)",
            "refs/heads",
        ],
    )?;
    for line in locals.lines() {
        if let Some((local, parent)) = line.split_once('\0') {
            if parent == full {
                run(
                    root,
                    vec![
                        "branch".into(),
                        format!("--set-upstream-to={remote}/{name}"),
                        local.to_owned(),
                    ],
                )?;
            }
        }
    }
    Ok(text)
}
#[tauri::command(async)]
pub fn git_rename_branch(
    state: State<'_, AppState>,
    root: String,
    target: BranchTarget,
    name: String,
) -> AppResult<String> {
    let root = state.authorize(&root)?;
    rename_branch(&root.to_string_lossy(), &target, name.trim())
}
pub(super) fn delete_branch(
    root: &str,
    target: &BranchTarget,
    delete_remote: bool,
    force: bool,
) -> AppResult<BranchDeleteResult> {
    let full = full_ref(root, target)?;
    if target.kind == "local" && current(root).ok().as_deref() == Some(target.name.as_str()) {
        return Err(AppError::c("git.currentBranchCannotDelete"));
    }
    let remote = if target.kind == "remote" {
        Some(remote_ref(root, &full)?)
    } else if delete_remote {
        Some(remote_ref(root, &upstream(root, &target.name)?)?)
    } else {
        None
    };
    let mut result = BranchDeleteResult {
        local_deleted: false,
        remote_deleted: false,
        error: None,
    };
    if target.kind == "local" {
        run(
            root,
            vec![
                "branch".into(),
                if force { "-D".into() } else { "-d".into() },
                target.name.clone(),
            ],
        )?;
        result.local_deleted = true;
    }
    if let Some((remote, dest, expected)) = remote {
        if let Err(error) = run(
            root,
            vec![
                "push".into(),
                format!("--force-with-lease={dest}:{expected}"),
                remote.clone(),
                format!(":{dest}"),
            ],
        ) {
            result.error = Some(error);
            return Ok(result);
        }
        result.remote_deleted = true;
        let tracking = format!(
            "refs/remotes/{remote}/{}",
            dest.trim_start_matches("refs/heads/")
        );
        if run_text_with_timeout(root, &["show-ref", "--verify", "--quiet", &tracking])?.0 {
            if let Err(error) = run(
                root,
                vec!["update-ref".into(), "-d".into(), tracking, expected],
            ) {
                result.error = Some(error);
            }
        }
    }
    Ok(result)
}
#[tauri::command(async)]
pub fn git_delete_branch(
    state: State<'_, AppState>,
    root: String,
    target: BranchTarget,
    delete_remote: bool,
    force: bool,
) -> AppResult<BranchDeleteResult> {
    let root = state.authorize(&root)?;
    delete_branch(&root.to_string_lossy(), &target, delete_remote, force)
}
pub(super) fn integrate_branch(
    root: &Path,
    target: &BranchTarget,
    rebase: bool,
    identity: Option<&GitIdentity>,
) -> AppResult<String> {
    let root_str = root.to_string_lossy();
    let preferences = super::git_config::load_project(&root_str)?;
    current(&root_str)?;
    let target = full_ref(&root_str, target)?;
    let status = read_status(root)?;
    if status.operation.is_some() {
        return Err(AppError::c("git.operationInProgress"));
    }
    if !status.staged.is_empty() || !status.changes.is_empty() || !status.conflicts.is_empty() {
        return Err(AppError::c("git.branchDirty"));
    }
    let mut args = Vec::new();
    if let Some(identity) = identity {
        validate_identity(identity)?;
        args.extend([
            "-c".into(),
            format!("user.name={}", identity.name),
            "-c".into(),
            format!("user.email={}", identity.email),
        ]);
    }
    args.push(if rebase {
        "rebase".into()
    } else {
        "merge".into()
    });
    if rebase && config(&root_str, "pull.rebase", false)? == "merges" {
        args.push("--rebase-merges".into());
    }
    if !rebase {
        args.push("--no-edit".into());
        if config(&root_str, "merge.log", false)?.is_empty() && preferences.merge_log {
            args.push("--log".into());
        }
        if !preferences.merge_auto_commit {
            args.push("--no-commit".into());
        }
    }
    args.extend(["--".into(), target]);
    run(&root_str, args)
}
#[tauri::command(async)]
pub fn git_integrate_branch(
    state: State<'_, AppState>,
    root: String,
    target: BranchTarget,
    rebase: bool,
    identity: Option<GitIdentity>,
) -> AppResult<String> {
    let root = state.authorize(&root)?;
    integrate_branch(&root, &target, rebase, identity.as_ref())
}
