// Tunnel data transport
//
// Three modes, in order of preference:
//
// 1. Pool WS (best): Runner pre-establishes an idle WebSocket to the hub.
//    When a tunnel is created, the hub assigns the idle WS immediately —
//    zero additional handshake latency. Binary frames, no encoding overhead.
//
// 2. Per-tunnel WS: Runner opens a new WebSocket per tunnel after TCP connect.
//    Still binary, but adds ~200-400ms for the WS handshake. Used when the
//    hub doesn't advertise wsPool capability (old hub).
//
// 3. Socket.IO fallback: Base64-encoded data over Socket.IO events.
//    +33% bandwidth overhead, higher latency. Used when all WS paths fail.
//
// Pool WS lifecycle:
//   Runner connect → Hub sends hub:capabilities { wsPool: true }
//   → Runner opens WS to /tunnel/pool (with ping keepalive every 20s)
//   → Hub stores in idle pool
//   → tunnel:ready arrives → Hub sends {"assign":"<tunnelId>"} on the WS
//   → Runner wires WS ↔ TCP, immediately opens a replacement idle WS

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::HashMap;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::connection::SocketEvent;
use crate::socket::SocketClient;

/// How long to wait for the initial pool WS connection to the hub.
const POOL_WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Ping interval for idle pool WS to prevent server-side idle timeout.
const POOL_WS_PING_INTERVAL: Duration = Duration::from_secs(20);
/// How long to wait for pool WS assignment before falling back to Socket.IO.
const POOL_WS_ASSIGN_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum backoff for pool WS reconnection attempts.
const POOL_WS_MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long to wait for a per-tunnel WS upgrade (non-pool mode).
const PER_TUNNEL_WS_TIMEOUT: Duration = Duration::from_secs(3);

