//! WebKitGTK environment for the Linux AppImage, applied in `run()` BEFORE
//! GTK/WebKit (and before any other threads exist: `set_var` is not thread-safe).
//!
//! The AppImage bundles Ubuntu 22.04's WebKitGTK (Skia + libstdc++
//! assertions enabled) but uses the host system's FreeType/fontconfig. On recent
//! distros (Fedora ≥ 39) the system emoji font is Noto Color Emoji **COLRv1** and
//! Skia aborts on the first emoji glyph:
//!   stl_vector.h:1123 … colrv1_configure_skpaint … Assertion '__n < this->size()' failed.
//! (fb Fedora + RTX 5060, 26/09/2026). Fix: a fonts.conf that includes the system
//! one and rejects fonts with a COLR v1 table → emoji fall back to another
//! font (bitmap CBDT or monochrome) instead of killing the WebProcess.
//!
//! Also, with the proprietary NVIDIA driver the WebKitGTK DMA-BUF renderer is
//! the known cause of a slow UI/white window → WEBKIT_DISABLE_DMABUF_RENDERER=1.
//!
//! User overrides (all respected if already set):
//!   PROMPTOPS_KEEP_COLRV1=1        doesn't touch fontconfig
//!   WEBKIT_DISABLE_DMABUF_RENDERER already set → left as is
//!   PROMPTOPS_WAYLAND=1/0          forces Wayland / X11. Default: native Wayland if the
//!                                  session is Wayland (the AppImage gtk hook forces x11,
//!                                  and WebKitGTK via XWayland is noticeably less smooth —
//!                                  Linux user fb 2.1.2, 03/10/2026)
//!   FONTCONFIG_FILE already set    → left as is
//!   PROMPTOPS_GPU=0 / auto         WebKit acceleration NEVER / WebKit default
//!                                  (PromptOps default: ALWAYS, see `tune_webview`)

use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Variables this module set for the app's own webview: children must not
/// inherit them (a shell with our FONTCONFIG_FILE or GDK_BACKEND behaves
/// differently from the user's terminal).
static SET_FOR_WEBVIEW: OnceLock<Vec<&'static str>> = OnceLock::new();

pub fn apply() {
    // AppImage only: the .deb uses the distro's WebKitGTK, consistent with its FreeType.
    if env::var_os("APPIMAGE").is_none() {
        let _ = SET_FOR_WEBVIEW.set(Vec::new());
        return;
    }
    // The AppImage GTK hook forces GDK_BACKEND for the bundled GTK: never a
    // user choice, so it is not passed on either.
    let mut ours = vec!["GDK_BACKEND"];
    if want_wayland() {
        env::set_var("GDK_BACKEND", "wayland");
    }
    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && Path::new("/proc/driver/nvidia/version").exists()
    {
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        ours.push("WEBKIT_DISABLE_DMABUF_RENDERER");
    }
    if env::var_os("PROMPTOPS_KEEP_COLRV1").is_none() && env::var_os("FONTCONFIG_FILE").is_none() {
        if let Some(conf) = write_reject_colrv1_conf() {
            env::set_var("FONTCONFIG_FILE", conf);
            ours.push("FONTCONFIG_FILE");
        }
    }
    let _ = SET_FOR_WEBVIEW.set(ours);
}

/// What a child process (PTY shell, agent, opener) must change in the
/// inherited environment to look like a normal launch: see
/// `session::appimage_env_overrides`. Empty outside an AppImage.
pub(crate) fn child_env_overrides() -> Vec<(String, Option<String>)> {
    let appdir = env::var("APPDIR").ok();
    if appdir.is_none() && env::var_os("APPIMAGE").is_none() {
        return Vec::new();
    }
    let vars: Vec<(String, String)> = env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    let ours = SET_FOR_WEBVIEW.get().cloned().unwrap_or_default();
    crate::commands::session::appimage_env_overrides(&vars, appdir.as_deref(), &ours)
}

