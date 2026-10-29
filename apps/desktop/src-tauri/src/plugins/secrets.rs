//! Plugin secrets at rest.
//!
//! Each plugin's `secrets.json` file is encrypted with AES-256-GCM. There is a single key per
//! installation, stored in the system keychain (Keychain, Credential Manager, Secret Service):
//! whoever copies the app data folder does not get the tokens, and a process reading the
//! user's files does not find them in plain text. It is the same scheme as "Safe Storage" in browsers.
//!
//! Rules:
//!  - the plugin id is bound to the ciphertext (authenticated data): a file moved into the folder
//!    of another plugin does not open;
//!  - a plain-text file from a previous version is read and encrypted at the first opportunity;
//!  - without a keychain (Linux without Secret Service, dev builds) the file is sealed with the
//!    Session Vault key of the local store (`vault.key`, owner-only), bound to the plugin id like
//!    every other secret of the app; only if the store itself is unavailable does it stay in plain
//!    text with 0600 permissions, and the status says so: never an error that blocks the plugin;
//!  - a keychain that does not respond NEVER causes a new key to be created: the secrets would be lost.

use super::{write_atomic, PluginRuntime};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;

const FILE: &str = "secrets.json";
const FORMAT: &str = "po-secrets-v1";
/// Sealed with the local store's Session Vault key instead of the keychain key.
const VAULT_FORMAT: &str = "po-secrets-vault-v1";
/// Record kind bound into the vault envelope (authenticated data, with the plugin id).
const VAULT_KIND: &str = "plugin-secrets";
// Distinct from the hosted edition's entry: the two apps never share a key.
const KEYCHAIN_SERVICE: &str = "it.promptops.oss.plugin-secrets";
const KEYCHAIN_ACCOUNT: &str = "master-key-v1";

pub type Secrets = BTreeMap<String, String>;
type Nonce = aes_gcm::Nonce<aes_gcm::aead::consts::U12>;

/// Key state for this app launch.
#[derive(Clone)]
pub enum KeyState {
    /// Not yet requested from the keychain.
    Unknown,
    Ready([u8; 32]),
    /// The keychain is missing or not responding: the reason, for the status shown to the user.
    Unavailable(String),
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    format: String,
    nonce: String,
    data: String,
}

/// How a plugin's secrets are stored, for the UI. Never the values.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `keychain` = encrypted with a key in the keychain, `vault` = encrypted with the Session Vault
    /// key in `vault.key` (no keychain), `file` = plain text with strict permissions, `none` = no secrets.
    pub storage: &'static str,
    /// Secrets present but unreadable: the key is gone, they must be re-entered.
    pub lost: bool,
    pub reason: Option<String>,
}

enum OnDisk {
    Missing,
    Plain(Secrets),
    Sealed(Sealed),
    /// Envelope of the local store's vault (see `VAULT_FORMAT`).
    Vault(Vec<u8>),
}

#[derive(Serialize, Deserialize)]
struct VaultSealed {
    format: String,
    envelope: serde_json::Value,
}

/// The local store whose key seals secrets when there is no keychain.
fn vault() -> Option<&'static crate::local_store::LocalStore> {
    #[cfg(test)]
    {
        Some(crate::local_store::init_for_tests())
    }
    #[cfg(not(test))]
    {
        crate::local_store::get()
    }
}

fn seal_vault(
    store: &crate::local_store::LocalStore,
    plugin_id: &str,
    secrets: &Secrets,
) -> Result<Vec<u8>, String> {
    let plain = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
    let envelope = store.seal_blob(VAULT_KIND, plugin_id, &plain)?;
    serde_json::to_vec(&VaultSealed {
        format: VAULT_FORMAT.into(),
        envelope: serde_json::from_slice(&envelope).map_err(|e| e.to_string())?,
    })
    .map_err(|e| e.to_string())
}

