use crate::{
    notifications::{build_miniapp_deep_link, first_request_id, get_agent_name, get_session_name},
    state::AppState,
    store::StoredPushSubscription,
    types::Session,
};
use serde_json::{json, Value};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushMessageBuilder,
};

#[derive(Clone)]
pub(crate) struct PushNotificationChannel {
    client: IsahcWebPushClient,
}

impl PushNotificationChannel {
    pub(crate) fn new(state: &AppState) -> Option<Self> {
        if state.config.vapid_private_key.is_empty() {
            tracing::warn!("push notifications disabled: missing VAPID private key");
            return None;
        }
        match IsahcWebPushClient::new() {
            Ok(client) => Some(Self { client }),
            Err(error) => {
                tracing::warn!(error = %error, "push notifications disabled: client init failed");
                None
            }
        }
    }

    pub(crate) async fn send_permission_request(
        &self,
        state: &AppState,
        session: &Session,
    ) -> anyhow::Result<()> {
        send_permission_request(state, &self.client, session).await
    }

    pub(crate) async fn send_ready(
        &self,
        state: &AppState,
        session: &Session,
    ) -> anyhow::Result<()> {
        send_ready(state, &self.client, session).await
    }
}

async fn send_permission_request(
    state: &AppState,
    client: &IsahcWebPushClient,
    session: &Session,
) -> anyhow::Result<()> {
    let Some(request_id) = first_request_id(session) else {
        return Ok(());
    };
    let payload = json!({
        "title": "Permission Request",
        "body": format!("{} needs approval", get_session_name(session)),
        "tag": format!("permission:{}", session.id),
        "data": {
            "type": "permission",
            "sessionId": session.id,
            "url": build_miniapp_deep_link(&state.config.public_url, &format!("session_{}", session.id)),
            "requestId": request_id,
        }
    });
    send_to_namespace(state, client, &session.namespace, payload).await
}

async fn send_ready(
    state: &AppState,
    client: &IsahcWebPushClient,
    session: &Session,
) -> anyhow::Result<()> {
    if !session.active {
        return Ok(());
    }
    let payload = json!({
        "title": "HAPI",
        "body": format!("It's ready! {} is waiting for your command", get_agent_name(session)),
        "tag": format!("ready:{}", session.id),
        "data": {
            "type": "ready",
            "sessionId": session.id,
            "url": build_miniapp_deep_link(&state.config.public_url, &format!("session_{}", session.id)),
        }
    });
    send_to_namespace(state, client, &session.namespace, payload).await
}

async fn send_to_namespace(
    state: &AppState,
    client: &IsahcWebPushClient,
    namespace: &str,
    payload: Value,
) -> anyhow::Result<()> {
    let subscriptions = state.store.list_push_subscriptions_by_namespace(namespace);
    if subscriptions.is_empty() {
        return Ok(());
    }

    let body = serde_json::to_vec(&payload)?;
    for subscription in subscriptions {
        if let Err(error) = send_to_subscription(state, client, namespace, &subscription, &body).await {
            tracing::warn!(
                namespace = %namespace,
                endpoint = %subscription.endpoint,
                error = %error,
                "push send failed"
            );
        }
    }
    Ok(())
}

async fn send_to_subscription(
    state: &AppState,
    client: &IsahcWebPushClient,
    namespace: &str,
    subscription: &StoredPushSubscription,
    body: &[u8],
) -> anyhow::Result<()> {
    let info = SubscriptionInfo::new(
        subscription.endpoint.clone(),
        subscription.p256dh.clone(),
        subscription.auth.clone(),
    );
    let mut sig_builder = VapidSignatureBuilder::from_base64(&state.config.vapid_private_key, &info)?;
    sig_builder.add_claim("sub", state.config.vapid_subject.clone());
    let signature = sig_builder.build()?;

    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_payload(ContentEncoding::Aes128Gcm, body);
    builder.set_vapid_signature(signature);

    let message = builder.build()?;
    if let Err(error) = client.send(message).await {
        let text = error.to_string();
        if text.contains("410") || text.contains("404") {
            let _ = state.store.remove_push_subscription(namespace, &subscription.endpoint);
        }
        return Err(error.into());
    }
    Ok(())
}
