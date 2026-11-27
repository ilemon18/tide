use crate::{
    error::{AppError, AppResult},
    paths, proc,
    state::AppState,
};
use reqwest::Url;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command(async)]
pub fn project_open_directory(state: State<'_, AppState>, root: String) -> AppResult<()> {
    let root = state.authorize(&root)?;
    #[cfg(target_os = "macos")]
    let status = proc::command("open").arg(&root).status();
    #[cfg(windows)]
    let status = proc::command("explorer").arg(&root).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = proc::command("xdg-open").arg(&root).status();
    let status = status?;
    if !cfg!(windows) && !status.success() {
        return Err(AppError::c("fs.revealStatus"));
    }
    Ok(())
}
#[tauri::command(async)]
pub fn project_open_terminal(state: State<'_, AppState>, root: String) -> AppResult<()> {
    let root = state.authorize(&root)?;
    open_terminal(&root)
}
#[cfg(target_os = "macos")]
fn open_terminal(root: &Path) -> AppResult<()> {
    let status = proc::command("open")
        .args(["-a", "Terminal"])
        .arg(root)
        .status()?;
    if !status.success() {
        return Err(AppError::c("fs.revealStatus"));
    }
    Ok(())
}
#[cfg(windows)]
fn open_terminal(root: &Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    match proc::command("wt").arg("-d").arg(root).spawn() {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::process::Command::new("cmd.exe")
                .current_dir(root)
                .arg("/K")
                .creation_flags(0x0000_0010)
                .spawn()?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}
#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(root: &Path) -> AppResult<()> {
    for (program, option) in [
        ("gnome-terminal", "--working-directory"),
        ("konsole", "--workdir"),
        ("xfce4-terminal", "--working-directory"),
    ] {
        match proc::command(program).arg(option).arg(root).spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    proc::command("x-terminal-emulator")
        .current_dir(root)
        .spawn()?;
    Ok(())
}
pub(super) fn remote_web_url(raw: &str) -> AppResult<Url> {
    let raw = raw.trim();
    let candidate = if raw.contains("://") {
        raw.to_owned()
    } else if let Some((host, path)) = raw.split_once(':') {
        if matches!(host, "javascript" | "data" | "file" | "ext" | "mailto")
            || host.len() <= 1
            || host.contains(['/', '\\'])
        {
            return Err(AppError::c("git.remoteNotWeb"));
        }
        format!(
            "https://{}/{}",
            host.split('@').next_back().unwrap_or(host),
            path.trim_start_matches('/')
        )
    } else {
        return Err(AppError::c("git.remoteNotWeb"));
    };
    let mut url = Url::parse(&candidate).map_err(|_| AppError::c("git.remoteNotWeb"))?;
    if url.scheme() == "ssh" {
        let host = url
            .host_str()
            .ok_or_else(|| AppError::c("git.remoteNotWeb"))?;
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        url = Url::parse(&format!("https://{host}{}", url.path()))
            .map_err(|_| AppError::c("git.remoteNotWeb"))?;
    }
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err(AppError::c("git.remoteNotWeb"));
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    let path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_owned();
    url.set_path(&path);
    Ok(url)
}
#[tauri::command(async)]
pub fn git_open_remote(
    state: State<'_, AppState>,
    root: String,
    name: Option<String>,
) -> AppResult<()> {
    let root = state.authorize(&root)?;
    let root = root.to_string_lossy();
    let remotes = super::git_config::remotes(&root)?;
    let selected = if let Some(name) = name {
        remotes
            .iter()
            .find(|remote| remote.name == name)
            .ok_or_else(|| AppError::c("git.unknownRemote"))?
    } else {
        remotes
            .iter()
            .find(|remote| remote.name == "origin")
            .or_else(|| remotes.first())
            .ok_or_else(|| AppError::c("git.noRemote"))?
    };
    let url = remote_web_url(&selected.url)?;
    #[cfg(target_os = "macos")]
    let status = proc::command("open").arg(url.as_str()).status();
    #[cfg(windows)]
    let status = proc::command("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = proc::command("xdg-open").arg(url.as_str()).status();
    if !status?.success() {
        return Err(AppError::c("fs.revealStatus"));
    }
    Ok(())
}
#[tauri::command(async)]
pub fn git_prepare_config(
    state: State<'_, AppState>,
    root: Option<String>,
    scope: String,
) -> AppResult<String> {
    let path = if scope == "global" {
        super::git_config::global_path()?
    } else {
        let root = root.ok_or_else(|| AppError::c("git.configUnavailable"))?;
        let root = state.authorize(&root)?;
        if scope == "ignore" {
            let path = root.join(".gitignore");
            crate::state::assert_inside(&root, &path)?;
            if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(AppError::c("fs.symlinkUnsupported"));
            }
            path
        } else if scope == "local" {
            let (ok, text) = super::git::run_text_with_timeout(
                &root.to_string_lossy(),
                &["rev-parse", "--git-path", "config"],
            )?;
            if !ok {
                return Err(AppError::new(text));
            }
            let path = PathBuf::from(text.trim());
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        } else {
            return Err(AppError::c("git.configUnavailable"));
        }
    };
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
    }
    let path = paths::canon(&path)?;
    if !std::fs::metadata(&path)?.is_file() {
        return Err(AppError::c("git.configUnavailable"));
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::remote_web_url;
    #[test]
    fn remote_web_urls_convert_ssh_and_remove_credentials() {
        for (raw, expected) in [
            (
                "git@github.com:owner/repo.git",
                "https://github.com/owner/repo",
            ),
            (
                "ssh://git@git.example.com:2222/group/repo.git",
                "https://git.example.com/group/repo",
            ),
            (
                "https://token:secret@example.com/repo.git?auth=token#part",
                "https://example.com/repo",
            ),
            (
                "http://git.example.com/team/repo.git/",
                "http://git.example.com/team/repo",
            ),
        ] {
            assert_eq!(remote_web_url(raw).unwrap().as_str(), expected);
        }
        for raw in [
            "/tmp/repo.git",
            "C:\\repo.git",
            "file:///tmp/repo",
            "ext::danger",
            "javascript:alert(1)",
            "ftp://example.com/repo",
        ] {
            assert!(remote_web_url(raw).is_err(), "{raw}");
        }
    }
}
