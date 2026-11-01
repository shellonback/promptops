//! Local store: where local mode keeps your data.
//!
//! The open-source edition has no server. Sessions, workspaces, prompts and
//! preferences live in one file on this device, `local-store.json` in the app
//! data folder, and nowhere else.
//!
//! Every record is encrypted on its own with the Session Vault
//! (`vault.rs`: AES-256-GCM, a fresh nonce per write). The envelope is bound
//! to its collection and id, so records cannot be swapped or moved without
//! failing authentication. Only collection names and record ids are stored in
//! clear; ids are random and say nothing about the content.
//!
//! The 256-bit key is created on first use and kept in the OS keychain
//! (macOS Keychain, Windows Credential Manager, Secret Service on Linux). When
//! no keychain is available, it falls back to `vault.key` next to the store,
//! readable only by your user account, and says so in the log. Debug builds
//! use `vault.key` (a copy of the keychain key, if there is one): every
//! rebuild changes the binary's signature, and macOS would ask for keychain
//! access again each time.
//!
//! Records written with either key stay readable: each envelope names its key
//! (`kid`), so a run that had to fall back never hides earlier records.
//!
//! Writes go to a temporary file that is flushed to disk and then atomically
//! replaces the store, so a crash or a power cut never leaves it half written.
//! One writer at a time, with the snapshot taken inside the write: the file on
//! disk always ends up holding the newest state.
//!
//! A store that cannot be read (truncated, not JSON) is never overwritten: it
//! is moved aside as `local-store.json.corrupt-<time>`, the app starts with an
//! empty store and says so (`health`). A store written by a newer version of
//! the app opens read-only. Only one running copy of the app writes the store;
//! a second copy opens it read-only instead of overwriting the first one's
//! changes.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::vault::{self, Envelope, VaultKey};

const FILE_NAME: &str = "local-store.json";
const KEY_FILE_NAME: &str = "vault.key";
const LOCK_FILE_NAME: &str = "local-store.lock";
pub(crate) const FORMAT_VERSION: u8 = 1;
/// Temporary files older than this are leftovers of a crash.
const STALE_TMP_SECS: u64 = 600;

#[derive(Default, Serialize, Deserialize)]
struct OnDisk {
    v: u8,
    /// collection → record id → sealed record.
    records: BTreeMap<String, BTreeMap<String, Envelope>>,
}

/// What happened when the store was opened, for the interface and the log.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreHealth {
    /// Where an unreadable store was moved, when it had to be set aside.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quarantined: Option<String>,
    /// Why writes are refused (newer format, another running copy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<String>,
    /// Records on disk this device cannot open (kept sealed, never deleted).
    pub unreadable: usize,
    pub format_version: u8,
}

pub struct LocalStore {
    path: PathBuf,
    /// Seals new writes. Older keys are only needed to open older data.
    key: VaultKey,
    /// Other keys of this device (data sealed before a keychain fallback).
    older: Vec<VaultKey>,
    /// Decrypted records, loaded once at start.
    data: Mutex<BTreeMap<String, BTreeMap<String, Value>>>,
    /// Sealed records, kept to rewrite the file without sealing everything again.
    sealed: Mutex<OnDisk>,
    /// One write at a time; the snapshot is taken while holding it.
    write_lock: Mutex<()>,
    /// Some(reason): every change is refused, nothing on disk is touched.
    read_only: Option<String>,
    /// Where the unreadable file found at open was moved.
    quarantined: Option<PathBuf>,
    /// Held for the life of the process: this copy of the app owns the store.
    _owner_lock: Option<std::fs::File>,
}

thread_local! {
    /// Store (by address) whose saves are deferred on this thread, and whether
    /// anything changed meanwhile. See [`LocalStore::batch`].
    static DEFERRED: RefCell<Option<(usize, bool)>> = const { RefCell::new(None) };
}

