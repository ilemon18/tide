use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::proc;
use crate::state::{assert_inside, resolve_in_root, AppState};

/// Above this line count, skip blame: parsing and rendering cost too much.
const MAX_BLAME_LINES: usize = 5000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// A stuck blame must never leave the editor waiting forever.
const BLAME_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameRange {
    pub start_line: u32,
    pub line_count: u32,
    /// Line number in the commit that introduced this line (git blame orig line).
    pub orig_line: u32,
    /// Path the line had inside the introducing commit: the rename-aware diff target.
    pub orig_path: String,
    pub sha: String,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub summary: String,
    pub uncommitted: bool,
    pub previous_sha: Option<String>,
    pub previous_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub disabled: bool,
    pub reason: Option<String>,
    pub line_count: u32,
    pub ranges: Vec<BlameRange>,
    /// Sent to the frontend: hover cards need root + rel to look up commit details.
    pub root: String,
    pub rel: String,
    /// Git identity of the current user, used to render `You` on their own lines.
    pub current_user_name: String,
    pub current_user_email: String,
    /// Editor buffer version this result belongs to (0 for disk reads).
    pub version: u64,
}

fn disabled(reason: &str, root: &str, rel: &str, version: u64) -> BlameResult {
    BlameResult {
        disabled: true,
        reason: Some(reason.to_string()),
        line_count: 0,
        ranges: Vec::new(),
        root: root.to_string(),
        rel: rel.to_string(),
        current_user_name: String::new(),
        current_user_email: String::new(),
        version,
    }
}

