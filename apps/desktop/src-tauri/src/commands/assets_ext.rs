//! Assets / Extensions / fcc-config — three IPC domains:
//!
//! - assets (`assets:*`): filesystem CRUD for session assets
//! - extensions: provider extensions
//! - fcc-config: PromptOps CLI provider configuration (the API key is kept
//!   in the encrypted local store, never in the JSON file)
//!
//! The responses use a `{ ok, ... }` shape, serialized as
//! `serde_json::Value`, which is what the renderer expects.
//!
//! Conventions (same as `commands/terminal.rs`):
//! - `#[tauri::command] pub fn <name>(...) -> Result<T, String>`, snake_case.
//! - Commands that do HTTP are `async fn` + `reqwest::Client` (like device.rs).
//! - No extra dependencies beyond the stack already in Cargo.toml: base64
//!   encoding is inlined below (no `base64` crate).

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// ════════════════════════════════════════════════════════════════════════════
// Constants.
// ════════════════════════════════════════════════════════════════════════════

/// `.promptops-assets` — session assets folder (ASSETS_DIR).
const ASSETS_DIR: &str = ".promptops-assets";
/// .gitignore entry for the assets (GITIGNORE_ENTRY).
const GITIGNORE_ENTRY: &str = ".promptops-assets/";
/// .gitignore entry for the materialized extensions (EXTENSIONS_GITIGNORE_ENTRY).
const EXTENSIONS_GITIGNORE_ENTRY: &str = ".promptops/";
/// Maximum upload: 50 MB (MAX_UPLOAD_SIZE).
const MAX_UPLOAD_SIZE: u64 = 50 * 1024 * 1024;

/// Relative path of the extensions lock manifest (EXTENSIONS_LOCK_REL_PATH).
const EXTENSIONS_LOCK_REL_PATH: &str = ".promptops/extensions/extensions.lock.json";
/// Placeholder replaced with the session cwd in payloads (WORKSPACE_PLACEHOLDER).
const WORKSPACE_PLACEHOLDER: &str = "${WORKSPACE}";

// ════════════════════════════════════════════════════════════════════════════
// Asset DTO — AssetInfo.
// ════════════════════════════════════════════════════════════════════════════

/// `AssetInfo`. Fields stay camelCase for the renderer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub name: String,
    pub relative_path: String,
    pub size: u64,
    pub mime_type: String,
    pub is_image: bool,
    pub created_at: String,
    pub modified_at: String,
}

/// File to upload: `{ name, dataBase64 }` (ASSETS_UPLOAD payload).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    pub name: String,
    pub data_base64: String,
}

// ════════════════════════════════════════════════════════════════════════════
// assets:* — filesystem CRUD under <cwd>/.promptops-assets.
// Every command returns a `{ ok, … }` shape.
// ════════════════════════════════════════════════════════════════════════════

