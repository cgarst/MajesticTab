//! The native iOS tab bar (a system `UITabBar`, Liquid Glass on iOS 26 and later) for the four library
//! destinations. The web layer sends the items and listens for taps; the commands are handled in Swift.
//! Other platforms get an empty plugin, so the web side falls back to its own tab bar.
use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_tabbar);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("ios-tabbar")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            let _handle = api.register_ios_plugin(init_plugin_ios_tabbar)?;
            #[cfg(not(target_os = "ios"))]
            let _ = api;
            Ok(())
        })
        .build()
}
