//! Loopback Google Picker server for desktop platforms (macOS, Windows, Linux).
//!
//! When running in an embedded WKWebView / WebView2, third-party cookies are blocked by default
//! (ITP / storage partitioning), which causes the Google Picker iframe to fail with
//! "Can't access your Google Account" (support.google.com/drive?p=enable_storage_access).
//!
//! Furthermore, desktop Google OAuth is performed in the user's default browser (RFC 8252),
//! so the user's active Google session cookies live in that browser, NOT in the app's webview.
//!
//! This module spawns a temporary, ephemeral loopback server on `127.0.0.1:0`, opens the
//! picker page in the user's default browser (where they are already signed into Google),
//! lets them select their tab file under the `drive.file` scope, receives the chosen file
//! metadata, closes the browser tab, focuses MajesticTab, and returns `{ id, name, mimeType }`.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickedDriveFile {
    pub id: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

const PICKER_TIMEOUT: Duration = Duration::from_secs(300); // 5 minutes
const API_KEY: &str = "AIzaSyCohcbDpEo2PvNPV4Imixd3a_Exu4B-kKY";
const APP_ID: &str = "1059497343032";

#[tauri::command]
pub async fn desktop_pick_drive_file(
    app: AppHandle,
    token: String,
    title: Option<String>,
) -> Result<Option<PickedDriveFile>, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Failed to bind loopback picker listener: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read listener address: {e}"))?
        .port();

    // Random session token to prevent unauthorized local calls
    let session_id: String = {
        use std::time::SystemTime;
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{:x}", nanos)
    };

    let picker_title = title.unwrap_or_else(|| "Select a tab file from Google Drive".into());
    let url = format!("http://127.0.0.1:{port}/?session={session_id}");

    // Spawn default browser directly
    open_in_default_browser(&url);

    let result = tokio::time::timeout(PICKER_TIMEOUT, async {
        let mut picked_result: Option<PickedDriveFile> = None;

        while picked_result.is_none() {
            let (mut socket, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(_) => break,
            };

            let mut buf = [0u8; 8192];
            let n = match socket.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => continue,
            };

            let req_str = String::from_utf8_lossy(&buf[..n]);
            let first_line = match req_str.lines().next() {
                Some(l) => l,
                None => continue,
            };

            let parts: Vec<&str> = first_line.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }
            let raw_path = parts[1];

            if raw_path.starts_with("/?session=") || raw_path == "/" {
                let html = build_picker_html(&token, &picker_title, &session_id);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = socket.write_all(response.as_bytes()).await;
            } else if raw_path.starts_with("/picked?") {
                if let Some(query) = raw_path.split_once('?').map(|x| x.1) {
                    let mut id = String::new();
                    let mut name = String::new();
                    let mut mime_type = String::new();
                    let mut sess = String::new();

                    for pair in query.split('&') {
                        if let Some((k, v)) = pair.split_once('=') {
                            let decoded = percent_encoding::percent_decode_str(v)
                                .decode_utf8_lossy()
                                .into_owned();
                            match k {
                                "id" => id = decoded,
                                "name" => name = decoded,
                                "mimeType" => mime_type = decoded,
                                "session" => sess = decoded,
                                _ => {}
                            }
                        }
                    }

                    if sess == session_id && !id.is_empty() {
                        picked_result = Some(PickedDriveFile {
                            id,
                            name,
                            mime_type,
                        });
                        let body = "<!DOCTYPE html><html><body style=\"background:#121214;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;\"><div style=\"text-align:center;\"><h3 style=\"font-weight:500;\">Tab selected!</h3><p style=\"color:#a1a1aa;\">Returning to MajesticTab...</p><script>window.close();</script></div></body></html>";
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                        break;
                    }
                }
            } else if raw_path.starts_with("/cancel") {
                let body = "<!DOCTYPE html><html><body style=\"background:#121214;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;\"><div style=\"text-align:center;\"><h3 style=\"font-weight:500;\">Selection cancelled</h3><p style=\"color:#a1a1aa;\">You can close this tab.</p><script>window.close();</script></div></body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                break;
            } else {
                let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(response.as_bytes()).await;
            }
        }

        picked_result
    })
    .await;

    // Focus main MajesticTab window if available
    if let Some(win) = app.get_window("main") {
        let _ = win.set_focus();
    }

    match result {
        Ok(file) => Ok(file),
        Err(_) => Ok(None), // Timeout
    }
}