/// assets:list — lists all the workspace assets.
/// Mirror of `ASSETS_LIST` → `{ ok, assets }`.
#[tauri::command]
pub async fn assets_list(app: tauri::AppHandle, cwd: String) -> Value {
    let res = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r.list(&app).await,
        Some(Err(e)) => Err(e),
        None => list_assets(&cwd),
    };
    match res {
        Ok(assets) => json!({ "ok": true, "assets": assets }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// assets:upload — uploads one or more files to the assets folder.
/// Mirror of `ASSETS_UPLOAD` → `{ ok, assets }` (`uploaded` collection).
#[tauri::command]
pub async fn assets_upload(app: tauri::AppHandle, cwd: String, files: Vec<UploadFile>) -> Value {
    let remote = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => Some(r),
        Some(Err(e)) => return json!({ "ok": false, "error": e }),
        None => None,
    };
    let mut uploaded: Vec<AssetInfo> = Vec::new();
    for file in files {
        let res = match &remote {
            Some(r) => match base64_decode(&file.data_base64) {
                Ok(bytes) => r.upload(&app, &file.name, &bytes).await,
                Err(e) => Err(e),
            },
            None => upload_asset(&cwd, &file.name, &file.data_base64),
        };
        match res {
            Ok(asset) => uploaded.push(asset),
            Err(e) => return json!({ "ok": false, "error": e }),
        }
    }
    json!({ "ok": true, "assets": uploaded })
}

/// assets:delete — deletes an asset by name.
/// Mirror of `ASSETS_DELETE` → `{ ok, deleted }`.
#[tauri::command]
pub async fn assets_delete(app: tauri::AppHandle, cwd: String, file_name: String) -> Value {
    let res = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r.delete(&app, &file_name).await,
        Some(Err(e)) => Err(e),
        None => delete_asset(&cwd, &file_name),
    };
    match res {
        Ok(deleted) => json!({ "ok": true, "deleted": deleted }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// assets:rename — renames an asset.
/// Mirror of `ASSETS_RENAME` → `{ ok, asset }`.
#[tauri::command]
pub async fn assets_rename(
    app: tauri::AppHandle,
    cwd: String,
    old_name: String,
    new_name: String,
) -> Value {
    let res = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r.rename(&app, &old_name, &new_name).await,
        Some(Err(e)) => Err(e),
        None => rename_asset(&cwd, &old_name, &new_name),
    };
    match res {
        Ok(asset) => json!({ "ok": true, "asset": asset }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// assets:read — reads the asset content as text.
/// Mirror of `ASSETS_READ` → `{ ok, content }`.
#[tauri::command]
pub async fn assets_read(app: tauri::AppHandle, cwd: String, file_name: String) -> Value {
    let res = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r
            .read_bytes(&app, &file_name)
            .await
            .map(|b| String::from_utf8_lossy(&b).into_owned()),
        Some(Err(e)) => Err(e),
        None => read_asset_text(&cwd, &file_name),
    };
    match res {
        Ok(content) => json!({ "ok": true, "content": content }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// assets:import-from-url — downloads a remote file (e.g. presigned S3 URL)
/// into the assets folder. Runs in the main process so the renderer's CORS doesn't
/// apply. Async: non-blocking reqwest, never on the main thread.
#[tauri::command]
pub async fn assets_import_from_url(
    app: tauri::AppHandle,
    cwd: String,
    url: String,
    file_name: String,
) -> Value {
    if !url.to_lowercase().starts_with("http://") && !url.to_lowercase().starts_with("https://") {
        return serde_json::json!({ "ok": false, "error": "Only http(s) URLs are allowed" });
    }
    let response = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    if !response.status().is_success() {
        return serde_json::json!({
            "ok": false,
            "error": format!("Download failed (HTTP {})", response.status().as_u16()),
        });
    }
    // Bounded download: the 50 MB asset limit used to be checked only after
    // the whole body was in memory.
    let too_large =
        || serde_json::json!({ "ok": false, "error": "File too large. Maximum: 50 MB" });
    if response.content_length().unwrap_or(0) > MAX_UPLOAD_SIZE {
        return too_large();
    }
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if (bytes.len() + chunk.len()) as u64 > MAX_UPLOAD_SIZE {
                    return too_large();
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    }
    let res = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r.upload(&app, &file_name, &bytes).await,
        Some(Err(e)) => Err(e),
        None => upload_asset(&cwd, &file_name, &base64_encode(&bytes)),
    };
    match res {
        Ok(asset) => serde_json::json!({ "ok": true, "asset": asset }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// Per-file cap of `assets_import_paths` (same order of magnitude as the
/// picker uploads, which travel whole as base64 over IPC).
const IMPORT_PATH_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// assets:import-paths — copies local files (absolute paths) into the assets
/// folder. Needed for drops from the file manager on Linux: WebKitGTK often
/// delivers only `text/uri-list` with no `File` in `dataTransfer.files`, so the
/// webview passes the paths and Rust reads the content. Regular files only.
#[tauri::command]
pub async fn assets_import_paths(app: tauri::AppHandle, cwd: String, paths: Vec<String>) -> Value {
    let remote = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => Some(r),
        Some(Err(e)) => return json!({ "ok": false, "error": e }),
        None => None,
    };
    let mut uploaded: Vec<AssetInfo> = Vec::new();
    for raw in paths {
        let path = PathBuf::from(&raw);
        if !path.is_absolute() {
            return json!({ "ok": false, "error": "Only absolute paths are allowed" });
        }
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        };
        // Folders and special files: skipped silently, like the HTML5 drop.
        if !meta.is_file() {
            continue;
        }
        if meta.len() > IMPORT_PATH_MAX_BYTES {
            return json!({ "ok": false, "error": "File too large" });
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        };
        let res = match &remote {
            Some(r) => r.upload(&app, &name, &bytes).await,
            None => upload_asset(&cwd, &name, &base64_encode(&bytes)),
        };
        match res {
            Ok(asset) => uploaded.push(asset),
            Err(e) => return json!({ "ok": false, "error": e }),
        }
    }
    json!({ "ok": true, "assets": uploaded })
}

/// assets:read-base64 — reads the asset as base64 (image preview / AI).
/// Mirror of `ASSETS_READ_BASE64` → `{ ok, data, mimeType }` (spread of the result).
#[tauri::command]
pub async fn assets_read_base64(app: tauri::AppHandle, cwd: String, file_name: String) -> Value {
    let res = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r
            .read_bytes(&app, &file_name)
            .await
            .map(|b| (base64_encode(&b), get_mime_type(&ext_lower(&file_name)))),
        Some(Err(e)) => Err(e),
        None => read_asset_base64(&cwd, &file_name),
    };
    match res {
        Ok((data, mime_type)) => json!({ "ok": true, "data": data, "mimeType": mime_type }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// assets:open-folder — opens the assets folder in the system file manager.
/// Mirror of `ASSETS_OPEN_FOLDER` → `{ ok }`. Uses `tauri-plugin-shell`/`open`
/// via a system command, equivalent to `shell.openPath`.
#[tauri::command]
pub fn assets_open_folder(cwd: String) -> Value {
    if crate::commands::remote::is_remote_path(Some(&cwd)) {
        return json!({
            "ok": false,
            "error": "The assets of a remote session live on the remote host (.promptops-assets/ in the session folder) and can't be opened in the local file manager.",
        });
    }
    // The folder is created only on the first upload: without this `open`/`explorer`
    // failed silently on a nonexistent path and the button "did nothing".
    let assets_dir = match ensure_assets_dir(&cwd) {
        Ok(dir) => dir,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    match open_path(&assets_dir) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ── assets: remote sessions (cwd `cmd://…` / `ssh://…`) ─────────────────────
//
// The CLI runs on the remote host: assets must live in
// `<remote folder>/.promptops-assets/`, not in the local filesystem (where
// `Path::new("cmd:///…")` created a ghost folder). POSIX scripts via the
// session transport; the bytes travel over stdin, never in argv.

/// Assets of a remote session: transport + session folder on the host.
struct RemoteAssets {
    target: crate::commands::remote::RemoteTarget,
    /// Remote path of the session ("" = home).
    root: String,
}

/// `None` = local cwd (unchanged flow). `Some(Err)` = remote but the connection
/// command is not known (session not started yet in this process).
fn remote_assets(app: &tauri::AppHandle, cwd: &str) -> Option<Result<RemoteAssets, String>> {
    use crate::commands::remote::{parse_cmd_path, parse_remote_path, RemoteTarget};
    use tauri::Manager as _;
    if let Some((conn_id, root)) = parse_remote_path(cwd) {
        return Some(Ok(RemoteAssets {
            target: RemoteTarget::Ssh(conn_id),
            root,
        }));
    }
    let root = parse_cmd_path(cwd)?;
    let command = app
        .state::<Arc<crate::commands::session::SessionManager>>()
        .remote_command_for_cwd(cwd);
    Some(match command {
        Some(c) => Ok(RemoteAssets {
            target: RemoteTarget::Command(c),
            root,
        }),
        None => Err("Remote session is not connected yet: resume it, then retry.".into()),
    })
}

/// Asset line emitted by the scripts: `a<TAB>size<TAB>mtime<TAB>name`.
const REMOTE_STAT_FN: &str = "po_a() { s=$(wc -c < \"$1\" | tr -d ' '); m=$(stat -c %Y \"$1\" 2>/dev/null || stat -f %m \"$1\" 2>/dev/null || echo 0); printf 'a\\t%s\\t%s\\t%s\\n' \"$s\" \"$m\" \"$2\"; }";

impl RemoteAssets {
    /// `cd` into the session folder + common helpers; `d` = assets folder.
    fn prelude(&self) -> String {
        let cd = if self.root.is_empty() || self.root == "~" {
            "cd".to_string()
        } else {
            format!("cd {}", crate::commands::remote::sh_quote(&self.root))
        };
        format!("{cd} 2>/dev/null || {{ echo '__PO_NOCD__'; exit 0; }}; d={ASSETS_DIR}; {REMOTE_STAT_FN}; ")
    }

    async fn run(
        &self,
        app: &tauri::AppHandle,
        body: &str,
        stdin: Option<&[u8]>,
        timeout: u64,
    ) -> Result<String, String> {
        let script = format!("{}{body}", self.prelude());
        let out =
            crate::commands::remote::run_on_target(app, &self.target, &script, stdin, timeout)
                .await?;
        if out.contains("__PO_NOCD__") {
            return Err(format!("Remote folder not accessible: {}", self.root));
        }
        Ok(out)
    }

    async fn list(&self, app: &tauri::AppHandle) -> Result<Vec<AssetInfo>, String> {
        let out = self
            .run(
                app,
                "[ -d \"$d\" ] || exit 0; for f in \"$d\"/* \"$d\"/in/* \"$d\"/out/* \"$d\"/out/sent/*; do [ -f \"$f\" ] && po_a \"$f\" \"${f#\"$d\"/}\"; done; true",
                None,
                30,
            )
            .await?;
        let mut assets: Vec<AssetInfo> = out.lines().filter_map(parse_remote_asset_line).collect();
        assets.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        Ok(assets)
    }

    async fn upload(
        &self,
        app: &tauri::AppHandle,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<AssetInfo, String> {
        if bytes.len() as u64 > MAX_UPLOAD_SIZE {
            let mb = bytes.len() as f64 / 1024.0 / 1024.0;
            return Err(format!("File too large ({mb:.1} MB). Maximum: 50 MB"));
        }
        let q = crate::commands::remote::sh_quote;
        let name = basename(file_name);
        let ext = ext_lower(&name);
        let stem = file_stem(&name, &ext);
        // Same two .gitignore entries as ensure_gitignore (best-effort) and
        // same name dedup (base_1.ext, base_2.ext, …).
        let body = format!(
            "mkdir -p \"$d\" || exit 1; \
             grep -qxF '{GITIGNORE_ENTRY}' .gitignore 2>/dev/null || printf '\\n# PromptOps session assets\\n{GITIGNORE_ENTRY}\\n' >> .gitignore 2>/dev/null; \
             grep -qxF '{EXTENSIONS_GITIGNORE_ENTRY}' .gitignore 2>/dev/null || printf '\\n# PromptOps agent extensions\\n{EXTENSIONS_GITIGNORE_ENTRY}\\n' >> .gitignore 2>/dev/null; \
             mkdir -p \"$d/{INBOX}\" || exit 1; \
             n={name}; i=1; while [ -e \"$d/{INBOX}/$n\" ]; do n={stem}_$i{ext}; i=$((i+1)); done; \
             cat > \"$d/{INBOX}/$n\" && po_a \"$d/{INBOX}/$n\" \"{INBOX}/$n\"",
            name = q(&name),
            stem = q(&stem),
            ext = q(&ext),
        );
        let out = self.run(app, &body, Some(bytes), 180).await?;
        out.lines()
            .find_map(parse_remote_asset_line)
            .ok_or_else(|| format!("Remote upload failed: {}", out.trim()))
    }

    async fn delete(&self, app: &tauri::AppHandle, file_name: &str) -> Result<bool, String> {
        let body = format!(
            "f=\"$d\"/{}; if [ -f \"$f\" ]; then rm -f \"$f\" && echo '__PO_DEL__1'; else echo '__PO_DEL__0'; fi",
            crate::commands::remote::sh_quote(&remote_asset_rel(file_name))
        );
        let out = self.run(app, &body, None, 30).await?;
        if out.contains("__PO_DEL__1") {
            Ok(true)
        } else if out.contains("__PO_DEL__0") {
            Ok(false)
        } else {
            Err(format!("Remote delete failed: {}", out.trim()))
        }
    }

    async fn rename(
        &self,
        app: &tauri::AppHandle,
        old_name: &str,
        new_name: &str,
    ) -> Result<AssetInfo, String> {
        let q = crate::commands::remote::sh_quote;
        let old = remote_asset_rel(old_name);
        let new = match old.rfind('/') {
            Some(i) => format!("{}/{}", &old[..i], basename(new_name)),
            None => basename(new_name),
        };
        let body = format!(
            "o=\"$d\"/{qo}; n=\"$d\"/{qn}; [ -e \"$o\" ] || {{ echo '__PO_NOTFOUND__'; exit 0; }}; \
             [ -e \"$n\" ] && {{ echo '__PO_EXISTS__'; exit 0; }}; mv \"$o\" \"$n\" && po_a \"$n\" {qn}",
            qo = q(&old),
            qn = q(&new),
        );
        let out = self.run(app, &body, None, 30).await?;
        if out.contains("__PO_NOTFOUND__") {
            return Err(format!("Asset not found: {old_name}"));
        }
        if out.contains("__PO_EXISTS__") {
            return Err(format!("Asset already exists: {new_name}"));
        }
        out.lines()
            .find_map(parse_remote_asset_line)
            .ok_or_else(|| format!("Remote rename failed: {}", out.trim()))
    }

    /// Raw asset content: base64 between markers (binary stdout is not
    /// reliable through the transport, and on native ssh stderr is mixed in).
    async fn read_bytes(&self, app: &tauri::AppHandle, file_name: &str) -> Result<Vec<u8>, String> {
        let f = format!(
            "\"$d\"/{}",
            crate::commands::remote::sh_quote(&remote_asset_rel(file_name))
        );
        self.read_file(app, &f, file_name).await
    }

    /// Any file on the host: absolute path or relative to the session folder.
    async fn read_path(&self, app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>, String> {
        self.read_file(app, &crate::commands::remote::sh_quote(path), path)
            .await
    }

    /// `f_expr` = already-quoted shell expression of the file to read.
    async fn read_file(
        &self,
        app: &tauri::AppHandle,
        f_expr: &str,
        label: &str,
    ) -> Result<Vec<u8>, String> {
        let body = format!(
            "f={f_expr}; [ -f \"$f\" ] || {{ echo '__PO_NOTFOUND__'; exit 0; }}; \
             [ \"$(wc -c < \"$f\" | tr -d ' ')\" -le {MAX_REMOTE_FETCH} ] || {{ echo '__PO_TOOBIG__'; exit 0; }}; \
             echo '__PO_B64__'; base64 < \"$f\" 2>/dev/null || openssl base64 < \"$f\"; echo '__PO_END__'"
        );
        let out = self.run(app, &body, None, 300).await?;
        if out.contains("__PO_NOTFOUND__") {
            return Err(format!("File not found on the remote host: {label}"));
        }
        if out.contains("__PO_TOOBIG__") {
            return Err(format!(
                "File too large to download (max {} MB): {label}",
                MAX_REMOTE_FETCH / 1024 / 1024
            ));
        }
        let start = out.find("__PO_B64__").ok_or("Remote read failed")? + "__PO_B64__".len();
        let end = out[start..]
            .find("__PO_END__")
            .map(|i| start + i)
            .ok_or("Remote read failed")?;
        let b64: String = out[start..end]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        base64_decode(&b64)
    }
}

/// Maximum download of a remote file (it passes through memory as base64).
const MAX_REMOTE_FETCH: u64 = 200 * 1024 * 1024;

/// remote:fetch-file — brings a file from a remote session's host to the
/// local machine (e.g. the PDF generated by the CLI): saves it in `Download/PromptOps/`
/// and, with `open`, opens it with the default app. `path` absolute or relative
/// to the session folder; a `:line:col` suffix from CLI links is ignored.
/// → `{ ok, localPath }` | `{ ok:false, error }`.
#[tauri::command]
pub async fn remote_fetch_file(
    app: tauri::AppHandle,
    cwd: String,
    path: String,
    open: Option<bool>,
) -> Value {
    let remote = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r,
        Some(Err(e)) => return json!({ "ok": false, "error": e }),
        None => return json!({ "ok": false, "error": "Not a remote session" }),
    };
    let mut p = path.trim().to_string();
    while let Some(i) = p.rfind(':') {
        if i + 1 < p.len() && p[i + 1..].chars().all(|c| c.is_ascii_digit()) {
            p.truncate(i);
        } else {
            break;
        }
    }
    let name = basename(&p);
    if p.is_empty() || name.is_empty() {
        return json!({ "ok": false, "error": "Empty path" });
    }
    let bytes = match remote.read_path(&app, &p).await {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let target = match save_local_download(&app, &remote, &name, &bytes) {
        Ok(t) => t,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let local = target.to_string_lossy().to_string();
    if open.unwrap_or(true) {
        match open_downloaded(&target) {
            Ok(true) => {}
            Ok(false) => return json!({ "ok": true, "localPath": local, "revealed": true }),
            Err(e) => return json!({ "ok": true, "localPath": local, "openError": e }),
        }
    }
    json!({ "ok": true, "localPath": local })
}

/// Saves a file that came from the host in `Download/PromptOps/<remote folder>/`
/// (dedup name_1.ext, …) and returns the local path.
fn save_local_download(
    app: &tauri::AppHandle,
    remote: &RemoteAssets,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    let project = basename(remote.root.trim_end_matches('/'));
    let mut dir = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .join("PromptOps");
    if !project.is_empty() && !project.starts_with('.') {
        dir = dir.join(project);
    }
    write_unique(&dir, name, bytes)
}

/// Writes `bytes` to `dir/<basename(name)>` without overwriting: if the name
/// already exists it moves on to name_1.ext, name_2.ext, …
fn write_unique(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = basename(name);
    let ext = ext_lower(&name);
    let mut target = dir.join(&name);
    let mut counter = 1u32;
    while target.exists() {
        target = dir.join(format!("{}_{counter}{ext}", file_stem(&name, &ext)));
        counter += 1;
    }
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target)
}

/// Maximum download size of an attachment (task attachments are ≤ 20 MB).
const MAX_URL_DOWNLOAD: u64 = 100 * 1024 * 1024;

/// download:url — downloads a file from an https URL (e.g. a task attachment,
/// a presigned S3 URL) into `Downloads/PromptOps/` with the given name and, with
/// `reveal`, highlights it in the file manager. Needed because in the webview
/// `<a download>` and `target=_blank` download nothing.
/// → `{ ok, localPath }` | `{ ok:false, error }`.
#[tauri::command]
pub async fn download_url_to_downloads(
    app: tauri::AppHandle,
    url: String,
    name: String,
    reveal: Option<bool>,
) -> Value {
    use tauri::Manager as _;
    if !url.to_lowercase().starts_with("https://") {
        return json!({ "ok": false, "error": "Only https URLs are allowed" });
    }
    let name = basename(name.trim());
    if name.is_empty() || name == "." || name == ".." {
        return json!({ "ok": false, "error": "Invalid file name" });
    }
    let mut response = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    if !response.status().is_success() {
        return json!({ "ok": false, "error": format!("Download failed (HTTP {})", response.status().as_u16()) });
    }
    if response
        .content_length()
        .is_some_and(|len| len > MAX_URL_DOWNLOAD)
    {
        return json!({ "ok": false, "error": "File too large" });
    }
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() as u64 + chunk.len() as u64 > MAX_URL_DOWNLOAD {
                    return json!({ "ok": false, "error": "File too large" });
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        }
    }
    let dir = match app.path().download_dir() {
        Ok(d) => d.join("PromptOps"),
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let target = match write_unique(&dir, &name, &bytes) {
        Ok(t) => t,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    mark_quarantined(&target);
    let local = target.to_string_lossy().to_string();
    if reveal.unwrap_or(true) {
        if let Err(e) = crate::commands::shell::shell_show_in_folder(local.clone()).await {
            return json!({ "ok": true, "localPath": local, "revealError": e });
        }
    }
    json!({ "ok": true, "localPath": local })
}

/// Like browsers do: a file downloaded from the internet gets `com.apple.quarantine`,
/// so Gatekeeper checks it when it is opened (e.g. a .app inside a zip).
/// Best-effort: if `xattr` fails the file stays saved anyway.
fn mark_quarantined(_path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = crate::commands::util_cmd::cmd("xattr")
            .arg("-w")
            .arg("com.apple.quarantine")
            .arg(format!("0081;{secs:x};PromptOps;"))
            .arg(_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// remote:outbox-collect — delivers the files the remote agent put in
/// `.promptops-assets/out/` (MCP tool `send_to_local`): downloads them locally,
/// with `open` opens them, and on the host moves them to `out/sent/` only AFTER the
/// local save (an error halfway leaves them queued for the next round).
/// → `{ ok, files: [{ name, localPath }] }`.
#[tauri::command]
pub async fn remote_outbox_collect(
    app: tauri::AppHandle,
    cwd: String,
    open: Option<bool>,
) -> Value {
    let remote = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r,
        Some(Err(e)) => return json!({ "ok": false, "error": e }),
        None => return json!({ "ok": true, "files": [] }),
    };
    let listing = match remote
        .run(&app, &format!("for f in \"$d\"/{OUTBOX}/*; do [ -f \"$f\" ] && po_a \"$f\" \"${{f##*/}}\"; done; true"), None, 20)
        .await
    {
        Ok(out) => out,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let names: Vec<String> = listing
        .lines()
        .filter_map(parse_remote_asset_line)
        .map(|a| a.name)
        .collect();
    let mut delivered: Vec<Value> = Vec::new();
    for name in names {
        let rel = format!("{OUTBOX}/{name}");
        let bytes = match remote.read_bytes(&app, &rel).await {
            Ok(b) => b,
            Err(e) => return json!({ "ok": false, "error": e, "files": delivered }),
        };
        let target = match save_local_download(&app, &remote, &name, &bytes) {
            Ok(t) => t,
            Err(e) => return json!({ "ok": false, "error": e, "files": delivered }),
        };
        let q = crate::commands::remote::sh_quote(&name);
        let moved = remote
            .run(&app, &format!("mkdir -p \"$d/{OUTBOX_SENT}\" && mv -f \"$d\"/{OUTBOX}/{q} \"$d\"/{OUTBOX_SENT}/{q}"), None, 20)
            .await;
        if let Err(e) = moved {
            // Already local: better a duplicate on the next round than a lost file.
            return json!({ "ok": false, "error": e, "files": delivered });
        }
        if open.unwrap_or(true) {
            let _ = open_downloaded(&target);
        }
        delivered.push(json!({ "name": name, "localPath": target.to_string_lossy() }));
    }
    json!({ "ok": true, "files": delivered })
}

/// MCP server installed on the host: gives the remote agent `send_to_local` and
/// `list_received_files` and tells it the user is not on that machine.
const REMOTE_MCP_PY: &str = include_str!("promptops_remote_mcp.py");

/// remote:bridge-setup — idempotent: installs/updates the MCP server in
/// `~/.promptops/bin/` on the host and registers it at user level in the remote
/// Claude CLI (`claude mcp add -s user promptops-remote`). Applies to
/// Claude sessions started afterwards. → `{ ok, registered }`.
#[tauri::command]
pub async fn remote_bridge_setup(app: tauri::AppHandle, cwd: String) -> Value {
    let remote = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r,
        Some(Err(e)) => return json!({ "ok": false, "error": e }),
        None => return json!({ "ok": false, "error": "Not a remote session" }),
    };
    let script = "PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH\"; \
        command -v python3 >/dev/null || { echo '__PO_NOPY__'; exit 0; }; \
        mkdir -p \"$HOME/.promptops/bin\" && cat > \"$HOME/.promptops/bin/promptops_remote_mcp.py\" || exit 1; \
        command -v claude >/dev/null || { echo '__PO_NOCLAUDE__'; exit 0; }; \
        claude mcp get promptops-remote >/dev/null 2>&1 || \
        claude mcp add -s user promptops-remote -- python3 \"$HOME/.promptops/bin/promptops_remote_mcp.py\" >/dev/null 2>&1; \
        claude mcp get promptops-remote >/dev/null 2>&1 && echo '__PO_MCP_OK__'";
    let out = match crate::commands::remote::run_on_target(
        &app,
        &remote.target,
        script,
        Some(REMOTE_MCP_PY.as_bytes()),
        60,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    if out.contains("__PO_NOPY__") {
        return json!({ "ok": false, "error": "python3 not found on the remote host" });
    }
    json!({ "ok": true, "registered": out.contains("__PO_MCP_OK__") })
}

/// Remote script that undoes `remote_bridge_setup` on the host: the
/// user-scope `promptops-remote` MCP registration and the helper script (plus
/// the folders, when nothing else is in them).
const REMOTE_BRIDGE_REMOVE_SCRIPT: &str =
    "PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH\"; \
    if command -v claude >/dev/null && claude mcp get promptops-remote >/dev/null 2>&1; then \
    claude mcp remove -s user promptops-remote >/dev/null 2>&1 || exit 1; fi; \
    rm -f \"$HOME/.promptops/bin/promptops_remote_mcp.py\"; \
    rmdir \"$HOME/.promptops/bin\" \"$HOME/.promptops\" 2>/dev/null; \
    echo '__PO_BRIDGE_REMOVED__'";

/// remote:bridge-remove — takes the `promptops-remote` MCP server back off the
/// host (registration and script). → `{ ok, removed }`.
#[tauri::command]
pub async fn remote_bridge_remove(app: tauri::AppHandle, cwd: String) -> Value {
    let remote = match remote_assets(&app, &cwd) {
        Some(Ok(r)) => r,
        Some(Err(e)) => return json!({ "ok": false, "error": e }),
        None => return json!({ "ok": false, "error": "Not a remote session" }),
    };
    match crate::commands::remote::run_on_target(
        &app,
        &remote.target,
        REMOTE_BRIDGE_REMOVE_SCRIPT,
        None,
        60,
    )
    .await
    {
        Ok(out) => json!({ "ok": true, "removed": out.contains("__PO_BRIDGE_REMOVED__") }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// Subfolders of `.promptops-assets/` on remote sessions:
/// `in/` = from the user's computer to the host, `out/` = from the host to the computer
/// (outbox collected by `remote_outbox_collect`), `out/sent/` = delivered.
const INBOX: &str = "in";
const OUTBOX: &str = "out";
const OUTBOX_SENT: &str = "out/sent";

/// Remote asset name relative to `.promptops-assets/`: keeps the known subfolder
/// prefix, the rest is reduced to a basename (no `..`/arbitrary paths).
fn remote_asset_rel(name: &str) -> String {
    let n = name.replace('\\', "/");
    for prefix in ["out/sent/", "in/", "out/"] {
        if let Some(rest) = n.strip_prefix(prefix) {
            return format!("{prefix}{}", basename(rest));
        }
    }
    basename(&n)
}

/// Parser for the `a<TAB>size<TAB>mtime<TAB>name` line (see REMOTE_STAT_FN).
fn parse_remote_asset_line(line: &str) -> Option<AssetInfo> {
    let rest = line.strip_prefix("a\t")?;
    let mut parts = rest.splitn(3, '\t');
    let size: u64 = parts.next()?.trim().parse().ok()?;
    let mtime: u64 = parts.next()?.trim().parse().unwrap_or(0);
    let name = parts.next()?.to_string();
    if name.is_empty() || basename(&name).starts_with('.') {
        return None;
    }
    let ext = ext_lower(&name);
    let iso = iso_from_system(std::time::UNIX_EPOCH + Duration::from_secs(mtime));
    Some(AssetInfo {
        relative_path: format!("{ASSETS_DIR}/{name}"),
        size,
        mime_type: get_mime_type(&ext),
        is_image: is_image_ext(&ext),
        created_at: iso.clone(),
        modified_at: iso,
        name,
    })
}

// ── assets: implementation (AssetManager) ───────────────────────────────────

/// AssetManager.ensureAssetsDir — creates `.promptops-assets/` and updates .gitignore.
fn ensure_assets_dir(workspace_path: &str) -> Result<PathBuf, String> {
    let assets_dir = Path::new(workspace_path).join(ASSETS_DIR);
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    }
    ensure_gitignore(workspace_path);
    Ok(assets_dir)
}

/// AssetManager.ensureGitignore — ensures the two entries (assets + extensions).
/// Best-effort: failures don't interrupt the flow.
fn ensure_gitignore(workspace_path: &str) {
    let gitignore_path = Path::new(workspace_path).join(".gitignore");
    let wanted: [(&str, &str); 2] = [
        ("# PromptOps session assets", GITIGNORE_ENTRY),
        ("# PromptOps agent extensions", EXTENSIONS_GITIGNORE_ENTRY),
    ];

    let (content, exists) = match fs::read_to_string(&gitignore_path) {
        Ok(c) => (c, true),
        Err(_) => (String::new(), false),
    };

    let existing_lines: Vec<&str> = content.lines().map(|l| l.trim()).collect();
    let mut to_append = String::new();
    for (comment, entry) in wanted {
        if !existing_lines.contains(&entry) {
            to_append.push_str(&format!("\n{comment}\n{entry}\n"));
        }
    }
    if to_append.is_empty() {
        return;
    }

    if exists {
        let separator = if content.ends_with('\n') { "" } else { "\n" };
        if let Ok(mut f) = fs::OpenOptions::new().append(true).open(&gitignore_path) {
            let _ = f.write_all(format!("{separator}{to_append}").as_bytes());
        }
    } else {
        // .replace(/^\n/, '') — strip the first leading newline.
        let body = to_append
            .strip_prefix('\n')
            .unwrap_or(&to_append)
            .to_string();
        let _ = fs::write(&gitignore_path, body);
    }
}

/// AssetManager.listAssets.
fn list_assets(workspace_path: &str) -> Result<Vec<AssetInfo>, String> {
    let assets_dir = Path::new(workspace_path).join(ASSETS_DIR);
    if !assets_dir.exists() {
        return Ok(vec![]);
    }

    let mut assets: Vec<AssetInfo> = Vec::new();
    let entries = fs::read_dir(&assets_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file = entry.file_name().to_string_lossy().to_string();
        if file.starts_with('.') {
            continue;
        }
        let file_path = entry.path();
        let stat = fs::metadata(&file_path).map_err(|e| e.to_string())?;
        if !stat.is_file() {
            continue;
        }

        let ext = ext_lower(&file);
        assets.push(AssetInfo {
            name: file.clone(),
            relative_path: format!("{ASSETS_DIR}/{file}"),
            size: stat.len(),
            mime_type: get_mime_type(&ext),
            is_image: is_image_ext(&ext),
            created_at: birthtime_iso(&stat),
            modified_at: mtime_iso(&stat),
        });
    }

    // sort((a,b) => b.modifiedAt.localeCompare(a.modifiedAt)) — descending.
    assets.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(assets)
}

/// A local asset name: the last path component only, never `.`/`..`/empty.
/// The upload used the raw name, so `../../.zshrc` or an absolute path wrote
/// outside `.promptops-assets/`.
fn asset_name(file_name: &str) -> Result<String, String> {
    let name = basename(file_name);
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
        return Err(format!("Invalid asset name: {file_name}"));
    }
    #[cfg(windows)]
    if name.contains(':') {
        return Err(format!("Invalid asset name: {file_name}"));
    }
    Ok(name.to_string())
}

/// Largest asset read back into memory (same as the upload limit).
fn read_asset_bytes(file_path: &Path, label: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let meta = fs::metadata(file_path).map_err(|_| format!("Asset not found: {label}"))?;
    if !meta.is_file() {
        return Err(format!("Asset not found: {label}"));
    }
    if meta.len() > MAX_UPLOAD_SIZE {
        return Err("Asset too large to read (max 50 MB)".to_string());
    }
    let mut bytes = Vec::new();
    fs::File::open(file_path)
        .map_err(|e| e.to_string())?
        .take(MAX_UPLOAD_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_UPLOAD_SIZE {
        return Err("Asset too large to read (max 50 MB)".to_string());
    }
    Ok(bytes)
}

/// AssetManager.uploadAsset — name dedup, size check, write.
fn upload_asset(
    workspace_path: &str,
    file_name: &str,
    data_base64: &str,
) -> Result<AssetInfo, String> {
    let file_name = asset_name(file_name)?;
    let file_name = file_name.as_str();
    let assets_dir = ensure_assets_dir(workspace_path)?;
    let ext = ext_lower(file_name);

    // Dedup the name: base_1.ext, base_2.ext, …
    let mut final_name = file_name.to_string();
    let mut counter = 1u32;
    while fs::symlink_metadata(assets_dir.join(&final_name)).is_ok() {
        let base = file_stem(file_name, &ext);
        final_name = format!("{base}_{counter}{ext}");
        counter += 1;
    }

    let file_path = assets_dir.join(&final_name);
    let buffer = base64_decode(data_base64).map_err(|e| e.to_string())?;

    if buffer.len() as u64 > MAX_UPLOAD_SIZE {
        let mb = buffer.len() as f64 / 1024.0 / 1024.0;
        return Err(format!("File too large ({mb:.1} MB). Maximum: 50 MB"));
    }

    fs::write(&file_path, &buffer).map_err(|e| e.to_string())?;

    let stat = fs::metadata(&file_path).map_err(|e| e.to_string())?;
    Ok(AssetInfo {
        name: final_name.clone(),
        relative_path: format!("{ASSETS_DIR}/{final_name}"),
        size: stat.len(),
        mime_type: get_mime_type(&ext),
        is_image: is_image_ext(&ext),
        created_at: birthtime_iso(&stat),
        modified_at: mtime_iso(&stat),
    })
}

/// AssetManager.deleteAsset.
fn delete_asset(workspace_path: &str, file_name: &str) -> Result<bool, String> {
    let file_path = Path::new(workspace_path)
        .join(ASSETS_DIR)
        .join(asset_name(file_name)?);
    if !fs::symlink_metadata(&file_path)
        .map(|m| !m.is_dir())
        .unwrap_or(false)
    {
        return Ok(false);
    }
    fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// AssetManager.renameAsset.
fn rename_asset(workspace_path: &str, old_name: &str, new_name: &str) -> Result<AssetInfo, String> {
    let assets_dir = Path::new(workspace_path).join(ASSETS_DIR);
    let old_path = assets_dir.join(asset_name(old_name)?);
    let new_path = assets_dir.join(asset_name(new_name)?);

    if !fs::symlink_metadata(&old_path).is_ok_and(|m| !m.is_dir()) {
        return Err(format!("Asset not found: {old_name}"));
    }
    if fs::symlink_metadata(&new_path).is_ok() {
        return Err(format!("Asset already exists: {new_name}"));
    }

    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

    let stat = fs::metadata(&new_path).map_err(|e| e.to_string())?;
    let base = basename(new_name);
    let ext = ext_lower(new_name);
    Ok(AssetInfo {
        name: base.clone(),
        relative_path: format!("{ASSETS_DIR}/{base}"),
        size: stat.len(),
        mime_type: get_mime_type(&ext),
        is_image: is_image_ext(&ext),
        created_at: birthtime_iso(&stat),
        modified_at: mtime_iso(&stat),
    })
}

/// AssetManager.readAssetText.
fn read_asset_text(workspace_path: &str, file_name: &str) -> Result<String, String> {
    let file_path = Path::new(workspace_path)
        .join(ASSETS_DIR)
        .join(asset_name(file_name)?);
    let bytes = read_asset_bytes(&file_path, file_name)?;
    String::from_utf8(bytes).map_err(|_| "Asset is not a text file".to_string())
}

/// AssetManager.readAssetBase64 → `{ data, mimeType }`.
fn read_asset_base64(workspace_path: &str, file_name: &str) -> Result<(String, String), String> {
    let file_path = Path::new(workspace_path)
        .join(ASSETS_DIR)
        .join(asset_name(file_name)?);
    let buffer = read_asset_bytes(&file_path, file_name)?;
    let ext = ext_lower(file_name);
    Ok((base64_encode(&buffer), get_mime_type(&ext)))
}

/// AssetManager.isImageExt.
fn is_image_ext(ext: &str) -> bool {
    matches!(ext, ".png" | ".jpg" | ".jpeg" | ".webp" | ".gif")
}

/// AssetManager.getMimeType — maps extension → mime.
pub fn get_mime_type(ext: &str) -> String {
    let mime = match ext {
        ".png" => "image/png",
        ".jpg" => "image/jpeg",
        ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".pdf" => "application/pdf",
        ".txt" => "text/plain",
        ".log" => "text/plain",
        ".csv" => "text/csv",
        ".json" => "application/json",
        ".md" => "text/markdown",
        ".xml" => "application/xml",
        ".yaml" => "text/yaml",
        ".yml" => "text/yaml",
        ".html" => "text/html",
        ".css" => "text/css",
        ".js" => "application/javascript",
        ".ts" => "application/typescript",
        ".zip" => "application/zip",
        ".tar" => "application/x-tar",
        ".gz" => "application/gzip",
        ".cer" => "application/x-x509-ca-cert",
        ".pem" => "application/x-pem-file",
        ".p12" => "application/x-pkcs12",
        ".key" => "application/x-pem-file",
        ".crt" => "application/x-x509-ca-cert",
        ".env" => "text/plain",
        ".sh" => "application/x-sh",
        ".sql" => "application/sql",
        ".doc" => "application/msword",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls" => "application/vnd.ms-excel",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".ppt" => "application/vnd.ms-powerpoint",
        ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

// ════════════════════════════════════════════════════════════════════════════
// extensions:* — Agent Extensions Catalog (MCP / Skills / Plugins).
// ════════════════════════════════════════════════════════════════════════════

/// SecretSpec — shape shared with the web UI.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSpec {
    pub key: String,
    pub label: String,
    pub env_var: String,
}

/// MaterializationRecipe — shape shared with the web UI.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializationRecipe {
    /// 'config-file' | 'skill-folder'.
    pub strategy: String,
    pub target_rel_path: String,
    /// 'json' | 'markdown'.
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_flag: Option<String>,
    /// config-file → object; skill-folder → markdown string.
    pub payload: Value,
}

/// CatalogItem — shape shared with the web UI.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub item_id: String,
    /// 'mcp' | 'skill' | 'plugin'.
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_secrets: Option<Vec<SecretSpec>>,
    /// Per-provider install recipes (key = ProviderType).
    pub install: HashMap<String, MaterializationRecipe>,
}

/// ExtensionSelection — shape shared with the web UI.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSelection {
    pub items: Vec<CatalogItem>,
    /// Map envVar → value. Never persisted to disk; injected into the PTY env.
    #[serde(default)]
    pub secrets: HashMap<String, String>,
}

/// Materialize request (`MaterializeRequest`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeRequest {
    pub workspace_path: Option<String>,
    pub provider: Option<String>,
    pub selection: Option<ExtensionSelection>,
}

/// ExtensionMaterializeResult — shape shared with the web UI.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionMaterializeResult {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub launch_args: Vec<String>,
    pub secret_env: HashMap<String, String>,
    pub warnings: Vec<String>,
}

/// extensions:catalog-list — `{ ok, items }`. This edition ships no shared
/// extensions catalog, so the list is always empty; the extensions installed
/// in a workspace are read with `extensions_installed`.
#[tauri::command]
pub async fn extensions_catalog_list(
    _state: tauri::State<'_, Arc<ExtensionsState>>,
    _query: Option<Value>,
) -> Result<Value, String> {
    Ok(json!({ "ok": true, "items": [] }))
}

/// extensions:materialize — writes the provider-native configs for a selection.
/// Mirror of `EXTENSIONS_MATERIALIZE` → `{ ok, result }`.
#[tauri::command]
pub fn extensions_materialize(
    state: tauri::State<'_, Arc<ExtensionsState>>,
    req: MaterializeRequest,
) -> Value {
    let (workspace_path, provider, selection) =
        match (req.workspace_path, req.provider, req.selection) {
            (Some(w), Some(p), Some(s)) if !w.is_empty() && !p.is_empty() => (w, p, s),
            _ => {
                return json!({
                    "ok": false,
                    "error": "workspacePath, provider and selection are required."
                })
            }
        };

    // Per-workspace serialization (sync mutex).
    // We keep the lock's Arc alive and lock it locally for the duration.
    let gate = state.workspace_lock(&workspace_path);
    let _guard = gate.lock();
    match materialize(&workspace_path, &provider, &selection) {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// extensions:installed — reads the workspace lock manifest.
/// Mirror of `EXTENSIONS_INSTALLED` → `{ ok, lock }` (null if absent/unreadable).
#[tauri::command]
pub fn extensions_installed(workspace_path: String) -> Value {
    let lock_path = Path::new(&workspace_path).join(EXTENSIONS_LOCK_REL_PATH);
    match fs::read_to_string(&lock_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(lock) => json!({ "ok": true, "lock": lock }),
        // No lock or failed parse → nothing installed by us.
        None => json!({ "ok": true, "lock": Value::Null }),
    }
}

// ── extensions: implementation (Materializer) ────────────────

/// Accumulator for a config-file file (ConfigGroup).
struct ConfigGroup {
    rel_path: String,
    merge_key: Option<String>,
    launch_flag: Option<String>,
    entries: Map<String, Value>,
    item_ids: Vec<String>,
}

/// ExtensionMaterializer.doMaterialize — non-destructive merge,
/// idempotency, secret collection and lock manifest writing.
fn materialize(
    workspace_path: &str,
    provider: &str,
    selection: &ExtensionSelection,
) -> Result<ExtensionMaterializeResult, String> {
    let mut result = ExtensionMaterializeResult::default();

    // Deterministic order by targetRelPath (the JS Map preserves insertion;
    // here BTreeMap gives a stable order, irrelevant for the written content).
    let mut config_groups: BTreeMap<String, ConfigGroup> = BTreeMap::new();

    // Lock manifest (LockManifest): items keyed by itemId.
    let mut lock_items: Map<String, Value> = Map::new();

    for item in &selection.items {
        let recipe = match item.install.get(provider) {
            Some(r) => r,
            None => {
                result.warnings.push(format!(
                    "No recipe for \"{}\" on provider \"{}\" — skipped.",
                    item.item_id, provider
                ));
                continue;
            }
        };

        // Recipes write under the workspace only: never an absolute path or `..`.
        if let Err(e) = check_target_rel_path(&recipe.target_rel_path) {
            result
                .warnings
                .push(format!("\"{}\" skipped: {e}", item.item_id));
            continue;
        }
        match recipe.strategy.as_str() {
            "config-file" => collect_config_recipe(
                item,
                recipe,
                workspace_path,
                &mut config_groups,
                &mut result,
            ),
            "skill-folder" => {
                write_skill_recipe(item, recipe, workspace_path, &mut lock_items, &mut result)?
            }
            "skill-link" => {
                link_skill_recipe(item, recipe, workspace_path, &mut lock_items, &mut result)?
            }
            _ => result.warnings.push(format!(
                "Unknown strategy for \"{}\" — skipped.",
                item.item_id
            )),
        }
    }

    // Flush of the config-file groups (a single merged write per file).
    for group in config_groups.values() {
        flush_config_group(group, workspace_path, &mut lock_items, &mut result)?;
    }

    // Secret → env (never written to disk).
    collect_secrets(selection, &mut result);

    write_lock(workspace_path, provider, &lock_items)?;
    Ok(result)
}

/// `targetRelPath` of a recipe: relative, without `..`, `.` or root components.
fn check_target_rel_path(rel: &str) -> Result<(), String> {
    use std::path::Component;
    if rel.trim().is_empty() || rel.contains('\0') {
        return Err("empty target path".to_string());
    }
    // Drive letters (`C:x`) and alternate data streams on Windows.
    if rel.contains(':') {
        return Err(format!(
            "target path \"{rel}\" must stay inside the workspace"
        ));
    }
    let normalized = rel.replace('\\', "/");
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "target path \"{rel}\" must stay inside the workspace"
                ))
            }
        }
    }
    Ok(())
}

/// ExtensionMaterializer.collectConfigRecipe.
fn collect_config_recipe(
    item: &CatalogItem,
    recipe: &MaterializationRecipe,
    workspace_path: &str,
    groups: &mut BTreeMap<String, ConfigGroup>,
    result: &mut ExtensionMaterializeResult,
) {
    if !recipe.payload.is_object() {
        result.warnings.push(format!(
            "Config recipe for \"{}\" has an invalid payload — skipped.",
            item.item_id
        ));
        return;
    }

    let key = recipe.target_rel_path.clone();
    let group = groups.entry(key).or_insert_with(|| ConfigGroup {
        rel_path: recipe.target_rel_path.clone(),
        merge_key: recipe.merge_key.clone(),
        launch_flag: recipe.launch_flag.clone(),
        entries: Map::new(),
        item_ids: Vec::new(),
    });

    let substituted = substitute_workspace(&recipe.payload, workspace_path);
    if let Some(obj) = substituted.as_object() {
        deep_merge_into(&mut group.entries, obj);
    }
    group.item_ids.push(item.item_id.clone());
}

/// ExtensionMaterializer.flushConfigGroup.
fn flush_config_group(
    group: &ConfigGroup,
    workspace_path: &str,
    lock_items: &mut Map<String, Value>,
    result: &mut ExtensionMaterializeResult,
) -> Result<(), String> {
    let abs_path = Path::new(workspace_path).join(&group.rel_path);

    // Reads + parses the existing file (preserves unrelated user keys).
    let current_content = fs::read_to_string(&abs_path).ok();
    let mut root: Map<String, Value> = current_content
        .as_ref()
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    if let Some(merge_key) = &group.merge_key {
        // Merge under a single top-level key (e.g. 'mcpServers').
        let mut section = root
            .get(merge_key)
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        deep_merge_into(&mut section, &group.entries);
        root.insert(merge_key.clone(), Value::Object(section));
    } else {
        // No mergeKey → deep-merge of the whole payload into the JSON root.
        deep_merge_into(&mut root, &group.entries);
    }

    // JSON.stringify(root, null, 2) + '\n'.
    let next_content = format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?
    );

    let abs_str = abs_path.to_string_lossy().to_string();
    if current_content.as_deref() == Some(next_content.as_str()) {
        result.skipped.push(abs_str.clone());
    } else {
        if let Some(parent) = abs_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&abs_path, &next_content).map_err(|e| e.to_string())?;
        result.written.push(abs_str.clone());
    }

    // Launch flag: one (flag, file) pair per target file.
    if let Some(flag) = &group.launch_flag {
        result.launch_args.push(flag.clone());
        result.launch_args.push(abs_str.clone());
    }

    // Records in the lock manifest.
    let managed_keys: Vec<Value> = group
        .entries
        .keys()
        .map(|k| Value::String(k.clone()))
        .collect();
    for item_id in &group.item_ids {
        lock_items.insert(
            item_id.clone(),
            json!({ "strategy": "config-file", "file": group.rel_path, "keys": managed_keys }),
        );
    }
    Ok(())
}

/// ExtensionMaterializer.writeSkillRecipe.
fn write_skill_recipe(
    item: &CatalogItem,
    recipe: &MaterializationRecipe,
    workspace_path: &str,
    lock_items: &mut Map<String, Value>,
    result: &mut ExtensionMaterializeResult,
) -> Result<(), String> {
    let body = match recipe.payload.as_str() {
        Some(s) => substitute_string(s, workspace_path),
        None => {
            result.warnings.push(format!(
                "Skill recipe for \"{}\" has a non-string payload — skipped.",
                item.item_id
            ));
            return Ok(());
        }
    };
    let abs_path = Path::new(workspace_path).join(&recipe.target_rel_path);
    let abs_str = abs_path.to_string_lossy().to_string();

    let current_content = fs::read_to_string(&abs_path).ok();
    if current_content.as_deref() == Some(body.as_str()) {
        result.skipped.push(abs_str);
    } else {
        if let Some(parent) = abs_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&abs_path, &body).map_err(|e| e.to_string())?;
        result.written.push(abs_str);
    }

    lock_items.insert(
        item.item_id.clone(),
        json!({ "strategy": "skill-folder", "file": recipe.target_rel_path }),
    );
    Ok(())
}

/// Local skill (~/.agents): links the source folder into the workspace instead of
/// copying only its SKILL.md, so the skill's scripts/references stay
/// available and changes made in ~/.agents show up immediately. On Windows
/// symlinks require privileges → recursive copy. Never overwrites an
/// existing folder/file that isn't our link.
fn link_skill_recipe(
    item: &CatalogItem,
    recipe: &MaterializationRecipe,
    workspace_path: &str,
    lock_items: &mut Map<String, Value>,
    result: &mut ExtensionMaterializeResult,
) -> Result<(), String> {
    let source = match recipe.payload.as_str().map(PathBuf::from) {
        Some(p) if p.join("SKILL.md").is_file() => p,
        _ => {
            result.warnings.push(format!(
                "Local skill \"{}\" no longer exists — skipped.",
                item.item_id
            ));
            return Ok(());
        }
    };
    let target = Path::new(workspace_path).join(&recipe.target_rel_path);
    let target_str = target.to_string_lossy().to_string();

    if let Ok(meta) = fs::symlink_metadata(&target) {
        let same_link = meta.file_type().is_symlink()
            && fs::read_link(&target).map(|l| l == source).unwrap_or(false);
        if same_link || cfg!(windows) && meta.is_dir() {
            result.skipped.push(target_str);
        } else {
            result.warnings.push(format!(
                "\"{}\" already exists and is not linked to {} — left untouched.",
                target_str,
                source.display()
            ));
            return Ok(());
        }
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, &target).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        copy_dir_recursive(&source, &target, 0)?;
        result.written.push(target_str);
    }

    lock_items.insert(
        item.item_id.clone(),
        json!({ "strategy": "skill-link", "file": recipe.target_rel_path, "source": source.to_string_lossy() }),
    );
    Ok(())
}

#[cfg(windows)]
fn copy_dir_recursive(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > 8 {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest, depth + 1)?;
        } else {
            fs::copy(&path, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── local skills (~/.agents) ────────────────────────────────────────────────

/// Maximum number of skills returned and max size of a read SKILL.md.
const LOCAL_SKILLS_MAX: usize = 300;
const LOCAL_SKILL_MD_MAX_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkill {
    pub slug: String,
    pub name: String,
    pub description: String,
    /// Skill folder (resolved if it is a symlink).
    pub dir_path: String,
    /// Root it was found from (e.g. ~/.agents/skills).
    pub root: String,
}

/// extensions:local-skills — skills the user keeps centralized in
/// `~/.agents` (cross-harness convention, linked via symlink). Looks for
/// `~/.agents/skills/<skill>/SKILL.md` and `~/.agents/<skill>/SKILL.md`,
/// following symlinks. Read-only: touches nothing.
#[tauri::command]
pub fn extensions_local_skills() -> Value {
    let home = {
        let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        match std::env::var(var) {
            Ok(h) if !h.is_empty() => PathBuf::from(h),
            _ => return json!({ "ok": true, "items": [] }),
        }
    };
    let agents = home.join(".agents");
    let roots = [agents.join("skills"), agents.clone()];
    json!({ "ok": true, "items": scan_local_skills(&roots) })
}

fn scan_local_skills(roots: &[PathBuf]) -> Vec<LocalSkill> {
    let mut out: Vec<LocalSkill> = Vec::new();
    let mut seen_dirs: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut seen_slugs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        dirs.sort();
        for dir in dirs {
            if out.len() >= LOCAL_SKILLS_MAX {
                return out;
            }
            // is_file/metadata follow symlinks (skills linked from elsewhere).
            let md = dir.join("SKILL.md");
            let Ok(meta) = fs::metadata(&md) else {
                continue;
            };
            if !meta.is_file() || meta.len() > LOCAL_SKILL_MD_MAX_BYTES {
                continue;
            }
            let real = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
            if !seen_dirs.insert(real.clone()) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&md) else {
                continue;
            };
            let fm = parse_skill_frontmatter(&raw);
            let folder = dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = fm
                .get("name")
                .cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| folder.clone());
            let slug = slugify_skill(&folder);
            if slug.is_empty() || !seen_slugs.insert(slug.clone()) {
                continue;
            }
            out.push(LocalSkill {
                slug,
                name,
                description: fm.get("description").cloned().unwrap_or_default(),
                dir_path: real.to_string_lossy().to_string(),
                root: root.to_string_lossy().to_string(),
            });
        }
    }
    out
}

/// Minimal `key: value` frontmatter (like parseFrontmatter on the webapp side).
fn parse_skill_frontmatter(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let text = raw.replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else {
        return map;
    };
    let Some(end) = rest.find("\n---") else {
        return map;
    };
    for line in rest[..end].lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            map.insert(k.trim().to_string(), v);
        }
    }
    map
}

fn slugify_skill(value: &str) -> String {
    let mut slug = String::new();
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').chars().take(60).collect()
}

/// ExtensionMaterializer.collectSecrets.
fn collect_secrets(selection: &ExtensionSelection, result: &mut ExtensionMaterializeResult) {
    for item in &selection.items {
        for spec in item.requires_secrets.iter().flatten() {
            match selection.secrets.get(&spec.env_var) {
                Some(value) if !value.is_empty() => {
                    result
                        .secret_env
                        .insert(spec.env_var.clone(), value.clone());
                }
                _ => result.warnings.push(format!(
                    "Missing secret \"{}\" for \"{}\" — it may not work until provided.",
                    spec.env_var, item.item_id
                )),
            }
        }
    }
}

/// ExtensionMaterializer.writeLock — no-op if there is nothing to record.
fn write_lock(
    workspace_path: &str,
    provider: &str,
    lock_items: &Map<String, Value>,
) -> Result<(), String> {
    if lock_items.is_empty() {
        return Ok(());
    }
    let lock = json!({
        "version": 1,
        "provider": provider,
        "updatedAt": now_iso(),
        "items": Value::Object(lock_items.clone()),
    });
    let abs_path = Path::new(workspace_path).join(EXTENSIONS_LOCK_REL_PATH);
    if let Some(parent) = abs_path.parent() {
        // Best-effort: on failure we continue.
        let _ = fs::create_dir_all(parent);
    }
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?
    );
    let _ = fs::write(&abs_path, body);
    Ok(())
}

/// ExtensionMaterializer.deepMergeInto — objects merged deeply, the rest
/// replaced (arrays included).
fn deep_merge_into(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (k, v) in source {
        let merge =
            matches!(v, Value::Object(_)) && matches!(target.get(k), Some(Value::Object(_)));
        if merge {
            if let (Some(Value::Object(existing)), Value::Object(src)) = (target.get_mut(k), v) {
                deep_merge_into(existing, src);
            }
        } else {
            target.insert(k.clone(), v.clone());
        }
    }
}

/// ExtensionMaterializer.substituteWorkspace — replaces `${WORKSPACE}` in every
/// string (recursive over arrays/objects).
fn substitute_workspace(value: &Value, workspace_path: &str) -> Value {
    match value {
        Value::String(s) => Value::String(substitute_string(s, workspace_path)),
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| substitute_workspace(v, workspace_path))
                .collect(),
        ),
        Value::Object(obj) => {
            let mut out = Map::new();
            for (k, v) in obj {
                out.insert(k.clone(), substitute_workspace(v, workspace_path));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `'…'.split(WORKSPACE_PLACEHOLDER).join(workspacePath)`.
fn substitute_string(s: &str, workspace_path: &str) -> String {
    s.replace(WORKSPACE_PLACEHOLDER, workspace_path)
}

// ════════════════════════════════════════════════════════════════════════════
// fcc-config:* — PromptOps CLI provider config + connection test.
// ════════════════════════════════════════════════════════════════════════════

/// ModelEntry — fcc-config store model entry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: &'static str,
    /// 'low' | 'medium' | 'high'.
    pub tier: &'static str,
    pub ram: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_cmd: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_cmd: Option<&'static str>,
}

/// FccProviderEntry — fcc-config store provider entry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FccProviderEntry {
    pub id: &'static str,
    pub name: &'static str,
    /// 'local' | 'cloud-free' | 'cloud-paid'.
    pub tier: &'static str,
    pub requires_api_key: bool,
    pub default_base_url: &'static str,
    pub default_model: &'static str,
    pub models: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_details: Option<Vec<ModelEntry>>,
}

/// FccConfig — fcc-config store contents.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FccConfig {
    pub provider: String,
    pub model: String,
    /// Never written to `fcc-config.json`: the key lives in the encrypted
    /// local store (`secrets/fcc_api_key`). It is filled in by `load()` for
    /// the settings page, and only read from the file to migrate a key that
    /// an older build saved there in clear text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Tells the CLI that a key exists and must be fetched from the app.
    #[serde(default)]
    pub has_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_thinking: Option<bool>,
    pub configured: bool,
    pub updated_at: String,
}

/// Input config for `save` — `Omit<FccConfig, 'updatedAt'>`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FccConfigInput {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub enable_thinking: Option<bool>,
    pub configured: bool,
}

/// fcc-config:get — persisted config (null if absent). Mirror `FCC_CONFIG_GET`.
#[tauri::command]
pub fn fcc_config_get(state: tauri::State<'_, Arc<FccConfigState>>) -> Value {
    json!({ "ok": true, "data": state.load() })
}

/// fcc-config:save — saves the config (the API key goes to the encrypted
/// local store, the rest to `fcc-config.json`). Mirror `FCC_CONFIG_SAVE`.
#[tauri::command]
pub fn fcc_config_save(
    state: tauri::State<'_, Arc<FccConfigState>>,
    config: FccConfigInput,
) -> Value {
    match state.save(&config) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// The PromptOps CLI API key saved in the app, for the `promptops` CLI
/// running in a PromptOps terminal (served by the control plane).
pub(crate) fn fcc_saved_api_key() -> Option<String> {
    read_fcc_api_key()
}

/// Collection and record id of the CLI API key in the encrypted local store
/// (same collection as the Groq key in `voice.rs`).
const FCC_SECRETS: &str = "secrets";
const FCC_KEY_ID: &str = "fcc_api_key";

fn read_fcc_api_key() -> Option<String> {
    crate::local_store::get()?
        .get(FCC_SECRETS, FCC_KEY_ID)?
        .get("value")?
        .as_str()
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

fn write_fcc_api_key(key: Option<&str>) -> Result<(), String> {
    let store = crate::local_store::get()
        .ok_or_else(|| "The encrypted local store is not available".to_string())?;
    match key {
        Some(k) => store.put(FCC_SECRETS, FCC_KEY_ID, json!({ "value": k })),
        None => store.delete(FCC_SECRETS, FCC_KEY_ID),
    }
}

/// fcc-config:test — tests the config with an OpenAI-compatible POST /chat/completions.
/// Handles `FCC_CONFIG_TEST` (baseUrl normalization, 15s timeout, handling of
/// 404/empty/timeout errors).
#[tauri::command]
pub async fn fcc_config_test(
    state: tauri::State<'_, Arc<FccConfigState>>,
) -> Result<Value, String> {
    let config = match state.load() {
        Some(c) if c.configured => c,
        _ => return Ok(json!({ "ok": false, "error": "Not configured" })),
    };

    let catalog = fcc_catalog_entry(&config.provider);

    let base_url = config
        .base_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| catalog.map(|c| c.default_base_url))
        .unwrap_or("");
    let base_url = match normalize_fcc_base_url(base_url) {
        Ok(url) => url,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    let chat_url = format!("{base_url}/chat/completions");

    let mut req = reqwest::Client::new()
        .post(&chat_url)
        .timeout(Duration::from_secs(120))
        .header("Content-Type", "application/json");
    if let Some(key) = config.api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let body = json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "Reply with only the word \"ok\"." }],
        "max_tokens": 256,
        "stream": false,
    });

    let provider_name = catalog
        .map(|c| c.name.to_string())
        .unwrap_or_else(|| config.provider.clone());

    let resp = match req.json(&body).send().await {
        Ok(r) => r,
        Err(err) => {
            // TimeoutError/AbortError → "Connection timeout …", otherwise "Connection failed …".
            if err.is_timeout() {
                return Ok(json!({
                    "ok": false,
                    "error": format!("Connection timeout — is {provider_name} running?")
                }));
            }
            return Ok(json!({ "ok": false, "error": format!("Connection failed: {err}") }));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        // detail = errJson.error?.message || errJson.error || raw.slice(0,300).
        let mut detail: String = err_text.chars().take(300).collect();
        if let Ok(err_json) = serde_json::from_str::<Value>(&err_text) {
            if let Some(msg) = err_json
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
            {
                detail = msg.to_string();
            } else if let Some(e) = err_json.get("error").and_then(|e| e.as_str()) {
                detail = e.to_string();
            }
        }

        if status.as_u16() == 404 && detail.contains("not found") {
            return Ok(json!({
                "ok": false,
                "error": format!("Model \"{}\" not found. Make sure it's downloaded and running.", config.model)
            }));
        }
        return Ok(
            json!({ "ok": false, "error": format!("API Error {}: {detail}", status.as_u16()) }),
        );
    }

    let data: Value = resp.json().await.unwrap_or(Value::Null);
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    if !content.is_empty() {
        let snippet: String = content.trim().chars().take(50).collect();
        Ok(json!({
            "ok": true,
            "message": format!("{provider_name} · {} is working. Response: \"{snippet}\"", config.model)
        }))
    } else {
        Ok(json!({
            "ok": false,
            "error": format!("{provider_name} responded but returned empty content. Check the model name.")
        }))
    }
}

/// fcc-config:catalog — static provider catalog. Mirror `FCC_CONFIG_CATALOG`.
#[tauri::command]
pub fn fcc_config_catalog() -> Value {
    json!({ "ok": true, "data": fcc_provider_catalog() })
}

/// Shared endpoint convention with cli/config.mjs: preserve custom API paths.
fn normalize_fcc_base_url(raw: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(raw.trim())
        .map_err(|_| "Enter a valid HTTP(S) base URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTP(S) base URL without credentials, query or fragment".into());
    }
    let path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .to_string();
    url.set_path(if path.is_empty() { "/v1" } else { &path });
    Ok(url.to_string().trim_end_matches('/').to_string())
}

