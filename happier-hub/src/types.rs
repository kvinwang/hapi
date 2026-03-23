use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

pub type Permission = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataSummary {
    pub text: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Metadata {
    pub path: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<MetadataSummary>,
    #[serde(rename = "machineId", skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    #[serde(rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(rename = "modelMode", skip_serializing_if = "Option::is_none")]
    pub model_mode: Option<String>,

    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentState {
    #[serde(rename = "controlledByUser", skip_serializing_if = "Option::is_none")]
    pub controlled_by_user: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<serde_json::Map<String, Value>>,
    #[serde(rename = "completedRequests", skip_serializing_if = "Option::is_none")]
    pub completed_requests: Option<serde_json::Map<String, Value>>,

    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    #[serde(rename = "parentSessionId")]
    pub parent_session_id: Option<String>,
    pub namespace: String,
    pub seq: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub active: bool,
    #[serde(rename = "activeAt")]
    pub active_at: i64,
    pub metadata: Option<Value>,
    #[serde(rename = "metadataVersion")]
    pub metadata_version: i64,
    #[serde(rename = "agentState")]
    pub agent_state: Option<Value>,
    #[serde(rename = "agentStateVersion")]
    pub agent_state_version: i64,
    pub thinking: bool,
    #[serde(rename = "thinkingAt")]
    pub thinking_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todos: Option<Value>,
    #[serde(rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(rename = "modelMode", skip_serializing_if = "Option::is_none")]
    pub model_mode: Option<String>,
    #[serde(rename = "shareToken", skip_serializing_if = "Option::is_none")]
    pub share_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummaryMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub path: String,
    #[serde(rename = "machineId", skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    #[serde(rename = "parentSessionId")]
    pub parent_session_id: Option<String>,
    pub active: bool,
    pub thinking: bool,
    #[serde(rename = "activeAt")]
    pub active_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub metadata: Option<SessionSummaryMetadata>,
    #[serde(rename = "todoProgress")]
    pub todo_progress: Option<Value>,
    #[serde(rename = "pendingRequestsCount")]
    pub pending_requests_count: usize,
    #[serde(rename = "modelMode", skip_serializing_if = "Option::is_none")]
    pub model_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Machine {
    pub id: String,
    pub namespace: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub metadata: Option<Value>,
    #[serde(rename = "metadataVersion")]
    pub metadata_version: i64,
    #[serde(rename = "runnerState")]
    pub runner_state: Option<Value>,
    #[serde(rename = "runnerStateVersion")]
    pub runner_state_version: i64,
    pub active: bool,
    #[serde(rename = "activeAt")]
    pub active_at: i64,
    pub seq: i64,
    #[serde(rename = "apiKeyId", skip_serializing_if = "Option::is_none")]
    pub api_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedMessage {
    pub id: String,
    pub seq: Option<i64>,
    #[serde(rename = "localId")]
    pub local_id: Option<String>,
    pub content: Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncEvent {
    #[serde(rename = "session-added")]
    SessionAdded {
        #[serde(rename = "sessionId")]
        session_id: String,
        namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    #[serde(rename = "session-updated")]
    SessionUpdated {
        #[serde(rename = "sessionId")]
        session_id: String,
        namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    #[serde(rename = "message-received")]
    MessageReceived {
        #[serde(rename = "sessionId")]
        session_id: String,
        namespace: Option<String>,
        message: DecryptedMessage,
    },
    #[serde(rename = "machine-updated")]
    MachineUpdated {
        #[serde(rename = "machineId")]
        machine_id: String,
        namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    #[serde(rename = "connection-changed")]
    ConnectionChanged {
        namespace: Option<String>,
        data: ConnectionChangedData,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionChangedData {
    pub status: String,
    #[serde(rename = "subscriptionId", skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketUpdate {
    pub id: String,
    pub seq: i64,
    pub body: Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

impl Session {
    pub fn to_summary(&self) -> SessionSummary {
        let pending_requests_count = self
            .agent_state
            .as_ref()
            .and_then(|state| state.get("requests"))
            .and_then(|value| value.as_object())
            .map(|value| value.len())
            .unwrap_or(0);

        let metadata = self.metadata.as_ref().and_then(|value| {
            let object = value.as_object()?;
            let path = object.get("path")?.as_str()?.to_string();
            Some(SessionSummaryMetadata {
                name: object
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned),
                path,
                machine_id: object
                    .get("machineId")
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned),
                summary: object.get("summary").cloned(),
                flavor: object
                    .get("flavor")
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned),
            })
        });

        Self::summary_from(self, metadata, pending_requests_count)
    }

    fn summary_from(
        session: &Session,
        metadata: Option<SessionSummaryMetadata>,
        pending_requests_count: usize,
    ) -> SessionSummary {
        SessionSummary {
            id: session.id.clone(),
            parent_session_id: session.parent_session_id.clone(),
            active: session.active,
            thinking: session.thinking,
            active_at: session.active_at,
            updated_at: session.updated_at,
            metadata,
            todo_progress: None,
            pending_requests_count,
            model_mode: session.model_mode.clone(),
            pinned: None,
            tags: None,
        }
    }
}
