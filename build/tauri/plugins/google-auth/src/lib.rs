use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.googleauth";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("google-auth")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            let _handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "GoogleAuthPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}