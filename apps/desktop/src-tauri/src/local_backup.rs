//! Encrypted backup and restore of the local store.
//!
//! The local store (`local_store.rs`) is sealed with a key that never leaves
//! this device. A backup is the way to keep a copy elsewhere, move to another
//! computer, or recover if the keychain entry is lost: every record is
//! decrypted with the device key and the whole payload is encrypted again
//! under a key derived from a passphrase the user chooses.
//!
//! File (`.pobackup`), binary, all integers little endian:
//!
//! | Offset | Size | Field                                         |
//! |--------|------|-----------------------------------------------|
//! | 0      | 8    | magic `POBACKUP`                              |
//! | 8      | 1    | format version (1)                            |
//! | 9      | 1    | KDF id (1 = Argon2id, version 0x13)           |
//! | 10     | 4    | Argon2 memory cost, KiB                       |
//! | 14     | 4    | Argon2 time cost (passes)                     |
//! | 18     | 4    | Argon2 parallelism (lanes)                    |
//! | 22     | 1    | salt length (16)                              |
//! | 23     | 16   | salt, random                                  |
//! | 39     | 12   | AES-GCM nonce, random                         |
//! | 51     | …    | AES-256-GCM ciphertext with its 16-byte tag   |
//!
//! The 51 header bytes are the additional authenticated data: changing the
//! KDF parameters, the salt or the version makes decryption fail. The
//! plaintext is JSON: `{"format":"promptops-local-backup","v":1,
//! "created_at":…,"app_version":…,"collections":{name:{id:record}}}`.
//!
//! Import re-seals every record with this device's key. The current store is
//! copied to `local-store.pre-import-<id>.json` first, and the new file
//! replaces it atomically. Only the newest [`PRE_IMPORT_KEEP`] copies are
//! kept: older ones are deleted after a successful import, so repeated
//! restores do not pile up sealed copies of old data. Nothing about the
//! contents is logged.
//!
//! Design and threat model: `docs/session-vault.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::local_store::{self, LocalStore};

const MAGIC: &[u8; 8] = b"POBACKUP";
const FORMAT_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 8 + 1 + 1 + 4 + 4 + 4 + 1 + SALT_LEN + NONCE_LEN;
const PAYLOAD_FORMAT: &str = "promptops-local-backup";
/// Shortest passphrase accepted for a new backup, in characters.
pub const MIN_PASSPHRASE_CHARS: usize = 12;
/// Upper bounds for parameters read from a file, so a crafted file cannot
/// make the app allocate gigabytes or spin for minutes.
const MAX_M_COST_KIB: u32 = 1024 * 1024;
const MAX_T_COST: u32 = 16;
const MAX_P_COST: u32 = 16;
/// Largest file accepted for import. A store of tens of thousands of records
/// is a few MiB; anything this big is not a backup this app wrote.
const MAX_BACKUP_BYTES: u64 = 256 * 1024 * 1024;
/// Prefix of the copies of the store taken before an import.
const PRE_IMPORT_PREFIX: &str = "local-store.pre-import-";
/// How many pre-import copies are kept (newest first).
pub const PRE_IMPORT_KEEP: usize = 5;

/// Argon2id parameters written into new backups: RFC 9106, second
/// recommended option (64 MiB, 3 passes, 4 lanes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

pub const DEFAULT_KDF: KdfParams = KdfParams {
    m_cost_kib: 64 * 1024,
    t_cost: 3,
    p_cost: 4,
};

/// Errors with stable codes: the UI maps them to translated messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    PassphraseTooShort,
    NotABackup,
    UnsupportedVersion(u8),
    UnsupportedKdf,
    /// Authentication failed: wrong passphrase, or the file was changed.
    WrongPassphraseOrDamaged,
    BadMode,
    StoreNotReady,
    Io(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PassphraseTooShort => write!(
                f,
                "passphrase_too_short: use at least {MIN_PASSPHRASE_CHARS} characters"
            ),
            Self::NotABackup => write!(f, "not_a_backup: this is not a PromptOps backup file"),
            Self::UnsupportedVersion(v) => write!(
                f,
                "unsupported_version: backup format {v} needs a newer PromptOps"
            ),
            Self::UnsupportedKdf => write!(f, "unsupported_kdf: unknown key derivation settings"),
            Self::WrongPassphraseOrDamaged => write!(
                f,
                "wrong_passphrase: wrong passphrase, or the file was damaged or changed"
            ),
            Self::BadMode => write!(f, "bad_mode: mode must be \"replace\" or \"merge\""),
            Self::StoreNotReady => write!(f, "store_not_ready: local store not ready"),
            Self::Io(e) => write!(f, "io: {e}"),
        }
    }
}

