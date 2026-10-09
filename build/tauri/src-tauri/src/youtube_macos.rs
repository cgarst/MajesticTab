use std::sync::Mutex;

use objc2_foundation::{NSString, NSURL};
use objc2_web_kit::WKWebView;
use tauri::{
    utils::config::WebviewUrl, webview::WebviewBuilder, App, AppHandle, Emitter, LogicalPosition,
    LogicalSize, Manager, State, Url, Wry,
};

const PLAYER_LABEL: &str = "youtubeplayer";
const SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

const PLAYER_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <style>
        html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; background: #000; }
    </style>
</head>
<body>
    <iframe id="player" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
    <script>
        const player = document.getElementById('player');
        let playerReady = false;
        let pendingMessages = [];

        window.ytLoad = (url) => {
            playerReady = false;
            pendingMessages = [];
            const embedUrl = new URL(url);
            embedUrl.searchParams.set('origin', window.location.origin);
            player.src = embedUrl.href;
        };

        window.ytCommand = (message) => {
            const serialized = typeof message === 'string' ? message : JSON.stringify(message);
            if (playerReady && player.contentWindow) {
                player.contentWindow.postMessage(serialized, '*');
            } else {
                pendingMessages.push(serialized);
            }
        };

        player.addEventListener('load', () => {
            playerReady = true;
            for (const message of pendingMessages.splice(0)) {
                player.contentWindow?.postMessage(message, '*');
            }
            window.ytCommand({ event: 'listening', id: 1 });
            window.ytCommand({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
        });

        window.addEventListener('message', (event) => {
            let data = event.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { return; }
            }
            if (event.source !== player.contentWindow) return;
            if (data?.event === 'infoDelivery' || data?.event === 'onStateChange') {
                window.postMessage(data, '*');
            }
        });
    </script>
</body>
</html>"##;
const PLAYER_BRIDGE: &str = r#"
window.addEventListener('message', (event) => {
  try {
    let data = event.data;
    if (typeof data === 'string') data = JSON.parse(data);
    if (!data || (data.event !== 'infoDelivery' && data.event !== 'onStateChange')) return;
    window.__TAURI__?.event.emit('youtube-player-state', data).catch(() => {});
  } catch {}
});
"#;

#[derive(Default)]
pub struct PlayerState {
    video_id: Mutex<Option<String>>,
}

pub fn open_youtube_auth_window(app: &AppHandle, url: tauri::Url) {
    let label = "youtube-auth";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.navigate(url);
        let _ = existing.show();
        let _ = existing.set_focus();
    } else {
        let app_handle = app.clone();
        if let Ok(window) = tauri::WebviewWindowBuilder::new(
            app,
            label,
            tauri::WebviewUrl::External(url),
        )
        .title("Sign In - YouTube")
        .inner_size(650.0, 780.0)
        .center()
        .user_agent(SAFARI_USER_AGENT)
        .build()
        {
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if let Some(player) = app_handle.get_webview(PLAYER_LABEL) {
                        let _ = player.eval("if (player && player.src) { player.src = player.src; }");
                    }
                    let _ = app_handle.emit("youtube-auth-completed", ());
                }
            });
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

