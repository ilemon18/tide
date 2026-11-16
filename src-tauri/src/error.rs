use serde::ser::{Serialize, SerializeMap, Serializer};
use std::collections::BTreeMap;

/// Unified frontend/backend error type.
///
/// Two shapes:
/// - `new("...")`: raw text, used for git / formatter output; the frontend shows it as-is, untranslated;
/// - `c("io.notFound")` / `p("io.notFound", [..])`: error code + interpolation params, rendered by the
///   frontend in the UI language.
///
/// Serializes to `{ "code": "...", "params": { ... } }`; the frontend `errorText()` maps it to a language.
#[derive(Debug)]
pub struct AppError {
    pub code: &'static str,
    pub params: BTreeMap<&'static str, String>,
}

impl AppError {
    /// Raw text (external tool output, user-provided content): the frontend does not translate it
    pub fn new(message: impl Into<String>) -> Self {
        let mut params = BTreeMap::new();
        params.insert("message", message.into());
        Self {
            code: "message",
            params,
        }
    }

    /// Bare error code, no params
    pub fn c(code: &'static str) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
        }
    }

    /// Error code + params (param names must match the `{name}` placeholders in the frontend glossary)
    pub fn p<const N: usize>(code: &'static str, params: [(&'static str, String); N]) -> Self {
        Self {
            code,
            params: params.into_iter().collect(),
        }
    }

    /// IO error carrying a path: "not found" alone does not tell the user which path, leaving only guesswork.
    pub fn io(path: &std::path::Path, e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "io.notFound",
            std::io::ErrorKind::PermissionDenied => "io.permissionDenied",
            _ => "io.other",
        };
        Self::p(
            code,
            [
                ("path", path.display().to_string()),
                ("error", e.to_string()),
            ],
        )
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Used in logs / panic messages: the code plus params is enough to locate the problem
        write!(f, "{} {:?}", self.code, self.params)
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code)?;
        map.serialize_entry("params", &self.params)?;
        map.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::p("io.other", [("error", e.to_string())])
    }
}

pub type AppResult<T> = Result<T, AppError>;