//! File system / code-editor IPC domain.
//!
//! Covers all `fs:*` channels (list-dir, list-dir-shallow, read-file,
//! write-file, search-files, search-paths, search-content, delete, rename,
//! new-file, new-folder, duplicate, watch-start, watch-stop). The push event
//! `fs:watch-event` travels over a `tauri::ipc::Channel` (like the terminal's
//! `on_output`).
//!
//! Responses use a `{ ok, ... }` envelope: the renderer
//! checks `result.ok` and expects the same field names (camelCase via
//! `#[serde(rename_all = "camelCase")]`). "Application" errors (file too
//! large, binary, missing directory, …) remain `ok: false` values,
//! not `Err`. We use `Result<T, String>` only for symmetry with
//! `terminal.rs`; in practice the commands always return `Ok(envelope)`.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

// ─── Constants ───────────────────────────────────────────────────────────────

/// Directories always skipped during walk/list (`IGNORE_DIRS`).
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "__pycache__",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".vscode",
    ".idea",
    ".DS_Store",
    ".promptops-assets",
    "vendor",
    "venv",
    ".env",
    "env",
    ".venv",
];

const MAX_FILES: usize = 20_000;

/// File cap for the fuzzy search walk (CMD+P / @-mention). `MAX_FILES`
/// (20k) cut large workspaces in alphabetical order: entire branches were
/// NEVER suggested.
const MAX_SEARCH_WALK_FILES: usize = 200_000;
/// Time budget for the fuzzy walk: partial results are better than a window
/// that stays empty for seconds.
const FUZZY_WALK_TIME_BUDGET: Duration = Duration::from_secs(4);
/// Max matches per single file in content search: a "noisy" file must not
/// consume the whole result budget on its own.
const MAX_MATCHES_PER_FILE: usize = 50;
const MAX_ENTRIES_PER_DIR: usize = 10_000;
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024; // 5 MB
const MAX_SEARCH_FILE_SIZE: u64 = 1024 * 1024; // 1 MB
const MAX_SEARCH_RESULTS_DEFAULT: usize = 100;
/// Content search walks the whole tree (no 20k listing cap) but stays bounded.
const MAX_SEARCH_FILES: usize = 200_000;
const SEARCH_TIME_BUDGET: Duration = Duration::from_secs(10);
const MAX_FUZZY_RESULTS: usize = 50;
const IGNORE_CACHE_TTL: Duration = Duration::from_secs(30);
/// Debounce to coalesce bursts of watch events (npm install, git checkout…).
const WATCH_FLUSH_MS: u64 = 200;

fn is_ignored_dir(name: &str) -> bool {
    IGNORE_DIRS.contains(&name)
}

// ─── DTO (types shared with the web UI) ──────────────────────────────────────

/// The renderer's `FileNode`. `children`/`gitIgnored` are omitted when absent
/// (optional properties).
#[derive(Clone, Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
    #[serde(rename = "gitIgnored", skip_serializing_if = "Option::is_none")]
    pub git_ignored: Option<bool>,
}

/// The renderer's `SearchResult`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub file_path: String,
    pub line: usize,
    pub content: String,
    pub column: usize,
    /// Match length in UTF-16 code units (Monaco columns).
    pub length: usize,
}

/// Options of `fs_search_content` (the renderer's `SearchContentOptions`).
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchContentOptions {
    pub max_results: Option<usize>,
    pub match_case: bool,
    pub whole_word: bool,
    pub use_regex: bool,
}

/// The renderer's `PathItem` (@-mention autocomplete). `type` is a reserved word in
/// Rust ⇒ renamed with serde.
#[derive(Clone, Serialize)]
pub struct PathItem {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String, // "file" | "dir"
}

/// Payload of the `fs:watch-event` event (`{ cwd, paths }`).
#[derive(Clone, Serialize)]
pub struct WatchEvent {
    pub cwd: String,
    pub paths: Vec<String>,
}

// ─── Response envelopes (`{ ok, ... }`) ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<Vec<FileNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirShallowResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<FileNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPathsResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<PathItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<SearchResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_scanned: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Generic `{ ok, error? }` response (delete, new-file, new-folder, rename,
/// watch-start, watch-stop).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OkResponse {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/// Equivalent of `path.resolve` for a single absolute/relative path:
/// normalizes `.`/`..` without touching the filesystem (no symlink
/// resolution, like `path.resolve`). Relative paths are anchored to the given
/// cwd; if empty, to the process cwd.
fn resolve_path(base: &Path, p: &str) -> PathBuf {
    let candidate = Path::new(p);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base.join(candidate)
    };
    normalize(&joined)
}

/// Resolves a single path (absolute or relative to the process cwd),
/// like `path.resolve(cwd)`.
fn resolve_single(p: &str) -> PathBuf {
    let candidate = Path::new(p);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(candidate)
    };
    normalize(&joined)
}

