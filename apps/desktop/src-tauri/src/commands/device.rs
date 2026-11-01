//! Device identity.
//!
//! A random id for this device, created on first start and kept in
//! `device.json` in the app data folder. It tells devices apart in the local
//! store (where a session's folder is on each device). It is not derived from
//! the machine (host name, hardware) and never leaves the device.

use std::path::PathBuf;

use serde_json::{json, Value as JsonValue};

fn device_file() -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support"))
            .unwrap_or_else(|_| PathBuf::from("."))
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|_| PathBuf::from("."))
    };
    base.join(crate::APP_DIR_NAME).join("device.json")
}

/// The device id, created on first call.
pub fn get_or_create_device_id() -> String {
    device_id_at(&device_file())
}

fn device_id_at(path: &std::path::Path) -> String {
    let stored: JsonValue = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if let Some(id) = stored
        .get("device_id")
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
    {
        return id.to_string();
    }
    let mut bytes = [0u8; 32];
    let _ = getrandom::fill(&mut bytes);
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, json!({ "device_id": id }).to_string());
    id
}

/// device:get-id, for the web UI.
#[tauri::command]
pub fn access_control_get_device_id() -> Result<String, String> {
    Ok(get_or_create_device_id())
}

#[cfg(test)]
mod tests {
    #[test]
    fn id_is_random_hex_and_stable() {
        let path = std::env::temp_dir()
            .join(format!("promptops-device-{}", crate::local_store::new_id()))
            .join("device.json");
        let a = super::device_id_at(&path);
        let b = super::device_id_at(&path);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
