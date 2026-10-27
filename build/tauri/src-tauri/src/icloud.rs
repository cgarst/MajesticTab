// iCloud Drive access through the operating system, with no network code of our own.
// macOS: iCloud Drive is a normal folder that the system keeps in step.
// iOS: the app's iCloud container, which the system syncs and shows in the Files app.
// Either way the JS side reads and writes plain files through the fs plugin.
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

#[cfg(target_os = "macos")]
fn drive_root() -> Result<Option<PathBuf>, String> {
    let Some(home) = std::env::var_os("HOME") else { return Ok(None) };
    let cloud_docs = PathBuf::from(home).join("Library/Mobile Documents/com~apple~CloudDocs");
    if !cloud_docs.is_dir() {
        return Ok(None);
    }
    let root = cloud_docs.join("MajesticTab");
    std::fs::create_dir_all(&root).map_err(|e| format!("Could not create the iCloud Drive folder: {e}"))?;
    Ok(Some(root))
}

#[cfg(target_os = "ios")]
fn drive_root() -> Result<Option<PathBuf>, String> {
    use objc2_foundation::NSFileManager;

    // Nil unless iCloud Drive is on, the user is signed in, and the build carries the iCloud entitlement
    let container = NSFileManager::defaultManager().URLForUbiquityContainerIdentifier(None);
    let Some(path) = container.and_then(|url| url.path()) else { return Ok(None) };
    // Only the Documents folder of a container is shown in the Files app
    let root = PathBuf::from(path.to_string()).join("Documents");
    std::fs::create_dir_all(&root).map_err(|e| format!("Could not create the iCloud Drive folder: {e}"))?;
    Ok(Some(root))
}

/// The folder MajesticTab uses inside iCloud Drive, or None when iCloud Drive is unavailable.
/// The folder is added to the fs plugin scope so the webview can read and write it.
#[tauri::command]
pub async fn icloud_drive_root(app: AppHandle) -> Result<Option<String>, String> {
    let Some(root) = drive_root()? else { return Ok(None) };
    app.fs_scope().allow_directory(&root, true).map_err(|e| e.to_string())?;
    Ok(Some(root.to_string_lossy().into_owned()))
}
