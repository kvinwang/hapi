use anyhow::{Context, Result};
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::OnceLock};

static OWNER_ID_CACHE: OnceLock<Mutex<Option<i64>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
struct OwnerIdFile {
    #[serde(rename = "ownerId")]
    owner_id: i64,
}

pub fn get_or_create_owner_id(data_dir: &Path) -> Result<i64> {
    let cache = OWNER_ID_CACHE.get_or_init(|| Mutex::new(None));
    if let Some(owner_id) = *cache.lock() {
        return Ok(owner_id);
    }

    let path = data_dir.join("owner-id.json");
    let owner_id = if path.exists() {
        let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let parsed: OwnerIdFile =
            serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
        if parsed.owner_id <= 0 {
            anyhow::bail!("invalid ownerId in {}", path.display());
        }
        parsed.owner_id
    } else {
        let owner_id = generate_owner_id();
        let body = serde_json::to_vec_pretty(&OwnerIdFile { owner_id })?;
        fs::write(&path, body).with_context(|| format!("write {}", path.display()))?;
        owner_id
    };

    *cache.lock() = Some(owner_id);
    Ok(owner_id)
}

fn generate_owner_id() -> i64 {
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut value = 0i64;
    for byte in bytes {
        value = (value << 8) + byte as i64;
    }
    value.max(1)
}
