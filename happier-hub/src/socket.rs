use crate::{
    auth::{authenticate_cli_token, has_permission, verify_auth_token},
    routes::{
        publish_message_event, publish_session_updated, socket_update_new_message,
        versioned_update_response,
    },
    state::AppState,
    types::SyncEvent,
};
use serde::Deserialize;
use serde_json::{json, Value};
use socketioxide::{
    extract::{AckSender, Data, SocketRef, State},
    handler::ConnectHandler,
    socket::DisconnectReason,
    SocketIo,
};
use std::sync::Arc;
use tokio::time::{sleep, Duration as TokioDuration};
use tracing::{debug, info, warn};

const DEFAULT_MAX_TERMINALS: usize = 4;

#[derive(Debug, Clone, Deserialize)]
struct ConnectAuth {
    token: String,
    #[serde(rename = "clientType")]
    client_type: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "machineId")]
    machine_id: Option<String>,
    #[serde(default)]
    capabilities: Option<ConnectCapabilities>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ConnectCapabilities {
    #[serde(rename = "wsTunnel")]
    ws_tunnel: Option<bool>,
    #[serde(rename = "builtinSsh")]
    builtin_ssh: Option<bool>,
}

#[derive(Debug, Clone)]
struct SocketAuth {
    namespace: String,
}