/// FCC_PROVIDER_CATALOG.find(p => p.id === provider).
fn fcc_catalog_entry(provider: &str) -> Option<&'static FccProviderEntry> {
    fcc_catalog().iter().find(|p| p.id == provider)
}

// ════════════════════════════════════════════════════════════════════════════
// State to manage (registered in lib.rs via .manage(Arc::new(...))).
// ════════════════════════════════════════════════════════════════════════════

/// extensions domain state: mutex to serialize per-workspace
/// materialization (one lock per workspace).
#[derive(Default)]
pub struct ExtensionsState {
    /// Per-workspace mutex (ExtensionMaterializer.locks).
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl ExtensionsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the workspace's Arc<Mutex> (ExtensionMaterializer.locks).
    /// The caller locks it to serialize materializations on the same path.
    fn workspace_lock(&self, workspace_path: &str) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock();
        map.entry(workspace_path.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

/// fcc-config domain state: path of the `fcc-config.json` file in userData.
pub struct FccConfigState {
    file_path: PathBuf,
}

impl FccConfigState {
    /// FccConfigStore(filename = 'fcc-config.json') — file in the app's userData.
    pub fn new() -> Self {
        Self {
            file_path: app_data_dir().join("fcc-config.json"),
        }
    }

    /// FccConfigStore.save — key to the encrypted store, the rest (with
    /// updatedAt now) to the JSON file, mode 0600.
    fn save(&self, input: &FccConfigInput) -> Result<(), String> {
        let key = input
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        write_fcc_api_key(key)?;
        let data = FccConfig {
            provider: input.provider.clone(),
            model: input.model.clone(),
            api_key: None,
            has_api_key: key.is_some(),
            base_url: input.base_url.clone(),
            enable_thinking: input.enable_thinking,
            configured: input.configured,
            updated_at: now_iso(),
        };
        self.write_file(&data)
    }

    fn write_file(&self, data: &FccConfig) -> Result<(), String> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        crate::local_store::write_private(&self.file_path, body.as_bytes())
    }

    /// FccConfigStore.load — null on absent/unreadable file or failed parse.
    /// The API key comes from the encrypted store. A clear-text key left in
    /// the file by an older build is moved there and removed from the file.
    fn load(&self) -> Option<FccConfig> {
        if !self.file_path.exists() {
            return None;
        }
        let raw = fs::read_to_string(&self.file_path).ok()?;
        let mut config = serde_json::from_str::<FccConfig>(&raw).ok()?;
        if let Some(legacy) = config.api_key.take().filter(|k| !k.trim().is_empty()) {
            if write_fcc_api_key(Some(legacy.trim())).is_ok() {
                config.has_api_key = true;
                let _ = self.write_file(&config);
            } else {
                // Store unavailable: keep serving the key, retry next time.
                config.api_key = Some(legacy);
                return Some(config);
            }
        }
        config.api_key = read_fcc_api_key();
        config.has_api_key = config.api_key.is_some();
        Some(config)
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Shared helpers: path, time, inline base64, open-folder, data-dir.
// ════════════════════════════════════════════════════════════════════════════

/// `path.basename` (file name only, separator '/' or '\\').
fn basename(p: &str) -> String {
    let p = p.replace('\\', "/");
    p.rsplit('/').next().unwrap_or(&p).to_string()
}

/// `path.extname(name).toLowerCase()` — includes the dot, "" if absent.
/// Mirror of Node's behavior: no extension for dotfiles like ".env".
fn ext_lower(name: &str) -> String {
    let base = basename(name);
    // Node: a name that starts with '.' and has no other dots → no extname.
    match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(idx) => base[idx..].to_lowercase(),
    }
}

/// `path.basename(file, ext)` — name without the final extension.
fn file_stem(name: &str, ext: &str) -> String {
    let base = basename(name);
    if !ext.is_empty() && base.to_lowercase().ends_with(ext) {
        base[..base.len() - ext.len()].to_string()
    } else {
        base
    }
}

/// ISO-8601 UTC with milliseconds (same format as JavaScript's `Date.toISOString()`).
fn now_iso() -> String {
    iso_from_system(std::time::SystemTime::now())
}

/// `stat.mtime.toISOString()`.
fn mtime_iso(stat: &fs::Metadata) -> String {
    stat.modified()
        .ok()
        .map(iso_from_system)
        .unwrap_or_default()
}

/// `stat.birthtime.toISOString()` — falls back to created/modified like the OS does.
fn birthtime_iso(stat: &fs::Metadata) -> String {
    stat.created()
        .or_else(|_| stat.modified())
        .ok()
        .map(iso_from_system)
        .unwrap_or_default()
}

/// Formats a SystemTime as ISO-8601 UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`
/// (civil algorithm, no external dependencies).
fn iso_from_system(t: std::time::SystemTime) -> String {
    let dur = match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();

    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Days-since-epoch → civil date conversion (Howard Hinnant).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// The app's data folder (`APP_DIR_NAME`, "promptops-oss"), consistent with
/// `commands/device.rs`. The CLI reads its non-secret config from here.
///
/// TODO: use `AppHandle::path().app_data_dir()` when the command has
/// access to the AppHandle, so the path matches the Tauri runtime.
pub(crate) fn cli_config_path() -> PathBuf {
    app_data_dir().join("fcc-config.json")
}

fn app_data_dir() -> PathBuf {
    dirs_data_dir().join(crate::APP_DIR_NAME)
}

/// OS-specific data dir (same folder logic as device.rs).
fn dirs_data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
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
    }
}

/// Extensions a file coming from a REMOTE host may be opened with directly.
/// The outbox is collected automatically while a remote session is open, so
/// opening anything else meant that whatever the remote agent (or whoever
/// controls the host) dropped in `out/` ran locally: `.bat`/`.exe`/`.js`/`.lnk`
/// through Explorer, `.terminal`/`.command`/`.fileloc` on macOS, `.desktop` on
/// Linux. Everything else is revealed in the file manager instead.
const SAFE_TO_OPEN_EXT: &[&str] = &[
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".txt",
    ".md", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".mp3", ".wav", ".m4a",
    ".mp4", ".mov", ".webm",
];

fn is_safe_to_open(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    SAFE_TO_OPEN_EXT.contains(&ext_lower(&name).as_str())
}

/// Opens a downloaded file when its type is inert, otherwise shows it in the
/// file manager. `Ok(true)` = opened, `Ok(false)` = revealed.
fn open_downloaded(p: &Path) -> Result<bool, String> {
    if is_safe_to_open(p) {
        open_path(p).map(|_| true)
    } else {
        reveal_path(p).map(|_| false)
    }
}

/// Selects the file in the system file manager without opening it.
fn reveal_path(p: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<std::ffi::OsString>) = ("open", vec!["-R".into(), p.into()]);
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<std::ffi::OsString>) = {
        let mut sel = std::ffi::OsString::from("/select,");
        sel.push(p);
        ("explorer", vec![sel])
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let (cmd, args): (&str, Vec<std::ffi::OsString>) = (
        "xdg-open",
        vec![p.parent().unwrap_or(Path::new("/")).into()],
    );
    let status = crate::commands::util_cmd::cmd(cmd)
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() || cfg!(target_os = "windows") {
        Ok(())
    } else {
        Err(format!("{cmd} exited with {status}"))
    }
}

