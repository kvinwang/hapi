use crate::{
    auth::{authenticate_cli_token, create_jwt, has_permission, verify_auth_token, AuthContext},
    owner::get_or_create_owner_id,
    sse::VisibilityUpdate,
    state::{AppState, LobstearToolResult, QrSession, QrStatus, VisibilityRecord},
    store::VersionedUpdate,
    telegram::{validate_telegram_init_data, TelegramInitDataValidation},
    types::{ConnectionChangedData, DecryptedMessage, PROTOCOL_VERSION, Session, SocketUpdate, SyncEvent},
};
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{sse::{Event, KeepAlive, Sse}, Html, IntoResponse, Redirect, Response},
    routing::{any, delete, get, patch, post},
    Json, Router,
};
use cookie::{time::Duration as CookieDuration, Cookie};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{convert::Infallible, fs, path::{Path as FsPath, PathBuf}, sync::Arc, time::Duration};
use futures_util::sink::SinkExt;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::{wrappers::{BroadcastStream, UnboundedReceiverStream}, StreamExt};
use uuid::Uuid;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/", get(root))
        .route("/install", get(install))
        .route("/install.ps1", get(install_ps1))
        .route("/assets/{*path}", get(static_asset))
        .route("/api/auth", post(api_auth))
        .route("/api/events", get(api_events))
        .route("/api/visibility", post(api_visibility))
        .route("/api/sessions", get(api_sessions))
        .route("/api/sessions/shared", get(api_shared_sessions))
        .route("/api/sessions/{id}", get(api_session).patch(api_rename_session).delete(api_delete_session))
        .route("/api/sessions/{id}/messages", get(api_messages).post(api_send_message))
        .route("/api/sessions/{id}/debug-state", get(api_debug_session_state))
        .route("/api/sessions/{id}/resume", post(api_resume_session))
        .route("/api/sessions/{id}/fork", post(api_fork_session))
        .route("/api/sessions/{id}/convert", post(api_convert_session))
        .route("/api/sessions/{id}/ui-state", get(api_get_session_ui_state).post(api_set_session_ui_state))
        .route("/api/sessions/{id}/upload", post(api_upload_file))
        .route("/api/sessions/{id}/upload/delete", post(api_delete_upload_file))
        .route("/api/sessions/{id}/abort", post(api_abort_session))
        .route("/api/sessions/{id}/archive", post(api_archive_session))
        .route("/api/sessions/{id}/switch", post(api_switch_session))
        .route("/api/sessions/{id}/permission-mode", post(api_set_permission_mode))
        .route("/api/sessions/{id}/model", post(api_set_model_mode))
        .route("/api/sessions/{id}/permissions/{request_id}/approve", post(api_approve_permission))
        .route("/api/sessions/{id}/permissions/{request_id}/deny", post(api_deny_permission))
        .route("/api/sessions/{id}/slash-commands", get(api_slash_commands))
        .route("/api/sessions/{id}/skills", get(api_skills))
        .route("/api/sessions/{id}/git-status", get(api_git_status))
        .route("/api/sessions/{id}/git-diff-numstat", get(api_git_diff_numstat))
        .route("/api/sessions/{id}/git-diff-file", get(api_git_diff_file))
        .route("/api/sessions/{id}/file", get(api_read_file))
        .route("/api/sessions/{id}/files", get(api_list_files))
        .route("/api/sessions/{id}/directory", get(api_list_directory))
        .route("/api/sessions/{id}/usage", get(api_session_usage))
        .route("/api/sessions/{id}/share", get(api_get_share_status).post(api_share_session).delete(api_unshare_session))
        .route("/api/machines", get(api_machines))
        .route("/api/machines/{id}", delete(api_delete_machine))
        .route("/api/machines/{id}/notes", patch(api_update_machine_notes))
        .route("/api/machines/{id}/unbind", post(api_unbind_machine))
        .route("/api/machines/{id}/spawn", post(api_spawn_session))
        .route("/api/machines/{id}/paths/exists", post(api_paths_exist))
        .route("/api/machines/{id}/apply-credentials", post(api_apply_credentials))
        .route("/api/machines/{id}/read-credentials", get(api_read_credentials))
        .route("/api/share/{token}", get(api_shared_session))
        .route("/api/share/{token}/messages", get(api_shared_messages))
        .route("/api/files/{session_id}/{file_id}", get(api_file_blob))
        .route("/api/qr", post(api_qr_create))
        .route("/api/qr/{id}", get(api_qr_status))
        .route("/api/qr/{id}/confirm", post(api_qr_confirm))
        .route("/api/qr/{id}/deny", post(api_qr_deny))
        .route("/api/bind", post(api_bind))
        .route("/api/push/vapid-public-key", get(api_push_vapid_public_key))
        .route("/api/push/subscribe", post(api_push_subscribe).delete(api_push_unsubscribe))
        .route("/api/voice/token", post(api_voice_token))
        .route("/api/sync/messages", get(api_sync_messages))
        .route("/api/sync/sessions", get(api_sync_sessions))
        .route("/api/lobstear/down", get(api_lobstear_down))
        .route("/api/lobstear/up", post(api_lobstear_up))
        .route("/api/lobstear/tool", post(api_lobstear_tool))
        .route("/api/lobstear/devices", get(api_lobstear_devices).post(api_create_lobstear_device))
        .route("/api/lobstear/devices/{id}", axum::routing::put(api_update_lobstear_device).patch(api_update_lobstear_device).delete(api_delete_lobstear_device))
        .route("/api/credentials", get(api_credentials).post(api_create_credential))
        .route("/api/credentials/{id}", axum::routing::put(api_update_credential).delete(api_delete_credential))
        .route("/api/api-keys", get(api_list_api_keys).post(api_create_api_key))
        .route("/api/api-keys/{id}", axum::routing::put(api_update_api_key).delete(api_revoke_api_key))
        .route("/api/api-keys/{id}/restore", post(api_restore_api_key))
        .route("/api/api-keys/{id}/tokens", get(api_list_access_tokens).post(api_create_access_token))
        .route("/api/api-keys/{id}/tokens/{token_id}", axum::routing::put(api_update_access_token).delete(api_revoke_access_token))
        .route("/api/api-keys/{id}/tokens/{token_id}/restore", post(api_restore_access_token))
        .route("/api/api-keys/{id}/tokens/{token_id}/extend", post(api_extend_access_token))
        .route("/api/invites", post(api_create_invite))
        .route("/cli/sessions", post(cli_sessions))
        .route("/cli/sessions/{id}", get(cli_session))
        .route("/cli/sessions/{id}/messages", get(cli_session_messages))
        .route("/cli/sessions/{id}/history", get(cli_session_history))
        .route("/cli/sessions/{id}/send", post(cli_send_message))
        .route("/cli/machines", get(cli_list_machines).post(cli_machines))
        .route("/cli/machines/{id}", get(cli_machine))
        .route("/cli/machines/{id}/notes", patch(cli_update_machine_notes))
        .route("/cli/machines/{id}/import-ssh-key", post(cli_import_ssh_key))
        .route("/cli/files", post(cli_upload_file))
        .route("/tunnel/ws/{id}", get(tunnel_ws))
        .route("/tunnel/pool", get(tunnel_pool_ws))
        .route("/tunnel/protocol/{id}", get(tunnel_protocol))
        .route("/api/share", any(not_implemented))
        .route("/api/preferences/{*path}", any(not_implemented))
        .route("/api/sessions/{id}/{*path}", any(not_implemented))
        .route("/api/machines/{id}/{*path}", any(not_implemented))
        .route("/api/preferences", get(api_get_preferences).post(api_update_preferences))
        .route("/{*path}", get(spa_fallback))
        .fallback(not_found)
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "protocolVersion": PROTOCOL_VERSION }))
}

async fn root() -> impl IntoResponse {
    match serve_index_html() {
        Some(response) => response,
        None => (StatusCode::SERVICE_UNAVAILABLE, "Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n").into_response(),
    }
}

async fn static_asset(Path(path): Path<String>) -> impl IntoResponse {
    serve_web_path(&format!("assets/{path}")).unwrap_or_else(not_found_response)
}

async fn tunnel_protocol(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(entry) = state.tunnel_entry(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Tunnel not found" }))).into_response();
    };
    let Some(_) = state.store.get_machine_by_namespace(&entry.machine_id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Tunnel not found" }))).into_response();
    };
    Json(json!({
        "connect": if state.socket_supports_ws_tunnel(entry.connect_socket_id) { "websocket" } else { "socketio" },
        "runner": if state.socket_supports_ws_tunnel(entry.runner_socket_id) { "websocket" } else { "socketio" },
    })).into_response()
}

#[derive(Debug, Deserialize)]
struct TunnelWsQuery {
    token: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct TunnelPoolQuery {
    token: String,
    #[serde(rename = "machineId")]
    machine_id: String,
}

async fn tunnel_ws(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TunnelWsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if query.role != "connect" && query.role != "runner" {
        return (StatusCode::BAD_REQUEST, "Bad request").into_response();
    }
    let Some(api) = authenticate_cli_token(&state, &query.token) else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    let Some(entry) = state.tunnel_entry(&id) else {
        return (StatusCode::NOT_FOUND, "Tunnel not found").into_response();
    };
    if api.namespace != entry.namespace {
        return (StatusCode::NOT_FOUND, "Tunnel not found").into_response();
    }
    ws.on_upgrade(move |socket| handle_tunnel_ws(state, id, query.role, socket)).into_response()
}

async fn tunnel_pool_ws(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TunnelPoolQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let Some(api) = authenticate_cli_token(&state, &query.token) else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    if !has_permission(&api.permissions, "machines:write") {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    if state.store.get_machine_by_namespace(&query.machine_id, &api.namespace).is_none() {
        return (StatusCode::NOT_FOUND, "Machine not found").into_response();
    }
    ws.on_upgrade(move |socket| handle_pool_ws(state, query.machine_id, socket)).into_response()
}

async fn spa_fallback(Path(path): Path<String>) -> impl IntoResponse {
    if path.starts_with("api/") || path == "api" || path.starts_with("cli/") || path == "cli" || path.starts_with("socket.io/") || path == "socket.io" {
        return not_found_response();
    }
    if let Some(response) = serve_web_path(&path) {
        return response;
    }
    serve_index_html().unwrap_or_else(not_found_response)
}

async fn install(headers: HeaderMap) -> impl IntoResponse {
    let hub_url = request_origin(&headers).unwrap_or_else(|| "http://127.0.0.1:3006".to_string());
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("install.sh");
    match fs::read_to_string(path) {
        Ok(script) => ([ (header::CONTENT_TYPE, HeaderValue::from_static("text/x-shellscript")) ], script.replace("__HAPI_HUB_URL__", &hub_url)).into_response(),
        Err(_) => Redirect::temporary("https://raw.githubusercontent.com/kvinwang/hapi/main/install.sh").into_response(),
    }
}

async fn install_ps1(headers: HeaderMap) -> impl IntoResponse {
    let hub_url = request_origin(&headers).unwrap_or_else(|| "http://127.0.0.1:3006".to_string());
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("install.ps1");
    match fs::read_to_string(path) {
        Ok(script) => ([ (header::CONTENT_TYPE, HeaderValue::from_static("text/plain")) ], script.replace("__HAPI_HUB_URL__", &hub_url)).into_response(),
        Err(_) => Redirect::temporary("https://raw.githubusercontent.com/kvinwang/hapi/main/install.ps1").into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AuthBody {
    AccessToken { #[serde(rename = "accessToken")] access_token: String },
    Telegram { #[serde(rename = "initData")] init_data: String },
}

async fn api_auth(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AuthBody>,
) -> Response {
    match body {
        AuthBody::AccessToken { access_token } => {
            let Some(api) = authenticate_cli_token(&state, &access_token) else {
                return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid access token" }))).into_response();
            };
            let user_id = match get_or_create_owner_id(&state.config.data_dir) {
                Ok(user_id) => user_id,
                Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
            };
            match create_jwt(&state, &api, user_id) {
                Ok(token) => {
                    let cookie = build_auth_cookie(&state, &token);
                    let mut response = Json(json!({
                        "token": token,
                        "user": { "id": user_id, "firstName": "Web User" }
                    })).into_response();
                    response.headers_mut().append(
                        header::SET_COOKIE,
                        HeaderValue::from_str(&cookie.to_string()).unwrap(),
                    );
                    response
                }
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
            }
        }
        AuthBody::Telegram { init_data } => {
            let Some(bot_token) = state.config.telegram_bot_token.as_deref() else {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN." }))).into_response();
            };
            let result = validate_telegram_init_data(&init_data, bot_token, 60 * 60 * 24);
            let TelegramInitDataValidation::Ok { user, .. } = result else {
                let TelegramInitDataValidation::Err(error) = result else { unreachable!() };
                return (StatusCode::UNAUTHORIZED, Json(json!({ "error": error }))).into_response();
            };
            let Some(stored_user) = state.store.get_user("telegram", &user.id.to_string()) else {
                return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "not_bound" }))).into_response();
            };
            let user_id = match get_or_create_owner_id(&state.config.data_dir) {
                Ok(user_id) => user_id,
                Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
            };
            let api_key_id = state
                .store
                .list_api_keys(Some(&stored_user.namespace))
                .into_iter()
                .find(|key| key.revoked_at.is_none())
                .map(|key| key.id)
                .unwrap_or_else(|| "__telegram__".to_string());
            let api = crate::auth::ApiAuth {
                api_key_id,
                access_token_id: None,
                namespace: stored_user.namespace,
                permissions: vec!["admin".to_string()],
            };
            match create_jwt(&state, &api, user_id) {
                Ok(token) => {
                    let cookie = build_auth_cookie(&state, &token);
                    let mut response = Json(json!({
                        "token": token,
                        "user": {
                            "id": user_id,
                            "username": user.username,
                            "firstName": user.first_name,
                            "lastName": user.last_name,
                        }
                    })).into_response();
                    response.headers_mut().append(
                        header::SET_COOKIE,
                        HeaderValue::from_str(&cookie.to_string()).unwrap(),
                    );
                    response
                }
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
            }
        }
    }
}

async fn api_bind(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BindBody>,
) -> Response {
    let Some(api) = authenticate_cli_token(&state, &body.access_token) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid access token" }))).into_response();
    };
    let Some(bot_token) = state.config.telegram_bot_token.as_deref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN." }))).into_response();
    };
    let result = validate_telegram_init_data(&body.init_data, bot_token, 60 * 60 * 24);
    let TelegramInitDataValidation::Ok { user, .. } = result else {
        let TelegramInitDataValidation::Err(error) = result else { unreachable!() };
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": error }))).into_response();
    };

