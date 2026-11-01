//! Where termd lives: socket name and token, per platform.
//!
//! Everything derives from the data folder passed by the app (`--dir`), so two
//! editions or profiles get separate termd instances that cannot see each other.
//! - macOS/Linux: Unix socket inside a user-owned 0700 folder.
//! - Windows: named pipe with a name derived from the folder; access is still
//!   tied to the token (the server writes nothing before auth).
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use interprocess::local_socket::Name;

/// Practical `sun_path` limit (104 on macOS, 108 on Linux) with some margin.
#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH: usize = 100;

/// FNV-1a: short, stable names from a folder (not a cryptographic use).
fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// termd folder, created if missing. On Unix it must be 0700 and owned by the
/// user, otherwise it is rejected (another account could read the token or
/// replace the socket).
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let meta = std::fs::metadata(dir)?;
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        if meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "termd folder is not private",
            ));
        }
    }
    Ok(())
}

/// Unix socket path: in the data folder or, if the path exceeds the `sun_path`
/// limit, in a short private folder under /tmp.
#[cfg(unix)]
pub fn socket_path(dir: &Path) -> io::Result<PathBuf> {
    let direct = dir.join("termd.sock");
    if direct.as_os_str().len() <= MAX_UNIX_SOCKET_PATH {
        return Ok(direct);
    }
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let short = PathBuf::from(format!(
        "/tmp/po-termd-{uid}-{}",
        short_hash(&dir.to_string_lossy())
    ));
    ensure_private_dir(&short)?;
    Ok(short.join("s"))
}

/// Socket name for interprocess.
pub fn socket_name(dir: &Path) -> io::Result<Name<'static>> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        socket_path(dir)?
            .to_fs_name::<GenericFilePath>()
            .map(|n| n.into_owned())
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        format!("promptops-termd-{}", short_hash(&dir.to_string_lossy()))
            .to_ns_name::<GenericNamespaced>()
            .map(|n| n.into_owned())
    }
}

pub fn token_path(dir: &Path) -> PathBuf {
    dir.join("termd.token")
}

/// New token on every server start, written readable by the user only.
pub fn write_new_token(dir: &Path) -> io::Result<String> {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let path = token_path(dir);
    let tmp = path.with_extension("token.tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(token.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(token)
}

pub fn read_token(dir: &Path) -> io::Result<String> {
    Ok(std::fs::read_to_string(token_path(dir))?.trim().to_string())
}

/// Constant-time comparison (response timing leaks nothing about the token).
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "ab"));
    }

    #[test]
    fn hash_is_stable_and_short() {
        assert_eq!(short_hash("/a/b"), short_hash("/a/b"));
        assert_ne!(short_hash("/a/b"), short_hash("/a/c"));
        assert_eq!(short_hash("x").len(), 16);
    }

    #[cfg(unix)]
    #[test]
    fn long_dirs_get_a_short_private_socket() {
        let long = std::env::temp_dir().join("x".repeat(120));
        let p = socket_path(&long).unwrap();
        assert!(p.as_os_str().len() <= MAX_UNIX_SOCKET_PATH);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(p.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}