/// shell.openPath — opens a path in the system file manager.
fn open_path(p: &Path) -> Result<(), String> {
    let p = p.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    let (cmd, args) = ("open", vec![p.clone()]);
    #[cfg(target_os = "windows")]
    let (cmd, args) = ("explorer", vec![p.clone()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (cmd, args) = ("xdg-open", vec![p.clone()]);

    let status = crate::commands::util_cmd::cmd(cmd)
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    // `explorer` on Windows returns 1 even when it opens the window: it's not an error.
    if status.success() || cfg!(target_os = "windows") {
        Ok(())
    } else {
        Err(format!("{cmd} exited with {status}"))
    }
}

// ── inline base64 (no `base64` crate) ───────────────────────────────────────

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 encoding (with padding) — Buffer.toString('base64').
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Standard base64 decoding, tolerant of whitespace/missing padding —
/// Buffer.from(str, 'base64').
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut buf = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c).ok_or_else(|| format!("invalid base64 character: {}", c as char))?;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

// ════════════════════════════════════════════════════════════════════════════
// FCC_PROVIDER_CATALOG — local runtimes with suggested models, cloud
// providers with their endpoint only.
// ════════════════════════════════════════════════════════════════════════════

/// Concise helper to build a ModelEntry.
fn me(
    id: &'static str,
    tier: &'static str,
    ram: &'static str,
    recommended: Option<bool>,
    label: Option<&'static str>,
    install_cmd: Option<&'static str>,
    run_cmd: Option<&'static str>,
) -> ModelEntry {
    ModelEntry {
        id,
        tier,
        ram,
        recommended,
        label,
        install_cmd,
        run_cmd,
    }
}

use std::sync::OnceLock;

/// Static provider catalog, built only once (FCC_PROVIDER_CATALOG).
static FCC_CATALOG: OnceLock<Vec<FccProviderEntry>> = OnceLock::new();

/// Access to the static catalog (lazy-init).
fn fcc_catalog() -> &'static Vec<FccProviderEntry> {
    FCC_CATALOG.get_or_init(build_fcc_catalog)
}

