use crate::types::SyncEvent;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<SyncEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self { tx }
    }

    pub fn publish(&self, event: SyncEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SyncEvent> {
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
