use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::debug;

#[derive(Clone)]
pub struct Embedder {
    client: Client,
    url: String,
    model: String,
}

#[derive(Serialize)]
struct EmbedRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

impl Embedder {
    pub fn new(url: &str, model: &str) -> Self {
        Self {
            client: Client::new(),
            url: url.trim_end_matches('/').to_string(),
            model: model.to_string(),
        }
    }

    /// Generate embeddings for a batch of texts.
    pub async fn embed(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        debug!("Embedding {} texts with {}", texts.len(), self.model);

        let resp = self
            .client
            .post(format!("{}/api/embed", self.url))
            .json(&EmbedRequest {
                model: self.model.clone(),
                input: texts.to_vec(),
            })
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Ollama embed failed ({}): {}", status, body);
        }

        let data: EmbedResponse = resp.json().await?;
        Ok(data.embeddings)
    }

    /// Generate embedding for a single text (for search queries).
    pub async fn embed_query(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let results = self.embed(&[text.to_string()]).await?;
        results
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No embedding returned"))
    }
}
