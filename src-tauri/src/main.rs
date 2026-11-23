#![cfg_attr(windows, windows_subsystem = "windows")]

mod agent;
mod commands;
mod error;
mod i18n;
mod paths;
mod proc;
mod state;
// In-app update (check / download / install / startup report), see the module header
mod update;
mod watcher;

#[cfg(target_os = "macos")]
mod dock_menu;
/// Other platforms have no Dock menu; an empty impl keeps the setup call uniform
#[cfg(not(target_os = "macos"))]
mod dock_menu {
    pub fn install(_app: &tauri::AppHandle) {}
}

use std::path::Path;

use state::AppState;
use tauri::{Emitter, Manager, State};

/// Label counter for new windows: per-process increment keeps labels unique
static WINDOW_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Encode a path into the query so CJK chars / spaces / `#` cannot break the URL
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Open a new window from any window: optional project to open, plus optional extra query
/// (e.g. projects=1)
fn create_window(
    app: &tauri::AppHandle,
    label: String,
    path: Option<&str>,
    extra_query: Option<&str>,
) -> Result<tauri::WebviewWindow, String> {
    let mut query: Vec<String> = Vec::new();
    if let Some(target) = path.filter(|p| !p.trim().is_empty()) {
        query.push(format!("open={}", encode_query(target)));
    }
    if let Some(extra) = extra_query {
        query.push(extra.to_string());
    }
    let url = if query.is_empty() {
        tauri::WebviewUrl::App("index.html".into())
    } else {
        tauri::WebviewUrl::App(format!("index.html?{}", query.join("&")).into())
    };

    let mut builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title("Tide")
        .inner_size(1320.0, 840.0)
        .min_inner_size(780.0, 480.0)
        .resizable(true)
        .center();

    // Pass the current theme at build time so the native title bar never flashes the default look
    let settings = commands::theme::read_settings(app);
    if let Some(theme) = commands::theme::native_theme(&settings.theme) {
        builder = builder.theme(Some(theme));
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));

    // Windows / Linux: `titleBarStyle` is macOS-only, and the native title bar would stack on top
    // of the frontend one. Drop native decorations; TitleBar draws the drag area and caption buttons.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder.build().map_err(|e| e.to_string())
}

/// Bring a window to the front (restoring it if minimized). false = the label no longer exists
pub(crate) fn focus_window(app: &tauri::AppHandle, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Same event as a Dock activation: the frontend remounts its sleeping editor documents
    let _ = window.emit("app:shown", ());
    true
}

/// Atomic claim before opening a project: true = the project lives in (or is opening in)
/// another window, which has been focused; the caller must not open a second copy here.
///
/// Dedupe and claim must happen in one call: "check then open" from the frontend leaves a few
/// IPCs in between, so two windows both see "not open" and each opens one.
#[tauri::command]
fn claim_project(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> bool {
    let _open = state.begin_open();
    if let Some(label) = state.owner_window_of(Path::new(&path)) {
        if label != window.label() {
            if focus_window(&app, &label) {
                return true;
            }
            // Record exists but the window is gone: treat as unopened and claim again below
            state.release_window(&label);
        }
        // We already hold it (reserved when the window was built via `?open=`): open it here
        return false;
    }
    state.reserve_root(window.label(), Path::new(&path));
    false
}

/// Drop the claim: hand the project back on cancel or open failure so other windows can open it
#[tauri::command]
fn release_project_claim(state: State<'_, AppState>, window: tauri::Window, path: String) {
    state.release_pending(window.label(), Path::new(&path));
}

/// Which projects each window has open (for the Dock menu's "Open" group)
pub(crate) fn open_root_paths(app: &tauri::AppHandle) -> Vec<String> {
    app.state::<AppState>()
        .open_roots()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

/// Next window label: per-process increment keeps it unique
fn next_window_label() -> String {
    let seq = WINDOW_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    format!("win-{}-{seq}", std::process::id())
}

/// Open a project's window: one project per window, focus it if already open.
/// true = no new window, just switched.
pub(crate) fn open_project(app: &tauri::AppHandle, path: &str) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let _open = state.begin_open();
    if let Some(label) = state.owner_window_of(Path::new(path)) {
        if focus_window(app, &label) {
            return Ok(true);
        }
        // Record exists but the window is gone: clear the stale claim and open a new one
        state.release_window(&label);
    }
    let label = next_window_label();
    // Claim before building: the new window needs a few hundred ms to load, and in that gap
    // another window clicking the same project should switch to it, not open another copy
    state.reserve_root(&label, Path::new(path));
    if let Err(e) = create_window(app, label.clone(), Some(path), None) {
        state.release_window(&label);
        return Err(e);
    }
    Ok(false)
}

/// Blank window: reuse an existing blank one instead of stacking more.
/// `exclude` is the requesting window, which is not itself a reusable blank window.
pub(crate) fn open_empty_window(
    app: &tauri::AppHandle,
    exclude: Option<&str>,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let _open = state.begin_open();
    let others: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| Some(label.as_str()) != exclude)
        .collect();
    // A window still opening a project (reserved, not granted) is not reusable as blank
    if let Some(label) = others.iter().find(|label| {
        !state.window_has_roots(label.as_str()) && !state.window_has_pending(label.as_str())
    }) {
        if focus_window(app, label) {
            return Ok(true);
        }
    }
    create_window(app, next_window_label(), None, None)?;
    Ok(false)
}

