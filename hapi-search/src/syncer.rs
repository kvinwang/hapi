use crate::chunker::{chunk_messages, MessageInfo};
use crate::embedder::Embedder;
use crate::hub_client::HubClient;
use crate::indexer::Indexer;
use crate::models::{SearchDocument, SseEvent, SyncMessage, Vectors};
use crate::state::SyncState;
use crate::text_extract::extract_text;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

const BATCH_SIZE: u32 = 500;
const EMBED_BATCH_SIZE: usize = 32;

pub struct Syncer {
    hub: HubClient,
    embedder: Embedder,
    indexer: Indexer,
    state: SyncState,
    hapi_url: String,
}

impl Syncer {
    pub fn new(
        hub: HubClient,
        embedder: Embedder,
        indexer: Indexer,
        state: SyncState,
        hapi_url: &str,
    ) -> Self {
        Self {
            hub,
            embedder,
            indexer,
            state,
            hapi_url: hapi_url.trim_end_matches('/').to_string(),
        }
    }

    /// Run the full sync pipeline: initial sync + SSE real-time.
    pub async fn run(self) -> anyhow::Result<()> {
        // Init meilisearch index
        self.indexer.init_index().await?;

        // Load sessions cache BEFORE syncing messages so session names are available
        self.hub.fetch_sessions(0).await?;

        // Full sync
        self.initial_sync().await?;

        // Real-time sync via SSE
        self.realtime_sync().await
    }

    /// Initial sync: paginate through all messages since last cursor.
    async fn initial_sync(&self) -> anyhow::Result<()> {
        let since = self.state.get_last_sync_ts();
        let mut cursor = self.state.get_cursor();
        let mut total_indexed = 0usize;

        info!("Starting initial sync (since={since}, cursor={cursor:?})");

        loop {
            let resp = self
                .hub
                .fetch_messages(since, BATCH_SIZE, cursor.as_deref())
                .await?;

            let count = resp.messages.len();
            if count == 0 {
                break;
            }

            info!("Fetched {count} messages");
            self.process_messages(&resp.messages).await?;
            total_indexed += count;

            // Update sync state
            if let Some(last) = resp.messages.last() {
                self.state.set_last_sync_ts(last.created_at)?;
            }

            if let Some(ref c) = resp.cursor {
                self.state.set_cursor(c)?;
                cursor = Some(c.clone());
            }

            if !resp.has_more {
                break;
            }
        }

        info!("Initial sync complete: indexed {total_indexed} messages");
        Ok(())
    }