fn open_vault(plugin_id: &str, envelope: &[u8]) -> Option<Secrets> {
    let plain = vault()?.open_blob(VAULT_KIND, plugin_id, envelope)?;
    serde_json::from_slice(&plain).ok()
}

fn read_file(rt: &PluginRuntime, plugin_id: &str) -> Result<OnDisk, String> {
    let path = rt.plugin_dir(plugin_id)?.join(FILE);
    let Ok(bytes) = fs::read(path) else {
        return Ok(OnDisk::Missing);
    };
    if let Ok(sealed) = serde_json::from_slice::<Sealed>(&bytes) {
        if sealed.format == FORMAT {
            return Ok(OnDisk::Sealed(sealed));
        }
    }
    if let Ok(v) = serde_json::from_slice::<VaultSealed>(&bytes) {
        if v.format == VAULT_FORMAT {
            return Ok(OnDisk::Vault(
                serde_json::to_vec(&v.envelope).map_err(|e| e.to_string())?,
            ));
        }
    }
    Ok(serde_json::from_slice::<Secrets>(&bytes)
        .map(OnDisk::Plain)
        .unwrap_or(OnDisk::Missing))
}

fn seal(key: &[u8; 32], plugin_id: &str, secrets: &Secrets) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| format!("random numbers unavailable: {e}"))?;
    let plain = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
    let data = Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: plugin_id.as_bytes(),
            },
        )
        .map_err(|_| "secrets encryption failed".to_string())?;
    serde_json::to_vec(&Sealed {
        format: FORMAT.into(),
        nonce: B64.encode(nonce),
        data: B64.encode(data),
    })
    .map_err(|e| e.to_string())
}

fn open(key: &[u8; 32], plugin_id: &str, sealed: &Sealed) -> Option<Secrets> {
    let nonce = B64.decode(&sealed.nonce).ok().filter(|n| n.len() == 12)?;
    let data = B64.decode(&sealed.data).ok()?;
    let plain = Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &data,
                aad: plugin_id.as_bytes(),
            },
        )
        .ok()?;
    serde_json::from_slice(&plain).ok()
}

/// Plugin secrets, for the broker. An unreadable file is a clear error: better to stop the
/// call than to send an unreplaced placeholder.
pub fn load(rt: &PluginRuntime, plugin_id: &str) -> Result<Secrets, String> {
    match read_file(rt, plugin_id)? {
        OnDisk::Missing => Ok(Secrets::new()),
        OnDisk::Plain(secrets) => {
            // File from a previous version: encrypted as soon as a key exists (keychain, else the
            // Session Vault). If that fails it stays as is.
            if !secrets.is_empty() {
                let _ = save(rt, plugin_id, &secrets);
            }
            Ok(secrets)
        }
        OnDisk::Vault(envelope) => open_vault(plugin_id, &envelope).ok_or_else(lost_message),
        OnDisk::Sealed(sealed) => match rt.secret_key(false) {
            KeyState::Ready(key) => open(&key, plugin_id, &sealed).ok_or_else(lost_message),
            KeyState::Unavailable(reason) => Err(format!("this plugin's credentials are in the system keychain, which is not responding right now: {reason}")),
            KeyState::Unknown => Err(lost_message()),
        },
    }
}

fn lost_message() -> String {
    "this plugin's saved credentials can no longer be read: re-enter them in Configure".into()
}

/// Saves the full set. Empty = the file is removed.
pub fn save(rt: &PluginRuntime, plugin_id: &str, secrets: &Secrets) -> Result<(), String> {
    let path = rt.plugin_dir(plugin_id)?.join(FILE);
    if secrets.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    match rt.secret_key(true) {
        KeyState::Ready(key) => write_atomic(&path, &seal(&key, plugin_id, secrets)?, true),
        // Without a keychain: sealed with the Session Vault key, like the app's other secrets.
        _ => save_without_keychain(&path, plugin_id, secrets, vault()),
    }
}

