use crate::{
    notifications::{build_miniapp_deep_link, first_request_id, get_agent_name},
    state::AppState,
    types::Session,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

#[derive(Clone)]
struct BotState {
    offset: i64,
}

pub fn start_telegram_bot(state: Arc<AppState>) {
    let Some(bot_token) = state.config.telegram_bot_token.clone() else {
        return;
    };
    let client = reqwest::Client::new();
    tokio::spawn(run_bot_loop(state, client, bot_token));
}

async fn run_bot_loop(state: Arc<AppState>, client: reqwest::Client, bot_token: String) {
    let mut bot_state = BotState { offset: 0 };

    loop {
        sleep(Duration::from_millis(200)).await;
        if let Err(error) = poll_updates(&state, &client, &bot_token, &mut bot_state).await {
            tracing::warn!(error = %error, "telegram poll failed");
            sleep(Duration::from_secs(2)).await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct TelegramNotificationChannel {
    client: reqwest::Client,
    bot_token: String,
}

impl TelegramNotificationChannel {
    pub(crate) fn new(state: &AppState) -> Option<Self> {
        Some(Self {
            client: reqwest::Client::new(),
            bot_token: state.config.telegram_bot_token.clone()?,
        })
    }

    pub(crate) async fn send_permission_request(
        &self,
        state: &AppState,
        session: &Session,
    ) -> anyhow::Result<()> {
        send_permission_request(state, &self.client, &self.bot_token, session).await
    }

    pub(crate) async fn send_ready(
        &self,
        state: &AppState,
        session: &Session,
    ) -> anyhow::Result<()> {
        send_ready(state, &self.client, &self.bot_token, session).await
    }
}

async fn poll_updates(
    state: &Arc<AppState>,
    client: &reqwest::Client,
    bot_token: &str,
    bot_state: &mut BotState,
) -> anyhow::Result<()> {
    let response = client
        .get(format!("https://api.telegram.org/bot{bot_token}/getUpdates"))
        .query(&[
            ("timeout", "1"),
            ("offset", &bot_state.offset.to_string()),
            ("allowed_updates", "[\"message\",\"callback_query\"]"),
        ])
        .send()
        .await?;
    let value: Value = response.json().await?;
    let Some(results) = value.get("result").and_then(Value::as_array) else {
        return Ok(());
    };

    for update in results {
        let update_id = update.get("update_id").and_then(Value::as_i64).unwrap_or(0);
        bot_state.offset = update_id + 1;
        if let Some(message) = update.get("message") {
            handle_message(state, client, bot_token, message).await;
        }
        if let Some(callback) = update.get("callback_query") {
            handle_callback_query(state, client, bot_token, callback).await;
        }
    }
    Ok(())
}

async fn handle_message(state: &Arc<AppState>, client: &reqwest::Client, bot_token: &str, message: &Value) {
    let chat_id = message.get("chat").and_then(|v| v.get("id")).and_then(Value::as_i64);
    let text = message.get("text").and_then(Value::as_str).unwrap_or_default();
    let Some(chat_id) = chat_id else {
        return;
    };

    match text.split_whitespace().next().unwrap_or_default() {
        "/start" => {
            let _ = send_message(
                client,
                bot_token,
                chat_id,
                "Welcome to HAPI Bot!\n\nUse the Mini App for full session management.",
                Some(web_app_keyboard("Open App", &state.config.public_url)),
            ).await;
        }
        "/app" => {
            let _ = send_message(
                client,
                bot_token,
                chat_id,
                "Open HAPI Mini App:",
                Some(web_app_keyboard("Open App", &state.config.public_url)),
            ).await;
        }
        _ => {}
    }
}

async fn handle_callback_query(state: &Arc<AppState>, client: &reqwest::Client, bot_token: &str, callback: &Value) {
    let Some(data) = callback.get("data").and_then(Value::as_str) else {
        return;
    };
    let Some(from_id) = callback.get("from").and_then(|v| v.get("id")).and_then(Value::as_i64) else {
        return;
    };
    let Some(user) = state.store.get_user("telegram", &from_id.to_string()) else {
        return;
    };
    let Some((action, session_prefix, request_prefix)) = parse_callback_data(data) else {
        answer_callback_query(client, bot_token, callback, Some("Unknown action")).await;
        return;
    };
    let Some(session) = state
        .store
        .list_sessions(Some(&user.namespace))
        .into_iter()
        .find(|session| session.id.starts_with(session_prefix))
    else {
        answer_callback_query(client, bot_token, callback, Some("Session not found")).await;
        return;
    };
    if !session.active {
        answer_callback_query(client, bot_token, callback, Some("Session is inactive")).await;
        return;
    }
    let request_id = first_request_id(&session)
        .filter(|request_id| request_id.starts_with(request_prefix))
        .or_else(|| first_request_id(&session));
    let Some(request_id) = request_id else {
        answer_callback_query(client, bot_token, callback, Some("Request not found")).await;
        return;
    };
    let approved = action == "ap";
    match rpc_call(
        state,
        &format!("{}:permission", session.id),
        json!({ "id": request_id, "approved": approved }),
    ).await {
        Ok(_) => {
            let text = if approved { "Approved!" } else { "Denied" };
            answer_callback_query(client, bot_token, callback, Some(text)).await;
            let message_text = if approved { "Permission approved." } else { "Permission denied." };
            edit_callback_message(client, bot_token, callback, message_text).await;
        }
        Err(error) => {
            tracing::warn!(session_id = %session.id, approved, error = %error, "telegram permission callback failed");
            answer_callback_query(client, bot_token, callback, Some("Action failed")).await;
        }
    }
}

async fn send_permission_request(
    state: &AppState,
    client: &reqwest::Client,
    bot_token: &str,
    session: &Session,
) -> anyhow::Result<()> {
    let Some(request_id) = first_request_id(session) else {
        return Ok(());
    };
    let request_prefix = &request_id[..request_id.len().min(8)];
    let text = format_permission_request(session);
    let keyboard = callback_keyboard(
        vec![
            ("Allow", format!("ap:{}:{}", &session.id[..session.id.len().min(8)], request_prefix)),
            ("Deny", format!("dn:{}:{}", &session.id[..session.id.len().min(8)], request_prefix)),
        ],
        Some(("Details", build_miniapp_deep_link(&state.config.public_url, &format!("session_{}", session.id)))),
    );
    for chat_id in bound_chat_ids(state, &session.namespace) {
        let _ = send_message(client, bot_token, chat_id, &text, Some(keyboard.clone())).await;
    }
    Ok(())
}

async fn send_ready(
    state: &AppState,
    client: &reqwest::Client,
    bot_token: &str,
    session: &Session,
) -> anyhow::Result<()> {
    let text = format!("It's ready!\n\n{} is waiting for your command", get_agent_name(session));
    let keyboard = web_app_keyboard(
        "Open Session",
        &build_miniapp_deep_link(&state.config.public_url, &format!("session_{}", session.id)),
    );
    for chat_id in bound_chat_ids(state, &session.namespace) {
        let _ = send_message(client, bot_token, chat_id, &text, Some(keyboard.clone())).await;
    }
    Ok(())
}

fn bound_chat_ids(state: &AppState, namespace: &str) -> Vec<i64> {
    state
        .store
        .get_users_by_platform_and_namespace("telegram", namespace)
        .into_iter()
        .filter_map(|user| user.platform_user_id.parse::<i64>().ok())
        .collect()
}

fn format_permission_request(session: &Session) -> String {
    let mut lines = vec!["Permission Request".to_string()];
    let name = session
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("name").and_then(Value::as_str).map(ToOwned::to_owned))
        .or_else(|| {
            session
                .metadata
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("path").and_then(Value::as_str).map(ToOwned::to_owned))
        })
        .unwrap_or_else(|| session.id[..session.id.len().min(8)].to_string());
    lines.push(String::new());
    lines.push(format!("Session: {name}"));

    if let Some(requests) = session.agent_state.as_ref().and_then(|value| value.get("requests")).and_then(Value::as_object) {
        if let Some(request) = requests.values().next() {
            if let Some(tool) = request.get("tool").and_then(Value::as_str) {
                lines.push(format!("Tool: {tool}"));
            }
            if let Some(command) = request.get("arguments").and_then(|v| v.get("command")).and_then(Value::as_str) {
                lines.push(format!("Command: {}", truncate(command, 150)));
            }
        }
    }

    truncate(&lines.join("\n"), 3800)
}

fn truncate(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len.saturating_sub(3)])
    }
}