static STORE: OnceLock<LocalStore> = OnceLock::new();
/// Where the key that seals new writes lives, for Settings → About.
static KEY_SOURCE: OnceLock<&'static str> = OnceLock::new();

/// `keychain` (the OS keychain), `file` (no keychain: `vault.key`, owner-only)
/// or `development` (debug builds always use `vault.key`).
#[tauri::command]
pub fn local_store_key_source() -> &'static str {
    KEY_SOURCE.get().copied().unwrap_or("keychain")
}

/// Where the store key lives, once `init` ran (`None` before, and in unit tests).
pub(crate) fn key_source() -> Option<&'static str> {
    KEY_SOURCE.get().copied()
}

/// Opens the store once, at app start. `keychain_service` must be derived from
/// the app identifier, so two editions installed side by side never share a key.
pub fn init(dir: &Path, keychain_service: &str) -> Result<(), String> {
    if STORE.get().is_some() {
        return Ok(());
    }
    create_private_dir(dir)?;
    let (key, older) = load_keys(dir, keychain_service)?;
    let (owner_lock, busy) = take_owner_lock(dir);
    let mut store = LocalStore::open(dir.join(FILE_NAME), key, older)?;
    if busy && store.read_only.is_none() {
        store.read_only = Some(
            "Another copy of PromptOps is using this data. Changes made here are not saved: close the other copy and restart."
                .to_string(),
        );
    }
    store._owner_lock = owner_lock;
    let health = store.health();
    if health.quarantined.is_some() || health.read_only.is_some() {
        eprintln!("[local-store] opened with problems: {health:?}");
    }
    let _ = STORE.set(store);
    Ok(())
}

/// The store, if `init` ran. Local mode always runs it during setup.
pub fn get() -> Option<&'static LocalStore> {
    STORE.get()
}

/// Process-wide store for unit tests of code that reaches it through `get()`
/// (session restore): a fresh folder and a fixed key, never the keychain.
#[cfg(test)]
pub(crate) fn init_for_tests() -> &'static LocalStore {
    STORE.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("promptops-global-store-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        LocalStore::open_at(&dir, VaultKey::from_bytes([7; 32])).unwrap()
    })
}

/// Exclusive lock on `local-store.lock`: `(lock, busy)`. `busy` means another
/// running copy of the app holds it. A lock that cannot be taken for any other
/// reason (unsupported file system) does not block writes: the app behaves as
/// before the lock existed.
fn take_owner_lock(dir: &Path) -> (Option<std::fs::File>, bool) {
    let path = dir.join(LOCK_FILE_NAME);
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(_) => return (None, false),
    };
    match file.try_lock() {
        Ok(()) => (Some(file), false),
        Err(std::fs::TryLockError::WouldBlock) => (None, true),
        Err(_) => (None, false),
    }
}

/// The key that seals new writes, plus any other key of this device that can
/// still open older records.
fn load_keys(dir: &Path, keychain_service: &str) -> Result<(VaultKey, Vec<VaultKey>), String> {
    let file = dir.join(KEY_FILE_NAME);
    if cfg!(debug_assertions) {
        // Copy the keychain key once, so a development build keeps reading
        // what an earlier build wrote without asking for keychain access again.
        if !file.exists() {
            if let Ok(Some(key)) = vault::read_key(keychain_service) {
                let mut b64 = key.to_b64();
                let written = write_private(&file, b64.as_bytes());
                vault::wipe_string(&mut b64);
                written?;
            }
        }
        let _ = KEY_SOURCE.set("development");
        return Ok((load_or_create_key_file(&file)?, Vec::new()));
    }
    match vault::load_or_create_key(keychain_service) {
        Ok(key) => {
            let _ = KEY_SOURCE.set("keychain");
            let older = if file.exists() {
                vec![load_or_create_key_file(&file)?]
            } else {
                Vec::new()
            };
            Ok((key, older))
        }
        Err(err) => {
            eprintln!("[local-store] OS keychain unavailable ({err}); using {KEY_FILE_NAME} with owner-only permissions");
            let _ = KEY_SOURCE.set("file");
            Ok((load_or_create_key_file(&file)?, Vec::new()))
        }
    }
}