    let telegram_user_id = user.id.to_string();
    if let Some(existing_user) = state.store.get_user("telegram", &telegram_user_id) {
        if existing_user.namespace != api.namespace {
            return (StatusCode::CONFLICT, Json(json!({ "error": "already_bound" }))).into_response();
        }
    }
    if let Err(error) = state.store.add_user("telegram", &telegram_user_id, &api.namespace) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
    }

    let user_id = match get_or_create_owner_id(&state.config.data_dir) {
        Ok(user_id) => user_id,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    };
    match create_jwt(&state, &api, user_id) {
        Ok(token) => Json(json!({
            "token": token,
            "user": {
                "id": user_id,
                "username": user.username,
                "firstName": user.first_name,
                "lastName": user.last_name,
            }
        })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

fn build_auth_cookie(state: &AppState, token: &str) -> Cookie<'static> {
    let mut builder = Cookie::build(("hapi_token", token.to_string()))
        .http_only(true)
        .path("/")
        .max_age(CookieDuration::minutes(5));
    if state.config.public_url.starts_with("https://") {
        builder = builder.secure(true);
    }
    builder.build()
}

async fn api_qr_create(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    cleanup_qr_sessions(&state);
    let id = Uuid::new_v4().to_string();
    let secret = random_base64url(24);
    state.qr_sessions.lock().insert(
        id.clone(),
        QrSession {
            id: id.clone(),
            secret: secret.clone(),
            status: QrStatus::Pending,
            created_at: now_ms(),
            access_token: None,
        },
    );
    Json(json!({ "id": id, "secret": secret }))
}

async fn api_qr_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<QrQuery>,
) -> impl IntoResponse {
    cleanup_qr_sessions(&state);
    let Some(secret) = query.s else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Invalid secret" }))).into_response();
    };
    let Some(session) = state.qr_sessions.lock().get(&id).cloned() else {
        return Json(json!({ "status": "expired" })).into_response();
    };
    if session.secret != secret {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Invalid secret" }))).into_response();
    }
    match session.status {
        QrStatus::Confirmed => {
            state.qr_sessions.lock().remove(&id);
            let mut response = Json(json!({ "status": "confirmed", "accessToken": session.access_token })).into_response();
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        QrStatus::Pending => {
            let mut response = Json(json!({ "status": "pending" })).into_response();
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
    }
}

async fn api_qr_confirm(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<QrQuery>,
    Json(body): Json<QrConfirmBody>,
) -> impl IntoResponse {
    cleanup_qr_sessions(&state);
    let Some(secret) = query.s else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Invalid secret" }))).into_response();
    };
    let mut sessions = state.qr_sessions.lock();
    let Some(session) = sessions.get_mut(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found or expired" }))).into_response();
    };
    if session.secret != secret {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Invalid secret" }))).into_response();
    }
    if session.status != QrStatus::Pending {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Session already confirmed" }))).into_response();
    }
    let expires_at = match body.expires_in.as_deref().unwrap_or("never") {
        "never" => 0,
        "1d" => now_ms() + 24 * 60 * 60 * 1000,
        "7d" => now_ms() + 7 * 24 * 60 * 60 * 1000,
        "90d" => now_ms() + 90 * 24 * 60 * 60 * 1000,
        "365d" => now_ms() + 365 * 24 * 60 * 60 * 1000,
        _ => 0,
    };
    let Some(api_key_id) = qr_parent_api_key_id(&state, &auth) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "No API key available for QR login" }))).into_response();
    };
    let raw_token = generate_api_key_raw();
    if let Err(error) = state.store.create_access_token(
        &Uuid::new_v4().to_string(),
        &api_key_id,
        &format!("QR Login ({})", iso_minute_stamp()),
        &crate::auth::hash_api_key(&raw_token),
        &extract_key_prefix(&raw_token),
        &auth.namespace,
        &auth.permissions,
        expires_at,
    ) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
    }
    session.status = QrStatus::Confirmed;
    session.access_token = Some(if auth.namespace == "default" { raw_token } else { format!("{raw_token}:{}", auth.namespace) });
    Json(json!({ "ok": true })).into_response()
}

async fn api_qr_deny(
    State(state): State<Arc<AppState>>,
    _auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<QrQuery>,
) -> impl IntoResponse {
    cleanup_qr_sessions(&state);
    let Some(secret) = query.s else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Invalid secret" }))).into_response();
    };
    let mut sessions = state.qr_sessions.lock();
    match sessions.get(&id) {
        Some(session) if session.secret != secret => {
            (StatusCode::FORBIDDEN, Json(json!({ "error": "Invalid secret" }))).into_response()
        }
        _ => {
            sessions.remove(&id);
            Json(json!({ "ok": true })).into_response()
        }
    }
}

async fn api_push_vapid_public_key(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    Json(json!({ "publicKey": state.config.vapid_public_key })).into_response()
}

async fn api_push_subscribe(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<PushSubscriptionBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if body.endpoint.trim().is_empty() || body.keys.p256dh.trim().is_empty() || body.keys.auth.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
    }
    match state.store.add_push_subscription(&auth.namespace, &body.endpoint, &body.keys.p256dh, &body.keys.auth) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_push_unsubscribe(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<PushUnsubscribeBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if body.endpoint.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
    }
    match state.store.remove_push_subscription(&auth.namespace, &body.endpoint) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_voice_token(
    auth: AuthContext,
    Json(body): Json<VoiceTokenBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let api_key = body.custom_api_key.or_else(|| std::env::var("ELEVENLABS_API_KEY").ok());
    let mut agent_id = body.custom_agent_id.or_else(|| std::env::var("ELEVENLABS_AGENT_ID").ok());
    let Some(api_key) = api_key else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "allowed": false, "error": "ElevenLabs API key not configured" }))).into_response();
    };
    if agent_id.is_none() {
        agent_id = get_or_create_voice_agent_id(&api_key).await;
    }
    let Some(agent_id) = agent_id else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "allowed": false, "error": "Failed to create ElevenLabs agent automatically" }))).into_response();
    };
    let client = reqwest::Client::new();
    let url = format!("https://api.elevenlabs.io/v1/convai/conversation/token?agent_id={}", percent_encode_simple(&agent_id));
    match client
        .get(url)
        .header("xi-api-key", api_key)
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<Value>().await {
                Ok(value) => {
                    if let Some(token) = value.get("token").and_then(Value::as_str) {
                        Json(json!({ "allowed": true, "token": token, "agentId": agent_id })).into_response()
                    } else {
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "allowed": false, "error": "No token in ElevenLabs response" }))).into_response()
                    }
                }
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "allowed": false, "error": error.to_string() }))).into_response(),
            }
        }
        Ok(response) => {
            let fallback = format!("ElevenLabs API error: {}", response.status());
            let detail = response.json::<Value>().await.ok()
                .and_then(|value| value.get("detail").and_then(Value::as_object).and_then(|obj| obj.get("message")).and_then(Value::as_str).map(ToOwned::to_owned)
                    .or_else(|| value.get("error").and_then(Value::as_str).map(ToOwned::to_owned)));
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "allowed": false, "error": detail.unwrap_or(fallback) }))).into_response()
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "allowed": false, "error": error.to_string() }))).into_response(),
    }
}

async fn api_sync_messages(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Query(query): Query<SyncMessagesQuery>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let since = query.since.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(500).clamp(1, 1000);
    match state.store.get_messages_since(&auth.namespace, since, limit, query.cursor.as_deref()) {
        Ok(result) => Json(json!({
            "messages": result.messages,
            "cursor": result.cursor,
            "hasMore": result.has_more,
        })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_sync_sessions(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Query(query): Query<SyncSessionsQuery>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let updated_since = query.updated_since.unwrap_or(0).max(0);
    let sessions = state.store.list_sessions(Some(&auth.namespace));
    let sessions: Vec<_> = sessions
        .into_iter()
        .filter(|session| updated_since == 0 || session.updated_at >= updated_since)
        .map(|session| {
            let metadata = session.metadata.clone().unwrap_or(Value::Null);
            let ui_state = state.store.get_session_ui_state(&session.id, &auth.namespace).unwrap_or(Value::Null);
            json!({
                "id": session.id,
                "namespace": session.namespace,
                "metadata": if let Some(metadata) = metadata.as_object() {
                    json!({
                        "name": metadata.get("name"),
                        "path": metadata.get("path"),
                        "summary": metadata.get("summary"),
                        "flavor": metadata.get("flavor"),
                        "machineId": metadata.get("machineId"),
                        "worktree": metadata.get("worktree"),
                    })
                } else { Value::Null },
                "createdAt": session.created_at,
                "updatedAt": session.updated_at,
                "active": session.active,
                "tags": ui_state.get("tags").and_then(Value::as_array).cloned().unwrap_or_default(),
            })
        })
        .collect();
    Json(json!({ "sessions": sessions })).into_response()
}

async fn api_lobstear_devices(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let speakers: Vec<_> = state
        .store
        .list_lobstear_devices(Some(&auth.namespace))
        .into_iter()
        .map(|device| {
            let runtime = state.lobstear_devices.lock();
            let runtime = runtime.get(&device.id);
            json!({
                "id": device.id,
                "name": device.name,
                "sessionId": device.bridged_session_id,
                "relay": runtime.and_then(|entry| entry.down_tx.as_ref()).is_some(),
                "speaker": runtime.map(|entry| entry.speaker_connected).unwrap_or(false),
            })
        })
        .collect();
    Json(json!({ "speakers": speakers })).into_response()
}

async fn api_create_lobstear_device(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<LobstearCreateDeviceBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if body.id.trim().is_empty() || body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body: id and name required" }))).into_response();
    }
    if state.store.get_lobstear_device(&body.id).is_some() {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Device ID already exists" }))).into_response();
    }
    if let Some(session_id) = body.session_id.as_deref() {
        if state.store.get_session_by_namespace(session_id, &auth.namespace).is_none() {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
        }
    }
    match state.store.upsert_lobstear_device(&body.id, &body.name, &auth.namespace) {
        Ok(_) => {
            if let Some(session_id) = body.session_id.as_deref() {
                if let Err(error) = state.store.set_lobstear_bridged_session(&body.id, Some(session_id)) {
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
                }
            }
            let device = state.store.get_lobstear_device(&body.id).unwrap();
            (StatusCode::CREATED, Json(json!({
                "speaker": {
                    "id": device.id,
                    "name": device.name,
                    "sessionId": device.bridged_session_id,
                }
            }))).into_response()
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_update_lobstear_device(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(device) = state.store.get_lobstear_device(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Device not found" }))).into_response();
    };
    if device.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Device not found" }))).into_response();
    }
    if let Some(name) = body.get("name").and_then(Value::as_str) {
        if name.trim().is_empty() {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
        }
        if let Err(error) = state.store.upsert_lobstear_device(&id, name, &auth.namespace) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
        }
    }
    if let Some(session_value) = body.get("sessionId") {
        if session_value.is_null() {
            if let Err(error) = state.store.set_lobstear_bridged_session(&id, None) {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
            }
        } else if let Some(session_id) = session_value.as_str() {
            if state.store.get_session_by_namespace(session_id, &auth.namespace).is_none() {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
            }
            if let Err(error) = state.store.set_lobstear_bridged_session(&id, Some(session_id)) {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
            }
        } else {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
        }
    }
    let updated = state.store.get_lobstear_device(&id).unwrap();
    Json(json!({
        "speaker": {
            "id": updated.id,
            "name": updated.name,
            "sessionId": updated.bridged_session_id,
        }
    })).into_response()
}

async fn api_delete_lobstear_device(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(device) = state.store.get_lobstear_device(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Device not found" }))).into_response();
    };
    if device.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Device not found" }))).into_response();
    }
    if let Err(error) = state.store.remove_lobstear_device(&id) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
    }
    let mut runtimes = state.lobstear_devices.lock();
    if let Some(runtime) = runtimes.remove(&id) {
        for (_, pending) in runtime.pending_tool_calls {
            let _ = pending.send(LobstearToolResult { result: Value::Null, error: Some("device removed".to_string()) });
        }
    }
    Json(json!({ "ok": true })).into_response()
}

async fn api_lobstear_down(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Query(query): Query<LobstearDeviceQuery>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(device) = state.store.get_lobstear_device(&query.device_id) else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "device not registered" }))).into_response();
    };
    if device.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not found" }))).into_response();
    }

    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let stream_id = Uuid::new_v4().to_string();
    {
        let mut runtimes = state.lobstear_devices.lock();
        let runtime = runtimes.entry(query.device_id.clone()).or_insert_with(|| crate::state::LobstearRuntime {
            stream_id: None,
            down_tx: None,
            speaker_connected: false,
            interrupted: false,
            pending_tool_calls: std::collections::HashMap::new(),
        });
        runtime.stream_id = Some(stream_id.clone());
        runtime.down_tx = Some(tx.clone());
    }

    let device_id = query.device_id.clone();
    let state_for_events = state.clone();
    let tx_for_events = tx.clone();
    tokio::spawn(async move {
        let mut event_rx = state_for_events.events.subscribe();
        loop {
            let event = match event_rx.recv().await {
                Ok(event) => event,
                Err(_) => break,
            };
            let (bound_session_id, interrupted) = {
                let runtime = state_for_events.lobstear_devices.lock();
                let Some(runtime) = runtime.get(&device_id) else {
                    break;
                };
                let Some(stored_device) = state_for_events.store.get_lobstear_device(&device_id) else {
                    break;
                };
                (stored_device.bridged_session_id, runtime.interrupted)
            };
            let Some(bound_session_id) = bound_session_id else {
                continue;
            };
            if interrupted {
                continue;
            }
            let SyncEvent::MessageReceived { session_id, message, .. } = event else {
                continue;
            };
            if session_id != bound_session_id {
                continue;
            }
            let Some(text) = extract_lobstear_assistant_text(&message.content) else {
                continue;
            };
            if tx_for_events.send(json!({ "type": "outbound", "text": text })).is_err() {
                break;
            }
        }
        let mut runtimes = state_for_events.lobstear_devices.lock();
        if let Some(runtime) = runtimes.get_mut(&device_id) {
            if runtime.stream_id.as_deref() == Some(&stream_id) {
                runtime.stream_id = None;
                runtime.down_tx = None;
                runtime.speaker_connected = false;
            }
        }
    });

    let stream = UnboundedReceiverStream::new(rx).map(|message| Ok::<Event, Infallible>(Event::default().data(message.to_string())));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive")).into_response()
}