#[derive(Debug, Clone)]
struct CliSocketContext {
    namespace: String,
    permissions: Vec<String>,
    client_type: Option<String>,
    session_id: Option<String>,
    machine_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MessagePayload {
    sid: String,
    message: Value,
    #[serde(default)]
    #[serde(rename = "localId")]
    local_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionAlivePayload {
    sid: String,
    time: i64,
    #[serde(default)]
    thinking: bool,
    mode: Option<String>,
    #[serde(rename = "permissionMode")]
    permission_mode: Option<String>,
    #[serde(rename = "modelMode")]
    model_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionEndPayload {
    sid: String,
    time: i64,
}

#[derive(Debug, Deserialize)]
struct MachineAlivePayload {
    #[serde(rename = "machineId")]
    machine_id: String,
    time: i64,
}

#[derive(Debug, Deserialize)]
struct VersionedPayload {
    #[serde(default)]
    sid: Option<String>,
    #[serde(rename = "machineId", default)]
    machine_id: Option<String>,
    #[serde(rename = "expectedVersion")]
    expected_version: i64,
    metadata: Option<Value>,
    #[serde(rename = "agentState")]
    agent_state: Option<Value>,
    #[serde(rename = "runnerState")]
    runner_state: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct TerminalCreatePayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
struct TerminalWritePayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
struct TerminalResizePayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
struct TerminalClosePayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalReadyPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalOutputPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    data: String,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalExitPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    code: Option<i32>,
    signal: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalErrorPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct TunnelRequestPayload {
    #[serde(rename = "tunnelId")]
    tunnel_id: String,
    #[serde(rename = "machineId")]
    machine_id: String,
    port: u16,
    host: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TunnelReadyPayload {
    #[serde(rename = "tunnelId")]
    tunnel_id: String,
}

#[derive(Debug, Deserialize)]
struct TunnelDataPayload {
    #[serde(rename = "tunnelId")]
    tunnel_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
struct TunnelClosePayload {
    #[serde(rename = "tunnelId")]
    tunnel_id: String,
}

#[derive(Debug, Deserialize)]
struct TunnelErrorPayload {
    #[serde(rename = "tunnelId")]
    tunnel_id: String,
    message: String,
}

pub fn configure(io: &SocketIo, _state: Arc<AppState>) {
    let cli_middleware = move |socket: SocketRef,
                               State(state): State<Arc<AppState>>,
                               Data(auth): Data<ConnectAuth>| {
        let state = state.clone();
        async move {
            let Some(api) = authenticate_cli_token(&state, &auth.token) else {
                warn!(socket_id = %socket.id, "reject /cli socket: invalid token");
                return Err("Invalid token".to_string());
            };
            socket.extensions.insert(SocketAuth {
                namespace: api.namespace.clone(),
            });
            socket.extensions.insert(CliSocketContext {
                namespace: api.namespace.clone(),
                permissions: api.permissions.clone(),
                client_type: auth.client_type.clone(),
                session_id: auth.session_id.clone(),
                machine_id: auth.machine_id.clone(),
            });
            register_cli_handlers(
                socket.clone(),
                state.clone(),
                api.namespace.clone(),
                api.permissions.clone(),
            );
            state.register_cli_socket(socket.clone());
            state.set_socket_ws_tunnel(
                socket.id,
                auth.capabilities
                    .as_ref()
                    .and_then(|caps| caps.ws_tunnel)
                    .unwrap_or(false),
            );
            state.set_socket_builtin_ssh(
                socket.id,
                auth.capabilities
                    .as_ref()
                    .and_then(|caps| caps.builtin_ssh)
                    .unwrap_or(false),
            );
            socket.on_disconnect({
                let state = state.clone();
                let machine_id = auth.machine_id.clone();
                async move |socket: SocketRef, _reason: DisconnectReason| {
                    let removed_terminals: Vec<_> = state
                        .terminals
                        .lock()
                        .iter()
                        .filter_map(|(terminal_id, entry)| {
                            (entry.cli_socket_id == socket.id).then(|| terminal_id.clone())
                        })
                        .collect();
                    for terminal_id in removed_terminals {
                        if let Some(entry) = state.remove_terminal(&terminal_id) {
                            for web_socket in entry.web_clients.values() {
                                let _ = web_socket.emit(
                                    "terminal:error",
                                    &json!({
                                        "terminalId": entry.terminal_id,
                                        "message": "CLI disconnected."
                                    }),
                                );
                            }
                        }
                    }
                    for entry in state.remove_tunnels_by_connect_socket(socket.id) {
                        state.close_tunnel_ws(&entry.tunnel_id);
                        let _ = entry
                            .runner_socket
                            .emit("tunnel:close", &json!({ "tunnelId": entry.tunnel_id }));
                    }
                    for entry in state.remove_tunnels_by_runner_socket(socket.id) {
                        state.close_tunnel_ws(&entry.tunnel_id);
                        let _ = entry.connect_socket.emit(
                            "tunnel:error",
                            &json!({
                                "tunnelId": entry.tunnel_id,
                                "message": "Runner disconnected"
                            }),
                        );
                    }
                    if let Some(machine_id) = machine_id.as_deref() {
                        for pool in state.remove_all_idle_pool_ws(machine_id) {
                            let _ = pool.sender.send(axum::extract::ws::Message::Close(None));
                        }
                    }
                    info!(socket_id = %socket.id, "cli socket disconnected");
                    let scopes = state.unregister_socket(socket.id);
                    // If this was the last socket for a machine, mark it inactive
                    for machine_id in &scopes.machine_ids {
                        if state.get_machine_socket(machine_id).is_none() {
                            let _ = state.store.deactivate_machine(machine_id);
                            state.events.publish(SyncEvent::MachineUpdated {
                                machine_id: machine_id.clone(),
                                namespace: None,
                                data: None,
                            });
                        }
                    }
                }
            });
            Ok::<(), String>(())
        }
    };

    io.ns("/cli", (move |socket: SocketRef, State(state): State<Arc<AppState>>| {
        let state = state.clone();
        async move {
            let Some(ctx) = socket.extensions.get::<CliSocketContext>() else {
                warn!(socket_id = %socket.id, "reject /cli socket: missing context");
                let _ = socket.disconnect();
                return;
            };

            if let Some(session_id) = ctx.session_id.as_deref() {
                if has_permission(&ctx.permissions, "sessions:write") {
                    state.register_session_socket(session_id, socket.clone());
                }
            }

            if let Some(machine_id) = ctx.machine_id.as_deref() {
                if has_permission(&ctx.permissions, "machines:write")
                    && state.store.get_machine_by_namespace(machine_id, &ctx.namespace).is_some()
                {
                    if ctx.client_type.as_deref() != Some("tunnel") {
                        if let Some(existing) = state.get_machine_socket(machine_id) {
                            if existing.id != socket.id {
                                let _ = existing.emit("replaced", &json!({ "reason": "Another runner connected for this machine" }));
                                let _ = existing.disconnect();
                            }
                        }
                        state.register_machine_socket(machine_id, socket.clone());
                        let _ = socket.emit("hub:hello", &json!({ "capabilities": { "wsPool": true } }));
                    }
                }
            }

            info!(
                namespace = %ctx.namespace,
                socket_id = %socket.id,
                client_type = ?ctx.client_type,
                session_id = ?ctx.session_id,
                machine_id = ?ctx.machine_id,
                "cli socket connected"
            );
        }
    }).with(cli_middleware));

    io.ns(
        "/terminal",
        move |socket: SocketRef,
              State(state): State<Arc<AppState>>,
              Data(auth): Data<ConnectAuth>| async move {
            let Some(ctx) = verify_auth_token(&state, &auth.token) else {
                let _ = socket.emit(
                    "terminal:error",
                    &json!({ "terminalId": "", "message": "Invalid token" }),
                );
                let _ = socket.disconnect();
                return;
            };
            if !has_permission(&ctx.permissions, "sessions:write") {
                let _ = socket.emit(
                    "terminal:error",
                    &json!({ "terminalId": "", "message": "Insufficient permissions" }),
                );
                let _ = socket.disconnect();
                return;
            }
            socket.extensions.insert(SocketAuth {
                namespace: ctx.namespace.clone(),
            });
            register_terminal_handlers(socket.clone(), state.clone(), ctx.namespace.clone());
            socket.on_disconnect({
                let state = state.clone();
                async move |socket: SocketRef| {
                    let affected = state.detach_terminal_web_socket(socket.id);
                    for terminal_id in affected {
                        state.schedule_terminal_idle(&terminal_id);
                    }
                }
            });
        },
    );
}

fn register_cli_handlers(
    socket: SocketRef,
    state: Arc<AppState>,
    namespace: String,
    permissions: Vec<String>,
) {
    socket.on("message", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<MessagePayload>| {
            let Some(session) = state
                .store
                .get_session_by_namespace(&payload.sid, &namespace)
            else {
                emit_socket_error(
                    &socket,
                    "Session not found",
                    Some("session"),
                    Some(&payload.sid),
                );
                return;
            };
            match state.store.append_message(
                &session.id,
                &payload.message,
                payload.local_id.as_deref(),
            ) {
                Ok(message) => {
                    publish_message_event(&state, &namespace, &session.id, &message);
                    let update = socket_update_new_message(&session.id, &message);
                    emit_to_session_cli_peers(&state, &session.id, socket.id, "update", &update);
                }
                Err(error) => {
                    emit_socket_error(&socket, &error.to_string(), None, None);
                }
            }
        }
    });

    socket.on("session-alive", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<SessionAlivePayload>| {
            let _ = payload.time;
            if state
                .store
                .get_session_by_namespace(&payload.sid, &namespace)
                .is_none()
            {
                emit_socket_error(
                    &socket,
                    "Session not found",
                    Some("session"),
                    Some(&payload.sid),
                );
                return;
            }
            state.register_session_socket(&payload.sid, socket.clone());

            // Check what changed before updating DB
            let prev = state.store.get_session(&payload.sid);
            let was_active = prev.as_ref().map(|s| s.active).unwrap_or(false);
            let was_thinking = prev.as_ref().map(|s| s.thinking).unwrap_or(false);
            let prev_permission = prev.as_ref().and_then(|s| s.permission_mode.clone());
            let prev_model = prev.as_ref().and_then(|s| s.model_mode.clone());

            if state
                .store
                .touch_session_alive(
                    &payload.sid,
                    payload.thinking,
                    payload.mode.as_deref(),
                    payload.permission_mode.as_deref(),
                    payload.model_mode.as_deref(),
                )
                .is_ok()
            {
                // Throttle broadcasts: only broadcast if state changed or >10s since last
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                let last_broadcast = state
                    .session_last_broadcast_at
                    .lock()
                    .get(&payload.sid)
                    .copied()
                    .unwrap_or(0);
                let state_changed = !was_active
                    || was_thinking != payload.thinking
                    || prev_permission.as_deref() != payload.permission_mode.as_deref()
                    || prev_model.as_deref() != payload.model_mode.as_deref();
                let should_broadcast = state_changed || (now_ms - last_broadcast > 10_000);

                if should_broadcast {
                    state
                        .session_last_broadcast_at
                        .lock()
                        .insert(payload.sid.clone(), now_ms);
                    if let Some(session) = state.store.get_session(&payload.sid) {
                        publish_session_updated(&state, &namespace, &session);
                    }
                }
            }
        }
    });

    socket.on("session-end", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<SessionEndPayload>| {
            let _ = payload.time;
            if state
                .store
                .get_session_by_namespace(&payload.sid, &namespace)
                .is_none()
            {
                emit_socket_error(
                    &socket,
                    "Session not found",
                    Some("session"),
                    Some(&payload.sid),
                );
                return;
            }
            if state.store.end_session(&payload.sid).is_ok() {
                if let Some(session) = state.store.get_session(&payload.sid) {
                    publish_session_updated(&state, &namespace, &session);
                }
            }
        }
    });

    socket.on("machine-alive", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<MachineAlivePayload>| {
            let _ = payload.time;
            if state
                .store
                .get_machine_by_namespace(&payload.machine_id, &namespace)
                .is_none()
            {
                emit_socket_error(
                    &socket,
                    "Machine not found",
                    Some("machine"),
                    Some(&payload.machine_id),
                );
                return;
            }
            if state.store.touch_machine_alive(&payload.machine_id).is_ok() {
                state.events.publish(SyncEvent::MachineUpdated {
                    machine_id: payload.machine_id,
                    namespace: Some(namespace.clone()),
                    data: None,
                });
            }
        }
    });

    socket.on("update-metadata", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<VersionedPayload>, ack: AckSender| {
            let Some(session_id) = payload.sid.as_deref() else {
                let _ = ack.send(&json!({ "result": "error" }));
                return;
            };
            if state
                .store
                .get_session_by_namespace(session_id, &namespace)
                .is_none()
            {
                let _ = ack.send(&json!({ "result": "error", "reason": "not-found" }));
                return;
            }
            let metadata = payload.metadata.unwrap_or(Value::Null);
            let answer = state
                .store
                .update_session_metadata(
                    session_id,
                    &namespace,
                    payload.expected_version,
                    &metadata,
                )
                .map(|update| versioned_update_response(update, "metadata"))
                .unwrap_or_else(|_| json!({ "result": "error" }));
            let _ = ack.send(&answer);
            if answer.get("result").and_then(Value::as_str) == Some("success") {
                if let Some(session) = state.store.get_session(session_id) {
                    publish_session_updated(&state, &namespace, &session);
                    let update = json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "seq": current_ms(),
                        "createdAt": current_ms(),
                        "body": {
                            "t": "update-session",
                            "sid": session_id,
                            "metadata": { "version": answer["version"], "value": metadata },
                            "agentState": null
                        }
                    });
                    emit_to_session_cli_peers(&state, session_id, socket.id, "update", &update);
                }
            }
        }
    });

    socket.on("update-state", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<VersionedPayload>, ack: AckSender| {
            let Some(session_id) = payload.sid.as_deref() else {
                let _ = ack.send(&json!({ "result": "error" }));
                return;
            };
            if state
                .store
                .get_session_by_namespace(session_id, &namespace)
                .is_none()
            {
                let _ = ack.send(&json!({ "result": "error", "reason": "not-found" }));
                return;
            }
            let agent_state = payload.agent_state.unwrap_or(Value::Null);
            let answer = state
                .store
                .update_session_agent_state(
                    session_id,
                    &namespace,
                    payload.expected_version,
                    &agent_state,
                )
                .map(|update| versioned_update_response(update, "agentState"))
                .unwrap_or_else(|_| json!({ "result": "error" }));
            let _ = ack.send(&answer);
            if answer.get("result").and_then(Value::as_str) == Some("success") {
                if let Some(session) = state.store.get_session(session_id) {
                    publish_session_updated(&state, &namespace, &session);
                    let update = json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "seq": current_ms(),
                        "createdAt": current_ms(),
                        "body": {
                            "t": "update-session",
                            "sid": session_id,
                            "metadata": null,
                            "agentState": { "version": answer["version"], "value": agent_state }
                        }
                    });
                    emit_to_session_cli_peers(&state, session_id, socket.id, "update", &update);
                }
            }
        }
    });

    socket.on("machine-update-metadata", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |_socket: SocketRef, Data(payload): Data<VersionedPayload>, ack: AckSender| {
            let Some(machine_id) = payload.machine_id.as_deref() else {
                let _ = ack.send(&json!({ "result": "error" }));
                return;
            };
            let metadata = payload.metadata.unwrap_or(Value::Null);
            let answer = state
                .store
                .update_machine_metadata(
                    machine_id,
                    &namespace,
                    payload.expected_version,
                    &metadata,
                )
                .map(|update| versioned_update_response(update, "metadata"))
                .unwrap_or_else(|_| json!({ "result": "error" }));
            let _ = ack.send(&answer);
            if answer.get("result").and_then(Value::as_str) == Some("success") {
                state.events.publish(SyncEvent::MachineUpdated {
                    machine_id: machine_id.to_string(),
                    namespace: Some(namespace.clone()),
                    data: None,
                });
            }
        }
    });

    socket.on("machine-update-state", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |_socket: SocketRef, Data(payload): Data<VersionedPayload>, ack: AckSender| {
            let Some(machine_id) = payload.machine_id.as_deref() else {
                let _ = ack.send(&json!({ "result": "error" }));
                return;
            };
            let runner_state = payload.runner_state.unwrap_or(Value::Null);
            let answer = state
                .store
                .update_machine_state(
                    machine_id,
                    &namespace,
                    payload.expected_version,
                    &runner_state,
                )
                .map(|update| versioned_update_response(update, "runnerState"))
                .unwrap_or_else(|_| json!({ "result": "error" }));
            let _ = ack.send(&answer);
            if answer.get("result").and_then(Value::as_str) == Some("success") {
                state.events.publish(SyncEvent::MachineUpdated {
                    machine_id: machine_id.to_string(),
                    namespace: Some(namespace.clone()),
                    data: None,
                });
            }
        }
    });

    socket.on("rpc-register", {
        let state = state.clone();
        let permissions = permissions.clone();
        async move |socket: SocketRef, Data::<Value>(payload): Data<Value>| {
            if let Some(method) = payload.get("method").and_then(Value::as_str) {
                if !can_register_rpc_method(&state, socket.id, &permissions, method) {
                    return;
                }
                state.rpc_register(socket.id, method.to_string());
            }
        }
    });

    socket.on("rpc-unregister", {
        let state = state.clone();
        async move |socket: SocketRef, Data::<Value>(payload): Data<Value>| {
            if let Some(method) = payload.get("method").and_then(Value::as_str) {
                state.rpc_unregister(socket.id, method);
            }
        }
    });

    socket.on("terminal:ready", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalReadyPayload>| {
            state.schedule_terminal_idle(&payload.terminal_id);
            forward_terminal_event(
                &state,
                socket.id,
                &payload.terminal_id,
                Some(&payload.session_id),
                "terminal:ready",
                json!({
                    "terminalId": payload.terminal_id,
                }),
            );
        }
    });

    socket.on("terminal:output", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalOutputPayload>| {
            state.append_terminal_output(&payload.terminal_id, &payload.data);
            state.schedule_terminal_idle(&payload.terminal_id);
            forward_terminal_event(
                &state,
                socket.id,
                &payload.terminal_id,
                Some(&payload.session_id),
                "terminal:output",
                json!({
                    "terminalId": payload.terminal_id,
                    "data": payload.data,
                }),
            );
        }
    });

    socket.on("terminal:error", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalErrorPayload>| {
            forward_terminal_event(
                &state,
                socket.id,
                &payload.terminal_id,
                Some(&payload.session_id),
                "terminal:error",
                json!({
                    "terminalId": payload.terminal_id,
                    "message": payload.message,
                }),
            );
        }
    });

    socket.on("terminal:exit", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalExitPayload>| {
            let Some(entry) = state.terminal_entry(&payload.terminal_id) else {
                return;
            };
            if entry.cli_socket_id != socket.id || entry.session_id != payload.session_id {
                return;
            }
            if let Some(entry) = state.remove_terminal(&payload.terminal_id) {
                for web_socket in entry.web_clients.values() {
                    let _ = web_socket.emit(
                        "terminal:exit",
                        &json!({
                            "terminalId": payload.terminal_id,
                            "code": payload.code,
                            "signal": payload.signal,
                        }),
                    );
                }
            }
        }
    });

    socket.on("tunnel:request", {
        let state = state.clone();
        let namespace = namespace.clone();
        let permissions = permissions.clone();
        async move |socket: SocketRef, Data(payload): Data<TunnelRequestPayload>| {
            if !has_permission(&permissions, "machines:connect") {
                let _ = socket.emit("tunnel:error", &json!({
                    "tunnelId": payload.tunnel_id,
                    "message": "Insufficient permissions: machines:connect required"
                }));
                return;
            }
            if state.store.get_machine_by_namespace(&payload.machine_id, &namespace).is_none() {
                let _ = socket.emit("tunnel:error", &json!({
                    "tunnelId": payload.tunnel_id,
                    "message": "Machine not found"
                }));
                return;
            }
            let Some(runner_socket) = pick_runner_socket(&state, &payload.machine_id, socket.id) else {
                debug!(tunnel_id=%payload.tunnel_id, machine_id=%payload.machine_id, requester=%socket.id, "tunnel request: runner not connected");
                let _ = socket.emit("tunnel:error", &json!({
                    "tunnelId": payload.tunnel_id,
                    "message": "Runner not connected"
                }));
                return;
            };

            let resolved_port = match resolve_tunnel_port(
                &permissions,
                payload.port,
                state.socket_supports_builtin_ssh(runner_socket.id),
            ) {
                Ok(port) => port,
                Err(message) => {
                    let _ = socket.emit("tunnel:error", &json!({
                        "tunnelId": payload.tunnel_id,
                        "message": message,
                    }));
                    return;
                }
            };

            debug!(tunnel_id=%payload.tunnel_id, machine_id=%payload.machine_id, requester=%socket.id, runner=%runner_socket.id, port=resolved_port, host=?payload.host, "tunnel request: forwarding to runner");
            if !state.register_tunnel(&payload.tunnel_id, &namespace, &payload.machine_id, resolved_port, socket.clone(), runner_socket.clone()) {
                let _ = socket.emit("tunnel:error", &json!({
                    "tunnelId": payload.tunnel_id,
                    "message": "Tunnel ID already in use"
                }));
                return;
            }

            state.schedule_tunnel_idle(&payload.tunnel_id);
            let emit_result = runner_socket.emit("tunnel:open", &json!({
                "tunnelId": payload.tunnel_id,
                "port": resolved_port,
                "host": payload.host,
            }));
            debug!(tunnel_id=%payload.tunnel_id, runner=%runner_socket.id, ok=%emit_result.is_ok(), "tunnel request: tunnel:open emitted");
        }
    });

    socket.on("tunnel:ready", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TunnelReadyPayload>| {
            let Some(entry) = state.tunnel_entry(&payload.tunnel_id) else {
                return;
            };
            if entry.runner_socket_id != socket.id {
                return;
            }
            debug!(tunnel_id=%payload.tunnel_id, runner=%socket.id, connect=%entry.connect_socket_id, machine_id=%entry.machine_id, "tunnel ready from runner");
            state.schedule_tunnel_idle(&payload.tunnel_id);
            let _ = entry.connect_socket.emit("tunnel:ready", &json!({ "tunnelId": payload.tunnel_id }));
            let state = state.clone();
            let tunnel_id = payload.tunnel_id.clone();
            let machine_id = entry.machine_id.clone();
            tokio::spawn(async move {
                for _ in 0..60 {
                    if let Some(pool) = state.try_acquire_pool_ws(&machine_id) {
                        state.assign_pool_ws(&pool.pool_id, &tunnel_id);
                        let _ = pool.sender.send(axum::extract::ws::Message::Text(json!({ "assign": tunnel_id }).to_string().into()));
                        break;
                    }
                    sleep(TokioDuration::from_millis(50)).await;
                }
            });
        }
    });

    socket.on("tunnel:data", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TunnelDataPayload>| {
            let Some(entry) = state.tunnel_entry(&payload.tunnel_id) else {
                return;
            };
            state.schedule_tunnel_idle(&payload.tunnel_id);
            if socket.id == entry.connect_socket_id {
                if let Some(sender) = state.tunnel_ws_sender(&payload.tunnel_id, "runner") {
                    let bytes = base64_decode(&payload.data);
                    let _ = sender.send(axum::extract::ws::Message::Binary(bytes.into()));
                } else {
                    let _ = entry.runner_socket.emit(
                        "tunnel:data",
                        &json!({
                            "tunnelId": payload.tunnel_id,
                            "data": payload.data,
                        }),
                    );
                }
            } else if socket.id == entry.runner_socket_id {
                if let Some(sender) = state.tunnel_ws_sender(&payload.tunnel_id, "connect") {
                    let bytes = base64_decode(&payload.data);
                    let _ = sender.send(axum::extract::ws::Message::Binary(bytes.into()));
                } else {
                    let _ = entry.connect_socket.emit(
                        "tunnel:data",
                        &json!({
                            "tunnelId": payload.tunnel_id,
                            "data": payload.data,
                        }),
                    );
                }
            }
        }
    });

    socket.on("tunnel:close", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TunnelClosePayload>| {
            let Some(entry) = state.tunnel_entry(&payload.tunnel_id) else {
                return;
            };
            let target = if socket.id == entry.connect_socket_id {
                Some(entry.runner_socket.clone())
            } else if socket.id == entry.runner_socket_id {
                Some(entry.connect_socket.clone())
            } else {
                None
            };
            if target.is_none() {
                return;
            }
            let _ = state.remove_tunnel(&payload.tunnel_id);
            state.close_tunnel_ws(&payload.tunnel_id);
            if let Some(target) = target {
                let _ = target.emit("tunnel:close", &json!({ "tunnelId": payload.tunnel_id }));
            }
        }
    });

    socket.on("tunnel:error", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TunnelErrorPayload>| {
            let Some(entry) = state.tunnel_entry(&payload.tunnel_id) else {
                return;
            };
            if socket.id != entry.runner_socket_id {
                return;
            }
            debug!(tunnel_id=%payload.tunnel_id, runner=%socket.id, message=%payload.message, "tunnel error from runner");
            let _ = state.remove_tunnel(&payload.tunnel_id);
            state.close_tunnel_ws(&payload.tunnel_id);
            let _ = entry.connect_socket.emit("tunnel:error", &json!({
                "tunnelId": payload.tunnel_id,
                "message": payload.message,
            }));
        }
    });

    socket.on("ping", async |_socket: SocketRef, ack: AckSender| {
        let _ = ack.send(&json!([]));
    });
}