    /// Process a batch of messages: extract text → group by session → chunk → embed → index.
    async fn process_messages(&self, messages: &[SyncMessage]) -> anyhow::Result<()> {
        // Group messages by session, preserving order within each session
        let mut session_msgs: HashMap<String, Vec<MessageInfo>> = HashMap::new();
        let mut session_order: Vec<String> = Vec::new();

        for msg in messages {
            let segments = extract_text(&msg.content);
            if segments.is_empty() {
                continue;
            }

            if !session_msgs.contains_key(&msg.session_id) {
                session_order.push(msg.session_id.clone());
            }

            session_msgs
                .entry(msg.session_id.clone())
                .or_default()
                .push(MessageInfo {
                    message_id: msg.id.clone(),
                    session_id: msg.session_id.clone(),
                    seq: msg.seq,
                    created_at: msg.created_at,
                    segments,
                });
        }

        // Chunk each session's messages together
        let mut all_chunks = Vec::new();
        for session_id in &session_order {
            if let Some(msgs) = session_msgs.get(session_id) {
                all_chunks.extend(chunk_messages(msgs));
            }
        }

        if all_chunks.is_empty() {
            return Ok(());
        }

        debug!("Processing {} chunks", all_chunks.len());

        // Batch embed
        // Pre-resolve session metadata for all chunks
        struct ChunkMeta {
            session_name: String,
            session_path: String,
            session_flavor: String,
        }
        let mut chunk_metas = Vec::with_capacity(all_chunks.len());
        for chunk in &all_chunks {
            let session = self.hub.get_session(&chunk.session_id).await;
            let metadata = session.as_ref().and_then(|s| s.metadata.as_ref());

            let session_name = metadata
                .and_then(|m| {
                    m.name
                        .as_deref()
                        .or(m.summary.as_ref().map(|s| s.text.as_str()))
                })
                .unwrap_or("")
                .to_string();

            let session_path = metadata
                .and_then(|m| m.path.as_deref())
                .unwrap_or("")
                .to_string();

            let session_flavor = metadata
                .and_then(|m| m.flavor.as_deref())
                .unwrap_or("")
                .to_string();

            chunk_metas.push(ChunkMeta {
                session_name,
                session_path,
                session_flavor,
            });
        }

        for batch_start in (0..all_chunks.len()).step_by(EMBED_BATCH_SIZE) {
            let batch_end = (batch_start + EMBED_BATCH_SIZE).min(all_chunks.len());

            // Build embedding texts: prepend session name for context
            let texts: Vec<String> = (batch_start..batch_end)
                .map(|i| {
                    let chunk = &all_chunks[i];
                    let meta = &chunk_metas[i];
                    if meta.session_name.is_empty() {
                        chunk.text.clone()
                    } else {
                        format!("[{}] {}", meta.session_name, chunk.text)
                    }
                })
                .collect();

            let embeddings = match self.embedder.embed(&texts).await {
                Ok(e) => e,
                Err(e) => {
                    error!("Embedding failed: {e}");
                    continue;
                }
            };

            let mut documents = Vec::new();
            for (i, embedding) in (batch_start..batch_end).zip(embeddings.into_iter()) {
                let chunk = &all_chunks[i];
                let meta = &chunk_metas[i];

                documents.push(SearchDocument {
                    id: format!("msg_{}_chunk_{}", chunk.message_id, chunk.chunk_index),
                    message_id: chunk.message_id.clone(),
                    session_id: chunk.session_id.clone(),
                    seq: chunk.seq,
                    role: chunk.role.clone(),
                    text: chunk.text.clone(),
                    session_name: meta.session_name.clone(),
                    session_path: meta.session_path.clone(),
                    session_flavor: meta.session_flavor.clone(),
                    created_at: chunk.created_at,
                    vectors: Vectors { bge: embedding },
                });
            }

            self.indexer.add_documents(&documents).await?;
        }

        Ok(())
    }

    /// Real-time sync via SSE.
    async fn realtime_sync(&self) -> anyhow::Result<()> {
        let (tx, mut rx) = mpsc::unbounded_channel::<SseEvent>();

        let hub = self.hub.clone();

        // Spawn SSE listener
        tokio::spawn(async move {
            if let Err(e) = hub.subscribe_events(move |event| {
                let _ = tx.send(event);
            }).await {
                error!("SSE subscription error: {e}");
            }
        });

        info!("Real-time sync started");

        // Process events
        while let Some(event) = rx.recv().await {
            match event {
                SseEvent::MessageReceived { session_id, message } => {
                    debug!("SSE: message-received session={session_id}");
                    let msg = SyncMessage {
                        id: message.id,
                        session_id: session_id.clone(),
                        seq: message.seq.unwrap_or(0),
                        content: message.content,
                        created_at: message.created_at,
                    };
                    if let Err(e) = self.process_messages(&[msg]).await {
                        error!("Failed to process SSE message: {e}");
                    }
                }
                SseEvent::SessionUpdated { session_id } => {
                    debug!("SSE: session-updated {session_id}");
                    // Refresh session cache
                    if let Err(e) = self.hub.fetch_sessions(0).await {
                        warn!("Failed to refresh sessions: {e}");
                    }
                }
                SseEvent::SessionRemoved { session_id } => {
                    info!("SSE: session-removed {session_id}");
                    self.hub.remove_session(&session_id).await;
                    if let Err(e) = self.indexer.delete_session_documents(&session_id).await {
                        error!("Failed to delete session documents: {e}");
                    }
                }
                SseEvent::ConnectionChanged { .. } => {
                    debug!("SSE: connection-changed");
                }
                SseEvent::Unknown => {}
            }
        }

        Ok(())
    }
}