/// Purely lexical normalization of `.`/`..` (no I/O).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Lexical `path.relative(from, to)`, always with the `/` separator (also on
/// Windows): the renderer splits paths on `/` (file names, parent folders,
/// git status keys), and with `\` a rename on Windows moved the file to the
/// workspace root and git badges never matched.
fn relative(from: &Path, to: &Path) -> String {
    let from_comps: Vec<_> = from.components().collect();
    let to_comps: Vec<_> = to.components().collect();
    let mut i = 0;
    while i < from_comps.len() && i < to_comps.len() && from_comps[i] == to_comps[i] {
        i += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in i..from_comps.len() {
        parts.push("..".to_string());
    }
    for c in &to_comps[i..] {
        parts.push(c.as_os_str().to_string_lossy().to_string());
    }
    parts.join("/")
}

/// For anything that creates, modifies, moves or deletes: the REAL location
/// (symlinks resolved) must be inside the real workspace. The lexical check
/// alone let `link -> /Users/me` (a symlink committed in a cloned repo) turn
/// "save docs/x.md" into a write anywhere. `follow_final` = the operation goes
/// through the last component (write) instead of acting on the entry itself
/// (rename/delete of a symlink touches the link, not its target).
/// Reads keep following symlinks, as in every editor.
fn assert_real_within_cwd(cwd: &Path, target: &Path, follow_final: bool) -> Result<(), String> {
    const OUTSIDE: &str = "Path resolves outside the workspace (symlink)";
    let root = std::fs::canonicalize(cwd).map_err(|_| "Workspace folder not found".to_string())?;
    if follow_final {
        if let Ok(meta) = std::fs::symlink_metadata(target) {
            if meta.file_type().is_symlink() {
                let real = std::fs::canonicalize(target)
                    .map_err(|_| "Broken symlink: its target does not exist".to_string())?;
                if !real.starts_with(&root) {
                    return Err(OUTSIDE.to_string());
                }
            }
        }
    }
    // Deepest existing ancestor of the parent folder.
    let mut probe = target.parent().map(Path::to_path_buf);
    while let Some(dir) = probe {
        if let Ok(real) = std::fs::canonicalize(&dir) {
            if !real.starts_with(&root) {
                return Err(OUTSIDE.to_string());
            }
            return Ok(());
        }
        probe = dir.parent().map(Path::to_path_buf);
    }
    Ok(())
}

/// `exists()` without following symlinks: a dangling link counts as taken
/// (writing "a new file" through it would create its target, maybe outside).
fn entry_exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// Reads a regular file of at most `cap` bytes. A FIFO or a device (or a
/// committed symlink to `/dev/zero`) used to block the command thread or
/// fill the memory: `metadata().len()` is 0 for them.
fn read_regular_file_capped(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Not a regular file".to_string());
    }
    if meta.len() > cap {
        return Err("File too large".to_string());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > cap {
        return Err("File too large".to_string());
    }
    Ok(bytes)
}

/// Path-traversal protection: `resolved` must live inside `cwd`.
fn assert_within_cwd(cwd: &Path, resolved: &Path) -> Result<(), String> {
    let normal_cwd = normalize(cwd);
    let normal_resolved = normalize(resolved);
    if normal_resolved == normal_cwd {
        return Ok(());
    }
    if normal_resolved.starts_with(&normal_cwd) {
        return Ok(());
    }
    Err("Path traversal detected".to_string())
}

/// "Binary" heuristic: too many non-printable chars in the first sample.
/// Works on code points, which is accurate for the typical ASCII/Latin content of text files).
fn is_binary(content: &str) -> bool {
    let sample_size = content.chars().count().min(8000);
    if sample_size == 0 {
        return false;
    }
    let mut non_printable = 0usize;
    for ch in content.chars().take(sample_size) {
        let code = ch as u32;
        if code == 9 || code == 10 || code == 13 {
            continue;
        }
        if code < 32 || code == 127 {
            non_printable += 1;
        }
    }
    (non_printable as f64) / (sample_size as f64) > 0.1
}

/// Natural, case-insensitive comparison (file2 < file10), like the `Intl.Collator`
/// with `{ numeric: true, sensitivity: 'base' }`.
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    natural_cmp(&a.to_lowercase(), &b.to_lowercase())
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    // Compare whole numeric blocks.
                    let mut na = String::new();
                    while let Some(c) = ai.peek().copied() {
                        if c.is_ascii_digit() {
                            na.push(c);
                            ai.next();
                        } else {
                            break;
                        }
                    }
                    let mut nb = String::new();
                    while let Some(c) = bi.peek().copied() {
                        if c.is_ascii_digit() {
                            nb.push(c);
                            bi.next();
                        } else {
                            break;
                        }
                    }
                    let ta = na.trim_start_matches('0');
                    let tb = nb.trim_start_matches('0');
                    let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    // on equal value, keep stability on raw length
                    let ord2 = na.len().cmp(&nb.len());
                    if ord2 != Ordering::Equal {
                        return ord2;
                    }
                } else {
                    let ord = ca.cmp(&cb);
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

// ─── Gitignore: `git status --ignored --porcelain` + TTL cache ────────────────

struct IgnoreCacheEntry {
    set: HashSet<String>,
    ts: Instant,
}

/// Global cache of gitignored paths per cwd. Static parking_lot::Mutex.
static IGNORE_CACHE: Mutex<Option<HashMap<String, IgnoreCacheEntry>>> = Mutex::new(None);

fn ignore_cache_get(cwd: &str) -> Option<HashSet<String>> {
    let guard = IGNORE_CACHE.lock();
    let map = guard.as_ref()?;
    let entry = map.get(cwd)?;
    if entry.ts.elapsed() < IGNORE_CACHE_TTL {
        Some(entry.set.clone())
    } else {
        None
    }
}

fn ignore_cache_put(cwd: &str, set: HashSet<String>) {
    let mut guard = IGNORE_CACHE.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(
        cwd.to_string(),
        IgnoreCacheEntry {
            set,
            ts: Instant::now(),
        },
    );
}

fn ignore_cache_delete(cwd: &str) {
    let mut guard = IGNORE_CACHE.lock();
    if let Some(map) = guard.as_mut() {
        map.remove(cwd);
    }
}

/// One lock per cwd: parallel lists (tree re-expansion) with an empty cache must
/// wait for a single `git status`, not run one each.
static IGNORE_COMPUTE: Mutex<Option<HashMap<String, Arc<Mutex<()>>>>> = Mutex::new(None);

fn get_git_ignored_paths_cached(cwd: &str) -> HashSet<String> {
    if let Some(set) = ignore_cache_get(cwd) {
        return set;
    }
    let lock = IGNORE_COMPUTE
        .lock()
        .get_or_insert_with(HashMap::new)
        .entry(cwd.to_string())
        .or_default()
        .clone();
    let _computing = lock.lock();
    if let Some(set) = ignore_cache_get(cwd) {
        return set;
    }
    let set = get_git_ignored_paths(cwd);
    ignore_cache_put(cwd, set.clone());
    set
}

/// Path of the cwd relative to the repo root (`""` if cwd IS the root or we are
/// not in a repo). Used to rebase the porcelain output, which is ALWAYS
/// relative to the repo root even when git runs in a subfolder.
fn git_show_prefix(cwd: &str) -> String {
    let out = crate::commands::util_cmd::cmd("git")
        .arg("rev-parse")
        .arg("--show-prefix")
        .current_dir(cwd)
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// `git status --ignored=matching --porcelain` → collects entries with the "!! "
/// prefix, rebased onto the cwd (entries outside the cwd are discarded).
/// `matching` stops at folders matching a pattern: the default walks through
/// them all (node_modules, target), which costs seconds on large repos.
fn get_git_ignored_paths(cwd: &str) -> HashSet<String> {
    let out = crate::commands::util_cmd::cmd("git")
        .arg("--no-optional-locks")
        .arg("status")
        .arg("--ignored=matching")
        .arg("--porcelain")
        .current_dir(cwd)
        .output();
    let mut set = HashSet::new();
    let raw = match out {
        Ok(o) if o.status.success() || !o.stdout.is_empty() => {
            String::from_utf8_lossy(&o.stdout).into_owned()
        }
        _ => return set,
    };
    let prefix = git_show_prefix(cwd);
    for line in raw.split('\n') {
        if !line.starts_with("!! ") {
            continue;
        }
        let p = line[3..].trim().trim_matches('"').trim_end_matches('/');
        if p.is_empty() {
            continue;
        }
        // porcelain always uses '/', even on Windows, like `relative()`.
        let rel = if prefix.is_empty() {
            p
        } else if let Some(r) = p.strip_prefix(prefix.as_str()) {
            r
        } else {
            continue; // ignored but outside the cwd open in the editor
        };
        if rel.is_empty() {
            continue;
        }
        set.insert(rel.to_string());
    }
    set
}

/// Is a relative path (or one of its ancestors) in the ignored set?
fn is_path_ignored(rel_path: &str, ignored: &HashSet<String>) -> bool {
    if ignored.contains(rel_path) {
        return true;
    }
    rel_path
        .match_indices('/')
        .any(|(i, _)| ignored.contains(&rel_path[..i]))
}

// ─── Recursive walk (tree, files, paths) ──────────────────────────────────────

struct Counter {
    count: usize,
}

/// Recursively builds the tree, honoring the ignore list and the file cap.
fn build_tree(
    dir_path: &Path,
    relative_to: &Path,
    counter: &mut Counter,
    ignored: Option<&HashSet<String>>,
    parent_ignored: bool,
    depth: usize,
) -> Vec<FileNode> {
    // The root is never truncated.
    if depth > 0 && counter.count >= MAX_FILES {
        return Vec::new();
    }

    let entries = match std::fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut folders: Vec<FileNode> = Vec::new();
    let mut files: Vec<FileNode> = Vec::new();

    for entry in entries.flatten() {
        if depth > 0 && counter.count >= MAX_FILES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_dir(&name) {
            continue;
        }

        let full_path = dir_path.join(&name);
        let rel_path = relative(relative_to, &full_path);
        let is_ignored = parent_ignored
            || ignored
                .map(|set| is_path_ignored(&rel_path, set))
                .unwrap_or(false);

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            let children = build_tree(
                &full_path,
                relative_to,
                counter,
                ignored,
                is_ignored,
                depth + 1,
            );
            folders.push(FileNode {
                name,
                path: rel_path,
                is_dir: true,
                children: Some(children),
                git_ignored: if is_ignored { Some(true) } else { None },
            });
        } else {
            counter.count += 1;
            files.push(FileNode {
                name,
                path: rel_path,
                is_dir: false,
                children: None,
                git_ignored: if is_ignored { Some(true) } else { None },
            });
        }
    }

    folders.sort_by(|a, b| compare_names(&a.name, &b.name));
    files.sort_by(|a, b| compare_names(&a.name, &b.name));

    folders.extend(files);
    folders
}

/// Collects relative paths of files only.
/// Like `walk_files` but skips gitignored paths and honors a deadline: with
/// 20k files and no filter, large workspaces were truncated in alphabetical
/// order and half the tree never showed up in CMD+P.
fn walk_files_filtered(
    dir_path: &Path,
    relative_to: &Path,
    out: &mut Vec<String>,
    max: usize,
    ignored: &HashSet<String>,
    deadline: Option<Instant>,
) {
    if out.len() >= max || deadline.map(|d| Instant::now() >= d).unwrap_or(false) {
        return;
    }
    let entries = match std::fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= max {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_dir(&name) {
            continue;
        }
        let full_path = dir_path.join(&name);
        let rel_path = relative(relative_to, &full_path);
        if !ignored.is_empty() && is_path_ignored(&rel_path, ignored) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            walk_files_filtered(&full_path, relative_to, out, max, ignored, deadline);
            if deadline.map(|d| Instant::now() >= d).unwrap_or(false) {
                return;
            }
        } else {
            out.push(rel_path);
        }
    }
}