fn register_terminal_handlers(socket: SocketRef, state: Arc<AppState>, namespace: String) {
    socket.on("terminal:create", {
        let state = state.clone();
        let namespace = namespace.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalCreatePayload>| {
            let Some(session) = state.store.get_session_by_namespace(&payload.session_id, &namespace) else {
                let _ = socket.emit("terminal:error", &json!({ "terminalId": payload.terminal_id, "message": "Session is inactive or unavailable." }));
                return;
            };
            if !session.active {
                let _ = socket.emit("terminal:error", &json!({ "terminalId": payload.terminal_id, "message": "Session is inactive or unavailable." }));
                return;
            }
            let Some(cli_socket) = state.get_session_socket(&payload.session_id) else {
                let _ = socket.emit("terminal:error", &json!({ "terminalId": payload.terminal_id, "message": "CLI is not connected for this session." }));
                return;
            };
            let max_terminals = max_terminals_limit();
            if let Some(entry) = state.terminal_entry(&payload.terminal_id) {
                if entry.session_id != payload.session_id {
                    let _ = socket.emit("terminal:error", &json!({ "terminalId": payload.terminal_id, "message": "Terminal ID is already in use." }));
                    return;
                }
                state.register_terminal(&payload.terminal_id, &payload.session_id, entry.cli_socket.clone(), socket.clone());
                state.schedule_terminal_idle(&payload.terminal_id);
                if !entry.output_buffer.is_empty() {
                    let _ = socket.emit("terminal:snapshot", &json!({ "terminalId": payload.terminal_id, "data": entry.output_buffer }));
                }
                let _ = socket.emit("terminal:ready", &json!({ "terminalId": payload.terminal_id }));
                return;
            }
            if state.terminal_count_for_socket(socket.id) >= max_terminals {
                let _ = socket.emit("terminal:error", &json!({
                    "terminalId": payload.terminal_id,
                    "message": format!("Too many terminals open (max {max_terminals}).")
                }));
                return;
            }
            if state.terminal_count_for_session(&payload.session_id) >= max_terminals {
                let _ = socket.emit("terminal:error", &json!({
                    "terminalId": payload.terminal_id,
                    "message": format!("Too many terminals open for this session (max {max_terminals}).")
                }));
                return;
            }
            state.register_terminal(&payload.terminal_id, &payload.session_id, cli_socket.clone(), socket.clone());
            state.schedule_terminal_idle(&payload.terminal_id);
            let _ = cli_socket.emit("terminal:open", &json!({
                "sessionId": payload.session_id,
                "terminalId": payload.terminal_id,
                "cols": payload.cols,
                "rows": payload.rows,
            }));
        }
    });

    socket.on("terminal:write", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalWritePayload>| {
            let Some(entry) = state.terminal_entry(&payload.terminal_id) else {
                return;
            };
            if !entry.web_clients.contains_key(&socket.id) {
                return;
            }
            state.schedule_terminal_idle(&payload.terminal_id);
            let _ = entry.cli_socket.emit(
                "terminal:write",
                &json!({
                    "sessionId": entry.session_id,
                    "terminalId": payload.terminal_id,
                    "data": payload.data,
                }),
            );
        }
    });

    socket.on("terminal:resize", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalResizePayload>| {
            let Some(entry) = state.terminal_entry(&payload.terminal_id) else {
                return;
            };
            if !entry.web_clients.contains_key(&socket.id) {
                return;
            }
            state.schedule_terminal_idle(&payload.terminal_id);
            let _ = entry.cli_socket.emit(
                "terminal:resize",
                &json!({
                    "sessionId": entry.session_id,
                    "terminalId": payload.terminal_id,
                    "cols": payload.cols,
                    "rows": payload.rows,
                }),
            );
        }
    });

    socket.on("terminal:close", {
        let state = state.clone();
        async move |socket: SocketRef, Data(payload): Data<TerminalClosePayload>| {
            let Some(entry) = state.terminal_entry(&payload.terminal_id) else {
                return;
            };
            if !entry.web_clients.contains_key(&socket.id) {
                return;
            }
            let _ = entry.cli_socket.emit(
                "terminal:close",
                &json!({
                    "sessionId": entry.session_id,
                    "terminalId": payload.terminal_id,
                }),
            );
            let _ = state.remove_terminal(&payload.terminal_id);
        }
    });
}