struct TunnelHandle {
    /// Send decoded bytes to the TCP write task.
    write_tx: mpsc::Sender<Vec<u8>>,
    /// All spawned tasks for this tunnel (aborted on drop).
    tasks: Vec<JoinHandle<()>>,
    /// True if WebSocket binary transport is active (skip Socket.IO data).
    has_ws: bool,
    /// Held until pool WS is assigned or timeout triggers Socket.IO fallback.
    pending_read: Option<Box<dyn AsyncRead + Unpin + Send>>,
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Internal event for pool WS assignment from hub.
enum PoolEvent {
    Assigned {
        tunnel_id: String,
        ws_sink: futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        ws_stream: futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
    },
    /// Pool WS assignment timed out — fall back to Socket.IO for TCP read.
    Timeout { tunnel_id: String },
}

/// Pending pool WS assignment that arrived before the tunnel was created.
struct PendingPoolAssignment {
    ws_sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    ws_stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
}

pub async fn run(
    mut event_rx: mpsc::Receiver<SocketEvent>,
    client: SocketClient,
    machine_id: String,
    api_url: String,
    token: String,
    data_dir: String,
) {
    let mut tunnels: HashMap<String, TunnelHandle> = HashMap::new();
    let mut pool_active = false;
    let (pool_tx, mut pool_rx) = mpsc::channel::<PoolEvent>(16);
    let mut pool_task: Option<JoinHandle<()>> = None;
    let mut pending_pool: HashMap<String, PendingPoolAssignment> = HashMap::new();

    loop {
        tokio::select! {
            event = event_rx.recv() => {
                let Some(event) = event else { break };
                match event {
                    SocketEvent::TunnelOpen {
                        tunnel_id,
                        host,
                        port,
                    } => {
                        let target_host = host.as_deref().unwrap_or("127.0.0.1");
                        log::info!("Tunnel open: {} -> {}:{}", tunnel_id, target_host, port);
                        handle_tunnel_open(
                            &mut tunnels,
                            &client,
                            tunnel_id,
                            target_host,
                            port,
                            &api_url,
                            &token,
                            pool_active,
                            &pool_tx,
                            &mut pending_pool,
                            &data_dir,
                        )
                        .await;
                    }
                    SocketEvent::TunnelData { tunnel_id, data } => {
                        if let Some(handle) = tunnels.get(&tunnel_id) {
                            if handle.has_ws {
                                continue; // WS active, ignore Socket.IO data
                            }
                            match B64.decode(&data) {
                                Ok(bytes) => {
                                    if handle.write_tx.send(bytes).await.is_err() {
                                        log::debug!("Tunnel {} TCP write channel closed", tunnel_id);
                                        tunnels.remove(&tunnel_id);
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Tunnel {} base64 decode error: {}", tunnel_id, e);
                                }
                            }
                        }
                    }
                    SocketEvent::TunnelClose { tunnel_id } => {
                        log::info!("Tunnel close from hub: {}", tunnel_id);
                        tunnels.remove(&tunnel_id); // Drop triggers abort
                    }
                    SocketEvent::RpcRequest {
                        ack_id,
                        method,
                        params,
                    } => {
                        log::info!("RPC request: {} (ack_id={})", method, ack_id);
                        let response = handle_rpc(&method, &params, &machine_id);
                        let ack_data = serde_json::Value::String(response);
                        if let Err(e) = client.send_ack(ack_id, ack_data).await {
                            log::warn!("Failed to send RPC ack: {}", e);
                        }
                    }
                    SocketEvent::HubCapabilities { ws_pool } => {
                        log::info!("Hub capabilities: wsPool={}", ws_pool);
                        if ws_pool && !pool_active {
                            pool_active = true;
                            let sid = client.sid();
                            // Spawn initial pool WS
                            spawn_pool_ws(
                                &api_url,
                                &token,
                                &machine_id,
                                sid.as_deref(),
                                pool_tx.clone(),
                                &mut pool_task,
                            );
                        }
                    }
                    SocketEvent::Disconnected => {
                        log::warn!("Socket.IO disconnected, closing {} tunnels", tunnels.len());
                        tunnels.clear();
                        pending_pool.clear();
                        if let Some(task) = pool_task.take() {
                            task.abort();
                        }
                        return; // Let main loop handle reconnect
                    }
                }
            }
            Some(pool_event) = pool_rx.recv() => {
                match pool_event {
                    PoolEvent::Assigned { tunnel_id, ws_sink, ws_stream } => {
                        log::info!("Pool WS assigned to tunnel {}", tunnel_id);
                        if tunnels.contains_key(&tunnel_id) {
                            attach_pool_ws(&mut tunnels, &client, &tunnel_id, ws_sink, ws_stream);
                        } else {
                            log::info!("Tunnel {} not yet created, buffering pool WS", tunnel_id);
                            pending_pool.insert(tunnel_id, PendingPoolAssignment { ws_sink, ws_stream });
                        }
                        // Replenish pool WS
                        let sid = client.sid();
                        spawn_pool_ws(
                            &api_url,
                            &token,
                            &machine_id,
                            sid.as_deref(),
                            pool_tx.clone(),
                            &mut pool_task,
                        );
                    }
                    PoolEvent::Timeout { tunnel_id } => {
                        // Pool WS assignment timed out — fall back to Socket.IO
                        if let Some(handle) = tunnels.get_mut(&tunnel_id) {
                            if !handle.has_ws {
                                if let Some(tcp_read) = handle.pending_read.take() {
                                    log::warn!("Tunnel {} pool WS timeout, falling back to Socket.IO", tunnel_id);
                                    let read_client = client.clone();
                                    let read_tid = tunnel_id.clone();
                                    let read_task = tokio::spawn(async move {
                                        tcp_read_loop(tcp_read, &read_client, &read_tid).await;
                                    });
                                    handle.tasks.push(read_task);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn spawn_pool_ws(
    api_url: &str,
    token: &str,
    machine_id: &str,
    socket_id: Option<&str>,
    pool_tx: mpsc::Sender<PoolEvent>,
    current_task: &mut Option<JoinHandle<()>>,
) {
    // Abort previous pool WS task if still running
    if let Some(task) = current_task.take() {
        task.abort();
    }

    let ws_url = match build_pool_ws_url(api_url, token, machine_id, socket_id) {
        Some(url) => url,
        None => {
            log::warn!("Failed to build pool WS URL");
            return;
        }
    };

    let task = tokio::spawn(async move {
        let mut backoff = 1u64;
        loop {
            log::info!("Connecting pool WS...");
            let ws_result = timeout(POOL_WS_CONNECT_TIMEOUT, connect_async(ws_url.as_str())).await;
            let ws_stream = match ws_result {
                Ok(Ok((stream, _))) => {
                    backoff = 1; // reset on success
                    stream
                }
                Ok(Err(e)) => {
                    log::warn!("Pool WS connect failed: {}, retry in {}s", e, backoff);
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(POOL_WS_MAX_BACKOFF.as_secs());
                    continue;
                }
                Err(_) => {
                    log::warn!("Pool WS connect timed out, retry in {}s", backoff);
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(POOL_WS_MAX_BACKOFF.as_secs());
                    continue;
                }
            };
            log::info!("Pool WS connected, waiting for assignment...");

            let (mut ws_sink, mut ws_read) = ws_stream.split();
            let mut ping_interval = tokio::time::interval(POOL_WS_PING_INTERVAL);
            ping_interval.tick().await; // consume the immediate first tick

            // Wait for assignment text frame from hub, sending pings to stay alive
            loop {
                tokio::select! {
                    msg = ws_read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(tunnel_id) = val["assign"].as_str() {
                                        let tunnel_id = tunnel_id.to_string();
                                        log::info!("Pool WS assigned: {}", tunnel_id);
                                        let _ = pool_tx
                                            .send(PoolEvent::Assigned {
                                                tunnel_id,
                                                ws_sink,
                                                ws_stream: ws_read,
                                            })
                                            .await;
                                        return; // main loop will replenish
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                                log::info!(
                                    "Pool WS closed while idle, reconnecting in {}s",
                                    backoff
                                );
                                break; // reconnect via outer loop
                            }
                            _ => {} // Pong, Binary, etc.
                        }
                    }
                    _ = ping_interval.tick() => {
                        if ws_sink.send(Message::Ping(vec![])).await.is_err() {
                            log::info!("Pool WS ping failed, reconnecting");
                            break;
                        }
                    }
                }
            }

            // WS closed without assignment — retry
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(POOL_WS_MAX_BACKOFF.as_secs());
        }
    });

    *current_task = Some(task);
}

fn attach_pool_ws(
    tunnels: &mut HashMap<String, TunnelHandle>,
    client: &SocketClient,
    tunnel_id: &str,
    mut ws_sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    mut ws_stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) {
    let handle = match tunnels.get_mut(tunnel_id) {
        Some(h) => h,
        None => {
            log::warn!("Pool WS assigned to unknown tunnel {}", tunnel_id);
            return;
        }
    };

    let tcp_read = match handle.pending_read.take() {
        Some(r) => r,
        None => {
            log::warn!("Tunnel {} has no pending TCP read for pool WS", tunnel_id);
            return;
        }
    };

    handle.has_ws = true;
    log::info!("Tunnel {} pool WS attached, starting relay", tunnel_id);

    // TCP read → WS binary send
    let read_client = client.clone();
    let read_tid = tunnel_id.to_string();
    let read_task = tokio::spawn(async move {
        let mut tcp_read = tcp_read;
        let mut buf = [0u8; 16384];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => {
                    log::info!("Tunnel {} TCP EOF", read_tid);
                    let _ = read_client
                        .emit("tunnel:close", json!({"tunnelId": &read_tid}))
                        .await;
                    let _ = ws_sink.close().await;
                    break;
                }
                Ok(n) => {
                    log::debug!("Tunnel {} TCP→WS {}b", read_tid, n);
                    if ws_sink
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        log::warn!("Tunnel {} WS sink send failed", read_tid);
                        break;
                    }
                }
                Err(e) => {
                    log::warn!("Tunnel {} TCP read error: {}", read_tid, e);
                    let _ = read_client
                        .emit(
                            "tunnel:error",
                            json!({"tunnelId": &read_tid, "message": e.to_string()}),
                        )
                        .await;
                    break;
                }
            }
        }
    });

    // WS binary recv → TCP write
    let ws_write_tx = handle.write_tx.clone();
    let ws_tid = tunnel_id.to_string();
    let ws_read_task = tokio::spawn(async move {
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    log::debug!("Tunnel {} WS→TCP {}b", ws_tid, data.len());
                    if ws_write_tx.send(data).await.is_err() {
                        log::warn!("Tunnel {} TCP write channel closed", ws_tid);
                        break;
                    }
                }
                Ok(Message::Text(text)) => {
                    log::warn!(
                        "Tunnel {} unexpected text on pool WS: {}",
                        ws_tid,
                        &text[..text.len().min(100)]
                    );
                }
                Ok(Message::Close(_)) | Err(_) => {
                    log::info!("Tunnel {} pool WS closed", ws_tid);
                    break;
                }
                _ => {}
            }
        }
    });

    handle.tasks.push(read_task);
    handle.tasks.push(ws_read_task);
}

fn build_pool_ws_url(
    api_url: &str,
    token: &str,
    machine_id: &str,
    socket_id: Option<&str>,
) -> Option<String> {
    let base = api_url.replace("http", "ws");
    let mut url = url::Url::parse(&format!("{}/tunnel/pool", base)).ok()?;
    url.query_pairs_mut()
        .append_pair("token", token)
        .append_pair("machineId", machine_id);
    if let Some(sid) = socket_id {
        url.query_pairs_mut().append_pair("socketId", sid);
    }
    Some(url.to_string())
}

fn build_tunnel_ws_url(api_url: &str, tunnel_id: &str, token: &str) -> Option<String> {
    let base = api_url.replace("http", "ws");
    let mut url = url::Url::parse(&format!("{}/tunnel/ws/{}", base, tunnel_id)).ok()?;
    url.query_pairs_mut()
        .append_pair("token", token)
        .append_pair("role", "runner");
    Some(url.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn handle_tunnel_open(
    tunnels: &mut HashMap<String, TunnelHandle>,
    client: &SocketClient,
    tunnel_id: String,
    host: &str,
    port: u16,
    api_url: &str,
    token: &str,
    pool_active: bool,
    pool_tx: &mpsc::Sender<PoolEvent>,
    pending_pool: &mut HashMap<String, PendingPoolAssignment>,
    data_dir: &str,
) {
    if port == 0 {
        // Built-in SSH server — no TCP, use in-memory duplex stream
        log::info!("Tunnel {} using built-in SSH server", tunnel_id);
        if let Err(e) = client
            .emit("tunnel:ready", json!({ "tunnelId": &tunnel_id }))
            .await
        {
            log::error!("Failed to emit tunnel:ready: {}", e);
            return;
        }

        let (ssh_stream, tunnel_stream) = tokio::io::duplex(64 * 1024);
        let (tunnel_read, tunnel_write) = tokio::io::split(tunnel_stream);
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(256);

        // Write task: channel bytes → tunnel stream → SSH server
        let write_task = tokio::spawn(async move {
            tcp_write_loop(tunnel_write, write_rx).await;
        });

        // Read task: SSH server output → tunnel stream → Socket.IO/WS
        let read_client = client.clone();
        let read_tid = tunnel_id.clone();
        let read_task = tokio::spawn(async move {
            tcp_read_loop(tunnel_read, &read_client, &read_tid).await;
        });

        // SSH server task
        let dd = data_dir.to_string();
        tokio::spawn(async move {
            crate::ssh_server::serve(ssh_stream, &dd).await;
        });

        tunnels.insert(
            tunnel_id,
            TunnelHandle {
                write_tx,
                tasks: vec![write_task, read_task],
                has_ws: false,
                pending_read: None,
            },
        );
        return;
    }

    match TcpStream::connect((host, port)).await {
        Ok(stream) => {
            // Notify hub that TCP connection is ready
            if let Err(e) = client
                .emit("tunnel:ready", json!({ "tunnelId": &tunnel_id }))
                .await
            {
                log::error!("Failed to emit tunnel:ready: {}", e);
                return;
            }

            let (tcp_read, tcp_write) = stream.into_split();
            let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(256);

            // Spawn TCP write task immediately (receives bytes, writes to TCP)
            let write_task = tokio::spawn(async move {
                tcp_write_loop(tcp_write, write_rx).await;
            });

            if pool_active {
                // Pool mode: hold TCP read half, wait for pool WS assignment
                log::info!("Tunnel {} waiting for pool WS assignment", tunnel_id);
                // Schedule fallback timeout in case pool WS assignment never arrives
                let timeout_tx = pool_tx.clone();
                let timeout_tid = tunnel_id.clone();
                let timeout_task = tokio::spawn(async move {
                    tokio::time::sleep(POOL_WS_ASSIGN_TIMEOUT).await;
                    let _ = timeout_tx
                        .send(PoolEvent::Timeout {
                            tunnel_id: timeout_tid,
                        })
                        .await;
                });
                tunnels.insert(
                    tunnel_id.clone(),
                    TunnelHandle {
                        write_tx,
                        tasks: vec![write_task, timeout_task],
                        has_ws: false,
                        pending_read: Some(Box::new(tcp_read)),
                    },
                );
                // Check if pool WS assignment arrived before this tunnel was created
                if let Some(pending) = pending_pool.remove(&tunnel_id) {
                    log::info!("Tunnel {} attaching buffered pool WS", tunnel_id);
                    attach_pool_ws(
                        tunnels,
                        client,
                        &tunnel_id,
                        pending.ws_sink,
                        pending.ws_stream,
                    );
                }
            } else {
                // No pool: try per-tunnel WS upgrade (existing behavior)
                let mut tcp_read = tcp_read;
                let ws_url = build_tunnel_ws_url(api_url, &tunnel_id, token);
                let ws_ok = match &ws_url {
                    Some(url) => timeout(PER_TUNNEL_WS_TIMEOUT, connect_async(url.as_str()))
                        .await
                        .ok(),
                    None => None,
                };

                if let Some(Ok((ws_stream, _))) = ws_ok {
                    log::info!("Tunnel {} upgraded to WebSocket binary", tunnel_id);
                    let (mut ws_sink, mut ws_stream) = ws_stream.split();

                    // TCP read → WS binary send
                    let read_client = client.clone();
                    let read_tid = tunnel_id.clone();
                    let read_task = tokio::spawn(async move {
                        let mut buf = [0u8; 16384];
                        loop {
                            match tcp_read.read(&mut buf).await {
                                Ok(0) => {
                                    let _ = read_client
                                        .emit("tunnel:close", json!({"tunnelId": &read_tid}))
                                        .await;
                                    let _ = ws_sink.close().await;
                                    break;
                                }
                                Ok(n) => {
                                    if ws_sink
                                        .send(Message::Binary(buf[..n].to_vec()))
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                                Err(e) => {
                                    let _ = read_client
                                        .emit(
                                            "tunnel:error",
                                            json!({"tunnelId": &read_tid, "message": e.to_string()}),
                                        )
                                        .await;
                                    break;
                                }
                            }
                        }
                    });

                    // WS binary recv → TCP write
                    let ws_write_tx = write_tx.clone();
                    let ws_read_task = tokio::spawn(async move {
                        while let Some(msg) = ws_stream.next().await {
                            match msg {
                                Ok(Message::Binary(data)) => {
                                    if ws_write_tx.send(data).await.is_err() {
                                        break;
                                    }
                                }
                                Ok(Message::Close(_)) | Err(_) => break,
                                _ => {}
                            }
                        }
                    });

                    tunnels.insert(
                        tunnel_id,
                        TunnelHandle {
                            write_tx,
                            tasks: vec![read_task, write_task, ws_read_task],
                            has_ws: true,
                            pending_read: None,
                        },
                    );
                } else {
                    // Fallback to Socket.IO base64
                    if ws_url.is_some() {
                        log::info!(
                            "Tunnel {} WebSocket upgrade failed, using Socket.IO",
                            tunnel_id
                        );
                    }
                    let read_client = client.clone();
                    let read_tid = tunnel_id.clone();
                    let read_task = tokio::spawn(async move {
                        tcp_read_loop(tcp_read, &read_client, &read_tid).await;
                    });

                    tunnels.insert(
                        tunnel_id,
                        TunnelHandle {
                            write_tx,
                            tasks: vec![read_task, write_task],
                            has_ws: false,
                            pending_read: None,
                        },
                    );
                }
            }
        }
        Err(e) => {
            log::error!("Tunnel {} TCP connect failed: {}", tunnel_id, e);
            let _ = client
                .emit(
                    "tunnel:error",
                    json!({
                        "tunnelId": &tunnel_id,
                        "message": format!("connect ECONNREFUSED {}:{}", host, port),
                    }),
                )
                .await;
        }
    }
}

/// Socket.IO fallback: reads from TCP, base64-encodes, emits tunnel:data
async fn tcp_read_loop(
    mut tcp_read: impl AsyncRead + Unpin,
    client: &SocketClient,
    tunnel_id: &str,
) {
    let mut buf = [0u8; 16384];
    loop {
        match tcp_read.read(&mut buf).await {
            Ok(0) => {
                log::debug!("Tunnel {} TCP EOF", tunnel_id);
                let _ = client
                    .emit("tunnel:close", json!({ "tunnelId": tunnel_id }))
                    .await;
                break;
            }
            Ok(n) => {
                let b64 = B64.encode(&buf[..n]);
                if let Err(e) = client
                    .emit(
                        "tunnel:data",
                        json!({
                            "tunnelId": tunnel_id,
                            "data": b64,
                        }),
                    )
                    .await
                {
                    log::warn!("Tunnel {} failed to emit data: {}", tunnel_id, e);
                    break;
                }
            }
            Err(e) => {
                log::debug!("Tunnel {} TCP read error: {}", tunnel_id, e);
                let _ = client
                    .emit(
                        "tunnel:error",
                        json!({
                            "tunnelId": tunnel_id,
                            "message": e.to_string(),
                        }),
                    )
                    .await;
                break;
            }
        }
    }
}

async fn tcp_write_loop(
    mut tcp_write: impl tokio::io::AsyncWrite + Unpin,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
) {
    while let Some(bytes) = write_rx.recv().await {
        if let Err(e) = tcp_write.write_all(&bytes).await {
            log::debug!("TCP write error: {}", e);
            break;
        }
    }
}

fn handle_rpc(method: &str, _params_json: &str, machine_id: &str) -> String {
    let suffix = method
        .strip_prefix(machine_id)
        .and_then(|s| s.strip_prefix(':'))
        .unwrap_or(method);

    log::warn!("Unknown RPC method: {}", suffix);
    json!({"error": "Method not found"}).to_string()
}
