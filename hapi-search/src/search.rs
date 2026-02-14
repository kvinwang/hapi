use crate::embedder::Embedder;
use crate::indexer::Indexer;
use crate::models::{SearchHit, SearchHitSession, SearchResponse};
use std::collections::HashMap;
use tracing::debug;

pub struct SearchService {
    indexer: Indexer,
    embedder: Embedder,
    hapi_url: String,
}

/// A session-grouped result: best hit per session, with boosted score.
struct SessionGroup {
    best_hit: SearchHit,
    /// Number of chunks matched in this session
    chunk_count: usize,
}

impl SearchService {
    pub fn new(indexer: Indexer, embedder: Embedder, hapi_url: &str) -> Self {
        Self {
            indexer,
            embedder,
            hapi_url: hapi_url.trim_end_matches('/').to_string(),
        }
    }

    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> anyhow::Result<SearchResponse> {
        // Generate query embedding
        let vector = self.embedder.embed_query(query).await?;

        // Fetch more results than requested so we can aggregate by session
        let fetch_limit = (limit * 5).max(50).min(200);
        let result = self.indexer.search(query, &vector, fetch_limit, 0).await?;

        debug!(
            "Search '{}': {} hits in {}ms",
            query, result.estimated_total_hits, result.processing_time_ms
        );

        let query_lower = query.to_lowercase();

        // Group by session, keep best hit per session
        let mut groups: HashMap<String, SessionGroup> = HashMap::new();

        for hit in result.hits {
            let session_id = hit
                .result
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let session_name = hit
                .result
                .get("sessionName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let session_path = hit
                .result
                .get("sessionPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let session_flavor = hit
                .result
                .get("sessionFlavor")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let base_score = hit.ranking_score;

            // Boost score if session name semantically relates to query
            let name_boost = compute_name_boost(&session_name, &query_lower);
            let final_score = base_score + name_boost;

            let search_hit = SearchHit {
                text: hit.highlighted_text,
                role: hit
                    .result
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                message_id: hit
                    .result
                    .get("messageId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                seq: hit
                    .result
                    .get("seq")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                created_at: hit
                    .result
                    .get("createdAt")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                session: SearchHitSession {
                    id: session_id.clone(),
                    name: session_name,
                    path: session_path,
                    flavor: session_flavor,
                    url: format!("{}/sessions/{}", self.hapi_url, session_id),
                },
                score: final_score,
            };

            let group = groups
                .entry(session_id)
                .or_insert_with(|| SessionGroup {
                    best_hit: search_hit.clone(),
                    chunk_count: 0,
                });
            group.chunk_count += 1;

            // Keep the highest-scored hit for this session
            if final_score > group.best_hit.score {
                group.best_hit = search_hit;
            }
        }

        // Sort sessions by best score (with boost applied), secondary by chunk count
        let mut session_results: Vec<SessionGroup> = groups.into_values().collect();
        session_results.sort_by(|a, b| {
            b.best_hit
                .score
                .partial_cmp(&a.best_hit.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.chunk_count.cmp(&a.chunk_count))
        });

        // Apply offset/limit on the session-grouped results
        let total = session_results.len();
        let hits: Vec<SearchHit> = session_results
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|g| g.best_hit)
            .collect();

        Ok(SearchResponse {
            query: query.to_string(),
            hits,
            total_hits: total,
            processing_time_ms: result.processing_time_ms,
        })
    }
}

/// Compute a score boost based on how well the session name matches the query.
/// Returns a small boost (0.0 to 0.02) to break ties, not dominate ranking.
fn compute_name_boost(session_name: &str, query_lower: &str) -> f64 {
    if session_name.is_empty() {
        return 0.0;
    }

    let name_lower = session_name.to_lowercase();

    // Split query into words/tokens, filter very short tokens (< 3 bytes)
    let query_tokens: Vec<&str> = query_lower
        .split(|c: char| c.is_whitespace() || c == ',' || c == '、')
        .filter(|t| !t.is_empty() && t.len() > 2)
        .collect();

    if query_tokens.is_empty() {
        return 0.0;
    }

    // Count how many query tokens appear in the session name
    let matched = query_tokens
        .iter()
        .filter(|token| name_lower.contains(**token))
        .count();

    let ratio = matched as f64 / query_tokens.len() as f64;

    // Small boost: 0.0 (no match) to 0.02 (full match)
    // Must be small enough to not override semantic ranking (score diffs ~0.01-0.05)
    ratio * 0.02
}

