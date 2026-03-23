use crate::{config::Config, sse::EventBus, store::Store};
use axum::extract::ws::Message;
use parking_lot::Mutex;
use serde_json::Value;
use socketioxide::{extract::SocketRef, socket::Sid};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::{mpsc::UnboundedSender, oneshot};
use tokio::time::{sleep, Duration};

const DEFAULT_IDLE_TIMEOUT_MS: u64 = 15 * 60_000;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub store: Store,
    pub events: EventBus,
    pub jwt_secret: Arc<Vec<u8>>,
    pub visibility: Arc<Mutex<HashMap<String, VisibilityRecord>>>,
    pub cli_sockets: Arc<Mutex<HashMap<Sid, SocketRef>>>,
    pub session_cli_sockets: Arc<Mutex<HashMap<String, HashMap<Sid, SocketRef>>>>,
    pub machine_cli_sockets: Arc<Mutex<HashMap<String, HashMap<Sid, SocketRef>>>>,
    pub rpc_methods: Arc<Mutex<HashMap<String, Sid>>>,
    pub socket_scopes: Arc<Mutex<HashMap<Sid, SocketScopes>>>,
    pub terminals: Arc<Mutex<HashMap<String, TerminalEntry>>>,
    pub tunnels: Arc<Mutex<HashMap<String, TunnelEntry>>>,
    pub tunnel_ws_pairs: Arc<Mutex<HashMap<String, TunnelWsPair>>>,
    pub pool_ws_entries: Arc<Mutex<HashMap<String, PoolWsEntry>>>,
    pub idle_pool_ws: Arc<Mutex<HashMap<String, Vec<String>>>>,
    pub qr_sessions: Arc<Mutex<HashMap<String, QrSession>>>,
    pub lobstear_devices: Arc<Mutex<HashMap<String, LobstearRuntime>>>,
}

#[derive(Debug, Clone)]
pub struct VisibilityRecord {
    pub namespace: String,
    pub visibility: String,
}

#[derive(Debug, Clone, Default)]
pub struct SocketScopes {
    pub session_ids: HashSet<String>,
    pub machine_ids: HashSet<String>,
    pub rpc_methods: HashSet<String>,
    pub ws_tunnel: bool,
    pub builtin_ssh: bool,
}

#[derive(Clone)]
pub struct TerminalClient {
    pub socket_id: Sid,
    pub socket: SocketRef,
}

#[derive(Clone)]
pub struct TerminalEntry {
    pub terminal_id: String,
    pub session_id: String,
    pub cli_socket_id: Sid,
    pub cli_socket: SocketRef,
    pub web_clients: HashMap<Sid, SocketRef>,
    pub output_buffer: String,
    pub idle_generation: u64,
}

#[derive(Clone)]
pub struct TunnelEntry {
    pub tunnel_id: String,
    pub namespace: String,
    pub machine_id: String,
    pub port: u16,
    pub connect_socket_id: Sid,
    pub connect_socket: SocketRef,
    pub runner_socket_id: Sid,
    pub runner_socket: SocketRef,
    pub idle_generation: u64,
}

#[derive(Clone)]
pub struct TunnelWsPeer {
    pub peer_id: String,
    pub sender: UnboundedSender<Message>,
}

#[derive(Clone, Default)]
pub struct TunnelWsPair {
    pub connect: Option<TunnelWsPeer>,
    pub runner: Option<TunnelWsPeer>,
}

#[derive(Clone)]
pub struct PoolWsEntry {
    pub pool_id: String,
    pub machine_id: String,
    pub sender: UnboundedSender<Message>,
    pub assigned_tunnel_id: Option<String>,
}

#[derive(Clone)]
pub struct IdlePoolWs {
    pub pool_id: String,
    pub sender: UnboundedSender<Message>,
}