/// `author-mail <foo@bar>` → `foo@bar`: the angle brackets are porcelain decoration, not the address.
fn clean_email(value: &str) -> String {
    value.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

fn is_zero_sha(sha: &str) -> bool {
    !sha.is_empty() && sha.chars().all(|c| c == '0')
}

fn header(line: &str) -> Option<(&str, u32, u32)> {
    let mut parts = line.split(' ');
    let sha = parts.next()?;
    let orig = parts.next()?;
    let final_line = parts.next()?;
    // SHA-1 is 40 hex digits, SHA-256 repositories use 64.
    if !(sha.len() == 40 || sha.len() == 64) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some((sha, orig.parse().ok()?, final_line.parse().ok()?))
}

/// Parse `git blame --line-porcelain` output into row ranges.
///
/// Each block repeats the full metadata (author, summary, filename, previous) because of
/// `--line-porcelain`; `filename` is the path inside the introducing commit, which keeps hover
/// diffs correct across renames.
pub fn parse_blame_porcelain(text: &str, rel: &str) -> (u32, Vec<BlameRange>) {
    let mut ranges: Vec<BlameRange> = Vec::new();
    let mut line_count = 0u32;
    let mut lines = text.lines();

    while let Some(line) = lines.next() {
        if line.starts_with('\t') || line.is_empty() {
            continue;
        }
        let Some((sha, orig_line, final_line)) = header(line) else {
            continue;
        };

        let mut author = String::new();
        let mut author_email = String::new();
        let mut author_time = 0i64;
        let mut summary = String::new();
        let mut orig_path = rel.to_string();
        let mut previous_sha: Option<String> = None;
        let mut previous_path: Option<String> = None;

        // Metadata runs until the tab-prefixed content line of this blame block.
        while let Some(meta) = lines.next() {
            if meta.starts_with('\t') || meta.is_empty() {
                break;
            }
            if let Some(value) = meta.strip_prefix("author-mail ") {
                author_email = clean_email(value);
            } else if let Some(value) = meta.strip_prefix("author ") {
                author = value.to_string();
            } else if let Some(value) = meta.strip_prefix("author-time ") {
                author_time = value.trim().parse().unwrap_or(0);
            } else if let Some(value) = meta.strip_prefix("summary ") {
                summary = value.to_string();
            } else if let Some(value) = meta.strip_prefix("filename ") {
                orig_path = value.to_string();
            } else if let Some(value) = meta.strip_prefix("previous ") {
                let value = value.trim();
                let (sha, path) = match value.split_once(' ') {
                    Some((sha, path)) => (sha, path.trim()),
                    None => (value, ""),
                };
                if !sha.is_empty() {
                    previous_sha = Some(sha.to_string());
                }
                if !path.is_empty() {
                    previous_path = Some(path.to_string());
                }
            }
            // `boundary` and other porcelain keys carry no card data; consuming them here keeps the
            // loop aligned with the content line that follows.
        }

        line_count = line_count.saturating_add(1);
        let uncommitted = is_zero_sha(sha);
        if let Some(last) = ranges.last_mut() {
            // Consecutive rows merge only when they stay on the same contiguous orig path + lines:
            // otherwise the hover-row → original-line map drifts.
            if last.sha == sha
                && last.orig_path == orig_path
                && last.start_line + last.line_count == final_line
                && last.orig_line + last.line_count == orig_line
            {
                last.line_count += 1;
                continue;
            }
        }
        ranges.push(BlameRange {
            start_line: final_line,
            line_count: 1,
            orig_line,
            orig_path,
            sha: sha.to_string(),
            author: author.clone(),
            author_email: author_email.clone(),
            author_time,
            summary,
            uncommitted,
            previous_sha,
            previous_path,
        });
    }

    (line_count, ranges)
}

/// Cache `git config user.name/user.email` by root: the identity changes rarely, and a hover or a
/// background prefetch must not spawn two extra git processes each time.
fn user_identity(root: &str) -> (String, String) {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(root).cloned()) {
        return hit;
    }
    let read = |key: &str| -> String {
        proc::command("git")
            .arg("-C")
            .arg(root)
            .args(["config", "--get", key])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let identity = (read("user.name"), read("user.email"));
    if let Ok(mut guard) = cache.lock() {
        guard.insert(root.to_string(), identity.clone());
    }
    identity
}

/// Run blame, feeding the editor buffer through `--contents -` when present.
fn run_blame(root: &str, rel: &str, contents: Option<&str>) -> Result<String, String> {
    let mut cmd = proc::command("git");
    cmd.arg("-C")
        .arg(root)
        // Non-ASCII paths must stay readable in `filename` instead of octal escapes.
        .args(["-c", "core.quotePath=false"])
        .args(["blame", "--line-porcelain", "--root", "-M"]);
    if contents.is_some() {
        cmd.args(["--contents", "-"]);
    }
    cmd.args(["--", rel])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(if contents.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("git failed: {e}"))?;

    if let Some(text) = contents {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "git stdin is unavailable".to_string())?;
        let bytes = text.as_bytes().to_vec();
        // Write on a worker thread: a large buffer must not block the deadline while git is busy.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
            // Dropping stdin closes the pipe and lets blame finish reading.
        });
    }

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout is unavailable".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr is unavailable".to_string())?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout_pipe.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr_pipe.read_to_end(&mut bytes).map(|_| bytes)
    });

    let deadline = Instant::now() + BLAME_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Timed out: inline blame is off".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git failed: {error}"));
            }
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "git stdout reader failed".to_string())?
        .map_err(|e| format!("git failed: {e}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "git stderr reader failed".to_string())?
        .map_err(|e| format!("git failed: {e}"))?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let first = stderr
            .lines()
            .next()
            .unwrap_or("This file has no commit history yet");
        return Err(first.to_string());
    }
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

fn blame_file(root: &str, rel: &str, contents: Option<&str>, version: u64) -> BlameResult {
    if let Some(text) = contents {
        if text.len() as u64 > MAX_FILE_BYTES {
            return disabled("File is large: inline blame is off", root, rel, version);
        }
        if text.lines().count() > MAX_BLAME_LINES {
            return disabled("Too many lines: inline blame is off", root, rel, version);
        }
    }

    let text = match run_blame(root, rel, contents) {
        Ok(text) => text,
        Err(reason) => return disabled(&reason, root, rel, version),
    };

    let (line_count, ranges) = parse_blame_porcelain(&text, rel);
    if line_count as usize > MAX_BLAME_LINES {
        return disabled("Too many lines: inline blame is off", root, rel, version);
    }
    let (current_user_name, current_user_email) = user_identity(root);

    BlameResult {
        disabled: false,
        reason: None,
        line_count,
        ranges,
        root: root.to_string(),
        rel: rel.to_string(),
        current_user_name,
        current_user_email,
        version,
    }
}

#[tauri::command(async)]
pub fn git_blame(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    contents: Option<String>,
    version: u64,
) -> AppResult<BlameResult> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();

    let abs = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &abs)?;
    if contents.is_none() {
        if let Ok(meta) = std::fs::metadata(&abs) {
            if meta.len() > MAX_FILE_BYTES {
                return Ok(disabled(
                    "File is large: inline blame is off",
                    &root,
                    &rel,
                    version,
                ));
            }
        }
    }

    let mut result = blame_file(&root_str, &rel, contents.as_deref(), version);
    // Hover/diff calls are made with this value, exactly as the frontend knows the workspace root.
    result.root = root;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{blame_file, parse_blame_porcelain, MAX_BLAME_LINES};
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sha(ch: char) -> String {
        std::iter::repeat(ch).take(40).collect()
    }

    fn block(sha: &str, orig: u32, final_line: u32, extra: &str, content: &str) -> String {
        format!(
            "{sha} {orig} {final_line} 1\n\
             author Ada\n\
             author-mail <ada@example.com>\n\
             author-time 1700000000\n\
             author-tz +0000\n\
             committer Ada\n\
             committer-mail <ada@example.com>\n\
             committer-time 1700000000\n\
             committer-tz +0000\n\
             {extra}summary Add a thing\n\
             \t{content}\n",
            sha = sha,
            orig = orig,
            final_line = final_line,
            extra = extra,
            content = content,
        )
    }

    #[test]
    fn parses_a_plain_commit_block() {
        let text = block(&sha('a'), 10, 1, "boundary\n", "let x = 1;");
        let (count, ranges) = parse_blame_porcelain(&text, "src/a.ts");
        assert_eq!(count, 1);
        assert_eq!(ranges.len(), 1);
        let range = &ranges[0];
        assert_eq!(range.start_line, 1);
        assert_eq!(range.line_count, 1);
        assert_eq!(range.orig_line, 10);
        assert_eq!(range.orig_path, "src/a.ts");
        assert_eq!(range.sha, sha('a'));
        assert_eq!(range.author, "Ada");
        assert_eq!(range.author_email, "ada@example.com");
        assert_eq!(range.author_time, 1_700_000_000);
        assert_eq!(range.summary, "Add a thing");
        assert!(!range.uncommitted);
        assert_eq!(range.previous_sha, None);
    }

    #[test]
    fn keeps_the_commit_path_and_previous_for_renames() {
        let text = block(
            &sha('b'),
            3,
            2,
            "previous 1111111111111111111111111111111111111111 old/name.ts\nfilename new/name.ts\n",
            "renamed line",
        );
        let (_, ranges) = parse_blame_porcelain(&text, "new/name.ts");
        assert_eq!(ranges[0].orig_path, "new/name.ts");
        assert_eq!(
            ranges[0].previous_sha.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert_eq!(ranges[0].previous_path.as_deref(), Some("old/name.ts"));
    }

    #[test]
    fn treats_all_zero_sha_as_uncommitted() {
        let zeros = "0".repeat(40);
        let text = block(&zeros, 1, 1, "", "unsaved");
        let (_, ranges) = parse_blame_porcelain(&text, "a.ts");
        assert!(ranges[0].uncommitted);
        assert_eq!(ranges[0].sha, zeros);
    }

    #[test]
    fn accepts_sha256_repositories() {
        let long = "c".repeat(64);
        let text = block(&long, 4, 1, "", "sha256");
        let (_, ranges) = parse_blame_porcelain(&text, "a.ts");
        assert_eq!(ranges[0].sha, long);
        assert_eq!(ranges[0].orig_line, 4);
    }

    #[test]
    fn merges_contiguous_rows_but_not_a_jumping_original_line() {
        let a = sha('a');
        let text = format!(
            "{}{}{}",
            block(&a, 1, 1, "", "one"),
            block(&a, 2, 2, "", "two"),
            block(&a, 9, 3, "", "three"),
        );
        let (count, ranges) = parse_blame_porcelain(&text, "a.ts");
        assert_eq!(count, 3);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].line_count, 2);
        assert_eq!(ranges[1].orig_line, 9);
    }

    static NEXT_REPO: AtomicU64 = AtomicU64::new(0);

    struct TestRepo {
        root: PathBuf,
    }

    impl TestRepo {
        fn new() -> Self {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let ordinal = NEXT_REPO.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tide-blame-{}-{timestamp}-{ordinal}",
                std::process::id(),
            ));
            std::fs::create_dir_all(&root).unwrap();
            let repo = Self {
                root: crate::paths::canon(&root).unwrap(),
            };
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.name", "Tide tests"]);
            repo.git(&["config", "user.email", "tests@example.invalid"]);
            repo.git(&["config", "core.autocrlf", "false"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .stdin(Stdio::null())
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).to_string()
        }

        fn write(&self, rel: &str, content: &str) {
            std::fs::write(self.root.join(rel), content).unwrap();
        }

        fn commit(&self, message: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", message]);
        }

        fn path(&self) -> &str {
            self.root.to_str().unwrap()
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn blames_editor_contents_through_stdin() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\ntwo\n");
        repo.commit("initial");
        repo.write("a.txt", "one\nTWO\nthree\n");

        let result = blame_file(repo.path(), "a.txt", Some("one\nTWO\nthree\n"), 7);
        assert!(!result.disabled, "{:?}", result.reason);
        assert_eq!(result.version, 7);
        assert_eq!(result.line_count, 3);
        let last = result.ranges.last().unwrap();
        assert!(last.uncommitted, "the edited buffer line is uncommitted");
        assert_eq!(last.start_line, 2);
        assert_eq!(result.current_user_email, "tests@example.invalid");
    }

    #[test]
    fn disables_blame_above_the_line_limit() {
        let repo = TestRepo::new();
        let content = "line\n".repeat(MAX_BLAME_LINES + 1);
        let result = blame_file(repo.path(), "big.txt", Some(content.as_str()), 1);
        assert!(result.disabled);
        assert!(result.reason.unwrap().contains("Too many lines"));
    }

    #[test]
    fn reports_a_missing_file_as_disabled_not_an_error() {
        let repo = TestRepo::new();
        let result = blame_file(repo.path(), "missing.txt", None, 0);
        assert!(result.disabled);
    }
}
