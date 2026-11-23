use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::state::{assert_inside, resolve_in_root, AppState};

const CONFIG_LIMIT: u64 = 256 * 1024;
const MAX_RUNNING_TASKS: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub id: String,
    pub label: String,
    pub command: String,
    pub source: String,
    pub cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskFile {
    #[serde(default)]
    tasks: Vec<TaskFileEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskFileEntry {
    id: String,
    label: Option<String>,
    command: String,
    cwd: Option<String>,
}

pub struct TaskProcess {
    child: Mutex<Child>,
    stopped: AtomicBool,
    pub owner: String,
    pub root: PathBuf,
}

impl TaskProcess {
    pub fn stop(&self) {
        let mut child = self.child.lock();
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        // The waiter uses try_wait and never holds this lock across a running process's lifetime.
        kill_tree(&mut child);
        let _ = child.wait();
    }
}

impl Drop for TaskProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = proc::command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDataEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskExitEvent {
    id: String,
    code: Option<i32>,
    success: bool,
}

// Preserve UTF-8 characters split between pipe reads; only genuinely invalid bytes are replaced.
fn read_output(mut reader: impl Read, mut emit: impl FnMut(String)) {
    let mut buf = [0u8; 8192];
    let mut pending = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(size) => pending.extend_from_slice(&buf[..size]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
        loop {
            match std::str::from_utf8(&pending) {
                Ok(text) => {
                    if !text.is_empty() {
                        emit(text.to_owned());
                    }
                    pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        emit(String::from_utf8_lossy(&pending[..valid]).into_owned());
                        pending.drain(..valid);
                    }
                    match error.error_len() {
                        Some(size) => {
                            emit("\u{fffd}".into());
                            pending.drain(..size);
                        }
                        None => break,
                    }
                }
            }
        }
    }
    if !pending.is_empty() {
        emit(String::from_utf8_lossy(&pending).into_owned());
    }
}

fn emit_reader(
    app: AppHandle,
    owner: String,
    id: String,
    reader: impl Read + Send + 'static,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        read_output(reader, |data| {
            let _ = app.emit_to(
                owner.as_str(),
                "task:data",
                TaskDataEvent {
                    id: id.clone(),
                    data,
                },
            );
        });
    })
}

fn shell_command(command: &str, cwd: &Path) -> Command {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = proc::command("cmd.exe");
        cmd.args(["/D", "/S", "/C", command]);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut cmd = proc::command("/bin/sh");
        cmd.args(["-c", command]);
        cmd.process_group(0);
        cmd
    };
    cmd.current_dir(cwd);
    if let Some(path) = crate::agent::providers::augmented_path() {
        cmd.env("PATH", path);
    }
    cmd
}

fn task_cwd(root: &Path, rel: &str) -> AppResult<PathBuf> {
    if rel.starts_with('/')
        || rel.starts_with(char::from(92))
        || rel.as_bytes().get(1) == Some(&b':')
    {
        return Err(AppError::p("path.invalid", [("path", rel.to_owned())]));
    }
    let path = resolve_in_root(root, rel)?;
    assert_inside(root, &path)?;
    let canon = crate::paths::canon(&path).map_err(|error| AppError::io(&path, error))?;
    if !canon.is_dir() {
        return Err(AppError::p("task.cwdNotFolder", [("path", rel.to_owned())]));
    }
    Ok(canon)
}

fn read_config(root: &Path, rel: &str) -> AppResult<Option<String>> {
    let path = resolve_in_root(root, rel)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::io(&path, error)),
        Ok(_) => {}
    }
    assert_inside(root, &path)?;
    let file = std::fs::File::open(&path).map_err(|error| AppError::io(&path, error))?;
    let mut text = String::new();
    file.take(CONFIG_LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|error| AppError::io(&path, error))?;
    if text.len() as u64 > CONFIG_LIMIT {
        return Err(AppError::p(
            "task.configTooLarge",
            [("limit", CONFIG_LIMIT.to_string())],
        ));
    }
    Ok(Some(text))
}

fn package_runner(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

fn push_task(
    tasks: &mut Vec<TaskDefinition>,
    id: String,
    label: String,
    command: String,
    source: &str,
) {
    if id.trim().is_empty() || command.trim().is_empty() || tasks.iter().any(|task| task.id == id) {
        return;
    }
    tasks.push(TaskDefinition {
        id,
        label,
        command,
        source: source.into(),
        cwd: String::new(),
    });
}

// Discovered names become shell arguments. Never interpret metacharacters or option-like target names.
fn safe_target(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"_-.:/@+".contains(&ch))
}