fn save_without_keychain(
    path: &std::path::Path,
    plugin_id: &str,
    secrets: &Secrets,
    store: Option<&crate::local_store::LocalStore>,
) -> Result<(), String> {
    match store.map(|s| seal_vault(s, plugin_id, secrets)) {
        Some(Ok(bytes)) => write_atomic(path, &bytes, true),
        // No local store at all (it failed to open): plain text with strict permissions,
        // and the status tells the user.
        _ => write_atomic(
            path,
            &serde_json::to_vec(secrets).map_err(|e| e.to_string())?,
            true,
        ),
    }
}

/// Starting point when the user saves the configuration: the current secrets, or nothing if
/// they are lost for good. If the keychain is only temporarily silent it refuses: writing
/// now would erase the secrets that cannot be read.
pub fn load_for_update(rt: &PluginRuntime, plugin_id: &str) -> Result<Secrets, String> {
    match load(rt, plugin_id) {
        Ok(secrets) => Ok(secrets),
        Err(e) => match (read_file(rt, plugin_id)?, rt.secret_key(false)) {
            (OnDisk::Sealed(_), KeyState::Unavailable(_)) => Err(e),
            _ => Ok(Secrets::new()),
        },
    }
}

pub fn status(rt: &PluginRuntime, plugin_id: &str) -> Status {
    match read_file(rt, plugin_id) {
        Ok(OnDisk::Sealed(sealed)) => match rt.secret_key(false) {
            KeyState::Ready(key) if open(&key, plugin_id, &sealed).is_some() => Status {
                storage: "keychain",
                lost: false,
                reason: None,
            },
            KeyState::Unavailable(reason) => Status {
                storage: "keychain",
                lost: false,
                reason: Some(reason),
            },
            _ => Status {
                storage: "keychain",
                lost: true,
                reason: None,
            },
        },
        Ok(OnDisk::Vault(envelope)) => Status {
            // When the store's own key lives in the keychain, saying "keychain" is accurate.
            storage: if crate::local_store::key_source() == Some("keychain") {
                "keychain"
            } else {
                "vault"
            },
            lost: open_vault(plugin_id, &envelope).is_none(),
            reason: match rt.secret_key(false) {
                KeyState::Unavailable(reason) => Some(reason),
                _ => None,
            },
        },
        Ok(OnDisk::Plain(s)) if !s.is_empty() => Status {
            storage: "file",
            lost: false,
            reason: match rt.secret_key(false) {
                KeyState::Unavailable(reason) => Some(reason),
                _ => None,
            },
        },
        _ => Status {
            storage: "none",
            lost: false,
            reason: None,
        },
    }
}

impl PluginRuntime {
    /// The key for this launch. `create` = if the keychain responds but the key does not exist, create it.
    /// A keychain that does not respond NEVER causes a key to be created.
    pub fn secret_key(&self, create: bool) -> KeyState {
        let mut state = self.secret_key.lock();
        let retry = matches!(*state, KeyState::Unknown)
            || (create && !matches!(*state, KeyState::Ready(_)));
        if retry {
            *state = keychain::fetch(create);
        }
        state.clone()
    }

    #[cfg(test)]
    pub fn set_secret_key(&self, state: KeyState) {
        *self.secret_key.lock() = state;
    }
}