async fn api_lobstear_up(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Query(query): Query<LobstearDeviceQuery>,
    Json(body): Json<LobstearUpMessage>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(device) = state.store.get_lobstear_device(&query.device_id) else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "device not registered" }))).into_response();
    };
    if device.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not found" }))).into_response();
    }

    match body {
        LobstearUpMessage::Hello { version: _, speaker_connected } => {
            let tx = {
                let mut runtimes = state.lobstear_devices.lock();
                let Some(runtime) = runtimes.get_mut(&query.device_id) else {
                    return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected" }))).into_response();
                };
                runtime.speaker_connected = speaker_connected;
                runtime.down_tx.clone()
            };
            let Some(tx) = tx else {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected" }))).into_response();
            };
            let _ = tx.send(json!({ "type": "ack" }));
            Json(json!({ "ok": true })).into_response()
        }
        LobstearUpMessage::Status { speaker_connected } => {
            let mut runtimes = state.lobstear_devices.lock();
            let Some(runtime) = runtimes.get_mut(&query.device_id) else {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected" }))).into_response();
            };
            runtime.speaker_connected = speaker_connected;
            Json(json!({ "ok": true })).into_response()
        }
        LobstearUpMessage::Interrupt {} => {
            let mut runtimes = state.lobstear_devices.lock();
            let Some(runtime) = runtimes.get_mut(&query.device_id) else {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected" }))).into_response();
            };
            runtime.interrupted = true;
            Json(json!({ "ok": true })).into_response()
        }
        LobstearUpMessage::ToolResult { id, result, error } => {
            let pending = {
                let mut runtimes = state.lobstear_devices.lock();
                let Some(runtime) = runtimes.get_mut(&query.device_id) else {
                    return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected" }))).into_response();
                };
                runtime.pending_tool_calls.remove(&id)
            };
            if let Some(pending) = pending {
                let _ = pending.send(LobstearToolResult { result, error });
            }
            Json(json!({ "ok": true })).into_response()
        }
        LobstearUpMessage::Inbound { text, sender_id: _ } => {
            {
                let mut runtimes = state.lobstear_devices.lock();
                let Some(runtime) = runtimes.get_mut(&query.device_id) else {
                    return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected" }))).into_response();
                };
                runtime.interrupted = false;
            }
            let Some(session_id) = device.bridged_session_id.as_deref() else {
                let tx = state.lobstear_devices.lock().get(&query.device_id).and_then(|runtime| runtime.down_tx.clone());
                if let Some(tx) = tx {
                    let _ = tx.send(json!({ "type": "outbound", "text": "未绑定会话。" }));
                }
                return Json(json!({ "ok": true })).into_response();
            };
            let content = json!({
                "role": "user",
                "content": {
                    "type": "text",
                    "text": text,
                },
                "meta": {
                    "sentFrom": "lobstear"
                }
            });
            match state.store.append_message(session_id, &content, None) {
                Ok(message) => {
                    publish_message_event(&state, &auth.namespace, session_id, &message);
                    emit_session_update_to_all_cli_peers(&state, session_id, &socket_update_new_message(session_id, &message));
                    Json(json!({ "ok": true })).into_response()
                }
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
            }
        }
    }
}

async fn api_lobstear_tool(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<LobstearToolBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(command) = body.command.as_deref().filter(|value| !value.trim().is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "command required" }))).into_response();
    };
    let device_id = if let Some(device_id) = body.device_id.as_deref() {
        device_id.to_string()
    } else if let Some(session_id) = body.session_id.as_deref() {
        let devices: Vec<_> = state
            .store
            .get_lobstear_devices_by_session(session_id)
            .into_iter()
            .filter(|device| device.namespace == auth.namespace)
            .collect();
        if devices.is_empty() {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "no device bound to this session" }))).into_response();
        }
        if devices.len() > 1 {
            return (StatusCode::BAD_REQUEST, Json(json!({
                "error": format!("multiple devices bound to this session ({}), specify deviceId", devices.iter().map(|device| device.id.as_str()).collect::<Vec<_>>().join(", ")),
                "devices": devices.into_iter().map(|device| json!({ "id": device.id, "name": device.name })).collect::<Vec<_>>(),
            }))).into_response();
        }
        devices[0].id.clone()
    } else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "deviceId or sessionId required" }))).into_response();
    };

    let Some(device) = state.store.get_lobstear_device(&device_id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not found" }))).into_response();
    };
    if device.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not found" }))).into_response();
    }

    let tool_id = Uuid::new_v4().to_string();
    let (pending_tx, pending_rx) = oneshot::channel();
    let down_tx = {
        let mut runtimes = state.lobstear_devices.lock();
        let Some(runtime) = runtimes.get_mut(&device_id) else {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected (relay offline)" }))).into_response();
        };
        let Some(down_tx) = runtime.down_tx.clone() else {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected (relay offline)" }))).into_response();
        };
        runtime.pending_tool_calls.insert(tool_id.clone(), pending_tx);
        down_tx
    };

    if down_tx.send(json!({
        "type": "tool_call",
        "id": tool_id,
        "name": command,
        "params": body.params.unwrap_or_default(),
    })).is_err() {
        let mut runtimes = state.lobstear_devices.lock();
        if let Some(runtime) = runtimes.get_mut(&device_id) {
            runtime.pending_tool_calls.remove(&tool_id);
            runtime.down_tx = None;
        }
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "device not connected (relay offline)" }))).into_response();
    }

    match tokio::time::timeout(Duration::from_millis(body.timeout_ms.unwrap_or(30_000)), pending_rx).await {
        Ok(Ok(result)) => Json(json!({ "result": result.result, "error": result.error })).into_response(),
        Ok(Err(_)) => Json(json!({ "result": Value::Null, "error": "relay disconnected" })).into_response(),
        Err(_) => {
            let mut runtimes = state.lobstear_devices.lock();
            if let Some(runtime) = runtimes.get_mut(&device_id) {
                runtime.pending_tool_calls.remove(&tool_id);
            }
            Json(json!({ "result": Value::Null, "error": "tool call timeout" })).into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    #[serde(default)]
    all: Option<bool>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "machineId")]
    machine_id: Option<String>,
    visibility: Option<String>,
}

async fn api_events(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Query(query): Query<EventsQuery>,
) -> impl IntoResponse {
    let subscription_id = Uuid::new_v4().to_string();
    state.visibility.lock().insert(
        subscription_id.clone(),
        VisibilityRecord {
            namespace: auth.namespace.clone(),
            visibility: query.visibility.clone().unwrap_or_else(|| "hidden".to_string()),
        },
    );

    let connected = SyncEvent::ConnectionChanged {
        namespace: Some(auth.namespace.clone()),
        data: ConnectionChangedData {
            status: "connected".to_string(),
            subscription_id: Some(subscription_id.clone()),
        },
    };

    let receiver = state.events.subscribe();
    let stream = BroadcastStream::new(receiver)
        .filter_map(move |item| {
            let event = item.ok()?;
            if !query.all.unwrap_or(false) && !event_matches_namespace(&event, &auth.namespace) {
                return None;
            }
            if let Some(ref session_id) = query.session_id {
                if !event_matches_session(&event, session_id) {
                    return None;
                }
            }
            if let Some(ref machine_id) = query.machine_id {
                if !event_matches_machine(&event, machine_id) {
                    return None;
                }
            }
            Some(Ok::<Event, Infallible>(Event::default().data(serde_json::to_string(&event).ok()?)))
        });

    let prefix = tokio_stream::once(Ok::<Event, Infallible>(Event::default().data(serde_json::to_string(&connected).unwrap())));
    Sse::new(prefix.chain(stream)).keep_alive(KeepAlive::default().text("heartbeat"))
}

async fn api_visibility(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<VisibilityUpdate>,
) -> impl IntoResponse {
    let mut visibility = state.visibility.lock();
    let Some(record) = visibility.get_mut(&body.subscription_id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Subscription not found" })));
    };
    if record.namespace != auth.namespace {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Subscription access denied" })));
    }
    record.visibility = body.visibility;
    (StatusCode::OK, Json(json!({ "ok": true })))
}

async fn api_sessions(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let sessions = state.store.list_sessions(Some(&auth.namespace));
    let summaries: Vec<_> = sessions.into_iter().map(|session| session.to_summary()).collect();
    Json(json!({ "sessions": summaries })).into_response()
}

async fn api_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    Json(json!({ "session": session })).into_response()
}

async fn api_shared_sessions(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let sessions = state.store.list_shared_sessions(&auth.namespace);
    let sessions: Vec<_> = sessions
        .into_iter()
        .map(|session| {
            let metadata = session.metadata.clone().unwrap_or(Value::Null);
            json!({
                "id": session.id,
                "title": session_title(metadata.as_object()),
                "flavor": metadata.get("flavor").and_then(Value::as_str),
                "active": session.active,
                "createdAt": session.created_at,
                "updatedAt": session.updated_at,
            })
        })
        .collect();
    Json(json!({ "sessions": sessions })).into_response()
}

async fn api_get_session_ui_state(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    Json(json!({ "state": state.store.get_session_ui_state(&id, &auth.namespace).unwrap_or_else(|| json!({})) })).into_response()
}

async fn api_set_session_ui_state(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    let current = state.store.get_session_ui_state(&id, &auth.namespace).unwrap_or_else(|| json!({}));
    let merged = merge_json_objects(current, body);
    match state.store.update_session_ui_state(&id, &auth.namespace, &merged) {
        Ok(true) => Json(json!({ "ok": true, "state": merged })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct RenameSessionBody {
    name: String,
}

async fn api_rename_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<RenameSessionBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body: name is required" }))).into_response();
    }
    match state.store.rename_session(&id, &auth.namespace, body.name.trim()) {
        Ok(true) => {
            if let Some(session) = state.store.get_session(&id) {
                publish_session_updated(&state, &auth.namespace, &session);
            }
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct DeleteSessionQuery {
    mode: Option<String>,
}

async fn api_delete_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<DeleteSessionQuery>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    let delete_mode = query.mode.as_deref().unwrap_or("single");
    if !matches!(delete_mode, "single" | "detach-children" | "recursive") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid delete mode" }))).into_response();
    }
    if session.active {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Cannot delete active session. Archive it first." }))).into_response();
    }
    if session_has_share_token(&session) {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Cannot delete shared session. Unshare it first." }))).into_response();
    }
    match state.store.delete_session(&id, &auth.namespace) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_debug_session_state(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:debug-session-state"), json!({})).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => map_rpc_error_response(response, "Failed to fetch session debug state", Some("RPC handler not registered"), Some("success")),
    }
}

async fn api_resume_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found", "code": "session_not_found" }))).into_response();
    };
    if session.active {
        return Json(json!({ "type": "success", "sessionId": id })).into_response();
    }
    let Some(metadata) = session.metadata.as_ref().and_then(Value::as_object) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Session metadata missing path", "code": "resume_unavailable" }))).into_response();
    };
    let Some(path) = metadata.get("path").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Session metadata missing path", "code": "resume_unavailable" }))).into_response();
    };
    let flavor = session_flavor(metadata);
    let Some(resume_session_id) = resume_token(metadata, flavor) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Resume session ID unavailable", "code": "resume_unavailable" }))).into_response();
    };
    let Some(machine) = pick_online_machine(&state, &auth.namespace, metadata) else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "No machine online", "code": "no_machine_online" }))).into_response();
    };
    let yolo = metadata_is_yolo(metadata);
    let session_tag = state.store.get_session_tag(&id, &auth.namespace);
    match rpc_call(&state, &format!("{}:spawn-happy-session", machine.id), json!({
        "type": "spawn-in-directory",
        "directory": path,
        "agent": flavor,
        "yolo": yolo.then_some(true),
        "resumeSessionId": resume_session_id,
        "sessionTag": session_tag,
    })).await {
        Ok(value) => spawn_result_response(value, "resume_failed"),
        Err(response) => response,
    }
}

async fn api_fork_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<ForkSessionBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if body.message_seq <= 0 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "messageSeq is required and must be a number" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found", "code": "session_not_found" }))).into_response();
    };
    let Some(metadata_obj) = session.metadata.as_ref().and_then(Value::as_object) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Fork failed", "code": "fork_failed" }))).into_response();
    };
    let Some(path) = metadata_obj.get("path").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Source session has no workspace path", "code": "fork_failed" }))).into_response();
    };
    let Some(machine) = pick_online_machine(&state, &auth.namespace, metadata_obj) else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "No machine online", "code": "no_machine_online" }))).into_response();
    };
    let flavor = session_flavor(metadata_obj);
    let source_agent_session_id = source_agent_session_id(metadata_obj, flavor);
    if matches!(flavor, "claude" | "codex") && source_agent_session_id.is_none() {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Source session agent not ready yet, please try again later", "code": "fork_not_ready" }))).into_response();
    }
    let mut forked_metadata = Value::Object(metadata_obj.clone());
    normalize_fork_metadata(&mut forked_metadata, flavor, None);
    let tag = format!("fork-{}", Uuid::new_v4());
    let Ok(forked_session) = state.store.create_forked_session(&id, &auth.namespace, body.message_seq, &tag, &forked_metadata) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Fork failed", "code": "fork_failed" }))).into_response();
    };
    copy_session_files(&state, &id, &forked_session.id);
    match rpc_call(&state, &format!("{}:spawn-happy-session", machine.id), json!({
        "type": "spawn-in-directory",
        "directory": path,
        "agent": flavor,
        "yolo": metadata_is_yolo(metadata_obj).then_some(true),
        "forkSourceSessionId": source_agent_session_id,
        "sessionTag": tag,
        "parentSessionId": id,
    })).await {
        Ok(value) => spawn_result_response(value, "fork_failed"),
        Err(response) => response,
    }
}

async fn api_convert_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<ConvertSessionBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let target = body.target_agent.as_str();
    if !matches!(target, "claude" | "codex") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body", "code": "convert_failed" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found", "code": "session_not_found" }))).into_response();
    };
    let Some(metadata_obj) = session.metadata.as_ref().and_then(Value::as_object) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Source session has no workspace path", "code": "convert_failed" }))).into_response();
    };
    let source = session_flavor(metadata_obj);
    if source == target {
        return (StatusCode::CONFLICT, Json(json!({ "error": format!("Session already uses {target}"), "code": "already_target_flavor" }))).into_response();
    }
    let Some(path) = metadata_obj.get("path").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Source session has no workspace path", "code": "convert_failed" }))).into_response();
    };
    let Some(machine) = pick_online_machine(&state, &auth.namespace, metadata_obj) else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "No machine online", "code": "no_machine_online" }))).into_response();
    };
    match rpc_call(&state, &format!("{}:spawn-happy-session", machine.id), json!({
        "type": "spawn-in-directory",
        "directory": path,
        "agent": target,
        "yolo": metadata_is_yolo(metadata_obj).then_some(true),
    })).await {
        Ok(value) => spawn_result_response(value, "convert_failed"),
        Err(response) => response,
    }
}

#[derive(Debug, Deserialize)]
struct MessagesQuery {
    limit: Option<i64>,
    #[serde(rename = "beforeSeq")]
    before_seq: Option<i64>,
    #[serde(rename = "afterSeq")]
    after_seq: Option<i64>,
}

