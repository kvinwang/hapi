use serde::{Deserialize, Serialize};

/// Message from hub sync API
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncMessage {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub content: serde_json::Value,
    pub created_at: i64,
}

/// Session metadata from hub sync API
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncSession {
    pub id: String,
    pub namespace: Option<String>,
    pub metadata: Option<SessionMetadata>,
    pub created_at: i64,
    pub updated_at: i64,
    pub active: bool,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub name: Option<String>,
    pub path: Option<String>,
    pub summary: Option<SummaryText>,
    pub flavor: Option<String>,
    pub machine_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SummaryText {
    pub text: String,
}

/// Hub sync messages response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMessagesResponse {
    pub messages: Vec<SyncMessage>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

/// Hub sync sessions response
#[derive(Debug, Deserialize)]
pub struct SyncSessionsResponse {
    pub sessions: Vec<SyncSession>,
}

/// SSE event from hub
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SseEvent {
    MessageReceived {
        #[serde(rename = "sessionId")]
        session_id: String,
        message: SseMessage,
    },
    SessionUpdated {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    SessionRemoved {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    ConnectionChanged {
        data: serde_json::Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseMessage {
    pub id: String,
    pub seq: Option<i64>,
    pub content: serde_json::Value,
    pub created_at: i64,
}

/// Document stored in Meilisearch
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchDocument {
    pub id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub text: String,
    #[serde(rename = "sessionName")]
    pub session_name: String,
    #[serde(rename = "sessionPath")]
    pub session_path: String,
    #[serde(rename = "sessionFlavor")]
    pub session_flavor: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "_vectors")]
    pub vectors: Vectors,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Vectors {
    pub bge: Vec<f32>,
}

/// Text segment extracted from a message
#[derive(Debug, Clone)]
pub struct TextSegment {
    pub role: String,
    pub text: String,
}

/// A chunk of text ready for embedding
#[derive(Debug, Clone)]
pub struct TextChunk {
    pub message_id: String,
    pub session_id: String,
    pub seq: i64,
    pub created_at: i64,
    pub role: String,
    pub text: String,
    pub chunk_index: usize,
}

/// Search result returned to frontend
#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    pub text: String,
    pub role: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub seq: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub session: SearchHitSession,
    pub score: f64,
    #[serde(rename = "semanticScore", skip_serializing_if = "Option::is_none")]
    pub semantic_score: Option<f64>,
    #[serde(rename = "keywordScore", skip_serializing_if = "Option::is_none")]
    pub keyword_score: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchHitSession {
    pub id: String,
    pub name: String,
    pub path: String,
    pub flavor: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub query: String,
    pub hits: Vec<SearchHit>,
    pub total_hits: usize,
    pub processing_time_ms: u64,
}
