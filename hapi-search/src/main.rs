mod chunker;
mod config;
mod embedder;
mod hub_client;
mod indexer;
mod models;
mod search;
mod state;
mod syncer;
mod text_extract;
mod web;

use clap::Parser;
use config::{Cli, Config};
use embedder::Embedder;
use hub_client::HubClient;
use indexer::Indexer;
use search::SearchService;
use state::SyncState;
use std::sync::Arc;
use syncer::Syncer;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    // Load config
    let config_str = std::fs::read_to_string(&cli.config).unwrap_or_else(|e| {
        eprintln!(
            "Warning: could not read config file {:?}: {e}. Using defaults.",
            cli.config
        );
        String::new()
    });

    let config: Config = if config_str.is_empty() {
        toml::from_str("[hub]\nurl = \"http://localhost:3006\"\napi_key = \"\"").expect("default config parse")
    } else {
        toml::from_str(&config_str)?
    };

    info!("hapi-search starting");
    info!("  Hub URL: {}", config.hub.url);
    info!("  Meilisearch: {}", config.meilisearch.url);
    info!("  Ollama: {} ({})", config.ollama.url, config.ollama.model);
    info!("  Listen: {}", config.search.listen);
    info!("  HAPI URL: {}", config.hapi_url());

    // Initialize components
    let hub = HubClient::new(&config.hub.url, &config.hub.api_key);
    let embedder = Embedder::new(&config.ollama.url, &config.ollama.model);
    let indexer = Indexer::new(
        &config.meilisearch.url,
        config.meilisearch.api_key.as_deref(),
    );
    let sync_state = SyncState::open(&config.search.state_db)?;
    let hapi_url = config.hapi_url().to_string();

    // Create search service (shares embedder and indexer)
    let search_service = SearchService::new(indexer.clone(), embedder.clone(), &hapi_url);

    let app_state = Arc::new(web::AppState {
        search: search_service,
        indexer: indexer.clone(),
    });

    // Start web server
    let listen_addr = config.search.listen.clone();
    let router = web::create_router(app_state);

    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    info!("Web server listening on {listen_addr}");

    let server = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            error!("Web server error: {e}");
        }
    });

    // Start syncer
    let syncer = Syncer::new(hub, embedder, indexer, sync_state, &hapi_url);

    let sync = tokio::spawn(async move {
        if let Err(e) = syncer.run().await {
            error!("Syncer error: {e}");
        }
    });

    // Wait for either to finish (or ctrl+c)
    tokio::select! {
        _ = server => {
            info!("Web server stopped");
        }
        _ = sync => {
            info!("Syncer stopped");
        }
        _ = tokio::signal::ctrl_c() => {
            info!("Shutting down...");
        }
    }

    Ok(())
}
