use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug)]
pub struct Config {
    pub api_url: String,
    pub token: String,
    pub machine_id: String,
    pub machine_name: Option<String>,
    pub hapi_home: PathBuf,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(rename = "machineId", skip_serializing_if = "Option::is_none")]
    machine_id: Option<String>,
    #[serde(rename = "cliApiToken", skip_serializing_if = "Option::is_none")]
    cli_api_token: Option<String>,
    #[serde(rename = "apiUrl", skip_serializing_if = "Option::is_none")]
    api_url: Option<String>,
    #[serde(rename = "machineName", skip_serializing_if = "Option::is_none")]
    machine_name: Option<String>,
    // Preserve unknown fields
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn hapi_home() -> PathBuf {
    if let Ok(home) = std::env::var("HAPI_HOME") {
        return PathBuf::from(home);
    }
    // HOME on Unix, USERPROFILE on Windows
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "C:\\".to_string()
            } else {
                "/root".to_string()
            }
        });
    PathBuf::from(home).join(".hapi")
}

fn read_settings(hapi_home: &std::path::Path) -> Settings {
    let path = hapi_home.join("settings.json");
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(content.trim_start_matches('\u{feff}')) {
            Ok(s) => s,
            Err(e) => {
                log::warn!(
                    "Malformed settings.json ({}), using defaults: {e}",
                    path.display()
                );
                Settings::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            log::warn!("Cannot read settings.json ({}): {e}", path.display());
            Settings::default()
        }
    }
}

fn write_settings(
    hapi_home: &PathBuf,
    settings: &Settings,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(hapi_home)?;
    let path = hapi_home.join("settings.json");
    let content = serde_json::to_string_pretty(settings)?;
    fs::write(&path, content)?;
    Ok(())
}

pub fn load() -> Result<Config, Box<dyn std::error::Error>> {
    let hapi_home = hapi_home();
    let mut settings = read_settings(&hapi_home);

    // Resolve API URL: env > settings > default
    let api_url = std::env::var("HAPI_API_URL")
        .ok()
        .or_else(|| settings.api_url.clone())
        .unwrap_or_else(|| "http://localhost:3006".to_string());

    // Resolve token: env > settings > error
    let token = std::env::var("CLI_API_TOKEN")
        .ok()
        .or_else(|| settings.cli_api_token.clone())
        .ok_or("CLI_API_TOKEN not set (env or settings.json)")?;

    // Resolve machine ID: settings > generate new
    let machine_id = match &settings.machine_id {
        Some(id) if !id.is_empty() => id.clone(),
        _ => {
            let id = uuid::Uuid::new_v4().to_string();
            log::info!("Generated new machineId: {}", id);
            settings.machine_id = Some(id.clone());
            write_settings(&hapi_home, &settings)?;
            id
        }
    };

    let machine_name = std::env::var("HAPI_MACHINE_NAME")
        .ok()
        .or_else(|| settings.machine_name.clone());

    Ok(Config {
        api_url,
        token,
        machine_id,
        machine_name,
        hapi_home,
    })
}