#[derive(Debug, Clone)]
pub struct QrSession {
    pub id: String,
    pub secret: String,
    pub status: QrStatus,
    pub created_at: i64,
    pub access_token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrStatus {
    Pending,
    Confirmed,
}

pub struct LobstearRuntime {
    pub stream_id: Option<String>,
    pub down_tx: Option<UnboundedSender<Value>>,
    pub speaker_connected: bool,
    pub interrupted: bool,
    pub pending_tool_calls: HashMap<String, oneshot::Sender<LobstearToolResult>>,
}

#[derive(Debug, Clone)]
pub struct LobstearToolResult {
    pub result: Value,
    pub error: Option<String>,
}

impl AppState {
    pub fn new(config: Config, store: Store, jwt_secret: Vec<u8>) -> Self {
        Self {
            config,
            store,
            events: EventBus::new(),
            jwt_secret: Arc::new(jwt_secret),
            visibility: Arc::new(Mutex::new(HashMap::new())),
            cli_sockets: Arc::new(Mutex::new(HashMap::new())),
            session_cli_sockets: Arc::new(Mutex::new(HashMap::new())),
            machine_cli_sockets: Arc::new(Mutex::new(HashMap::new())),
            rpc_methods: Arc::new(Mutex::new(HashMap::new())),
            socket_scopes: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            tunnels: Arc::new(Mutex::new(HashMap::new())),
            tunnel_ws_pairs: Arc::new(Mutex::new(HashMap::new())),
            pool_ws_entries: Arc::new(Mutex::new(HashMap::new())),
            idle_pool_ws: Arc::new(Mutex::new(HashMap::new())),
            qr_sessions: Arc::new(Mutex::new(HashMap::new())),
            lobstear_devices: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register_cli_socket(&self, socket: SocketRef) {
        self.cli_sockets.lock().insert(socket.id, socket.clone());
        self.socket_scopes.lock().entry(socket.id).or_default();
    }

    pub fn cli_socket(&self, sid: Sid) -> Option<SocketRef> {
        self.cli_sockets.lock().get(&sid).cloned()
    }

    pub fn rpc_socket(&self, method: &str) -> Option<SocketRef> {
        let sid = self.rpc_methods.lock().get(method).copied()?;
        self.cli_socket(sid)
    }

    pub fn register_session_socket(&self, session_id: &str, socket: SocketRef) {
        let sid = socket.id;
        self.session_cli_sockets
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .insert(sid, socket);
        self.socket_scopes
            .lock()
            .entry(sid)
            .or_default()
            .session_ids
            .insert(session_id.to_string());
    }

    pub fn register_machine_socket(&self, machine_id: &str, socket: SocketRef) {
        let sid = socket.id;
        self.machine_cli_sockets
            .lock()
            .entry(machine_id.to_string())
            .or_default()
            .insert(sid, socket);
        self.socket_scopes
            .lock()
            .entry(sid)
            .or_default()
            .machine_ids
            .insert(machine_id.to_string());
    }

    pub fn get_session_socket(&self, session_id: &str) -> Option<SocketRef> {
        self.session_cli_sockets
            .lock()
            .get(session_id)
            .and_then(|sockets| sockets.values().next().cloned())
    }

    pub fn get_machine_socket(&self, machine_id: &str) -> Option<SocketRef> {
        self.machine_cli_sockets
            .lock()
            .get(machine_id)
            .and_then(|sockets| sockets.values().next().cloned())
    }

    pub fn rpc_register(&self, socket_id: Sid, method: String) {
        self.rpc_methods.lock().insert(method.clone(), socket_id);
        self.socket_scopes
            .lock()
            .entry(socket_id)
            .or_default()
            .rpc_methods
            .insert(method);
    }

    pub fn rpc_unregister(&self, socket_id: Sid, method: &str) {
        let mut rpc = self.rpc_methods.lock();
        if rpc.get(method) == Some(&socket_id) {
            rpc.remove(method);
        }
        if let Some(scopes) = self.socket_scopes.lock().get_mut(&socket_id) {
            scopes.rpc_methods.remove(method);
        }
    }

    pub fn rpc_socket_id(&self, method: &str) -> Option<Sid> {
        self.rpc_methods.lock().get(method).copied()
    }

    pub fn set_socket_ws_tunnel(&self, socket_id: Sid, enabled: bool) {
        self.socket_scopes
            .lock()
            .entry(socket_id)
            .or_default()
            .ws_tunnel = enabled;
    }

    pub fn set_socket_builtin_ssh(&self, socket_id: Sid, enabled: bool) {
        self.socket_scopes
            .lock()
            .entry(socket_id)
            .or_default()
            .builtin_ssh = enabled;
    }

    pub fn socket_supports_ws_tunnel(&self, socket_id: Sid) -> bool {
        self.socket_scopes
            .lock()
            .get(&socket_id)
            .map(|scopes| scopes.ws_tunnel)
            .unwrap_or(false)
    }

    pub fn socket_supports_builtin_ssh(&self, socket_id: Sid) -> bool {
        self.socket_scopes
            .lock()
            .get(&socket_id)
            .map(|scopes| scopes.builtin_ssh)
            .unwrap_or(false)
    }

    pub fn register_terminal(
        &self,
        terminal_id: &str,
        session_id: &str,
        cli_socket: SocketRef,
        web_socket: SocketRef,
    ) {
        let mut terminals = self.terminals.lock();
        let entry = terminals
            .entry(terminal_id.to_string())
            .or_insert_with(|| TerminalEntry {
                terminal_id: terminal_id.to_string(),
                session_id: session_id.to_string(),
                cli_socket_id: cli_socket.id,
                cli_socket: cli_socket.clone(),
                web_clients: HashMap::new(),
                output_buffer: String::new(),
                idle_generation: 0,
            });
        entry.session_id = session_id.to_string();
        entry.cli_socket_id = cli_socket.id;
        entry.cli_socket = cli_socket;
        entry.web_clients.insert(web_socket.id, web_socket);
    }

    pub fn terminal_entry(&self, terminal_id: &str) -> Option<TerminalEntry> {
        self.terminals.lock().get(terminal_id).cloned()
    }

    pub fn terminal_count_for_socket(&self, socket_id: Sid) -> usize {
        self.terminals
            .lock()
            .values()
            .filter(|entry| entry.web_clients.contains_key(&socket_id))
            .count()
    }

    pub fn terminal_count_for_session(&self, session_id: &str) -> usize {
        self.terminals
            .lock()
            .values()
            .filter(|entry| entry.session_id == session_id)
            .count()
    }

    pub fn append_terminal_output(&self, terminal_id: &str, data: &str) {
        if let Some(entry) = self.terminals.lock().get_mut(terminal_id) {
            entry.output_buffer.push_str(data);
            if entry.output_buffer.len() > 200_000 {
                let keep = entry.output_buffer.len() - 200_000;
                entry.output_buffer.drain(..keep);
            }
        }
    }

    pub fn remove_terminal(&self, terminal_id: &str) -> Option<TerminalEntry> {
        self.terminals.lock().remove(terminal_id)
    }

    pub fn detach_terminal_web_socket(&self, socket_id: Sid) -> Vec<String> {
        let mut terminals = self.terminals.lock();
        let mut touched = Vec::new();
        for (terminal_id, entry) in terminals.iter_mut() {
            if entry.web_clients.remove(&socket_id).is_some() {
                touched.push(terminal_id.clone());
            }
        }
        touched
    }

    pub fn register_tunnel(
        &self,
        tunnel_id: &str,
        namespace: &str,
        machine_id: &str,
        port: u16,
        connect_socket: SocketRef,
        runner_socket: SocketRef,
    ) -> bool {
        let mut tunnels = self.tunnels.lock();
        if tunnels.contains_key(tunnel_id) {
            return false;
        }
        tunnels.insert(
            tunnel_id.to_string(),
            TunnelEntry {
                tunnel_id: tunnel_id.to_string(),
                namespace: namespace.to_string(),
                machine_id: machine_id.to_string(),
                port,
                connect_socket_id: connect_socket.id,
                connect_socket,
                runner_socket_id: runner_socket.id,
                runner_socket,
                idle_generation: 0,
            },
        );
        true
    }

    pub fn tunnel_entry(&self, tunnel_id: &str) -> Option<TunnelEntry> {
        self.tunnels.lock().get(tunnel_id).cloned()
    }

    pub fn remove_tunnel(&self, tunnel_id: &str) -> Option<TunnelEntry> {
        self.tunnels.lock().remove(tunnel_id)
    }

    pub fn register_tunnel_ws_peer(
        &self,
        tunnel_id: &str,
        role: &str,
        peer_id: String,
        sender: UnboundedSender<Message>,
    ) {
        let mut pairs = self.tunnel_ws_pairs.lock();
        let pair = pairs.entry(tunnel_id.to_string()).or_default();
        let peer = Some(TunnelWsPeer { peer_id, sender });
        match role {
            "connect" => pair.connect = peer,
            "runner" => pair.runner = peer,
            _ => {}
        }
    }

    pub fn unregister_tunnel_ws_peer(&self, tunnel_id: &str, role: &str, peer_id: &str) {
        let mut pairs = self.tunnel_ws_pairs.lock();
        let Some(pair) = pairs.get_mut(tunnel_id) else {
            return;
        };
        let slot = match role {
            "connect" => &mut pair.connect,
            "runner" => &mut pair.runner,
            _ => return,
        };
        if slot.as_ref().map(|peer| peer.peer_id.as_str()) == Some(peer_id) {
            *slot = None;
        }
        if pair.connect.is_none() && pair.runner.is_none() {
            pairs.remove(tunnel_id);
        }
    }

    pub fn unregister_tunnel_ws_peer_by_role(&self, tunnel_id: &str, role: &str) {
        let mut pairs = self.tunnel_ws_pairs.lock();
        let Some(pair) = pairs.get_mut(tunnel_id) else {
            return;
        };
        match role {
            "connect" => pair.connect = None,
            "runner" => pair.runner = None,
            _ => return,
        }
        if pair.connect.is_none() && pair.runner.is_none() {
            pairs.remove(tunnel_id);
        }
    }

    pub fn tunnel_ws_sender(
        &self,
        tunnel_id: &str,
        role: &str,
    ) -> Option<UnboundedSender<Message>> {
        let pairs = self.tunnel_ws_pairs.lock();
        let pair = pairs.get(tunnel_id)?;
        match role {
            "connect" => pair.connect.as_ref().map(|peer| peer.sender.clone()),
            "runner" => pair.runner.as_ref().map(|peer| peer.sender.clone()),
            _ => None,
        }
    }

    pub fn close_tunnel_ws(&self, tunnel_id: &str) {
        let pair = self.tunnel_ws_pairs.lock().remove(tunnel_id);
        if let Some(pair) = pair {
            if let Some(connect) = pair.connect {
                let _ = connect.sender.send(Message::Close(None));
            }
            if let Some(runner) = pair.runner {
                let _ = runner.sender.send(Message::Close(None));
            }
        }
    }

    pub fn register_pool_ws(&self, machine_id: &str, sender: UnboundedSender<Message>) -> String {
        let pool_id = format!("pool:{}", uuid::Uuid::new_v4());
        self.pool_ws_entries.lock().insert(
            pool_id.clone(),
            PoolWsEntry {
                pool_id: pool_id.clone(),
                machine_id: machine_id.to_string(),
                sender,
                assigned_tunnel_id: None,
            },
        );
        self.idle_pool_ws
            .lock()
            .entry(machine_id.to_string())
            .or_default()
            .push(pool_id.clone());
        pool_id
    }

    pub fn try_acquire_pool_ws(&self, machine_id: &str) -> Option<IdlePoolWs> {
        let pool_id = {
            let mut idle = self.idle_pool_ws.lock();
            let ids = idle.get_mut(machine_id)?;
            let pool_id = ids.first()?.clone();
            ids.remove(0);
            if ids.is_empty() {
                idle.remove(machine_id);
            }
            pool_id
        };
        let sender = self.pool_ws_entries.lock().get(&pool_id)?.sender.clone();
        Some(IdlePoolWs { pool_id, sender })
    }

    pub fn assign_pool_ws(&self, pool_id: &str, tunnel_id: &str) {
        let sender = {
            let mut pool = self.pool_ws_entries.lock();
            let Some(entry) = pool.get_mut(pool_id) else {
                return;
            };
            entry.assigned_tunnel_id = Some(tunnel_id.to_string());
            entry.sender.clone()
        };
        self.register_tunnel_ws_peer(tunnel_id, "runner", pool_id.to_string(), sender);
    }

    pub fn pool_assigned_tunnel(&self, pool_id: &str) -> Option<String> {
        self.pool_ws_entries
            .lock()
            .get(pool_id)
            .and_then(|entry| entry.assigned_tunnel_id.clone())
    }

    pub fn remove_pool_ws(&self, pool_id: &str) -> Option<PoolWsEntry> {
        let entry = self.pool_ws_entries.lock().remove(pool_id)?;
        if entry.assigned_tunnel_id.is_none() {
            let mut idle = self.idle_pool_ws.lock();
            if let Some(ids) = idle.get_mut(&entry.machine_id) {
                ids.retain(|id| id != pool_id);
                if ids.is_empty() {
                    idle.remove(&entry.machine_id);
                }
            }
        }
        Some(entry)
    }

    pub fn remove_all_idle_pool_ws(&self, machine_id: &str) -> Vec<PoolWsEntry> {
        let ids = self
            .idle_pool_ws
            .lock()
            .remove(machine_id)
            .unwrap_or_default();
        let mut removed = Vec::new();
        let mut pool = self.pool_ws_entries.lock();
        for pool_id in ids {
            if let Some(entry) = pool.remove(&pool_id) {
                removed.push(entry);
            }
        }
        removed
    }

    pub fn schedule_terminal_idle(self: &Arc<Self>, terminal_id: &str) {
        let Some(idle_generation) = self.bump_terminal_idle_generation(terminal_id) else {
            return;
        };
        let timeout_ms = terminal_idle_timeout_ms();
        if timeout_ms == 0 {
            return;
        }
        let state = self.clone();
        let terminal_id = terminal_id.to_string();
        tokio::spawn(async move {
            sleep(Duration::from_millis(timeout_ms)).await;
            let should_close = {
                let terminals = state.terminals.lock();
                matches!(terminals.get(&terminal_id), Some(entry) if entry.idle_generation == idle_generation)
            };
            if !should_close {
                return;
            }
            if let Some(entry) = state.remove_terminal(&terminal_id) {
                for web_socket in entry.web_clients.values() {
                    let _ = web_socket.emit(
                        "terminal:error",
                        &serde_json::json!({
                            "terminalId": entry.terminal_id,
                            "message": "Terminal closed due to inactivity."
                        }),
                    );
                }
                let _ = entry.cli_socket.emit(
                    "terminal:close",
                    &serde_json::json!({
                        "sessionId": entry.session_id,
                        "terminalId": entry.terminal_id,
                    }),
                );
            }
        });
    }

    pub fn schedule_tunnel_idle(self: &Arc<Self>, tunnel_id: &str) {
        let Some(idle_generation) = self.bump_tunnel_idle_generation(tunnel_id) else {
            return;
        };
        let timeout_ms = tunnel_idle_timeout_ms();
        if timeout_ms == 0 {
            return;
        }
        let state = self.clone();
        let tunnel_id = tunnel_id.to_string();
        tokio::spawn(async move {
            sleep(Duration::from_millis(timeout_ms)).await;
            let should_close = {
                let tunnels = state.tunnels.lock();
                matches!(tunnels.get(&tunnel_id), Some(entry) if entry.idle_generation == idle_generation)
            };
            if !should_close {
                return;
            }
            state.close_tunnel_ws(&tunnel_id);
            if let Some(entry) = state.remove_tunnel(&tunnel_id) {
                let _ = entry.connect_socket.emit(
                    "tunnel:close",
                    &serde_json::json!({ "tunnelId": entry.tunnel_id }),
                );
                let _ = entry.runner_socket.emit(
                    "tunnel:close",
                    &serde_json::json!({ "tunnelId": entry.tunnel_id }),
                );
            }
        });
    }

    fn bump_terminal_idle_generation(&self, terminal_id: &str) -> Option<u64> {
        let mut terminals = self.terminals.lock();
        let entry = terminals.get_mut(terminal_id)?;
        entry.idle_generation = entry.idle_generation.wrapping_add(1);
        Some(entry.idle_generation)
    }

    fn bump_tunnel_idle_generation(&self, tunnel_id: &str) -> Option<u64> {
        let mut tunnels = self.tunnels.lock();
        let entry = tunnels.get_mut(tunnel_id)?;
        entry.idle_generation = entry.idle_generation.wrapping_add(1);
        Some(entry.idle_generation)
    }

    pub fn remove_tunnels_by_connect_socket(&self, socket_id: Sid) -> Vec<TunnelEntry> {
        let ids: Vec<_> = self
            .tunnels
            .lock()
            .iter()
            .filter_map(|(tunnel_id, entry)| {
                (entry.connect_socket_id == socket_id).then(|| tunnel_id.clone())
            })
            .collect();
        let mut removed = Vec::new();
        for tunnel_id in ids {
            if let Some(entry) = self.remove_tunnel(&tunnel_id) {
                removed.push(entry);
            }
        }
        removed
    }

    pub fn remove_tunnels_by_runner_socket(&self, socket_id: Sid) -> Vec<TunnelEntry> {
        let ids: Vec<_> = self
            .tunnels
            .lock()
            .iter()
            .filter_map(|(tunnel_id, entry)| {
                (entry.runner_socket_id == socket_id).then(|| tunnel_id.clone())
            })
            .collect();
        let mut removed = Vec::new();
        for tunnel_id in ids {
            if let Some(entry) = self.remove_tunnel(&tunnel_id) {
                removed.push(entry);
            }
        }
        removed
    }

    pub fn unregister_socket(&self, socket_id: Sid) -> SocketScopes {
        self.cli_sockets.lock().remove(&socket_id);
        let scopes = self
            .socket_scopes
            .lock()
            .remove(&socket_id)
            .unwrap_or_default();
        {
            let mut session_map = self.session_cli_sockets.lock();
            for session_id in &scopes.session_ids {
                if let Some(sockets) = session_map.get_mut(session_id) {
                    sockets.remove(&socket_id);
                    if sockets.is_empty() {
                        session_map.remove(session_id);
                    }
                }
            }
        }
        {
            let mut machine_map = self.machine_cli_sockets.lock();
            for machine_id in &scopes.machine_ids {
                if let Some(sockets) = machine_map.get_mut(machine_id) {
                    sockets.remove(&socket_id);
                    if sockets.is_empty() {
                        machine_map.remove(machine_id);
                    }
                }
            }
        }
        {
            let mut rpc = self.rpc_methods.lock();
            for method in &scopes.rpc_methods {
                if rpc.get(method) == Some(&socket_id) {
                    rpc.remove(method);
                }
            }
        }
        scopes
    }
}

fn terminal_idle_timeout_ms() -> u64 {
    std::env::var("HAPI_TERMINAL_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_MS)
}

fn tunnel_idle_timeout_ms() -> u64 {
    std::env::var("HAPI_TUNNEL_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_MS)
}