/// Clones the catalog (the commands return an owned copy to the renderer).
fn fcc_provider_catalog() -> Vec<FccProviderEntry> {
    fcc_catalog().clone()
}

/// A cloud provider: API key, base URL, and the model left to the user.
fn cloud(
    id: &'static str,
    name: &'static str,
    tier: &'static str,
    base_url: &'static str,
) -> FccProviderEntry {
    FccProviderEntry {
        id,
        name,
        tier,
        requires_api_key: true,
        default_base_url: base_url,
        default_model: "",
        models: Vec::new(),
        model_details: None,
    }
}

fn build_fcc_catalog() -> Vec<FccProviderEntry> {
    vec![
        // ── Local (no API key) ──
        FccProviderEntry {
            id: "ollama", name: "Ollama", tier: "local", requires_api_key: false,
            default_base_url: "http://localhost:11434/v1",
            default_model: "qwen2.5-coder:14b",
            models: vec![
                "codegemma:7b", "qwen2.5-coder:7b", "codellama:7b",
                "qwen2.5-coder:14b", "starcoder2:15b", "deepseek-coder-v2:16b",
                "codestral:22b", "devstral:24b", "qwen2.5-coder:32b",
            ],
            model_details: Some(vec![
                me("codegemma:7b", "low", "~5 GB", None, None, Some("ollama pull codegemma:7b"), Some("ollama run codegemma:7b")),
                me("qwen2.5-coder:7b", "low", "~5 GB", Some(true), Some("light"), Some("ollama pull qwen2.5-coder:7b"), Some("ollama run qwen2.5-coder:7b")),
                me("codellama:7b", "low", "~5 GB", None, None, Some("ollama pull codellama:7b"), Some("ollama run codellama:7b")),
                me("qwen2.5-coder:14b", "medium", "~10 GB", Some(true), Some("balanced"), Some("ollama pull qwen2.5-coder:14b"), Some("ollama run qwen2.5-coder:14b")),
                me("starcoder2:15b", "medium", "~10 GB", None, None, Some("ollama pull starcoder2:15b"), Some("ollama run starcoder2:15b")),
                me("deepseek-coder-v2:16b", "medium", "~11 GB", None, None, Some("ollama pull deepseek-coder-v2:16b"), Some("ollama run deepseek-coder-v2:16b")),
                me("codestral:22b", "high", "~14 GB", None, None, Some("ollama pull codestral:22b"), Some("ollama run codestral:22b")),
                me("devstral:24b", "high", "~16 GB", Some(true), Some("power"), Some("ollama pull devstral:24b"), Some("ollama run devstral:24b")),
                me("qwen2.5-coder:32b", "high", "~22 GB", None, Some("quality"), Some("ollama pull qwen2.5-coder:32b"), Some("ollama run qwen2.5-coder:32b")),
            ]),
        },
        FccProviderEntry {
            id: "lm_studio", name: "LM Studio", tier: "local", requires_api_key: false,
            default_base_url: "http://localhost:1234/v1",
            default_model: "qwen2.5-coder-14b",
            models: vec![
                "codegemma-7b", "qwen2.5-coder-7b",
                "qwen2.5-coder-14b", "starcoder2-15b", "deepseek-coder-v2-16b",
                "codestral-22b", "qwen2.5-coder-32b",
            ],
            model_details: Some(vec![
                me("codegemma-7b", "low", "~5 GB", None, None, None, None),
                me("qwen2.5-coder-7b", "low", "~5 GB", Some(true), Some("light"), None, None),
                me("qwen2.5-coder-14b", "medium", "~10 GB", Some(true), Some("balanced"), None, None),
                me("starcoder2-15b", "medium", "~10 GB", None, None, None, None),
                me("deepseek-coder-v2-16b", "medium", "~11 GB", None, None, None, None),
                me("codestral-22b", "high", "~14 GB", Some(true), Some("power"), None, None),
                me("qwen2.5-coder-32b", "high", "~22 GB", None, Some("quality"), None, None),
            ]),
        },
        FccProviderEntry {
            id: "llamacpp", name: "llama.cpp", tier: "local", requires_api_key: false,
            default_base_url: "http://localhost:8080/v1",
            default_model: "qwen2.5-coder-14b",
            models: vec!["qwen2.5-coder-7b", "qwen2.5-coder-14b", "qwen2.5-coder-32b"],
            model_details: Some(vec![
                me("qwen2.5-coder-7b", "low", "~5 GB", Some(true), Some("light"),
                    Some("hf download Qwen/Qwen2.5-Coder-7B-Instruct-GGUF qwen2.5-coder-7b-instruct-q4_k_m.gguf --local-dir ."),
                    Some("llama-server -m qwen2.5-coder-7b-instruct-q4_k_m.gguf --port 8080")),
                me("qwen2.5-coder-14b", "medium", "~10 GB", Some(true), Some("balanced"),
                    Some("hf download Qwen/Qwen2.5-Coder-14B-Instruct-GGUF qwen2.5-coder-14b-instruct-q4_k_m.gguf --local-dir ."),
                    Some("llama-server -m qwen2.5-coder-14b-instruct-q4_k_m.gguf --port 8080")),
                me("qwen2.5-coder-32b", "high", "~22 GB", Some(true), Some("quality"),
                    Some("hf download Qwen/Qwen2.5-Coder-32B-Instruct-GGUF qwen2.5-coder-32b-instruct-q4_k_m.gguf --local-dir ."),
                    Some("llama-server -m qwen2.5-coder-32b-instruct-q4_k_m.gguf --port 8080")),
            ]),
        },
        // ── Cloud ──
        // No model ids or prices here: free and paid lineups change every few
        // weeks, and a stale default would fail or quietly bill the user. The
        // user types the model id from the provider's own list (the setup
        // page links to it).
        cloud("open_router", "OpenRouter", "cloud-free", "https://openrouter.ai/api/v1"),
        cloud("opencode", "OpenCode", "cloud-free", "https://opencode.ai/zen/v1"),
        cloud("nvidia_nim", "NVIDIA NIM", "cloud-free", "https://integrate.api.nvidia.com/v1"),
        cloud("zai", "Z.ai", "cloud-free", "https://api.z.ai/api/coding/paas/v4"),
        cloud("kimi", "Kimi (Moonshot)", "cloud-free", "https://api.moonshot.cn/v1"),
        cloud("deepseek", "DeepSeek", "cloud-paid", "https://api.deepseek.com/v1"),
        cloud("fireworks", "Fireworks", "cloud-paid", "https://api.fireworks.ai/inference/v1"),
        cloud("wafer", "Wafer", "cloud-paid", "https://pass.wafer.ai/v1"),
    ]
}

