use std::fs;
use std::path::Path;

use ignore::overrides::{Override, OverrideBuilder};
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::state::{assert_inside, resolve_in_root, AppState};

/// Per-file search cap; larger files are skipped so huge build artifacts never load into memory.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Max length of each result preview.
const MAX_PREVIEW_CHARS: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
    /// Search scope relative to the workspace; None means the whole workspace.
    pub scope: Option<String>,
    /// Only search files matching these globs (comma / space separated, gitignore semantics).
    pub include: Option<String>,
    /// Exclude files matching these globs.
    pub exclude: Option<String>,
    pub max_results: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            regex: false,
            whole_word: false,
            scope: None,
            include: None,
            exclude: None,
            max_results: 500,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    /// Character offset of the match in this line (1-based); used for jumping and slicing.
    pub column: u32,
    pub length: u32,
    pub preview: String,
    /// Match start / visible length inside preview (for the strikethrough preview).
    pub preview_start: u32,
    pub preview_length: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub file: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub files: Vec<SearchFile>,
    pub total: usize,
    pub scanned: usize,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResponse {
    pub replaced_files: usize,
    pub replaced_matches: usize,
}
fn build_matcher(query: &str, options: &SearchOptions) -> AppResult<Regex> {
    let body = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        // Lookaround is not an option (Rust regex has none),
        // \b wrapping limits to whole words without swallowing adjacent chars.
        format!(r"\b(?:{body})\b")
    } else {
        body
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| AppError::p("search.invalidRegex", [("error", e.to_string())]))
}

/// Build a preview and map the match offset into char range inside the preview.
///
/// The preview trims leading whitespace and turns tabs into spaces, so the offset
/// must be remapped; if the match falls outside the 200-char window, cut from the
/// match instead so it is always visible in the replace preview.
fn preview_of(line: &str, match_byte_start: usize, match_chars: usize) -> (String, usize, usize) {
    let leading_ws = line.chars().take_while(|c| c.is_whitespace()).count();
    let match_char_start = line[..match_byte_start].chars().count();
    let rel = match_char_start.saturating_sub(leading_ws);

    let trimmed = line.trim();
    let (source, start) = if rel >= MAX_PREVIEW_CHARS {
        (trimmed.chars().skip(rel).collect::<String>(), 0usize)
    } else {
        (trimmed.to_string(), rel)
    };

    let mut out = String::with_capacity(source.len().min(MAX_PREVIEW_CHARS));
    for (i, ch) in source.chars().enumerate() {
        if i >= MAX_PREVIEW_CHARS {
            out.push('…');
            break;
        }
        out.push(if ch == '\t' { ' ' } else { ch });
    }

    let preview_chars = out.chars().count();
    let start = start.min(preview_chars);
    let len = match_chars.min(preview_chars.saturating_sub(start));
    (out, start, len)
}

/// Split input like "a, b *.ts" into individual patterns.
fn split_globs(value: &Option<String>) -> Vec<String> {
    value
        .as_deref()
        .unwrap_or("")
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Build include / exclude overrides with gitignore semantics (globset):
/// a pattern without `/` matches at any depth, `!` negates.
fn build_overrides(
    base: &Path,
    include: &Option<String>,
    exclude: &Option<String>,
) -> AppResult<Option<Override>> {
    let includes = split_globs(include);
    let excludes = split_globs(exclude);
    if includes.is_empty() && excludes.is_empty() {
        return Ok(None);
    }

    let mut builder = OverrideBuilder::new(base);
    for pattern in &includes {
        builder
            .add(pattern)
            .map_err(|e| {
                AppError::p(
                    "search.invalidInclude",
                    [("pattern", pattern.clone()), ("error", e.to_string())],
                )
            })?;
    }
    for pattern in &excludes {
        builder
            .add(&format!("!{pattern}"))
            .map_err(|e| {
                AppError::p(
                    "search.invalidExclude",
                    [("pattern", pattern.clone()), ("error", e.to_string())],
                )
            })?;
    }
    builder
        .build()
        .map(Some)
        .map_err(|e| AppError::p("search.invalidFilter", [("error", e.to_string())]))
}

fn resolve_base(root: &Path, scope: &Option<String>) -> AppResult<std::path::PathBuf> {
    match scope {
        Some(scope) if !scope.is_empty() => {
            let base = resolve_in_root(root, scope)?;
            assert_inside(root, &base)?;
            if base.is_dir() {
                Ok(base)
            } else {
                Ok(root.to_path_buf())
            }
        }
        _ => Ok(root.to_path_buf()),
    }
}

#[tauri::command(async)]
pub fn search_files(
    state: State<'_, AppState>,
    root: String,
    query: String,
    options: SearchOptions,
) -> AppResult<SearchResponse> {
    if query.is_empty() {
        return Ok(SearchResponse {
            files: Vec::new(),
            total: 0,
            scanned: 0,
            truncated: false,
        });
    }

    let root_path = state.authorize(&root)?;
    let base = resolve_base(&root_path, &options.scope)?;
    let matcher = build_matcher(&query, &options)?;
    let overrides = build_overrides(&base, &options.include, &options.exclude)?;

    let max_results = options.max_results.clamp(1, 2000);
    let max_files = 200usize;

    let mut files: Vec<SearchFile> = Vec::new();
    let mut total = 0usize;
    let mut scanned = 0usize;
    let mut truncated = false;

    // ignore::WalkBuilder respects .gitignore, matching VSCode's default search behavior.
    let mut walker_builder = WalkBuilder::new(&base);
    walker_builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .follow_links(false)
        .max_depth(Some(24))
        // Skip .git / node_modules style dirs even when not gitignored.
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".cache" | ".turbo"
            )
        });
    // Include / exclude from the search box: handed to ignore's overrides, globs like VSCode.
    if let Some(overrides) = overrides {
        walker_builder.overrides(overrides);
    }
    let walker = walker_builder.build();

    for entry in walker.flatten() {
        if total >= max_results {
            truncated = true;
            break;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        scanned += 1;

        let bytes = match fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if bytes.iter().take(4096).any(|b| *b == 0) {
            continue;
        }

        let text = String::from_utf8_lossy(&bytes);
        // Result paths stay relative to the workspace root so "open at line" can locate them.
        let rel = paths::rel_in(&root_path, entry.path())
            .unwrap_or_else(|| entry.path().to_string_lossy().replace('\\', "/"));

        let mut matches: Vec<SearchMatch> = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if total >= max_results {
                truncated = true;
                break;
            }
            let mut per_line = 0;
            for m in matcher.find_iter(line) {
                let matched_chars = m.as_str().chars().count();
                let (preview, preview_start, preview_length) =
                    preview_of(line, m.start(), matched_chars);
                matches.push(SearchMatch {
                    line: (index + 1) as u32,
                    // Char offset, not byte: frontend slicing and CodeMirror both work in chars.
                    column: (line[..m.start()].chars().count() + 1) as u32,
                    length: matched_chars as u32,
                    preview,
                    preview_start: preview_start as u32,
                    preview_length: preview_length as u32,
                });
                total += 1;
                per_line += 1;
                if per_line >= 20 || total >= max_results {
                    break;
                }
            }
        }

        if !matches.is_empty() {
            files.push(SearchFile { file: rel, matches });
            if files.len() >= max_files {
                truncated = true;
                break;
            }
        }
    }

    Ok(SearchResponse {
        files,
        total,
        scanned,
        truncated,
    })
}