fn forward_terminal_event(
    state: &AppState,
    sender_id: socketioxide::socket::Sid,
    terminal_id: &str,
    session_id: Option<&str>,
    event: &str,
    payload: Value,
) {
    if let Some(entry) = state.terminal_entry(terminal_id) {
        if entry.cli_socket_id != sender_id {
            return;
        }
        if let Some(session_id) = session_id {
            if entry.session_id != session_id {
                return;
            }
        }
        for web_socket in entry.web_clients.values() {
            let _ = web_socket.emit(event, &payload);
        }
    }
}

fn can_register_rpc_method(
    state: &AppState,
    socket_id: socketioxide::socket::Sid,
    permissions: &[String],
    method: &str,
) -> bool {
    if has_permission(permissions, "admin") {
        return true;
    }
    let Some((scope_id, _)) = method.split_once(':') else {
        return false;
    };
    let scopes = state.socket_scopes.lock();
    let Some(scopes) = scopes.get(&socket_id) else {
        return false;
    };
    if scopes.machine_ids.contains(scope_id) {
        return has_permission(permissions, "machines:write");
    }
    if scopes.session_ids.contains(scope_id) {
        return has_permission(permissions, "sessions:write");
    }
    false
}

fn pick_runner_socket(
    state: &AppState,
    machine_id: &str,
    requester_id: socketioxide::socket::Sid,
) -> Option<SocketRef> {
    state
        .machine_cli_sockets
        .lock()
        .get(machine_id)
        .and_then(|sockets| {
            sockets
                .iter()
                .find_map(|(sid, socket)| (*sid != requester_id).then(|| socket.clone()))
        })
}