/// Filtered variant of `walk_paths` (see `walk_files_filtered`).
fn walk_paths_filtered(
    dir_path: &Path,
    relative_to: &Path,
    out: &mut Vec<PathItem>,
    max: usize,
    ignored: &HashSet<String>,
    deadline: Option<Instant>,
) {
    if out.len() >= max || deadline.map(|d| Instant::now() >= d).unwrap_or(false) {
        return;
    }
    let entries = match std::fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= max {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_dir(&name) {
            continue;
        }
        let full_path = dir_path.join(&name);
        let rel_path = relative(relative_to, &full_path);
        if !ignored.is_empty() && is_path_ignored(&rel_path, ignored) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            out.push(PathItem {
                path: rel_path,
                kind: "dir".to_string(),
            });
            walk_paths_filtered(&full_path, relative_to, out, max, ignored, deadline);
            if deadline.map(|d| Instant::now() >= d).unwrap_or(false) {
                return;
            }
        } else {
            out.push(PathItem {
                path: rel_path,
                kind: "file".to_string(),
            });
        }
    }
}

/// Fuzzy match: all chars of `query` appear in order in `target`
/// (case-insensitive).
fn fuzzy_match(query: &str, target: &str) -> bool {
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = target.to_lowercase().chars().collect();
    let mut qi = 0usize;
    let mut ti = 0usize;
    while ti < t.len() && qi < q.len() {
        if t[ti] == q[qi] {
            qi += 1;
        }
        ti += 1;
    }
    qi == q.len()
}

/// Normalizes the quick-open query. Users often paste whole paths:
/// absolute, with `./`, with `file://`, with a `:line[:column]` suffix (stack
/// trace / "copy path with line") or with Windows separators. Without this
/// normalization the subsequence match always failed.
fn normalize_query_path(query: &str, cwd: &Path) -> String {
    let mut q = query
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if let Some(rest) = q.strip_prefix("file://") {
        q = rest.to_string();
    }
    q = q.replace('\\', "/");

    // :line[:column] suffix — digits only, and only if something remains before it
    while let Some(idx) = q.rfind(':') {
        let (head, tail) = q.split_at(idx);
        let digits = &tail[1..];
        if head.is_empty() || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        q = head.to_string();
    }

    let cwd_s = cwd.to_string_lossy().replace('\\', "/");
    let cwd_s = cwd_s.trim_end_matches('/');
    if !cwd_s.is_empty() {
        if let Some(rest) = q.strip_prefix(cwd_s) {
            q = rest.to_string();
        }
    }
    while let Some(rest) = q.strip_prefix("./") {
        q = rest.to_string();
    }
    q.trim_start_matches('/').trim_end_matches('/').to_string()
}

