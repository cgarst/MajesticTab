//! Dev-only JS eval bridge (`debug-tools` feature), the WebKitGTK/WKWebView stand-in for the CDP `Runtime.evaluate`
//! that `tests/cdp.py` uses. Listens on loopback only; never compiled into release builds.
//!
//!   curl -s --data-binary '1+1' http://127.0.0.1:9555/eval           # -> {"ok":true,"value":2}
//!   curl -s --data-binary 'document.title' http://127.0.0.1:9555/eval
//!
//! The body is evaluated in the main webview as an async expression (use `await` freely; wrap statements in an IIFE).
//! The JSON-serialised result comes back through the `debug_bridge_result` command.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const DEFAULT_PORT: u16 = 9555;
const EVAL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY: usize = 1 << 20;

type Pending = Mutex<(u64, HashMap<u64, oneshot::Sender<String>>)>;

fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(|| Mutex::new((0, HashMap::new())))
}

#[tauri::command]
pub fn debug_bridge_result(id: u64, payload: String) {
    if let Some(tx) = pending().lock().ok().and_then(|mut p| p.1.remove(&id)) {
        let _ = tx.send(payload);
    }
}

pub fn start(app: AppHandle) {
    let port = std::env::var("MAJESTICTAB_DEBUG_BRIDGE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[debug-bridge] cannot bind 127.0.0.1:{port}: {e}");
                return;
            }
        };
        eprintln!("[debug-bridge] listening on http://127.0.0.1:{port}/eval");
        loop {
            if let Ok((stream, _)) = listener.accept().await {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle(stream, app).await;
                });
            }
        }
    });
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_BODY {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let len = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(MAX_BODY);
    while buf.len() < header_end + len {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[header_end..]).to_string();
    Some((method, path, body))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await
}

async fn handle(mut stream: TcpStream, app: AppHandle) -> std::io::Result<()> {
    let Some((method, path, code)) = read_request(&mut stream).await else {
        return Ok(());
    };
    if method != "POST" || path != "/eval" {
        return respond(&mut stream, "404 Not Found", r#"{"ok":false,"error":"POST /eval with the JS as the body"}"#).await;
    }
    let Some(webview) = app.get_webview("main") else {
        return respond(&mut stream, "503 Service Unavailable", r#"{"ok":false,"error":"no main webview"}"#).await;
    };

    let (tx, rx) = oneshot::channel();
    let id = {
        let mut p = pending().lock().unwrap();
        p.0 += 1;
        let id = p.0;
        p.1.insert(id, tx);
        id
    };
    let code_json = serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".into());
    let script = format!(
        r#"(async () => {{
  let out;
  try {{
    const v = await (0, eval)({code_json});
    let value;
    try {{ value = JSON.parse(JSON.stringify(v === undefined ? null : v)); }} catch (_) {{ value = String(v); }}
    out = {{ ok: true, value }};
  }} catch (e) {{
    out = {{ ok: false, error: String((e && e.stack) || e) }};
  }}
  window.__TAURI_INTERNALS__.invoke('debug_bridge_result', {{ id: {id}, payload: JSON.stringify(out) }});
}})();"#
    );
    if let Err(e) = webview.eval(&script) {
        pending().lock().unwrap().1.remove(&id);
        let body = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
        return respond(&mut stream, "500 Internal Server Error", &body).await;
    }
    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(payload)) => respond(&mut stream, "200 OK", &payload).await,
        _ => {
            pending().lock().unwrap().1.remove(&id);
            respond(&mut stream, "504 Gateway Timeout", r#"{"ok":false,"error":"eval timed out"}"#).await
        }
    }
}