type Collections = BTreeMap<String, BTreeMap<String, Value>>;

#[derive(Serialize, Deserialize)]
struct BackupPayload {
    format: String,
    v: u8,
    created_at: String,
    app_version: String,
    collections: Collections,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    /// The store becomes exactly what the backup holds.
    Replace,
    /// Records missing here are added; records already here are kept.
    Merge,
}

impl ImportMode {
    fn parse(mode: &str) -> Result<Self, BackupError> {
        match mode {
            "replace" => Ok(Self::Replace),
            "merge" => Ok(Self::Merge),
            _ => Err(BackupError::BadMode),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub records: usize,
    pub collections: usize,
    /// Records on disk this device cannot open: not in the backup.
    pub skipped_unreadable: usize,
    pub bytes: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Records in the backup file.
    pub records: usize,
    /// Records written or updated in this device's store.
    pub restored: usize,
    /// Merge only: records that already existed here with other contents, kept as they are.
    pub kept_local: usize,
    pub created_at: String,
    /// Copy of the store as it was before the import; `None` when there
    /// was no store file yet.
    pub previous_copy: Option<String>,
}

/// Overwrites the bytes before they are freed. Volatile writes, so the
/// compiler cannot drop the zeroing as a dead store.
fn wipe(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

/// A derived 256-bit key, zeroed on drop.
struct DerivedKey([u8; 32]);

impl Drop for DerivedKey {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

fn check_passphrase(passphrase: &[u8]) -> Result<(), BackupError> {
    let chars = std::str::from_utf8(passphrase)
        .map(|s| s.chars().count())
        .unwrap_or(passphrase.len());
    if chars < MIN_PASSPHRASE_CHARS {
        return Err(BackupError::PassphraseTooShort);
    }
    Ok(())
}

fn derive_key(
    passphrase: &[u8],
    salt: &[u8],
    params: KdfParams,
) -> Result<DerivedKey, BackupError> {
    if params.m_cost_kib > MAX_M_COST_KIB
        || params.t_cost > MAX_T_COST
        || params.p_cost > MAX_P_COST
    {
        return Err(BackupError::UnsupportedKdf);
    }
    let argon_params =
        argon2::Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
            .map_err(|_| BackupError::UnsupportedKdf)?;
    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon_params,
    );
    let mut key = DerivedKey([0u8; 32]);
    argon
        .hash_password_into(passphrase, salt, &mut key.0)
        .map_err(|_| BackupError::UnsupportedKdf)?;
    Ok(key)
}

fn header(params: KdfParams, salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.push(FORMAT_VERSION);
    h.push(KDF_ARGON2ID);
    h.extend_from_slice(&params.m_cost_kib.to_le_bytes());
    h.extend_from_slice(&params.t_cost.to_le_bytes());
    h.extend_from_slice(&params.p_cost.to_le_bytes());
    h.push(SALT_LEN as u8);
    h.extend_from_slice(salt);
    h.extend_from_slice(nonce);
    h
}

fn random<const N: usize>() -> Result<[u8; N], BackupError> {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).map_err(|e| BackupError::Io(e.to_string()))?;
    Ok(out)
}

/// Encrypts `collections` into the backup file format.
fn seal_backup(
    collections: &Collections,
    passphrase: &[u8],
    params: KdfParams,
) -> Result<Vec<u8>, BackupError> {
    check_passphrase(passphrase)?;
    let salt = random::<SALT_LEN>()?;
    let nonce = random::<NONCE_LEN>()?;
    let key = derive_key(passphrase, &salt, params)?;
    let payload = BackupPayload {
        format: PAYLOAD_FORMAT.into(),
        v: FORMAT_VERSION,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        app_version: env!("CARGO_PKG_VERSION").into(),
        collections: collections.clone(),
    };
    let mut plain = serde_json::to_vec(&payload).map_err(|e| BackupError::Io(e.to_string()))?;
    let head = header(params, &salt, &nonce);
    let sealed = Aes256Gcm::new((&key.0).into()).encrypt(
        (&nonce).into(),
        Payload {
            msg: &plain,
            aad: &head,
        },
    );
    wipe(&mut plain);
    let ct = sealed.map_err(|_| BackupError::Io("encryption failed".into()))?;
    let mut file = head;
    file.extend_from_slice(&ct);
    Ok(file)
}

/// The 51-byte header, checked for shape only (no key derivation).
#[derive(Debug, PartialEq, Eq)]
struct Header {
    params: KdfParams,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
}

/// Parses the header without trusting any length or offset in the file:
/// every read is bounds-checked, so a truncated or crafted file is an error,
/// never a panic.
fn parse_header(bytes: &[u8]) -> Result<Header, BackupError> {
    if bytes.get(..8) != Some(&MAGIC[..]) {
        return Err(BackupError::NotABackup);
    }
    let version = *bytes.get(8).ok_or(BackupError::NotABackup)?;
    if version != FORMAT_VERSION {
        return Err(BackupError::UnsupportedVersion(version));
    }
    // Header plus at least the 16-byte authentication tag.
    if bytes.len() < HEADER_LEN + 16 {
        return Err(BackupError::NotABackup);
    }
    if bytes[9] != KDF_ARGON2ID || bytes[22] as usize != SALT_LEN {
        return Err(BackupError::UnsupportedKdf);
    }
    let u32_at = |at: usize| -> Result<u32, BackupError> {
        bytes
            .get(at..at + 4)
            .and_then(|b| <[u8; 4]>::try_from(b).ok())
            .map(u32::from_le_bytes)
            .ok_or(BackupError::NotABackup)
    };
    let params = KdfParams {
        m_cost_kib: u32_at(10)?,
        t_cost: u32_at(14)?,
        p_cost: u32_at(18)?,
    };
    let salt = bytes
        .get(23..23 + SALT_LEN)
        .and_then(|b| <[u8; SALT_LEN]>::try_from(b).ok())
        .ok_or(BackupError::NotABackup)?;
    let nonce = bytes
        .get(23 + SALT_LEN..HEADER_LEN)
        .and_then(|b| <[u8; NONCE_LEN]>::try_from(b).ok())
        .ok_or(BackupError::NotABackup)?;
    Ok(Header {
        params,
        salt,
        nonce,
    })
}

/// Verifies and decrypts a backup file.
fn open_backup(bytes: &[u8], passphrase: &[u8]) -> Result<BackupPayload, BackupError> {
    let Header {
        params,
        salt,
        nonce,
    } = parse_header(bytes)?;
    let key = derive_key(passphrase, &salt, params)?;
    let mut plain = Aes256Gcm::new((&key.0).into())
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &bytes[HEADER_LEN..],
                aad: &bytes[..HEADER_LEN],
            },
        )
        .map_err(|_| BackupError::WrongPassphraseOrDamaged)?;
    let parsed = serde_json::from_slice::<BackupPayload>(&plain);
    wipe(&mut plain);
    let payload = parsed.map_err(|_| BackupError::NotABackup)?;
    if payload.format != PAYLOAD_FORMAT {
        return Err(BackupError::NotABackup);
    }
    if payload.v != FORMAT_VERSION {
        return Err(BackupError::UnsupportedVersion(payload.v));
    }
    // The store refuses these names on every write (`check_kind`): a backup
    // written by this app never holds them, and an import must not either.
    if payload
        .collections
        .keys()
        .any(|name| name.is_empty() || name.contains('|'))
    {
        return Err(BackupError::NotABackup);
    }
    Ok(payload)
}

