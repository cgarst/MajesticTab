//! Jam Mode networking: a LAN WebSocket host/client used to synchronise
//! playback between MajesticTab instances.
//!
//! Rust only handles transport concerns (sockets, handshake, PIN check, roster
//! limit, session lock, clock-sync pings and mDNS discovery). All musical state and message
//! semantics live in the JS side (`app/jam/`). Messages are opaque JSON strings.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::Message;

#[cfg(target_vendor = "apple")]
#[path = "jam_dnssd.rs"]
mod discovery;
#[cfg(not(target_vendor = "apple"))]
#[path = "jam_mdns.rs"]
mod discovery;

// A classroom is about 30 people; a connection is one task and a few small messages a second.
const MAX_CLIENTS: usize = 32;
const PROTOCOL_VERSION: u64 = 1;
const SERVICE_TYPE: &str = "_majestictab-jam._tcp.local.";
const DEFAULT_PORT: u16 = 47813;

enum Outgoing {
    Text(String),
    Close,
}

struct Peer {
    name: String,
    tx: mpsc::UnboundedSender<Outgoing>,
}

type PeerMap = Arc<Mutex<HashMap<String, Peer>>>;

/// While locked, only someone presenting an id this host issued (a dropped player coming back) gets in.
#[derive(Clone, Default)]
struct JoinGate {
    locked: Arc<AtomicBool>,
    issued: Arc<Mutex<HashSet<String>>>,
}

struct HostHandle {
    shutdown: watch::Sender<bool>,
    peers: PeerMap,
    gate: JoinGate,
    // Dropping it unregisters the service.
    _advertisement: Option<discovery::Advertisement>,
}

struct ClientHandle {
    shutdown: watch::Sender<bool>,
    tx: mpsc::UnboundedSender<Outgoing>,
}

pub struct JamState {
    epoch: Instant,
    host: Mutex<Option<HostHandle>>,
    client: Mutex<Option<ClientHandle>>,
}

impl Default for JamState {
    fn default() -> Self {
        Self {
            epoch: Instant::now(),
            host: Mutex::new(None),
            client: Mutex::new(None),
        }
    }
}

fn now_ms(epoch: Instant) -> f64 {
    epoch.elapsed().as_secs_f64() * 1000.0
}

