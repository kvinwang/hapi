mod config;
mod connection;
mod metadata;
mod register;
mod socket;
mod tunnel;

use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::mpsc;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    if let Err(e) = run().await {
        log::error!("Fatal: {}", e);
        std::process::exit(1);
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

    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
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
                    _ = sigint.recv() => { log::info!("Received SIGINT"); return Ok(()); }
                    _ = sigterm.recv() => { log::info!("Received SIGTERM"); return Ok(()); }
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };
        log::info!("Socket.IO connected to {}/cli", config.api_url);

        // Emit initial state
        if let Err(e) = connection::emit_initial_state(&client, &config.machine_id).await {
            log::warn!("Failed to emit initial state: {} — reconnecting", e);
            let _ = client.disconnect().await;
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
        let tunnel_handle = tokio::spawn(tunnel::run(event_rx, t_client, t_mid));

        // Wait for disconnect or signal
        tokio::select! {
            _ = tunnel_handle => {
                // tunnel::run exited → socket disconnected
                log::warn!("Disconnected — reconnecting in {:?}", backoff);
                keepalive_handle.abort();
            }
            _ = sigint.recv() => {
                log::info!("Received SIGINT");
                keepalive_handle.abort();
                let _ = client.disconnect().await;
                log::info!("Goodbye");
                return Ok(());
            }
            _ = sigterm.recv() => {
                log::info!("Received SIGTERM");
                keepalive_handle.abort();
                let _ = client.disconnect().await;
                log::info!("Goodbye");
                return Ok(());
            }
        }

        // Brief pause before reconnect
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {},
            _ = sigint.recv() => { log::info!("Received SIGINT"); return Ok(()); }
            _ = sigterm.recv() => { log::info!("Received SIGTERM"); return Ok(()); }
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}