/// Relevance score for quick-open: lower = better match.
/// `None` = no match. The fuzzy subsequence remains, but as a last resort,
/// so a fully pasted path does not end up below 40 false positives.
fn match_score(query_lower: &str, path: &str) -> Option<u8> {
    if query_lower.is_empty() {
        return Some(7);
    }
    let p = path.replace('\\', "/").to_lowercase();
    let name = basename(path).to_lowercase();
    if p == query_lower {
        return Some(0);
    }
    // separator-aligned suffix: "webapp/src/main.ts" matches the full path
    if p.ends_with(query_lower) && p.as_bytes().get(p.len() - query_lower.len() - 1) == Some(&b'/')
    {
        return Some(1);
    }
    if name == query_lower {
        return Some(2);
    }
    if name.starts_with(query_lower) {
        return Some(3);
    }
    if p.contains(query_lower) {
        return Some(4);
    }
    if name.contains(query_lower) {
        return Some(5);
    }
    if fuzzy_match(query_lower, &p) {
        return Some(6);
    }
    None
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

// ─── Watch state ──────────────────────────────────────────────────────────────

struct ActiveWatcher {
    /// Live `notify` watcher; Drop stops its notification thread.
    _watcher: Box<dyn notify::Watcher + Send>,
    cwd: String,
}

/// Manager of active watchers, keyed by id (string): the workspace id (resolved
/// cwd), so each cwd has at most one watcher (idempotent).
#[derive(Default)]
pub struct WatchManager {
    watchers: Mutex<HashMap<String, ActiveWatcher>>,
}

impl WatchManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Quick check: discards events touching an ignored dir in any
/// segment.
pub(crate) fn should_ignore_watch_path(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    rel.split(['/', '\\']).any(is_ignored_dir)
}

fn stop_watcher(manager: &WatchManager, key: &str) {
    let mut guard = manager.watchers.lock();
    if let Some(active) = guard.remove(key) {
        // Invalidate the cwd's gitignore cache on stop, consistent with the flush.
        ignore_cache_delete(&active.cwd);
        // Dropping `_watcher` stops the notify backend thread.
    }
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Markers identifying a folder as a project (repo or manifest).
const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "composer.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "mix.exs",
    "pubspec.yaml",
    "Package.swift",
    "deno.json",
    "CMakeLists.txt",
    "Makefile",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedProject {
    pub name: String,
    pub path: String,
    /// "git" if it contains `.git`, otherwise the first manifest found.
    pub marker: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProjectsResponse {
    pub ok: bool,
    pub root: String,
    pub root_name: String,
    /// Marker of the root folder (Some if it already is a project itself).
    pub root_marker: Option<String>,
    pub projects: Vec<ScannedProject>,
    pub error: Option<String>,
}

fn project_marker(dir: &Path) -> Option<String> {
    PROJECT_MARKERS
        .iter()
        .find(|m| dir.join(m).exists())
        .map(|m| {
            if *m == ".git" {
                "git".to_string()
            } else {
                (*m).to_string()
            }
        })
}

/// fs:scan-projects — immediate children of `path` that are projects (git repo
/// or manifest). Used by the "folder of projects" import → folder + workspace.
#[tauri::command]
pub fn fs_scan_projects(path: String) -> Result<ScanProjectsResponse, String> {
    let root = resolve_single(&path);
    let root_str = root.to_string_lossy().into_owned();
    let root_name = basename(&root_str);
    let fail = |e: String| ScanProjectsResponse {
        ok: false,
        root: root_str.clone(),
        root_name: root_name.clone(),
        root_marker: None,
        projects: vec![],
        error: Some(e),
    };
    if !root.is_dir() {
        return Ok(fail("Not a directory".to_string()));
    }
    let read = match std::fs::read_dir(&root) {
        Ok(r) => r,
        Err(e) => return Ok(fail(e.to_string())),
    };
    let mut projects: Vec<ScannedProject> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || is_ignored_dir(&name) {
                return None;
            }
            let p = e.path();
            project_marker(&p).map(|marker| ScannedProject {
                name,
                path: p.to_string_lossy().into_owned(),
                marker,
            })
        })
        .collect();
    projects.sort_by_key(|p| p.name.to_lowercase());
    Ok(ScanProjectsResponse {
        ok: true,
        root_marker: project_marker(&root),
        root: root_str.clone(),
        root_name: root_name.clone(),
        projects,
        error: None,
    })
}

/// fs:list-dir — recursive tree listing (legacy).
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_list_dir(cwd: String) -> Result<ListDirResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let ignored = get_git_ignored_paths(&resolved_cwd.to_string_lossy());
    let mut counter = Counter { count: 0 };
    let tree = build_tree(
        &resolved_cwd,
        &resolved_cwd,
        &mut counter,
        Some(&ignored),
        false,
        0,
    );
    Ok(ListDirResponse {
        ok: true,
        tree: Some(tree),
        error: None,
    })
}

/// fs:list-dir-shallow — immediate children (1 level).
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_list_dir_shallow(
    cwd: String,
    rel_path: Option<String>,
) -> Result<ListDirShallowResponse, String> {
    let resolved_cwd = resolve_single(&cwd);

    // Normalize relPath (accepts '', '.', '/').
    let cleaned_rel = rel_path
        .unwrap_or_default()
        .trim_start_matches(['/', '\\'])
        .trim()
        .to_string();
    let target = if cleaned_rel.is_empty() || cleaned_rel == "." {
        resolved_cwd.clone()
    } else {
        resolve_path(&resolved_cwd, &cleaned_rel)
    };

    if let Err(e) = assert_within_cwd(&resolved_cwd, &target) {
        return Ok(ListDirShallowResponse {
            ok: false,
            entries: None,
            error: Some(e),
        });
    }

    let stat = match std::fs::metadata(&target) {
        Ok(s) => s,
        Err(_) => {
            return Ok(ListDirShallowResponse {
                ok: false,
                entries: None,
                error: Some("Directory not found".to_string()),
            })
        }
    };
    if !stat.is_dir() {
        return Ok(ListDirShallowResponse {
            ok: false,
            entries: None,
            error: Some("Not a directory".to_string()),
        });
    }

    let read = match std::fs::read_dir(&target) {
        Ok(r) => r,
        Err(e) => {
            return Ok(ListDirShallowResponse {
                ok: false,
                entries: None,
                error: Some(e.to_string()),
            })
        }
    };

    let ignored = get_git_ignored_paths_cached(&resolved_cwd.to_string_lossy());
    let mut folders: Vec<FileNode> = Vec::new();
    let mut files: Vec<FileNode> = Vec::new();

    for entry in read.flatten() {
        if folders.len() + files.len() >= MAX_ENTRIES_PER_DIR {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_dir(&name) {
            continue;
        }

        let child_abs = target.join(&name);
        let child_rel = relative(&resolved_cwd, &child_abs);
        let is_ignored = is_path_ignored(&child_rel, &ignored);

        // Symlinks: stat the target (broken link ⇒ file). `metadata`
        // follows the link; on error we classify it as a file.
        let file_type = entry.file_type();
        let is_dir = match &file_type {
            Ok(ft) if ft.is_symlink() => std::fs::metadata(&child_abs)
                .map(|m| m.is_dir())
                .unwrap_or(false),
            Ok(ft) => ft.is_dir(),
            Err(_) => false,
        };

        let node = FileNode {
            name,
            path: child_rel,
            is_dir,
            children: None,
            git_ignored: if is_ignored { Some(true) } else { None },
        };
        if is_dir {
            folders.push(node);
        } else {
            files.push(node);
        }
    }

    folders.sort_by(|a, b| compare_names(&a.name, &b.name));
    files.sort_by(|a, b| compare_names(&a.name, &b.name));
    folders.extend(files);

    Ok(ListDirShallowResponse {
        ok: true,
        entries: Some(folders),
        error: None,
    })
}

/// Cap for base64 media previews (MAX_MEDIA_FILE_SIZE, 20MB).
const MAX_MEDIA_FILE_SIZE: u64 = 20 * 1024 * 1024;

/// fs:read-file-base64 — file bytes as base64 + mime (image previews
/// in the editor).
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_read_file_base64(cwd: String, file_path: String) -> serde_json::Value {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &file_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved) {
        return serde_json::json!({ "ok": false, "error": e });
    }
    let bytes = match read_regular_file_capped(&resolved, MAX_MEDIA_FILE_SIZE) {
        Ok(b) => b,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    serde_json::json!({
        "ok": true,
        "data": crate::commands::assets_ext::base64_encode(&bytes),
        "mimeType": crate::commands::assets_ext::get_mime_type(&ext),
        "size": bytes.len(),
    })
}

/// fs:read-file — reads the content as utf-8.
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_read_file(cwd: String, file_path: String) -> Result<ReadFileResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &file_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved) {
        return Ok(ReadFileResponse {
            ok: false,
            content: None,
            encoding: None,
            error: Some(e),
        });
    }

    let bytes = match read_regular_file_capped(&resolved, MAX_FILE_SIZE) {
        Ok(b) => b,
        Err(e) => {
            return Ok(ReadFileResponse {
                ok: false,
                content: None,
                encoding: None,
                error: Some(e),
            })
        }
    };
    // `readFileSync(..., 'utf-8')` replaces invalid bytes; we use lossy.
    let content = String::from_utf8_lossy(&bytes).into_owned();
    if is_binary(&content) {
        return Ok(ReadFileResponse {
            ok: false,
            content: None,
            encoding: None,
            error: Some("Binary file".to_string()),
        });
    }

    Ok(ReadFileResponse {
        ok: true,
        content: Some(content),
        encoding: Some("utf-8".to_string()),
        error: None,
    })
}

