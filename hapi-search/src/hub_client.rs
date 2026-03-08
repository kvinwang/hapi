use crate::models::{SseEvent, SyncMessagesResponse, SyncSession, SyncSessionsResponse};
use reqwest::Client;
use reqwest_eventsource::{Event, EventSource};
use futures::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

#[derive(Deserialize)]
struct AuthResponse {
    token: String,
}

/// Manages a JWT token obtained via API key, with automatic refresh.
struct TokenManager {
    client: Client,
    base_url: String,
    api_key: String,
    /// Current JWT and its obtain time (refresh 1 minute before the 5-min expiry)
    jwt: RwLock<Option<String>>,
    jwt_obtained_at: RwLock<std::time::Instant>,
}

/// JWT is valid for 5 minutes; refresh after 4 minutes to be safe.
const JWT_REFRESH_SECS: u64 = 4 * 60;

impl TokenManager {
    fn new(client: Client, base_url: &str, api_key: &str) -> Self {
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            jwt: RwLock::new(None),
            jwt_obtained_at: RwLock::new(std::time::Instant::now()),
        }
    }

    /// Get a valid JWT, refreshing if needed.
    async fn get_jwt(&self) -> anyhow::Result<String> {
        // Check if we have a valid token
        {
            let jwt = self.jwt.read().await;
            let obtained_at = self.jwt_obtained_at.read().await;
            if let Some(ref token) = *jwt {
                if obtained_at.elapsed().as_secs() < JWT_REFRESH_SECS {
                    return Ok(token.clone());
                }
            }
        }

        // Need to refresh
        self.refresh_jwt().await
    }

    async fn refresh_jwt(&self) -> anyhow::Result<String> {
        debug!("Refreshing JWT via /api/auth");

        let url = format!("{}/api/auth", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "accessToken": self.api_key }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Auth failed ({}): {}", status, body);
        }

        let auth: AuthResponse = resp.json().await?;
        let token = auth.token;

        // Update cached JWT
        {
            let mut jwt = self.jwt.write().await;
            *jwt = Some(token.clone());
            let mut obtained_at = self.jwt_obtained_at.write().await;
            *obtained_at = std::time::Instant::now();
        }

        info!("JWT refreshed successfully");
        Ok(token)
    }

    /// Invalidate the cached JWT so the next get_jwt() call forces a refresh.
    async fn invalidate(&self) {
        let mut jwt = self.jwt.write().await;
        *jwt = None;
    }
}

#[derive(Clone)]
pub struct HubClient {
    client: Client,
    base_url: String,
    token_manager: Arc<TokenManager>,
    /// Cached session metadata, keyed by session id
    sessions: Arc<RwLock<HashMap<String, SyncSession>>>,
}

impl HubClient {
    pub fn new(base_url: &str, api_key: &str) -> Self {
        let client = Client::new();
        let token_manager = Arc::new(TokenManager::new(client.clone(), base_url, api_key));

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            token_manager,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Get a valid JWT for API requests.
    async fn jwt(&self) -> anyhow::Result<String> {
        self.token_manager.get_jwt().await
    }

    /// Make an authenticated GET request, retrying once on 401 with a fresh JWT.
    async fn auth_get(&self, url_without_token: &str) -> anyhow::Result<reqwest::Response> {
        for attempt in 0..2 {
            let token = self.jwt().await?;
            let sep = if url_without_token.contains('?') { "&" } else { "?" };
            let url = format!("{url_without_token}{sep}token={}", urlencoding::encode(&token));

            let resp = self.client.get(&url).send().await?;

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                warn!("Got 401, refreshing JWT and retrying");
                self.token_manager.invalidate().await;
                continue;
            }

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                anyhow::bail!("Hub request failed ({}): {}", status, body);
            }

            return Ok(resp);
        }
        unreachable!()
    }

    /// Fetch messages from hub sync API with cursor-based pagination.
    pub async fn fetch_messages(
        &self,
        since: i64,
        limit: u32,
        cursor: Option<&str>,
    ) -> anyhow::Result<SyncMessagesResponse> {
        let mut url = format!(
            "{}/api/sync/messages?since={since}&limit={limit}",
            self.base_url,
        );
        if let Some(cursor) = cursor {
            url.push_str(&format!("&cursor={}", urlencoding::encode(cursor)));
        }

        debug!("Fetching messages since={since} limit={limit}");

        let resp = self.auth_get(&url).await?;
        Ok(resp.json().await?)
    }

    /// Fetch all session metadata from hub.
    pub async fn fetch_sessions(&self, updated_since: i64) -> anyhow::Result<Vec<SyncSession>> {
        let url = format!(
            "{}/api/sync/sessions?updatedSince={updated_since}",
            self.base_url,
        );

        debug!("Fetching sessions updatedSince={updated_since}");

        let resp = self.auth_get(&url).await?;
        let data: SyncSessionsResponse = resp.json().await?;

        // Update cache
        let mut cache = self.sessions.write().await;
        for session in &data.sessions {
            cache.insert(session.id.clone(), session.clone());
        }

        Ok(data.sessions)
    }

    /// Get cached session metadata by id.
    pub async fn get_session(&self, id: &str) -> Option<SyncSession> {
        self.sessions.read().await.get(id).cloned()
    }

    /// Remove session from cache.
    pub async fn remove_session(&self, id: &str) {
        self.sessions.write().await.remove(id);
    }

    /// Subscribe to hub SSE events.
    /// Automatically reconnects on disconnection and refreshes JWT.
    /// Calls `on_reconnect` after each reconnection (not the first connect)
    /// so the caller can perform catch-up sync for missed messages.
    pub async fn subscribe_events(
        &self,
        mut on_event: impl FnMut(SseEvent) + Send + 'static,
        mut on_reconnect: impl FnMut() + Send + 'static,
    ) -> anyhow::Result<()> {
        let mut first_connect = true;
        loop {
            let token = match self.jwt().await {
                Ok(t) => t,
                Err(e) => {
                    error!("Failed to get JWT for SSE: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };

            let url = format!(
                "{}/api/events?all=true&token={}",
                self.base_url,
                urlencoding::encode(&token)
            );

            info!("Connecting to SSE");

            let mut es = EventSource::get(&url);

            while let Some(event) = es.next().await {
                match event {
                    Ok(Event::Open) => {
                        if first_connect {
                            info!("SSE connected");
                            first_connect = false;
                        } else {
                            info!("SSE reconnected, triggering catch-up");
                            on_reconnect();
                        }
                    }
                    Ok(Event::Message(msg)) => {
                        if msg.data.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<SseEvent>(&msg.data) {
                            Ok(sse_event) => on_event(sse_event),
                            Err(e) => {
                                debug!("Failed to parse SSE event: {e}");
                            }
                        }
                    }
                    Err(reqwest_eventsource::Error::StreamEnded) => {
                        warn!("SSE stream ended, will reconnect");
                        break;
                    }
                    Err(e) => {
                        error!("SSE error: {e}");
                        break;
                    }
                }
            }

            es.close();
            info!("SSE disconnected, reconnecting in 5s...");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }
}