fn package_tasks(root: &Path, tasks: &mut Vec<TaskDefinition>) -> AppResult<()> {
    let Some(text) = read_config(root, "package.json")? else {
        return Ok(());
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(());
    };
    let Some(scripts) = json.get("scripts").and_then(|value| value.as_object()) else {
        return Ok(());
    };
    let runner = package_runner(root);
    for (name, value) in scripts {
        if !safe_target(name)
            || value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        {
            continue;
        }
        push_task(
            tasks,
            format!("package:{name}"),
            name.clone(),
            format!("{runner} run {name}"),
            "package.json",
        );
    }
    Ok(())
}

fn make_tasks(root: &Path, tasks: &mut Vec<TaskDefinition>) -> AppResult<()> {
    let Some(text) = read_config(root, "Makefile")? else {
        return Ok(());
    };
    for line in text.lines() {
        // Leading whitespace is a recipe/continuation, never a target declaration.
        if line.starts_with(char::is_whitespace) || line.starts_with('#') || line.starts_with('.') {
            continue;
        }
        let Some((names, rest)) = line.split_once(':') else {
            continue;
        };
        if rest.starts_with('=') || names.contains('=') {
            continue;
        }
        for name in names.split_whitespace().filter(|name| safe_target(name)) {
            push_task(
                tasks,
                format!("make:{name}"),
                name.into(),
                format!("make {name}"),
                "Makefile",
            );
        }
    }
    Ok(())
}

fn config_tasks(root: &Path, tasks: &mut Vec<TaskDefinition>) -> AppResult<()> {
    let Some(text) = read_config(root, ".tide/tasks.json")? else {
        return Ok(());
    };
    let config = serde_json::from_str::<TaskFile>(&text)
        .map_err(|error| AppError::p("task.configInvalid", [("error", error.to_string())]))?;
    for entry in config.tasks {
        if entry.id.trim().is_empty() || entry.command.trim().is_empty() {
            return Err(AppError::p(
                "task.configInvalid",
                [("error", "Task id and command must be nonempty".to_owned())],
            ));
        }
        let id = format!("custom:{}", entry.id.trim());
        if tasks.iter().any(|task| task.id == id) {
            return Err(AppError::p(
                "task.configInvalid",
                [("error", format!("Duplicate task id: {}", entry.id))],
            ));
        }
        let cwd = entry.cwd.unwrap_or_default().replace('\\', "/");
        task_cwd(root, &cwd)?;
        let label = entry
            .label
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(entry.id);
        tasks.push(TaskDefinition {
            id,
            label,
            command: entry.command,
            source: ".tide/tasks.json".into(),
            cwd,
        });
    }
    Ok(())
}

fn discover_tasks(root: &Path) -> AppResult<Vec<TaskDefinition>> {
    let mut tasks = Vec::new();
    config_tasks(root, &mut tasks)?;
    package_tasks(root, &mut tasks)?;
    make_tasks(root, &mut tasks)?;
    if root.join("Cargo.toml").is_file() {
        for action in ["check", "test", "build"] {
            push_task(
                &mut tasks,
                format!("cargo:{action}"),
                format!("cargo {action}"),
                format!("cargo {action}"),
                "Cargo.toml",
            );
        }
    }
    if root.join("go.mod").is_file() {
        for action in ["test", "build"] {
            push_task(
                &mut tasks,
                format!("go:{action}"),
                format!("go {action}"),
                format!("go {action} ./..."),
                "go.mod",
            );
        }
    }
    if ["pyproject.toml", "pytest.ini", "requirements.txt"]
        .iter()
        .any(|name| root.join(name).is_file())
    {
        push_task(
            &mut tasks,
            "python:test".into(),
            "pytest".into(),
            "python -m pytest".into(),
            "Python project",
        );
    }
    tasks.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    Ok(tasks)
}

#[tauri::command(async)]
pub fn task_list(
    window: tauri::Window,
    state: State<'_, AppState>,
    root: String,
) -> AppResult<Vec<TaskDefinition>> {
    let root_path = state.authorize(&root)?;
    if state.owner_window_of(&root_path).as_deref() != Some(window.label()) {
        return Err(AppError::c("workspace.notAuthorized"));
    }
    discover_tasks(&root_path)
}

