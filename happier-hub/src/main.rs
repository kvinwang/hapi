mod auth;
mod bot;
mod config;
mod notifications;
mod owner;
mod push;
mod routes;
mod socket;
mod sse;
mod state;
mod store;
mod telegram;
mod types;

use anyhow::{Context, Result};
use axum::Router;
use config::Config;
use socketioxide::SocketIo;
use state::AppState;
use std::{fs, net::SocketAddr, path::PathBuf, sync::Arc};
use store::Store;
use tower_http::{cors::{Any, CorsLayer}, trace::TraceLayer};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let config = Config::load()?;
    let store = Store::open(&config.db_path)?;
    store.seed_legacy_api_key(&config.cli_api_token)?;
    let jwt_secret = load_or_create_jwt_secret(&config.data_dir)?;
    let state = Arc::new(AppState::new(config.clone(), store, jwt_secret));
    notifications::start_notification_hub(state.clone());
    if config.telegram_enabled {
        bot::start_telegram_bot(state.clone());
    }

    let (socket_layer, io) = SocketIo::builder().with_state(state.clone()).build_layer();
    socket::configure(&io, state.clone());

    let app = build_app(state).layer(socket_layer);
    let addr: SocketAddr = format!("{}:{}", config.listen_host, config.listen_port)
        .parse()
        .context("invalid listen addr")?;

    info!(addr = %addr, public_url = %config.public_url, "happier-hub starting");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_app(state: Arc<AppState>) -> Router {
    let cors = if state.config.cors_origins.iter().any(|origin| origin == "*") {
        CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any)
    } else {
        let mut layer = CorsLayer::new();
        for origin in &state.config.cors_origins {
            if let Ok(value) = axum::http::HeaderValue::from_str(origin) {
                layer = layer.allow_origin(value);
            }
        }
        layer.allow_headers(Any).allow_methods(Any)
    };

    routes::router(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
}

fn load_or_create_jwt_secret(data_dir: &PathBuf) -> Result<Vec<u8>> {
    let path = data_dir.join("jwt-secret");
    if path.exists() {
        return Ok(fs::read(path)?);
    }
    let secret = uuid::Uuid::new_v4().to_string().into_bytes();
    fs::write(&path, &secret)?;
    Ok(secret)
}
