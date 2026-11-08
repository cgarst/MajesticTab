//! Fold and hinge state for the iPhone Duo. WKWebView does not expose Device Posture or Viewport Segments, so the
//! Swift side reads the division region and the hinge and the web layer listens (`src/foldState.js`). Other platforms
//! get an empty plugin and the web side stays in its normal layout.
use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_fold);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("ios-fold")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            let _handle = api.register_ios_plugin(init_plugin_ios_fold)?;
            #[cfg(not(target_os = "ios"))]
            let _ = api;
            Ok(())
        })
        .build()
}
