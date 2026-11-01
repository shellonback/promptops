//! Shell + clipboard + editor — three IPC domains in a single
//! Tauri 2 command module:
//!   - shell:* + clipboard:*
//!   - editor:*
//!
//! Includes path validations and the map of allowed editor commands. All commands return
//! `Result<T, String>` per convention (see terminal.rs).

use std::path::Path;

use serde::Serialize;

// ===========================================================================
// Path validation utilities (port of isSafeDir / isSafeExistingPath)
// ===========================================================================

/// `isSafeDir` — non-empty string ≤4096 chars, absolute, and existing as a dir.
fn is_safe_dir(dir: &str) -> bool {
    if dir.is_empty() || dir.len() > 4096 {
        return false;
    }
    let p = Path::new(dir);
    if !p.is_absolute() {
        return false;
    }
    // Node's `path.resolve` normalizes; we use canonicalize to check that it
    // exists and is actually a directory.
    match std::fs::metadata(p) {
        Ok(md) => md.is_dir(),
        Err(_) => false,
    }
}

/// `isSafeExistingPath` — like above but accepts any existing path
/// (file OR directory): `showItemInFolder` also reveals files.
fn is_safe_existing_path(p: &str) -> bool {
    if p.is_empty() || p.len() > 4096 {
        return false;
    }
    let path = Path::new(p);
    if !path.is_absolute() {
        return false;
    }
    std::fs::metadata(path).is_ok()
}

// ===========================================================================
// shell:show-in-folder
// ===========================================================================