fn resolve_tunnel_port(
    permissions: &[String],
    port: u16,
    builtin_ssh: bool,
) -> Result<u16, &'static str> {
    if port == 0 {
        return Ok(
            if has_permission(permissions, "machines:shell") && builtin_ssh {
                0
            } else {
                22
            },
        );
    }
    if port < 10 && !has_permission(permissions, "machines:shell") {
        return Err("Insufficient permissions: machines:shell required");
    }
    Ok(port)
}

fn max_terminals_limit() -> usize {
    std::env::var("HAPI_TERMINAL_MAX_TERMINALS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_TERMINALS)
}

fn base64_decode(data: &str) -> Vec<u8> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut output = Vec::with_capacity(trimmed.len() * 3 / 4);
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0usize;

    for byte in trimmed.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ if byte.is_ascii_whitespace() => continue,
            _ => return Vec::new(),
        };
        chunk[chunk_len] = value;
        chunk_len += 1;

        if chunk_len == 4 {
            if chunk[0] == 64 || chunk[1] == 64 {
                return Vec::new();
            }
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                output.push((chunk[1] << 4) | (chunk[2] >> 2));
                if chunk[3] != 64 {
                    output.push((chunk[2] << 6) | chunk[3]);
                }
            }
            chunk_len = 0;
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::resolve_tunnel_port;

    #[test]
    fn tunnel_port_zero_uses_builtin_ssh_when_supported() {
        let permissions = vec!["machines:connect".to_string(), "machines:shell".to_string()];
        assert_eq!(resolve_tunnel_port(&permissions, 0, true).unwrap(), 0);
    }

    #[test]
    fn tunnel_port_zero_falls_back_to_22_without_builtin_ssh() {
        let permissions = vec!["machines:connect".to_string(), "machines:shell".to_string()];
        assert_eq!(resolve_tunnel_port(&permissions, 0, false).unwrap(), 22);
    }

    #[test]
    fn reserved_ports_require_shell_permission_except_zero_fallback() {
        let permissions = vec!["machines:connect".to_string()];
        assert_eq!(resolve_tunnel_port(&permissions, 0, false).unwrap(), 22);
        assert!(resolve_tunnel_port(&permissions, 1, false).is_err());
    }
}

fn emit_to_session_cli_peers<T: serde::Serialize>(
    state: &AppState,
    session_id: &str,
    sender_id: socketioxide::socket::Sid,
    event: &str,
    payload: &T,
) {
    if let Some(sockets) = state.session_cli_sockets.lock().get(session_id).cloned() {
        for (sid, socket) in sockets {
            if sid != sender_id {
                let _ = socket.emit(event, payload);
            }
        }
    }
}

fn emit_socket_error(socket: &SocketRef, message: &str, scope: Option<&str>, id: Option<&str>) {
    let _ = socket.emit(
        "error",
        &json!({
            "message": message,
            "scope": scope,
            "id": id,
        }),
    );
}

fn current_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
