use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_apple_nav);

#[cfg(not(target_os = "ios"))]
mod desktop {
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Runtime};

    #[cfg(target_os = "macos")]
    mod macos_ffi {
        use std::ffi::{c_char, c_void, CStr, CString};
        use std::sync::Mutex;
        use tauri::ipc::Channel;
        use tauri::{AppHandle, Manager, Runtime};

        extern "C" {
            fn apple_nav_mac_create(
                window_ptr: *mut c_void,
                callback: extern "C" fn(*const c_char),
            ) -> *mut c_void;
            fn apple_nav_mac_configure(
                plugin_ptr: *mut c_void,
                items_json: *const c_char,
                selected_index: i32,
                min_major: i32,
            ) -> bool;
            fn apple_nav_mac_select(plugin_ptr: *mut c_void, index: i32);
            fn apple_nav_mac_visibility(plugin_ptr: *mut c_void, hidden: bool);
            fn apple_nav_mac_appearance(
                plugin_ptr: *mut c_void,
                dark: bool,
                tint_hex: *const c_char,
            );
            fn apple_nav_mac_search(
                plugin_ptr: *mut c_void,
                visible: bool,
                placeholder: *const c_char,
                text: *const c_char,
                has_y: bool,
                y: f64,
                has_x: bool,
                x: f64,
                has_width: bool,
                width: f64,
            );
        }

        static CHANNEL: Mutex<Option<Channel<serde_json::Value>>> = Mutex::new(None);
        static PLUGIN_PTR: Mutex<Option<usize>> = Mutex::new(None);

        extern "C" fn callback_bridge(c_str: *const c_char) {
            if c_str.is_null() {
                return;
            }
            let s = unsafe { CStr::from_ptr(c_str) }.to_string_lossy();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Ok(guard) = CHANNEL.lock() {
                    if let Some(ref ch) = *guard {
                        let _ = ch.send(val);
                    }
                }
            }
        }

        pub fn get_or_create_plugin<R: Runtime>(app: &AppHandle<R>) -> Result<*mut c_void, String> {
            let mut guard = PLUGIN_PTR
                .lock()
                .map_err(|_| "Failed to lock plugin mutex".to_string())?;
            if let Some(ptr_val) = *guard {
                return Ok(ptr_val as *mut c_void);
            }

            let win = app
                .get_webview_window("main")
                .map(|w| w.as_ref().window().clone())
                .or_else(|| app.get_window("main"))
                .ok_or_else(|| "Main window not found".to_string())?;

            let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;
            let plugin_ptr = unsafe { apple_nav_mac_create(ns_win_ptr as *mut c_void, callback_bridge) };
            if plugin_ptr.is_null() {
                return Err("Failed to create macOS navigation plugin".to_string());
            }

            *guard = Some(plugin_ptr as usize);
            Ok(plugin_ptr)
        }

        pub fn set_channel(ch: Channel<serde_json::Value>) {
            if let Ok(mut guard) = CHANNEL.lock() {
                *guard = Some(ch);
            }
        }

        pub fn configure(
            plugin: *mut c_void,
            items_json: &str,
            selected: i32,
            min_major: i32,
        ) -> bool {
            let c_items = CString::new(items_json).unwrap_or_default();
            unsafe { apple_nav_mac_configure(plugin, c_items.as_ptr(), selected, min_major) }
        }

        pub fn select(plugin: *mut c_void, index: i32) {
            unsafe { apple_nav_mac_select(plugin, index) }
        }

        pub fn visibility(plugin: *mut c_void, hidden: bool) {
            unsafe { apple_nav_mac_visibility(plugin, hidden) }
        }

        pub fn appearance(plugin: *mut c_void, dark: bool, tint: Option<String>) {
            let c_tint = tint.and_then(|t| CString::new(t).ok());
            unsafe {
                apple_nav_mac_appearance(
                    plugin,
                    dark,
                    c_tint.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
                )
            }
        }

        pub fn search(
            plugin: *mut c_void,
            visible: bool,
            placeholder: Option<String>,
            text: Option<String>,
            y: Option<f64>,
            x: Option<f64>,
            width: Option<f64>,
        ) {
            let c_ph = placeholder.and_then(|s| CString::new(s).ok());
            let c_txt = text.and_then(|s| CString::new(s).ok());
            let has_y = y.is_some();
            let y_val = y.unwrap_or(0.0);
            let has_x = x.is_some();
            let x_val = x.unwrap_or(0.0);
            let has_width = width.is_some();
            let width_val = width.unwrap_or(0.0);
            unsafe {
                apple_nav_mac_search(
                    plugin,
                    visible,
                    c_ph.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
                    c_txt.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
                    has_y,
                    y_val,
                    has_x,
                    x_val,
                    has_width,
                    width_val,
                )
            }
        }
    }

    #[tauri::command]
    pub fn configure<R: Runtime>(
        app: AppHandle<R>,
        items: serde_json::Value,
        selected: Option<i32>,
        min_major: Option<i32>,
        on_event: Channel<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        #[cfg(target_os = "macos")]
        {
            let plugin = macos_ffi::get_or_create_plugin(&app)?;
            macos_ffi::set_channel(on_event);
            let items_str = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
            let sel = selected.unwrap_or(0);
            let min_ver = min_major.unwrap_or(0);
            let supported = macos_ffi::configure(plugin, &items_str, sel, min_ver);
            Ok(serde_json::json!({
                "supported": supported,
                "major": 26,
                "vertical": true
            }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, items, selected, min_major, on_event);
            Ok(serde_json::json!({ "supported": false }))
        }
    }

    #[tauri::command]
    pub fn select<R: Runtime>(app: AppHandle<R>, index: i32) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if let Ok(plugin) = macos_ffi::get_or_create_plugin(&app) {
                macos_ffi::select(plugin, index);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, index);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn visibility<R: Runtime>(app: AppHandle<R>, hidden: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if let Ok(plugin) = macos_ffi::get_or_create_plugin(&app) {
                macos_ffi::visibility(plugin, hidden);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, hidden);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn appearance<R: Runtime>(
        app: AppHandle<R>,
        dark: bool,
        tint: Option<String>,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if let Ok(plugin) = macos_ffi::get_or_create_plugin(&app) {
                macos_ffi::appearance(plugin, dark, tint);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, dark, tint);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn search<R: Runtime>(
        app: AppHandle<R>,
        visible: bool,
        placeholder: Option<String>,
        text: Option<String>,
        y: Option<f64>,
        x: Option<f64>,
        width: Option<f64>,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if let Ok(plugin) = macos_ffi::get_or_create_plugin(&app) {
                macos_ffi::search(plugin, visible, placeholder, text, y, x, width);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, visible, placeholder, text, y, x, width);
        }
        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    #[cfg(target_os = "ios")]
    {
        tauri::plugin::Builder::new("apple-nav")
            .setup(|_app, api| {
                let _handle = api.register_ios_plugin(init_plugin_apple_nav)?;
                Ok(())
            })
            .build()
    }
    #[cfg(not(target_os = "ios"))]
    {
        tauri::plugin::Builder::new("apple-nav")
            .invoke_handler(tauri::generate_handler![
                desktop::configure,
                desktop::select,
                desktop::visibility,
                desktop::appearance,
                desktop::search,
            ])
            .build()
    }
}