/// shell:show-in-folder — reveals a path in the system file manager
/// (Finder on macOS), highlighting the item. Replicates `shell.showItemInFolder`.
#[tauri::command]
pub async fn shell_show_in_folder(folder_path: String) -> Result<(), String> {
    if !is_safe_existing_path(&folder_path) {
        return Err("invalid path".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // `open -R` reveals and highlights the item in Finder (equivalent to
        // showItemInFolder, which opens the containing folder and selects the file).
        crate::commands::util_cmd::spawn_detached(
            crate::commands::util_cmd::cmd("open")
                .arg("-R")
                // Absolute (checked above): it can never read as an option.
                .arg(&folder_path),
        )
        .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        // explorer /select, highlights the item in the containing folder.
        crate::commands::util_cmd::spawn_detached(
            crate::commands::util_cmd::cmd("explorer").arg(format!("/select,{}", folder_path)),
        )
        .map_err(|e| e.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux has no universal "reveal & highlight"; xdg-open opens the
        // containing folder (for files) or the dir itself. It is the closest
        // fallback to showItemInFolder's behavior.
        let target = {
            let p = Path::new(&folder_path);
            if p.is_dir() {
                folder_path.clone()
            } else {
                p.parent()
                    .map(|parent| parent.to_string_lossy().into_owned())
                    .unwrap_or_else(|| folder_path.clone())
            }
        };
        crate::commands::util_cmd::spawn_detached(
            crate::commands::util_cmd::cmd("xdg-open").arg(&target),
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ===========================================================================
// shell:open-terminal
// ===========================================================================

/// shell:open-terminal — opens the system terminal in a directory.
/// Uses per-OS logic to pick the terminal.
#[tauri::command]
pub async fn shell_open_terminal(cwd: String) -> Result<(), String> {
    if !is_safe_dir(&cwd) {
        return Err("invalid cwd".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // execFile('open', ['-a', 'Terminal', cwd])
        crate::commands::util_cmd::spawn_detached(
            crate::commands::util_cmd::cmd("open")
                .arg("-a")
                .arg("Terminal")
                .arg(&cwd),
        )
        .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        // A new console window whose working directory is `cwd`. The folder
        // never goes through a command line: `cmd /c start … "cd /d <cwd>"`
        // let cmd.exe re-parse it, so a folder named `a&calc` ran `calc`.
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut command = std::process::Command::new("cmd.exe");
        command.current_dir(&cwd).creation_flags(CREATE_NEW_CONSOLE);
        crate::commands::util_cmd::spawn_detached(&mut command).map_err(|e| e.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // execFile('x-terminal-emulator', ['--working-directory', cwd], err => {
        //   if (err) execFile('xterm', ['-e', 'bash'], { cwd });
        // })
        let spawned = crate::commands::util_cmd::spawn_detached(
            crate::commands::util_cmd::cmd("x-terminal-emulator")
                .arg("--working-directory")
                .arg(&cwd)
                .current_dir(&cwd),
        );
        if spawned.is_err() {
            // Fallback: xterm -e bash with cwd set.
            crate::commands::util_cmd::spawn_detached(
                crate::commands::util_cmd::cmd("xterm")
                    .arg("-e")
                    .arg("bash")
                    .current_dir(&cwd),
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// ===========================================================================
// shell:open-external
// ===========================================================================

/// Checks that `url` is a web/mail link safe to hand to the OS handler:
/// http/https/mailto only, bounded length, no quotes or control characters.
pub(crate) fn validate_external_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    if !allowed || !is_plain_uri(trimmed) {
        return Err("unsupported_url".to_string());
    }
    Ok(trimmed.to_string())
}

/// No quotes, control characters or excessive length.
fn is_plain_uri(uri: &str) -> bool {
    !uri.is_empty()
        && uri.len() <= 4096
        && !uri.contains('"')
        && !uri.chars().any(|c| c.is_control())
}

/// Hands a URI to the OS protocol handler without going through a shell.
/// Callers must validate it first (`validate_external_url`, or a fixed
/// settings URI such as `ms-settings:` / `x-apple.systempreferences:`).
pub(crate) fn spawn_uri_handler(uri: &str) -> Result<(), String> {
    if !is_plain_uri(uri) {
        return Err("unsupported_url".to_string());
    }

    #[cfg(target_os = "macos")]
    let res =
        crate::commands::util_cmd::spawn_detached(crate::commands::util_cmd::cmd("open").arg(uri));

    #[cfg(target_os = "windows")]
    let res = {
        use std::os::windows::process::CommandExt;
        // Not through `cmd /C start`: cmd re-parses the line and expands
        // %VARIABLES% even inside quotes, and `&`/`|` chain commands, so a
        // link could run code or leak the environment. The URL protocol
        // handler opens it as a single argument. CREATE_NO_WINDOW avoids a
        // console flash.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = crate::commands::util_cmd::cmd("rundll32");
        c.creation_flags(CREATE_NO_WINDOW)
            .arg("url.dll,FileProtocolHandler")
            .arg(uri);
        crate::commands::util_cmd::spawn_detached(&mut c)
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let res = crate::commands::util_cmd::spawn_detached(
        crate::commands::util_cmd::cmd("xdg-open").arg(uri),
    );

    res.map_err(|e| e.to_string())
}

/// Validates and opens a web/mail link in the system browser (synchronous).
pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
    let url = validate_external_url(url)?;
    spawn_uri_handler(&url)
}

/// shell:open-external — opens a URL in the system browser/handler.
/// Only http/https/mailto are allowed; any other scheme is refused.
#[tauri::command]
pub async fn shell_open_external(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    // spawn_blocking: the process spawn stays off the main thread (on macOS
    // `open` may pay for LaunchServices).
    tauri::async_runtime::spawn_blocking(move || spawn_uri_handler(&url))
        .await
        .map_err(|e| e.to_string())?
}

// ===========================================================================
// clipboard:write / clipboard:read / clipboard:write-image
// ===========================================================================

/// Result of clipboard:read — replicates `{ ok, text }`.
#[derive(Serialize)]
pub struct ClipboardReadResult {
    pub ok: bool,
    pub text: String,
}

/// Result of clipboard:write / clipboard:write-image — replicates `{ ok }`.
#[derive(Serialize)]
pub struct ClipboardWriteResult {
    pub ok: bool,
}

/// Runs clipboard access on the correct thread for the platform.
///
/// `async` Tauri commands run on Tokio workers. On macOS `arboard` uses
/// `NSPasteboard` directly, which with WebKit active may be queried
/// concurrently from the main thread. AppKit is not thread-safe: that race can
/// kill the whole process with EXC_BAD_ACCESS. All arboard calls
/// must therefore go through the main thread; on other platforms we keep
/// running on the current worker.
async fn clipboard_call<T, F>(app: tauri::AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(operation());
        })
        .map_err(|e| format!("failed to schedule clipboard operation: {e}"))?;

        receiver
            .await
            .map_err(|_| "clipboard operation was canceled".to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        #[cfg(target_os = "linux")]
        keep_linux_clipboard_alive();
        operation()
    }
}

/// On X11 the clipboard is not a system buffer: the content is served by the
/// process that wrote it, and arboard stops serving it when the last
/// `Clipboard` instance is dropped. Every command creates one and drops it
/// right away, so without a clipboard manager a Ctrl+C from the terminal was
/// lost instantly (Linux tester feedback, 2026-10-29). One instance kept alive
/// for the whole app lifetime keeps the content available to other apps.
#[cfg(target_os = "linux")]
fn keep_linux_clipboard_alive() {
    static KEEPER: std::sync::OnceLock<std::sync::Mutex<Option<arboard::Clipboard>>> =
        std::sync::OnceLock::new();
    KEEPER.get_or_init(|| std::sync::Mutex::new(arboard::Clipboard::new().ok()));
}

/// clipboard:write — writes text to the system clipboard.
#[tauri::command]
pub async fn clipboard_write(
    app: tauri::AppHandle,
    text: String,
) -> Result<ClipboardWriteResult, String> {
    clipboard_call(app, move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
        Ok(ClipboardWriteResult { ok: true })
    })
    .await
}

/// clipboard:read — reads text from the system clipboard.
/// Returns a `{ ok, text }` shape: the webapp
/// reads `res.text`, and a bare string would make it always paste empty.
#[tauri::command]
pub async fn clipboard_read(app: tauri::AppHandle) -> Result<ClipboardReadResult, String> {
    clipboard_call(app, || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let text = clipboard.get_text().map_err(|e| e.to_string())?;
        Ok(ClipboardReadResult { ok: true, text })
    })
    .await
}

/// clipboard:write-image — writes a PNG (data URL) to the clipboard.
/// Replicates `nativeImage.createFromDataURL` + `clipboard.writeImage`, including the
/// "empty image" guard.
#[tauri::command]
pub async fn clipboard_write_image(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<ClipboardWriteResult, String> {
    // Extracts the base64 payload from the data URL (e.g. "data:image/png;base64,....").
    let b64 = match data_url.split_once(',') {
        Some((header, payload)) if header.starts_with("data:") => payload,
        // If it is not a valid data URL we treat the whole string as raw
        // base64: in any case, if decoding fails or the image is empty,
        // we return "empty image" like the original.
        _ => data_url.as_str(),
    };

    let bytes = base64_decode(b64).ok_or_else(|| "empty image".to_string())?;
    if bytes.is_empty() {
        return Err("empty image".to_string());
    }

    // Decode the image (PNG and common formats) to RGBA8 for arboard.
    let img = image::load_from_memory(&bytes).map_err(|_| "empty image".to_string())?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("empty image".to_string());
    }

    let img_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };

    clipboard_call(app, move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_image(img_data).map_err(|e| e.to_string())?;
        Ok(ClipboardWriteResult { ok: true })
    })
    .await
}

/// clipboard:read-image — reads an image from the clipboard as a PNG data URL.
/// WKWebView does not expose native images in `clipboardData` on paste (unlike
/// Chromium): the webapp falls back to this command.
/// Returns None if the clipboard does not contain an image.
#[tauri::command]
pub async fn clipboard_read_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let img = clipboard_call(app, || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        match clipboard.get_image() {
            Ok(i) if i.width > 0 && i.height > 0 => Ok(Some(i)),
            _ => Ok(None),
        }
    })
    .await?;
    let Some(img) = img else {
        return Ok(None);
    };
    let rgba =
        image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
            .ok_or_else(|| "invalid clipboard image".to_string())?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(Some(format!("data:image/png;base64,{}", b64)))
}

/// Native paths of the OS drag in progress — a stand-in for `webUtils.getPathForFile`.
/// With wry's drag-drop handler disabled (required for internal HTML5
/// DnD and for file drops onto the DOM) dropped `File`s have no path:
/// during dragover the bridge calls this command, which reads macOS's drag
/// pasteboard, and `getDroppedPath` resolves by basename on drop.
#[tauri::command]
// NSFilenamesPboardType is deprecated but still the type Finder puts on the
// drag pasteboard; the file-URL replacement needs one item per file.
#[allow(deprecated)]
pub fn drag_drop_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
        use objc2_foundation::{NSArray, NSString};
        let pb = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
        let types = NSArray::from_slice(&[unsafe { NSFilenamesPboardType }]);
        if pb.availableTypeFromArray(&types).is_none() {
            return Vec::new();
        }
        let Some(list) = pb.propertyListForType(unsafe { NSFilenamesPboardType }) else {
            return Vec::new();
        };
        let Ok(arr) = list.downcast::<NSArray>() else {
            return Vec::new();
        };
        arr.iter()
            .filter_map(|p| p.downcast::<NSString>().ok().map(|s| s.to_string()))
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

// ===========================================================================
// installer:write-script — provider auto-installer ("provider not found" guide)
// ===========================================================================

/// Path of the written script.
#[derive(Serialize)]
pub struct InstallerScript {
    pub path: String,
}

const INSTALLER_SCRIPT_MAX: usize = 64 * 1024;

/// Writes `content` to `<dir>/install.sh` (0700, dir 0700).
/// Remove + `create_new`: a symlink left in place of the file is never
/// followed.
fn write_installer_script(dir: &Path, content: &str) -> Result<InstallerScript, String> {
    use std::io::Write;
    if content.is_empty() || content.len() > INSTALLER_SCRIPT_MAX {
        return Err("invalid installer script size".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let path = dir.join("install.sh");
    let _ = std::fs::remove_file(&path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o700);
    }
    let mut file = opts.open(&path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(InstallerScript {
        path: path.to_string_lossy().into_owned(),
    })
}

/// installer:write-script — the auto-installer script goes to a file and only
/// `bash '<path>'` is typed into the PTY: typed in full (~2 KB) it overflows the
/// tty input queue (≈1 KB on macOS) and bash loses characters. macOS/Linux only:
/// on Windows the installer stays typed PowerShell.
#[tauri::command]
pub fn installer_write_script(
    app: tauri::AppHandle,
    content: String,
) -> Result<InstallerScript, String> {
    use tauri::Manager;
    if cfg!(windows) {
        return Err("installer script files are unix-only".to_string());
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("installer");
    write_installer_script(&dir, &content)
}

#[cfg(all(test, unix))]
mod installer_tests {
    use super::write_installer_script;
    use std::os::unix::fs::PermissionsExt;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("po-installer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_private_script_and_overwrites() {
        let dir = tmp_dir("write");
        let first = write_installer_script(&dir, "echo one\n").unwrap();
        let second = write_installer_script(&dir, "echo two\n").unwrap();
        assert_eq!(first.path, second.path);
        assert_eq!(std::fs::read_to_string(&second.path).unwrap(), "echo two\n");
        let mode = std::fs::metadata(&second.path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
        let dmode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dmode, 0o700);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_follows_a_planted_symlink() {
        let dir = tmp_dir("symlink");
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("install.sh")).unwrap();
        write_installer_script(&dir, "echo safe\n").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_empty_and_oversized() {
        let dir = tmp_dir("size");
        assert!(write_installer_script(&dir, "").is_err());
        assert!(write_installer_script(&dir, &"x".repeat(64 * 1024 + 1)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ===========================================================================
// Editor — catalog + detect + open (port of editor-handlers.ts)
// ===========================================================================

/// Editor catalog entry. `available` filled in during detection.
#[derive(Clone, Serialize)]
pub struct EditorInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub icon: &'static str,
    pub available: bool,
}

/// Editor catalog 1:1 with `EDITORS` in editor-handlers.ts.
/// NB: `agy` (Antigravity agent manager) is a sub-agent provider, NOT an editor:
/// it is deliberately left out; here there is only `agy-ide` (the Antigravity 2 IDE).
const EDITORS: &[(&str, &str, &str, &str)] = &[
    ("vscode", "Code", "code", "mdi:microsoft-visual-studio-code"),
    ("cursor", "Cursor", "cursor", "simple-icons:cursor"),
    ("windsurf", "Windsurf", "windsurf", "simple-icons:codeium"),
    (
        "antigravity-ide",
        "Antigravity 2",
        "agy-ide",
        "tabler:rocket",
    ),
    ("zed", "Zed", "zed", "simple-icons:zed"),
    ("webstorm", "WebStorm", "webstorm", "simple-icons:webstorm"),
    ("idea", "IntelliJ", "idea", "simple-icons:intellijidea"),
    ("sublime", "Sublime", "subl", "simple-icons:sublimetext"),
    ("fleet", "Fleet", "fleet", "simple-icons:jetbrains"),
];

/// Extra paths added to PATH for detection, like `EXTRA_PATHS` in the TS. An
/// app opened from Finder/Dock does not get the login shell's PATH.
fn extra_paths() -> Vec<std::path::PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        vec![
            local.join("Programs").join("Microsoft VS Code").join("bin"),
            local
                .join("Programs")
                .join("cursor")
                .join("resources")
                .join("app")
                .join("bin"),
            local.join("Programs").join("Windsurf").join("bin"),
        ]
    } else {
        vec![
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/bin".into(),
            "/opt/homebrew/bin".into(),
            home.join(".local/bin"),
        ]
    }
}

/// `augmentedPath` — EXTRA_PATHS + current PATH, without duplicates, joined
/// with the platform separator.
fn augmented_path() -> std::ffi::OsString {
    crate::commands::util_cmd::path_with(&extra_paths())
}

/// Full path of an editor launcher, looked up in the augmented PATH (on
/// Windows `code` is `code.cmd`, which `Command::new("code")` never finds).
fn editor_binary(command: &str) -> Option<std::path::PathBuf> {
    crate::commands::util_cmd::find_in_path(command, &augmented_path())
}

/// `isCommandAvailable` — the launcher exists in the augmented PATH.
fn is_command_available(command: &str) -> bool {
    editor_binary(command).is_some()
}

/// Result of editor:detect — replicates `{ ok, editors }`.
#[derive(Serialize)]
pub struct EditorDetectResult {
    pub ok: bool,
    pub editors: Vec<EditorInfo>,
}

/// editor:detect — detects installed editors and returns ONLY the available ones.
///
/// Returns a `{ ok, editors }` shape: the caller does `if (result.ok) result.editors`,
/// and a bare array would leave `ok` undefined, hiding the "open in editor" badges.
#[tauri::command]
pub async fn editor_detect() -> Result<EditorDetectResult, String> {
    let editors: Vec<EditorInfo> = EDITORS
        .iter()
        .map(|&(id, name, command, icon)| EditorInfo {
            id,
            name,
            command,
            icon,
            available: is_command_available(command),
        })
        .filter(|e| e.available)
        .collect();
    Ok(EditorDetectResult { ok: true, editors })
}

/// editor:open — opens `cwd` in the given editor.
/// Only catalog commands are allowed (anti command-injection),
/// exactly like the TS `EDITORS.find(...)` check. Launches `<command> .`
/// with cwd = `cwd` and augmented PATH.
#[tauri::command]
pub async fn editor_open(editor_command: String, cwd: String) -> Result<(), String> {
    let known = EDITORS
        .iter()
        .any(|&(_, _, command, _)| command == editor_command);
    if !known {
        return Err(format!("Unknown editor command: {}", editor_command));
    }
    if !is_safe_dir(&cwd) {
        return Err("invalid cwd".to_string());
    }
    let binary = editor_binary(&editor_command)
        .ok_or_else(|| format!("Editor command not found: {}", editor_command))?;

    // Equivalent to `${editorCommand} .` run in `cwd`. Launchers return as
    // soon as the editor window is up; off the async workers all the same.
    let output = tauri::async_runtime::spawn_blocking(move || {
        crate::commands::util_cmd::cmd(&binary)
            .arg(".")
            .current_dir(&cwd)
            .env("PATH", augmented_path())
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    // In the TS the error was propagated only if there was an error AND empty stdout
    // (a GUI editor often returns immediately with no output but exit 0); many
    // launchers (e.g. `code .`) exit 0. We keep the same tolerance:
    // we fail only if the process exited with an error and produced no stdout.
    if !output.status.success() && output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = if stderr.trim().is_empty() {
            format!("Editor command failed: {}", editor_command)
        } else {
            stderr.trim().to_string()
        };
        return Err(msg);
    }

    Ok(())
}

// ===========================================================================
// base64 decode (no extra crate) — standard alphabet only, ignores whitespace.
// ===========================================================================

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;

    for &c in input.as_bytes() {
        // Skip whitespace and padding.
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' || c == b'\t' {
            continue;
        }
        let v = val(c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }

    Some(out)
}

#[cfg(test)]
mod open_url_tests {
    use super::validate_external_url;

    #[test]
    fn accepts_web_and_mail_links() {
        assert!(validate_external_url("https://example.com/a?b=%20c").is_ok());
        assert!(validate_external_url(" http://localhost:3000 ").is_ok());
        assert!(validate_external_url("mailto:someone@example.com").is_ok());
    }

    #[test]
    fn editor_lookup_uses_the_platform_path_separator() {
        let joined = super::augmented_path();
        // Every extra dir is its own entry: never a ':'-joined blob on Windows.
        let dirs: Vec<_> = std::env::split_paths(&joined).collect();
        for extra in super::extra_paths() {
            assert!(dirs.contains(&extra), "{extra:?}");
        }
        assert!(super::editor_binary("definitely-not-an-editor-xyz").is_none());
    }

    #[tokio::test]
    async fn editor_open_refuses_unknown_commands_and_bad_folders() {
        assert!(super::editor_open("sh".into(), "/".into()).await.is_err());
        assert_eq!(
            super::editor_open("code".into(), "relative/dir".into()).await,
            Err("invalid cwd".to_string())
        );
    }

    #[test]
    fn refuses_other_schemes_and_shell_metacharacters() {
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://x.test/\" & calc").is_err());
        assert!(validate_external_url("https://x.test/\ncalc").is_err());
        assert!(validate_external_url("").is_err());
    }
}