fn load_or_create_key_file(path: &Path) -> Result<VaultKey, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    if let Ok(text) = std::fs::read_to_string(path) {
        let bytes = B64
            .decode(text.trim())
            .map_err(|_| "vault.key is not valid base64".to_string())?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "vault.key has the wrong length".to_string())?;
        return Ok(VaultKey::from_bytes(bytes));
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    write_private(path, B64.encode(bytes).as_bytes())?;
    Ok(VaultKey::from_bytes(bytes))
}

/// Writes a file readable and writable only by the current user, flushed to
/// disk before returning (so a rename that follows never exposes a file whose
/// content is still only in the page cache).
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    let mut f = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        // `mode` applies only when the file is created: tighten an older one too.
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        f
    };
    // On Windows files in the user's AppData folder are private to the user by default.
    #[cfg(not(unix))]
    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

/// Creates a folder readable only by the current user (0700 on macOS and Linux).
pub(crate) fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replaces `path` with `bytes` atomically: private temporary file in the same
/// folder (unique name, so two writers never share it), flushed, renamed.
pub(crate) fn replace_file_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", new_id()));
    write_private(&tmp, bytes)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    // The rename itself must reach the disk too.
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Removes temporary files that a crash left next to the store.
fn remove_stale_tmp_files(path: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!("{}.tmp-", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(&prefix) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() >= STALE_TMP_SECS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// How the bytes on disk were understood.
enum Parsed {
    Ok(OnDisk),
    /// Written by a newer app: never rewrite it.
    Newer(u8, Option<OnDisk>),
    Corrupt(String),
}

fn parse_store(bytes: &[u8]) -> Parsed {
    let raw: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return Parsed::Corrupt(format!("not valid JSON: {e}")),
    };
    let version = raw.get("v").and_then(Value::as_u64);
    if let Some(v) = version.filter(|v| *v > FORMAT_VERSION as u64) {
        let v = u8::try_from(v).unwrap_or(u8::MAX);
        return Parsed::Newer(v, serde_json::from_value(raw).ok());
    }
    match serde_json::from_value::<OnDisk>(raw) {
        Ok(d) => Parsed::Ok(d),
        Err(e) => Parsed::Corrupt(format!("unexpected layout: {e}")),
    }
}

impl LocalStore {
    /// Opens the store in `dir` with a given key (tests and tools).
    #[cfg(test)]
    pub(crate) fn open_at(dir: &Path, key: VaultKey) -> Result<Self, String> {
        Self::open(dir.join(FILE_NAME), key, Vec::new())
    }

    fn open(path: PathBuf, key: VaultKey, older: Vec<VaultKey>) -> Result<Self, String> {
        remove_stale_tmp_files(&path);
        let mut read_only = None;
        let mut quarantined = None;
        let sealed: OnDisk = match std::fs::read(&path) {
            Ok(bytes) => match parse_store(&bytes) {
                Parsed::Ok(d) => d,
                Parsed::Newer(v, d) => {
                    read_only = Some(format!(
                        "This data was saved by a newer version of PromptOps (format {v}). Update the app to change it."
                    ));
                    d.unwrap_or_default()
                }
                Parsed::Corrupt(reason) => {
                    // Never overwrite what we cannot read: move it aside, keep
                    // every byte, start empty and say so.
                    let aside = path.with_file_name(format!(
                        "{FILE_NAME}.corrupt-{}",
                        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
                    ));
                    std::fs::rename(&path, &aside).map_err(|e| {
                        format!("local store unreadable ({reason}) and could not be set aside: {e}")
                    })?;
                    eprintln!(
                        "[local-store] {} is unreadable ({reason}); moved to {} and starting empty",
                        path.display(),
                        aside.display()
                    );
                    quarantined = Some(aside);
                    OnDisk {
                        v: FORMAT_VERSION,
                        ..Default::default()
                    }
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => OnDisk {
                v: FORMAT_VERSION,
                ..Default::default()
            },
            Err(e) => return Err(e.to_string()),
        };
        let mut data = BTreeMap::new();
        for (collection, records) in &sealed.records {
            let mut out = BTreeMap::new();
            for (id, env) in records {
                let sealed_with = std::iter::once(&key)
                    .chain(&older)
                    .find(|k| k.kid() == env.kid)
                    .unwrap_or(&key);
                match vault::open_json(sealed_with, collection, id, env) {
                    Ok(value) => {
                        out.insert(id.clone(), value);
                    }
                    // A record that does not open is kept sealed on disk and skipped,
                    // never deleted: it may belong to a key the user can restore.
                    Err(err) => eprintln!("[local-store] skipped {collection}/{id}: {err}"),
                }
            }
            data.insert(collection.clone(), out);
        }
        Ok(Self {
            path,
            key,
            older,
            data: Mutex::new(data),
            sealed: Mutex::new(sealed),
            write_lock: Mutex::new(()),
            read_only,
            quarantined,
            _owner_lock: None,
        })
    }

    /// What happened at open: quarantined file, read-only reason, records
    /// that do not open.
    pub fn health(&self) -> StoreHealth {
        StoreHealth {
            quarantined: self
                .quarantined
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            read_only: self.read_only.clone(),
            unreadable: self.unreadable_count(),
            format_version: FORMAT_VERSION,
        }
    }

    fn check_writable(&self) -> Result<(), String> {
        match &self.read_only {
            Some(reason) => Err(reason.clone()),
            None => Ok(()),
        }
    }

    /// All records of a collection, in id order (ids are time-ordered).
    pub fn list(&self, collection: &str) -> Vec<Value> {
        self.data
            .lock()
            .get(collection)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get(&self, collection: &str, id: &str) -> Option<Value> {
        self.data
            .lock()
            .get(collection)
            .and_then(|m| m.get(id).cloned())
    }

    /// Inserts or replaces a record and saves the store.
    pub fn put(&self, collection: &str, id: &str, value: Value) -> Result<(), String> {
        self.check_writable()?;
        check_kind(collection)?;
        let env = vault::seal_json(&self.key, collection, id, &value).map_err(|e| e.to_string())?;
        self.data
            .lock()
            .entry(collection.to_string())
            .or_default()
            .insert(id.to_string(), value);
        self.sealed
            .lock()
            .records
            .entry(collection.to_string())
            .or_default()
            .insert(id.to_string(), env);
        self.save()
    }

    pub fn delete(&self, collection: &str, id: &str) -> Result<(), String> {
        self.check_writable()?;
        if let Some(m) = self.data.lock().get_mut(collection) {
            m.remove(id);
        }
        if let Some(m) = self.sealed.lock().records.get_mut(collection) {
            m.remove(id);
        }
        self.save()
    }

    /// Runs `f` with the saves of this store deferred on this thread, then
    /// writes the file once if anything changed. A call that changes many
    /// records (reorder, persist of every session) costs one write instead of
    /// one per record, and lands on disk all together or not at all. The
    /// second value is the outcome of that final write. Nested batches join
    /// the outer one.
    pub fn batch<R>(&self, f: impl FnOnce() -> R) -> (R, Result<(), String>) {
        let me = self as *const Self as usize;
        let nested = DEFERRED.with(|d| {
            let mut d = d.borrow_mut();
            match *d {
                Some((addr, _)) if addr == me => true,
                _ => {
                    *d = Some((me, false));
                    false
                }
            }
        });
        if nested {
            return (f(), Ok(()));
        }
        /// Clears the flag even if `f` panics, and still saves what changed:
        /// a pooled thread must never keep deferring saves.
        struct Guard<'a>(&'a LocalStore, Option<Result<(), String>>);
        impl Guard<'_> {
            fn finish(&mut self) -> Result<(), String> {
                let dirty = DEFERRED
                    .with(|d| d.borrow_mut().take())
                    .is_some_and(|(_, dirty)| dirty);
                if dirty {
                    self.0.write_now()
                } else {
                    Ok(())
                }
            }
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                if self.1.is_none() {
                    let _ = self.finish();
                }
            }
        }
        let mut guard = Guard(self, None);
        let out = f();
        let saved = guard.finish();
        guard.1 = Some(saved.clone());
        (out, saved)
    }

    /// Encrypts data that lives outside the store file (terminal history),
    /// bound to `kind` and `id` like a record. Returns the envelope as JSON.
    pub fn seal_blob(&self, kind: &str, id: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        check_kind(kind)?;
        let env = vault::seal(&self.key, kind, id, plaintext).map_err(|e| e.to_string())?;
        serde_json::to_vec(&env).map_err(|e| e.to_string())
    }

    /// Opens what `seal_blob` produced, with whichever key of this device
    /// sealed it; `None` if it does not authenticate.
    pub fn open_blob(&self, kind: &str, id: &str, sealed: &[u8]) -> Option<Vec<u8>> {
        let env: Envelope = serde_json::from_slice(sealed).ok()?;
        let key = std::iter::once(&self.key)
            .chain(&self.older)
            .find(|k| k.kid() == env.kid)
            .unwrap_or(&self.key);
        vault::open(key, kind, id, &env).ok()
    }

    /// Every record this device can open, decrypted (backup export).
    pub fn snapshot(&self) -> BTreeMap<String, BTreeMap<String, Value>> {
        self.data.lock().clone()
    }

    /// How many records are on disk but could not be opened with this
    /// device's keys (they stay sealed, see `open`).
    pub fn unreadable_count(&self) -> usize {
        let data = self.data.lock();
        let sealed = self.sealed.lock();
        sealed
            .records
            .iter()
            .map(|(c, m)| {
                let open = data.get(c);
                m.keys()
                    .filter(|id| open.is_none_or(|o| !o.contains_key(*id)))
                    .count()
            })
            .sum()
    }

    /// The folder that holds the store file.
    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or(Path::new("."))
    }

    /// Replaces every record with `records`, sealed with this device's key
    /// (backup import). The current file is first copied to `previous_copy`.
    /// With `keep_unreadable`, records this device cannot open stay on disk
    /// as they are. The new file replaces the old one atomically. Returns
    /// whether there was a file to copy.
    pub fn replace_all(
        &self,
        records: BTreeMap<String, BTreeMap<String, Value>>,
        keep_unreadable: bool,
        previous_copy: &Path,
    ) -> Result<bool, String> {
        self.check_writable()?;
        let mut fresh: BTreeMap<String, BTreeMap<String, Envelope>> = BTreeMap::new();
        for (collection, items) in &records {
            let out = fresh.entry(collection.clone()).or_default();
            for (id, value) in items {
                let env = vault::seal_json(&self.key, collection, id, value)
                    .map_err(|e| e.to_string())?;
                out.insert(id.clone(), env);
            }
        }
        let _write = self.write_lock.lock();
        let mut data = self.data.lock();
        let mut sealed = self.sealed.lock();
        if keep_unreadable {
            for (collection, items) in &sealed.records {
                let open = data.get(collection);
                for (id, env) in items {
                    let readable = open.is_some_and(|o| o.contains_key(id));
                    if !readable && !records.get(collection).is_some_and(|r| r.contains_key(id)) {
                        fresh
                            .entry(collection.clone())
                            .or_default()
                            .insert(id.clone(), env.clone());
                    }
                }
            }
        }
        let copied = match std::fs::read(&self.path) {
            Ok(bytes) => {
                write_private(previous_copy, &bytes)?;
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.to_string()),
        };
        let next = OnDisk {
            v: FORMAT_VERSION,
            records: fresh,
        };
        let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
        replace_file_private(&self.path, &bytes)?;
        *sealed = next;
        *data = records;
        Ok(copied)
    }

    fn save(&self) -> Result<(), String> {
        self.check_writable()?;
        let me = self as *const Self as usize;
        let deferred = DEFERRED.with(|d| match d.borrow_mut().as_mut() {
            Some((addr, dirty)) if *addr == me => {
                *dirty = true;
                true
            }
            _ => false,
        });
        if deferred {
            return Ok(());
        }
        self.write_now()
    }

    /// Writes the current state. The snapshot is taken under `write_lock`, so
    /// two saves racing can never leave the older state as the last rename.
    fn write_now(&self) -> Result<(), String> {
        self.check_writable()?;
        let _write = self.write_lock.lock();
        let bytes = {
            let mut sealed = self.sealed.lock();
            sealed.v = FORMAT_VERSION;
            serde_json::to_vec(&*sealed).map_err(|e| e.to_string())?
        };
        replace_file_private(&self.path, &bytes)
    }
}

