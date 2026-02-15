use crate::models::SearchDocument;
use reqwest::Client;
use serde::Deserialize;
use tracing::{debug, info};

const INDEX_NAME: &str = "hapi-messages";

#[derive(Clone)]
pub struct Indexer {
    client: Client,
    base_url: String,
    api_key: Option<String>,
}

impl Indexer {
    pub fn new(url: &str, api_key: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            base_url: url.trim_end_matches('/').to_string(),
            api_key: api_key.map(|s| s.to_string()),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.client.request(method, &url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        req.header("Content-Type", "application/json")
    }

    /// Initialize the Meilisearch index with proper settings.
    pub async fn init_index(&self) -> anyhow::Result<()> {
        info!("Initializing Meilisearch index '{INDEX_NAME}'");

        // Enable vector store experimental feature
        let resp = self
            .request(reqwest::Method::PATCH, "/experimental-features")
            .json(&serde_json::json!({ "vectorStore": true }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to enable vector store: {}", body);
        }
        info!("Vector store enabled");

        // Create index
        let resp = self
            .request(reqwest::Method::POST, "/indexes")
            .json(&serde_json::json!({
                "uid": INDEX_NAME,
                "primaryKey": "id"
            }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 202 && status != 200 {
            let body = resp.text().await.unwrap_or_default();
            // Index already exists is fine
            if !body.contains("already_exists") {
                anyhow::bail!("Failed to create index ({}): {}", status, body);
            }
        }

        // Wait for index creation task to complete
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        // Configure settings including embedder for hybrid search
        let resp = self
            .request(
                reqwest::Method::PATCH,
                &format!("/indexes/{INDEX_NAME}/settings"),
            )
            .json(&serde_json::json!({
                "searchableAttributes": ["text", "sessionName", "sessionPath"],
                "filterableAttributes": ["sessionId", "role", "sessionFlavor"],
                "sortableAttributes": ["createdAt"],
                "localizedAttributes": [
                    {
                        "attributePatterns": ["text", "sessionName", "sessionPath"],
                        "locales": ["cmn", "eng"]
                    }
                ],
                "embedders": {
                    "bge": {
                        "source": "userProvided",
                        "dimensions": 1024
                    }
                }
            }))
            .send()
            .await?;

        if !resp.status().is_success() && resp.status().as_u16() != 202 {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to configure index settings: {}", body);
        }

        info!("Meilisearch index configured");
        Ok(())
    }

    /// Add or update documents in the index.
    pub async fn add_documents(&self, documents: &[SearchDocument]) -> anyhow::Result<()> {
        if documents.is_empty() {
            return Ok(());
        }

        debug!("Indexing {} documents", documents.len());

        let resp = self
            .request(
                reqwest::Method::POST,
                &format!("/indexes/{INDEX_NAME}/documents"),
            )
            .json(documents)
            .send()
            .await?;

        if !resp.status().is_success() && resp.status().as_u16() != 202 {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to add documents: {}", body);
        }

        Ok(())
    }

    /// Delete all documents for a given session.
    pub async fn delete_session_documents(&self, session_id: &str) -> anyhow::Result<()> {
        info!("Deleting documents for session {session_id}");

        let resp = self
            .request(
                reqwest::Method::POST,
                &format!("/indexes/{INDEX_NAME}/documents/delete"),
            )
            .json(&serde_json::json!({
                "filter": format!("sessionId = \"{}\"", session_id)
            }))
            .send()
            .await?;

        if !resp.status().is_success() && resp.status().as_u16() != 202 {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to delete documents: {}", body);
        }

        Ok(())
    }

    /// Search the index with hybrid (keyword + vector) search.
    pub async fn search(
        &self,
        query: &str,
        vector: &[f32],
        limit: usize,
        offset: usize,
    ) -> anyhow::Result<MeiliSearchResult> {
        debug!("Searching with vector len={}, first 3 values: {:?}", vector.len(), &vector[..3.min(vector.len())]);
        let body = serde_json::json!({
            "q": query,
            "limit": limit,
            "offset": offset,
            "showRankingScore": true,
            "showRankingScoreDetails": true,
            "attributesToHighlight": ["text"],
            "highlightPreTag": "<mark>",
            "highlightPostTag": "</mark>",
            "hybrid": {
                "semanticRatio": 0.9,
                "embedder": "bge"
            },
            "vector": vector
        });

        let resp = self
            .request(
                reqwest::Method::POST,
                &format!("/indexes/{INDEX_NAME}/search"),
            )
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Meilisearch search failed: {}", body);
        }

        let data: MeiliRawSearchResponse = resp.json().await?;

        let hits: Vec<MeiliHit> = data
            .hits
            .into_iter()
            .map(|hit| {
                let highlighted_text = hit
                    .formatted
                    .as_ref()
                    .and_then(|f| f.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // _rankingScoreDetails gets swallowed by #[serde(flatten)] into source
                let details = hit.source.get("_rankingScoreDetails");

                let semantic_score = details
                    .and_then(|d| d.get("vectorSort"))
                    .and_then(|v| v.get("similarity"))
                    .and_then(|v| v.as_f64());

                // In hybrid mode with high semanticRatio, Meilisearch only returns
                // vectorSort details. keyword_score is not available separately.
                let keyword_score = details
                    .and_then(|d| d.get("words"))
                    .and_then(|w| w.get("score"))
                    .and_then(|v| v.as_f64());

                MeiliHit {
                    result: hit.source,
                    highlighted_text,
                    ranking_score: hit.ranking_score.unwrap_or(0.0),
                    semantic_score,
                    keyword_score,
                }
            })
            .collect();

        Ok(MeiliSearchResult {
            hits,
            estimated_total_hits: data.estimated_total_hits.unwrap_or(0),
            processing_time_ms: data.processing_time_ms,
        })
    }

    /// Get index stats (document count).
    pub async fn get_stats(&self) -> anyhow::Result<IndexStats> {
        let resp = self
            .request(
                reqwest::Method::GET,
                &format!("/indexes/{INDEX_NAME}/stats"),
            )
            .send()
            .await?;

        if !resp.status().is_success() {
            return Ok(IndexStats {
                number_of_documents: 0,
            });
        }

        let data: serde_json::Value = resp.json().await?;
        let count = data
            .get("numberOfDocuments")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;

        Ok(IndexStats {
            number_of_documents: count,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeiliRawSearchResponse {
    hits: Vec<MeiliRawHit>,
    estimated_total_hits: Option<usize>,
    processing_time_ms: u64,
}

#[derive(Deserialize)]
struct MeiliRawHit {
    #[serde(flatten)]
    source: serde_json::Value,
    #[serde(rename = "_formatted")]
    formatted: Option<serde_json::Value>,
    #[serde(rename = "_rankingScore")]
    ranking_score: Option<f64>,
}

pub struct MeiliSearchResult {
    pub hits: Vec<MeiliHit>,
    pub estimated_total_hits: usize,
    pub processing_time_ms: u64,
}

pub struct MeiliHit {
    pub result: serde_json::Value,
    pub highlighted_text: String,
    pub ranking_score: f64,
    pub semantic_score: Option<f64>,
    pub keyword_score: Option<f64>,
}

pub struct IndexStats {
    pub number_of_documents: usize,
}
