use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::socket::SocketClient;

/// Events forwarded from Socket.IO to the main loop.
#[derive(Debug)]
pub enum SocketEvent {
    TunnelOpen { tunnel_id: String, host: Option<String>, port: u16 },
    TunnelData { tunnel_id: String, data: String },
    TunnelClose { tunnel_id: String },
    Disconnected,
}

pub async fn connect(
    config: &Config,
    event_tx: mpsc::Sender<SocketEvent>,
) -> Result<SocketClient, Box<dyn std::error::Error>> {
    let auth = json!({
        "token": config.token,
        "clientType": "machine-scoped",
        "machineId": config.machine_id,
    });

    let tx = event_tx.clone();
    let client = SocketClient::connect(&config.api_url, "/cli", auth, move |event, data, _client| {
        let tx = tx.clone();
        let socket_event = match event.as_str() {
            "tunnel:open" => {
                let tunnel_id = data["tunnelId"].as_str().unwrap_or("").to_string();
                let port = data["port"].as_u64().unwrap_or(0) as u16;
                let host = data["host"].as_str().map(|s| s.to_string());
                if tunnel_id.is_empty() || port == 0 {
                    return;
                }
                SocketEvent::TunnelOpen { tunnel_id, host, port }
            }
            "tunnel:data" => {
                let tunnel_id = data["tunnelId"].as_str().unwrap_or("").to_string();
                let data = data["data"].as_str().unwrap_or("").to_string();
                if tunnel_id.is_empty() {
                    return;
                }
                SocketEvent::TunnelData { tunnel_id, data }
            }
            "tunnel:close" => {
                let tunnel_id = data["tunnelId"].as_str().unwrap_or("").to_string();
                if tunnel_id.is_empty() {
                    return;
                }
                SocketEvent::TunnelClose { tunnel_id }
            }
            _ => return,
        };
        let _ = tx.try_send(socket_event);
    })
    .await?;

    // Handle disconnection — forward to event loop
    let dc_notify = client.on_disconnect();
    let dc_tx = event_tx.clone();
    tokio::spawn(async move {
        dc_notify.notified().await;
        let _ = dc_tx.send(SocketEvent::Disconnected).await;
    });

    Ok(client)
}

pub async fn emit_initial_state(
    client: &SocketClient,
    machine_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let _ack = client
        .emit_with_ack(
            "machine-update-state",
            json!({
                "machineId": machine_id,
                "runnerState": {
                    "status": "running",
                    "startedAt": now,
                },
                "expectedVersion": 0,
            }),
            10,
        )
        .await?;

    log::info!("Emitted initial runner state");
    Ok(())
}

pub async fn keep_alive(client: SocketClient, machine_id: String) {
    let mut interval = tokio::time::interval(Duration::from_secs(20));
    loop {
        interval.tick().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        if let Err(e) = client
            .emit(
                "machine-alive",
                json!({
                    "machineId": machine_id,
                    "time": now,
                }),
            )
            .await
        {
            log::warn!("Failed to send keep-alive: {}", e);
        }
    }
}
