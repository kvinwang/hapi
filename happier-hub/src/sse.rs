use crate::types::SyncEvent;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

/// A published event: the original event plus a pre-serialized JSON string.
/// Wrapped in Arc so broadcast::channel clones a pointer instead of deep-cloning Value trees.
#[derive(Debug, Clone)]
pub struct PublishedEvent {
    pub event: SyncEvent,
    pub json: Arc<String>,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Arc<PublishedEvent>>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self { tx }
    }

    pub fn publish(&self, event: SyncEvent) {
        let json = serde_json::to_string(&event).unwrap_or_default();
        let published = Arc::new(PublishedEvent {
            event,
            json: Arc::new(json),
        });
        let _ = self.tx.send(published);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<PublishedEvent>> {
        self.tx.subscribe()
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisibilityUpdate {
    #[serde(rename = "subscriptionId")]
    pub subscription_id: String,
    pub visibility: String,
}