/// The system keychain. Calls run on their own thread: on Linux the Secret Service
/// goes through D-Bus with a blocking wait, which would panic inside the async runtime.
mod keychain {
    use super::{KeyState, B64, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
    use base64::Engine;

    pub fn fetch(create: bool) -> KeyState {
        if !enabled() {
            return KeyState::Unavailable(
                "this dev build does not use the keychain (PROMPTOPS_PLUGIN_KEYCHAIN=1 to try it)"
                    .into(),
            );
        }
        std::thread::spawn(move || fetch_blocking(create))
            .join()
            .unwrap_or_else(|_| {
                KeyState::Unavailable("the system keychain returned an unexpected error".into())
            })
    }

    /// In a dev build every recompile changes the program signature, and macOS would ask for
    /// the keychain password at every launch. There it is used only on request.
    fn enabled() -> bool {
        if cfg!(test) {
            return false;
        }
        !cfg!(debug_assertions) || std::env::var("PROMPTOPS_PLUGIN_KEYCHAIN").as_deref() == Ok("1")
    }

    fn fetch_blocking(create: bool) -> KeyState {
        let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(entry) => entry,
            Err(e) => return KeyState::Unavailable(e.to_string()),
        };
        match entry.get_password() {
            Ok(stored) => match B64
                .decode(stored.trim())
                .ok()
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
            {
                Some(key) => KeyState::Ready(key),
                None => KeyState::Unavailable("the key in the keychain is not valid".into()),
            },
            Err(keyring::Error::NoEntry) if create => {
                let mut key = [0u8; 32];
                if let Err(e) = getrandom::fill(&mut key) {
                    return KeyState::Unavailable(format!("random numbers unavailable: {e}"));
                }
                match entry.set_password(&B64.encode(key)) {
                    Ok(()) => KeyState::Ready(key),
                    Err(e) => KeyState::Unavailable(e.to_string()),
                }
            }
            Err(keyring::Error::NoEntry) => KeyState::Unknown,
            Err(e) => KeyState::Unavailable(e.to_string()),
        }
    }