/// fs:write-file — writes utf-8, creating parent dirs.
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_write_file(
    cwd: String,
    file_path: String,
    content: String,
) -> Result<WriteFileResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &file_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved)
        .and_then(|_| assert_real_within_cwd(&resolved_cwd, &resolved, true))
    {
        return Ok(WriteFileResponse {
            ok: false,
            error: Some(e),
        });
    }
    if resolved == normalize(&resolved_cwd) || resolved.is_dir() {
        return Ok(WriteFileResponse {
            ok: false,
            error: Some("Not a file".to_string()),
        });
    }

    if let Some(parent) = resolved.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(WriteFileResponse {
                ok: false,
                error: Some(e.to_string()),
            });
        }
    }
    match std::fs::write(&resolved, content.as_bytes()) {
        Ok(_) => Ok(WriteFileResponse {
            ok: true,
            error: None,
        }),
        Err(e) => Ok(WriteFileResponse {
            ok: false,
            error: Some(e.to_string()),
        }),
    }
}

/// fs:search-files — fuzzy by file name (CMD+P).
/// spawn_blocking: the workspace walk must not run on the main thread.
#[tauri::command]
pub async fn fs_search_files(cwd: String, query: String) -> Result<SearchFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || fs_search_files_impl(cwd, query))
        .await
        .map_err(|e| e.to_string())?
}

fn fs_search_files_impl(cwd: String, query: String) -> Result<SearchFilesResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let ignored = get_git_ignored_paths_cached(&resolved_cwd.to_string_lossy());
    let deadline = Some(Instant::now() + FUZZY_WALK_TIME_BUDGET);
    let mut all_files: Vec<String> = Vec::new();
    walk_files_filtered(
        &resolved_cwd,
        &resolved_cwd,
        &mut all_files,
        MAX_SEARCH_WALK_FILES,
        &ignored,
        deadline,
    );

    let q = normalize_query_path(&query, &resolved_cwd);
    if q.is_empty() {
        // No query — first 50 sorted by path length.
        all_files.sort_by_key(|f| f.len());
        all_files.truncate(MAX_FUZZY_RESULTS);
        return Ok(SearchFilesResponse {
            ok: true,
            files: Some(all_files),
            error: None,
        });
    }

    let q_lower = q.to_lowercase();
    let mut scored: Vec<(u8, usize, String)> = all_files
        .into_iter()
        .filter_map(|f| match_score(&q_lower, &f).map(|sc| (sc, f.len(), f)))
        .collect();
    scored.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    scored.truncate(MAX_FUZZY_RESULTS);

    let matches: Vec<String> = scored.into_iter().map(|(_, _, f)| f).collect();
    Ok(SearchFilesResponse {
        ok: true,
        files: Some(matches),
        error: None,
    })
}

/// fs:search-paths — fuzzy files AND folders (@-mention).
/// spawn_blocking: the workspace walk must not run on the main thread.
#[tauri::command]
pub async fn fs_search_paths(
    cwd: String,
    query: String,
    include_dirs: Option<bool>,
    include_files: Option<bool>,
    max_results: Option<usize>,
) -> Result<SearchPathsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_search_paths_impl(cwd, query, include_dirs, include_files, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn fs_search_paths_impl(
    cwd: String,
    query: String,
    include_dirs: Option<bool>,
    include_files: Option<bool>,
    max_results: Option<usize>,
) -> Result<SearchPathsResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let include_dirs = include_dirs.unwrap_or(true);
    let include_files = include_files.unwrap_or(true);
    let limit = max_results
        .unwrap_or(MAX_FUZZY_RESULTS)
        .min(MAX_FUZZY_RESULTS);

    let ignored = get_git_ignored_paths_cached(&resolved_cwd.to_string_lossy());
    let deadline = Some(Instant::now() + FUZZY_WALK_TIME_BUDGET);
    let mut all: Vec<PathItem> = Vec::new();
    walk_paths_filtered(
        &resolved_cwd,
        &resolved_cwd,
        &mut all,
        MAX_SEARCH_WALK_FILES,
        &ignored,
        deadline,
    );

    let filtered: Vec<PathItem> = all
        .into_iter()
        .filter(|it| {
            if it.kind == "dir" && !include_dirs {
                return false;
            }
            if it.kind == "file" && !include_files {
                return false;
            }
            true
        })
        .collect();

    let trimmed = normalize_query_path(&query, &resolved_cwd);
    if trimmed.is_empty() {
        let mut sorted = filtered;
        sorted.sort_by_key(|a| a.path.len());
        sorted.truncate(limit);
        return Ok(SearchPathsResponse {
            ok: true,
            items: Some(sorted),
            error: None,
        });
    }

    let q_lower = trimmed.to_lowercase();
    let mut scores: HashMap<String, u8> = HashMap::new();
    let mut matches: Vec<PathItem> = filtered
        .into_iter()
        .filter(|it| match match_score(&q_lower, &it.path) {
            Some(sc) => {
                scores.insert(it.path.clone(), sc);
                true
            }
            None => false,
        })
        .collect();

    matches.sort_by(|a, b| {
        let a_exact = scores.get(&a.path).copied().unwrap_or(u8::MAX);
        let b_exact = scores.get(&b.path).copied().unwrap_or(u8::MAX);
        a_exact
            .cmp(&b_exact)
            .then_with(|| {
                if a.kind != b.kind {
                    // dir preferred on equal score
                    if a.kind == "dir" {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    }
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| a.path.len().cmp(&b.path.len()))
    });

    matches.truncate(limit);
    Ok(SearchPathsResponse {
        ok: true,
        items: Some(matches),
        error: None,
    })
}

/// fs:search-content — searches content (CMD+SHIFT+F).
/// `options` (matchCase/wholeWord/useRegex) applied on the Rust side: the renderer
/// gets exact hits (all matches per line, with column+length).
/// spawn_blocking: walk + read of every file — the heaviest of the three searches.
#[tauri::command]
pub async fn fs_search_content(
    cwd: String,
    query: String,
    max_results: Option<usize>,
    options: Option<SearchContentOptions>,
) -> Result<SearchContentResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_search_content_impl(cwd, query, max_results, options.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Builds the content search regex.
fn build_content_search_regex(query: &str, opts: &SearchContentOptions) -> Option<regex::Regex> {
    if query.is_empty() {
        return None;
    }
    let mut pattern = if opts.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if opts.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!opts.match_case)
        .size_limit(10 * (1 << 20))
        .build()
        .ok()
}

struct SearchCtx<'a> {
    root: &'a Path,
    regex: regex::Regex,
    ignored: HashSet<String>,
    results: Vec<SearchResult>,
    limit: usize,
    started: Instant,
    files_scanned: usize,
    truncated: bool,
}

/// Alphabetical DFS (files before subfolders). Returns `false` when
/// it must stop (result / file / time limit reached).
fn search_dir(ctx: &mut SearchCtx<'_>, dir_path: &Path) -> bool {
    let entries = match std::fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(_) => return true,
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());

    let mut sub_dirs: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_dir(&name) {
            continue;
        }
        let full_path = dir_path.join(&name);
        let rel_path = relative(ctx.root, &full_path);
        if !ctx.ignored.is_empty() && is_path_ignored(&rel_path, &ctx.ignored) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            sub_dirs.push(full_path);
            continue;
        }

        if ctx.files_scanned >= MAX_SEARCH_FILES || ctx.started.elapsed() > SEARCH_TIME_BUDGET {
            ctx.truncated = true;
            return false;
        }
        ctx.files_scanned += 1;

        // Follows symlinks (like fs.statSync) but only into regular files of
        // bounded size: never a FIFO or a device.
        let bytes = match read_regular_file_capped(&full_path, MAX_SEARCH_FILE_SIZE) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let content = String::from_utf8_lossy(&bytes);
        if is_binary(&content) {
            continue;
        }
        // Pre-check on the whole file before splitting into lines.
        if !ctx.regex.is_match(&content) {
            continue;
        }

        let mut file_matches = 0usize;
        'lines: for (i, raw_line) in content.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            for m in ctx.regex.find_iter(line) {
                if m.start() == m.end() {
                    continue; // zero-width match (e.g. `a*`)
                }
                if file_matches >= MAX_MATCHES_PER_FILE {
                    // a minified file/lockfile must not eat the whole budget
                    ctx.truncated = true;
                    break 'lines;
                }
                file_matches += 1;
                let column = line[..m.start()].encode_utf16().count() + 1;
                let length = line[m.start()..m.end()].encode_utf16().count();
                ctx.results.push(SearchResult {
                    file_path: rel_path.clone(),
                    line: i + 1,
                    content: line.to_string(),
                    column,
                    length,
                });
                if ctx.results.len() >= ctx.limit {
                    ctx.truncated = true;
                    return false;
                }
            }
        }
    }

    for sub in sub_dirs {
        if !search_dir(ctx, &sub) {
            return false;
        }
    }
    true
}

