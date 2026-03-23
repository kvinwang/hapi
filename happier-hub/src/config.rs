use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use figment::{
    providers::{Format, Json},
    Figment,
};
use p256::{elliptic_curve::rand_core::OsRng, SecretKey};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use web_push::VapidSignatureBuilder;

#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub listen_host: String,
    pub listen_port: u16,
    pub public_url: String,
    pub cli_api_token: String,
    pub cors_origins: Vec<String>,
    pub vapid_public_key: String,
    pub vapid_private_key: String,
    pub vapid_subject: String,
    pub telegram_bot_token: Option<String>,
    pub telegram_enabled: bool,
}

#[derive(Debug, Deserialize, Default)]
struct SettingsFile {
    #[serde(rename = "listenHost")]
    listen_host: Option<String>,
    #[serde(rename = "listenPort")]
    listen_port: Option<u16>,
    #[serde(rename = "publicUrl")]
    public_url: Option<String>,
    #[serde(rename = "corsOrigins")]
    cors_origins: Option<Vec<String>>,
    #[serde(rename = "cliApiToken")]
    cli_api_token: Option<String>,
    #[serde(rename = "telegramBotToken")]
    telegram_bot_token: Option<String>,
    #[serde(rename = "vapidKeys")]
    vapid_keys: Option<SettingsVapidKeys>,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct SettingsVapidKeys {
    #[serde(rename = "publicKey")]
    public_key: Option<String>,
    #[serde(rename = "privateKey")]
    private_key: Option<String>,
}

impl Config {
    pub fn load() -> Result<Self> {
        let home = std::env::var("HAPI_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".hapi")
            });
        fs::create_dir_all(&home)
            .with_context(|| format!("create data dir: {}", home.display()))?;

        let settings_path = home.join("settings.json");
        let file_figment = if settings_path.exists() {
            Figment::new().merge(Json::file(&settings_path))
        } else {
            Figment::new()
        };
        let file_settings: SettingsFile = file_figment.extract().unwrap_or_default();

        let listen_host = std::env::var("HAPI_LISTEN_HOST")
            .ok()
            .or(file_settings.listen_host)
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let listen_port = std::env::var("HAPI_LISTEN_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .or(file_settings.listen_port)
            .unwrap_or(3006);
        let public_url = std::env::var("HAPI_PUBLIC_URL")
            .ok()
            .or(file_settings.public_url)
            .unwrap_or_else(|| format!("http://{}:{}", listen_host, listen_port));
        let cors_origins = std::env::var("CORS_ORIGINS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .or(file_settings.cors_origins)
            .unwrap_or_else(|| vec![public_url.clone()]);

        let cli_api_token = std::env::var("CLI_API_TOKEN")
            .ok()
            .or(file_settings.cli_api_token)
            .unwrap_or_else(generate_api_token);

        persist_settings_if_missing(
            &settings_path,
            &listen_host,
            listen_port,
            &public_url,
            &cors_origins,
            &cli_api_token,
        )?;

        let db_path = std::env::var("DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("hapi.db"));
        let env_vapid_public_key = std::env::var("VAPID_PUBLIC_KEY").ok();
        let env_vapid_private_key = std::env::var("VAPID_PRIVATE_KEY").ok();
        let file_vapid = file_settings.vapid_keys.clone().unwrap_or_default();
        let (vapid_public_key, vapid_private_key) =
            match (env_vapid_public_key.clone(), env_vapid_private_key.clone()) {
                (Some(public_key), Some(private_key)) => (public_key, private_key),
                (Some(public_key), None) => (public_key, String::new()),
                (None, Some(private_key)) => {
                    let public_key = derive_vapid_public_key(&private_key).unwrap_or_default();
                    (public_key, private_key)
                }
                (None, None) => match (file_vapid.public_key, file_vapid.private_key) {
                    (Some(public_key), Some(private_key)) => (public_key, private_key),
                    _ => {
                        let generated = generate_vapid_keys()?;
                        persist_vapid_keys(&settings_path, &generated.0, &generated.1)?;
                        generated
                    }
                },
            };
        let vapid_subject = std::env::var("VAPID_SUBJECT")
            .ok()
            .unwrap_or_else(|| "mailto:admin@hapi.run".to_string());
        let telegram_bot_token = std::env::var("TELEGRAM_BOT_TOKEN")
            .ok()
            .or(file_settings.telegram_bot_token);
        let telegram_enabled = telegram_bot_token.is_some();

        Ok(Self {
            data_dir: home,
            db_path,
            listen_host,
            listen_port,
            public_url,
            cli_api_token,
            cors_origins,
            vapid_public_key,
            vapid_private_key,
            vapid_subject,
            telegram_bot_token,
            telegram_enabled,
        })
    }
}

fn generate_api_token() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(43)
        .map(char::from)
        .collect();
    format!("hapi_{suffix}")
}

fn persist_settings_if_missing(
    settings_path: &Path,
    listen_host: &str,
    listen_port: u16,
    public_url: &str,
    cors_origins: &[String],
    cli_api_token: &str,
) -> Result<()> {
    if settings_path.exists() {
        return Ok(());
    }

    let value = serde_json::json!({
        "listenHost": listen_host,
        "listenPort": listen_port,
        "publicUrl": public_url,
        "corsOrigins": cors_origins,
        "cliApiToken": cli_api_token,
    });
    fs::write(settings_path, serde_json::to_vec_pretty(&value)?)
        .with_context(|| format!("write settings file: {}", settings_path.display()))?;
    Ok(())
}

fn generate_vapid_keys() -> Result<(String, String)> {
    let secret = SecretKey::random(&mut OsRng);
    let private_key = URL_SAFE_NO_PAD.encode(secret.to_bytes());
    let public_key = derive_vapid_public_key(&private_key)?;
    Ok((public_key, private_key))
}

fn derive_vapid_public_key(private_key: &str) -> Result<String> {
    let builder = VapidSignatureBuilder::from_base64_no_sub(private_key)
        .context("parse VAPID private key")?;
    Ok(URL_SAFE_NO_PAD.encode(builder.get_public_key()))
}

fn persist_vapid_keys(settings_path: &Path, public_key: &str, private_key: &str) -> Result<()> {
    let value = if settings_path.exists() {
        match fs::read_to_string(settings_path) {
            Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                .unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };
    let mut object = value.as_object().cloned().unwrap_or_default();
    object.insert(
        "vapidKeys".to_string(),
        serde_json::json!({
            "publicKey": public_key,
            "privateKey": private_key,
        }),
    );
    fs::write(
        settings_path,
        serde_json::to_vec_pretty(&serde_json::Value::Object(object))?,
    )
    .with_context(|| format!("write settings file: {}", settings_path.display()))?;
    Ok(())
}
