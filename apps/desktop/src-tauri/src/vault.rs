//! Session Vault: encrypts sensitive session data on the device.
//!
//! Session names, paths, repository URLs, CLI conversation ids and UI state are
//! sealed into a versioned envelope before they are stored or synced. The key
//! (256 bits, random) lives in the OS keychain and never leaves the device in
//! clear. Where no keychain can be used (and in debug builds) the local store
//! keeps it in `vault.key` next to its data, readable only by the user, and
//! Settings → About says so (`local_store.rs`, `load_keys`).
//!
//! Envelope: `{"v":1,"alg":"A256GCM","kid":"…","n":"<nonce b64>","ct":"<ciphertext b64>"}`.
//! - AES-256-GCM with a fresh random 96-bit nonce for every seal.
//! - Additional authenticated data binds the ciphertext to its record:
//!   `promptops/vault/v1|<kind>|<id>`. Moving an envelope to another record or
//!   another kind of record makes decryption fail.
//! - `kid` identifies the key without revealing it, so a device can tell a
//!   foreign envelope from a corrupted one.
//!
//! Design and threat model: `docs/open-source/SESSION_VAULT.md`.

// Not every helper is used by the local store yet (the sync uses them next).
#![allow(dead_code)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const FORMAT_VERSION: u8 = 1;
pub const ALGORITHM: &str = "A256GCM";
const AAD_PREFIX: &str = "promptops/vault/v1";
const KID_LABEL: &[u8] = b"promptops/vault/kid";
const NONCE_LEN: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    UnsupportedVersion(u8),
    UnsupportedAlgorithm(String),
    KeyMismatch,
    Malformed(&'static str),
    Decrypt,
    Encrypt,
    Random(String),
    Keychain(String),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(v) => write!(f, "unsupported vault envelope version {v}"),
            Self::UnsupportedAlgorithm(a) => write!(f, "unsupported vault algorithm {a}"),
            Self::KeyMismatch => write!(f, "envelope was sealed with a different key"),
            Self::Malformed(what) => write!(f, "malformed vault envelope: {what}"),
            Self::Decrypt => write!(f, "vault envelope failed authentication"),
            Self::Encrypt => write!(f, "vault encryption failed"),
            Self::Random(e) => write!(f, "secure random numbers unavailable: {e}"),
            Self::Keychain(e) => write!(f, "OS keychain unavailable: {e}"),
        }
    }
}

impl std::error::Error for VaultError {}

/// The user's data key. Zeroed on drop.
pub struct VaultKey([u8; 32]);

impl VaultKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn generate() -> Result<Self, VaultError> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| VaultError::Random(e.to_string()))?;
        Ok(Self(bytes))
    }

    /// Public key id: first 8 bytes of SHA-256 over a fixed label and the key, hex encoded.
    pub fn kid(&self) -> String {
        let mut h = Sha256::new();
        h.update(KID_LABEL);
        h.update(self.0);
        h.finalize()[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new((&self.0).into())
    }

    pub(crate) fn to_b64(&self) -> String {
        B64.encode(self.0)
    }

    fn from_b64(s: &str) -> Option<Self> {
        let mut bytes = B64.decode(s.trim()).ok()?;
        let key = <[u8; 32]>::try_from(bytes.as_slice()).ok().map(Self);
        wipe_bytes(&mut bytes);
        key
    }
}

/// Overwrites bytes before they are freed. Volatile writes, so the compiler
/// cannot drop the zeroing as a dead store.
fn wipe_bytes(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

/// Overwrites a string holding key material (the base64 form of the key that
/// travels to and from the keychain) before it is freed.
pub(crate) fn wipe_string(s: &mut str) {
    // SAFETY: zero bytes are valid UTF-8, so the string stays well formed.
    wipe_bytes(unsafe { s.as_bytes_mut() });
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        for b in self.0.iter_mut() {
            // Volatile write so the compiler cannot drop the zeroing as a dead store.
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

impl fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VaultKey({})", self.kid())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub alg: String,
    pub kid: String,
    pub n: String,
    pub ct: String,
}

fn aad(kind: &str, id: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}|{kind}|{id}").into_bytes()
}

/// Seals `plaintext` for the record `(kind, id)`.
pub fn seal(
    key: &VaultKey,
    kind: &str,
    id: &str,
    plaintext: &[u8],
) -> Result<Envelope, VaultError> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|e| VaultError::Random(e.to_string()))?;
    seal_with_nonce(key, kind, id, plaintext, nonce)
}

fn seal_with_nonce(
    key: &VaultKey,
    kind: &str,
    id: &str,
    plaintext: &[u8],
    nonce: [u8; NONCE_LEN],
) -> Result<Envelope, VaultError> {
    let aad = aad(kind, id);
    let ct = key
        .cipher()
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| VaultError::Encrypt)?;
    Ok(Envelope {
        v: FORMAT_VERSION,
        alg: ALGORITHM.to_string(),
        kid: key.kid(),
        n: B64.encode(nonce),
        ct: B64.encode(ct),
    })
}

