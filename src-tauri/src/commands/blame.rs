use std::process::Stdio;

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::proc;
use crate::state::{assert_inside, resolve_in_root, AppState};

/// Above this line count, skip blame: parsing and rendering cost too much.
const MAX_BLAME_LINES: usize = 5000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameRange {
    pub start_line: u32,
    pub line_count: u32,
    /// Line number in the commit that introduced this line (git blame orig line).
    pub orig_line: u32,
    pub sha: String,
    pub author: String,
    pub author_time: i64,
    pub summary: String,
    pub uncommitted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub disabled: bool,
    pub reason: Option<String>,
    pub line_count: u32,
    pub ranges: Vec<BlameRange>,
    pub latest: Option<BlameRange>,
    /// Sent to the frontend: hover cards need root + rel to look up commit details.
    pub root: String,
    pub rel: String,
}

fn disabled(reason: &str, root: &str, rel: &str) -> BlameResult {
    BlameResult {
        disabled: true,
        reason: Some(reason.to_string()),
        line_count: 0,
        ranges: Vec::new(),
        latest: None,
        root: root.to_string(),
        rel: rel.to_string(),
    }
}

fn push_line(
    ranges: &mut Vec<BlameRange>,
    line: u32,
    orig_line: u32,
    sha: &str,
    author: &str,
    time: i64,
    summary: &str,
) {
    let uncommitted = sha.chars().all(|c| c == '0');
    if let Some(last) = ranges.last_mut() {
        // orig line must be contiguous too, or the hover-row to original-line map drifts.
        if last.sha == sha
            && last.start_line + last.line_count == line
            && last.orig_line + last.line_count == orig_line
        {
            last.line_count += 1;
            return;
        }
    }
    ranges.push(BlameRange {
        start_line: line,
        line_count: 1,
        orig_line,
        sha: sha.to_string(),
        author: author.to_string(),
        author_time: time,
        summary: summary.to_string(),
        uncommitted,
    });
}

#[tauri::command(async)]
pub fn git_blame(state: State<'_, AppState>, root: String, rel: String) -> AppResult<BlameResult> {
    let root_path = state.authorize(&root)?;
    let root_str = root_path.to_string_lossy().to_string();

    let abs = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &abs)?;
    if let Ok(meta) = std::fs::metadata(&abs) {
        if meta.len() > MAX_FILE_BYTES {
            return Ok(disabled("File is large: inline blame is off", &root, &rel));
        }
    }

    let output = proc::command("git")
        .arg("-C")
        .arg(&root_str)
        .args(["blame", "--line-porcelain", "--", &rel])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output();

    let output = match output {
        Ok(output) => output,
        Err(e) => return Ok(disabled(&format!("git failed: {e}"), &root, &rel)),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr.lines().next().unwrap_or("This file has no commit history yet");
        return Ok(disabled(first, &root, &rel));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut ranges: Vec<BlameRange> = Vec::new();
    let mut line_count = 0u32;

    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.starts_with('\t') || line.is_empty() {
            continue;
        }

        let mut parts = line.split(' ');
        let sha = parts.next().unwrap_or("");
        let orig_line = parts.next();
        let final_line = parts.next();

        let is_header = sha.len() == 40
            && sha.chars().all(|c| c.is_ascii_hexdigit())
            && final_line.map(|v| v.parse::<u32>().is_ok()).unwrap_or(false);

        if !is_header {
            continue;
        }

        let final_line: u32 = final_line.and_then(|v| v.parse().ok()).unwrap_or(0);
        let orig_line: u32 = orig_line.and_then(|v| v.parse().ok()).unwrap_or(0);
        line_count += 1;
        if line_count as usize > MAX_BLAME_LINES {
            return Ok(disabled("Too many lines: inline blame is off", &root, &rel));
        }

        let mut author = String::new();
        let mut author_time = 0i64;
        let mut summary = String::new();

        // Header is followed by "key value" lines, then a content line starting with \t.
        while let Some(peek) = lines.clone().next() {
            if peek.starts_with('\t') || peek.is_empty() {
                break;
            }
            let Some(current) = lines.next() else { break };
            if let Some(v) = current.strip_prefix("author-mail ") {
                let _ = v;
            } else if let Some(v) = current.strip_prefix("author ") {
                author = v.to_string();
            } else if let Some(v) = current.strip_prefix("author-time ") {
                author_time = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = current.strip_prefix("summary ") {
                summary = v.to_string();
            }
        }
        // Consume the content line.
        let _ = lines.next();

        push_line(&mut ranges, final_line, orig_line, sha, &author, author_time, &summary);
    }

    let latest = ranges
        .iter()
        .filter(|r| !r.uncommitted)
        .max_by_key(|r| r.author_time)
        .cloned();

    Ok(BlameResult {
        disabled: false,
        reason: None,
        line_count,
        ranges,
        latest,
        root,
        rel,
    })
}