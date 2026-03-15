mod config;
mod connection;
mod metadata;
mod register;
mod socket;
pub mod ssh_server;
mod tunnel;

use std::time::Duration;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    if let Err(e) = run().await {
        log::error!("Fatal: {}", e);
        std::process::exit(1);
    }
}

/// Wait for a shutdown signal (SIGINT/SIGTERM on Unix, Ctrl+C on Windows).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigint = signal(SignalKind::interrupt()).ok();
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = async { if let Some(s) = sigint.as_mut() { s.recv().await; } else { std::future::pending::<()>().await; } } => {
                log::info!("Received SIGINT");
            }
            _ = async { if let Some(s) = sigterm.as_mut() { s.recv().await; } else { std::future::pending::<()>().await; } } => {
                log::info!("Received SIGTERM");
            }
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = tokio::signal::ctrl_c().await {
            log::error!("Failed to listen for Ctrl+C: {}", e);
            std::future::pending::<()>().await;
        }
        log::info!("Received Ctrl+C");
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = config::load()?;
    log::info!(
        "happier {} starting (machine: {}, api: {})",
        env!("CARGO_PKG_VERSION"),
        config.machine_id,
        config.api_url
    );

    let metadata = metadata::build(&config);
    log::info!(
        "Machine: {} ({})",
        metadata.display_name.as_deref().unwrap_or(&metadata.host),
        metadata.platform
    );

    // Register once at startup
    register::register_machine(&config, &metadata).await?;

    let mut backoff = Duration::from_secs(1);
    const MAX_BACKOFF: Duration = Duration::from_secs(30);

    loop {
        // Connect
        let (event_tx, event_rx) = mpsc::channel(512);
        let client = match connection::connect(&config, event_tx).await {
            Ok(c) => {
                backoff = Duration::from_secs(1); // reset on success
                c
            }
            Err(e) => {
                log::warn!("Connect failed: {} — retrying in {:?}", e, backoff);
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {},
                    _ = shutdown_signal() => { return Ok(()); }
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };
        log::info!("Socket.IO connected to {}/cli", config.api_url);

        // Emit initial state
        if let Err(e) = connection::emit_initial_state(&client, &config.machine_id).await {
            log::warn!("Failed to emit initial state: {} — reconnecting", e);
            if let Err(e) = client.disconnect().await {
                log::debug!("Disconnect error: {}", e);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        // Spawn keep-alive
        let ka_client = client.clone();
        let ka_mid = config.machine_id.clone();
        let keepalive_handle = tokio::spawn(connection::keep_alive(ka_client, ka_mid));

        // Spawn tunnel manager — returns when it receives Disconnected
        let t_client = client.clone();
        let t_mid = config.machine_id.clone();
        let t_api = config.api_url.clone();
        let t_tok = config.token.clone();
        let t_data_dir = config.hapi_home.to_string_lossy().to_string();
        let tunnel_handle = tokio::spawn(tunnel::run(
            event_rx, t_client, t_mid, t_api, t_tok, t_data_dir,
        ));

        // Wait for disconnect or signal
        tokio::select! {
            _ = tunnel_handle => {
                log::warn!("Disconnected — reconnecting in {:?}", backoff);
                keepalive_handle.abort();
            }
            _ = shutdown_signal() => {
                keepalive_handle.abort();
                if let Err(e) = client.disconnect().await {
                    log::debug!("Disconnect error: {}", e);
                }
                log::info!("Goodbye");
                return Ok(());
            }
        }

        // Brief pause before reconnect
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {},
            _ = shutdown_signal() => { return Ok(()); }
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}