/// Records shaped `{ "connections": [ { "id": … }, … ], … }` (saved SSH and
/// database connections live in one record each): merging keeps every local
/// connection and adds the backup's connections whose id is new here.
fn merge_connections(local: &Value, incoming: &Value) -> Option<(Value, usize)> {
    let mine = local.get("connections")?.as_array()?;
    let theirs = incoming.get("connections")?.as_array()?;
    let known: std::collections::HashSet<&str> = mine
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str))
        .collect();
    let mut merged = mine.clone();
    let mut added = 0;
    for c in theirs {
        match c.get("id").and_then(Value::as_str) {
            Some(id) if !known.contains(id) => {
                merged.push(c.clone());
                added += 1;
            }
            _ => {}
        }
    }
    let mut out = local.clone();
    out["connections"] = Value::Array(merged);
    Some((out, added))
}

/// Merge: add what is missing, keep what is already here.
/// Returns the merged records, how many changed, and how many conflicting
/// records were kept local.
fn merge(mut current: Collections, incoming: Collections) -> (Collections, usize, usize) {
    let mut restored = 0;
    let mut kept = 0;
    for (collection, items) in incoming {
        let target = current.entry(collection).or_default();
        for (id, value) in items {
            match target.get(&id) {
                None => {
                    target.insert(id, value);
                    restored += 1;
                }
                Some(local) if *local == value => {}
                Some(local) => match merge_connections(local, &value) {
                    Some((merged, added)) => {
                        if added > 0 {
                            target.insert(id, merged);
                            restored += 1;
                        }
                    }
                    None => kept += 1,
                },
            }
        }
    }
    (current, restored, kept)
}