/// Opens an envelope sealed for the record `(kind, id)`.
pub fn open(key: &VaultKey, kind: &str, id: &str, env: &Envelope) -> Result<Vec<u8>, VaultError> {
    if env.v != FORMAT_VERSION {
        return Err(VaultError::UnsupportedVersion(env.v));
    }
    if env.alg != ALGORITHM {
        return Err(VaultError::UnsupportedAlgorithm(env.alg.clone()));
    }
    if env.kid != key.kid() {
        return Err(VaultError::KeyMismatch);
    }
    let nonce = B64
        .decode(&env.n)
        .map_err(|_| VaultError::Malformed("nonce is not base64"))?;
    let nonce: [u8; NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| VaultError::Malformed("nonce length"))?;
    let ct = B64
        .decode(&env.ct)
        .map_err(|_| VaultError::Malformed("ciphertext is not base64"))?;
    let aad = aad(kind, id);
    key.cipher()
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &ct,
                aad: &aad,
            },
        )
        .map_err(|_| VaultError::Decrypt)
}

/// Seals a JSON value (the usual shape of a record's sensitive fields).
pub fn seal_json(
    key: &VaultKey,
    kind: &str,
    id: &str,
    value: &serde_json::Value,
) -> Result<Envelope, VaultError> {
    let bytes = serde_json::to_vec(value).map_err(|_| VaultError::Encrypt)?;
    seal(key, kind, id, &bytes)
}

pub fn open_json(
    key: &VaultKey,
    kind: &str,
    id: &str,
    env: &Envelope,
) -> Result<serde_json::Value, VaultError> {
    let bytes = open(key, kind, id, env)?;
    serde_json::from_slice(&bytes).map_err(|_| VaultError::Malformed("payload is not JSON"))
}

