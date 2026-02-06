use crate::config::Config;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct MachineMetadata {
    pub host: String,
    pub platform: String,
    #[serde(rename = "happyCliVersion")]
    pub happy_cli_version: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(rename = "homeDir")]
    pub home_dir: String,
    #[serde(rename = "happyHomeDir")]
    pub happy_home_dir: String,
    #[serde(rename = "happyLibDir")]
    pub happy_lib_dir: String,
}

pub fn build(config: &Config) -> MachineMetadata {
    let host = std::env::var("HAPI_HOSTNAME").unwrap_or_else(|_| {
        gethostname().unwrap_or_else(|| "unknown".to_string())
    });

    let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());

    let happy_lib_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|| "/usr/local/bin".to_string());

    MachineMetadata {
        host,
        platform: "linux".to_string(),
        happy_cli_version: format!("happier/{}", env!("CARGO_PKG_VERSION")),
        display_name: config.machine_name.clone(),
        home_dir,
        happy_home_dir: config.hapi_home.to_string_lossy().to_string(),
        happy_lib_dir,
    }
}

fn gethostname() -> Option<String> {
    let mut buf = [0u8; 256];
    let ret = unsafe { libc_gethostname(buf.as_mut_ptr() as *mut i8, buf.len()) };
    if ret != 0 {
        return None;
    }
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..len].to_vec()).ok()
}

extern "C" {
    #[link_name = "gethostname"]
    fn libc_gethostname(name: *mut i8, len: usize) -> i32;
}