fn count(collections: &Collections) -> usize {
    collections.values().map(BTreeMap::len).sum()
}

/// Writes `bytes` to `path` through a temporary file in the same folder.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), BackupError> {
    let name = path
        .file_name()
        .ok_or_else(|| BackupError::Io("invalid file name".into()))?
        .to_string_lossy()
        .to_string();
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", local_store::new_id()));
    local_store::write_private(&tmp, bytes).map_err(BackupError::Io)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        BackupError::Io(e.to_string())
    })
}

fn absolute(path: &str) -> Result<PathBuf, BackupError> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(BackupError::Io("the path must be absolute".into()));
    }
    Ok(p)
}

pub(crate) fn export_to(
    store: &LocalStore,
    path: &Path,
    passphrase: &[u8],
    params: KdfParams,
) -> Result<ExportSummary, BackupError> {
    check_passphrase(passphrase)?;
    let collections = store.snapshot();
    let file = seal_backup(&collections, passphrase, params)?;
    write_atomic(path, &file)?;
    Ok(ExportSummary {
        records: count(&collections),
        collections: collections.len(),
        skipped_unreadable: store.unreadable_count(),
        bytes: file.len(),
    })
}

/// Deletes all but the newest `keep` pre-import copies in `dir`. Their names
/// end in a ULID, which sorts by creation time. Returns how many were removed.
fn prune_pre_import_copies(dir: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut copies: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let is_copy = name.starts_with(PRE_IMPORT_PREFIX)
                && name.ends_with(".json")
                && e.file_type().map(|t| t.is_file()).unwrap_or(false);
            is_copy.then(|| (name, e.path()))
        })
        .collect();
    copies.sort_by(|a, b| b.0.cmp(&a.0));
    copies
        .iter()
        .skip(keep)
        .filter(|(_, path)| std::fs::remove_file(path).is_ok())
        .count()
}

pub(crate) fn import_from(
    store: &LocalStore,
    path: &Path,
    passphrase: &[u8],
    mode: ImportMode,
) -> Result<ImportSummary, BackupError> {
    let size = std::fs::metadata(path)
        .map_err(|e| BackupError::Io(e.to_string()))?
        .len();
    if size > MAX_BACKUP_BYTES {
        return Err(BackupError::NotABackup);
    }
    let bytes = std::fs::read(path).map_err(|e| BackupError::Io(e.to_string()))?;
    let payload = open_backup(&bytes, passphrase)?;
    let records = count(&payload.collections);
    let (next, restored, kept_local) = match mode {
        ImportMode::Replace => (payload.collections, records, 0),
        ImportMode::Merge => merge(store.snapshot(), payload.collections),
    };
    let previous = store
        .dir()
        .join(format!("{PRE_IMPORT_PREFIX}{}.json", local_store::new_id()));
    let copied = store
        .replace_all(next, mode == ImportMode::Merge, &previous)
        .map_err(BackupError::Io)?;
    prune_pre_import_copies(store.dir(), PRE_IMPORT_KEEP);
    Ok(ImportSummary {
        records,
        restored,
        kept_local,
        created_at: payload.created_at,
        previous_copy: copied.then(|| previous.to_string_lossy().to_string()),
    })
}