#[cfg(test)]
mod promptops_cli_config_tests {
    use super::*;

    #[test]
    fn catalog_quotes_no_prices_and_names_no_cloud_model() {
        let en: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../web/src/assets/i18n/en.json"),
            )
            .unwrap(),
        )
        .unwrap();
        for p in fcc_catalog() {
            if p.tier != "local" {
                // Lineups change too often: the user picks the model.
                assert_eq!(p.default_model, "", "{}", p.id);
                assert!(p.models.is_empty() && p.model_details.is_none(), "{}", p.id);
                continue;
            }
            assert!(p.models.contains(&p.default_model), "{}", p.id);
            for m in p.model_details.as_deref().unwrap_or_default() {
                assert!(!m.ram.contains('$') && !m.ram.contains("/1M"), "{}", m.id);
                // Labels are translation ids, shown as FCC_SETUP.MODEL_LABEL.<id>.
                if let Some(label) = m.label {
                    assert!(
                        en["FCC_SETUP"]["MODEL_LABEL"][label].is_string(),
                        "missing FCC_SETUP.MODEL_LABEL.{label}"
                    );
                }
                // Only real commands are shown with a copy button.
                for cmd in [m.install_cmd, m.run_cmd].into_iter().flatten() {
                    assert!(
                        cmd.starts_with("ollama ")
                            || cmd.starts_with("hf download ")
                            || cmd.starts_with("llama-server "),
                        "{cmd}"
                    );
                }
            }
        }
    }
    #[test]
    fn promptops_cli_test_endpoint_matches_runtime() {
        for host in [
            "localhost:1234",
            "127.0.0.1:1234",
            "[::1]:1234",
            "192.168.1.9:8080",
        ] {
            assert_eq!(
                normalize_fcc_base_url(&format!("http://{host}/")).unwrap(),
                format!("http://{host}/v1")
            );
        }
        assert_eq!(
            normalize_fcc_base_url("https://example.test/api/v4/chat/completions/").unwrap(),
            "https://example.test/api/v4"
        );
        for url in [
            "file:///secret",
            "https://user:pass@example.test",
            "http://example.test?key=secret",
        ] {
            assert!(normalize_fcc_base_url(url).is_err());
        }
    }
}