pub fn install(app: &mut App<Wry>) -> tauri::Result<()> {
    app.manage(PlayerState::default());
    let main = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WebviewNotFound)?;

    let app_handle_new_win = app.handle().clone();
    let app_handle_nav = app.handle().clone();
    let blank_url = Url::parse("about:blank").map_err(tauri::Error::InvalidUrl)?;

    let player = main.as_ref().window().add_child(
        WebviewBuilder::new(PLAYER_LABEL, WebviewUrl::External(blank_url))
            .initialization_script(PLAYER_BRIDGE)
            .user_agent(SAFARI_USER_AGENT)
            .on_new_window(move |url, _features| {
                let host = url.host_str().unwrap_or_default();
                if host.is_empty()
                    || host == "net.zathu.majestictab"
                    || host == "localhost"
                    || host == "tauri.localhost"
                    || url.scheme() == "tauri"
                    || url.scheme() == "about"
                {
                    return tauri::webview::NewWindowResponse::Deny;
                }
                let is_auth_or_verification = host.contains("accounts.google.com")
                    || (host.contains("youtube.com") && (url.path().contains("signin") || url.path().contains("ServiceLogin")))
                    || url.path().contains("sorry")
                    || url.path().contains("captcha");
                if is_auth_or_verification {
                    let app = app_handle_new_win.clone();
                    let _ = tauri::async_runtime::spawn(async move {
                        open_youtube_auth_window(&app, url);
                    });
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .on_navigation(move |url| {
                let host = url.host_str().unwrap_or_default();
                if host.is_empty()
                    || host == "net.zathu.majestictab"
                    || host == "localhost"
                    || host == "tauri.localhost"
                    || url.scheme() == "tauri"
                    || url.scheme() == "about"
                {
                    return true;
                }
                let is_auth_or_verification = host.contains("accounts.google.com")
                    || (host.contains("youtube.com") && (url.path().contains("signin") || url.path().contains("ServiceLogin")))
                    || url.path().contains("sorry")
                    || url.path().contains("captcha");
                if is_auth_or_verification {
                    let app = app_handle_nav.clone();
                    let target_url = url.clone();
                    let _ = tauri::async_runtime::spawn(async move {
                        open_youtube_auth_window(&app, target_url);
                    });
                    return false;
                }
                true
            }),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(1.0, 1.0),
    )?;
    player.with_webview(|platform| unsafe {
        let webview = &*platform.inner().cast::<WKWebView>();
        webview.setWantsLayer(true);
        if let Some(layer) = webview.layer() {
            layer.setCornerRadius(11.0);
            layer.setMasksToBounds(true);
        }
        let ua = NSString::from_str(SAFARI_USER_AGENT);
        webview.setCustomUserAgent(Some(&ua));
        let html = NSString::from_str(PLAYER_HTML);
        let base_url = NSString::from_str("https://net.zathu.majestictab");
        if let Some(base_url) = NSURL::URLWithString(&base_url) {
            webview.loadHTMLString_baseURL(&html, Some(&base_url));
        }
    })?;
    player.hide()?;
    #[cfg(feature = "debug-tools")]
    player.open_devtools();
    Ok(())
}

#[tauri::command]
pub fn youtube_player_update(
    app: AppHandle,
    state: State<'_, PlayerState>,
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
    let player = app
        .get_webview(PLAYER_LABEL)
        .ok_or_else(|| "Native YouTube player is unavailable".to_string())?;

    if video_id.is_empty() {
        *state
            .video_id
            .lock()
            .map_err(|_| "Native YouTube player state is unavailable".to_string())? = None;
        player
            .eval("window.ytCommand({event:'command',func:'pauseVideo',args:[]});")
            .map_err(|error| error.to_string())?;
        player.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }

    if !visible || width <= 0.0 || height <= 0.0 {
        if keep_alive {
            player
                .set_position(LogicalPosition::new(-10000.0, -10000.0))
                .map_err(|error| error.to_string())?;
            player
                .set_size(LogicalSize::new(1.0, 1.0))
                .map_err(|error| error.to_string())?;
            player.show().map_err(|error| error.to_string())?;
        } else {
            player.hide().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    player
        .set_position(LogicalPosition::new(left, top))
        .map_err(|error| error.to_string())?;
    player
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    let valid_video_id = video_id.len() == 11
        && video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid_video_id {
        return Err("Invalid YouTube video ID".to_string());
    }

    let mut current_video = state
        .video_id
        .lock()
        .map_err(|_| "Native YouTube player state is unavailable".to_string())?;
    if current_video.as_deref() != Some(video_id.as_str()) {
        let mut url = tauri::webview::Url::parse(&format!(
            "https://www.youtube.com/embed/{video_id}"
        ))
        .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("autoplay", if autoplay { "1" } else { "0" })
            .append_pair("enablejsapi", "1")
            .append_pair("origin", "https://net.zathu.majestictab");
        if start > 0 {
            url.query_pairs_mut()
                .append_pair("start", &start.to_string());
        }
        let request_url = serde_json::to_string(url.as_str()).map_err(|error| error.to_string())?;
        player
            .eval(&format!("window.ytLoad({request_url});"))
            .map_err(|error| error.to_string())?;
        *current_video = Some(video_id);
    } else if autoplay {
        player
            .eval("window.ytCommand({event:'command',func:'playVideo',args:[]});")
            .map_err(|error| error.to_string())?;
    }

    player.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn youtube_player_command(app: AppHandle, message: serde_json::Value) -> Result<(), String> {
    let player = app
        .get_webview(PLAYER_LABEL)
        .ok_or_else(|| "Native YouTube player is unavailable".to_string())?;
    let serialized = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    player
        .eval(&format!("window.ytCommand({serialized});"))
        .map_err(|error| error.to_string())
}