/// Saves an encrypted backup of every local record to `path`.
#[tauri::command]
pub async fn local_backup_export(
    path: String,
    passphrase: String,
) -> Result<ExportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pass = passphrase.into_bytes();
        let result = (|| {
            let store = local_store::get().ok_or(BackupError::StoreNotReady)?;
            export_to(store, &absolute(&path)?, &pass, DEFAULT_KDF)
        })();
        wipe(&mut pass);
        match &result {
            Ok(s) => eprintln!(
                "[local-backup] exported {} records in {} collections",
                s.records, s.collections
            ),
            Err(e) => eprintln!("[local-backup] export failed: {}", code(e)),
        }
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restores a backup into this device's store. `mode`: `replace` or `merge`.
#[tauri::command]
pub async fn local_backup_import(
    path: String,
    passphrase: String,
    mode: String,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pass = passphrase.into_bytes();
        let result = (|| {
            let mode = ImportMode::parse(&mode)?;
            let store = local_store::get().ok_or(BackupError::StoreNotReady)?;
            import_from(store, &absolute(&path)?, &pass, mode)
        })();
        wipe(&mut pass);
        match &result {
            Ok(s) => eprintln!(
                "[local-backup] imported {} records ({} restored, {} kept local)",
                s.records, s.restored, s.kept_local
            ),
            Err(e) => eprintln!("[local-backup] import failed: {}", code(e)),
        }
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native file dialog for a backup: `save` asks where to write a new one,
/// otherwise picks an existing file. `None` when the user cancels.
#[tauri::command]
pub async fn local_backup_pick_file(
    app: tauri::AppHandle,
    save: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // Non-blocking dialog: a blocking one from a command deadlocks the main
    // loop that draws it on macOS (see workspace_select).
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app
        .dialog()
        .file()
        .add_filter("PromptOps backup", &["pobackup"]);
    if save {
        let name = format!(
            "promptops-backup-{}.pobackup",
            chrono::Local::now().format("%Y-%m-%d")
        );
        dialog.set_file_name(name).save_file(move |fp| {
            let _ = tx.send(fp);
        });
    } else {
        dialog.pick_file(move |fp| {
            let _ = tx.send(fp);
        });
    }
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// The error code only, for the log.
fn code(e: &BackupError) -> String {
    e.to_string()
        .split(':')
        .next()
        .unwrap_or("error")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VaultKey;
    use serde_json::json;

    const PASS: &[u8] = b"correct horse battery";
    /// Cheap parameters: the format is the same, tests stay fast.
    const FAST: KdfParams = KdfParams {
        m_cost_kib: 64,
        t_cost: 1,
        p_cost: 1,
    };

    fn tmp() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("promptops-backup-test-{}", local_store::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn device(byte: u8) -> (PathBuf, LocalStore) {
        let dir = tmp();
        let store = LocalStore::open_at(&dir, VaultKey::from_bytes([byte; 32])).unwrap();
        (dir, store)
    }

    fn sample(store: &LocalStore) {
        store
            .put(
                "sessions",
                "01a",
                json!({ "name": "acme-api", "workspace_path": "/Users/alice/acme" }),
            )
            .unwrap();
        store
            .put("prompts", "1", json!({ "title": "Review" }))
            .unwrap();
        store
            .put(
                "secrets",
                "groq_api_key",
                json!({ "value": "gsk_secret_value" }),
            )
            .unwrap();
        store
            .put(
                "ssh",
                "connections",
                json!({ "version": 1, "connections": [ { "id": "c1", "host": "a.example" } ] }),
            )
            .unwrap();
    }

    fn export(store: &LocalStore, dir: &Path) -> PathBuf {
        let path = dir.join("backup.pobackup");
        export_to(store, &path, PASS, FAST).unwrap();
        path
    }

    #[test]
    fn round_trip_to_a_device_with_another_key() {
        let (dir_a, a) = device(1);
        sample(&a);
        let file = export(&a, &dir_a);
        let raw = std::fs::read(&file).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            !text.contains("acme") && !text.contains("gsk_secret") && !text.contains("sessions")
        );
        assert_eq!(&raw[..8], MAGIC);

        let (dir_b, b) = device(2);
        let summary = import_from(&b, &file, PASS, ImportMode::Replace).unwrap();
        assert_eq!(summary.records, 4);
        // A fresh device has no store file yet: nothing to copy.
        assert!(summary.previous_copy.is_none());
        assert_eq!(b.get("sessions", "01a").unwrap()["name"], "acme-api");

        // Re-sealed with device B's key: B reopens it, A's key cannot.
        let reopened = LocalStore::open_at(&dir_b, VaultKey::from_bytes([2; 32])).unwrap();
        assert_eq!(
            reopened.get("secrets", "groq_api_key").unwrap()["value"],
            "gsk_secret_value"
        );
        let foreign = LocalStore::open_at(&dir_b, VaultKey::from_bytes([1; 32])).unwrap();
        assert!(foreign.get("sessions", "01a").is_none());
    }

    #[test]
    fn default_parameters_round_trip() {
        let mut collections = Collections::new();
        collections
            .entry("notes".into())
            .or_default()
            .insert("1".into(), json!({ "content": "x" }));
        let file = seal_backup(&collections, PASS, DEFAULT_KDF).unwrap();
        assert_eq!(u32::from_le_bytes(file[10..14].try_into().unwrap()), 65536);
        assert_eq!(open_backup(&file, PASS).unwrap().collections, collections);
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let (dir, a) = device(1);
        sample(&a);
        let file = export(&a, &dir);
        let (_, b) = device(2);
        assert_eq!(
            import_from(&b, &file, b"another passphrase", ImportMode::Replace),
            Err(BackupError::WrongPassphraseOrDamaged)
        );
        assert!(b.list("sessions").is_empty());
    }

    #[test]
    fn tampered_file_is_rejected() {
        let (dir, a) = device(1);
        sample(&a);
        let file = export(&a, &dir);
        let good = std::fs::read(&file).unwrap();

        let mut body = good.clone();
        let last = body.len() - 1;
        body[last] ^= 1;
        assert_eq!(
            open_backup(&body, PASS).err(),
            Some(BackupError::WrongPassphraseOrDamaged)
        );

        // The header is authenticated too: a different salt or cost fails.
        let mut salt = good.clone();
        salt[30] ^= 1;
        assert_eq!(
            open_backup(&salt, PASS).err(),
            Some(BackupError::WrongPassphraseOrDamaged)
        );
        let mut cost = good.clone();
        cost[14] = 2;
        assert_eq!(
            open_backup(&cost, PASS).err(),
            Some(BackupError::WrongPassphraseOrDamaged)
        );

        assert_eq!(
            open_backup(&good[..40], PASS).err(),
            Some(BackupError::NotABackup)
        );
        assert_eq!(
            open_backup(b"{\"v\":1}", PASS).err(),
            Some(BackupError::NotABackup)
        );
    }

    #[test]
    fn version_mismatch_is_reported() {
        let (dir, a) = device(1);
        sample(&a);
        let mut bytes = std::fs::read(export(&a, &dir)).unwrap();
        bytes[8] = 2;
        assert_eq!(
            open_backup(&bytes, PASS).err(),
            Some(BackupError::UnsupportedVersion(2))
        );
        bytes[8] = FORMAT_VERSION;
        bytes[9] = 7;
        assert_eq!(
            open_backup(&bytes, PASS).err(),
            Some(BackupError::UnsupportedKdf)
        );
    }

    #[test]
    fn oversized_kdf_parameters_are_refused() {
        let (dir, a) = device(1);
        sample(&a);
        let mut bytes = std::fs::read(export(&a, &dir)).unwrap();
        bytes[10..14].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            open_backup(&bytes, PASS).err(),
            Some(BackupError::UnsupportedKdf)
        );
    }

    #[test]
    fn short_passphrase_is_refused() {
        let (dir, a) = device(1);
        assert_eq!(
            export_to(&a, &dir.join("x.pobackup"), b"short", FAST).err(),
            Some(BackupError::PassphraseTooShort)
        );
        // Characters, not bytes: 11 two-byte characters are still too short.
        assert_eq!(
            check_passphrase("ééééééééééé".as_bytes()),
            Err(BackupError::PassphraseTooShort)
        );
        assert!(!dir.join("x.pobackup").exists());
    }

    #[test]
    fn merge_adds_missing_and_keeps_local_while_replace_drops_local() {
        let (dir_a, a) = device(1);
        sample(&a);
        let file = export(&a, &dir_a);

        let setup = |b: &LocalStore| {
            b.put("prompts", "1", json!({ "title": "Mine" })).unwrap();
            b.put("notes", "7", json!({ "content": "only here" }))
                .unwrap();
            b.put(
                "ssh",
                "connections",
                json!({ "version": 1, "connections": [ { "id": "c2", "host": "b.example" } ] }),
            )
            .unwrap();
        };

        let (dir_m, m) = device(2);
        setup(&m);
        let s = import_from(&m, &file, PASS, ImportMode::Merge).unwrap();
        assert_eq!(m.get("prompts", "1").unwrap()["title"], "Mine");
        assert_eq!(m.get("notes", "7").unwrap()["content"], "only here");
        assert_eq!(m.get("sessions", "01a").unwrap()["name"], "acme-api");
        let conns = m.get("ssh", "connections").unwrap()["connections"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(conns, 2);
        assert_eq!(s.kept_local, 1);
        assert_eq!(s.restored, 3); // session, groq key, ssh connection list
        let copy = s.previous_copy.unwrap();
        assert!(Path::new(&copy).exists());
        assert!(Path::new(&copy).starts_with(&dir_m));

        let (_, r) = device(3);
        setup(&r);
        import_from(&r, &file, PASS, ImportMode::Replace).unwrap();
        assert_eq!(r.get("prompts", "1").unwrap()["title"], "Review");
        assert!(r.get("notes", "7").is_none());
        let conns = r.get("ssh", "connections").unwrap()["connections"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(conns, 1);
    }

    #[test]
    fn pre_import_copy_holds_the_previous_store() {
        let (dir_a, a) = device(1);
        sample(&a);
        let file = export(&a, &dir_a);
        let (dir_b, b) = device(2);
        b.put("notes", "7", json!({ "content": "before" })).unwrap();
        let s = import_from(&b, &file, PASS, ImportMode::Replace).unwrap();
        // The copy is the old sealed file: restoring it brings the note back.
        let restore = tmp();
        std::fs::copy(s.previous_copy.unwrap(), restore.join("local-store.json")).unwrap();
        let old = LocalStore::open_at(&restore, VaultKey::from_bytes([2; 32])).unwrap();
        assert_eq!(old.get("notes", "7").unwrap()["content"], "before");
        assert!(old.get("sessions", "01a").is_none());
        drop(dir_b);
    }

    #[test]
    fn merge_keeps_records_this_device_cannot_open() {
        let (dir_a, a) = device(1);
        sample(&a);
        let file = export(&a, &dir_a);
        // A store with a record sealed by a key this device no longer has.
        let (dir_b, foreign) = device(9);
        foreign
            .put("notes", "x", json!({ "content": "lost key" }))
            .unwrap();
        let b = LocalStore::open_at(&dir_b, VaultKey::from_bytes([2; 32])).unwrap();
        assert_eq!(b.unreadable_count(), 1);
        import_from(&b, &file, PASS, ImportMode::Merge).unwrap();
        assert_eq!(b.unreadable_count(), 1);
        let back = LocalStore::open_at(&dir_b, VaultKey::from_bytes([9; 32])).unwrap();
        assert_eq!(back.get("notes", "x").unwrap()["content"], "lost key");
    }

    #[test]
    fn collection_names_the_store_refuses_are_refused_on_import() {
        for name in ["a|b", ""] {
            let mut collections = Collections::new();
            collections
                .entry(name.to_string())
                .or_default()
                .insert("c".into(), json!({ "value": 1 }));
            let file = seal_backup(&collections, PASS, FAST).unwrap();
            assert_eq!(
                open_backup(&file, PASS).err(),
                Some(BackupError::NotABackup),
                "{name:?}"
            );
        }
    }

    #[test]
    fn bad_mode_is_refused() {
        assert_eq!(ImportMode::parse("wipe"), Err(BackupError::BadMode));
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            code(&BackupError::WrongPassphraseOrDamaged),
            "wrong_passphrase"
        );
        assert_eq!(
            code(&BackupError::PassphraseTooShort),
            "passphrase_too_short"
        );
    }

    /// Deterministic xorshift generator: reproducible fuzzing without a crate.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn bytes(&mut self, n: usize) -> Vec<u8> {
            (0..n).map(|_| self.next() as u8).collect()
        }
    }

    fn fast_backup() -> Vec<u8> {
        let mut collections = Collections::new();
        collections
            .entry("secrets".into())
            .or_default()
            .insert("k".into(), json!({ "value": "s3cret" }));
        seal_backup(&collections, PASS, FAST).unwrap()
    }

    #[test]
    fn fuzz_header_parser_never_panics() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for i in 0..20_000 {
            let len = rng.below(HEADER_LEN + 40);
            let mut b = rng.bytes(len);
            // Most iterations get past the early checks, so the deeper
            // reads are exercised too.
            if i % 4 != 0 && b.len() >= 23 {
                b[..8].copy_from_slice(MAGIC);
                b[8] = FORMAT_VERSION;
                b[9] = KDF_ARGON2ID;
                b[22] = SALT_LEN as u8;
            }
            match parse_header(&b) {
                Ok(h) => assert!(b.len() >= HEADER_LEN + 16, "{h:?}"),
                Err(e) => assert!(matches!(
                    e,
                    BackupError::NotABackup
                        | BackupError::UnsupportedVersion(_)
                        | BackupError::UnsupportedKdf
                )),
            }
        }
    }

    #[test]
    fn every_truncation_of_a_backup_is_rejected() {
        let good = fast_backup();
        for cut in 0..good.len() {
            let err = open_backup(&good[..cut], PASS).err();
            assert!(
                matches!(
                    err,
                    Some(BackupError::NotABackup) | Some(BackupError::WrongPassphraseOrDamaged)
                ),
                "cut at {cut}: {err:?}"
            );
        }
        assert!(open_backup(&good, PASS).is_ok());
    }

    #[test]
    fn fuzz_mutated_backups_are_rejected_without_panicking() {
        let good = fast_backup();
        let mut rng = Rng(0x0123_4567_89ab_cdef);
        for _ in 0..400 {
            let mut b = good.clone();
            for _ in 0..1 + rng.below(4) {
                // The cost fields (10..22) are left to the bounds test below:
                // random values there only make the KDF slow, not unsafe.
                let mut at = rng.below(b.len());
                while (10..22).contains(&at) {
                    at = rng.below(b.len());
                }
                let flip = 1 + rng.below(255) as u8;
                b[at] ^= flip;
            }
            // Sometimes also append or drop a tail.
            match rng.below(4) {
                0 => {
                    let n = 1 + rng.below(32);
                    b.extend(rng.bytes(n));
                }
                1 => {
                    let n = 1 + rng.below(16);
                    b.truncate(b.len() - n);
                }
                _ => {}
            }
            assert!(open_backup(&b, PASS).is_err());
        }
    }

    #[test]
    fn crafted_kdf_parameters_are_bounded_or_refused() {
        let good = fast_backup();
        for (at, value) in [
            (10, 0u32),
            (10, MAX_M_COST_KIB + 1),
            (14, 0),
            (14, MAX_T_COST + 1),
            (18, 0),
            (18, MAX_P_COST + 1),
            (18, u32::MAX),
        ] {
            let mut b = good.clone();
            b[at..at + 4].copy_from_slice(&value.to_le_bytes());
            assert_eq!(
                open_backup(&b, PASS).err(),
                Some(BackupError::UnsupportedKdf),
                "offset {at} = {value}"
            );
        }
    }

    #[test]
    fn oversized_file_is_refused_before_reading() {
        let (dir, store) = device(4);
        let path = dir.join("big.pobackup");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_BACKUP_BYTES + 1).unwrap();
        assert_eq!(
            import_from(&store, &path, PASS, ImportMode::Replace).err(),
            Some(BackupError::NotABackup)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_backup_has_its_own_salt_and_nonce() {
        let a = fast_backup();
        let b = fast_backup();
        let (ha, hb) = (parse_header(&a).unwrap(), parse_header(&b).unwrap());
        assert_ne!(ha.salt, hb.salt);
        assert_ne!(ha.nonce, hb.nonce);
    }

    #[test]
    fn only_the_newest_pre_import_copies_are_kept() {
        let (dir_a, a) = device(1);
        sample(&a);
        let file = export(&a, &dir_a);
        let (dir_b, b) = device(2);
        b.put("notes", "1", json!({ "content": "x" })).unwrap();
        // A file that only looks similar is never touched.
        std::fs::write(dir_b.join("local-store.pre-import-notes.txt"), "keep").unwrap();
        let mut copies = Vec::new();
        for _ in 0..PRE_IMPORT_KEEP + 3 {
            let s = import_from(&b, &file, PASS, ImportMode::Merge).unwrap();
            copies.push(s.previous_copy.unwrap());
            // ULIDs are millisecond-ordered: keep the names distinct in time.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let left: Vec<String> = std::fs::read_dir(&dir_b)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(PRE_IMPORT_PREFIX) && n.ends_with(".json"))
            .collect();
        assert_eq!(left.len(), PRE_IMPORT_KEEP);
        for newest in copies.iter().rev().take(PRE_IMPORT_KEEP) {
            assert!(Path::new(newest).exists(), "{newest} was pruned");
        }
        for oldest in copies.iter().take(3) {
            assert!(!Path::new(oldest).exists(), "{oldest} was kept");
        }
        assert!(dir_b.join("local-store.pre-import-notes.txt").exists());
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }
}
