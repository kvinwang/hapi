use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramUser {
    pub id: i64,
    #[serde(default)]
    pub is_bot: Option<bool>,
    #[serde(rename = "first_name", default)]
    pub first_name: Option<String>,
    #[serde(rename = "last_name", default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(rename = "language_code", default)]
    pub language_code: Option<String>,
}

pub enum TelegramInitDataValidation {
    Ok {
        user: TelegramUser,
        auth_date: i64,
        raw: BTreeMap<String, String>,
    },
    Err(&'static str),
}

pub fn validate_telegram_init_data(
    init_data: &str,
    bot_token: &str,
    max_age_seconds: i64,
) -> TelegramInitDataValidation {
    let params = url::form_urlencoded::parse(init_data.as_bytes());
    let mut entries = BTreeMap::new();
    for (key, value) in params {
        entries.insert(key.into_owned(), value.into_owned());
    }

    let Some(hash) = entries.get("hash").cloned() else {
        return TelegramInitDataValidation::Err("Missing hash");
    };
    let Some(auth_date_raw) = entries.get("auth_date") else {
        return TelegramInitDataValidation::Err("Missing or invalid auth_date");
    };
    let Ok(auth_date) = auth_date_raw.parse::<i64>() else {
        return TelegramInitDataValidation::Err("Missing or invalid auth_date");
    };

    let now_seconds = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()) as i64;
    if now_seconds - auth_date > max_age_seconds {
        return TelegramInitDataValidation::Err("initData is too old");
    }

    let data_check_string = entries
        .iter()
        .filter(|(key, _)| key.as_str() != "hash")
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\n");

    let secret_keys = derive_secret_keys(bot_token);
    let is_valid = secret_keys.iter().any(|secret_key| {
        compute_expected_hash_hex(secret_key, &data_check_string)
            .map(|expected| safe_compare_hex(&hash, &expected))
            .unwrap_or(false)
    });
    if !is_valid {
        return TelegramInitDataValidation::Err("Invalid initData signature");
    }

    let Some(user_raw) = entries.get("user") else {
        return TelegramInitDataValidation::Err("Missing user");
    };
    let Ok(user) = serde_json::from_str::<TelegramUser>(user_raw) else {
        return TelegramInitDataValidation::Err("Invalid user JSON");
    };

    TelegramInitDataValidation::Ok {
        user,
        auth_date,
        raw: entries,
    }
}

fn derive_secret_keys(bot_token: &str) -> [Vec<u8>; 3] {
    [
        hmac_digest(b"WebAppData", bot_token.as_bytes()).unwrap_or_default(),
        hmac_digest(bot_token.as_bytes(), b"WebAppData").unwrap_or_default(),
        Sha256::digest(bot_token.as_bytes()).to_vec(),
    ]
}

fn hmac_digest(key: &[u8], data: &[u8]) -> Result<Vec<u8>, hmac::digest::InvalidLength> {
    let mut mac = HmacSha256::new_from_slice(key)?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn compute_expected_hash_hex(secret_key: &[u8], data_check_string: &str) -> Result<String, hmac::digest::InvalidLength> {
    let mut mac = HmacSha256::new_from_slice(secret_key)?;
    mac.update(data_check_string.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn safe_compare_hex(a_hex: &str, b_hex: &str) -> bool {
    let Ok(a) = hex::decode(a_hex) else {
        return false;
    };
    let Ok(b) = hex::decode(b_hex) else {
        return false;
    };
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