/// Settings of the main webview, Linux only (.deb too). With the
/// ON_DEMAND policy (the default of WebKitGTK ≤ 2.38, including the one
/// the AppImage brings from Ubuntu 22.04) WebKit enters and leaves accelerated
/// compositing depending on the content: every switch recreates the layers → stutters
/// and flashes. ALWAYS keeps it fixed on the GPU, like Chromium/WebView2.
/// `WEBKIT_DISABLE_COMPOSITING_MODE` set by the user still wins.
pub fn tune_webview(win: &tauri::WebviewWindow) {
    use webkit2gtk::{HardwareAccelerationPolicy as Policy, SettingsExt, WebViewExt};
    if env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some() {
        return;
    }
    let policy = match env::var("PROMPTOPS_GPU").as_deref() {
        Ok("auto") => return,
        Ok("0") => Policy::Never,
        _ => Policy::Always,
    };
    let _ = win.with_webview(move |pw| {
        if let Some(settings) = pw.inner().settings() {
            settings.set_hardware_acceleration_policy(policy);
        }
    });
}

/// Local paths of the last file drag coming from outside the app (file manager).
static DRAG_PATHS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Linux counterpart of the macOS drag pasteboard (`drag_drop_paths`).
/// WebKitGTK (≥ 2.4x) hides the file:// URLs of external drops from the page:
/// `dataTransfer.files` and `text/uri-list` arrive empty, so the Assets panel
/// could not tell which file to import. GTK, however, hands the full uri-list
/// to the webview (`drag-data-received` signal, emitted when WebKit requests the
/// drag data): we read it here before WebKit, without stopping its handling, and
/// keep it for the bridge. Every new drag with a uri-list replaces the list
/// (even with an empty one, e.g. http links), so no stale paths are left behind.
pub fn track_drag_paths(win: &tauri::WebviewWindow) {
    use gtk::prelude::*;
    let _ = win.with_webview(|pw| {
        pw.inner()
            .connect_drag_data_received(|_, _, _, _, data, _, _| {
                let uris = data.uris();
                if uris.is_empty() {
                    return; // not a uri-list (text, html…)
                }
                let paths = uris
                    .iter()
                    .filter_map(|u| gtk::glib::filename_from_uri(u).ok())
                    .map(|(p, _)| p.to_string_lossy().into_owned())
                    .collect();
                if let Ok(mut slot) = DRAG_PATHS.lock() {
                    *slot = paths;
                }
            });
    });
}

/// Paths stored by `track_drag_paths` (empty if the drag carries no local files).
pub fn drag_paths() -> Vec<String> {
    DRAG_PATHS.lock().map(|p| p.clone()).unwrap_or_default()
}

fn want_wayland() -> bool {
    match env::var("PROMPTOPS_WAYLAND").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => {
            env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
                && env::var_os("WAYLAND_DISPLAY").is_some()
        }
    }
}

fn write_reject_colrv1_conf() -> Option<PathBuf> {
    let colrv1 = colrv1_font_files();
    if colrv1.is_empty() {
        return None;
    }
    let dir = env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?
        .join(crate::APP_DIR_NAME);
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("fonts-no-colrv1.conf");
    let system = ["/etc/fonts/fonts.conf", "/usr/share/fontconfig/fonts.conf"]
        .into_iter()
        .find(|p| Path::new(p).exists())?;
    let mut globs = String::new();
    for f in &colrv1 {
        globs.push_str(&format!(
            "      <glob>{}</glob>\n",
            xml_escape(&f.to_string_lossy())
        ));
    }
    let xml = format!(
        "<?xml version=\"1.0\"?>\n<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">\n\
         <!-- Generated by PromptOps: avoids the Skia COLRv1 crash of the bundled WebKitGTK -->\n\
         <fontconfig>\n  <include ignore_missing=\"no\">{system}</include>\n\
         \x20 <selectfont>\n    <rejectfont>\n{globs}    </rejectfont>\n  </selectfont>\n</fontconfig>\n"
    );
    fs::write(&path, xml).ok()?;
    Some(path)
}

/// System font files with a `COLR` table version ≥ 1. Candidates from
/// `fc-list :color=true` (present wherever fontconfig is): only the "color"
/// fonts are opened so as not to read the header of hundreds of files. Without
/// `fc-list` (or if it fails) the standard font directories are scanned:
/// `has_colr_v1` reads a few bytes per file, the cost stays negligible.
fn colrv1_font_files() -> Vec<PathBuf> {
    fc_list_color_fonts()
        .unwrap_or_else(scan_font_dirs)
        .into_iter()
        .filter(|p| has_colr_v1(p).unwrap_or(false))
        .collect()
}

