use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.googleauth";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_google_auth);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("google-auth")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            let _handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "GoogleAuthPlugin")?;
            #[cfg(target_os = "ios")]
            let _handle = api.register_ios_plugin(init_plugin_google_auth)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let _ = api;
            Ok(())
        })
        .build()
}