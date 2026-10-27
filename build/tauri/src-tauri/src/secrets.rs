// Credential storage in the OS keychain (macOS and iOS Keychain, Windows Credential Manager).
// Other platforms report "unsupported" and the JS side (app/secureStore.js) keeps using localStorage.

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.majestictab.app", name).map_err(|e| e.to_string())
}

/// True when this platform has a keychain backend.
#[tauri::command]
pub fn secret_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "ios", target_os = "windows"))
}

/// The stored secret, or None when nothing is stored under `name`.
#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    return match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    };
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    {
        let _ = name;
        Err("unsupported".to_string())
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    return entry(&name)?.set_password(&value).map_err(|e| e.to_string());
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    {
        let _ = (name, value);
        Err("unsupported".to_string())
    }
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    return match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    {
        let _ = name;
        Err("unsupported".to_string())
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "ios", target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_secret() {
        let name = "majestictab_test_roundtrip".to_string();
        secret_set(name.clone(), "value-1".into()).unwrap();
        assert_eq!(secret_get(name.clone()).unwrap().as_deref(), Some("value-1"));
        secret_delete(name.clone()).unwrap();
        assert_eq!(secret_get(name).unwrap(), None);
    }
}