fn fs_search_content_impl(
    cwd: String,
    query: String,
    max_results: Option<usize>,
    options: SearchContentOptions,
) -> Result<SearchContentResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let limit = options
        .max_results
        .or(max_results)
        .unwrap_or(MAX_SEARCH_RESULTS_DEFAULT)
        .max(1);
    let regex = match build_content_search_regex(&query, &options) {
        Some(r) => r,
        None => {
            return Ok(SearchContentResponse {
                ok: false,
                results: None,
                truncated: None,
                files_scanned: None,
                error: Some("Invalid search pattern".into()),
            })
        }
    };
    let ignored = get_git_ignored_paths_cached(&resolved_cwd.to_string_lossy());

    let mut ctx = SearchCtx {
        root: &resolved_cwd,
        regex,
        ignored,
        results: Vec::new(),
        limit,
        started: Instant::now(),
        files_scanned: 0,
        truncated: false,
    };
    search_dir(&mut ctx, &resolved_cwd);

    Ok(SearchContentResponse {
        ok: true,
        results: Some(ctx.results),
        truncated: Some(ctx.truncated),
        files_scanned: Some(ctx.files_scanned),
        error: None,
    })
}

/// fs:delete — moves to the trash (safe delete).
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_delete(cwd: String, file_path: String) -> Result<OkResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &file_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved)
        .and_then(|_| assert_real_within_cwd(&resolved_cwd, &resolved, false))
    {
        return Ok(OkResponse::err(e));
    }
    if resolved == normalize(&resolved_cwd) {
        return Ok(OkResponse::err(
            "The workspace folder itself cannot be deleted",
        ));
    }
    match move_to_trash(&resolved) {
        Ok(_) => Ok(OkResponse::ok()),
        Err(e) => Ok(OkResponse::err(e)),
    }
}

/// Moves to the system trash. On macOS the `trash` crate defaults to asking
/// Finder through AppleScript, which needs the Automation permission and fails
/// with "Finder is busy (-15260)" when it is not granted: "Move to Trash" in
/// the editor and "Discard" of untracked files in the git panel then did
/// nothing. NSFileManager needs no permission; Finder stays as a fallback.
fn move_to_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        if ctx.delete(path).is_ok() {
            return Ok(());
        }
    }
    trash::delete(path).map_err(|e| e.to_string())
}

/// fs:rename — renames/moves a file or folder.
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_rename(cwd: String, old_path: String, new_path: String) -> Result<OkResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved_old = resolve_path(&resolved_cwd, &old_path);
    let resolved_new = resolve_path(&resolved_cwd, &new_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved_old) {
        return Ok(OkResponse::err(e));
    }
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved_new) {
        return Ok(OkResponse::err(e));
    }
    if let Err(e) = assert_real_within_cwd(&resolved_cwd, &resolved_old, false)
        .and_then(|_| assert_real_within_cwd(&resolved_cwd, &resolved_new, false))
    {
        return Ok(OkResponse::err(e));
    }
    let root = normalize(&resolved_cwd);
    if resolved_old == root || resolved_new == root {
        return Ok(OkResponse::err(
            "The workspace folder itself cannot be renamed",
        ));
    }
    if entry_exists(&resolved_new) {
        return Ok(OkResponse::err("Destination already exists"));
    }
    if let Some(parent) = resolved_new.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(OkResponse::err(e.to_string()));
        }
    }
    match std::fs::rename(&resolved_old, &resolved_new) {
        Ok(_) => Ok(OkResponse::ok()),
        Err(e) => Ok(OkResponse::err(e.to_string())),
    }
}

/// fs:new-file — creates an empty file.
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_new_file(cwd: String, file_path: String) -> Result<OkResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &file_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved)
        .and_then(|_| assert_real_within_cwd(&resolved_cwd, &resolved, false))
    {
        return Ok(OkResponse::err(e));
    }
    if entry_exists(&resolved) {
        return Ok(OkResponse::err("File already exists"));
    }
    if let Some(parent) = resolved.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(OkResponse::err(e.to_string()));
        }
    }
    match std::fs::write(&resolved, b"") {
        Ok(_) => Ok(OkResponse::ok()),
        Err(e) => Ok(OkResponse::err(e.to_string())),
    }
}

/// fs:new-folder — creates a directory.
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_new_folder(cwd: String, folder_path: String) -> Result<OkResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &folder_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved)
        .and_then(|_| assert_real_within_cwd(&resolved_cwd, &resolved, false))
    {
        return Ok(OkResponse::err(e));
    }
    if entry_exists(&resolved) {
        return Ok(OkResponse::err("Folder already exists"));
    }
    match std::fs::create_dir_all(&resolved) {
        Ok(_) => Ok(OkResponse::ok()),
        Err(e) => Ok(OkResponse::err(e.to_string())),
    }
}

