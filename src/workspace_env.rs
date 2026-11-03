//! Opt-in project .env loading for one sandboxed workspace command.
//!
//! Do not inherit the SourceNerve daemon environment or export project secrets
//! into the daemon. Values belong only to the launched child process.
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use crate::error::{AppError, AppResult};

const MAX_ENV_BYTES: u64 = 64 * 1024;
const MAX_ENV_ENTRIES: usize = 128;
const MAX_ENV_VALUE_BYTES: usize = 8 * 1024;

fn valid_env_filename(name: &str) -> bool {
    if name.len() > 64 {
        return false;
    }
    name == ".env"
        || name.strip_prefix(".env.").is_some_and(|suffix| {
            !suffix.is_empty()
                && !suffix.starts_with('.')
                && !suffix.ends_with('.')
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        })
}

/// Protect the sanitized process environment and SourceNerve's own authority.
fn protected_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "PATH"
            | "HOME"
            | "USER"
            | "USERNAME"
            | "USERPROFILE"
            | "TMP"
            | "TEMP"
            | "TMPDIR"
            | "SYSTEMROOT"
            | "COMSPEC"
            | "PATHEXT"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "XDG_RUNTIME_DIR"
            | "XDG_CACHE_HOME"
            | "WAYLAND_DISPLAY"
            | "DISPLAY"
            | "DBUS_SESSION_BUS_ADDRESS"
            | "XAUTHORITY"
            | "GIT_TERMINAL_PROMPT"
            | "ENV"
            | "BASH_ENV"
            | "SHELLOPTS"
            | "BASHOPTS"
            | "IFS"
            | "CDPATH"
            | "NODE_OPTIONS"
            | "PYTHONPATH"
            | "PYTHONHOME"
            | "RUSTC_WRAPPER"
    ) || [
        "SOURCENERVE_",
        "LD_",
        "DYLD_",
        "GIT_",
        "BASH_FUNC_",
        "NPM_CONFIG_USERCONFIG",
    ]
    .iter()
    .any(|prefix| upper.starts_with(prefix))
}

fn project_env_path(root: &Path, cwd: &Path, name: &str) -> AppResult<PathBuf> {
    if !valid_env_filename(name) {
        return Err(AppError::InvalidRequest(
            "env_file must be .env or a .env.<name> basename in the selected workspace cwd".into(),
        ));
    }
    let root = root.canonicalize().map_err(|error| {
        AppError::Sandbox(format!(
            "failed to validate workspace root for env_file: {error}"
        ))
    })?;
    let cwd = cwd.canonicalize().map_err(|error| {
        AppError::Sandbox(format!(
            "failed to validate workspace cwd for env_file: {error}"
        ))
    })?;
    if !cwd.starts_with(&root) {
        return Err(AppError::PathOutsideWorkspace);
    }
    let candidate = cwd.join(name);
    let metadata = std::fs::symlink_metadata(&candidate).map_err(|error| {
        AppError::Sandbox(format!(
            "cannot read the explicitly selected project env_file: {error}"
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::InvalidRequest(
            "project env_file must be a regular file, not a symlink".into(),
        ));
    }
    if metadata.len() > MAX_ENV_BYTES {
        return Err(AppError::InvalidRequest(
            "project env_file exceeds the 64 KiB limit".into(),
        ));
    }
    let path = candidate.canonicalize().map_err(|error| {
        AppError::Sandbox(format!("failed to resolve the project env_file: {error}"))
    })?;
    if !path.starts_with(&root) {
        return Err(AppError::PathOutsideWorkspace);
    }
    Ok(path)
}

pub(crate) fn read_project_env(
    root: &Path,
    cwd: &Path,
    selected_file: Option<&str>,
) -> AppResult<BTreeMap<String, String>> {
    let Some(name) = selected_file else {
        return Ok(BTreeMap::new());
    };
    let path = project_env_path(root, cwd, name)?;
    let file = File::open(&path)
        .map_err(|error| AppError::Sandbox(format!("cannot open project env_file: {error}")))?;
    let mut raw = String::new();
    file.take(MAX_ENV_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|_| AppError::InvalidRequest("project env_file must contain UTF-8 text".into()))?;
    if raw.len() as u64 > MAX_ENV_BYTES {
        return Err(AppError::InvalidRequest(
            "project env_file exceeds the 64 KiB limit".into(),
        ));
    }
    let values = crate::env_file::parse_env_file(&raw).map_err(|error| {
        AppError::InvalidRequest(format!("malformed project env_file: {error}"))
    })?;
    if values.len() > MAX_ENV_ENTRIES {
        return Err(AppError::InvalidRequest(
            "project env_file exceeds the 128-variable limit".into(),
        ));
    }
    for (key, value) in &values {
        if protected_key(key) {
            return Err(AppError::InvalidRequest(format!(
                "project env_file cannot override protected execution variable {key}"
            )));
        }
        if value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0') {
            return Err(AppError::InvalidRequest(format!(
                "project env_file value for {key} is invalid or exceeds 8 KiB"
            )));
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_opt_in_project_env_and_preserves_quoted_values() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::write(
            root.path().join(".env"),
            "NODE_ENV=development\nAPI_BASE_URL='https://example.test/path?x=1'\n",
        )
        .expect("write test env");
        assert!(
            read_project_env(root.path(), root.path(), None)
                .expect("opt out")
                .is_empty()
        );
        let values =
            read_project_env(root.path(), root.path(), Some(".env")).expect("load project env");
        assert_eq!(values["NODE_ENV"], "development");
        assert_eq!(values["API_BASE_URL"], "https://example.test/path?x=1");
    }

    #[test]
    fn rejects_protected_variables_without_revealing_values() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::write(
            root.path().join(".env"),
            "SOURCENERVE_BEARER_TOKEN=private-token\n",
        )
        .expect("write test env");
        let error = read_project_env(root.path(), root.path(), Some(".env"))
            .expect_err("must reject credential overwrite");
        assert!(!error.to_string().contains("private-token"));
        assert!(error.to_string().contains("SOURCENERVE_BEARER_TOKEN"));
    }

    #[test]
    fn rejects_non_env_paths_and_accepts_named_project_env() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::write(root.path().join(".env.local"), "LOCAL_ONLY=yes\n").expect("write test env");
        assert_eq!(
            read_project_env(root.path(), root.path(), Some(".env.local")).expect("named env")["LOCAL_ONLY"],
            "yes"
        );
        for name in ["../.env", "other", ".env.", ".env..private", "/tmp/.env"] {
            assert!(
                read_project_env(root.path(), root.path(), Some(name)).is_err(),
                "{name}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_env_symlinks_including_external_targets() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().expect("fixture");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("secrets"), "VALUE=do-not-copy\n")
            .expect("outside file");
        symlink(outside.path().join("secrets"), root.path().join(".env")).expect("link");
        assert!(read_project_env(root.path(), root.path(), Some(".env")).is_err());
    }

    #[test]
    fn rejects_large_files_and_too_many_variables() {
        let root = tempfile::tempdir().expect("fixture");
        std::fs::write(
            root.path().join(".env"),
            format!("KEY={}\n", "a".repeat(65_536)),
        )
        .expect("large env");
        assert!(read_project_env(root.path(), root.path(), Some(".env")).is_err());
        let entries = (0..129)
            .map(|index| format!("KEY_{index}=a\n"))
            .collect::<String>();
        std::fs::write(root.path().join(".env"), entries).expect("large variable count");
        assert!(read_project_env(root.path(), root.path(), Some(".env")).is_err());
    }
}
