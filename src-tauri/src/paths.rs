//! Cross-platform path and file-write helpers.
//!
//! On Windows `std::fs::canonicalize` returns paths with a `\\?\` verbatim prefix: git rejects
//! them, the UI shows them ugly, and worse, event paths from `notify` come **without** that
//! prefix, so prefix comparisons between "workspace root vs event path" all fail on Windows
//! (the file tree stops refreshing incrementally and a `.git` outside the repo is not watched).
//! Every place that needs a normalized path goes through [`canon`] here.
//!
//! Windows also compares paths case-insensitively and can mix plain and verbatim forms (dunce keeps
//! the prefix when stripping it would change path semantics), so plain `Path::starts_with` misses;
//! [`is_inside`] / [`rel_in`] compare equivalent component forms instead.

#[cfg(windows)]
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Temp file sequence number: concurrent writes in one process each use their own temp file
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Normalize a path: resolve symlinks, drop `.` / `..`, and strip the Windows verbatim prefix.
///
/// dunce only strips it when that is safe (non-UTF-8 / over-long paths keep verbatim),
/// so it can replace `Path::canonicalize` unconditionally.
pub fn canon(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// User home directory: Windows has no `HOME`. Shared by the terminal and skill scans.
pub fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            if cfg!(windows) {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let rest = std::env::var_os("HOMEPATH")?;
                let mut path = PathBuf::from(drive);
                path.push(rest);
                Some(path)
            } else {
                None
            }
        })
}

/// Per-component comparison: case-insensitive on Windows, strict elsewhere.
#[cfg(not(windows))]
fn same_component(a: Component<'_>, b: Component<'_>) -> bool {
    a == b
}

/// Windows paths can describe the same location with or without a verbatim prefix. dunce keeps
/// that prefix for long and non-Unicode paths, so compare the equivalent prefix forms instead of
/// requiring callers to strip it (which can change path semantics).
#[cfg(windows)]
fn same_component(a: Component<'_>, b: Component<'_>) -> bool {
    use std::path::Prefix;

    match (a, b) {
        (Component::Prefix(a), Component::Prefix(b)) => match (a.kind(), b.kind()) {
            (Prefix::Disk(a), Prefix::Disk(b))
            | (Prefix::Disk(a), Prefix::VerbatimDisk(b))
            | (Prefix::VerbatimDisk(a), Prefix::Disk(b))
            | (Prefix::VerbatimDisk(a), Prefix::VerbatimDisk(b)) => a.eq_ignore_ascii_case(&b),
            (Prefix::UNC(server_a, share_a), Prefix::UNC(server_b, share_b))
            | (Prefix::UNC(server_a, share_a), Prefix::VerbatimUNC(server_b, share_b))
            | (Prefix::VerbatimUNC(server_a, share_a), Prefix::UNC(server_b, share_b))
            | (
                Prefix::VerbatimUNC(server_a, share_a),
                Prefix::VerbatimUNC(server_b, share_b),
            ) => same_os_str(server_a, server_b) && same_os_str(share_a, share_b),
            _ => a.as_os_str() == b.as_os_str(),
        },
        _ => same_os_str(a.as_os_str(), b.as_os_str()),
    }
}

#[cfg(windows)]
fn same_os_str(a: &OsStr, b: &OsStr) -> bool {
    a == b || a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Whether `path` is inside `root` (`root` itself included).
pub fn is_inside(root: &Path, path: &Path) -> bool {
    let mut rest = path.components();
    for want in root.components() {
        match rest.next() {
            Some(have) if same_component(have, want) => {}
            _ => return false,
        }
    }
    true
}

/// Take the part of `path` relative to `root`, always `/`-separated (the convention shared
/// by the frontend and git). Returns None when `path` is not inside `root`.
pub fn rel_in(root: &Path, path: &Path) -> Option<String> {
    let roots: Vec<Component<'_>> = root.components().collect();
    let parts: Vec<Component<'_>> = path.components().collect();
    if parts.len() < roots.len() {
        return None;
    }
    for (want, have) in roots.iter().zip(parts.iter()) {
        if !same_component(*have, *want) {
            return None;
        }
    }
    let mut out = String::new();
    for part in &parts[roots.len()..] {
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&part.as_os_str().to_string_lossy());
    }
    Some(out)
}

/// Why a selected path cannot be granted as a single external file.
#[derive(Debug)]
pub enum FileTargetError {
    /// The frontend must pass an absolute path; a relative path depends on an unspecified cwd.
    Relative,
    /// `.` / `..`, an empty name, or a path that names a directory
    Invalid,
    /// The path exists and is a directory
    NotFile,
    /// The final component is a symlink; reads never follow links on the user's behalf
    Symlink,
    /// The parent directory does not exist / cannot be canonicalized
    Io(std::io::Error),
}

/// Normalize a file selected for editing outside the workspace.
///
/// The parent directory must already exist (a save dialog can only name a file inside a real
/// directory). The final component is kept verbatim but never followed: an existing symlink or
/// directory is rejected. A missing file is allowed so "Save As" can create it; callers register
/// the returned path before the first write.
pub fn normalize_file_target(path: &Path) -> Result<PathBuf, FileTargetError> {
    if !path.is_absolute() {
        return Err(FileTargetError::Relative);
    }
    let mut last = None;
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) => {}
            Component::Normal(segment) => last = Some(segment.to_os_string()),
            Component::CurDir | Component::ParentDir => return Err(FileTargetError::Invalid),
        }
    }
    let Some(name) = last else {
        return Err(FileTargetError::Invalid);
    };
    if name.is_empty() {
        return Err(FileTargetError::Invalid);
    }
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).ok_or(FileTargetError::Invalid)?;
    let parent = canon(parent).map_err(FileTargetError::Io)?;
    let target = parent.join(&name);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => Err(FileTargetError::Symlink),
        Ok(meta) if !meta.is_file() => Err(FileTargetError::NotFile),
        Ok(_) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(e) => Err(FileTargetError::Io(e)),
    }
}