/// Reads the data key from the OS keychain without creating one.
pub fn read_key(service: &str) -> Result<Option<VaultKey>, VaultError> {
    let entry = keyring::Entry::new(service, "session-vault")
        .map_err(|e| VaultError::Keychain(e.to_string()))?;
    match entry.get_password() {
        Ok(mut stored) => {
            let key = VaultKey::from_b64(&stored);
            wipe_string(&mut stored);
            key.map(Some)
                .ok_or_else(|| VaultError::Keychain("stored vault key is invalid".into()))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(VaultError::Keychain(e.to_string())),
    }
}

/// Loads the data key from the OS keychain, creating it on first use.
///
/// `service` must be derived from the app identifier, so that two editions
/// installed side by side never share a key.
pub fn load_or_create_key(service: &str) -> Result<VaultKey, VaultError> {
    const ACCOUNT: &str = "session-vault";
    let entry =
        keyring::Entry::new(service, ACCOUNT).map_err(|e| VaultError::Keychain(e.to_string()))?;
    match entry.get_password() {
        Ok(mut stored) => {
            let key = VaultKey::from_b64(&stored);
            wipe_string(&mut stored);
            key.ok_or_else(|| VaultError::Keychain("stored vault key is invalid".into()))
        }
        Err(keyring::Error::NoEntry) => {
            let key = VaultKey::generate()?;
            let mut encoded = key.to_b64();
            let stored = entry.set_password(&encoded);
            wipe_string(&mut encoded);
            stored.map_err(|e| VaultError::Keychain(e.to_string()))?;
            Ok(key)
        }
        Err(e) => Err(VaultError::Keychain(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    fn key(byte: u8) -> VaultKey {
        VaultKey::from_bytes([byte; 32])
    }

    #[test]
    fn roundtrip() {
        let k = key(7);
        let env = seal(&k, "session", "s-1", b"/Users/alice/acme").unwrap();
        assert_eq!(
            open(&k, "session", "s-1", &env).unwrap(),
            b"/Users/alice/acme"
        );
    }

    #[test]
    fn json_roundtrip() {
        let k = key(7);
        let value =
            json!({ "name": "acme-api", "workspace_path": "/Users/alice/acme", "repo_url": null });
        let env = seal_json(&k, "session", "s-1", &value).unwrap();
        assert_eq!(open_json(&k, "session", "s-1", &env).unwrap(), value);
    }

    #[test]
    fn envelope_is_bound_to_its_record() {
        let k = key(7);
        let env = seal(&k, "session", "s-1", b"secret").unwrap();
        assert_eq!(open(&k, "session", "s-2", &env), Err(VaultError::Decrypt));
        assert_eq!(open(&k, "workspace", "s-1", &env), Err(VaultError::Decrypt));
    }

    #[test]
    fn other_key_is_rejected_before_decrypting() {
        let env = seal(&key(7), "session", "s-1", b"secret").unwrap();
        assert_eq!(
            open(&key(8), "session", "s-1", &env),
            Err(VaultError::KeyMismatch)
        );
    }

    #[test]
    fn tampering_is_detected() {
        let k = key(7);
        let mut env = seal(&k, "session", "s-1", b"secret").unwrap();
        let mut ct = B64.decode(&env.ct).unwrap();
        ct[0] ^= 1;
        env.ct = B64.encode(ct);
        assert_eq!(open(&k, "session", "s-1", &env), Err(VaultError::Decrypt));
    }

    #[test]
    fn unknown_version_and_algorithm_are_rejected() {
        let k = key(7);
        let env = seal(&k, "session", "s-1", b"secret").unwrap();
        let v2 = Envelope {
            v: 2,
            ..env.clone()
        };
        assert_eq!(
            open(&k, "session", "s-1", &v2),
            Err(VaultError::UnsupportedVersion(2))
        );
        let other = Envelope {
            alg: "A128GCM".into(),
            ..env
        };
        assert!(matches!(
            open(&k, "session", "s-1", &other),
            Err(VaultError::UnsupportedAlgorithm(_))
        ));
    }

    #[test]
    fn nonces_are_unique() {
        let k = key(7);
        let nonces: HashSet<String> = (0..2000)
            .map(|_| seal(&k, "session", "s-1", b"x").unwrap().n)
            .collect();
        assert_eq!(nonces.len(), 2000);
    }

    #[test]
    fn ciphertext_does_not_contain_the_plaintext() {
        let k = key(7);
        let env = seal(&k, "session", "s-1", b"/Users/alice/acme").unwrap();
        let wire = serde_json::to_string(&env).unwrap();
        assert!(!wire.contains("alice") && !wire.contains("acme"));
    }

    #[test]
    fn kid_is_stable_and_does_not_reveal_the_key() {
        let k = key(7);
        assert_eq!(k.kid(), key(7).kid());
        assert_ne!(k.kid(), key(8).kid());
        assert_eq!(k.kid().len(), 16);
        assert!(!format!("{k:?}").contains(&B64.encode([7u8; 32])));
    }

    #[test]
    fn wiped_key_strings_hold_only_zeros() {
        let mut encoded = key(42).to_b64();
        let len = encoded.len();
        wipe_string(&mut encoded);
        assert_eq!(encoded.len(), len);
        assert!(encoded.bytes().all(|b| b == 0));
    }

    #[test]
    fn key_encoding_roundtrip() {
        let k = key(42);
        let back = VaultKey::from_b64(&k.to_b64()).unwrap();
        assert_eq!(back.kid(), k.kid());
        assert!(VaultKey::from_b64("not a key").is_none());
    }

    /// Fixed test vector, cross-checked with Python `cryptography` (AESGCM),
    /// so other implementations can verify compatibility.
    #[test]
    fn known_answer_vector() {
        let k = VaultKey::from_bytes(core::array::from_fn(|i| i as u8));
        let nonce: [u8; NONCE_LEN] = core::array::from_fn(|i| 0xa0 + i as u8);
        let env = seal_with_nonce(
            &k,
            "session",
            "00000000-0000-4000-8000-000000000001",
            br#"{"name":"demo"}"#,
            nonce,
        )
        .unwrap();
        assert_eq!(env.n, KNOWN_NONCE);
        assert_eq!(env.kid, KNOWN_KID);
        assert_eq!(env.ct, KNOWN_CT);
        assert_eq!(
            open(&k, "session", "00000000-0000-4000-8000-000000000001", &env).unwrap(),
            br#"{"name":"demo"}"#
        );
    }

    /// Performance guard: `cargo test --release --lib vault::tests::perf -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_seal_and_open_session_records() {
        let k = key(7);
        let value = json!({
            "name": "acme-payments-api",
            "workspace_path": "/Users/alice/clients/acme/payments-api",
            "workspace_name": "payments-api",
            "repo_url": "git@github.com:acme/payments-api.git",
            "repo_branch": "feature/settlement-v2",
            "config": { "cwd": "/Users/alice/clients/acme/payments-api", "cols": 160, "rows": 48 },
        });
        let n = 10_000;
        let t = std::time::Instant::now();
        let envs: Vec<Envelope> = (0..n)
            .map(|i| seal_json(&k, "session", &i.to_string(), &value).unwrap())
            .collect();
        let seal = t.elapsed();
        let t = std::time::Instant::now();
        for (i, e) in envs.iter().enumerate() {
            open_json(&k, "session", &i.to_string(), e).unwrap();
        }
        let open = t.elapsed();
        let plain = serde_json::to_vec(&value).unwrap().len();
        let wire = serde_json::to_vec(&envs[0]).unwrap().len();
        println!(
            "{n} records: seal {:.2} µs/record, open {:.2} µs/record, size {plain} B → {wire} B",
            seal.as_secs_f64() * 1e6 / n as f64,
            open.as_secs_f64() * 1e6 / n as f64,
        );
    }

    const KNOWN_NONCE: &str = "oKGio6Slpqeoqaqr";
    const KNOWN_KID: &str = "25cb0762909ed2e1";
    const KNOWN_CT: &str = "nToSTCiuIIVAAeK+aFi9oNjHF/+XAlpNVnK+g4nDUA==";
}
