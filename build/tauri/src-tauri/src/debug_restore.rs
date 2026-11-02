//! Dev-only (`debug-tools` feature): restore a `.mtbackup` file into the running build at startup, so a test build can
//! start with real data. `run.sh --restore-backup` sets the environment; the frontend asks for the request, reads the
//! file's bytes, and runs the normal restore. It happens once per `run.sh` invocation: the dev watcher relaunches the
//! app on every Rust change, and a marker file keeps those relaunches (and webview reloads) from restoring again.
//!
//!   MAJESTICTAB_RESTORE_BACKUP  absolute path of the backup file
//!   MAJESTICTAB_RESTORE_MODE    `merge` (default, adds what is missing) or `wipe` (replaces everything)
//!   MAJESTICTAB_RESTORE_TOKEN   identifies the run.sh invocation (names the marker file)

use std::path::PathBuf;

#[derive(serde::Serialize)]
pub struct RestoreRequest {
    name: String,
    mode: &'static str,
    size: u64,
}

fn backup_path() -> Option<PathBuf> {
    std::env::var("MAJESTICTAB_RESTORE_BACKUP")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn marker() -> PathBuf {
    let token = std::env::var("MAJESTICTAB_RESTORE_TOKEN").unwrap_or_else(|_| "manual".into());
    let safe: String = token.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    std::env::temp_dir().join(format!("majestictab-restore-{safe}.done"))
}

/// The restore asked for by this run, or `None` when there is none or it has already been handed over.
#[tauri::command]
pub fn debug_restore_request() -> Option<RestoreRequest> {
    let path = backup_path()?;
    if marker().exists() {
        return None;
    }
    let meta = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m,
        _ => {
            eprintln!("[debug restore] backup file not found: {}", path.display());
            return None;
        }
    };
    Some(RestoreRequest {
        name: path.file_name()?.to_string_lossy().into_owned(),
        mode: if std::env::var("MAJESTICTAB_RESTORE_MODE").as_deref() == Ok("wipe") { "wipe" } else { "merge" },
        size: meta.len(),
    })
}

/// The backup's bytes, sent as binary (not a JSON array, which would be far too slow for a large backup). Marks the
/// restore as handed over.
#[tauri::command]
pub fn debug_restore_data() -> Result<tauri::ipc::Response, String> {
    let path = backup_path().ok_or("no backup requested")?;
    let data = std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let _ = std::fs::write(marker(), b"");
    Ok(tauri::ipc::Response::new(data))
}