/// File / directory name validity. Windows rules are far stricter than POSIX; letting a bad
/// name through only turns into a vague IO error at the syscall, so reject it at the entry point.
/// Returns a reason code: empty | chars | reserved | trailing
pub fn invalid_name_reason(name: &str) -> Option<&'static str> {
    if name.is_empty() || name == "." || name == ".." {
        return Some("empty");
    }
    // Portable: a slash is the path separator and NUL truncates the string
    if name.contains('/') || name.contains('\0') {
        return Some("chars");
    }

    #[cfg(windows)]
    {
        // `\ : * ? " < > |` are all invalid on Windows
        if name.contains('\\')
            || name.contains(':')
            || name.contains('*')
            || name.contains('?')
            || name.contains('"')
            || name.contains('<')
            || name.contains('>')
            || name.contains('|')
        {
            return Some("chars");
        }
        // A trailing dot or space is silently eaten by the OS, so the created name differs from input
        if name.ends_with('.') || name.ends_with(' ') {
            return Some("trailing");
        }
        // CON / PRN / AUX / NUL / COM1-9 / LPT1-9 are device names, even with an extension
        let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit());
        if reserved {
            return Some("reserved");
        }
    }

    None
}

/// Whether a rename is worth retrying.
///
/// On Windows a file is often briefly opened by another process (antivirus scan, indexer,
/// another editor), and rename then returns sharing violation / access denied; a few retries
/// usually get through.
fn is_transient(e: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        // 5 = access denied, 32 = sharing violation, 33 = lock violation
        matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
    }
    #[cfg(not(windows))]
    {
        let _ = e;
        false
    }
}

/// rename, retrying on transient errors such as "file in use"
pub fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..5u64 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if !is_transient(&e) {
                    return Err(e);
                }
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(15 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Atomic write: temp file + rename, so a crash mid-write cannot corrupt the original.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target
        .parent()
        .ok_or_else(|| std::io::Error::other("missing parent directory"))?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    rename_retry(&tmp, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Whether a file is "hidden": the attribute bit on Windows, a `.` prefix elsewhere.
pub fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        // Treat system files (desktop.ini, pagefile.sys, ...) as hidden too, or Explorer gets noisy
        meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
            || name.starts_with('.')
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        name.starts_with('.')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_in_is_slash_separated() {
        let root = Path::new("/a/b");
        assert_eq!(rel_in(root, Path::new("/a/b/c/d.ts")), Some("c/d.ts".into()));
        assert_eq!(rel_in(root, root), Some("".into()));
        assert_eq!(rel_in(root, Path::new("/a/bc/d.ts")), None);
        assert!(is_inside(root, Path::new("/a/b/c")));
        assert!(!is_inside(root, Path::new("/a/bc")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_prefixes_are_equivalent() {
        let root = Path::new(r"c:\a\b");
        let verbatim = Path::new(r"\\?\C:\a\b\file.ts");
        assert!(is_inside(root, verbatim));
        assert_eq!(rel_in(root, verbatim), Some("file.ts".into()));
        assert!(is_inside(
            Path::new(r"\\?\C:\a\b"),
            Path::new(r"C:\a\B\other.ts")
        ));
        assert!(!is_inside(root, Path::new(r"C:\a\bc\file.ts")));

        let unc_root = Path::new(r"\\server\share\a");
        let verbatim_unc = Path::new(r"\\?\UNC\server\share\a\file.ts");
        assert_eq!(rel_in(unc_root, verbatim_unc), Some("file.ts".into()));
    }

    #[test]
    fn file_targets_require_absolute_existing_parents() {
        let root = std::env::temp_dir();
        let missing = root.join("tide-normalize-file-target-missing.txt");
        let _ = std::fs::remove_file(&missing);
        assert!(matches!(
            normalize_file_target(Path::new("relative.txt")),
            Err(FileTargetError::Relative)
        ));
        assert!(matches!(
            normalize_file_target(&root.join("..").join("escape.txt")),
            Err(FileTargetError::Invalid)
        ));
        assert!(matches!(
            normalize_file_target(&root),
            Err(FileTargetError::Invalid) | Err(FileTargetError::NotFile)
        ));
        let normalized = normalize_file_target(&missing).unwrap();
        // macOS temp dirs are symlinked (`/var` -> `/private/var`); the parent is canonicalized.
        assert_eq!(normalized.parent(), Some(canon(&root).unwrap().as_path()));
        assert_eq!(
            normalized.file_name().and_then(|name| name.to_str()),
            Some("tide-normalize-file-target-missing.txt")
        );
    }

    #[test]
    fn invalid_names_are_rejected() {
        assert_eq!(invalid_name_reason(""), Some("empty"));
        assert_eq!(invalid_name_reason("a/b"), Some("chars"));
        assert!(invalid_name_reason("src").is_none());
        #[cfg(windows)]
        {
            assert_eq!(invalid_name_reason("a:b"), Some("chars"));
            assert_eq!(invalid_name_reason("con.txt"), Some("reserved"));
            assert_eq!(invalid_name_reason("name."), Some("trailing"));
        }
    }
}
