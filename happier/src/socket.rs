use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

/// A minimal Socket.IO (EIO4) client over WebSocket.
#[derive(Clone)]
pub struct SocketClient {
    write_tx: mpsc::Sender<Message>,
    ack_waiters: Arc<std::sync::Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: Arc<std::sync::Mutex<i64>>,
    namespace: String,
    disconnect_notify: Arc<Notify>,
}

impl SocketClient {
    pub async fn connect(
        api_url: &str,
        namespace: &str,
        auth: Value,
        on_event: impl Fn(String, Value, SocketClient) + Send + Sync + 'static,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        // Build WebSocket URL
        let mut url = Url::parse(api_url)?;
        let scheme = match url.scheme() {
            "https" => "wss",
            _ => "ws",
        };
        url.set_scheme(scheme).map_err(|_| "invalid url scheme")?;
        url.set_path("/socket.io/");
        url.set_query(Some("EIO=4&transport=websocket"));

        let (stream, _) = connect_async(url.as_str()).await?;
        let (ws_write, mut ws_read) = stream.split();

        // Spawn writer task
        let (write_tx, mut write_rx) = mpsc::channel::<Message>(128);
        tokio::spawn(async move {
            let mut ws_write = ws_write;
            while let Some(msg) = write_rx.recv().await {
                if ws_write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        let disconnect_notify = Arc::new(Notify::new());
        let client = SocketClient {
            write_tx: write_tx.clone(),
            ack_waiters: Arc::new(std::sync::Mutex::new(HashMap::new())),
            next_id: Arc::new(std::sync::Mutex::new(1)),
            namespace: namespace.to_string(),
            disconnect_notify: disconnect_notify.clone(),
        };

        // Read EIO open packet (type 0)
        if let Some(Ok(Message::Text(open))) = ws_read.next().await {
            if !open.starts_with('0') {
                return Err(format!("expected EIO open, got: {}", &open[..open.len().min(80)]).into());
            }
        } else {
            return Err("no EIO open packet".into());
        }

        // Send Socket.IO connect packet: 40/namespace,{auth}
        let connect_pkt = format!("40{},{}", namespace, auth.to_string());
        write_tx.send(Message::Text(connect_pkt)).await?;

        // Wait for connect ack (40/namespace)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err("Socket.IO connect ack timed out".into());
            }
            match timeout(remaining, ws_read.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    // EIO ping
                    if text == "2" {
                        let _ = write_tx.send(Message::Text("3".to_string())).await;
                        continue;
                    }
                    // Socket.IO connect ack
                    if text.starts_with(&format!("40{}", namespace)) {
                        break;
                    }
                    // Socket.IO error
                    if text.starts_with(&format!("44{}", namespace)) {
                        return Err(format!("Socket.IO connect error: {}", text).into());
                    }
                    if text.starts_with("41") {
                        return Err(format!("Socket.IO closed during connect: {}", text).into());
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(e))) => return Err(e.into()),
                Ok(None) => return Err("WebSocket closed during connect".into()),
                Err(_) => return Err("Socket.IO connect ack timed out".into()),
            }
        }

        // Spawn reader task
        let client_clone = client.clone();
        let ns = namespace.to_string();
        let on_event = Arc::new(on_event);
        let dn = disconnect_notify.clone();
        let ping_tx = write_tx.clone();
        tokio::spawn(async move {
            while let Some(msg) = ws_read.next().await {
                let Ok(msg) = msg else { break };
                match msg {
                    Message::Text(text) => {
                        // EIO ping → pong
                        if text == "2" {
                            let _ = ping_tx.send(Message::Text("3".to_string())).await;
                            continue;
                        }
                        // EIO/SIO disconnect
                        if text.starts_with('1')
                            || text.starts_with(&format!("41{}", ns))
                        {
                            break;
                        }
                        // Only process Socket.IO packets (prefix '4')
                        if !text.starts_with('4') {
                            continue;
                        }
                        let Some(pkt) = parse_sio_packet(&text, &ns) else {
                            continue;
                        };
                        match pkt.packet_type {
                            // ACK response
                            3 => {
                                if let (Some(id), Some(payload)) = (pkt.id, pkt.payload) {
                                    if let Ok(mut waiters) = client_clone.ack_waiters.lock() {
                                        if let Some(tx) = waiters.remove(&id) {
                                            let _ = tx.send(payload);
                                        }
                                    }
                                }
                            }
                            // EVENT
                            2 => {
                                if let Some(payload) = pkt.payload {
                                    if let Some(event) =
                                        payload.get(0).and_then(|v| v.as_str())
                                    {
                                        let data =
                                            payload.get(1).cloned().unwrap_or(Value::Null);
                                        on_event(
                                            event.to_string(),
                                            data,
                                            client_clone.clone(),
                                        );
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            dn.notify_waiters();
        });

        Ok(client)
    }

    pub async fn emit(&self, event: &str, data: Value) -> Result<(), Box<dyn std::error::Error>> {
        let payload = json!([event, data]).to_string();
        let packet = format!("42{},{}", self.namespace, payload);
        self.write_tx
            .send(Message::Text(packet))
            .await
            .map_err(|_| "socket write failed")?;
        Ok(())
    }

    pub async fn emit_with_ack(
        &self,
        event: &str,
        data: Value,
        timeout_secs: u64,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        let id = {
            let mut next = self.next_id.lock().map_err(|_| "lock poisoned")?;
            let id = *next;
            *next += 1;
            id
        };
        let payload = json!([event, data]).to_string();
        let packet = format!("42{},{}{}", self.namespace, id, payload);
        let (tx, rx) = oneshot::channel();
        {
            let mut waiters = self.ack_waiters.lock().map_err(|_| "lock poisoned")?;
            waiters.insert(id, tx);
        }
        self.write_tx
            .send(Message::Text(packet))
            .await
            .map_err(|_| "socket write failed")?;
        let result = timeout(Duration::from_secs(timeout_secs), rx).await??;
        Ok(result)
    }

    pub async fn disconnect(&self) -> Result<(), Box<dyn std::error::Error>> {
        let packet = format!("41{}", self.namespace);
        let _ = self.write_tx.send(Message::Text(packet)).await;
        Ok(())
    }

    pub fn on_disconnect(&self) -> Arc<Notify> {
        self.disconnect_notify.clone()
    }
}

struct SioPacket {
    packet_type: i32,
    id: Option<i64>,
    payload: Option<Value>,
}

fn parse_sio_packet(input: &str, namespace: &str) -> Option<SioPacket> {
    // input starts with '4', strip it
    let mut rest = &input[1..];
    if rest.is_empty() {
        return None;
    }

    // Next char is SIO packet type (2=event, 3=ack, etc.)
    let packet_type = rest.chars().next()?.to_digit(10)? as i32;
    rest = &rest[1..];

    // Strip namespace prefix + comma
    if rest.starts_with(namespace) {
        rest = &rest[namespace.len()..];
        if rest.starts_with(',') {
            rest = &rest[1..];
        }
    }

    // Parse optional numeric ack ID
    let mut id: Option<i64> = None;
    let digit_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digit_len > 0 {
        if let Ok(parsed) = rest[..digit_len].parse::<i64>() {
            id = Some(parsed);
        }
        rest = &rest[digit_len..];
    }

    let payload = if rest.trim().is_empty() {
        None
    } else {
        serde_json::from_str(rest).ok()
    };

    Some(SioPacket {
        packet_type,
        id,
        payload,
    })
}