fn web_app_keyboard(label: &str, url: &str) -> Value {
    json!({
        "inline_keyboard": [[{
            "text": label,
            "web_app": { "url": url }
        }]]
    })
}

fn callback_keyboard(buttons: Vec<(&str, String)>, web_app: Option<(&str, String)>) -> Value {
    let mut rows = vec![buttons
        .into_iter()
        .map(|(text, callback_data)| json!({ "text": text, "callback_data": callback_data }))
        .collect::<Vec<_>>()];
    if let Some((text, url)) = web_app {
        rows.push(vec![json!({ "text": text, "web_app": { "url": url } })]);
    }
    json!({ "inline_keyboard": rows })
}

fn parse_callback_data(data: &str) -> Option<(&str, &str, &str)> {
    let mut parts = data.split(':');
    Some((parts.next()?, parts.next()?, parts.next()?))
}

async fn send_message(
    client: &reqwest::Client,
    bot_token: &str,
    chat_id: i64,
    text: &str,
    reply_markup: Option<Value>,
) -> anyhow::Result<()> {
    let mut body = json!({
        "chat_id": chat_id,
        "text": text,
    });
    if let Some(reply_markup) = reply_markup {
        body["reply_markup"] = reply_markup;
    }
    client
        .post(format!("https://api.telegram.org/bot{bot_token}/sendMessage"))
        .json(&body)
        .send()
        .await?;
    Ok(())
}