/// The vault binds `prefix|kind|id` as authenticated data. With no `|` in the
/// kind (collection name) that string splits one way only, so a record can
/// never be moved to another (kind, id) pair whose joined form is the same.
fn check_kind(kind: &str) -> Result<(), String> {
    if kind.is_empty() || kind.contains('|') {
        return Err(format!("invalid collection name {kind:?}"));
    }
    Ok(())
}

/// New record id: 26-character ULID, sortable by creation time like the ids
/// the hosted edition uses, so the app's ordering assumptions still hold.
pub fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut random = [0u8; 10];
    let _ = getrandom::fill(&mut random);
    let mut value: u128 = (ms as u128) << 80;
    for (i, b) in random.iter().enumerate() {
        value |= (*b as u128) << (8 * (9 - i));
    }
    (0..26)
        .rev()
        .map(|i| ALPHABET[((value >> (5 * i)) & 31) as usize] as char)
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Fresh scratch folder under the system temp dir (no extra test crates needed).
    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("promptops-local-store-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(dir: &Path) -> LocalStore {
        LocalStore::open(
            dir.join(FILE_NAME),
            VaultKey::from_bytes([9; 32]),
            Vec::new(),
        )
        .unwrap()
    }

    #[test]
    fn records_survive_a_restart_and_are_encrypted_on_disk() {
        let dir = tmp();
        let s = store(&dir);
        s.put(
            "sessions",
            "01a",
            json!({ "name": "acme-api", "workspace_path": "/Users/alice/acme" }),
        )
        .unwrap();
        let on_disk = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(!on_disk.contains("acme") && !on_disk.contains("alice"));
        let again = store(&dir);
        assert_eq!(again.get("sessions", "01a").unwrap()["name"], "acme-api");
    }

    #[test]
    fn collection_names_that_would_make_the_aad_ambiguous_are_refused() {
        let dir = tmp();
        let s = store(&dir);
        // ("a|b", "c") and ("a", "b|c") would share the authenticated data.
        assert!(s.put("a|b", "c", json!({ "x": 1 })).is_err());
        assert!(s.put("", "c", json!({ "x": 1 })).is_err());
        assert!(s.seal_blob("a|b", "c", b"x").is_err());
        assert!(s.put("a", "b|c", json!({ "x": 1 })).is_ok());
        assert!(s.get("a|b", "c").is_none());
    }

    #[test]
    fn delete_removes_the_record() {
        let dir = tmp();
        let s = store(&dir);
        s.put("prompts", "1", json!({ "title": "x" })).unwrap();
        s.delete("prompts", "1").unwrap();
        assert!(store(&dir).get("prompts", "1").is_none());
    }

    #[test]
    fn a_record_moved_to_another_id_does_not_open() {
        let dir = tmp();
        let s = store(&dir);
        s.put("sessions", "a", json!({ "name": "secret" })).unwrap();
        let path = dir.join(FILE_NAME);
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"a\":", "\"b\":");
        std::fs::write(&path, text).unwrap();
        let again = store(&dir);
        assert!(again.get("sessions", "b").is_none());
    }

    #[test]
    fn ids_are_unique_and_time_ordered() {
        let a = new_id();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = new_id();
        assert_eq!(a.len(), 26);
        assert!(a < b);
    }

    #[test]
    fn records_sealed_with_an_older_key_stay_readable() {
        let dir = tmp();
        let old = VaultKey::from_bytes([1; 32]);
        let new = VaultKey::from_bytes([2; 32]);
        LocalStore::open_at(&dir, VaultKey::from_bytes([1; 32]))
            .unwrap()
            .put("sessions", "a", json!({"name": "before"}))
            .unwrap();

        let store = LocalStore::open(dir.join(FILE_NAME), new, vec![old]).unwrap();
        assert_eq!(store.get("sessions", "a").unwrap()["name"], "before");
        store
            .put("sessions", "b", json!({"name": "after"}))
            .unwrap();

        let reopened = LocalStore::open(
            dir.join(FILE_NAME),
            VaultKey::from_bytes([2; 32]),
            vec![VaultKey::from_bytes([1; 32])],
        )
        .unwrap();
        assert_eq!(reopened.list("sessions").len(), 2);
        // Without the older key the record is skipped, not lost.
        let without = LocalStore::open_at(&dir, VaultKey::from_bytes([2; 32])).unwrap();
        assert_eq!(without.list("sessions").len(), 1);
        assert_eq!(without.health().unreadable, 1);
        assert!(std::fs::read_to_string(dir.join(FILE_NAME))
            .unwrap()
            .contains("\"a\""));
    }

    #[test]
    fn blobs_sealed_with_an_older_key_stay_readable() {
        let dir = tmp();
        let old = LocalStore::open_at(&dir, VaultKey::from_bytes([1; 32])).unwrap();
        let blob = old.seal_blob("parked-buffer", "s1", b"history").unwrap();
        let new = LocalStore::open(
            dir.join(FILE_NAME),
            VaultKey::from_bytes([2; 32]),
            vec![VaultKey::from_bytes([1; 32])],
        )
        .unwrap();
        assert_eq!(
            new.open_blob("parked-buffer", "s1", &blob).as_deref(),
            Some(&b"history"[..])
        );
        assert!(new.open_blob("parked-buffer", "s2", &blob).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp();
        let path = dir.join(KEY_FILE_NAME);
        let k1 = load_or_create_key_file(&path).unwrap();
        let k2 = load_or_create_key_file(&path).unwrap();
        assert_eq!(k1.kid(), k2.kid());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn a_truncated_store_is_set_aside_with_every_byte_and_reported() {
        let dir = tmp();
        let s = store(&dir);
        for i in 0..20 {
            s.put("prompts", &i.to_string(), json!({ "title": i }))
                .unwrap();
        }
        drop(s);
        let path = dir.join(FILE_NAME);
        let bytes = std::fs::read(&path).unwrap();
        let cut = &bytes[..bytes.len() / 2];
        std::fs::write(&path, cut).unwrap();

        let again = store(&dir);
        let health = again.health();
        let aside = PathBuf::from(health.quarantined.expect("quarantined"));
        assert_eq!(std::fs::read(&aside).unwrap(), cut, "no byte is lost");
        assert!(again.list("prompts").is_empty());
        assert!(health.read_only.is_none());
        // The empty store is usable and does not touch the quarantined copy.
        again
            .put("prompts", "new", json!({ "title": "n" }))
            .unwrap();
        assert_eq!(std::fs::read(&aside).unwrap(), cut);
        assert!(store(&dir).health().quarantined.is_none());
    }

    #[test]
    fn garbage_and_wrong_layout_are_quarantined_too() {
        for junk in [
            &b"\0\0\0garbage"[..],
            &b"{\"v\":1,\"records\":[1,2]}"[..],
            b"",
        ] {
            let dir = tmp();
            std::fs::write(dir.join(FILE_NAME), junk).unwrap();
            let s = store(&dir);
            assert!(s.health().quarantined.is_some(), "{junk:?}");
            assert!(s.list("sessions").is_empty());
        }
    }

    #[test]
    fn a_store_from_a_newer_version_opens_read_only_and_is_never_rewritten() {
        let dir = tmp();
        store(&dir)
            .put("sessions", "a", json!({ "name": "kept" }))
            .unwrap();
        let path = dir.join(FILE_NAME);
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replacen("\"v\":1", "\"v\":2", 1);
        std::fs::write(&path, &text).unwrap();

        let s = store(&dir);
        assert!(s.health().read_only.is_some());
        assert!(s.health().quarantined.is_none());
        assert_eq!(s.get("sessions", "a").unwrap()["name"], "kept");
        assert!(s.put("sessions", "b", json!({})).is_err());
        assert!(s.delete("sessions", "a").is_err());
        assert!(s
            .replace_all(BTreeMap::new(), false, &dir.join("prev.json"))
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        // Nothing was loaded into memory by the refused writes either.
        assert!(s.get("sessions", "b").is_none());
    }

    #[test]
    fn concurrent_writers_never_lose_a_record_on_disk() {
        let dir = tmp();
        let s = std::sync::Arc::new(store(&dir));
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let s = s.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        s.put("notes", &format!("{t}-{i}"), json!({ "t": t, "i": i }))
                            .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(store(&dir).list("notes").len(), 200);
        // No temporary file is left behind.
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_batch_writes_once_and_a_panic_does_not_leave_saves_deferred() {
        let dir = tmp();
        let s = store(&dir);
        let path = dir.join(FILE_NAME);
        let ((), saved) = s.batch(|| {
            for i in 0..5 {
                s.put("folders", &i.to_string(), json!({ "i": i })).unwrap();
            }
            // Nothing on disk until the batch ends.
            assert!(!path.exists());
        });
        saved.unwrap();
        assert_eq!(store(&dir).list("folders").len(), 5);

        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            s.batch(|| {
                s.put("folders", "boom", json!({})).unwrap();
                panic!("handler bug");
            })
        }));
        assert!(caught.is_err());
        // The change made before the panic was still written...
        assert!(store(&dir).get("folders", "boom").is_some());
        // ...and later saves on this thread go straight to disk again.
        s.put("folders", "after", json!({})).unwrap();
        assert!(store(&dir).get("folders", "after").is_some());
    }

    #[test]
    fn stale_temporary_files_are_removed_at_open_fresh_ones_are_kept() {
        let dir = tmp();
        let stale = dir.join(format!("{FILE_NAME}.tmp-old"));
        let fresh = dir.join(format!("{FILE_NAME}.tmp-new"));
        std::fs::write(&stale, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(past)
            .unwrap();
        let _ = store(&dir);
        assert!(!stale.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn a_second_running_copy_cannot_take_the_owner_lock() {
        let dir = tmp();
        let (first, busy) = take_owner_lock(&dir);
        assert!(first.is_some() && !busy);
        let (second, busy) = take_owner_lock(&dir);
        assert!(second.is_none() && busy);
        drop(first);
        // A process forked by a concurrent test can hold the lock's file
        // description for a moment before its exec closes it: retry briefly.
        let mut third = take_owner_lock(&dir);
        for _ in 0..100 {
            if third.0.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
            third = take_owner_lock(&dir);
        }
        assert!(third.0.is_some() && !third.1);
    }
}