#[tauri::command(async)]
pub fn task_run(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    root: String,
    id: String,
    command: String,
    cwd: String,
) -> AppResult<()> {
    // Close/release takes this same lock after revoking the grant, so a concurrent start is also reaped.
    let mut running = state.tasks.lock();
    let root_path = state.authorize(&root)?;
    if state.owner_window_of(&root_path).as_deref() != Some(window.label()) {
        return Err(AppError::c("workspace.notAuthorized"));
    }
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"_-".contains(&ch))
        || running.contains_key(&id)
    {
        return Err(AppError::p(
            "task.configInvalid",
            [("error", "Invalid execution id".to_owned())],
        ));
    }
    if running
        .values()
        .filter(|task| task.owner == window.label())
        .count()
        >= MAX_RUNNING_TASKS
    {
        return Err(AppError::p(
            "task.tooManyRunning",
            [("limit", MAX_RUNNING_TASKS.to_string())],
        ));
    }
    let command = command.trim();
    if command.is_empty() {
        return Err(AppError::c("task.emptyCommand"));
    }
    let cwd = task_cwd(&root_path, &cwd)?;
    let mut process = shell_command(command, &cwd);
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process
        .spawn()
        .map_err(|error| AppError::p("task.spawnFailed", [("error", error.to_string())]))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let owner = window.label().to_owned();
    let task = Arc::new(TaskProcess {
        child: Mutex::new(child),
        stopped: AtomicBool::new(false),
        owner: owner.clone(),
        root: root_path,
    });
    running.insert(id.clone(), task.clone());
    drop(running);
    let mut readers = Vec::new();
    if let Some(reader) = stdout {
        readers.push(emit_reader(app.clone(), owner.clone(), id.clone(), reader));
    }
    if let Some(reader) = stderr {
        readers.push(emit_reader(app.clone(), owner.clone(), id.clone(), reader));
    }
    std::thread::spawn(move || {
        let status = loop {
            let result = task.child.lock().try_wait();
            match result {
                Ok(Some(status)) => break Some(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => {
                    task.stop();
                    break None;
                }
            }
        };
        // Reap descendants retaining pipe handles before draining both readers and publishing exit.
        task.stop();
        for reader in readers {
            let _ = reader.join();
        }
        let code = status.as_ref().and_then(std::process::ExitStatus::code);
        let success = status.map(|value| value.success()).unwrap_or(false);
        app.state::<AppState>().tasks.lock().remove(&id);
        let _ = app.emit_to(
            owner.as_str(),
            "task:exit",
            TaskExitEvent { id, code, success },
        );
    });
    Ok(())
}