#[derive(Serialize, Clone)]
pub struct HostInfo {
    port: u16,
    addresses: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct DiscoveredHost {
    name: String,
    addr: String,
    port: u16,
}

fn local_addresses() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(list) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in list {
            if let std::net::IpAddr::V4(v4) = ip {
                if !v4.is_loopback() && !v4.is_link_local() {
                    out.push(v4.to_string());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn random_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("c{:x}", nanos & 0xffff_ffff_ffff)
}

fn emit_message(app: &AppHandle, from: &str, msg: &str) {
    let _ = app.emit("jam-message", json!({ "from": from, "msg": msg }));
}

fn emit_peer(app: &AppHandle, event: &str, id: &str, name: &str, peers: &PeerMap) {
    let count = peers.lock().map(|p| p.len()).unwrap_or(0);
    let _ = app.emit(
        "jam-peers-changed",
        json!({ "event": event, "id": id, "name": name, "count": count }),
    );
}

fn emit_connection(app: &AppHandle, state: &str, reason: &str) {
    let _ = app.emit(
        "jam-connection-state",
        json!({ "state": state, "reason": reason }),
    );
}

#[tauri::command]
pub fn jam_now_ms(state: State<'_, JamState>) -> f64 {
    now_ms(state.epoch)
}

/// Debug builds only: `MAJESTICTAB_JAM_AUTOSTART=host[:policy]` or `join:<addr>[:port]` starts
/// Jam mode on launch so two instances can be exercised without clicking through the UI.
#[tauri::command]
pub fn jam_debug_autostart() -> Option<String> {
    if cfg!(feature = "debug-tools") {
        std::env::var("MAJESTICTAB_JAM_AUTOSTART").ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

/// Keep the screen awake during a session. The webview's Screen Wake Lock covers most
/// platforms; WKWebView on iOS is unreliable there, so disable the idle timer natively.
#[tauri::command]
pub fn jam_keep_awake(app: AppHandle, on: bool) {
    #[cfg(target_os = "ios")]
    {
        let _ = app.run_on_main_thread(move || unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            let ui_app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            if !ui_app.is_null() {
                let _: () = msg_send![ui_app, setIdleTimerDisabled: on];
            }
        });
    }
    #[cfg(not(target_os = "ios"))]
    let _ = (app, on);
}

#[tauri::command]
pub fn jam_local_addresses() -> Vec<String> {
    local_addresses()
}

#[tauri::command]
pub async fn jam_host_start(
    app: AppHandle,
    state: State<'_, JamState>,
    name: String,
    pin: Option<String>,
    port: Option<u16>,
) -> Result<HostInfo, String> {
    {
        let guard = state.host.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Already hosting".into());
        }
    }

    let wanted = port.unwrap_or(DEFAULT_PORT);
    let listener = match TcpListener::bind(("0.0.0.0", wanted)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|e| format!("Could not open port: {e}"))?,
    };
    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let addresses = local_addresses();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let peers: PeerMap = Arc::new(Mutex::new(HashMap::new()));
    let gate = JoinGate::default();

    // LAN discovery advertisement (best effort)
    let instance: String = name.chars().filter(|c| *c != '.').collect();
    let instance = if instance.trim().is_empty() { "MajesticTab".to_string() } else { instance };
    let has_pin = !pin.as_deref().unwrap_or("").is_empty();
    #[cfg(target_vendor = "apple")]
    let advertisement = discovery::advertise(SERVICE_TYPE, &instance, actual_port, has_pin);
    #[cfg(not(target_vendor = "apple"))]
    let advertisement = discovery::advertise(SERVICE_TYPE, &instance, actual_port, has_pin, &addresses);

    let epoch = state.epoch;
    let pin = pin.unwrap_or_default();
    let host_name = name.clone();
    let peers_for_loop = peers.clone();
    let gate_for_loop = gate.clone();
    let app_for_loop = app.clone();
    let mut accept_shutdown = shutdown_rx.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = accept_shutdown.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let _ = stream.set_nodelay(true);
                    let app = app_for_loop.clone();
                    let peers = peers_for_loop.clone();
                    let gate = gate_for_loop.clone();
                    let pin = pin.clone();
                    let host_name = host_name.clone();
                    let shutdown = shutdown_rx.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_peer(app, stream, peers, gate, pin, host_name, epoch, shutdown).await;
                    });
                }
            }
        }
    });

    let mut guard = state.host.lock().map_err(|e| e.to_string())?;
    *guard = Some(HostHandle {
        shutdown: shutdown_tx,
        peers,
        gate,
        _advertisement: advertisement,
    });

    Ok(HostInfo {
        port: actual_port,
        addresses,
    })
}

const MAX_REQUEST_HEAD: usize = 8192;

/// Peek the HTTP request head without consuming it (so the WebSocket handshake can still read it).
/// Returns the head text once the blank line arrives.
async fn read_request_head(stream: &TcpStream) -> Option<String> {
    let mut buf = vec![0u8; MAX_REQUEST_HEAD];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let n = tokio::time::timeout_at(deadline, stream.peek(&mut buf)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        if let Some(end) = buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            return Some(String::from_utf8_lossy(&buf[..end + 4]).into_owned());
        }
        if n == MAX_REQUEST_HEAD || tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}

fn is_websocket_upgrade(head: &str) -> bool {
    head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("upgrade:") && l.contains("websocket")
    })
}

/// Native peers send no Origin. A browser sends one, and it must be this host, so other websites
/// cannot drive a Jam host from a browser on the LAN.
fn check_origin(req: &Request, resp: Response) -> Result<Response, ErrorResponse> {
    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
    let Some(origin) = origin else {
        return Ok(resp);
    };
    let host = req.headers().get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    let origin_host = origin.split_once("://").map(|(_, rest)| rest).unwrap_or(origin);
    if !host.is_empty() && origin_host.eq_ignore_ascii_case(host) {
        return Ok(resp);
    }
    Err(http::Response::builder()
        .status(http::StatusCode::FORBIDDEN)
        .body(Some("Forbidden".to_string()))
        .unwrap_or_else(|_| http::Response::new(None)))
}