/// New window: with path, switch to the project if open, else open it in a new window; without
/// path, reuse a blank window. true = no new window, just switched to an existing one.
#[tauri::command]
fn new_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: Option<String>,
) -> Result<bool, String> {
    let target = path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    match target {
        Some(target) => open_project(&app, target),
        None => open_empty_window(&app, Some(window.label())),
    }
}

/// Stable cycle order: the main window first, then secondary windows by creation sequence. Labels are
/// process-local (`win-<pid>-<seq>`), so sorting by the label string is predictable across invocations.
fn window_cycle_key(label: &str) -> (u8, u32, &str) {
    if label == "main" {
        return (0, 0, label);
    }
    if label.starts_with("win-") {
        if let Some(seq) = label.rsplit('-').next().and_then(|value| value.parse::<u32>().ok()) {
            return (1, seq, label);
        }
    }
    (2, 0, label)
}

/// ⌘` / Ctrl+`: bring the next Tide window to the front, wrapping after the last one.
#[tauri::command]
fn cycle_window(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    labels.sort_by(|a, b| window_cycle_key(a).cmp(&window_cycle_key(b)));
    if labels.is_empty() {
        return Ok(());
    }

    let current = window.label();
    let index = labels.iter().position(|label| label == current).unwrap_or(0);
    let next = &labels[(index + 1) % labels.len()];
    if focus_window(&app, next) {
        Ok(())
    } else {
        Err(format!("window not found: {next}"))
    }
}

/// Forward a second launch to the already running instance:
/// with a path open (or switch to) that project's window, without one focus an existing window.
fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    let target = commands::fs::parse_start_args(argv.into_iter().skip(1));

    let Some(root) = target.roots.first().cloned() else {
        // No path argument: focus the window the user can see; if none is left, open a blank one
        let windows: Vec<tauri::WebviewWindow> =
            app.webview_windows().into_values().collect();
        let focus = windows
            .iter()
            .find(|w| w.is_focused().unwrap_or(false))
            .or_else(|| windows.iter().find(|w| w.is_visible().unwrap_or(false)))
            .or_else(|| windows.first())
            .cloned();
        match focus {
            Some(window) => {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            None => {
                let _ = create_window(app, next_window_label(), None, None);
            }
        }
        return;
    };

    if let Err(e) = open_project(app, &root) {
        eprintln!("[Tide] second launch: opening project failed: {e}");
        return;
    }

    // A file was given: the project window is already in front, so hand the file to it
    if let Some(file) = target.file {
        let label = app.state::<AppState>().owner_window_of(Path::new(&root));
        if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
            let _ = window.emit("app:open-file", (root, file));
        }
    }
}