#[tauri::command(async)]
pub fn task_stop(window: tauri::Window, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let task = {
        let running = state.tasks.lock();
        running
            .get(&id)
            .filter(|task| task.owner == window.label())
            .cloned()
    };
    if let Some(task) = task {
        task.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "tide-tasks-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(crate::paths::canon(&path).unwrap())
        }
        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_scripts_targets_and_language_commands_without_executing_them() {
        let dir = TestDir::new();
        dir.write("package.json", r#"{"scripts":{"build":"vite build","lint:fix":"eslint --fix","empty":"","injected;echo":"bad","--help":"bad"}}"#);
        dir.write("pnpm-lock.yaml", "");
        dir.write(
            "Makefile",
            ".PHONY: test\ntest lint:\n\tprintf 'fake: target'\nVAR := value\n%.o: %.c\n",
        );
        for name in ["Cargo.toml", "go.mod", "pyproject.toml"] {
            dir.write(name, "");
        }
        let tasks = discover_tasks(&dir.0).unwrap();
        assert!(tasks
            .iter()
            .any(|task| task.id == "package:build" && task.command == "pnpm run build"));
        assert!(tasks.iter().any(|task| task.id == "package:lint:fix"));
        assert!(tasks.iter().any(|task| task.id == "make:test"));
        assert!(tasks.iter().any(|task| task.id == "make:lint"));
        assert!(tasks.iter().any(|task| task.id == "cargo:check"));
        assert!(tasks.iter().any(|task| task.id == "go:test"));
        assert!(tasks.iter().any(|task| task.id == "python:test"));
        assert!(!tasks.iter().any(|task| task.id.contains("injected")
            || task.id.contains("--help")
            || task.id == "make:VAR"
            || task.id == "package:empty"));
    }

    #[test]
    fn keeps_custom_cwd_separate_from_the_command() {
        let dir = TestDir::new();
        std::fs::create_dir(dir.0.join("folder with $ punctuation")).unwrap();
        dir.write(".tide/tasks.json", r#"{"tasks":[{"id":"test","label":"Test","command":"echo ok","cwd":"folder with $ punctuation"}]}"#);
        let tasks = discover_tasks(&dir.0).unwrap();
        assert_eq!(tasks[0].command, "echo ok");
        assert_eq!(tasks[0].cwd, "folder with $ punctuation");
        assert_eq!(
            task_cwd(&dir.0, &tasks[0].cwd).unwrap(),
            dir.0.join(&tasks[0].cwd)
        );
    }

    #[test]
    fn validates_config_ids_commands_size_and_working_directories() {
        let dir = TestDir::new();
        for text in [
            "{broken",
            r#"{"tasks":[{"id":"","command":"echo ok"}]}"#,
            r#"{"tasks":[{"id":"a","command":"  "}]}"#,
            r#"{"tasks":[{"id":"a","command":"one"},{"id":"a","command":"two"}]}"#,
            r#"{"tasks":[{"id":"a","command":"echo ok","cwd":"../outside"}]}"#,
            r#"{"tasks":[{"id":"a","command":"echo ok","cwd":"C:/outside"}]}"#,
        ] {
            dir.write(".tide/tasks.json", text);
            assert!(discover_tasks(&dir.0).is_err(), "accepted {text}");
        }
        dir.write(".tide/tasks.json", &" ".repeat(CONFIG_LIMIT as usize + 1));
        assert!(discover_tasks(&dir.0).is_err());
        dir.write("file.txt", "not a directory");
        assert!(task_cwd(&dir.0, "file.txt").is_err());
        assert!(task_cwd(&dir.0, "/outside").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_configs_and_working_directories_outside_the_root() {
        let root = TestDir::new();
        let outside = TestDir::new();
        outside.write("tasks.json", r#"{"tasks":[]}"#);
        std::os::unix::fs::symlink(&outside.0, root.0.join(".tide")).unwrap();
        assert!(discover_tasks(&root.0).is_err());
        std::os::unix::fs::symlink(&outside.0, root.0.join("escape")).unwrap();
        assert!(task_cwd(&root.0, "escape").is_err());
    }

    #[test]
    fn decodes_utf8_across_individual_pipe_bytes() {
        struct OneByte<'a>(&'a [u8]);
        impl Read for OneByte<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.0[0];
                self.0 = &self.0[1..];
                Ok(1)
            }
        }
        let text = "hello \u{1f642}\u{6c49}\u{5b57}";
        let mut output = String::new();
        read_output(OneByte(text.as_bytes()), |chunk| output.push_str(&chunk));
        assert_eq!(output, text);
        output.clear();
        read_output(&b"bad\xff\xe2"[..], |chunk| output.push_str(&chunk));
        assert_eq!(output, "bad\u{fffd}\u{fffd}");
    }

    fn live_process(root: &Path, owner: &str) -> Arc<TaskProcess> {
        #[cfg(windows)]
        let command = "ping -n 60 127.0.0.1 >NUL";
        #[cfg(not(windows))]
        let command = "sleep 60";
        let child = shell_command(command, root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Arc::new(TaskProcess {
            child: Mutex::new(child),
            stopped: AtomicBool::new(false),
            owner: owner.into(),
            root: root.to_path_buf(),
        })
    }

    #[test]
    fn root_release_and_window_cleanup_reap_only_their_owned_processes() {
        let dir = TestDir::new();
        let other_dir = TestDir::new();
        let state = AppState::default();
        state.register_root("main", &dir.0).unwrap();
        state.register_root("other", &other_dir.0).unwrap();
        let first = live_process(&dir.0, "main");
        let other = live_process(&other_dir.0, "other");
        state.tasks.lock().insert("first".into(), first.clone());
        state.tasks.lock().insert("other".into(), other.clone());
        let started = Instant::now();
        state.unregister_root("main", dir.0.to_str().unwrap());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(first.child.lock().try_wait().unwrap().is_some());
        assert!(other.child.lock().try_wait().unwrap().is_none());
        state.kill_window_tasks("other");
        assert!(other.child.lock().try_wait().unwrap().is_some());
        assert!(state.tasks.lock().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_descendants_and_releases_their_output_pipe() {
        let dir = TestDir::new();
        let mut child = shell_command("sleep 60 & wait", &dir.0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let process = TaskProcess {
            child: Mutex::new(child),
            stopped: AtomicBool::new(false),
            owner: "main".into(),
            root: dir.0.clone(),
        };
        process.stop();
        let mut output = String::new();
        stdout.read_to_string(&mut output).unwrap();
        assert!(process.child.lock().try_wait().unwrap().is_some());
        process.stop(); // Cleanup is idempotent after reaping.
    }
}