async fn answer_callback_query(client: &reqwest::Client, bot_token: &str, callback: &Value, text: Option<&str>) {
    let Some(callback_query_id) = callback.get("id").and_then(Value::as_str) else {
        return;
    };
    let mut body = json!({ "callback_query_id": callback_query_id });
    if let Some(text) = text {
        body["text"] = Value::String(text.to_string());
    }
    let _ = client
        .post(format!("https://api.telegram.org/bot{bot_token}/answerCallbackQuery"))
        .json(&body)
        .send()
        .await;
}

async fn edit_callback_message(client: &reqwest::Client, bot_token: &str, callback: &Value, text: &str) {
    let Some(message) = callback.get("message") else {
        return;
    };
    let Some(chat_id) = message.get("chat").and_then(|v| v.get("id")).and_then(Value::as_i64) else {
        return;
    };
    let Some(message_id) = message.get("message_id").and_then(Value::as_i64) else {
        return;
    };
    let _ = client
        .post(format!("https://api.telegram.org/bot{bot_token}/editMessageText"))
        .json(&json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
        }))
        .send()
        .await;
}

async fn rpc_call(state: &AppState, method: &str, params: Value) -> anyhow::Result<Value> {
    let Some(socket) = state.rpc_socket(method) else {
        anyhow::bail!("RPC handler not registered: {method}");
    };
    let payload = json!({
        "method": method,
        "params": params.to_string(),
    });
    let future = socket
        .timeout(Duration::from_secs(30))
        .emit_with_ack::<_, String>("rpc-request", &payload)?;
    let raw = future.await?;
    Ok(serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!(raw)))
}