fn build_picker_html(token: &str, title: &str, session_id: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MajesticTab &bull; Google Drive</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://apis.google.com/js/api.js"></script>
  <style>
    body {{
      background: #121214;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      overflow: hidden;
    }}
    .box {{
      text-align: center;
      padding: 32px;
      max-width: 440px;
    }}
    h2 {{
      font-weight: 500;
      font-size: 20px;
      margin: 0 0 12px 0;
      letter-spacing: -0.01em;
    }}
    p {{
      color: #a1a1aa;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 24px 0;
    }}
    .btn {{
      background: #27272a;
      color: #f4f4f5;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.15s;
    }}
    .btn:hover {{
      background: #3f3f46;
    }}
  </style>
</head>
<body>
  <div class="box">
    <h2>Opening Google Drive&hellip;</h2>
    <p>Please choose your tab file in the picker window.<br>Once selected, this tab will close automatically.</p>
    <button class="btn" onclick="openPicker()">Reopen Picker</button>
  </div>
  <script>
    const OAUTH_TOKEN = {token_json};
    const DEVELOPER_KEY = {api_key_json};
    const APP_ID = {app_id_json};
    const SESSION_ID = {session_json};
    const PICKER_TITLE = {title_json};

    function openPicker() {{
      if (!window.google || !window.google.picker) return;
      const origin = window.location.origin;
      const view = new google.picker.DocsView()
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);

      const picker = new google.picker.PickerBuilder()
        .setAppId(APP_ID)
        .setDeveloperKey(DEVELOPER_KEY)
        .setOAuthToken(OAUTH_TOKEN)
        .setOrigin(origin)
        .setTitle(PICKER_TITLE)
        .addView(view)
        .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
        .setCallback(async (data) => {{
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {{
            const doc = data[google.picker.Response.DOCUMENTS][0];
            const docId = doc.id || doc[google.picker.Document.ID];
            const docName = doc.name || doc[google.picker.Document.NAME];
            const docMime = doc.mimeType || doc[google.picker.Document.MIME_TYPE] || '';
            const q = new URLSearchParams({{
              id: docId,
              name: docName,
              mimeType: docMime,
              session: SESSION_ID
            }});
            try {{
              document.querySelector('h2').innerText = 'Tab selected!';
              document.querySelector('p').innerText = 'Returning to MajesticTab... You can close this tab.';
              await fetch('/picked?' + q.toString());
            }} finally {{
              window.close();
            }}
          }} else if (action === google.picker.Action.CANCEL) {{
            try {{
              document.querySelector('h2').innerText = 'Selection cancelled';
              document.querySelector('p').innerText = 'You can close this tab.';
              await fetch('/cancel?session=' + encodeURIComponent(SESSION_ID));
            }} finally {{
              window.close();
            }}
          }}
        }})
        .build();

      picker.setVisible(true);
    }}

    window.addEventListener('beforeunload', () => {{
      try {{
        navigator.sendBeacon('/cancel?session=' + encodeURIComponent(SESSION_ID));
      }} catch (_) {{}}
    }});

    gapi.load('picker', openPicker);
  </script>
</body>
</html>"#,
        token_json = serde_json::to_string(token).unwrap_or_default(),
        api_key_json = serde_json::to_string(API_KEY).unwrap_or_default(),
        app_id_json = serde_json::to_string(APP_ID).unwrap_or_default(),
        session_json = serde_json::to_string(session_id).unwrap_or_default(),
        title_json = serde_json::to_string(title).unwrap_or_default(),
    )
}

fn open_in_default_browser(url: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}