/// fs:duplicate — copies with a " copy" suffix.
// Off the main thread: a slow disk, a network mount or a big `git status`
// must not freeze the window.
#[tauri::command(async)]
pub fn fs_duplicate(cwd: String, file_path: String) -> Result<DuplicateResponse, String> {
    let resolved_cwd = resolve_single(&cwd);
    let resolved = resolve_path(&resolved_cwd, &file_path);
    if let Err(e) = assert_within_cwd(&resolved_cwd, &resolved)
        .and_then(|_| assert_real_within_cwd(&resolved_cwd, &resolved, false))
    {
        return Ok(DuplicateResponse {
            ok: false,
            new_path: None,
            error: Some(e),
        });
    }
    if !resolved.is_file() {
        return Ok(DuplicateResponse {
            ok: false,
            new_path: None,
            error: Some("Only files can be duplicated".to_string()),
        });
    }

    // ext/base like `path.extname`/`path.basename(p, ext)`.
    let file_name = resolved
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (base, ext) = split_ext(&file_name);
    let dir = resolved
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut copy_path = dir.join(format!("{base} copy{ext}"));
    let mut i = 2;
    while entry_exists(&copy_path) {
        copy_path = dir.join(format!("{base} copy {i}{ext}"));
        i += 1;
    }

    match std::fs::copy(&resolved, &copy_path) {
        Ok(_) => Ok(DuplicateResponse {
            ok: true,
            new_path: Some(relative(&resolved_cwd, &copy_path)),
            error: None,
        }),
        Err(e) => Ok(DuplicateResponse {
            ok: false,
            new_path: None,
            error: Some(e.to_string()),
        }),
    }
}

/// `path.extname` + `path.basename(p, ext)` → (base, ext including the dot).
/// Node: dotfiles like ".env" have extname "" and basename ".env".
fn split_ext(name: &str) -> (String, String) {
    // Find the last '.' that is not at position 0 (dotfile).
    match name.rfind('.') {
        Some(idx) if idx > 0 => {
            let ext = &name[idx..]; // includes the dot
            let base = &name[..idx];
            (base.to_string(), ext.to_string())
        }
        _ => (name.to_string(), String::new()),
    }
}

/// fs:watch-start — starts the recursive watch of the workspace.
///
/// The push event (`fs:watch-event`, payload `{ cwd, paths }`) travels over the
/// `Channel<WatchEvent>` passed by the renderer (analogous to the terminal's
/// `on_output`). Bursts are coalesced with a `WATCH_FLUSH_MS` debounce;
/// events on ignored dirs are discarded.
#[tauri::command(async)]
pub fn fs_watch_start(
    manager: tauri::State<'_, Arc<WatchManager>>,
    cwd: String,
    on_event: Channel<WatchEvent>,
) -> Result<OkResponse, String> {
    use notify::{RecursiveMode, Watcher};

    let resolved_cwd = resolve_single(&cwd);
    let stat = std::fs::metadata(&resolved_cwd).ok();
    if stat.as_ref().map(|s| s.is_dir()) != Some(true) {
        return Ok(OkResponse::err("Workspace path is not a directory"));
    }

    let cwd_str = resolved_cwd.to_string_lossy().into_owned();

    // Idempotent: stops any previous watcher on the same cwd.
    stop_watcher(&manager, &cwd_str);

    // State shared with the debounce thread.
    let pending: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let flush_scheduled: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));

    let cwd_for_cb = cwd_str.clone();
    let pending_cb = pending.clone();
    let flush_cb = flush_scheduled.clone();
    let channel = on_event.clone();
    let root_for_rel = resolved_cwd.clone();

    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            let mut added_any = false;
            for path in &event.paths {
                // notify gives absolute paths; the renderer expects the relative name.
                let rel = relative(&root_for_rel, path);
                if rel.is_empty() || should_ignore_watch_path(&rel) {
                    continue;
                }
                pending_cb.lock().insert(rel);
                added_any = true;
            }
            if !added_any {
                return;
            }
            // Schedule a flush if one is not already pending (debounce).
            {
                let mut scheduled = flush_cb.lock();
                if *scheduled {
                    return;
                }
                *scheduled = true;
            }
            let pending_flush = pending_cb.clone();
            let flush_flag = flush_cb.clone();
            let cwd_flush = cwd_for_cb.clone();
            let channel_flush = channel.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(WATCH_FLUSH_MS));
                *flush_flag.lock() = false;
                let paths: Vec<String> = {
                    let mut p = pending_flush.lock();
                    if p.is_empty() {
                        return;
                    }
                    let v = p.iter().cloned().collect();
                    p.clear();
                    v
                };
                // Drop the cache only when the rules change: with an agent at work
                // every flush would run git again. The TTL covers the rest.
                if paths.iter().any(|p| p.ends_with(".gitignore")) {
                    ignore_cache_delete(&cwd_flush);
                }
                let _ = channel_flush.send(WatchEvent {
                    cwd: cwd_flush.clone(),
                    paths,
                });
            });
        }) {
            Ok(w) => w,
            Err(e) => return Ok(OkResponse::err(e.to_string())),
        };

    if let Err(e) = watcher.watch(&resolved_cwd, RecursiveMode::Recursive) {
        return Ok(OkResponse::err(e.to_string()));
    }

    manager.watchers.lock().insert(
        cwd_str.clone(),
        ActiveWatcher {
            _watcher: Box::new(watcher),
            cwd: cwd_str,
        },
    );

    Ok(OkResponse::ok())
}