fn main() {
    tauri::Builder::default()
        // Single instance must register first: a second launch (icon / CLI / file association)
        // is handed to the running process. Otherwise two processes keep separate grant and window
        // tables, and "this project is already open" stops working.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_second_instance(app, argv);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        // Holds the downloaded installer until update_install consumes it
        .manage(update::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            // window
            new_window,
            cycle_window,
            claim_project,
            release_project_claim,
            // file system
            commands::fs::open_folder,
            commands::fs::close_folder,
            commands::fs::read_dir,
            commands::fs::resolve_dir_chain,
            commands::fs::read_text_file,
            commands::fs::read_image_file,
            commands::fs::stat_file,
            commands::fs::write_text_file,
            commands::fs::create_entry,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
            commands::fs::list_files,
            commands::fs::path_info,
            commands::fs::start_target,
            commands::fs::reveal_in_finder,
            // format
            commands::format::format_text,
            commands::format::format_tool_status,
            commands::format::prettier_config,
            // search
            commands::search::search_files,
            commands::search::replace_in_files,
            commands::search::replace_match,
            // Git blame
            commands::blame::git_blame,
            // Git
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_diff_full,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_discard_changes,
            commands::git::git_commit,
            commands::git::git_undo_commit,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_fetch,
            commands::git::git_commit_detail,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_branch_create,
            commands::git::git_unmerged,
            commands::git::git_continue,
            commands::git::git_abort,
            commands::git::git_skip,
            commands::git::git_conflict_reset,
            // terminal
            commands::terminal::pty_open,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_close,
            // project tasks
            commands::tasks::task_list,
            commands::tasks::task_run,
            commands::tasks::task_stop,
            // agent
            commands::agent::agent_providers,
            commands::agent::agent_models,
            commands::agent::agent_skills,
            commands::agent::agent_send,
            commands::agent::agent_cancel,
            commands::agent::agent_permission_respond,
            commands::agent::agent_chat_open,
            commands::agent::agent_chat_page,
            commands::agent::agent_chat_apply,
            commands::agent::agent_chat_reset,
            commands::agent::agent_chat_list,
            commands::agent::agent_chat_clone,
            commands::agent::agent_chat_delete,
            commands::agent::agent_tabs_save,
            commands::agent::agent_tabs_load,
            // settings / theme persistence
            commands::theme::load_settings,
            commands::theme::save_settings,
            commands::theme::load_session,
            commands::theme::save_session,
            commands::theme::save_open_tabs,
            commands::theme::remember_recent,
            commands::theme::remove_recent,
            // in-app update
            update::app_version,
            update::is_debug_build,
            update::update_check,
            update::update_download,
            update::update_install,
            update::update_startup_report,
            update::update_open_page,
        ])
        .on_window_event(|window, event| {
            let label = window.label();

            // Close: flush the frontend's debounced settings / session, then really destroy the
            // window (macOS keeps it in the Dock; Windows / Linux quit on the last closed window).
            // Not intercepting this would lose the last edit on Windows when closing right after
            // a settings change.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app:hidden", ());
                let app = window.app_handle().clone();
                let label = label.to_string();
                std::thread::spawn(move || {
                    // Give the frontend time to send its two flush IPCs
                    std::thread::sleep(std::time::Duration::from_millis(180));
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.destroy();
                    }
                });
            }

            // Window really destroyed (closed a second window, or quit): reap its shells, or the
            // PTY readers keep pushing data and the processes stay alive; also release its workspace
            // grants — the frontend can no longer call close_folder, so not doing it here leaks
            // both directory grants and file watchers.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<state::AppState>();
                state.kill_window_ptys(label);
                state.kill_window_tasks(label);
                state.kill_window_agent_turns(label);
                state.release_window(label);
            }
        })
        .setup(|app| {
            // Sync native appearance from the persisted theme at startup (title bar / lights /
            // scrollbars)
            let settings = commands::theme::read_settings(&app.handle());
            let theme = commands::theme::native_theme(&settings.theme);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_theme(theme);
                // The main window is created hidden: drop the native title bar per platform before
                // showing it, or Windows flashes it first. macOS uses Overlay and needs nothing.
                #[cfg(not(target_os = "macos"))]
                let _ = window.set_decorations(false);
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Dock context menu (recent projects); setup runs on the main thread, right for AppKit
            dock_menu::install(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tide failed to start")
        .run(|app, event| match event {
            // On exit stop the watchers first, then reap the PTY children
            tauri::RunEvent::Exit => {
                let state = app.state::<state::AppState>();
                state.kill_all_watchers();
                state.kill_all_ptys();
                state.kill_all_tasks();
                state.kill_all_agent_turns();
            }
            // Dock icon clicked: only focus a window, no "switch project" prompt
            // (`Reopen` is macOS-only; writing it unconditionally would not compile on
            // Windows / Linux)
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let windows: Vec<tauri::WebviewWindow> =
                    app.webview_windows().into_values().collect();
                let target = windows
                    .iter()
                    .find(|w| w.is_focused().unwrap_or(false))
                    .or_else(|| windows.iter().find(|w| w.is_visible().unwrap_or(false)))
                    .or_else(|| windows.first())
                    .cloned();

                match target {
                    Some(window) => {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("app:shown", ());
                    }
                    None => {
                        // No windows left: open a blank one
                        let _ = create_window(app, "main".to_string(), None, None);
                    }
                }
            }
            _ => {}
        });
}