async fn api_messages(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    match state.store.get_messages_page(&id, limit, query.before_seq, query.after_seq) {
        Ok((messages, has_more)) => Json(json!({
            "messages": messages,
            "page": {
                "limit": limit,
                "beforeSeq": query.before_seq,
                "nextBeforeSeq": messages.first().and_then(|m| m.seq),
                "afterSeq": query.after_seq,
                "nextAfterSeq": messages.last().and_then(|m| m.seq),
                "hasMore": has_more
            }
        })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct SendMessageBody {
    text: String,
    #[serde(rename = "localId")]
    local_id: Option<String>,
    attachments: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
struct FilePathQuery {
    path: String,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileSearchQuery {
    query: Option<String>,
    limit: Option<usize>,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitQuery {
    cwd: Option<String>,
    staged: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UploadFileBody {
    filename: String,
    content: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

#[derive(Debug, Deserialize)]
struct DeleteUploadBody {
    path: String,
}

#[derive(Debug, Deserialize, Default)]
struct FileAccessQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ForkSessionBody {
    #[serde(rename = "messageSeq")]
    message_seq: i64,
}

#[derive(Debug, Deserialize)]
struct ConvertSessionBody {
    #[serde(rename = "targetAgent")]
    target_agent: String,
}

#[derive(Debug, Deserialize)]
struct UpdatePreferencesBody {
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateCredentialBody {
    name: String,
    #[serde(rename = "agentType")]
    agent_type: String,
    config: Value,
}

#[derive(Debug, Deserialize)]
struct UpdateCredentialBody {
    name: Option<String>,
    config: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ApplyCredentialBody {
    #[serde(rename = "credentialId")]
    credential_id: String,
    #[serde(rename = "agentType")]
    agent_type: String,
}

#[derive(Debug, Deserialize)]
struct CreateApiKeyBody {
    name: String,
    namespace: Option<String>,
    permissions: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UpdateApiKeyBody {
    name: Option<String>,
    permissions: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct CreateAccessTokenBody {
    name: String,
    #[serde(rename = "expiresIn")]
    expires_in: String,
}

#[derive(Debug, Deserialize)]
struct UpdateAccessTokenBody {
    name: Option<String>,
    #[serde(rename = "expiresIn")]
    expires_in: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExtendAccessTokenBody {
    #[serde(rename = "ttlMinutes")]
    ttl_minutes: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreateInviteBody {
    #[serde(rename = "ttlMinutes")]
    ttl_minutes: Option<i64>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QrConfirmBody {
    #[serde(rename = "expiresIn")]
    expires_in: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BindBody {
    #[serde(rename = "initData")]
    init_data: String,
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Debug, Deserialize, Default)]
struct QrQuery {
    s: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PushSubscriptionBody {
    endpoint: String,
    keys: PushKeys,
}

#[derive(Debug, Deserialize)]
struct PushKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
struct PushUnsubscribeBody {
    endpoint: String,
}

#[derive(Debug, Deserialize, Default)]
struct SyncMessagesQuery {
    since: Option<i64>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct SyncSessionsQuery {
    #[serde(rename = "updatedSince")]
    updated_since: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
struct VoiceTokenBody {
    #[serde(rename = "customAgentId")]
    custom_agent_id: Option<String>,
    #[serde(rename = "customApiKey")]
    custom_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LobstearDeviceQuery {
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Debug, Deserialize)]
struct LobstearCreateDeviceBody {
    id: String,
    name: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LobstearToolBody {
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    command: Option<String>,
    params: Option<serde_json::Map<String, Value>>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum LobstearUpMessage {
    #[serde(rename = "inbound")]
    Inbound {
        text: String,
        #[serde(rename = "senderId")]
        sender_id: String,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        id: String,
        result: Value,
        error: Option<String>,
    },
    #[serde(rename = "hello")]
    Hello {
        version: String,
        #[serde(rename = "speakerConnected")]
        speaker_connected: bool,
    },
    #[serde(rename = "status")]
    Status {
        #[serde(rename = "speakerConnected")]
        speaker_connected: bool,
    },
    #[serde(rename = "interrupt")]
    Interrupt {},
}

async fn api_send_message(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<SendMessageBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }

    let mut inner = serde_json::Map::new();
    inner.insert("type".to_string(), Value::String("text".to_string()));
    inner.insert("text".to_string(), Value::String(body.text.clone()));
    if let Some(attachments) = body.attachments.clone() {
        inner.insert("attachments".to_string(), Value::Array(attachments));
    }
    let content = json!({
        "role": "user",
        "content": Value::Object(inner),
        "meta": {
            "sentFrom": "webapp"
        }
    });
    match state.store.append_message(&id, &content, body.local_id.as_deref()) {
        Ok(message) => {
            publish_message_event(&state, &auth.namespace, &id, &message);
            emit_session_update_to_all_cli_peers(&state, &id, &socket_update_new_message(&id, &message));
            Json(json!({ "ok": true, "seq": message.seq })).into_response()
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_git_status(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<GitQuery>,
) -> impl IntoResponse {
    let Some(session) = require_session_read(&state, &auth, &id) else {
        return missing_or_forbidden_session(&state, &auth, &id).into_response();
    };
    let Some(session_path) = session_path(&session) else {
        return Json(json!({ "success": false, "error": "Session path not available" })).into_response();
    };
    let cwd = resolve_cwd(query.cwd.as_deref(), session_path);
    match rpc_call(&state, &format!("{id}:git-status"), json!({ "cwd": cwd })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_git_diff_numstat(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<GitQuery>,
) -> impl IntoResponse {
    let Some(session) = require_session_read(&state, &auth, &id) else {
        return missing_or_forbidden_session(&state, &auth, &id).into_response();
    };
    let Some(session_path) = session_path(&session) else {
        return Json(json!({ "success": false, "error": "Session path not available" })).into_response();
    };
    let cwd = resolve_cwd(query.cwd.as_deref(), session_path);
    match rpc_call(&state, &format!("{id}:git-diff-numstat"), json!({
        "cwd": cwd,
        "staged": parse_bool_param(query.staged.as_deref()),
    })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_git_diff_file(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<FilePathQueryWithGit>,
) -> impl IntoResponse {
    let Some(session) = require_session_read(&state, &auth, &id) else {
        return missing_or_forbidden_session(&state, &auth, &id).into_response();
    };
    let Some(session_path) = session_path(&session) else {
        return Json(json!({ "success": false, "error": "Session path not available" })).into_response();
    };
    if query.path.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid file path" }))).into_response();
    }
    let cwd = resolve_cwd(query.cwd.as_deref(), session_path);
    match rpc_call(&state, &format!("{id}:git-diff-file"), json!({
        "cwd": cwd,
        "filePath": query.path,
        "staged": parse_bool_param(query.staged.as_deref()),
    })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[derive(Debug, Deserialize)]
struct FilePathQueryWithGit {
    path: String,
    cwd: Option<String>,
    staged: Option<String>,
}

async fn api_read_file(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<FilePathQuery>,
) -> impl IntoResponse {
    let Some(session) = require_session_read(&state, &auth, &id) else {
        return missing_or_forbidden_session(&state, &auth, &id).into_response();
    };
    let Some(session_path) = session_path(&session) else {
        return Json(json!({ "success": false, "error": "Session path not available" })).into_response();
    };
    if query.path.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid file path" }))).into_response();
    }
    let cwd = resolve_cwd(query.cwd.as_deref(), session_path);
    let payload = if cwd == session_path {
        json!({ "path": query.path })
    } else {
        json!({ "path": query.path, "cwd": cwd })
    };
    match rpc_call(&state, &format!("{id}:readFile"), payload).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_list_files(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<FileSearchQuery>,
) -> impl IntoResponse {
    let Some(session) = require_session_read(&state, &auth, &id) else {
        return missing_or_forbidden_session(&state, &auth, &id).into_response();
    };
    let Some(session_path) = session_path(&session) else {
        return Json(json!({ "success": false, "error": "Session path not available" })).into_response();
    };
    let cwd = resolve_cwd(query.cwd.as_deref(), session_path);
    let trimmed_query = query.query.as_deref().unwrap_or("").trim();
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let mut args = vec!["--files".to_string()];
    if !trimmed_query.is_empty() {
        args.push("--iglob".to_string());
        args.push(format!("*{trimmed_query}*"));
    }
    match rpc_call(&state, &format!("{id}:ripgrep"), json!({ "args": args, "cwd": cwd })).await {
        Ok(value) => {
            if value.get("success").and_then(Value::as_bool) != Some(true) {
                return Json(value).into_response();
            }
            let stdout = value.get("stdout").and_then(Value::as_str).unwrap_or_default();
            let files: Vec<_> = stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .take(limit)
                .map(|full_path| {
                    let (file_path, file_name) = split_file_path(full_path);
                    json!({
                        "fileName": file_name,
                        "filePath": file_path,
                        "fullPath": full_path,
                        "fileType": "file",
                    })
                })
                .collect();
            Json(json!({ "success": true, "files": files })).into_response()
        }
        Err(response) => response,
    }
}

async fn api_list_directory(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let Some(session) = require_session_read(&state, &auth, &id) else {
        return missing_or_forbidden_session(&state, &auth, &id).into_response();
    };
    let Some(session_path) = session_path(&session) else {
        return Json(json!({ "success": false, "error": "Session path not available" })).into_response();
    };
    let cwd = resolve_cwd(query.cwd.as_deref(), session_path);
    let rpc_path = query.path.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(".");
    let payload = if cwd == session_path {
        json!({ "path": rpc_path })
    } else {
        json!({ "path": rpc_path, "cwd": cwd })
    };
    match rpc_call(&state, &format!("{id}:listDirectory"), payload).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_session_usage(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    let Some(metadata) = session.metadata.as_ref().and_then(Value::as_object) else {
        return Json(json!({ "success": false, "error": "Usage is not supported for this session agent" })).into_response();
    };
    let flavor = session_flavor(metadata);
    if !matches!(flavor, "claude" | "codex") {
        return Json(json!({ "success": false, "error": "Usage is not supported for this session agent" })).into_response();
    }
    let Some(machine_id) = metadata.get("machineId").and_then(Value::as_str) else {
        return Json(json!({ "success": false, "error": "Machine ID is missing for this session" })).into_response();
    };
    let Some(machine) = state.store.get_machine_by_namespace(machine_id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "success": false, "error": "Machine not found" }))).into_response();
    };
    if !machine.active {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "success": false, "error": "Runner is offline or restarting" }))).into_response();
    }
    match rpc_call(&state, &format!("{machine_id}:get-usage"), json!({ "provider": flavor })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => map_rpc_error_response(response, "Failed to fetch usage", Some("RPC handler not registered"), Some("runner")),
    }
}

async fn api_upload_file(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<UploadFileBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    if !session.active {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Session is not active" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:uploadFile"), json!({
        "sessionId": id,
        "filename": body.filename,
        "content": body.content,
        "mimeType": body.mime_type,
    })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_delete_upload_file(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<DeleteUploadBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    if !session.active {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Session is not active" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:deleteUpload"), json!({
        "sessionId": id,
        "path": body.path,
    })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_machines(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Query(query): Query<ManagedMachinesQuery>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let want_all = query.all.unwrap_or(false);
    if want_all && !has_permission(&auth.permissions, "machines:read:all") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let manage = query.manage.unwrap_or(false);
    let machines = if want_all {
        state.store.list_machines(None)
    } else {
        state.store.list_machines(Some(&auth.namespace))
    };
    if manage {
        let machines: Vec<_> = machines.into_iter().map(|machine| {
            json!({
                "id": machine.id,
                "namespace": machine.namespace,
                "active": machine.active,
                "activeAt": machine.active_at,
                "createdAt": machine.created_at,
                "updatedAt": machine.updated_at,
                "metadata": machine.metadata,
                "apiKeyId": machine.api_key_id,
                "apiKeyName": machine.api_key_id.as_deref().and_then(|id| state.store.get_api_key_name(id)),
                "notes": machine.notes,
            })
        }).collect();
        Json(json!({ "machines": machines })).into_response()
    } else {
        let machines: Vec<_> = machines.into_iter().filter(|machine| machine.active).collect();
        Json(json!({ "machines": machines })).into_response()
    }
}

#[derive(Debug, Deserialize, Default)]
struct ManagedMachinesQuery {
    manage: Option<bool>,
    all: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct PermissionModeBody {
    mode: String,
}

#[derive(Debug, Deserialize)]
struct ModelModeBody {
    model: String,
}

#[derive(Debug, Deserialize)]
struct ApprovePermissionBody {
    mode: Option<String>,
    #[serde(rename = "allowTools")]
    allow_tools: Option<Vec<String>>,
    decision: Option<String>,
    answers: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
struct DenyPermissionBody {
    decision: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SpawnBody {
    directory: String,
    agent: Option<String>,
    model: Option<String>,
    yolo: Option<bool>,
    #[serde(rename = "sessionType")]
    session_type: Option<String>,
    #[serde(rename = "worktreeName")]
    worktree_name: Option<String>,
    #[serde(rename = "parentSessionId")]
    parent_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PathsExistBody {
    paths: Vec<String>,
}

async fn api_abort_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:abort"), json!({ "reason": "User aborted via web" })).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(response) => response,
    }
}

async fn api_archive_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    if !session.active {
        return Json(json!({ "ok": true })).into_response();
    }
    match state.store.archive_session(&id, &auth.namespace) {
        Ok(true) => {
            if let Some(session) = state.store.get_session(&id) {
                publish_session_updated(&state, &auth.namespace, &session);
            }
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_switch_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:switch"), json!({ "to": "remote" })).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(response) => response,
    }
}

async fn api_set_permission_mode(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<PermissionModeBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:set-session-config"), json!({ "permissionMode": body.mode })).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(response) => response,
    }
}

async fn api_set_model_mode(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<ModelModeBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:set-session-config"), json!({ "modelMode": body.model })).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(response) => response,
    }
}

async fn api_approve_permission(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path((id, request_id)): Path<(String, String)>,
    Json(body): Json<ApprovePermissionBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:permission"), json!({
        "id": request_id,
        "approved": true,
        "mode": body.mode,
        "allowTools": body.allow_tools,
        "decision": body.decision,
        "answers": body.answers,
    })).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(response) => response,
    }
}

async fn api_deny_permission(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path((id, request_id)): Path<(String, String)>,
    Json(body): Json<DenyPermissionBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:permission"), json!({
        "id": request_id,
        "approved": false,
        "decision": body.decision,
    })).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(response) => response,
    }
}

async fn api_slash_commands(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    let flavor = session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("flavor"))
        .and_then(Value::as_str)
        .unwrap_or("claude");
    match rpc_call(&state, &format!("{id}:listSlashCommands"), json!({ "agent": flavor })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_skills(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:listSkills"), json!({})).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_spawn_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<SpawnBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:spawn-happy-session"), json!({
        "type": "spawn-in-directory",
        "directory": body.directory,
        "agent": body.agent.unwrap_or_else(|| "claude".to_string()),
        "model": body.model,
        "yolo": body.yolo,
        "sessionType": body.session_type,
        "worktreeName": body.worktree_name,
        "parentSessionId": body.parent_session_id,
    })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_paths_exist(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<PathsExistBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    match rpc_call(&state, &format!("{id}:path-exists"), json!({ "paths": body.paths })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[derive(Debug, Deserialize)]
struct MachineNotesBody {
    notes: Option<String>,
}

async fn api_update_machine_notes(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<MachineNotesBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    match state.store.update_machine_notes(&id, &auth.namespace, body.notes.as_deref()) {
        Ok(true) => Json(json!({ "ok": true, "notes": body.notes })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_unbind_machine(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    match state.store.unbind_machine(&id, &auth.namespace) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_delete_machine(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    match state.store.delete_machine(&id, &auth.namespace) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_share_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match state.store.set_share_token(&id, &auth.namespace, Some(&id)) {
        Ok(true) => Json(json!({ "shareToken": id })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_unshare_session(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    match state.store.set_share_token(&id, &auth.namespace, None) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_get_share_status(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    };
    Json(json!({ "shareToken": session.share_token })).into_response()
}

async fn api_shared_session(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> impl IntoResponse {
    let Some(session) = state.store.get_session_by_share_token(&token) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Shared session not found" }))).into_response();
    };
    if !session_has_share_token(&session) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Shared session not found" }))).into_response();
    }
    let metadata = session.metadata.clone().unwrap_or(Value::Null);
    Json(json!({
        "session": {
            "id": session.id,
            "title": session_title(metadata.as_object()),
            "flavor": metadata.get("flavor").and_then(Value::as_str),
            "createdAt": session.created_at,
            "updatedAt": session.updated_at,
            "active": session.active,
        }
    })).into_response()
}

async fn api_shared_messages(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> impl IntoResponse {
    let Some(session) = state.store.get_session_by_share_token(&token) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Shared session not found" }))).into_response();
    };
    if !session_has_share_token(&session) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Shared session not found" }))).into_response();
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    match state.store.get_messages_page(&session.id, limit, query.before_seq, query.after_seq) {
        Ok((messages, has_more)) => Json(json!({
            "messages": messages,
            "page": {
                "limit": limit,
                "beforeSeq": query.before_seq,
                "nextBeforeSeq": if query.after_seq.is_none() { messages.first().and_then(|m| m.seq) } else { None },
                "afterSeq": query.after_seq,
                "nextAfterSeq": if query.after_seq.is_some() { messages.last().and_then(|m| m.seq) } else { None },
                "hasMore": has_more
            }
        })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_file_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FileAccessQuery>,
    Path((session_id, file_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let not_found = || (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response();
    if !looks_like_uuid(&session_id) || !looks_like_file_id(&file_id) {
        return not_found();
    }
    let Some(session) = state.store.get_session(&session_id) else {
        return not_found();
    };
    let allowed = if session_has_share_token(&session) {
        true
    } else {
        extract_auth_from_request(&state, &headers, query.token.as_deref())
            .map(|auth| has_permission(&auth.permissions, "sessions:read") && auth.namespace == session.namespace)
            .unwrap_or(false)
    };
    if !allowed {
        return not_found();
    }

    let file_path = state.config.data_dir.join("files").join(&session_id).join(&file_id);
    if !file_path.exists() {
        return not_found();
    }

    let (mime_type, filename) = file_metadata(&file_path, &file_id);
    let is_inline = is_inline_type(&mime_type);
    let disposition = if is_inline { "inline" } else { "attachment" };

    let mut response = match fs::read(&file_path) {
        Ok(bytes) => bytes.into_response(),
        Err(_) => return not_found(),
    };
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime_type).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    if let Some(filename) = filename {
        let safe_filename = filename.replace('"', "");
        if let Ok(value) = HeaderValue::from_str(&format!("{disposition}; filename=\"{safe_filename}\"")) {
            response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
        }
    } else if !is_inline {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    }
    response
}

async fn api_get_preferences(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    let system_prompt = state.store.get_preference(&auth.namespace, "systemPrompt").unwrap_or_default();
    Json(json!({ "systemPrompt": system_prompt })).into_response()
}

async fn api_update_preferences(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<UpdatePreferencesBody>,
) -> impl IntoResponse {
    if let Some(system_prompt) = body.system_prompt {
        let trimmed = system_prompt.trim().to_string();
        let result = if trimmed.is_empty() {
            state.store.set_preference(&auth.namespace, "systemPrompt", None)
        } else {
            state.store.set_preference(&auth.namespace, "systemPrompt", Some(&trimmed))
        };
        if let Err(error) = result {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response();
        }
    }
    let system_prompt = state.store.get_preference(&auth.namespace, "systemPrompt").unwrap_or_default();
    Json(json!({ "systemPrompt": system_prompt })).into_response()
}

async fn api_credentials(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    Json(json!({ "credentials": state.store.list_credentials_by_namespace(&auth.namespace) })).into_response()
}

async fn api_create_credential(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<CreateCredentialBody>,
) -> impl IntoResponse {
    if body.name.trim().is_empty() || !matches!(body.agent_type.as_str(), "claude" | "codex") || !body.config.is_object() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
    }
    match state.store.create_credential(&Uuid::new_v4().to_string(), &auth.namespace, body.name.trim(), &body.agent_type, &body.config) {
        Ok(credential) => (StatusCode::CREATED, Json(json!({ "credential": credential }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_update_credential(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<UpdateCredentialBody>,
) -> impl IntoResponse {
    if body.name.is_none() && body.config.is_none() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Nothing to update" }))).into_response();
    }
    match state.store.update_credential(&id, &auth.namespace, body.name.as_deref(), body.config.as_ref()) {
        Ok(Some(credential)) => Json(json!({ "credential": credential })).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Credential not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_delete_credential(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.delete_credential(&id, &auth.namespace) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Credential not found" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_apply_credentials(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(machine_id): Path<String>,
    Json(body): Json<ApplyCredentialBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if !matches!(body.agent_type.as_str(), "claude" | "codex") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&machine_id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    let Some(credential) = state.store.get_credential_by_namespace(&body.credential_id, &auth.namespace) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Credential not found" }))).into_response();
    };
    if credential.agent_type != body.agent_type {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Credential agent type mismatch" }))).into_response();
    }
    match rpc_call(&state, &format!("{machine_id}:apply-credentials"), json!({ "agentType": body.agent_type, "config": credential.config })).await {
        Ok(value) => {
            if value.get("success").and_then(Value::as_bool) == Some(true) {
                let _ = state.store.set_machine_credential(&machine_id, &credential.agent_type, &credential.id);
                Json(value).into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": value.get("error").and_then(Value::as_str).unwrap_or("Failed to apply credentials") }))).into_response()
            }
        }
        Err(response) => response,
    }
}

async fn api_read_credentials(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(machine_id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_machine_by_namespace(&machine_id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response();
    }
    let Some(agent_type) = query.get("agentType").map(String::as_str) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid agentType query parameter" }))).into_response();
    };
    if !matches!(agent_type, "claude" | "codex") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid agentType query parameter" }))).into_response();
    }
    match rpc_call(&state, &format!("{machine_id}:read-credentials"), json!({ "agentType": agent_type })).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

async fn api_list_api_keys(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let keys = state.store.list_api_keys(Some(&auth.namespace));
    Json(json!({ "apiKeys": keys.into_iter().map(api_key_json).collect::<Vec<_>>() })).into_response()
}

async fn api_create_api_key(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Json(body): Json<CreateApiKeyBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
    }
    let raw_key = generate_api_key_raw();
    let namespace = body.namespace.as_deref().unwrap_or(&auth.namespace);
    let permissions = body.permissions.unwrap_or_default();
    match state.store.create_api_key(
        &Uuid::new_v4().to_string(),
        body.name.trim(),
        &crate::auth::hash_api_key(&raw_key),
        &extract_key_prefix(&raw_key),
        namespace,
        &permissions,
    ) {
        Ok(api_key) => (StatusCode::CREATED, Json(json!({ "apiKey": api_key_json(api_key), "rawKey": raw_key }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_update_api_key(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<UpdateApiKeyBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(existing) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or already revoked" }))).into_response();
    };
    if existing.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or already revoked" }))).into_response();
    }
    match state.store.update_api_key(&id, body.name.as_deref(), body.permissions.as_deref()) {
        Ok(Some(api_key)) => Json(json!({ "apiKey": api_key_json(api_key) })).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or already revoked" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_revoke_api_key(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(existing) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or already revoked" }))).into_response();
    };
    if existing.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or already revoked" }))).into_response();
    }
    match state.store.revoke_api_key(&id) {
        Ok(true) => {
            let _ = state.store.revoke_access_tokens_by_api_key(&id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or already revoked" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_restore_api_key(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(existing) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or not revoked" }))).into_response();
    };
    if existing.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or not revoked" }))).into_response();
    }
    match state.store.restore_api_key(&id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or not revoked" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_list_access_tokens(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(api_key) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    };
    if api_key.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    }
    let tokens = state.store.list_access_tokens_by_api_key(&id);
    Json(json!({ "tokens": tokens.into_iter().map(access_token_json).collect::<Vec<_>>() })).into_response()
}

async fn api_create_access_token(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path(id): Path<String>,
    Json(body): Json<CreateAccessTokenBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(api_key) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or revoked" }))).into_response();
    };
    if api_key.revoked_at.is_some() || api_key.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found or revoked" }))).into_response();
    }
    let Some(expires_at) = expires_at_from_label(&body.expires_in) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response();
    };
    let raw_token = generate_api_key_raw();
    match state.store.create_access_token(
        &Uuid::new_v4().to_string(),
        &id,
        body.name.trim(),
        &crate::auth::hash_api_key(&raw_token),
        &extract_key_prefix(&raw_token),
        &api_key.namespace,
        &api_key.permissions,
        expires_at,
    ) {
        Ok(token) => (StatusCode::CREATED, Json(json!({ "token": access_token_json(token), "rawToken": raw_token }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_update_access_token(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path((id, token_id)): Path<(String, String)>,
    Json(body): Json<UpdateAccessTokenBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(api_key) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    };
    if api_key.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    }
    let expires_at = match body.expires_in.as_deref() {
        Some(label) => match expires_at_from_label(label) {
            Some(value) => Some(value),
            None => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response(),
        },
        None => None,
    };
    match state.store.update_access_token(&token_id, body.name.as_deref(), expires_at) {
        Ok(Some(token)) => Json(json!({ "token": access_token_json(token) })).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Failed to update token" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_revoke_access_token(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path((id, token_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(api_key) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    };
    if api_key.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    }
    match state.store.revoke_access_token(&token_id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Token not found or already revoked" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_restore_access_token(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path((id, token_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(api_key) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    };
    if api_key.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    }
    match state.store.restore_access_token(&token_id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Token not found or not revoked" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_extend_access_token(
    State(state): State<Arc<AppState>>,
    auth: AuthContext,
    Path((id, token_id)): Path<(String, String)>,
    Json(body): Json<ExtendAccessTokenBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "api_keys:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let Some(api_key) = state.store.get_api_key_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    };
    if api_key.namespace != auth.namespace {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "API key not found" }))).into_response();
    }
    let ttl_minutes = body.ttl_minutes.unwrap_or(1440).clamp(1, 60 * 24 * 365);
    let expires_at = now_ms() + ttl_minutes * 60_000;
    match state.store.extend_access_token(&token_id, expires_at) {
        Ok(true) => Json(json!({ "ok": true, "expiresAt": expires_at })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Token not found or already revoked" }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn api_create_invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    auth: AuthContext,
    Json(body): Json<CreateInviteBody>,
) -> impl IntoResponse {
    if !has_permission(&auth.permissions, "machines:manage") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    let ttl_minutes = body.ttl_minutes.unwrap_or(1440).clamp(5, 1440);
    let guest_key_id = match ensure_guest_api_key(&state, &auth.namespace) {
        Ok(id) => id,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    };
    let raw_token = generate_api_key_raw();
    let token_id = Uuid::new_v4().to_string();
    let expires_at = now_ms() + ttl_minutes * 60_000;
    let name = body.name.as_deref().map(|name| format!("guest:{name}")).unwrap_or_else(|| format!("guest-{}", now_ms()));
    match state.store.create_access_token(
        &token_id,
        &guest_key_id,
        &name,
        &crate::auth::hash_api_key(&raw_token),
        &extract_key_prefix(&raw_token),
        &auth.namespace,
        &vec!["machines:write".to_string()],
        expires_at,
    ) {
        Ok(_) => {
            let _ = state.store.create_invite(&Uuid::new_v4().to_string(), &raw_token, &auth.namespace, &auth.api_key_id, expires_at);
            let origin = request_origin(&headers).unwrap_or_else(|| state.config.public_url.clone());
            let command = format!("curl -fsSL {origin}/install | bash -s -- --join {raw_token}");
            Json(json!({ "ok": true, "token": raw_token, "expiresAt": expires_at, "command": command })).into_response()
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response(),
    }
}

async fn rpc_call(state: &AppState, method: &str, params: Value) -> Result<Value, Response> {
    let Some(socket) = state.rpc_socket(method) else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": format!("RPC handler not registered: {method}") }))).into_response());
    };
    let payload = json!({
        "method": method,
        "params": params.to_string(),
    });
    let future = socket
        .timeout(Duration::from_secs(30))
        .emit_with_ack::<_, String>("rpc-request", &payload)
        .map_err(|error| (StatusCode::BAD_GATEWAY, Json(json!({ "error": error.to_string() }))).into_response())?;
    let raw = future
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, Json(json!({ "error": error.to_string() }))).into_response())?;
    Ok(serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!(raw)))
}

#[derive(Debug, Deserialize)]
struct CliCreateSessionBody {
    tag: String,
    #[serde(rename = "parentSessionId")]
    parent_session_id: Option<String>,
    metadata: Value,
    #[serde(rename = "agentState")]
    agent_state: Option<Value>,
}

async fn cli_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CliCreateSessionBody>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "sessions:write") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    match state.store.get_or_create_session(
        &body.tag,
        &body.metadata,
        body.agent_state.as_ref(),
        &auth.namespace,
        body.parent_session_id.as_deref(),
    ) {
        Ok(session) => {
            state.events.publish(SyncEvent::SessionAdded {
                session_id: session.id.clone(),
                namespace: Some(auth.namespace),
                data: None,
            });
            with_protocol_header(Json(json!({ "session": session })).into_response())
        }
        Err(error) => with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response()),
    }
}

async fn cli_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "sessions:read") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    let response = match state.store.get_session_by_namespace(&id, &auth.namespace) {
        Some(session) => Json(json!({ "session": session })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response(),
    };
    with_protocol_header(response)
}

#[derive(Debug, Deserialize)]
struct CliMessagesQuery {
    #[serde(rename = "afterSeq")]
    after_seq: i64,
    limit: Option<i64>,
}

async fn cli_session_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<CliMessagesQuery>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return with_protocol_header((StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response());
    }
    match state.store.get_messages_after(&id, query.after_seq, query.limit.unwrap_or(200).clamp(1, 200)) {
        Ok(messages) => with_protocol_header(Json(json!({ "messages": messages })).into_response()),
        Err(error) => with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response()),
    }
}

#[derive(Debug, Deserialize)]
struct CliHistoryQuery {
    tail: Option<i64>,
    search: Option<String>,
    role: Option<String>,
    #[serde(rename = "afterSeq")]
    after_seq: Option<i64>,
    #[serde(rename = "beforeSeq")]
    before_seq: Option<i64>,
    limit: Option<i64>,
    snippet: Option<String>,
}

async fn cli_session_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<CliHistoryQuery>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "sessions:read") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    if state.store.get_session_by_namespace(&id, &auth.namespace).is_none() {
        return with_protocol_header((StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response());
    }

    let limit = query
        .limit
        .or(query.tail)
        .unwrap_or(20)
        .clamp(1, 200);
    let search = query.search.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let role = query
        .role
        .as_deref()
        .map(str::trim)
        .filter(|value| matches!(*value, "user" | "assistant" | "tool"));
    let want_snippet = parse_bool_param(query.snippet.as_deref()).unwrap_or(false);
    let base_messages = if let Some(term) = search {
        state.store.search_messages(&id, term, 500, 0, query.after_seq, query.before_seq)
    } else {
        let fetch_limit = if role.is_some() { 500 } else { limit };
        state.store.get_messages_page(&id, fetch_limit, query.before_seq, query.after_seq).map(|(messages, _)| messages)
    };

    match base_messages {
        Ok(messages) => {
            let mut out = Vec::new();
            for message in messages {
                let (message_role, text) = cli_history_role_and_text(&message.content);
                if let Some(required_role) = role {
                    if message_role.as_deref() != Some(required_role) {
                        continue;
                    }
                }
                let snippet = if want_snippet {
                    text.as_deref().map(|value| truncate_for_cli_history(value, 240))
                } else {
                    None
                };
                out.push(json!({
                    "id": message.id,
                    "seq": message.seq,
                    "createdAt": message.created_at,
                    "localId": message.local_id,
                    "content": message.content,
                    "role": message_role,
                    "text": text,
                    "snippet": snippet,
                }));
            }
            if out.len() > limit as usize {
                out.truncate(limit as usize);
            }
            with_protocol_header(Json(json!({
                "messages": out,
                "query": {
                    "tail": query.tail,
                    "search": search,
                    "role": role,
                    "afterSeq": query.after_seq,
                    "beforeSeq": query.before_seq,
                    "limit": limit,
                    "snippet": want_snippet,
                }
            })).into_response())
        }
        Err(error) => with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response()),
    }
}

#[derive(Debug, Deserialize)]
struct CliCreateMachineBody {
    id: String,
    metadata: Value,
    #[serde(rename = "runnerState")]
    runner_state: Option<Value>,
}

async fn cli_machines(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CliCreateMachineBody>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "machines:write") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    match state.store.get_or_create_machine(&body.id, &body.metadata, body.runner_state.as_ref(), &auth.namespace, Some(&auth.api_key_id)) {
        Ok(machine) => with_protocol_header(Json(json!({ "machine": machine })).into_response()),
        Err(error) => with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response()),
    }
}

async fn cli_list_machines(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "machines:read") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    let machines = state.store.list_machines(Some(&auth.namespace));
    with_protocol_header(Json(json!({ "machines": machines })).into_response())
}

async fn cli_machine(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    let response = match state.store.get_machine_by_namespace(&id, &auth.namespace) {
        Some(machine) => Json(json!({ "machine": machine })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response(),
    };
    with_protocol_header(response)
}

#[derive(Debug, Deserialize)]
struct CliUpdateMachineNotesBody {
    notes: Option<String>,
}

async fn cli_update_machine_notes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CliUpdateMachineNotesBody>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "machines:write") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    match state.store.update_machine_notes(&id, &auth.namespace, body.notes.as_deref()) {
        Ok(true) => {
            let machine = state.store.get_machine_by_namespace(&id, &auth.namespace);
            with_protocol_header(Json(json!({ "machine": machine })).into_response())
        }
        Ok(false) => with_protocol_header((StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response()),
        Err(error) => with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response()),
    }
}

#[derive(Debug, Deserialize)]
struct CliImportSshKeyBody {
    #[serde(rename = "publicKey")]
    public_key: String,
}

async fn cli_import_ssh_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CliImportSshKeyBody>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "machines:write") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    if state.store.get_machine_by_namespace(&id, &auth.namespace).is_none() {
        return with_protocol_header((StatusCode::NOT_FOUND, Json(json!({ "error": "Machine not found" }))).into_response());
    }
    if body.public_key.trim().is_empty() {
        return with_protocol_header((StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response());
    }
    match rpc_call(&state, &format!("{id}:import-ssh-key"), json!({ "publicKey": body.public_key })).await {
        Ok(value) => with_protocol_header(Json(value).into_response()),
        Err(response) => with_protocol_header(map_rpc_error_response(response, "Failed to import SSH key", Some("RPC handler not registered"), Some("error"))),
    }
}

#[derive(Debug, Deserialize)]
struct CliUploadFileBody {
    content: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    filename: String,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

async fn cli_upload_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CliUploadFileBody>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "sessions:write") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    if state.store.get_session_by_namespace(&body.session_id, &auth.namespace).is_none() {
        return with_protocol_header((StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response());
    }
    if body.filename.trim().is_empty() || body.content.trim().is_empty() {
        return with_protocol_header((StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body" }))).into_response());
    }
    let estimated_bytes = estimate_base64_bytes(&body.content);
    if estimated_bytes > 50 * 1024 * 1024 {
        return with_protocol_header((StatusCode::BAD_REQUEST, Json(json!({ "error": "File too large (max 50MB)" }))).into_response());
    }
    let Ok(buffer) = base64_decode(&body.content) else {
        return with_protocol_header((StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid base64 content" }))).into_response());
    };
    if buffer.len() > 50 * 1024 * 1024 {
        return with_protocol_header((StatusCode::BAD_REQUEST, Json(json!({ "error": "File too large (max 50MB)" }))).into_response());
    }
    let ext = file_extension(&body.filename);
    let id = Uuid::new_v4().to_string();
    let file_id = match ext {
        Some(ext) if !ext.is_empty() => format!("{id}.{ext}"),
        _ => id.clone(),
    };
    let session_dir = state.config.data_dir.join("files").join(&body.session_id);
    if let Err(error) = fs::create_dir_all(&session_dir) {
        return with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response());
    }
    let path = session_dir.join(&file_id);
    if let Err(error) = fs::write(&path, &buffer) {
        return with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response());
    }
    let meta_path = session_dir.join(format!("{file_id}.meta.json"));
    let meta = json!({
        "filename": body.filename,
        "mimeType": body.mime_type,
    });
    let _ = fs::write(meta_path, serde_json::to_vec(&meta).unwrap_or_default());
    with_protocol_header(Json(json!({
        "id": id,
        "url": format!("/api/files/{}/{}", body.session_id, file_id),
    })).into_response())
}

#[derive(Debug, Deserialize)]
struct CliSendMessageBody {
    text: String,
    wait: Option<bool>,
}

async fn cli_send_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CliSendMessageBody>,
) -> impl IntoResponse {
    let Some(auth) = cli_auth(&state, &headers) else {
        return cli_unauthorized();
    };
    if !has_permission(&auth.permissions, "sessions:write") {
        return with_protocol_header((StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response());
    }
    let Some(session) = state.store.get_session_by_namespace(&id, &auth.namespace) else {
        return with_protocol_header((StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response());
    };
    if !session.active {
        return with_protocol_header((StatusCode::CONFLICT, Json(json!({ "error": "Session is not active" }))).into_response());
    }
    if body.text.trim().is_empty() {
        return with_protocol_header((StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid body: text is required" }))).into_response());
    }
    let content = json!({
        "role": "user",
        "content": {
            "type": "text",
            "text": body.text
        },
        "meta": {
            "sentFrom": "cli"
        }
    });
    match state.store.append_message(&id, &content, None) {
        Ok(message) => {
            publish_message_event(&state, &auth.namespace, &id, &message);
            emit_session_update_to_all_cli_peers(&state, &id, &socket_update_new_message(&id, &message));
            if body.wait.unwrap_or(false) {
                match wait_for_assistant_reply(&state, &id, session.thinking, message.seq.unwrap_or_default()).await {
                    Ok(reply) => with_protocol_header(Json(json!({ "ok": true, "seq": message.seq.unwrap_or_default(), "reply": reply })).into_response()),
                    Err(error) => with_protocol_header((StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": error.to_string() }))).into_response()),
                }
            } else {
                with_protocol_header(Json(json!({ "ok": true, "seq": message.seq.unwrap_or_default() })).into_response())
            }
        }
        Err(error) => with_protocol_header((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error.to_string() }))).into_response()),
    }
}

fn cli_history_role_and_text(content: &Value) -> (Option<String>, Option<String>) {
    let role = content.get("role").and_then(Value::as_str);
    match role {
        Some("user") => (
            Some("user".to_string()),
            match content.get("content") {
                Some(Value::String(text)) => Some(text.to_string()),
                Some(Value::Object(value)) => value
                    .get("text")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| {
                        value
                            .get("content")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    }),
                _ => None,
            },
        ),
        Some("tool") => (
            Some("tool".to_string()),
            Some(truncate_for_cli_history(&content.to_string(), 2000)),
        ),
        Some("agent") => {
            let inner = content.get("content").and_then(Value::as_object);
            if inner.and_then(|value| value.get("type")).and_then(Value::as_str) == Some("codex") {
                let data = inner.and_then(|value| value.get("data")).and_then(Value::as_object);
                if data.and_then(|value| value.get("type")).and_then(Value::as_str) == Some("message") {
                    return (
                        Some("assistant".to_string()),
                        data
                            .and_then(|value| value.get("message"))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                    );
                }
            }
            if inner.and_then(|value| value.get("type")).and_then(Value::as_str) == Some("output") {
                let data = inner.and_then(|value| value.get("data")).and_then(Value::as_object);
                if data.and_then(|value| value.get("type")).and_then(Value::as_str) == Some("assistant") {
                    let message = data.and_then(|value| value.get("message")).and_then(Value::as_object);
                    let blocks = message.and_then(|value| value.get("content")).and_then(Value::as_array);
                    let mut texts = Vec::new();
                    if let Some(blocks) = blocks {
                        for block in blocks {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    texts.push(trimmed.to_string());
                                }
                            }
                        }
                    }
                    return (
                        Some("assistant".to_string()),
                        (!texts.is_empty()).then(|| texts.join("\n")),
                    );
                }
            }
            (
                Some("assistant".to_string()),
                Some(truncate_for_cli_history(&content.to_string(), 2000)),
            )
        }
        _ => (None, Some(truncate_for_cli_history(&content.to_string(), 2000))),
    }
}

fn extract_lobstear_assistant_text(content: &Value) -> Option<String> {
    match content.get("role").and_then(Value::as_str) {
        Some("agent") => {}
        _ => return None,
    }
    let inner = content.get("content")?;
    if let Some(text) = inner.get("text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if inner.get("type").and_then(Value::as_str) == Some("codex") {
        let data = inner.get("data")?;
        if data.get("type").and_then(Value::as_str) == Some("message") {
            return data
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned);
        }
    }
    if inner.get("type").and_then(Value::as_str) == Some("output") {
        let data = inner.get("data")?;
        if data.get("type").and_then(Value::as_str) != Some("assistant") {
            return None;
        }
        let message = data.get("message")?;
        let blocks = message.get("content")?.as_array()?;
        let texts: Vec<String> = blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        return (!texts.is_empty()).then(|| texts.join("\n"));
    }
    None
}

fn truncate_for_cli_history(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        value.to_string()
    } else {
        format!("{}...", &value[..limit.saturating_sub(3)])
    }
}

fn estimate_base64_bytes(base64: &str) -> usize {
    let len = base64.len();
    if len == 0 {
        return 0;
    }
    let padding = if base64.ends_with("==") {
        2
    } else if base64.ends_with('=') {
        1
    } else {
        0
    };
    (len * 3) / 4 - padding
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity((bytes.len() * 3) / 4);
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0usize;

    for &byte in bytes {
        if byte.is_ascii_whitespace() {
            continue;
        }
        chunk[chunk_len] = byte;
        chunk_len += 1;
        if chunk_len == 4 {
            decode_base64_chunk(&chunk, &mut out)?;
            chunk_len = 0;
        }
    }
    if chunk_len != 0 {
        return Err("invalid base64 length".to_string());
    }
    Ok(out)
}

fn decode_base64_chunk(chunk: &[u8; 4], out: &mut Vec<u8>) -> Result<(), String> {
    let v0 = base64_value(chunk[0])?;
    let v1 = base64_value(chunk[1])?;
    let v2 = if chunk[2] == b'=' { 0 } else { base64_value(chunk[2])? };
    let v3 = if chunk[3] == b'=' { 0 } else { base64_value(chunk[3])? };

    out.push((v0 << 2) | (v1 >> 4));
    if chunk[2] != b'=' {
        out.push((v1 << 4) | (v2 >> 2));
    }
    if chunk[3] != b'=' {
        out.push((v2 << 6) | v3);
    }
    Ok(())
}

fn base64_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err("invalid base64 character".to_string()),
    }
}

fn file_extension(filename: &str) -> Option<String> {
    let ext = FsPath::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())?;
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return None;
    }
    Some(ext)
}

fn latest_message_seq(state: &AppState, session_id: &str) -> i64 {
    state
        .store
        .get_messages_page(session_id, 1, None, None)
        .ok()
        .and_then(|(messages, _)| messages.last().and_then(|message| message.seq))
        .unwrap_or(0)
}

fn assistant_text_from_message(content: &Value) -> Option<String> {
    if content.get("role").and_then(Value::as_str) != Some("agent") {
        return None;
    }
    let inner = content.get("content").and_then(Value::as_object)?;
    match inner.get("type").and_then(Value::as_str) {
        Some("codex") => {
            let data = inner.get("data").and_then(Value::as_object)?;
            if data.get("type").and_then(Value::as_str) == Some("message") {
                return data.get("message").and_then(Value::as_str).map(ToOwned::to_owned);
            }
            None
        }
        Some("output") => {
            let data = inner.get("data").and_then(Value::as_object)?;
            if data.get("type").and_then(Value::as_str) != Some("assistant") {
                return None;
            }
            let message = data.get("message").and_then(Value::as_object)?;
            let blocks = message.get("content").and_then(Value::as_array)?;
            let texts: Vec<_> = blocks
                .iter()
                .filter_map(|block| {
                    (block.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| block.get("text").and_then(Value::as_str))
                        .flatten()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(ToOwned::to_owned)
                })
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

fn assistant_texts_after(state: &AppState, session_id: &str, after_seq: i64) -> anyhow::Result<Vec<String>> {
    Ok(state
        .store
        .get_messages_after(session_id, after_seq, 500)?
        .into_iter()
        .filter_map(|message| assistant_text_from_message(&message.content))
        .collect())
}

fn emit_session_update_to_all_cli_peers<T: serde::Serialize>(state: &AppState, session_id: &str, payload: &T) {
    if let Some(sockets) = state.session_cli_sockets.lock().get(session_id).cloned() {
        for socket in sockets.values() {
            let _ = socket.emit("update", payload);
        }
    }
}

async fn wait_for_assistant_reply(
    state: &AppState,
    session_id: &str,
    was_thinking_before_send: bool,
    user_message_seq: i64,
) -> anyhow::Result<String> {
    let timeout = tokio::time::sleep(Duration::from_secs(600));
    tokio::pin!(timeout);

    let mut event_rx = state.events.subscribe();
    let mut phase = if was_thinking_before_send {
        "wait-idle"
    } else {
        "wait-thinking"
    };
    let mut anchor_seq = if phase == "wait-thinking" {
        user_message_seq
    } else {
        0
    };

    if !was_thinking_before_send {
        if let Some(session) = state.store.get_session(session_id) {
            if session.thinking {
                phase = "wait-done";
            } else {
                let texts = assistant_texts_after(state, session_id, user_message_seq)?;
                if !texts.is_empty() {
                    return Ok(texts.join("\n"));
                }
            }
        }
    }

    loop {
        tokio::select! {
            _ = &mut timeout => anyhow::bail!("Timeout waiting for reply"),
            event = event_rx.recv() => {
                let Ok(event) = event else { continue; };
                if !matches!(&event, SyncEvent::SessionUpdated { session_id: current, .. } if current == session_id) {
                    continue;
                }
                let Some(session) = state.store.get_session(session_id) else {
                    continue;
                };
                if phase == "wait-idle" {
                    if !session.thinking {
                        anchor_seq = latest_message_seq(state, session_id);
                        phase = "wait-thinking";
                    }
                    continue;
                }
                if phase == "wait-thinking" {
                    if session.thinking {
                        phase = "wait-done";
                        continue;
                    }
                    let texts = assistant_texts_after(state, session_id, anchor_seq)?;
                    if !texts.is_empty() {
                        return Ok(texts.join("\n"));
                    }
                    continue;
                }
                if session.thinking {
                    continue;
                }
                let texts = assistant_texts_after(state, session_id, anchor_seq)?;
                if !texts.is_empty() {
                    return Ok(texts.join("\n"));
                }
            }
        }
    }
}

async fn handle_tunnel_ws(state: Arc<AppState>, tunnel_id: String, role: String, socket: WebSocket) {
    let peer_id = format!("ws:{}:{}", role, Uuid::new_v4());
    let (mut sender, mut receiver) = futures_util::StreamExt::split(socket);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    state.register_tunnel_ws_peer(&tunnel_id, &role, peer_id.clone(), tx);

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sender.send(message).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = futures_util::StreamExt::next(&mut receiver).await {
        match message {
            Message::Binary(data) => relay_tunnel_ws_data(&state, &tunnel_id, &role, data.to_vec()),
            Message::Text(text) => relay_tunnel_ws_data(&state, &tunnel_id, &role, text.to_string().into_bytes()),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    state.unregister_tunnel_ws_peer(&tunnel_id, &role, &peer_id);
    let _ = writer.await;
}

async fn handle_pool_ws(state: Arc<AppState>, machine_id: String, socket: WebSocket) {
    let (mut sender, mut receiver) = futures_util::StreamExt::split(socket);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let pool_id = state.register_pool_ws(&machine_id, tx);

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sender.send(message).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = futures_util::StreamExt::next(&mut receiver).await {
        match message {
            Message::Binary(data) => {
                if let Some(tunnel_id) = state.pool_assigned_tunnel(&pool_id) {
                    relay_tunnel_ws_data(&state, &tunnel_id, "runner", data.to_vec());
                }
            }
            Message::Close(_) => break,
            Message::Text(_) | Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    if let Some(entry) = state.remove_pool_ws(&pool_id) {
        if let Some(tunnel_id) = entry.assigned_tunnel_id {
            state.unregister_tunnel_ws_peer(&tunnel_id, "runner", &entry.pool_id);
            state.close_tunnel_ws(&tunnel_id);
            if let Some(tunnel) = state.remove_tunnel(&tunnel_id) {
                let _ = tunnel.connect_socket.emit("tunnel:close", &json!({ "tunnelId": tunnel_id }));
                let _ = tunnel.runner_socket.emit("tunnel:close", &json!({ "tunnelId": tunnel.tunnel_id }));
            }
        }
    }

    let _ = writer.await;
}

fn relay_tunnel_ws_data(state: &Arc<AppState>, tunnel_id: &str, sender_role: &str, data: Vec<u8>) {
    let Some(entry) = state.tunnel_entry(tunnel_id) else {
        return;
    };
    state.schedule_tunnel_idle(tunnel_id);
    let target_role = if sender_role == "connect" { "runner" } else { "connect" };
    if let Some(sender) = state.tunnel_ws_sender(tunnel_id, target_role) {
        let _ = sender.send(Message::Binary(data.clone().into()));
        return;
    }
    let encoded = base64_encode(&data);
    if sender_role == "connect" {
        let _ = entry.runner_socket.emit("tunnel:data", &json!({ "tunnelId": tunnel_id, "data": encoded }));
    } else {
        let _ = entry.connect_socket.emit("tunnel:data", &json!({ "tunnelId": tunnel_id, "data": encoded }));
    }
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0usize;
    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[((b0 & 0x03) << 4 | (b1 >> 4)) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[((b1 & 0x0f) << 2 | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

async fn not_implemented(method: Method) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": format!("{} not implemented in happier-hub yet", method) })))
}

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Html("not found"))
}

fn not_found_response() -> Response {
    (StatusCode::NOT_FOUND, Html("not found")).into_response()
}

fn cli_auth(state: &Arc<AppState>, headers: &HeaderMap) -> Option<crate::auth::ApiAuth> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = raw.strip_prefix("Bearer ")?;
    authenticate_cli_token(state, token)
}

fn cli_unauthorized() -> Response {
    with_protocol_header((StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid token" }))).into_response())
}

fn with_protocol_header(mut response: Response) -> Response {
    response.headers_mut().insert(
        "x-hapi-protocol-version",
        HeaderValue::from_str(&PROTOCOL_VERSION.to_string()).unwrap(),
    );
    response
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("http");
    Some(format!("{proto}://{host}"))
}

fn find_web_dist_dir() -> Option<PathBuf> {
    [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        PathBuf::from("web/dist"),
    ]
    .into_iter()
    .find(|dir| dir.join("index.html").exists())
}

fn serve_index_html() -> Option<Response> {
    let dist_dir = find_web_dist_dir()?;
    let path = dist_dir.join("index.html");
    let bytes = fs::read(path).ok()?;
    Some(([(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))], bytes).into_response())
}

fn serve_web_path(path: &str) -> Option<Response> {
    let dist_dir = find_web_dist_dir()?;
    let safe = path.trim_start_matches('/');
    if safe.contains("..") || safe.is_empty() {
        return None;
    }
    let file = dist_dir.join(safe);
    if !file.exists() || !file.is_file() {
        return None;
    }
    let bytes = fs::read(&file).ok()?;
    let content_type = infer_static_mime(&file);
    Some(([(header::CONTENT_TYPE, HeaderValue::from_str(content_type).ok()?)], bytes).into_response())
}

fn require_session_read<'a>(state: &'a AppState, auth: &AuthContext, session_id: &str) -> Option<Session> {
    if !has_permission(&auth.permissions, "sessions:read") {
        return None;
    }
    state.store.get_session_by_namespace(session_id, &auth.namespace)
}

fn missing_or_forbidden_session(state: &AppState, auth: &AuthContext, session_id: &str) -> Response {
    if !has_permission(&auth.permissions, "sessions:read") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response();
    }
    if state.store.get_session_by_namespace(session_id, &auth.namespace).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Session not found" }))).into_response();
    }
    (StatusCode::FORBIDDEN, Json(json!({ "error": "Insufficient permissions" }))).into_response()
}

fn session_path(session: &Session) -> Option<&str> {
    session
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("path"))
        .and_then(Value::as_str)
}

fn resolve_cwd<'a>(cwd: Option<&'a str>, session_path: &'a str) -> &'a str {
    cwd.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(session_path)
}

fn parse_bool_param(value: Option<&str>) -> Option<bool> {
    match value {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

fn split_file_path(full_path: &str) -> (String, String) {
    match full_path.rsplit_once('/') {
        Some((file_path, file_name)) => (file_path.to_string(), file_name.to_string()),
        None => ("".to_string(), full_path.to_string()),
    }
}

fn merge_json_objects(current: Value, next: Value) -> Value {
    let mut current = current.as_object().cloned().unwrap_or_default();
    if let Some(next) = next.as_object() {
        for (key, value) in next {
            current.insert(key.clone(), value.clone());
        }
    }
    Value::Object(current)
}

fn session_flavor(metadata: &serde_json::Map<String, Value>) -> &'static str {
    match metadata.get("flavor").and_then(Value::as_str) {
        Some("codex") => "codex",
        Some("gemini") => "gemini",
        Some("opencode") => "opencode",
        _ => "claude",
    }
}

fn resume_token<'a>(metadata: &'a serde_json::Map<String, Value>, flavor: &str) -> Option<&'a str> {
    match flavor {
        "codex" => metadata.get("codexSessionId").and_then(Value::as_str),
        "gemini" => metadata.get("geminiSessionId").and_then(Value::as_str),
        "opencode" => metadata.get("opencodeSessionId").and_then(Value::as_str),
        _ => metadata.get("claudeSessionId").and_then(Value::as_str),
    }
}

fn source_agent_session_id<'a>(metadata: &'a serde_json::Map<String, Value>, flavor: &str) -> Option<&'a str> {
    match flavor {
        "codex" => metadata.get("codexSessionId").and_then(Value::as_str),
        "claude" => metadata.get("claudeSessionId").and_then(Value::as_str),
        _ => None,
    }
}

fn metadata_is_yolo(metadata: &serde_json::Map<String, Value>) -> bool {
    matches!(
        metadata.get("permissionMode").and_then(Value::as_str),
        Some("bypassPermissions" | "yolo" | "safe-yolo")
    )
}

fn pick_online_machine(state: &AppState, namespace: &str, metadata: &serde_json::Map<String, Value>) -> Option<crate::types::Machine> {
    let mut machines: Vec<_> = state
        .store
        .list_machines(Some(namespace))
        .into_iter()
        .filter(|machine| machine.active)
        .collect();
    if let Some(machine_id) = metadata.get("machineId").and_then(Value::as_str) {
        if let Some(machine) = machines.iter().find(|machine| machine.id == machine_id) {
            return Some(machine.clone());
        }
    }
    if let Some(host) = metadata.get("host").and_then(Value::as_str) {
        if let Some(machine) = machines
            .iter()
            .find(|machine| machine.metadata.as_ref().and_then(Value::as_object).and_then(|m| m.get("host")).and_then(Value::as_str) == Some(host))
        {
            return Some(machine.clone());
        }
    }
    machines.pop()
}

fn spawn_result_response(value: Value, fallback_code: &str) -> Response {
    match value.get("type").and_then(Value::as_str) {
        Some("success") if value.get("sessionId").and_then(Value::as_str).is_some() => Json(value).into_response(),
        Some("error") => {
            let message = value
                .get("errorMessage")
                .or_else(|| value.get("message"))
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("Unexpected spawn result");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": message, "code": fallback_code }))).into_response()
        }
        Some("requestToApproveDirectoryCreation") => {
            (StatusCode::CONFLICT, Json(value)).into_response()
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Unexpected spawn result", "code": fallback_code }))).into_response(),
    }
}

fn map_rpc_error_response(response: Response, default_message: &str, unavailable_hint: Option<&str>, mode: Option<&str>) -> Response {
    let status = response.status();
    if status != StatusCode::SERVICE_UNAVAILABLE {
        return response;
    }
    let message = match (unavailable_hint, mode) {
        (Some(_), Some("runner")) => "Runner is offline or restarting",
        (Some(_), Some("success")) => default_message,
        _ => default_message,
    };
    let body = if mode == Some("success") {
        json!({ "success": false, "error": message })
    } else {
        json!({ "success": false, "error": message })
    };
    (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
}

fn normalize_fork_metadata(metadata: &mut Value, source_flavor: &str, target_flavor: Option<&str>) {
    let target_flavor = target_flavor.unwrap_or(source_flavor);
    let Some(obj) = metadata.as_object_mut() else {
        return;
    };
    if let Some(name) = obj.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        obj.insert(
            "name".into(),
            Value::String(format!("{name} ({})", if target_flavor == source_flavor { "fork" } else { target_flavor })),
        );
    }
    obj.insert("flavor".into(), Value::String(target_flavor.to_string()));
    for key in ["claudeSessionId", "codexSessionId", "geminiSessionId", "opencodeSessionId", "hostPid", "lifecycleState", "lifecycleStateSince", "archivedBy", "archiveReason", "startedFromRunner", "startedBy"] {
        obj.remove(key);
    }
}

fn copy_session_files(state: &AppState, source_session_id: &str, target_session_id: &str) {
    let files_dir = state.config.data_dir.join("files");
    let src_dir = files_dir.join(source_session_id);
    if !src_dir.exists() {
        return;
    }
    let dst_dir = files_dir.join(target_session_id);
    let _ = fs::create_dir_all(&dst_dir);
    copy_dir_recursive(&src_dir, &dst_dir);
}

fn copy_dir_recursive(src: &FsPath, dst: &FsPath) {
    let Ok(entries) = fs::read_dir(src) else {
        return;
    };
    for entry in entries.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            let _ = fs::create_dir_all(&dst_path);
            copy_dir_recursive(&src_path, &dst_path);
        } else {
            let _ = fs::copy(&src_path, &dst_path);
        }
    }
}

fn session_has_share_token(session: &Session) -> bool {
    session.share_token.as_deref().map(|value| !value.is_empty()).unwrap_or(false)
}

fn session_title(metadata: Option<&serde_json::Map<String, Value>>) -> String {
    let Some(metadata) = metadata else {
        return "Shared Session".to_string();
    };
    if let Some(name) = metadata.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        return name.to_string();
    }
    if let Some(text) = metadata
        .get("summary")
        .and_then(Value::as_object)
        .and_then(|summary| summary.get("text"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return text.to_string();
    }
    if let Some(path) = metadata.get("path").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        return FsPath::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Shared Session")
            .to_string();
    }
    "Shared Session".to_string()
}

fn extract_auth_from_request(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> Option<AuthContext> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or(query_token)
        .or_else(|| {
            headers
                .get(header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .and_then(|cookie| {
                    cookie
                        .split(';')
                        .map(str::trim)
                        .find_map(|item| item.strip_prefix("hapi_token="))
                })
        })?;
    verify_auth_token(state, token)
}

fn looks_like_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(idx, byte)| match idx {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn looks_like_file_id(value: &str) -> bool {
    let (base, ext) = match value.split_once('.') {
        Some((base, ext)) => (base, Some(ext)),
        None => (value, None),
    };
    looks_like_uuid(base) && ext.map(|value| !value.is_empty() && value.len() <= 10 && value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(true)
}

fn file_metadata(file_path: &FsPath, file_id: &str) -> (String, Option<String>) {
    let mut mime_type = infer_mime_type(file_id).to_string();
    let mut filename = None;
    let meta_path = PathBuf::from(format!("{}.meta.json", file_path.display()));
    if let Ok(raw) = fs::read_to_string(meta_path) {
        if let Ok(meta) = serde_json::from_str::<Value>(&raw) {
            filename = meta.get("filename").and_then(Value::as_str).map(ToOwned::to_owned);
            if let Some(content_type) = meta.get("mimeType").and_then(Value::as_str) {
                mime_type = content_type.to_string();
            }
        }
    }
    (mime_type, filename)
}

fn infer_mime_type(file_id: &str) -> &'static str {
    match file_id.rsplit('.').next().unwrap_or_default() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tiff" => "image/tiff",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn infer_static_mime(path: &FsPath) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

fn is_inline_type(mime_type: &str) -> bool {
    ["image/", "text/html", "text/plain", "text/css", "text/javascript", "application/pdf", "application/json"]
        .iter()
        .any(|item| mime_type == *item || (item.ends_with('/') && mime_type.starts_with(item)))
}

fn generate_api_key_raw() -> String {
    use rand::{distributions::Alphanumeric, Rng};
    let suffix: String = rand::thread_rng().sample_iter(&Alphanumeric).take(43).map(char::from).collect();
    format!("hapi_{suffix}")
}

fn random_base64url(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url_encode(&bytes)
}

fn base64_url_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
    }
    out
}

fn extract_key_prefix(raw: &str) -> String {
    raw.chars().take(12).collect()
}

fn expires_at_from_label(label: &str) -> Option<i64> {
    Some(match label {
        "1d" => now_ms() + 24 * 60 * 60 * 1000,
        "7d" => now_ms() + 7 * 24 * 60 * 60 * 1000,
        "30d" => now_ms() + 30 * 24 * 60 * 60 * 1000,
        "never" => 0,
        _ => return None,
    })
}

fn api_key_json(api_key: crate::store::StoredApiKey) -> Value {
    json!({
        "id": api_key.id,
        "name": api_key.name,
        "keyPrefix": api_key.key_prefix,
        "namespace": api_key.namespace,
        "permissions": api_key.permissions,
        "createdAt": api_key.created_at,
        "revokedAt": api_key.revoked_at,
        "lastUsedAt": api_key.last_used_at,
    })
}

fn access_token_json(token: crate::store::StoredAccessToken) -> Value {
    json!({
        "id": token.id,
        "apiKeyId": token.api_key_id,
        "name": token.name,
        "tokenPrefix": token.token_prefix,
        "namespace": token.namespace,
        "permissions": token.permissions,
        "createdAt": token.created_at,
        "expiresAt": token.expires_at,
        "revokedAt": token.revoked_at,
    })
}

fn ensure_guest_api_key(state: &AppState, namespace: &str) -> anyhow::Result<String> {
    if let Some(existing) = state
        .store
        .list_api_keys(Some(namespace))
        .into_iter()
        .find(|key| key.name == "invited-guests" && key.revoked_at.is_none())
    {
        return Ok(existing.id);
    }
    let raw_key = generate_api_key_raw();
    let api_key = state.store.create_api_key(
        &Uuid::new_v4().to_string(),
        "invited-guests",
        &crate::auth::hash_api_key(&raw_key),
        &extract_key_prefix(&raw_key),
        namespace,
        &vec!["machines:write".to_string()],
    )?;
    Ok(api_key.id)
}

fn cleanup_qr_sessions(state: &AppState) {
    let now = now_ms();
    state
        .qr_sessions
        .lock()
        .retain(|_, session| now - session.created_at <= 5 * 60 * 1000);
}

fn qr_parent_api_key_id(state: &AppState, auth: &AuthContext) -> Option<String> {
    if auth.api_key_id != "__legacy__" && state.store.get_api_key_by_id(&auth.api_key_id).is_some() {
        return Some(auth.api_key_id.clone());
    }
    state
        .store
        .list_api_keys(Some(&auth.namespace))
        .into_iter()
        .find(|key| key.revoked_at.is_none())
        .map(|key| key.id)
}

async fn get_or_create_voice_agent_id(api_key: &str) -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<parking_lot::Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| parking_lot::Mutex::new(std::collections::HashMap::new()));
    let cache_key = format!("{}...{}", &api_key.chars().take(4).collect::<String>(), &api_key.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>());
    if let Some(value) = cache.lock().get(&cache_key).cloned() {
        return Some(value);
    }

    let client = reqwest::Client::new();
    if let Ok(response) = client
        .get(format!("{ELEVENLABS_API_BASE}/convai/agents"))
        .header("xi-api-key", api_key)
        .header("accept", "application/json")
        .send()
        .await
    {
        if response.status().is_success() {
            if let Ok(value) = response.json::<Value>().await {
                if let Some(agent_id) = value
                    .get("agents")
                    .and_then(Value::as_array)
                    .and_then(|agents| {
                        agents.iter().find_map(|agent| {
                            let name = agent.get("name").and_then(Value::as_str)?;
                            (name == VOICE_AGENT_NAME).then(|| agent.get("agent_id").and_then(Value::as_str)).flatten()
                        })
                    })
                {
                    cache.lock().insert(cache_key, agent_id.to_string());
                    return Some(agent_id.to_string());
                }
            }
        }
    }

    let body = build_voice_agent_config();
    let response = client
        .post(format!("{ELEVENLABS_API_BASE}/convai/agents/create"))
        .header("xi-api-key", api_key)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value = response.json::<Value>().await.ok()?;
    let agent_id = value.get("agent_id").and_then(Value::as_str)?.to_string();
    cache.lock().insert(cache_key, agent_id.clone());
    Some(agent_id)
}

fn percent_encode_simple(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

const ELEVENLABS_API_BASE: &str = "https://api.elevenlabs.io/v1";
const VOICE_AGENT_NAME: &str = "Hapi Voice Assistant";
const VOICE_FIRST_MESSAGE: &str = "Hey! Hapi here.";
const VOICE_SYSTEM_PROMPT: &str = r#"# Identity

You are Hapi Voice Assistant. You bridge voice communication between users and their AI coding agents in the Hapi ecosystem.

You are friendly, proactive, and highly intelligent with a world-class engineering background. Your approach is warm, witty, and relaxed, balancing professionalism with an approachable vibe.

# Environment Overview

Hapi is a multi-agent development platform supporting:
- **Claude Code** - Anthropic's coding assistant (primary)
- **Codex** - OpenAI's coding agent
- **Gemini** - Google's coding agent

Users control these agents through the Hapi web interface or Telegram Mini App. You serve as the voice interface to whichever agent is currently active.

# How Context Updates Work

You receive automatic context updates when:
- A session becomes focused (you see the full session history)
- The agent sends messages or uses tools
- Permission requests arrive
- The agent finishes working (ready event)

These updates appear as system messages. You do NOT need to poll or ask for updates. Simply wait for them and summarize when relevant.

# Tools

## messageCodingAgent
Send user requests to the active coding agent.

When to use:
- User says "ask Claude to..." or "have it..."
- Any coding, file, or development request
- User wants to continue a task

Example: User says "refactor the auth module" -> call messageCodingAgent with the full request.

## processPermissionRequest
Approve or deny pending permission requests.

When to use:
- User says "yes", "allow", "go ahead", "approve"
- User says "no", "deny", "cancel", "stop"

The decision parameter must be exactly "allow" or "deny".

# Voice Output Guidelines

## Summarization (Critical)
- NEVER read hashes, IDs, or paths character-by-character
- Say "session ending in ZAJ" not "c-m-i-a-b-c-1-2-3..."
- Say "file in the src folder" not the full path
- Summarize code changes at a high level
- Skip tool arguments unless specifically asked

## TTS Formatting
- Use ellipses "..." for pauses
- Say "dot" for periods in URLs/paths
- Spell out acronyms: "API" becomes "A P I"
- Use normalized spoken language

## Conversation Style
- Keep responses to 1-3 sentences typically
- Use brief affirmations: "got it", "sure thing"
- Occasional natural fillers: "so", "actually"
- Mirror user energy: terse replies for terse questions
- Lead with empathy for frustrated users

# Behavioral Guidelines

## Patience
After sending a message to the agent, WAIT SILENTLY. The agent may take 30+ seconds for complex tasks. Do NOT:
- Ask "are you still there?"
- Repeat the request
- Fill silence with chatter

You will receive a context update when the agent responds or finishes.

## Request Routing
- Direct address ("Assistant, explain...") -> Answer yourself
- Explicit delegation ("Have Claude...") -> Use messageCodingAgent
- Coding/file tasks -> Use messageCodingAgent
- General questions you can answer -> Answer yourself

Do NOT second-guess what the agent can do. If in doubt, pass it through.

## Proactive Updates
Speak proactively when:
- Permission is requested (inform user and ask for decision)
- Agent finishes a task (summarize results)
- Error occurs (explain clearly)
- Session status changes significantly

Stay silent when:
- Agent is actively working
- No meaningful update to share

# Common Scenarios

## Permission Requests
When you see a permission request, immediately inform the user:
"Claude wants to run a bash command. Should I allow it?"
Then wait for their response and use processPermissionRequest.

## Errors
If the agent reports an error:
- Summarize the error type
- Suggest what the user might do
- Do NOT read stack traces verbatim

## Session Issues
If there is no active session:
- Tell the user to select or start a session in the app
- You cannot start sessions yourself

## Long Operations
For builds, tests, or large file operations:
- Acknowledge the task was sent
- Wait silently for completion
- Summarize results when ready

# Guardrails

- Never read code line-by-line or provide inline code samples
- Never repeat the same information multiple ways in one response
- Treat garbled input as phonetic hints and ask for clarification
- Correct yourself immediately if you realize you made an error
- Keep conversations forward-moving with fresh insights
- Assume a technical software developer audience"#;

fn build_voice_agent_config() -> Value {
    json!({
        "name": VOICE_AGENT_NAME,
        "conversation_config": {
            "agent": {
                "first_message": VOICE_FIRST_MESSAGE,
                "language": "en",
                "prompt": {
                    "prompt": VOICE_SYSTEM_PROMPT,
                    "llm": "gemini-2.5-flash",
                    "temperature": 0.7,
                    "max_tokens": 1024,
                    "tools": [
                        {
                            "type": "client",
                            "name": "messageCodingAgent",
                            "description": "Send a message to the active coding agent. Use this tool to relay the user's coding requests, questions, or instructions to the agent. The message should be clear and complete.",
                            "expects_response": true,
                            "response_timeout_secs": 120,
                            "parameters": {
                                "type": "object",
                                "required": ["message"],
                                "properties": {
                                    "message": {
                                        "type": "string",
                                        "description": "The message to send to the coding agent. Should contain the user's complete request or instruction."
                                    }
                                }
                            }
                        },
                        {
                            "type": "client",
                            "name": "processPermissionRequest",
                            "description": "Process a permission request from the coding agent. Use this when the user wants to allow or deny a pending permission request.",
                            "expects_response": true,
                            "response_timeout_secs": 30,
                            "parameters": {
                                "type": "object",
                                "required": ["decision"],
                                "properties": {
                                    "decision": {
                                        "type": "string",
                                        "description": "The user's decision: must be either 'allow' or 'deny'"
                                    }
                                }
                            }
                        }
                    ]
                }
            },
            "turn": {
                "turn_timeout": 30.0,
                "silence_end_call_timeout": 600.0
            },
            "tts": {
                "voice_id": "cgSgspJ2msm6clMCkdW9",
                "model_id": "eleven_flash_v2",
                "speed": 1.1
            }
        },
        "platform_settings": {
            "overrides": {
                "conversation_config_override": {
                    "agent": {
                        "language": true
                    }
                }
            }
        }
    })
}

fn iso_minute_stamp() -> String {
    let secs = now_ms() / 1000;
    let tm = chrono_like_utc(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}", tm.0, tm.1, tm.2, tm.3, tm.4)
}

fn chrono_like_utc(secs: i64) -> (i32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let hour = (sod / 3600) as u32;
    let minute = ((sod % 3600) / 60) as u32;
    let (year, month, day) = civil_from_days(days);
    (year, month, day, hour, minute)
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn event_matches_namespace(event: &SyncEvent, namespace: &str) -> bool {
    match event {
        SyncEvent::SessionAdded { namespace: Some(ns), .. }
        | SyncEvent::SessionUpdated { namespace: Some(ns), .. }
        | SyncEvent::MessageReceived { namespace: Some(ns), .. }
        | SyncEvent::MachineUpdated { namespace: Some(ns), .. }
        | SyncEvent::ConnectionChanged { namespace: Some(ns), .. } => ns == namespace,
        _ => false,
    }
}

fn event_matches_session(event: &SyncEvent, session_id: &str) -> bool {
    match event {
        SyncEvent::SessionAdded { session_id: current, .. }
        | SyncEvent::SessionUpdated { session_id: current, .. }
        | SyncEvent::MessageReceived { session_id: current, .. } => current == session_id,
        _ => false,
    }
}

fn event_matches_machine(event: &SyncEvent, machine_id: &str) -> bool {
    match event {
        SyncEvent::MachineUpdated { machine_id: current, .. } => current == machine_id,
        _ => false,
    }
}

pub fn publish_message_event(state: &AppState, namespace: &str, session_id: &str, message: &DecryptedMessage) {
    state.events.publish(SyncEvent::MessageReceived {
        session_id: session_id.to_string(),
        namespace: Some(namespace.to_string()),
        message: message.clone(),
    });
}

pub fn publish_session_updated(state: &AppState, namespace: &str, session: &Session) {
    state.events.publish(SyncEvent::SessionUpdated {
        session_id: session.id.clone(),
        namespace: Some(namespace.to_string()),
        data: None,
    });
}

pub fn versioned_update_response(update: VersionedUpdate<Value>, field: &str) -> Value {
    match update {
        VersionedUpdate::Success { version, value } => json!({ "result": "success", "version": version, field: value }),
        VersionedUpdate::VersionMismatch { version, value } => json!({ "result": "version-mismatch", "version": version, field: value }),
        VersionedUpdate::Error => json!({ "result": "error" }),
    }
}

pub fn socket_update_new_message(session_id: &str, message: &DecryptedMessage) -> SocketUpdate {
    SocketUpdate {
        id: Uuid::new_v4().to_string(),
        seq: message.seq.unwrap_or_default(),
        body: json!({
            "t": "new-message",
            "sid": session_id,
            "message": message,
        }),
        created_at: message.created_at,
    }
}