async fn write_http(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(head.as_bytes()).await.is_ok() {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

/// Serve the bundled app to browser guests. Only GET, only the embedded frontend.
async fn serve_web_asset(app: &AppHandle, mut stream: TcpStream, head: String) {
    // Consume the request so closing the socket does not reset the connection mid-response.
    let mut sink = vec![0u8; head.len()];
    if stream.read_exact(&mut sink).await.is_err() {
        return;
    }
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" {
        write_http(&mut stream, "405 Method Not Allowed", "text/plain", b"Method not allowed").await;
        return;
    }
    let path = target.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    // Never expose the desktop OAuth secret module, or anything outside the bundle.
    if path.contains("..") || path.contains('\\') || path.ends_with("googleDrive.local.js") {
        write_http(&mut stream, "404 Not Found", "text/plain", b"Not found").await;
        return;
    }
    let Some(asset) = app.asset_resolver().get(path.to_string()) else {
        write_http(&mut stream, "404 Not Found", "text/plain", b"Not found").await;
        return;
    };
    if path == "index.html" {
        let html = String::from_utf8_lossy(&asset.bytes).replacen(
            "<head>",
            "<head><meta name=\"majestictab-jam-host\" content=\"1\">",
            1,
        );
        write_http(&mut stream, "200 OK", &asset.mime_type, html.as_bytes()).await;
    } else {
        write_http(&mut stream, "200 OK", &asset.mime_type, &asset.bytes).await;
    }
}

async fn handle_peer(
    app: AppHandle,
    stream: TcpStream,
    peers: PeerMap,
    gate: JoinGate,
    pin: String,
    host_name: String,
    epoch: Instant,
    mut shutdown: watch::Receiver<bool>,
) {
    // The same port serves WebSocket peers and, for browser guests, the app itself.
    let Some(head) = read_request_head(&stream).await else {
        return;
    };
    if !is_websocket_upgrade(&head) {
        serve_web_asset(&app, stream, head).await;
        return;
    }
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
        check_origin(req, resp)
    })
    .await
    else {
        return;
    };
    let (mut sink, mut stream) = ws.split();

    // Handshake: first message must be `hello` within 5 seconds.
    let hello = tokio::time::timeout(Duration::from_secs(5), stream.next()).await;
    let hello: Value = match hello {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str(t.as_str()).unwrap_or(Value::Null),
        _ => return,
    };
    let reject = |reason: &'static str| json!({ "v": 1, "type": "reject", "reason": reason }).to_string();

    if hello.get("type").and_then(Value::as_str) != Some("hello") {
        return;
    }
    if hello.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        let _ = sink.send(Message::Text(reject("version").into())).await;
        return;
    }
    if !pin.is_empty() && hello.get("pin").and_then(Value::as_str) != Some(pin.as_str()) {
        let _ = sink.send(Message::Text(reject("pin").into())).await;
        return;
    }

    if gate.locked.load(Ordering::SeqCst) {
        let returning = hello
            .get("resume")
            .and_then(Value::as_str)
            .map(|id| gate.issued.lock().map(|set| set.contains(id)).unwrap_or(false))
            .unwrap_or(false);
        if !returning {
            let _ = sink.send(Message::Text(reject("locked").into())).await;
            return;
        }
    }

    let name = hello
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Guest")
        .chars()
        .take(40)
        .collect::<String>();
    let id = random_id();
    if let Ok(mut set) = gate.issued.lock() {
        set.insert(id.clone());
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();

    let accepted = match peers.lock() {
        Ok(mut map) => {
            if map.len() >= MAX_CLIENTS {
                false
            } else {
                map.insert(
                    id.clone(),
                    Peer {
                        name: name.clone(),
                        tx,
                    },
                );
                true
            }
        }
        Err(_) => return,
    };
    if !accepted {
        let _ = sink.send(Message::Text(reject("full").into())).await;
        return;
    }

    let welcome = json!({
        "v": 1,
        "type": "welcome",
        "clientId": id,
        "hostName": host_name,
        "hostTs": now_ms(epoch),
    })
    .to_string();
    if sink.send(Message::Text(welcome.into())).await.is_err() {
        if let Ok(mut map) = peers.lock() {
            map.remove(&id);
        }
        return;
    }
    emit_peer(&app, "joined", &id, &name, &peers);

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = sink.send(Message::Close(None)).await;
                break;
            }
            out = rx.recv() => match out {
                Some(Outgoing::Text(t)) => {
                    if sink.send(Message::Text(t.into())).await.is_err() { break; }
                }
                Some(Outgoing::Close) | None => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    let rx_ts = now_ms(epoch);
                    let Ok(mut v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    match v.get("type").and_then(Value::as_str) {
                        Some("ping") => {
                            // Answered in Rust so the reply timestamp is not delayed by the webview.
                            let pong = json!({
                                "v": 1,
                                "type": "pong",
                                "id": v.get("id").cloned().unwrap_or(Value::Null),
                                "t0": v.get("t0").cloned().unwrap_or(Value::Null),
                                "t1": rx_ts,
                                "t1b": now_ms(epoch),
                            }).to_string();
                            if sink.send(Message::Text(pong.into())).await.is_err() { break; }
                        }
                        Some("bye") => break,
                        _ => {
                            if let Some(obj) = v.as_object_mut() {
                                obj.insert("rxTs".into(), json!(rx_ts));
                            }
                            emit_message(&app, &id, &v.to_string());
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    }

    if let Ok(mut map) = peers.lock() {
        map.remove(&id);
    }
    emit_peer(&app, "left", &id, &name, &peers);
}

#[tauri::command]
pub fn jam_host_stop(state: State<'_, JamState>) -> Result<(), String> {
    let handle = state.host.lock().map_err(|e| e.to_string())?.take();
    if let Some(h) = handle {
        let _ = h.shutdown.send(true);
        if let Ok(mut peers) = h.peers.lock() {
            peers.clear();
        }
    }
    Ok(())
}

/// Send to one peer (`to` set) or broadcast to every peer.
#[tauri::command]
pub fn jam_host_send(
    state: State<'_, JamState>,
    to: Option<String>,
    msg: String,
) -> Result<(), String> {
    let guard = state.host.lock().map_err(|e| e.to_string())?;
    let Some(host) = guard.as_ref() else {
        return Err("Not hosting".into());
    };
    let peers = host.peers.lock().map_err(|e| e.to_string())?;
    match to {
        Some(id) => {
            if let Some(p) = peers.get(&id) {
                let _ = p.tx.send(Outgoing::Text(msg));
            }
        }
        None => {
            for p in peers.values() {
                let _ = p.tx.send(Outgoing::Text(msg.clone()));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn jam_host_kick(state: State<'_, JamState>, id: String) -> Result<(), String> {
    let guard = state.host.lock().map_err(|e| e.to_string())?;
    if let Some(host) = guard.as_ref() {
        // A kicked player must not walk back in through a lock with their old id.
        if let Ok(mut set) = host.gate.issued.lock() {
            set.remove(&id);
        }
        if let Some(p) = host.peers.lock().map_err(|e| e.to_string())?.get(&id) {
            let _ = p.tx.send(Outgoing::Close);
        }
    }
    Ok(())
}

/// Lock or unlock the session. Locked, new people are turned away; returning players still get in.
#[tauri::command]
pub fn jam_host_set_locked(state: State<'_, JamState>, locked: bool) -> Result<(), String> {
    let guard = state.host.lock().map_err(|e| e.to_string())?;
    if let Some(host) = guard.as_ref() {
        host.gate.locked.store(locked, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn jam_host_peers(state: State<'_, JamState>) -> Result<Vec<Value>, String> {
    let guard = state.host.lock().map_err(|e| e.to_string())?;
    let Some(host) = guard.as_ref() else {
        return Ok(vec![]);
    };
    let peers = host.peers.lock().map_err(|e| e.to_string())?;
    Ok(peers
        .iter()
        .map(|(id, p)| json!({ "id": id, "name": p.name }))
        .collect())
}

#[tauri::command]
pub async fn jam_discover(timeout_ms: Option<u64>) -> Result<Vec<DiscoveredHost>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(500, 10000));
    tauri::async_runtime::spawn_blocking(move || discovery::discover(SERVICE_TYPE, timeout))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn jam_client_connect(
    app: AppHandle,
    state: State<'_, JamState>,
    addr: String,
    pin: Option<String>,
    name: String,
    resume: Option<String>,
) -> Result<(), String> {
    jam_client_disconnect(state.clone())?;

    let url = if addr.starts_with("ws://") {
        addr.clone()
    } else if addr.contains(':') {
        format!("ws://{addr}")
    } else {
        format!("ws://{addr}:{DEFAULT_PORT}")
    };

    emit_connection(&app, "connecting", "");
    let connect = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(url.as_str()),
    )
    .await
    .map_err(|_| "Connection timed out".to_string())?
    .map_err(|e| format!("Connection failed: {e}"))?;
    let (ws, _) = connect;
    let (mut sink, mut stream) = ws.split();

    let hello = json!({
        "v": 1,
        "type": "hello",
        "name": name,
        "pin": pin.unwrap_or_default(),
        "resume": resume,
        "protocol": PROTOCOL_VERSION,
        "appVersion": env!("MAJESTICTAB_VERSION"),
    })
    .to_string();
    sink.send(Message::Text(hello.into()))
        .await
        .map_err(|e| e.to_string())?;

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let epoch = state.epoch;

    {
        let mut guard = state.client.lock().map_err(|e| e.to_string())?;
        *guard = Some(ClientHandle {
            shutdown: shutdown_tx,
            tx,
        });
    }

    let app_loop = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reason = "closed".to_string();
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    let _ = sink.send(Message::Close(None)).await;
                    reason = "local".into();
                    break;
                }
                out = rx.recv() => match out {
                    Some(Outgoing::Text(t)) => {
                        let text = match serde_json::from_str::<Value>(&t) {
                            Ok(mut v) if v.get("type").and_then(Value::as_str) == Some("ping") => {
                                if let Some(o) = v.as_object_mut() {
                                    o.insert("t0".into(), json!(now_ms(epoch)));
                                }
                                v.to_string()
                            }
                            _ => t,
                        };
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    Some(Outgoing::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        reason = "local".into();
                        break;
                    }
                },
                incoming = stream.next() => match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let rx_ts = now_ms(epoch);
                        let Ok(mut v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                        if let Some(o) = v.as_object_mut() {
                            o.insert("rxTs".into(), json!(rx_ts));
                        }
                        let ty = v.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                        if ty == "welcome" {
                            emit_connection(&app_loop, "connected", "");
                        }
                        let is_reject = ty == "reject";
                        let rej = v.get("reason").and_then(Value::as_str).unwrap_or("").to_string();
                        emit_message(&app_loop, "host", &v.to_string());
                        if is_reject {
                            reason = format!("reject:{rej}");
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
        if let Some(st) = app_loop.try_state::<JamState>() {
            if let Ok(mut g) = st.client.lock() {
                *g = None;
            }
        }
        emit_connection(&app_loop, "disconnected", &reason);
    });

    Ok(())
}

#[tauri::command]
pub fn jam_client_send(state: State<'_, JamState>, msg: String) -> Result<(), String> {
    let guard = state.client.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(c) => c.tx.send(Outgoing::Text(msg)).map_err(|e| e.to_string()),
        None => Err("Not connected".into()),
    }
}

#[tauri::command]
pub fn jam_client_disconnect(state: State<'_, JamState>) -> Result<(), String> {
    let handle = state.client.lock().map_err(|e| e.to_string())?.take();
    if let Some(c) = handle {
        let _ = c.shutdown.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod web_tests {
    use super::*;

    fn upgrade_request(origin: Option<&str>) -> Request {
        let mut b = http::Request::builder().uri("/jam").header("host", "192.168.1.5:47813");
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        b.body(()).unwrap()
    }

    fn allowed(origin: Option<&str>) -> bool {
        check_origin(&upgrade_request(origin), http::Response::new(())).is_ok()
    }

    #[test]
    fn detects_websocket_upgrades() {
        assert!(is_websocket_upgrade("GET /jam HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\r\n"));
        assert!(is_websocket_upgrade("GET / HTTP/1.1\r\nupgrade: WebSocket\r\n\r\n"));
        assert!(!is_websocket_upgrade("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    }

    #[test]
    fn native_peers_without_origin_are_allowed() {
        assert!(allowed(None));
    }

    #[test]
    fn browser_origin_must_match_host() {
        assert!(allowed(Some("http://192.168.1.5:47813")));
        assert!(!allowed(Some("https://evil.example")));
        assert!(!allowed(Some("http://192.168.1.6:47813")));
    }
}
