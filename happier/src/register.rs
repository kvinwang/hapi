use crate::config::Config;
use crate::metadata::MachineMetadata;
use std::time::Duration;

pub async fn register_machine(
    config: &Config,
    metadata: &MachineMetadata,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;

    let url = format!("{}/cli/machines", config.api_url);
    let body = serde_json::json!({
        "id": config.machine_id,
        "metadata": metadata,
        "runnerState": null,
    });

    let mut delay = Duration::from_secs(1);
    let max_delay = Duration::from_secs(30);
    let max_attempts = 60;

    for attempt in 1..=max_attempts {
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.token))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                log::info!("Machine registered successfully");
                return Ok(());
            }
            Ok(resp) => {
                let status = resp.status();
                let body = match resp.text().await {
                    Ok(t) => t,
                    Err(e) => {
                        log::debug!("Failed to read response body: {e}");
                        String::new()
                    }
                };
                let reason = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["error"].as_str().map(String::from))
                    .unwrap_or(body);
                // Don't retry client errors (4xx) — they won't succeed on retry
                if status.is_client_error() {
                    return Err(format!(
                        "Machine registration failed ({}): {}",
                        status.as_u16(),
                        reason
                    )
                    .into());
                }
                log::warn!(
                    "Machine registration failed (attempt {}/{}): HTTP {} - {}",
                    attempt,
                    max_attempts,
                    status,
                    reason
                );
            }
            Err(e) => {
                log::warn!(
                    "Machine registration failed (attempt {}/{}): {}",
                    attempt,
                    max_attempts,
                    e
                );
            }
        }

        if attempt < max_attempts {
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(max_delay);
        }
    }

    Err("Machine registration failed after max attempts".into())
}
