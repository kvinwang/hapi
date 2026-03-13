use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::json;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::connection::SocketEvent;
use crate::socket::SocketClient;

struct TunnelHandle {
    /// Send decoded bytes to the TCP write task.
    write_tx: mpsc::Sender<Vec<u8>>,
    /// Handle to abort the TCP read task.
    read_task: JoinHandle<()>,
    /// Handle to abort the TCP write task.
    write_task: JoinHandle<()>,
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        self.read_task.abort();
        self.write_task.abort();
    }
}

pub async fn run(
    mut event_rx: mpsc::Receiver<SocketEvent>,
    client: SocketClient,
    machine_id: String,
) {
    let mut tunnels: HashMap<String, TunnelHandle> = HashMap::new();

    while let Some(event) = event_rx.recv().await {
        match event {
            SocketEvent::TunnelOpen { tunnel_id, host, port } => {
                let target_host = host.as_deref().unwrap_or("127.0.0.1");
                log::info!("Tunnel open: {} -> {}:{}", tunnel_id, target_host, port);
                handle_tunnel_open(&mut tunnels, &client, tunnel_id, target_host, port).await;
            }
            SocketEvent::TunnelData { tunnel_id, data } => {
                if let Some(handle) = tunnels.get(&tunnel_id) {
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
            SocketEvent::RpcRequest { ack_id, method, params } => {
                log::info!("RPC request: {} (ack_id={})", method, ack_id);
                let response = handle_rpc(&method, &params, &machine_id);
                let ack_data = serde_json::Value::String(response);
                if let Err(e) = client.send_ack(ack_id, ack_data).await {
                    log::warn!("Failed to send RPC ack: {}", e);
                }
            }
            SocketEvent::Disconnected => {
                log::warn!("Socket.IO disconnected, closing {} tunnels", tunnels.len());
                tunnels.clear();
                return; // Let main loop handle reconnect
            }
        }
    }
}

fn handle_rpc(method: &str, params_json: &str, machine_id: &str) -> String {
    let suffix = method
        .strip_prefix(machine_id)
        .and_then(|s| s.strip_prefix(':'))
        .unwrap_or(method);

    match suffix {
        "import-ssh-key" => handle_import_ssh_key(params_json),
        _ => {
            log::warn!("Unknown RPC method: {}", method);
            json!({"error": "Method not found"}).to_string()
        }
    }
}

fn handle_import_ssh_key(params_json: &str) -> String {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    let params: serde_json::Value =
        serde_json::from_str(params_json).unwrap_or(serde_json::Value::Null);
    let public_key = match params.get("publicKey").and_then(|v| v.as_str()) {
        Some(k) => k.trim(),
        None => {
            return json!({"success": false, "error": "Missing publicKey"}).to_string();
        }
    };

    const VALID_PREFIXES: &[&str] = &[
        "ssh-rsa",
        "ssh-ed25519",
        "ssh-dss",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "sk-ssh-ed25519",
        "sk-ecdsa-sha2-nistp256",
    ];
    if !VALID_PREFIXES.iter().any(|p| public_key.starts_with(p)) {
        return json!({"success": false, "error": "Invalid SSH public key format"}).to_string();
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    let ssh_dir = PathBuf::from(&home).join(".ssh");
    let auth_keys_path = ssh_dir.join("authorized_keys");

    if let Err(e) = fs::create_dir_all(&ssh_dir) {
        return json!({"success": false, "error": e.to_string()}).to_string();
    }
    if let Err(e) = fs::set_permissions(&ssh_dir, fs::Permissions::from_mode(0o700)) {
        return json!({"success": false, "error": e.to_string()}).to_string();
    }

    let existing = fs::read_to_string(&auth_keys_path).unwrap_or_default();

    // Compare by key type + key data (ignore comment)
    let parts: Vec<&str> = public_key.split_whitespace().collect();
    let fingerprint = if parts.len() >= 2 {
        format!("{} {}", parts[0], parts[1])
    } else {
        public_key.to_string()
    };

    let username = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .or_else(|_| {
            std::process::Command::new("whoami")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .ok_or(std::env::VarError::NotPresent)
        })
        .unwrap_or_else(|_| "unknown".to_string());

    if existing.contains(&fingerprint) {
        return json!({"success": true, "added": false, "message": format!("Key already present in ~{}/.ssh/authorized_keys", username)})
            .to_string();
    }

    let new_content = if existing.is_empty() || existing.ends_with('\n') {
        format!("{}{}\n", existing, public_key)
    } else {
        format!("{}\n{}\n", existing, public_key)
    };

    if let Err(e) = fs::write(&auth_keys_path, &new_content) {
        return json!({"success": false, "error": e.to_string()}).to_string();
    }
    if let Err(e) = fs::set_permissions(&auth_keys_path, fs::Permissions::from_mode(0o600)) {
        return json!({"success": false, "error": e.to_string()}).to_string();
    }

    log::info!("Imported SSH key to {}", auth_keys_path.display());
    json!({"success": true, "added": true, "message": format!("Key added to ~{}/.ssh/authorized_keys", username)}).to_string()
}

async fn handle_tunnel_open(
    tunnels: &mut HashMap<String, TunnelHandle>,
    client: &SocketClient,
    tunnel_id: String,
    host: &str,
    port: u16,
) {
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

            // Spawn TCP read task: reads from TCP, base64-encodes, emits tunnel:data
            let read_client = client.clone();
            let read_tid = tunnel_id.clone();
            let read_task = tokio::spawn(async move {
                tcp_read_loop(tcp_read, &read_client, &read_tid).await;
            });

            // Spawn TCP write task: receives bytes from channel, writes to TCP
            let write_task = tokio::spawn(async move {
                tcp_write_loop(tcp_write, write_rx).await;
            });

            tunnels.insert(
                tunnel_id,
                TunnelHandle {
                    write_tx,
                    read_task,
                    write_task,
                },
            );
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

async fn tcp_read_loop(
    mut tcp_read: tokio::net::tcp::OwnedReadHalf,
    client: &SocketClient,
    tunnel_id: &str,
) {
    let mut buf = [0u8; 16384];
    loop {
        match tcp_read.read(&mut buf).await {
            Ok(0) => {
                // EOF — TCP connection closed
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
    mut tcp_write: tokio::net::tcp::OwnedWriteHalf,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
) {
    while let Some(bytes) = write_rx.recv().await {
        if let Err(e) = tcp_write.write_all(&bytes).await {
            log::debug!("TCP write error: {}", e);
            break;
        }
    }
}