#[cfg(all(test, unix))]
mod local_skills_tests {
    use super::*;

    // Creating symlinks on Windows needs Developer Mode or admin rights.
    #[cfg(unix)]
    #[test]
    fn scans_agents_dir_following_symlinks_and_dedupes() {
        let base = std::env::temp_dir().join(format!("po-agents-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let skills = base.join(".agents").join("skills");
        let real = base.join("elsewhere").join("My Skill");
        fs::create_dir_all(&real).unwrap();
        fs::write(
            real.join("SKILL.md"),
            "---\nname: my-skill\ndescription: \"Does things\"\n---\nbody",
        )
        .unwrap();
        fs::create_dir_all(&skills).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, skills.join("My Skill")).unwrap();
        fs::create_dir_all(skills.join("no-md")).unwrap();

        let found = scan_local_skills(&[skills.clone(), base.join(".agents")]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].slug, "my-skill");
        assert_eq!(found[0].name, "my-skill");
        assert_eq!(found[0].description, "Does things");
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod path_safety_tests {
    use super::*;

    fn ws(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("po-assets-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn uploads_stay_inside_the_assets_folder() {
        let root = ws("upload");
        let workspace = root.join("w");
        fs::create_dir_all(&workspace).unwrap();
        let w = workspace.to_string_lossy().to_string();
        let data = base64_encode(b"payload");
        for name in [
            "../../escaped.txt",
            "/tmp/abs-escaped.txt",
            "..\\..\\win-escaped.txt",
        ] {
            let a = upload_asset(&w, name, &data).unwrap();
            assert!(workspace.join(ASSETS_DIR).join(&a.name).is_file(), "{name}");
            assert!(!a.name.contains('/') && !a.name.contains('\\'));
        }
        assert!(!root.join("escaped.txt").exists());
        assert!(!workspace.join("escaped.txt").exists());
        for bad in ["..", ".", "", "a/.."] {
            assert!(upload_asset(&w, bad, &data).is_err(), "{bad:?}");
            assert!(delete_asset(&w, bad).is_err(), "{bad:?}");
            assert!(rename_asset(&w, bad, "x").is_err(), "{bad:?}");
            assert!(rename_asset(&w, "x", bad).is_err(), "{bad:?}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn reading_an_asset_never_blocks_or_floods() {
        let root = ws("read");
        let dir = root.join(ASSETS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("pipe");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        std::os::unix::fs::symlink("/dev/zero", dir.join("zero")).unwrap();
        let w = root.to_string_lossy().to_string();
        assert!(read_asset_text(&w, "pipe").is_err());
        assert!(read_asset_base64(&w, "zero").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recipe_targets_must_stay_in_the_workspace() {
        assert!(check_target_rel_path(".claude/skills/x/SKILL.md").is_ok());
        for bad in [
            "../x",
            "/etc/x",
            "a/../../x",
            "",
            "C:\\x",
            "..\\x",
            "./x/../..",
        ] {
            assert!(check_target_rel_path(bad).is_err(), "{bad:?}");
        }
        let root = ws("materialize");
        let w = root.join("w");
        fs::create_dir_all(&w).unwrap();
        let item = CatalogItem {
            item_id: "evil".into(),
            kind: "skill".into(),
            name: "evil".into(),
            description: None,
            sector: None,
            trust: None,
            requires_secrets: None,
            install: HashMap::from([(
                "claude-code-cli".to_string(),
                MaterializationRecipe {
                    strategy: "skill-folder".into(),
                    target_rel_path: "../outside.md".into(),
                    format: "markdown".into(),
                    merge_key: None,
                    launch_flag: None,
                    payload: Value::String("pwned".into()),
                },
            )]),
        };
        let res = materialize(
            &w.to_string_lossy(),
            "claude-code-cli",
            &ExtensionSelection {
                items: vec![item],
                secrets: HashMap::new(),
            },
        )
        .unwrap();
        assert!(res.written.is_empty());
        assert!(!root.join("outside.md").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_inert_remote_files_are_opened_directly() {
        for ok in ["report.pdf", "shot.PNG", "notes.md", "data.csv"] {
            assert!(is_safe_to_open(Path::new(ok)), "{ok}");
        }
        for bad in [
            "run.bat",
            "setup.exe",
            "x.js",
            "x.vbs",
            "link.lnk",
            "x.terminal",
            "x.command",
            "x.fileloc",
            "x.desktop",
            "x.app",
            "x.html",
            "x.sh",
            "noext",
            "x.pdf.exe",
        ] {
            assert!(!is_safe_to_open(Path::new(bad)), "{bad}");
        }
    }
}

#[cfg(all(test, unix))]
mod remote_bridge_remove_tests {
    use super::REMOTE_BRIDGE_REMOVE_SCRIPT;

    /// Against a fake host home: the registration goes through
    /// `claude mcp remove -s user promptops-remote` and the script disappears.
    #[test]
    fn remove_script_undoes_the_setup() {
        use std::os::unix::fs::PermissionsExt;
        let home = crate::commands::util_cmd::PrivateTempDir::new("po-bridge-home").unwrap();
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let log = home.path().join("claude.log");
        let fake = bin.join("claude");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\necho \"$*\" >> '{}'\nexit 0\n", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tool = home.path().join(".promptops/bin/promptops_remote_mcp.py");
        std::fs::create_dir_all(tool.parent().unwrap()).unwrap();
        std::fs::write(&tool, "x").unwrap();
        let out = std::process::Command::new("sh")
            .args(["-c", REMOTE_BRIDGE_REMOVE_SCRIPT])
            .env("HOME", home.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("__PO_BRIDGE_REMOVED__"));
        assert!(!tool.exists() && !home.path().join(".promptops").exists());
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(
            calls.contains("mcp remove -s user promptops-remote"),
            "{calls}"
        );
    }
}
