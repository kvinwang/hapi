use clap::Parser;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "hapi-search", about = "Semantic search service for hapi")]
pub struct Cli {
    /// Path to config file
    #[arg(short, long, default_value = "hapi-search.toml")]
    pub config: PathBuf,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Config {
    pub hub: HubConfig,
    #[serde(default)]
    pub search: SearchConfig,
    #[serde(default)]
    pub meilisearch: MeilisearchConfig,
    #[serde(default)]
    pub ollama: OllamaConfig,
}

#[derive(Deserialize, Debug, Clone)]
pub struct HubConfig {
    pub url: String,
    /// CLI API key (same key used by CLI to connect to hub)
    pub api_key: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SearchConfig {
    #[serde(default = "default_listen")]
    pub listen: String,
    /// Base URL for linking to hapi sessions. Defaults to hub.url
    #[serde(default)]
    pub hapi_url: Option<String>,
    /// Path for local state database
    #[serde(default = "default_state_db")]
    pub state_db: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MeilisearchConfig {
    #[serde(default = "default_meilisearch_url")]
    pub url: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct OllamaConfig {
    #[serde(default = "default_ollama_url")]
    pub url: String,
    #[serde(default = "default_ollama_model")]
    pub model: String,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            listen: default_listen(),
            hapi_url: None,
            state_db: default_state_db(),
        }
    }
}

impl Default for MeilisearchConfig {
    fn default() -> Self {
        Self {
            url: default_meilisearch_url(),
            api_key: None,
        }
    }
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            url: default_ollama_url(),
            model: default_ollama_model(),
        }
    }
}

fn default_listen() -> String {
    "0.0.0.0:7600".to_string()
}

fn default_state_db() -> String {
    "hapi-search-state.db".to_string()
}

fn default_meilisearch_url() -> String {
    "http://localhost:7700".to_string()
}

fn default_ollama_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_ollama_model() -> String {
    "bge-m3".to_string()
}

impl Config {
    pub fn hapi_url(&self) -> &str {
        self.search
            .hapi_url
            .as_deref()
            .unwrap_or(&self.hub.url)
    }
}
