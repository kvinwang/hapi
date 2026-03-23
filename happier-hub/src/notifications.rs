use crate::{
    bot::TelegramNotificationChannel,
    push::PushNotificationChannel,
    state::AppState,
    types::{Session, SyncEvent},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::{
    sync::mpsc,
    time::{sleep, Duration},
};

const READY_COOLDOWN_MS: i64 = 5_000;
const PERMISSION_DEBOUNCE_MS: u64 = 500;

#[derive(Default)]
struct NotificationState {
    last_known_requests: HashMap<String, HashSet<String>>,
    permission_generation: HashMap<String, u64>,
    last_ready_notification_at: HashMap<String, i64>,
}

enum InternalTask {
    PermissionDue {
        session_id: String,
        namespace: String,
        generation: u64,
    },
}

struct NotificationChannels {
    telegram: Option<TelegramNotificationChannel>,
    push: Option<PushNotificationChannel>,
}

impl NotificationChannels {
    fn from_state(state: &AppState) -> Self {
        Self {
            telegram: TelegramNotificationChannel::new(state),
            push: PushNotificationChannel::new(state),
        }
    }

    fn is_empty(&self) -> bool {
        self.telegram.is_none() && self.push.is_none()
    }

    async fn send_ready(&self, state: &AppState, session: &Session) {
        if let Some(channel) = &self.telegram {
            if let Err(error) = channel.send_ready(state, session).await {
                tracing::warn!(session_id = %session.id, error = %error, "telegram ready notification failed");
            }
        }
        if let Some(channel) = &self.push {
            if let Err(error) = channel.send_ready(state, session).await {
                tracing::warn!(session_id = %session.id, error = %error, "push ready notification failed");
            }
        }
    }

    async fn send_permission_request(&self, state: &AppState, session: &Session) {
        if let Some(channel) = &self.telegram {
            if let Err(error) = channel.send_permission_request(state, session).await {
                tracing::warn!(session_id = %session.id, error = %error, "telegram permission notification failed");
            }
        }
        if let Some(channel) = &self.push {
            if let Err(error) = channel.send_permission_request(state, session).await {
                tracing::warn!(session_id = %session.id, error = %error, "push permission notification failed");
            }
        }
    }
}

pub fn start_notification_hub(state: Arc<AppState>) {
    let channels = NotificationChannels::from_state(&state);
    if channels.is_empty() {
        return;
    }
    tokio::spawn(run_notification_hub(state, channels));
}

async fn run_notification_hub(state: Arc<AppState>, channels: NotificationChannels) {
    let mut event_rx = state.events.subscribe();
    let (task_tx, mut task_rx) = mpsc::unbounded_channel::<InternalTask>();
    let mut notification_state = NotificationState::default();

    loop {
        tokio::select! {
            event = event_rx.recv() => {
                match event {
                    Ok(event) => handle_sync_event(&state, &channels, &task_tx, &mut notification_state, event).await,
                    Err(error) => {
                        tracing::warn!(error = %error, "notification hub event stream error");
                        sleep(Duration::from_millis(200)).await;
                    }
                }
            }
            Some(task) = task_rx.recv() => {
                handle_internal_task(&state, &channels, &mut notification_state, task).await;
            }
        }
    }
}

async fn handle_sync_event(
    state: &AppState,
    channels: &NotificationChannels,
    task_tx: &mpsc::UnboundedSender<InternalTask>,
    notification_state: &mut NotificationState,
    event: SyncEvent,
) {
    match event {
        SyncEvent::MessageReceived {
            session_id,
            namespace,
            message,
        } => {
            let Some(namespace) = namespace else {
                return;
            };
            if extract_message_event_type(&message.content) != Some("ready") {
                return;
            }
            let Some(session) = state
                .store
                .get_session_by_namespace(&session_id, &namespace)
            else {
                return;
            };
            if !session.active {
                return;
            }
            let now = now_ms();
            let last = notification_state
                .last_ready_notification_at
                .get(&session.id)
                .copied()
                .unwrap_or(0);
            if now - last < READY_COOLDOWN_MS {
                return;
            }
            notification_state
                .last_ready_notification_at
                .insert(session.id.clone(), now);
            channels.send_ready(state, &session).await;
        }
        SyncEvent::SessionAdded {
            session_id,
            namespace,
            ..
        }
        | SyncEvent::SessionUpdated {
            session_id,
            namespace,
            ..
        } => {
            let Some(namespace) = namespace else {
                return;
            };
            let Some(session) = state
                .store
                .get_session_by_namespace(&session_id, &namespace)
            else {
                clear_session_state(notification_state, &session_id);
                return;
            };
            if !session.active {
                clear_session_state(notification_state, &session.id);
                return;
            }

            let request_ids = request_ids(&session);
            let previous = notification_state
                .last_known_requests
                .get(&session.id)
                .cloned()
                .unwrap_or_default();
            let has_new_requests = request_ids
                .iter()
                .any(|request_id| !previous.contains(request_id));
            notification_state
                .last_known_requests
                .insert(session.id.clone(), request_ids);

            if !has_new_requests {
                return;
            }

            let generation = notification_state
                .permission_generation
                .entry(session.id.clone())
                .or_insert(0);
            *generation += 1;
            let generation = *generation;
            let session_id = session.id.clone();
            let namespace = session.namespace.clone();
            let task_tx = task_tx.clone();
            tokio::spawn(async move {
                sleep(Duration::from_millis(PERMISSION_DEBOUNCE_MS)).await;
                let _ = task_tx.send(InternalTask::PermissionDue {
                    session_id,
                    namespace,
                    generation,
                });
            });
        }
        _ => {}
    }
}

async fn handle_internal_task(
    state: &AppState,
    channels: &NotificationChannels,
    notification_state: &mut NotificationState,
    task: InternalTask,
) {
    match task {
        InternalTask::PermissionDue {
            session_id,
            namespace,
            generation,
        } => {
            if notification_state
                .permission_generation
                .get(&session_id)
                .copied()
                != Some(generation)
            {
                return;
            }
            let Some(session) = state
                .store
                .get_session_by_namespace(&session_id, &namespace)
            else {
                clear_session_state(notification_state, &session_id);
                return;
            };
            if !session.active || first_request_id(&session).is_none() {
                return;
            }
            channels.send_permission_request(state, &session).await;
        }
    }
}

fn clear_session_state(notification_state: &mut NotificationState, session_id: &str) {
    notification_state.last_known_requests.remove(session_id);
    notification_state.permission_generation.remove(session_id);
    notification_state
        .last_ready_notification_at
        .remove(session_id);
}

fn request_ids(session: &Session) -> HashSet<String> {
    session
        .agent_state
        .as_ref()
        .and_then(|value| value.get("requests"))
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn extract_message_event_type(content: &Value) -> Option<&str> {
    if let Some(event_type) = content.get("type").and_then(Value::as_str) {
        if event_type == "event" {
            return content.get("data")?.get("type")?.as_str();
        }
    }
    content
        .get("content")
        .and_then(Value::as_object)
        .filter(|inner| inner.get("type").and_then(Value::as_str) == Some("event"))
        .and_then(|inner| inner.get("data"))
        .and_then(|data| data.get("type"))
        .and_then(Value::as_str)
}

pub(crate) fn first_request_id(session: &Session) -> Option<String> {
    session
        .agent_state
        .as_ref()
        .and_then(|value| value.get("requests"))
        .and_then(Value::as_object)
        .and_then(|map| map.keys().next().cloned())
}

pub(crate) fn get_session_name(session: &Session) -> String {
    session
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|metadata| {
            metadata
                .get("name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            session
                .metadata
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("summary"))
                .and_then(|summary| summary.get("text"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            session
                .metadata
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("path").and_then(Value::as_str))
                .and_then(|path| {
                    path.split('/')
                        .filter(|part| !part.is_empty())
                        .next_back()
                        .map(ToOwned::to_owned)
                })
        })
        .unwrap_or_else(|| session.id[..session.id.len().min(8)].to_string())
}

pub(crate) fn get_agent_name(session: &Session) -> &'static str {
    match session
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("flavor"))
        .and_then(Value::as_str)
    {
        Some("claude") => "Claude",
        Some("codex") => "Codex",
        Some("gemini") => "Gemini",
        Some("opencode") => "OpenCode",
        _ => "Agent",
    }
}

pub(crate) fn build_miniapp_deep_link(base_url: &str, start_param: &str) -> String {
    match url::Url::parse(base_url) {
        Ok(mut url) => {
            url.query_pairs_mut().append_pair("startapp", start_param);
            url.to_string()
        }
        Err(_) => {
            let sep = if base_url.contains('?') { '&' } else { '?' };
            let encoded: String =
                url::form_urlencoded::byte_serialize(start_param.as_bytes()).collect();
            format!("{base_url}{sep}startapp={encoded}")
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
