use super::theme::{read_settings, Settings};
use crate::{
    error::{AppError, AppResult},
    paths,
};
use serde_json::Value;
use std::{fs, io::Read, path::PathBuf, time::Duration};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Configuration documents are small; bound both local and remote reads before JSON allocation.
const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;

fn invalid() -> AppError {
    AppError::c("config.invalidData")
}
fn source(error: impl std::fmt::Display) -> AppError {
    AppError::p("config.sourceFailed", [("error", error.to_string())])
}
fn parse(bytes: &[u8]) -> AppResult<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(source)?;
    if !value.is_object() {
        return Err(invalid());
    }
    Ok(value)
}

#[tauri::command(async)]
pub fn config_import_file(app: AppHandle) -> AppResult<Option<Value>> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(source)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(invalid());
    }
    parse(&bytes).map(Some)
}

#[tauri::command]
pub async fn config_import_url(url: String) -> AppResult<Value> {
    let url = reqwest::Url::parse(&url).map_err(source)?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(source)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(source)?
        .error_for_status()
        .map_err(source)?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_CONFIG_BYTES)
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(source)? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_CONFIG_BYTES {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse(&bytes)
}

#[tauri::command(async)]
pub fn config_choose_folder(app: AppHandle) -> AppResult<Option<String>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let folder = folder.into_path().map_err(source)?;
    Ok(Some(
        dunce::canonicalize(folder)?.to_string_lossy().into_owned(),
    ))
}

#[tauri::command(async)]
pub fn config_export(
    app: AppHandle,
    document: Value,
    automatic: bool,
    file_name: String,
) -> AppResult<Option<String>> {
    if !document.is_object()
        || !file_name.starts_with("tide-config")
        || !file_name.ends_with(".json")
        || file_name.len() > 80
        || !file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(invalid());
    }
    let bytes = serde_json::to_vec_pretty(&document).map_err(source)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(invalid());
    }
    let path = if automatic {
        let settings = read_settings(&app);
        if !settings.config_backup_enabled || settings.config_backup_folder.is_empty() {
            return Err(AppError::c("config.noBackupFolder"));
        }
        // Use the persisted destination chosen by the user, never a path supplied by the export command.
        let dir = dunce::canonicalize(PathBuf::from(settings.config_backup_folder))?;
        if !dir.is_dir() {
            return Err(AppError::c("config.invalidPath"));
        }
        dir.join(file_name)
    } else {
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(source)?
    };
    paths::write_atomic(&path, &bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
pub fn config_recovery(app: AppHandle, settings: Settings) -> AppResult<()> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(source)?;
    fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(source)?;
    paths::write_atomic(&dir.join("settings.before-import.json"), &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_object_configuration_without_accepting_html() {
        for data in [b"[]".as_slice(), b"null", b"42", b"<html>login</html>"] {
            assert!(parse(data).is_err());
        }
        assert!(parse(br#"{"settings":{"fontSize":14},"future":true}"#).is_ok());
    }
}
