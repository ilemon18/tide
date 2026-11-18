//! Skill discovery for the composer's `$` picker.
//!
//! Only known directories are scanned (never a user-supplied path): the open project's
//! `.agents/skills` / `.claude/skills`, plus the user's own Claude and Codex skill folders.
//! The scan is read-only metadata; the agent itself reads SKILL.md when the prompt points at it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::paths;

/// A skill whose SKILL.md is bigger than this is not worth parsing for a picker row.
const MAX_FILE: u64 = 64 * 1024;
const MAX_SKILLS: usize = 500;
const MAX_DESCRIPTION_CHARS: usize = 160;
const MAX_NAME_CHARS: usize = 80;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// Workspace-relative for project skills, absolute for user-level skills.
    pub path: String,
    pub source: &'static str,
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut out: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        out.push('…');
    }
    out
}

fn clean_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let unquoted = if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    };
    let unquoted = unquoted.trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

/// Minimal YAML frontmatter reader: `name` / `description`, with folded or literal
/// block values. Anything more elaborate falls back to the body text.
pub fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines().map(|line| line.trim_end_matches('\r'));
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }

    let mut name = None;
    let mut description = None;
    let mut current: Option<&str> = None;
    let mut block: Vec<String> = Vec::new();
    let mut block_folded = false;

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if current.is_some() && !indented && !trimmed.is_empty() {
            // A new key ends the block value that was being collected.
            let value = block.join(if block_folded { " " } else { "\n" });
            let value = clean_value(&value);
            match current {
                Some("description") => description = value,
                Some("name") => name = value,
                _ => {}
            }
            block.clear();
            current = None;
        }
        if let Some(rest) = line.strip_prefix("name:") {
            name = clean_value(rest);
            continue;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            let rest = rest.trim();
            if rest == ">" || rest == ">-" || rest == "|" || rest == "|-" || rest == ">+" || rest == "|+" {
                current = Some("description");
                block_folded = rest.starts_with('>');
                block.clear();
            } else {
                description = clean_value(rest);
            }
            continue;
        }
        if current.is_some() && indented {
            block.push(trimmed.to_string());
        }
    }

    if let Some(key) = current {
        let value = clean_value(&block.join(if block_folded { " " } else { "\n" }));
        match key {
            "description" => description = value,
            "name" => name = value,
            _ => {}
        }
    }

    (name, description)
}

/// First real paragraph after the frontmatter, used when the description is missing.
pub fn fallback_description(text: &str) -> Option<String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut body = text;
    if text.trim_start().starts_with("---") {
        let mut offset = 0usize;
        let mut markers = 0usize;
        for line in text.split_inclusive('\n') {
            offset += line.len();
            if line.trim() == "---" {
                markers += 1;
                if markers == 2 {
                    body = &text[offset..];
                    break;
                }
            }
        }
    }
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("<!--") {
            continue;
        }
        return Some(truncate_chars(line, MAX_DESCRIPTION_CHARS));
    }
    None
}

fn parse_skill(path: &Path, source: &'static str, dir_name: &str) -> Option<SkillInfo> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let (name, description) = parse_frontmatter(&text);
    let name = name
        .or_else(|| Some(dir_name.to_string()))?
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }
    let description = description
        .or_else(|| fallback_description(&text))
        .unwrap_or_default();
    Some(SkillInfo {
        name: truncate_chars(&name, MAX_NAME_CHARS),
        description: truncate_chars(&description, MAX_DESCRIPTION_CHARS),
        path: path.display().to_string(),
        source,
    })
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| paths::home_dir().map(|home| home.join(".codex")))
}

fn source_dirs(root: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut dirs: Vec<(PathBuf, &'static str)> = vec![
        (root.join(".agents/skills"), "project"),
        (root.join(".claude/skills"), "project"),
    ];
    if let Some(home) = paths::home_dir() {
        dirs.push((home.join(".claude/skills"), "user"));
    }
    if let Some(codex) = codex_home() {
        dirs.push((codex.join("skills"), "user"));
    }
    dirs
}

/// Scan every known skill directory. Missing / unreadable directories are skipped; the
/// picker simply shows what is available.
pub fn scan(root: &Path) -> Vec<SkillInfo> {
    let mut skills: Vec<SkillInfo> = Vec::new();
    let mut seen_files: HashSet<PathBuf> = HashSet::new();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();

    for (dir, source) in source_dirs(root) {
        let dir_key = paths::canon(&dir).unwrap_or_else(|_| dir.clone());
        if !seen_dirs.insert(dir_key) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        names.sort();
        for skill_dir in names {
            let file = skill_dir.join("SKILL.md");
            let file_key = paths::canon(&file).unwrap_or_else(|_| file.clone());
            if !seen_files.insert(file_key) {
                continue;
            }
            let dir_name = skill_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            let Some(mut skill) = parse_skill(&file, source, &dir_name) else {
                continue;
            };
            if source == "project" {
                if let Ok(rel) = file.strip_prefix(root) {
                    skill.path = rel.to_string_lossy().replace('\\', "/");
                }
            }
            skills.push(skill);
            if skills.len() >= MAX_SKILLS {
                break;
            }
        }
        if skills.len() >= MAX_SKILLS {
            break;
        }
    }

    skills.sort_by(|a, b| {
        (a.source == "user")
            .cmp(&(b.source == "user"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    skills
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_frontmatter() {
        let (name, description) = parse_frontmatter("---\nname: verify\ndescription: Run the checks\n---\n# Body\n");
        assert_eq!(name.as_deref(), Some("verify"));
        assert_eq!(description.as_deref(), Some("Run the checks"));
    }

    #[test]
    fn reads_quoted_values_and_folded_description() {
        let text = "---\nname: \"git-go\"\ndescription: >\n  Create a branch\n  and cherry-pick\n---\n";
        let (name, description) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("git-go"));
        assert_eq!(description.as_deref(), Some("Create a branch and cherry-pick"));
    }

    #[test]
    fn missing_frontmatter_falls_back_to_body() {
        let text = "# Title\n\nUse this skill for reviews.\n";
        assert_eq!(parse_frontmatter(text).0, None);
        assert_eq!(
            fallback_description(text).as_deref(),
            Some("Use this skill for reviews.")
        );
    }

    #[test]
    fn fallback_skips_frontmatter_and_headings() {
        let text = "---\nname: x\n---\n# Heading\n\nReal description.\n";
        assert_eq!(fallback_description(text).as_deref(), Some("Real description."));
    }
}