/// fs:watch-stop — stops the watcher (idempotent).
///
/// The `cwd` is needed to identify which watcher to stop.
#[tauri::command(async)]
pub fn fs_watch_stop(
    manager: tauri::State<'_, Arc<WatchManager>>,
    cwd: Option<String>,
) -> Result<OkResponse, String> {
    match cwd {
        Some(c) => {
            let resolved = resolve_single(&c).to_string_lossy().into_owned();
            stop_watcher(&manager, &resolved);
        }
        None => {
            // Without cwd, stop all (idempotent).
            let keys: Vec<String> = manager.watchers.lock().keys().cloned().collect();
            for k in keys {
                stop_watcher(&manager, &k);
            }
        }
    }
    Ok(OkResponse::ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizza_path_incollati() {
        let cwd = Path::new("/Users/me/proj");
        // pasted absolute path → relative to the cwd
        assert_eq!(
            normalize_query_path("/Users/me/proj/src/app/main.ts", cwd),
            "src/app/main.ts"
        );
        // line:column suffix from a stack trace
        assert_eq!(
            normalize_query_path("src/app/main.ts:42:7", cwd),
            "src/app/main.ts"
        );
        // ./ , quotes, file://, Windows separators
        assert_eq!(
            normalize_query_path("\"./src/app/main.ts\"", cwd),
            "src/app/main.ts"
        );
        assert_eq!(
            normalize_query_path("file:///Users/me/proj/src/x.ts", cwd),
            "src/x.ts"
        );
        assert_eq!(
            normalize_query_path("src\\app\\main.ts", cwd),
            "src/app/main.ts"
        );
        // normal query untouched
        assert_eq!(normalize_query_path("  main.ts  ", cwd), "main.ts");
    }

    #[test]
    fn score_preferisce_match_esatti_al_fuzzy() {
        let q = "src/app/main.ts";
        assert_eq!(match_score(q, "src/app/main.ts"), Some(0));
        assert_eq!(match_score(q, "packages/web/src/app/main.ts"), Some(1));
        // basename at the end of the path = separator-aligned suffix (tier 1)
        assert_eq!(match_score("main.ts", "a/b/main.ts"), Some(1));
        assert_eq!(match_score("main.ts", "main.ts"), Some(0));
        // fuzzy = last resort, must not beat the basename
        assert_eq!(match_score("main.ts", "s/rc/m/a/i/n/other.ts.x"), Some(6));
        assert_eq!(match_score("zzzz", "src/app/main.ts"), None);
    }

    struct TempWs(PathBuf);
    impl TempWs {
        fn new(tag: &str) -> Self {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!("po-fs-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn s(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempWs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn relative_paths_always_use_forward_slashes() {
        let base = Path::new("/w");
        assert_eq!(relative(base, Path::new("/w/a/b/c.txt")), "a/b/c.txt");
        let mut ignored = HashSet::new();
        ignored.insert("dist".to_string());
        ignored.insert("a/gen".to_string());
        assert!(is_path_ignored("dist/x.js", &ignored));
        assert!(is_path_ignored("a/gen/y/z.ts", &ignored));
        assert!(!is_path_ignored("a/general.ts", &ignored));
    }

    #[cfg(unix)]
    #[test]
    fn fifo_and_device_files_never_block_or_flood() {
        let ws = TempWs::new("fifo");
        let fifo = ws.0.join("pipe");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        std::os::unix::fs::symlink("/dev/zero", ws.0.join("zero.txt")).unwrap();
        std::fs::write(ws.0.join("real.txt"), "needle here\n").unwrap();
        let started = Instant::now();
        let r = fs_read_file(ws.s(), "pipe".into()).unwrap();
        assert!(!r.ok);
        let r = fs_read_file(ws.s(), "zero.txt".into()).unwrap();
        assert!(!r.ok);
        let b = fs_read_file_base64(ws.s(), "zero.txt".into());
        assert_eq!(b["ok"], false);
        let found =
            fs_search_content_impl(ws.s(), "needle".into(), None, Default::default()).unwrap();
        assert_eq!(found.results.unwrap().len(), 1);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn writes_never_leave_the_real_workspace() {
        let ws = TempWs::new("ws");
        let outside = TempWs::new("outside");
        std::fs::write(outside.0.join("victim.txt"), "original").unwrap();
        // A repo can commit symlinks pointing anywhere.
        std::os::unix::fs::symlink(&outside.0, ws.0.join("docs")).unwrap();
        std::os::unix::fs::symlink(outside.0.join("victim.txt"), ws.0.join("victim-link.txt"))
            .unwrap();
        std::os::unix::fs::symlink(outside.0.join("not-yet.txt"), ws.0.join("dangling.txt"))
            .unwrap();
        std::fs::create_dir_all(ws.0.join("inner")).unwrap();
        std::os::unix::fs::symlink(ws.0.join("inner"), ws.0.join("inner-link")).unwrap();

        let w = fs_write_file(ws.s(), "docs/new.md".into(), "x".into()).unwrap();
        assert!(!w.ok);
        assert!(!outside.0.join("new.md").exists());
        let w = fs_write_file(ws.s(), "victim-link.txt".into(), "pwned".into()).unwrap();
        assert!(!w.ok);
        assert_eq!(
            std::fs::read_to_string(outside.0.join("victim.txt")).unwrap(),
            "original"
        );
        let n = fs_new_file(ws.s(), "dangling.txt".into()).unwrap();
        assert!(!n.ok);
        assert!(!outside.0.join("not-yet.txt").exists());
        assert!(!fs_new_folder(ws.s(), "docs/sub".into()).unwrap().ok);
        assert!(
            !fs_rename(ws.s(), "inner".into(), "docs/moved".into())
                .unwrap()
                .ok
        );
        assert!(!fs_new_file(ws.s(), "docs/a.txt".into()).unwrap().ok);
        // A symlink that stays inside is fine, and so is renaming the link itself.
        assert!(
            fs_write_file(ws.s(), "inner-link/ok.txt".into(), "ok".into())
                .unwrap()
                .ok
        );
        assert!(ws.0.join("inner/ok.txt").exists());
        assert!(
            fs_rename(ws.s(), "victim-link.txt".into(), "renamed-link.txt".into())
                .unwrap()
                .ok
        );
        // Reads follow symlinks, as in any editor.
        assert!(fs_read_file(ws.s(), "renamed-link.txt".into()).unwrap().ok);
        // Lexical traversal is still refused.
        assert!(
            !fs_write_file(ws.s(), "../x.txt".into(), "x".into())
                .unwrap()
                .ok
        );
        assert!(!fs_read_file(ws.s(), "/etc/hosts".into()).unwrap().ok);
    }

    /// Moves a real file to the user's trash: ignored by default.
    #[test]
    #[ignore]
    fn move_to_trash_works_without_finder_automation() {
        let ws = TempWs::new("trash");
        std::fs::write(ws.0.join("to-trash.txt"), "x").unwrap();
        let r = fs_delete(ws.s(), "to-trash.txt".into()).unwrap();
        assert!(r.ok, "{:?}", r.error);
        assert!(!ws.0.join("to-trash.txt").exists());
    }

    #[test]
    fn the_workspace_root_cannot_be_deleted_or_renamed() {
        let ws = TempWs::new("root");
        for p in ["", ".", "./"] {
            assert!(!fs_delete(ws.s(), p.into()).unwrap().ok, "{p:?}");
            assert!(
                !fs_rename(ws.s(), p.into(), "elsewhere".into()).unwrap().ok,
                "{p:?}"
            );
        }
        assert!(ws.0.exists());
        assert!(!fs_write_file(ws.s(), ".".into(), "x".into()).unwrap().ok);
    }

    #[test]
    fn names_with_spaces_unicode_and_newlines_round_trip() {
        let ws = TempWs::new("names");
        let names = if cfg!(windows) {
            vec![
                "sp ace.txt",
                "unicodé-文件.txt",
                "hash#name.txt",
                "pct%41.txt",
            ]
        } else {
            vec![
                "sp ace.txt",
                "unicodé-文件.txt",
                "hash#name.txt",
                "pct%41.txt",
                "new\nline.txt",
                "-dash.txt",
            ]
        };
        for n in &names {
            let w = fs_write_file(ws.s(), format!("dir one/{n}"), "body".into()).unwrap();
            assert!(w.ok, "{n:?}: {:?}", w.error);
        }
        let listed = fs_list_dir_shallow(ws.s(), Some("dir one".into())).unwrap();
        let paths: Vec<String> = listed
            .entries
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        for n in &names {
            let p = format!("dir one/{n}");
            assert!(paths.contains(&p), "{p:?} not in {paths:?}");
            assert_eq!(
                fs_read_file(ws.s(), p.clone()).unwrap().content.as_deref(),
                Some("body")
            );
            let d = fs_duplicate(ws.s(), p).unwrap();
            assert!(d.ok, "{n:?}: {:?}", d.error);
        }
    }

    #[test]
    fn ordinamento_mette_prima_lo_score_migliore() {
        let q = "main.ts";
        let mut v = ["m/a/i/n/x.ts".to_string(), "src/main.ts".to_string()];
        v.sort_by_key(|p| (match_score(q, p).unwrap_or(u8::MAX), p.len()));
        assert_eq!(v[0], "src/main.ts");
    }
}
