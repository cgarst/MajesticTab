use std::ffi::{c_char, CStr};
use std::sync::Mutex;
use std::time::Duration;

use block2::RcBlock;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_ui_kit::UIColor;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::youtube_page::PLAYER_HTML;

/// iOS has no child webviews in Tauri, so the player is a plain WKWebView added next to the
/// main one. State is read back by polling a queue in the page instead of a script message handler.
#[derive(Default)]
pub struct PlayerState {
    /// Address of the player WKWebView; only touched on the main thread.
    webview: Mutex<usize>,
    video_id: Mutex<Option<String>>,
}

const QUEUE_SCRIPT: &str = "window.ytQueue = []; window.ytDrain = () => JSON.stringify(window.ytQueue.splice(0));";

fn nsstring(value: &str) -> objc2::rc::Retained<NSString> {
    NSString::from_str(value)
}

unsafe fn eval(webview: *mut AnyObject, script: &str) {
    let js = nsstring(script);
    let _: () = msg_send![webview, evaluateJavaScript: &*js, completionHandler: std::ptr::null::<AnyObject>()];
}

unsafe fn create_player(main: *mut AnyObject) -> *mut AnyObject {
    let config: *mut AnyObject = msg_send![AnyClass::get(c"WKWebViewConfiguration").unwrap(), new];
    let _: () = msg_send![config, setAllowsInlineMediaPlayback: true];
    // WKAudiovisualMediaTypeNone: allow autoplay without a user gesture inside the player.
    let _: () = msg_send![config, setMediaTypesRequiringUserActionForPlayback: 0usize];

    let frame = NSRect::new(NSPoint::new(-10000.0, -10000.0), NSSize::new(1.0, 1.0));
    let alloc: *mut AnyObject = msg_send![AnyClass::get(c"WKWebView").unwrap(), alloc];
    let webview: *mut AnyObject = msg_send![alloc, initWithFrame: frame, configuration: config];

    let black = UIColor::blackColor();
    let _: () = msg_send![webview, setOpaque: false];
    let _: () = msg_send![webview, setBackgroundColor: &*black];
    let _: () = msg_send![webview, setInspectable: true];
    let _: () = msg_send![webview, setClipsToBounds: true];
    let layer: *mut AnyObject = msg_send![webview, layer];
    if !layer.is_null() {
        let _: () = msg_send![layer, setCornerRadius: 11.0f64];
    }
    let scroll_view: *mut AnyObject = msg_send![webview, scrollView];
    if !scroll_view.is_null() {
        let _: () = msg_send![scroll_view, setScrollEnabled: false];
    }

    let superview: *mut AnyObject = msg_send![main, superview];
    if !superview.is_null() {
        let _: () = msg_send![superview, addSubview: webview];
    }

    let html = nsstring(&PLAYER_HTML.replace(
        "window.postMessage(data, '*');",
        "window.ytQueue.push(data); if (window.ytQueue.length > 50) window.ytQueue.shift();",
    ).replace("<script>", &format!("<script>\n{QUEUE_SCRIPT}")));
    if let Some(base_url) = NSURL::URLWithString(&nsstring("https://net.zathu.majestictab")) {
        let _: *mut AnyObject = msg_send![webview, loadHTMLString: &*html, baseURL: &*base_url];
    }
    webview
}

unsafe fn drain(app: AppHandle, webview: *mut AnyObject) {
    let handler = RcBlock::new(move |result: *mut AnyObject, _error: *mut AnyObject| {
        if result.is_null() {
            return;
        }
        let raw: *const c_char = msg_send![result, UTF8String];
        if raw.is_null() {
            return;
        }
        let text = CStr::from_ptr(raw).to_string_lossy();
        if let Ok(serde_json::Value::Array(events)) = serde_json::from_str::<serde_json::Value>(&text) {
            for event in events {
                let _ = app.emit("youtube-player-state", event);
            }
        }
    });
    let js = nsstring("window.ytDrain && window.ytDrain()");
    let _: () = msg_send![webview, evaluateJavaScript: &*js, completionHandler: &*handler];
}

fn start_polling(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let address = *app_main.state::<PlayerState>().webview.lock().unwrap();
            if address != 0 {
                unsafe { drain(app_main.clone(), address as *mut AnyObject) };
            }
        });
    });
}

pub fn install(app: &mut tauri::App) {
    app.manage(PlayerState::default());
    start_polling(app.handle().clone());
}

#[tauri::command]
pub fn youtube_player_update(
    app: AppHandle,
    video_id: String,
    autoplay: bool,
    start: u32,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    visible: bool,
    keep_alive: bool,
) -> Result<(), String> {
    if !video_id.is_empty()
        && !(video_id.len() == 11
            && video_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
    {
        return Err("Invalid YouTube video ID".to_string());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Main webview is unavailable".to_string())?;
    let app_inner = app.clone();
    main.with_webview(move |platform| unsafe {
        let main_view = platform.inner().cast::<AnyObject>();
        let state: State<'_, PlayerState> = app_inner.state();
        let mut address = state.webview.lock().unwrap();
        if *address == 0 {
            *address = create_player(main_view) as usize;
        }
        let player = *address as *mut AnyObject;
        drop(address);

        if video_id.is_empty() {
            *state.video_id.lock().unwrap() = None;
            eval(player, "window.ytCommand({event:'command',func:'pauseVideo',args:[]});");
            let _: () = msg_send![player, setHidden: true];
            return;
        }

        if !visible || width <= 0.0 || height <= 0.0 {
            if keep_alive {
                let frame = NSRect::new(NSPoint::new(-10000.0, -10000.0), NSSize::new(1.0, 1.0));
                let _: () = msg_send![player, setFrame: frame];
                let _: () = msg_send![player, setHidden: false];
            } else {
                let _: () = msg_send![player, setHidden: true];
            }
        } else {
            let main_frame: NSRect = msg_send![main_view, frame];
            let frame = NSRect::new(
                NSPoint::new(main_frame.origin.x + left, main_frame.origin.y + top),
                NSSize::new(width, height),
            );
            let _: () = msg_send![player, setFrame: frame];
            let _: () = msg_send![player, setHidden: false];
        }

        let mut current = state.video_id.lock().unwrap();
        if current.as_deref() != Some(video_id.as_str()) {
            let mut url = tauri::Url::parse(&format!("https://www.youtube.com/embed/{video_id}")).unwrap();
            url.query_pairs_mut()
                .append_pair("autoplay", if autoplay { "1" } else { "0" })
                .append_pair("enablejsapi", "1")
                .append_pair("playsinline", "1")
                .append_pair("origin", "https://net.zathu.majestictab");
            if start > 0 {
                url.query_pairs_mut().append_pair("start", &start.to_string());
            }
            if let Ok(request_url) = serde_json::to_string(url.as_str()) {
                eval(player, &format!("window.ytLoad({request_url});"));
            }
            *current = Some(video_id);
        } else if autoplay {
            eval(player, "window.ytCommand({event:'command',func:'playVideo',args:[]});");
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn youtube_player_command(app: AppHandle, message: serde_json::Value) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Main webview is unavailable".to_string())?;
    let serialized = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    let app_inner = app.clone();
    main.with_webview(move |_| unsafe {
        let address = *app_inner.state::<PlayerState>().webview.lock().unwrap();
        if address != 0 {
            eval(address as *mut AnyObject, &format!("window.ytCommand({serialized});"));
        }
    })
    .map_err(|error| error.to_string())
}