/// Batch replace (the frontend confirms first).
#[tauri::command(async)]
pub fn replace_in_files(
    state: State<'_, AppState>,
    root: String,
    query: String,
    options: SearchOptions,
    replacement: String,
    files: Vec<String>,
) -> AppResult<ReplaceResponse> {
    let root_path = state.authorize(&root)?;
    let matcher = build_matcher(&query, &options)?;

    let mut replaced_files = 0usize;
    let mut replaced_matches = 0usize;

    for rel in files {
        let abs = resolve_in_root(&root_path, &rel)?;
        assert_inside(&root_path, &abs)?;
        let bytes = match fs::read(&abs) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if bytes.iter().take(4096).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        let count = matcher.find_iter(&text).count();
        if count == 0 {
            continue;
        }
        let next = matcher.replace_all(&text, regex::NoExpand(&replacement)).to_string();

        // Atomic write plus retry on contention (Windows files are briefly opened by
        // indexers / antivirus).
        paths::write_atomic(&abs, next.as_bytes())?;

        replaced_files += 1;
        replaced_matches += count;
    }

    Ok(ReplaceResponse {
        replaced_files,
        replaced_matches,
    })
}
/// Replace a single match at a known position: `line` and `column` are 1-based and use the same
/// character-based convention `search_files` reports, so clicking a result and replacing it always hits
/// that occurrence even when several identical matches share a line.
///
/// The match is looked up again instead of trusting the position: if the file changed since the search,
/// nothing is written and the response reports zero replaced matches.
#[tauri::command(async)]
pub fn replace_match(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    query: String,
    options: SearchOptions,
    replacement: String,
    line: u32,
    column: u32,
) -> AppResult<ReplaceResponse> {
    let root_path = state.authorize(&root)?;
    let abs = resolve_in_root(&root_path, &rel)?;
    assert_inside(&root_path, &abs)?;
    let matcher = build_matcher(&query, &options)?;

    let bytes = fs::read(&abs).map_err(|e| AppError::io(&abs, e))?;
    if bytes.iter().take(4096).any(|b| *b == 0) {
        return Ok(ReplaceResponse {
            replaced_files: 0,
            replaced_matches: 0,
        });
    }
    // Byte-exact slicing matters here (the replacement is spliced in), so no lossy conversion yet
    let text = String::from_utf8_lossy(&bytes).to_string();

    let mut line_start = 0usize;
    let mut target: Option<(usize, usize)> = None;
    for (index, raw_line) in text.split('\n').enumerate() {
        if (index + 1) as u32 == line {
            for m in matcher.find_iter(raw_line) {
                let col = raw_line[..m.start()].chars().count() + 1;
                if col as u32 == column {
                    target = Some((line_start + m.start(), line_start + m.end()));
                    break;
                }
            }
            break;
        }
        // +1 for the '\n' that split() consumed
        line_start += raw_line.len() + 1;
    }

    let Some((start, end)) = target else {
        return Ok(ReplaceResponse {
            replaced_files: 0,
            replaced_matches: 0,
        });
    };

    let mut next = String::with_capacity(text.len() + replacement.len());
    next.push_str(&text[..start]);
    next.push_str(&replacement);
    next.push_str(&text[end..]);

    paths::write_atomic(&abs, next.as_bytes())?;
    Ok(ReplaceResponse {
        replaced_files: 1,
        replaced_matches: 1,
    })
}