/// `None` = fc-list missing or failed (→ fallback to `scan_font_dirs`);
/// `Some(vec![])` = fontconfig knows no color fonts: nothing to reject.
fn fc_list_color_fonts() -> Option<Vec<PathBuf>> {
    let out = Command::new("fc-list")
        .args([":color=true", "file"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(':').split(':').next())
            .map(|s| PathBuf::from(s.trim()))
            .filter(|p| !p.as_os_str().is_empty())
            .collect(),
    )
}

/// Standard fontconfig font directories (system + user), recursively.
fn scan_font_dirs() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/usr/share/fonts"),
        PathBuf::from("/usr/local/share/fonts"),
    ];
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        roots.push(home.join(".fonts"));
        let data = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        roots.push(data.join("fonts"));
    }
    let mut out = Vec::new();
    for root in roots {
        collect_sfnt_files(&root, &mut out, 0);
    }
    out
}

fn collect_sfnt_files(dir: &Path, out: &mut Vec<PathBuf>, depth: u8) {
    if depth > 8 {
        return; // symlink loop
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_sfnt_files(&p, out, depth + 1);
        } else if p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc"))
        {
            out.push(p);
        }
    }
}

/// Reads the sfnt table directory (and the first face of a .ttc) and checks
/// the version of the `COLR` table.
fn has_colr_v1(path: &Path) -> std::io::Result<bool> {
    let mut f = fs::File::open(path)?;
    let mut hdr = [0u8; 12];
    f.read_exact(&mut hdr)?;
    if &hdr[0..4] == b"ttcf" {
        // Offset of the first face; the table offsets are from the start of the file.
        let mut off = [0u8; 4];
        f.read_exact(&mut off)?;
        f.seek(SeekFrom::Start(u32::from_be_bytes(off) as u64))?;
        f.read_exact(&mut hdr)?;
    }
    let num_tables = u16::from_be_bytes([hdr[4], hdr[5]]) as usize;
    let mut dir = vec![0u8; num_tables * 16];
    f.read_exact(&mut dir)?;
    for rec in dir.chunks_exact(16) {
        if &rec[0..4] == b"COLR" {
            let off = u32::from_be_bytes([rec[8], rec[9], rec[10], rec[11]]) as u64;
            f.seek(SeekFrom::Start(off))?;
            let mut ver = [0u8; 2];
            f.read_exact(&mut ver)?;
            return Ok(u16::from_be_bytes(ver) >= 1);
        }
    }
    Ok(false)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sfnt_with_colr(version: u16) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&[0, 1, 0, 0]); // sfnt version
        v.extend_from_slice(&1u16.to_be_bytes()); // numTables
        v.extend_from_slice(&[0; 6]);
        v.extend_from_slice(b"COLR");
        v.extend_from_slice(&[0; 4]); // checksum
        v.extend_from_slice(&28u32.to_be_bytes()); // offset
        v.extend_from_slice(&2u32.to_be_bytes()); // length
        v.extend_from_slice(&version.to_be_bytes());
        v
    }

    #[test]
    fn detects_colr_version() {
        let dir = std::env::temp_dir();
        for (ver, expected) in [(0u16, false), (1, true)] {
            let p = dir.join(format!("po-colr-test-{ver}.ttf"));
            fs::write(&p, sfnt_with_colr(ver)).unwrap();
            assert_eq!(has_colr_v1(&p).unwrap(), expected);
            let _ = fs::remove_file(p);
        }
    }

    #[test]
    fn scans_font_dirs_recursively() {
        let root = std::env::temp_dir().join(format!("po-fontscan-{}", std::process::id()));
        let sub = root.join("noto/colr");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("Emoji.TTF"), sfnt_with_colr(1)).unwrap();
        fs::write(sub.join("readme.txt"), b"x").unwrap();
        let mut found = Vec::new();
        collect_sfnt_files(&root, &mut found, 0);
        assert_eq!(found, vec![sub.join("Emoji.TTF")]);
        let _ = fs::remove_dir_all(root);
    }
}