    /// Live test on the real keychain. Does not run with the other tests: `cargo test live_keychain -- --ignored`.
    #[cfg(test)]
    pub fn live_roundtrip() -> Result<(), String> {
        let entry = keyring::Entry::new("PromptOps Desktop plugin secrets (test)", "roundtrip")
            .map_err(|e| e.to_string())?;
        entry
            .set_password("c2VncmV0bw==")
            .map_err(|e| e.to_string())?;
        let back = entry.get_password().map_err(|e| e.to_string())?;
        entry.delete_credential().map_err(|e| e.to_string())?;
        if back == "c2VncmV0bw==" {
            Ok(())
        } else {
            Err("value mismatch".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(tag: &str) -> std::sync::Arc<PluginRuntime> {
        let rt = PluginRuntime::new();
        let root = std::env::temp_dir().join(format!(
            "po-secrets-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        rt.init(root);
        rt
    }

    fn sample() -> Secrets {
        Secrets::from([
            ("token".to_string(), "T0K3N-molto-segreto".to_string()),
            ("hook".to_string(), "abc/def".to_string()),
        ])
    }

    fn raw(rt: &PluginRuntime, id: &str) -> String {
        fs::read_to_string(rt.plugin_dir(id).unwrap().join(FILE)).unwrap()
    }

    #[test]
    fn sealed_on_disk_and_bound_to_the_plugin() {
        let rt = runtime("seal");
        rt.set_secret_key(KeyState::Ready([7u8; 32]));
        save(&rt, "acme.one", &sample()).unwrap();
        let on_disk = raw(&rt, "acme.one");
        assert!(
            on_disk.contains(FORMAT) && !on_disk.contains("T0K3N") && !on_disk.contains("token")
        );
        assert_eq!(load(&rt, "acme.one").unwrap(), sample());
        assert_eq!(status(&rt, "acme.one").storage, "keychain");

        // The same file in another plugin's folder does not open.
        fs::create_dir_all(rt.plugin_dir("evil.two").unwrap()).unwrap();
        fs::copy(
            rt.plugin_dir("acme.one").unwrap().join(FILE),
            rt.plugin_dir("evil.two").unwrap().join(FILE),
        )
        .unwrap();
        assert!(load(&rt, "evil.two").is_err());
        assert!(status(&rt, "evil.two").lost);

        // Two identical saves do not produce the same ciphertext.
        save(&rt, "acme.one", &sample()).unwrap();
        assert_ne!(on_disk, raw(&rt, "acme.one"));
    }

    #[test]
    fn legacy_plain_file_is_read_then_sealed() {
        let rt = runtime("legacy");
        let dir = rt.plugin_dir("acme.one").unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), serde_json::to_vec(&sample()).unwrap()).unwrap();
        rt.set_secret_key(KeyState::Ready([9u8; 32]));
        assert_eq!(load(&rt, "acme.one").unwrap(), sample());
        assert!(!raw(&rt, "acme.one").contains("T0K3N"));
        assert_eq!(load(&rt, "acme.one").unwrap(), sample());
    }

    #[test]
    fn without_keychain_it_is_sealed_with_the_session_vault() {
        let rt = runtime("nokey");
        rt.set_secret_key(KeyState::Unavailable("no Secret Service".into()));
        save(&rt, "acme.one", &sample()).unwrap();
        let on_disk = raw(&rt, "acme.one");
        assert!(on_disk.contains(VAULT_FORMAT));
        assert!(!on_disk.contains("T0K3N") && !on_disk.contains("token"));
        assert_eq!(load(&rt, "acme.one").unwrap(), sample());
        let st = status(&rt, "acme.one");
        assert_eq!(
            (st.storage, st.lost, st.reason.is_some()),
            ("vault", false, true)
        );

        // Bound to the plugin id: copied into another plugin's folder it does not open.
        fs::create_dir_all(rt.plugin_dir("evil.two").unwrap()).unwrap();
        fs::copy(
            rt.plugin_dir("acme.one").unwrap().join(FILE),
            rt.plugin_dir("evil.two").unwrap().join(FILE),
        )
        .unwrap();
        assert!(load(&rt, "evil.two").is_err());
        assert!(status(&rt, "evil.two").lost);

        // A plain file from an earlier version is re-sealed at the first read.
        let dir = rt.plugin_dir("old.one").unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), serde_json::to_vec(&sample()).unwrap()).unwrap();
        assert_eq!(load(&rt, "old.one").unwrap(), sample());
        assert!(!raw(&rt, "old.one").contains("T0K3N"));
        assert_eq!(load(&rt, "old.one").unwrap(), sample());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(rt.plugin_dir("acme.one").unwrap().join(FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn without_keychain_or_store_it_stays_a_private_file() {
        let rt = runtime("nostore");
        rt.set_secret_key(KeyState::Unavailable("no Secret Service".into()));
        let path = rt.plugin_dir("acme.one").unwrap().join(FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        save_without_keychain(&path, "acme.one", &sample(), None).unwrap();
        assert!(raw(&rt, "acme.one").contains("T0K3N"));
        assert_eq!(load(&rt, "acme.one").unwrap(), sample());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_changed_key_means_lost_and_a_silent_keychain_never_overwrites() {
        let rt = runtime("lost");
        rt.set_secret_key(KeyState::Ready([1u8; 32]));
        save(&rt, "acme.one", &sample()).unwrap();

        // Different key: lost for good, start over from scratch.
        rt.set_secret_key(KeyState::Ready([2u8; 32]));
        assert!(load(&rt, "acme.one").unwrap_err().contains("re-enter them"));
        assert!(status(&rt, "acme.one").lost);
        assert!(load_for_update(&rt, "acme.one").unwrap().is_empty());

        // Silent keychain: nothing is written over the secrets that cannot be read.
        rt.set_secret_key(KeyState::Unavailable("locked".into()));
        assert!(load_for_update(&rt, "acme.one").is_err());
        assert!(!status(&rt, "acme.one").lost);
    }

    #[test]
    fn empty_set_removes_the_file() {
        let rt = runtime("empty");
        rt.set_secret_key(KeyState::Ready([3u8; 32]));
        save(&rt, "acme.one", &sample()).unwrap();
        save(&rt, "acme.one", &Secrets::new()).unwrap();
        assert!(!rt.plugin_dir("acme.one").unwrap().join(FILE).exists());
        assert_eq!(status(&rt, "acme.one").storage, "none");
    }

    #[test]
    #[ignore = "touches this machine's real keychain"]
    fn live_keychain_roundtrip() {
        keychain::live_roundtrip().unwrap();
    }
}
