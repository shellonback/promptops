//! Git domain.
//!
//! Each `git:…` IPC channel is a
//! `#[tauri::command]` with a snake_case name (`git:status` -> `git_status`).
//!
//! Philosophy: **predictable behavior first**. We shell out to the
//! system `git` binary and parse its stdout, instead of using a `git2`
//! library that would behave subtly differently from the git CLI. The return shapes
//! (`ok`, `files`, `error`, `output`, … fields) match exactly those
//! expected by the renderer.
//!
//! The AI calls (`generate-commit-msg`, `generate-branch-name`,
//! `resolve-conflict`, `ai-resolve-sync`) go through
//! `spawn_provider()`, which launches the provider CLI
//! via `cat <tmpfile> | <provider-cli>` in a login shell. Each AI call site is
//! marked with `// TODO:` and uses the `spawn_provider` shell pipeline.
//!
//! Standalone file: does NOT touch mod.rs / lib.rs / Cargo.toml.

use std::path::Path;

use serde::Serialize;

// ─────────────────────────────────────────────────────────────────────────────
// Return DTOs — field names match exactly the shapes expected by the
// renderer.
// All optional fields are `skip_serializing_if = Option::is_none` so
// the JSON object contains ONLY the keys that are set.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitFile {
    pub path: String,
    pub status: String,
    #[serde(rename = "statusCode")]
    pub status_code: String,
    pub staged: bool,
    /// Source path of a rename/copy (`path` is the new one).
    #[serde(rename = "origPath", skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

/// Parses `git status --porcelain -z`: `XY path\0`, and for renames/copies
/// `XY new\0old\0`.
fn parse_porcelain_z(raw: &str) -> Vec<GitFile> {
    let mut files = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let mut chars = entry.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let path: String = entry.chars().skip(3).collect();
        let orig_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            fields.next().map(str::to_string)
        } else {
            None
        };
        let status_code = format!("{x}{y}").trim().to_string();
        files.push(GitFile {
            path,
            status: parse_status(&status_code).to_string(),
            staged: x != ' ' && x != '?',
            status_code,
            orig_path,
        });
    }
    files
}

/// NUL-separated path list (`git diff --name-only -z …`).
fn split_z(raw: &str) -> Vec<String> {
    raw.split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Serialize)]
pub struct GitCounts {
    pub modified: usize,
    pub added: usize,
    pub deleted: usize,
    pub renamed: usize,
    pub conflict: usize,
    pub total: usize,
}

#[derive(Serialize)]
pub struct GitStatusResult {
    pub ok: bool,
    pub files: Vec<GitFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(rename = "diffStat", skip_serializing_if = "Option::is_none")]
    pub diff_stat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<GitCounts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Generic `{ ok, output?, error? }` response.
#[derive(Serialize, Default)]
pub struct OkOutput {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Generic `{ ok, error? }` response.
#[derive(Serialize, Default)]
pub struct OkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
pub struct DiffResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// The diff was cut at [`WORKTREE_DIFF_CAP`] bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Upper bound of a whole working-tree diff read into memory and sent over
/// IPC (Git Writer, AI messages): a vendored folder or a generated file used
/// to push hundreds of MB to the webview, which only keeps a few KB anyway.
const WORKTREE_DIFF_CAP: usize = 1024 * 1024;
const WORKTREE_DIFF_TIMEOUT_SECS: u64 = 60;

#[derive(Serialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

#[derive(Serialize)]
pub struct ListBranchesResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<GitBranch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    #[serde(rename = "shortHash")]
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: String,
    #[serde(rename = "relativeDate")]
    pub relative_date: String,
    pub refs: Vec<String>,
    pub message: String,
}

#[derive(Serialize)]
pub struct LogResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commits: Option<Vec<GitCommit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<String>>,
    #[serde(rename = "currentBranch", skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ShowResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ConflictFilesResult {
    pub ok: bool,
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GenCommitMsgResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GenBranchNameResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct DiscoverRepo {
    pub name: String,
    pub path: String,
    pub branch: String,
}

#[derive(Serialize)]
pub struct DiscoverReposResult {
    pub ok: bool,
    pub repos: Vec<DiscoverRepo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct CloneResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct MergeSourceResult {
    pub source: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<bool>,
}

#[derive(Serialize, Default)]
pub struct MergeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<bool>,
    pub results: Vec<MergeSourceResult>,
    #[serde(rename = "stashRestored", skip_serializing_if = "Option::is_none")]
    pub stash_restored: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stashed: Option<bool>,
}

#[derive(Serialize)]
pub struct AiResolveSyncResult {
    pub ok: bool,
    pub steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level helpers — execSync / execFileSync / spawn equivalents
// ─────────────────────────────────────────────────────────────────────────────

/// Result of a `git` run (`{ ok, out, err }`).
struct GitRun {
    ok: bool,
    out: String,
    err: String,
}

/// Leading arguments of every git the panel runs on its own: the repository
/// may be a fresh clone, and a `core.fsmonitor` command in its config would
/// run on the first status poll, before the user ever typed a git command.
const GIT_SAFE_ARGS: [&str; 2] = ["-c", "core.fsmonitor=false"];

/// `git` with [`GIT_SAFE_ARGS`].
fn git_cmd() -> std::process::Command {
    let mut c = crate::commands::util_cmd::cmd("git");
    c.args(GIT_SAFE_ARGS);
    c
}

/// `execFileSync('git', args, { cwd })` — no shell, no word-splitting.
/// `out`/`err` are NOT trimmed here (like execFileSync, which returns
/// raw stdout): individual call sites apply `.trim()`/`.trimEnd()`
/// where needed.
fn run_git(cwd: &str, args: &[&str]) -> GitRun {
    match git_cmd().args(args).current_dir(cwd).output() {
        Ok(output) => GitRun {
            ok: output.status.success(),
            out: String::from_utf8_lossy(&output.stdout).to_string(),
            err: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(e) => GitRun {
            ok: false,
            out: String::new(),
            err: e.to_string(),
        },
    }
}

/// Replica of the `tryGit(args)` inside ai-resolve-sync: always returns
/// `{ ok, out (trimmed), err (trimmed) }` — on error it puts stdout in `out` and
/// stderr (or message) in `err`, both trimmed.
fn try_git(cwd: &str, args: &[&str]) -> GitRun {
    let r = run_git(cwd, args);
    GitRun {
        ok: r.ok,
        out: r.out.trim().to_string(),
        err: if r.ok {
            String::new()
        } else {
            let e = r.err.trim();
            if e.is_empty() {
                // execFileSync, on error, exposes err.message; we have no separate
                // message here, so we fall back to the stdout/err already captured.
                r.out.trim().to_string()
            } else {
                e.to_string()
            }
        },
    }
}

/// Extracts the error detail:
/// `err.stderr?.trim() || err.stdout?.trim() || err.message`.
fn err_detail(r: &GitRun) -> String {
    let e = r.err.trim();
    if !e.is_empty() {
        return e.to_string();
    }
    let o = r.out.trim();
    if !o.is_empty() {
        return o.to_string();
    }
    "git command failed".to_string()
}

/// `getBranch(cwd)` — `git rev-parse --abbrev-ref HEAD`, "unknown" on error.
fn get_branch(cwd: &str) -> String {
    let r = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    if r.ok {
        r.out.trim().to_string()
    } else {
        "unknown".to_string()
    }
}

/// `hasUnmergedFiles(cwd)` — are there conflicted files (diff-filter=U)?
fn has_unmerged_files(cwd: &str) -> bool {
    let r = run_git(cwd, &["diff", "--name-only", "-z", "--diff-filter=U"]);
    if !r.ok {
        return false;
    }
    !split_z(&r.out).is_empty()
}

/// `tryStashPop(cwd)` — true if `git stash pop` succeeds.
fn try_stash_pop(cwd: &str) -> bool {
    run_git(cwd, &["stash", "pop"]).ok
}

/// `parseStatus(code)` — maps the porcelain code to a human-readable label.
fn parse_status(code: &str) -> &'static str {
    match code {
        "M" | "MM" => "modified",
        "A" | "AM" => "added",
        "D" => "deleted",
        "R" => "renamed",
        "??" | "?" => "untracked",
        "UU" => "conflict",
        _ => "modified",
    }
}

/// Login-shell command runner (`spawnShellCmd(cmd, cwd, timeout)`).
///
/// Launches the user's shell (`-l -c <cmd>` on unix,
/// `-NoProfile -Command <cmd>` on Windows) so the session inherits
/// `SSH_AUTH_SOCK`, PATH, etc. `git push` writes to stderr even on
/// success: on `code === 0` it returns `stdout || stderr`.
///
/// Returns `Ok(output)` on exit 0, `Err(message)` otherwise — where `message`
/// is `stderr.trim() || stdout.trim() || "Exit code N"`.
fn spawn_shell_cmd(cmd: &str, cwd: &str) -> Result<String, String> {
    spawn_shell_cmd_timeout(cmd, cwd, NETWORK_TIMEOUT_SECS)
}

/// Duration cap for push/pull/fetch: beyond it, git is waiting for something
/// that will never come (credentials, passphrase, editor, dead network).
const NETWORK_TIMEOUT_SECS: u64 = 120;

/// Like `spawn_shell_cmd` with an explicit timeout. The process starts in its own
/// process group (unix) so on timeout we kill shell + git + ssh together,
/// without leaving an orphan git holding `index.lock`.
fn spawn_shell_cmd_timeout(cmd: &str, cwd: &str, timeout_secs: u64) -> Result<String, String> {
    spawn_shell_cmd_env(cmd, &[], cwd, timeout_secs)
}

/// `git <args>` through the login shell (SSH agent, PATH, credential
/// helpers of the user's profile) without ever interpolating an argument
/// into the shell text: each argument travels in its own environment
/// variable and the script only references it, quoted. A branch called
/// `x';calc;'` or a URL starting with `$(…)` is therefore inert.
fn spawn_shell_git(args: &[&str], cwd: &str, timeout_secs: u64) -> Result<String, String> {
    let (script, env) = shell_git_script(args);
    spawn_shell_cmd_env(&script, &env, cwd, timeout_secs)
}

/// Shell text + environment for [`spawn_shell_git`].
fn shell_git_script(args: &[&str]) -> (String, Vec<(String, String)>) {
    let mut env = Vec::with_capacity(args.len());
    let mut parts = vec![if is_windows() { "& git" } else { "git" }.to_string()];
    parts.extend(GIT_SAFE_ARGS.iter().map(|a| a.to_string()));
    for (i, arg) in args.iter().enumerate() {
        let name = format!("PO_GIT_ARG_{i}");
        parts.push(if is_windows() {
            format!("$env:{name}")
        } else {
            format!("\"${name}\"")
        });
        env.push((name, (*arg).to_string()));
    }
    (parts.join(" "), env)
}

/// Like `spawn_shell_cmd_timeout`, with extra environment variables for the
/// shell (the values referenced by the script).
fn spawn_shell_cmd_env(
    cmd: &str,
    extra_env: &[(String, String)],
    cwd: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    use std::process::Stdio;

    crate::commands::git_setup::ensure_selected_key_loaded(cwd);

    let shell = get_shell();
    let args = get_run_args(cmd);
    let env_path = build_path(&default_extra_paths());

    let mut command = crate::commands::util_cmd::cmd(&shell);
    command
        .args(&args)
        .current_dir(cwd)
        .envs(crate::commands::git_setup::git_network_env(cwd))
        .envs(extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .env("PATH", env_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout(command, timeout_secs)
}

/// Runs a prepared command in its own process group with a hard timeout.
/// `Ok(stdout || stderr)` on exit 0 (git push writes to stderr even on
/// success), `Err(stderr || stdout || "Exit code N")` otherwise.
fn run_with_timeout(
    mut command: std::process::Command,
    timeout_secs: u64,
) -> Result<String, String> {
    use std::io::Read;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if std::time::Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).to_string();

    let Some(status) = status else {
        return Err(format!(
            "Timed out after {timeout_secs}s: git was waiting for input that can't arrive here (credentials, SSH passphrase or merge editor) or the network is down. The command was stopped."
        ));
    };
    if status.success() {
        // git push outputs to stderr even on success
        Ok(if !stdout.is_empty() { stdout } else { stderr })
    } else {
        let st = stderr.trim();
        let so = stdout.trim();
        Err(if !st.is_empty() {
            st.to_string()
        } else if !so.is_empty() {
            so.to_string()
        } else {
            format!("Exit code {}", status.code().unwrap_or(-1))
        })
    }
}

// ── shell utils ──────────────────────────────────────────────────────────────

fn is_windows() -> bool {
    cfg!(windows)
}

/// `getShell()` — powershell.exe on Windows; elsewhere the user's $SHELL when
/// it understands the POSIX-style scripts built here (`"$VAR"`, `|`, `-l -c`),
/// otherwise /bin/sh (nushell, xonsh, … would misread them).
fn get_shell() -> String {
    if is_windows() {
        return "powershell.exe".to_string();
    }
    match std::env::var("SHELL") {
        Ok(shell) if is_posix_like_shell(&shell) => shell,
        _ => "/bin/sh".to_string(),
    }
}

fn is_posix_like_shell(shell: &str) -> bool {
    let name = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    matches!(
        name,
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "mksh" | "yash" | "ash" | "fish"
    )
}

/// Refuses a ref, hash or branch name that git could parse as an option
/// (`--exec=…`, `--output=…`, `-D`, …) or that carries control characters.
/// Git itself never creates refs starting with `-`, so nothing legitimate
/// is lost; paths are protected with `--` instead.
fn validate_ref_arg(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("Empty {what}"));
    }
    if value.starts_with('-') {
        return Err(format!(
            "Invalid {what} \"{value}\": it cannot start with \"-\""
        ));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!(
            "Invalid {what}: control characters are not allowed"
        ));
    }
    Ok(())
}

/// A file inside `cwd`, resolved for reading or writing: no absolute path,
/// no `..` escaping the folder, and (after resolving symlinks) still inside
/// the real folder. Returns the full path.
fn contained_path(cwd: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    use std::path::Component;
    if rel.is_empty() || rel.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    let rel_path = Path::new(rel);
    let mut depth: i32 = 0;
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err("Path traversal detected".to_string());
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Path traversal detected".to_string())
            }
        }
    }
    let full = Path::new(cwd).join(rel_path);
    let root = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    // Deepest existing ancestor: a symlinked folder must not lead outside.
    let mut probe = full.clone();
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            if !real.starts_with(&root) {
                return Err("Path resolves outside the repository (symlink)".to_string());
            }
            break;
        }
        if !probe.pop() {
            break;
        }
    }
    Ok(full)
}

/// Reads a regular file of at most `cap` bytes (FIFOs, devices and huge files
/// are refused instead of hanging or exhausting memory).
fn read_text_capped(path: &Path, cap: u64) -> Result<String, String> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Not a regular file".to_string());
    }
    if meta.len() > cap {
        return Err("File too large".to_string());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > cap {
        return Err("File too large".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `git <args>` with stdout capped at `cap` bytes (the process is killed
/// past it) and a hard timeout. Returns `(run, truncated)`.
fn run_git_capped(cwd: &str, args: &[&str], cap: usize, timeout_secs: u64) -> (GitRun, bool) {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = match git_cmd()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                GitRun {
                    ok: false,
                    out: String::new(),
                    err: e.to_string(),
                },
                false,
            )
        }
    };
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = stderr.as_mut() {
            let _ = p.take(64 * 1024).read_to_end(&mut b);
        }
        b
    });
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = stdout {
            let _ = p.take(cap as u64 + 1).read_to_end(&mut b);
        }
        let _ = tx.send(b);
    });
    let mut bytes = rx
        .recv_timeout(std::time::Duration::from_secs(timeout_secs))
        .ok();
    let truncated = bytes.as_ref().map(|b| b.len() > cap).unwrap_or(false);
    let finished_in_time = bytes.is_some();
    if truncated || !finished_in_time {
        let _ = child.kill();
    }
    let status = child.wait().ok();
    let err = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned();
    if !finished_in_time {
        return (
            GitRun {
                ok: false,
                out: String::new(),
                err: format!("git did not answer within {timeout_secs}s"),
            },
            false,
        );
    }
    let mut out = bytes.take().unwrap_or_default();
    if truncated {
        out.truncate(cap);
    }
    (
        GitRun {
            ok: truncated || status.map(|s| s.success()).unwrap_or(false),
            out: String::from_utf8_lossy(&out).into_owned(),
            err,
        },
        truncated,
    )
}

/// `getRunArgs(cmd)` — args to run a single command through the shell.
fn get_run_args(cmd: &str) -> Vec<String> {
    if is_windows() {
        crate::commands::util_cmd::powershell_args(cmd)
    } else {
        vec!["-l".to_string(), "-c".to_string(), cmd.to_string()]
    }
}

/// `homeDir()`.
fn home_dir() -> String {
    #[allow(deprecated)]
    std::env::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// `defaultExtraPaths()` — common extra directories for CLI tools.
fn default_extra_paths() -> Vec<String> {
    let home = home_dir();
    if is_windows() {
        vec![
            format!("{home}\\AppData\\Local\\Programs"),
            format!("{home}\\AppData\\Roaming\\npm"),
            format!("{home}\\.local\\bin"),
        ]
    } else {
        vec![
            format!("{home}/.local/bin"),
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
        ]
    }
}

/// `buildPath(extraDirs)` — join with the platform separator + current PATH.
fn build_path(extra_dirs: &[String]) -> String {
    let sep = if is_windows() { ";" } else { ":" };
    let fallback = if is_windows() { "" } else { "/usr/bin:/bin" };
    let current = std::env::var("PATH").unwrap_or_else(|_| fallback.to_string());
    format!("{}{}{}", extra_dirs.join(sep), sep, current)
}

// ── model-output utils ───────────────────────────────────────────────────────
//
// The functions below implement
// cleanCommitMessage / cleanBranchName and their internal helpers. Regex via
// the `regex` crate? No — to avoid extra crates they use manual
// case-insensitive matching.

const COMMIT_TYPES: [&str; 13] = [
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
    "wip", "merge",
];

/// `^(type)(\(scope\))?!?:\s.+` — the line *is* a conventional commit.
fn is_conventional_anchored(line: &str) -> bool {
    conventional_match_from(line, 0)
        .map(|m| m == 0)
        .unwrap_or(false)
}

/// Finds a conventional commit anywhere in the line; returns the start offset
/// of the match, or None. (Equivalent to CONVENTIONAL_INLINE_RE.)
fn conventional_match_from(line: &str, _start: usize) -> Option<usize> {
    let lower = line.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for ty in COMMIT_TYPES.iter() {
        // look for occurrences of the type with a word boundary on the left
        let mut search_start = 0;
        while let Some(rel) = lower[search_start..].find(ty) {
            let idx = search_start + rel;
            // left boundary (\b): start of string or a non-alphanumeric/_ char
            let left_ok = idx == 0 || {
                let prev = bytes[idx - 1];
                !(prev.is_ascii_alphanumeric() || prev == b'_')
            };
            if left_ok {
                let mut pos = idx + ty.len();
                // (\([^)]+\))?
                if pos < bytes.len() && bytes[pos] == b'(' {
                    if let Some(close_rel) = lower[pos..].find(')') {
                        let inner = &lower[pos + 1..pos + close_rel];
                        if !inner.is_empty() {
                            pos = pos + close_rel + 1;
                        }
                    }
                }
                // !?
                if pos < bytes.len() && bytes[pos] == b'!' {
                    pos += 1;
                }
                // :\s.+
                if pos < bytes.len() && bytes[pos] == b':' {
                    pos += 1;
                    if pos < bytes.len() && (bytes[pos] == b' ' || bytes[pos] == b'\t') {
                        pos += 1;
                        if pos < bytes.len() {
                            return Some(idx);
                        }
                    }
                }
            }
            search_start = idx + 1;
            if search_start >= lower.len() {
                break;
            }
        }
    }
    None
}

const PREAMBLE_PREFIXES: [&str; 28] = [
    "sure",
    "certainly",
    "of course",
    "okay",
    "ok",
    "got it",
    "absolutely",
    "here's",
    "here is",
    "here are",
    "i'll",
    "i will",
    "i can",
    "i'd",
    "based on",
    "looking at",
    "let me",
    "the commit message",
    "commit message",
    "this commit",
    "this change",
    "this pr",
    "the changes",
    "these changes",
    "the diff",
    // unicode/straight apostrophe variants already covered by here'?s, i'?ll, i'?d
    "heres",
    "ill",
    "id",
];

/// `PREAMBLE_RE` — the line starts with a conversational opener (+ \b after).
fn is_preamble(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    for p in PREAMBLE_PREFIXES.iter() {
        if lower.starts_with(p) {
            // \b after the prefix: the next char is not alphanumeric/_
            let next = lower.as_bytes().get(p.len());
            match next {
                None => return true,
                Some(c) => {
                    if !(c.is_ascii_alphanumeric() || *c == b'_') {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// `stripCommitMessageMarker(raw)` — cuts everything up to after the LAST
/// "commit message[ is]:".
fn strip_commit_message_marker(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let mut last_end: Option<usize> = None;
    let mut from = 0;
    while let Some(rel) = lower[from..].find("commit message") {
        let start = from + rel;
        let mut pos = start + "commit message".len();
        // (?:\s+is)?
        let rest = &lower[pos..];
        let after_is = {
            // \s+is
            let trimmed_ws: String = rest.chars().take_while(|c| c.is_whitespace()).collect();
            let ws_len = trimmed_ws.len();
            if ws_len > 0 && lower[pos + ws_len..].starts_with("is") {
                Some(pos + ws_len + 2)
            } else {
                None
            }
        };
        if let Some(p) = after_is {
            pos = p;
        }
        // \s*:
        let ws2: String = lower[pos..]
            .chars()
            .take_while(|c| c.is_whitespace())
            .collect();
        let colon_pos = pos + ws2.len();
        if lower[colon_pos..].starts_with(':') {
            last_end = Some(colon_pos + 1);
            from = colon_pos + 1;
        } else {
            from = start + "commit message".len();
        }
        if from >= lower.len() {
            break;
        }
    }
    match last_end {
        Some(e) => raw[e..].to_string(),
        None => raw.to_string(),
    }
}

/// `unwrapCodeFence(text)` — if the whole output is in a single fence block,
/// returns the trimmed inner content; otherwise the input.
fn unwrap_code_fence(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() < 2 {
        return text.to_string();
    }
    let first = lines[0];
    let is_fence = |s: &str| s.starts_with("```") || s.starts_with("~~~");
    if !is_fence(first) {
        return text.to_string();
    }
    // the last line (possible trailing whitespace) must be a fence
    let last_idx = lines.len() - 1;
    let last = lines[last_idx].trim_end();
    if !(last == "```" || last == "~~~") {
        // could there be a trailing empty line? The fence match allows \s* after
        // the closing fence, but the fence is in fact the last non-empty line.
        return text.to_string();
    }
    let inner = lines[1..last_idx].join("\n");
    inner.trim().to_string()
}

/// `toLines(raw)` — trim, unwrap fence, trimmed non-empty lines.
fn to_lines(raw: &str) -> Vec<String> {
    unwrap_code_fence(raw.trim())
        .split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// `stripDecorations(s)` — removes wrapping quotes/backticks and the `commit:` label.
fn strip_decorations(s: &str) -> String {
    let mut t = s.to_string();
    // ^["'`]+
    let leading = t
        .chars()
        .take_while(|c| *c == '"' || *c == '\'' || *c == '`')
        .count();
    t = t.chars().skip(leading).collect();
    // ["'`]+$
    let trailing = t
        .chars()
        .rev()
        .take_while(|c| *c == '"' || *c == '\'' || *c == '`')
        .count();
    let keep = t.chars().count().saturating_sub(trailing);
    t = t.chars().take(keep).collect();
    // ^commit:\s*  (case-insensitive)
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("commit:") {
        let consumed = t.len() - rest.len();
        let after = &t[consumed..];
        t = after.trim_start().to_string();
    }
    t.trim().to_string()
}

/// `extractCommitSubject(raw)` — None when nothing is usable.
fn extract_commit_subject(raw: &str) -> Option<String> {
    let lines = to_lines(&strip_commit_message_marker(raw));
    if lines.is_empty() {
        return None;
    }
    // 1. a line that IS a conventional commit
    if let Some(anchored) = lines.iter().find(|l| is_conventional_anchored(l)) {
        return Some(anchored.clone());
    }
    // 2. first line that is not a preamble
    if let Some(plain) = lines.iter().find(|l| !is_preamble(l)) {
        return Some(plain.clone());
    }
    // 3. extract an inline conventional commit from any line
    for l in &lines {
        if let Some(idx) = conventional_match_from(l, 0) {
            return Some(l[idx..].trim().to_string());
        }
    }
    None
}

/// `cleanCommitMessage(raw)`.
fn clean_commit_message(raw: &str) -> Option<String> {
    let subject = extract_commit_subject(raw)?;
    let cleaned = strip_decorations(&subject);
    let first_line = cleaned.split('\n').next().unwrap_or("").trim().to_string();
    if !first_line.is_empty() {
        Some(first_line)
    } else {
        None
    }
}

/// `cleanBranchName(raw)`.
fn clean_branch_name(raw: &str) -> Option<String> {
    let lines = to_lines(raw);
    if lines.is_empty() {
        return None;
    }
    let candidate = lines.iter().find(|l| !is_preamble(l))?;
    // stripDecorations then \s+ -> '-'
    let stripped = strip_decorations(candidate);
    let mut out = String::new();
    let mut in_ws = false;
    for c in stripped.chars() {
        if c.is_whitespace() {
            in_ws = true;
        } else {
            if in_ws {
                out.push('-');
                in_ws = false;
            }
            out.push(c);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ── provider-cli (spawnProvider) ─────────────────────────────────────────────
//
// spawn_provider writes the prompt to a temp file and runs
// `cat <tmpfile> | <provider-cli>` in a login shell, with an enriched PATH
// (.nvm/current/bin, .npm-global/bin). These git handlers ALWAYS use the
// provider CLI: there is no HTTP call here.

const PROVIDER_COMMANDS: [(&str, &str); 3] = [
    ("claude-code-cli", "claude -p --output-format text"),
    ("claude", "claude -p --output-format text"),
    ("gemini-cli", "gemini -p"),
];

/// `spawnProvider(provider, prompt, cwd)` — returns the provider's stdout.
/// AI call through a shell pipeline; the provider CLI
/// must be installed on the system. If missing or on error it returns Err with
/// the message.
fn spawn_provider(provider: &str, prompt: &str, cwd: &str) -> Result<String, String> {
    spawn_provider_with(
        provider,
        prompt,
        cwd,
        &ProviderShell::user(),
        PROVIDER_TIMEOUT_SECS,
        None,
    )
}

/// A provider that never answers (login prompt, network) must not keep the
/// git panel spinning forever.
pub(crate) const PROVIDER_TIMEOUT_SECS: u64 = 300;

/// How the provider pipeline is launched: the user's login shell in the app,
/// a plain shell with a controlled PATH in tests.
pub(crate) struct ProviderShell {
    program: String,
    args_before_cmd: Vec<String>,
    /// Text put before the pipeline (the UTF-8 preamble on PowerShell).
    script_prefix: String,
    path: String,
}

impl ProviderShell {
    pub(crate) fn user() -> Self {
        let home = home_dir();
        let mut extra = default_extra_paths();
        extra.push(format!("{home}/.nvm/versions/node/current/bin"));
        extra.push(format!("{home}/.npm-global/bin"));
        let mut args = get_run_args("");
        let script_prefix = args.pop().unwrap_or_default();
        Self {
            program: get_shell(),
            args_before_cmd: args,
            script_prefix,
            path: build_path(&extra),
        }
    }
}

/// Model flag of each provider's headless mode (`--help` of the installed
/// CLIs, October 2026). Unknown providers fall back to Claude Code and get no
/// model: a name picked for another vendor would make it fail.
fn model_flag(provider: &str) -> Option<&'static str> {
    match provider {
        "claude-code-cli" | "claude" => Some("--model"),
        "codex" | "gemini-cli" | "grok" => Some("-m"),
        "copilot" => Some("--model"),
        _ => None,
    }
}

/// CLI command line `provider` runs in the pipeline, without prompt or model:
/// tells which AI Accounts account applies (`utility_account_provider`).
fn provider_command_line(provider: &str) -> &'static str {
    match provider {
        "codex" => "codex exec",
        "grok" => "grok",
        "copilot" => "copilot -s",
        _ => PROVIDER_COMMANDS
            .iter()
            .find(|(k, _)| *k == provider)
            .map(|(_, v)| *v)
            .unwrap_or("claude -p --output-format text"),
    }
}

/// Shell text of the provider pipeline. The prompt file, the Codex output
/// file and the model are referenced through environment variables, never
/// pasted into the text: a temp dir under a user name like `O'Brien` used to
/// break it, and nothing in the text can come from the prompt.
///
/// The active account applies: an alias account (`PROMPTOPS_PROVIDER_COMMAND`)
/// replaces the CLI binary.
fn provider_pipeline_for(
    provider: &str,
    with_model: bool,
    account_vars: &[(String, String)],
) -> String {
    let cli =
        |line: String| crate::commands::provider_account::utility_base_command(line, account_vars);
    let win = is_windows();
    let var = |name: &str| {
        if win {
            format!("$env:{name}")
        } else {
            format!("\"${name}\"")
        }
    };
    let input = if win {
        "Get-Content -Raw -Encoding UTF8 -LiteralPath $env:PO_PROMPT_FILE".to_string()
    } else {
        "cat \"$PO_PROMPT_FILE\"".to_string()
    };
    let model = match model_flag(provider) {
        Some(flag) if with_model => format!(" {flag} {}", var("PO_MODEL")),
        _ => String::new(),
    };
    // grok and the GitHub Copilot CLI take the prompt as an option value
    // (a bare `grok -p` is a usage error, `gh copilot suggest` is retired).
    if provider == "grok" {
        return cli(format!(
            "grok{model} --prompt-file {}",
            var("PO_PROMPT_FILE")
        ));
    }
    if provider == "copilot" {
        // `--prompt=<text>` keeps a prompt that starts with `-` a value. On
        // Windows the text reaches copilot through PowerShell's native
        // argument passing, which (5.1, and 7.x for `.cmd` shims) does not
        // escape inner `"`: they would split the prompt into extra copilot
        // flags. They become `'`, and a trailing space keeps a final `\`
        // away from the closing quote.
        return if win {
            format!(
                "$p=((Get-Content -Raw -Encoding UTF8 -LiteralPath $env:PO_PROMPT_FILE) -replace '\"', \"'\") + ' '; {}",
                cli(format!("copilot -s --no-color{model} \"--prompt=$p\""))
            )
        } else {
            cli(format!(
                "copilot -s --no-color{model} --prompt=\"$(cat \"$PO_PROMPT_FILE\")\""
            ))
        };
    }
    let base_cmd: String = if provider == "codex" {
        format!(
            "codex exec --skip-git-repo-check --color never{model} --output-last-message {} -",
            var("PO_CODEX_OUT")
        )
    } else {
        let base = PROVIDER_COMMANDS
            .iter()
            .find(|(k, _)| *k == provider)
            .map(|(_, v)| *v)
            .unwrap_or("claude -p --output-format text");
        format!("{base}{model}")
    };
    format!("{input} | {}", cli(base_cmd))
}

/// Runs `provider` headless on `prompt` in `cwd` and returns its answer.
/// The CLI runs in its own process group and the whole group is killed after
/// `timeout_secs`. `model` must already be a plain model id
/// (`subagent::sanitize_model_flag`); anything else is ignored.
pub(crate) fn spawn_provider_with(
    provider: &str,
    prompt: &str,
    cwd: &str,
    shell: &ProviderShell,
    timeout_secs: u64,
    model: Option<&str>,
) -> Result<String, String> {
    let model = crate::commands::subagent::sanitize_model_flag(model);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand: u32 = {
        // small pseudo-random for the file name suffix (Math.random slice)

        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    };
    // Prompt and Codex output live in a private per-call dir (0700, random
    // name), removed when `tmp_guard` drops at the end of the call.
    let tmp_guard = crate::commands::util_cmd::PrivateTempDir::new("promptops-llm")?;
    let tmp_dir = tmp_guard.path().to_path_buf();
    let tmp_file = tmp_dir.join(format!("promptops-{now}-{rand:x}.txt"));
    if let Err(e) = crate::local_store::write_private(&tmp_file, prompt.as_bytes()) {
        return Err(format!("Failed to write prompt file: {e}"));
    }

    let is_codex = provider == "codex";
    let codex_out_file = if is_codex {
        Some(tmp_dir.join(format!("promptops-codex-out-{now}-{rand:x}.txt")))
    } else {
        None
    };

    // Active account (AI Accounts): same login as new sessions.
    let account_vars = crate::commands::provider_account::utility_account_vars(
        crate::commands::provider_account::utility_account_provider(
            provider,
            provider_command_line(provider),
        ),
    );
    // The login shell may rewrite the env in its startup files: the account
    // is reasserted before the pipeline (POSIX shells only).
    let line = crate::commands::provider_account::utility_shell_line(
        provider_pipeline_for(provider, model.is_some(), &account_vars),
        &account_vars,
        &shell.program,
    );
    let mut command = crate::commands::util_cmd::cmd(&shell.program);
    command
        .args(&shell.args_before_cmd)
        .arg(format!("{}{}", shell.script_prefix, line))
        .current_dir(cwd)
        .env("PATH", &shell.path)
        .env("PO_PROMPT_FILE", &tmp_file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for key in crate::commands::provider_account::utility_env_removals(&account_vars) {
        command.env_remove(key);
    }
    command.envs(account_vars.iter().map(|(k, v)| (k, v)));
    if let Some(cf) = &codex_out_file {
        command.env("PO_CODEX_OUT", cf);
    }
    if let Some(m) = &model {
        command.env("PO_MODEL", m);
    }

    let result = run_with_timeout(command, timeout_secs);
    let mut out = String::new();
    if result.is_ok() {
        if let Some(cf) = codex_out_file.as_ref().filter(|cf| cf.exists()) {
            if let Ok(content) = std::fs::read_to_string(cf) {
                out = content.trim().to_string();
            }
        }
    }
    // The private temp dir (prompt + Codex output) is removed by `tmp_guard`.
    drop(tmp_guard);
    match result {
        Ok(stdout_or_stderr) => {
            if out.is_empty() {
                out = stdout_or_stderr.trim().to_string();
            }
            if out.is_empty() {
                Err("Provider returned empty response".to_string())
            } else {
                Ok(out)
            }
        }
        Err(e) if e.starts_with("Timed out") => Err(format!(
            "The provider CLI did not answer within {timeout_secs}s and was stopped."
        )),
        Err(e) => Err(e),
    }
}

/// Safe branch name for auto-push/upstream: `^[A-Za-z0-9._\/\-]+$`.
fn is_safe_branch_chars(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

/// git:status
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusResult, String> {
    // Status is polled while the explorer is open. Bound the read and never
    // compute a whole-working-tree diff merely to obtain file names.
    // `-z`: paths raw and NUL-terminated. Without it git quotes every path with
    // a space, a quote or a non-ASCII byte (`"sp ace.txt"`,
    // `"unicod\303\250.txt"`) and writes renames as `old -> new`: those
    // strings then reached `git add -- <path>` and matched nothing.
    let raw = match history_git(
        &cwd,
        &["--no-optional-locks", "status", "--porcelain", "-z", "-u"],
        2 * 1024 * 1024,
    )
    .await
    {
        Ok((out, false)) => GitRun {
            ok: true,
            out,
            err: String::new(),
        },
        Ok((_, true)) => GitRun {
            ok: false,
            out: String::new(),
            err: "Working tree file list exceeds the 2 MiB limit".into(),
        },
        Err(err) => GitRun {
            ok: false,
            out: String::new(),
            err,
        },
    };
    if !raw.ok {
        return Ok(GitStatusResult {
            ok: false,
            files: vec![],
            branch: None,
            diff_stat: None,
            counts: None,
            error: Some(err_detail(&raw)),
        });
    }

    let files = parse_porcelain_z(&raw.out);
    if files.is_empty() {
        return Ok(GitStatusResult {
            ok: true,
            files: vec![],
            branch: Some(get_branch(&cwd)),
            diff_stat: None,
            counts: Some(GitCounts {
                modified: 0,
                added: 0,
                deleted: 0,
                renamed: 0,
                conflict: 0,
                total: 0,
            }),
            error: None,
        });
    }

    let branch = get_branch(&cwd);

    // No consumer uses diffStat. Computing it reads every modified blob and
    // can dominate both opening Git History and its periodic status refresh.

    let counts = GitCounts {
        modified: files.iter().filter(|f| f.status == "modified").count(),
        added: files
            .iter()
            .filter(|f| f.status == "added" || f.status == "untracked")
            .count(),
        deleted: files.iter().filter(|f| f.status == "deleted").count(),
        renamed: files.iter().filter(|f| f.status == "renamed").count(),
        conflict: files.iter().filter(|f| f.status == "conflict").count(),
        total: files.len(),
    };

    Ok(GitStatusResult {
        ok: true,
        files,
        branch: Some(branch),
        diff_stat: None,
        counts: Some(counts),
        error: None,
    })
}

/// git:stage
#[tauri::command]
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<OkResult, String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &paths {
        args.push(p.as_str());
    }
    let r = run_git(&cwd, &args);
    if r.ok {
        Ok(OkResult {
            ok: true,
            error: None,
        })
    } else {
        Ok(OkResult {
            ok: false,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:unstage
#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<OkResult, String> {
    let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
    for p in &paths {
        args.push(p.as_str());
    }
    let r = run_git(&cwd, &args);
    if r.ok {
        Ok(OkResult {
            ok: true,
            error: None,
        })
    } else {
        Ok(OkResult {
            ok: false,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:commit — optionally stages `paths` before committing.
#[tauri::command]
pub async fn git_commit(
    cwd: String,
    message: String,
    paths: Option<Vec<String>>,
) -> Result<OkOutput, String> {
    if let Some(ps) = &paths {
        if !ps.is_empty() {
            let mut args: Vec<&str> = vec!["add", "--"];
            for p in ps {
                args.push(p.as_str());
            }
            let staged = run_git(&cwd, &args);
            if !staged.ok {
                return Ok(OkOutput {
                    ok: false,
                    output: None,
                    error: Some(err_detail(&staged)),
                });
            }
        }
    }

    let r = run_git(&cwd, &["commit", "-m", &message]);
    if r.ok {
        Ok(OkOutput {
            ok: true,
            output: Some(r.out.trim().to_string()),
            error: None,
        })
    } else {
        Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:diff
#[tauri::command]
pub async fn git_diff(cwd: String, staged: Option<bool>) -> Result<DiffResult, String> {
    let args: Vec<&str> = if staged.unwrap_or(false) {
        vec!["diff", "--cached", "--no-ext-diff"]
    } else {
        vec!["diff", "--no-ext-diff"]
    };
    let (r, truncated) = run_git_capped(&cwd, &args, WORKTREE_DIFF_CAP, WORKTREE_DIFF_TIMEOUT_SECS);
    if r.ok {
        Ok(DiffResult {
            ok: true,
            diff: Some(r.out.trim().to_string()),
            truncated: truncated.then_some(true),
            error: None,
        })
    } else {
        Ok(DiffResult {
            ok: false,
            diff: None,
            truncated: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:stash
#[tauri::command]
pub async fn git_stash(cwd: String) -> Result<OkOutput, String> {
    let label = format!("promptops-stash-{}", now_millis());
    let r = run_git(&cwd, &["stash", "push", "-m", &label]);
    if r.ok {
        let out = r.out.trim();
        Ok(OkOutput {
            ok: true,
            output: Some(if out.is_empty() {
                "Stash created".to_string()
            } else {
                out.to_string()
            }),
            error: None,
        })
    } else {
        Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:stash-pop
#[tauri::command]
pub async fn git_stash_pop(cwd: String) -> Result<OkOutput, String> {
    let r = run_git(&cwd, &["stash", "pop"]);
    if r.ok {
        let out = r.out.trim();
        Ok(OkOutput {
            ok: true,
            output: Some(if out.is_empty() {
                "Stash applied".to_string()
            } else {
                out.to_string()
            }),
            error: None,
        })
    } else {
        Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:pull — via login shell (SSH agent access). Fetches the upstream if missing.
#[tauri::command]
pub async fn git_pull(cwd: String) -> Result<OkOutput, String> {
    match spawn_shell_cmd("git pull --no-edit", &cwd) {
        Ok(out) => Ok(OkOutput {
            ok: true,
            output: Some(out.trim().to_string()),
            error: None,
        }),
        Err(msg) => {
            let lower = msg.to_lowercase();
            let no_upstream = lower.contains("no tracking information")
                || lower.contains("no upstream")
                || lower.contains("set-upstream-to");
            if no_upstream {
                let branch = get_branch(&cwd);
                if branch != "unknown" && is_safe_branch_chars(&branch) {
                    let remote_ref = run_git(
                        &cwd,
                        &[
                            "rev-parse",
                            "--verify",
                            &format!("refs/remotes/origin/{branch}"),
                        ],
                    );
                    if remote_ref.ok {
                        let set = run_git(
                            &cwd,
                            &[
                                "branch",
                                &format!("--set-upstream-to=origin/{branch}"),
                                &branch,
                            ],
                        );
                        if set.ok {
                            if let Ok(out) = spawn_shell_cmd("git pull --no-edit", &cwd) {
                                return Ok(OkOutput {
                                    ok: true,
                                    output: Some(format!(
                                        "[upstream set to origin/{branch}]\n{}",
                                        out.trim()
                                    )),
                                    error: None,
                                });
                            }
                        }
                    }
                    return Ok(OkOutput {
                        ok: false,
                        output: None,
                        error: Some(format!(
                            "Branch '{branch}' has no upstream and no matching 'origin/{branch}' exists yet. Push first to create the remote branch."
                        )),
                    });
                }
            }
            Ok(OkOutput {
                ok: false,
                output: None,
                error: Some(msg),
            })
        }
    }
}

/// git:push — via login shell. Auto-upstream with -u if missing.
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<OkOutput, String> {
    match spawn_shell_cmd("git push", &cwd) {
        Ok(out) => Ok(OkOutput {
            ok: true,
            output: Some(out.trim().to_string()),
            error: None,
        }),
        Err(msg) => {
            let lower = msg.to_lowercase();
            let no_upstream = lower.contains("has no upstream branch")
                || lower.contains("no upstream")
                || lower.contains("set-upstream");
            if no_upstream {
                let branch = get_branch(&cwd);
                if branch != "unknown" && is_safe_branch_chars(&branch) {
                    match spawn_shell_git(
                        &["push", "-u", "origin", &branch],
                        &cwd,
                        NETWORK_TIMEOUT_SECS,
                    ) {
                        Ok(out) => {
                            return Ok(OkOutput {
                                ok: true,
                                output: Some(format!(
                                    "[upstream set to origin/{branch}]\n{}",
                                    out.trim()
                                )),
                                error: None,
                            });
                        }
                        Err(e) => {
                            return Ok(OkOutput {
                                ok: false,
                                output: None,
                                error: Some(e),
                            });
                        }
                    }
                }
            }
            Ok(OkOutput {
                ok: false,
                output: None,
                error: Some(msg),
            })
        }
    }
}

/// Splits a mini-terminal line into arguments the way a POSIX shell would for
/// plain words and quotes, but with no expansion at all. Anything that would
/// need a shell to mean something (pipes, `;`, `&`, redirections, `$`,
/// backticks, sub-shells, line breaks) is refused with a readable message
/// instead of being executed.
fn split_command_line(line: &str) -> Result<Vec<String>, String> {
    const SHELL_FEATURE: &str = "Shell features (pipes, redirections, ';', '&', '$', backticks, line breaks) are not supported here: run this command in a terminal.";
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(ch) => cur.push(ch),
                        None => return Err("Unterminated quote".to_string()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if !is_windows() => match chars.next() {
                            Some(n @ ('"' | '\\')) => cur.push(n),
                            Some(n) => {
                                cur.push('\\');
                                cur.push(n);
                            }
                            None => return Err("Unterminated quote".to_string()),
                        },
                        Some('$') | Some('`') => return Err(SHELL_FEATURE.to_string()),
                        Some(ch) => cur.push(ch),
                        None => return Err("Unterminated quote".to_string()),
                    }
                }
            }
            // Windows paths use backslashes: literal there, escape elsewhere.
            '\\' if !is_windows() => {
                in_word = true;
                match chars.next() {
                    Some('\n') | Some('\r') => return Err(SHELL_FEATURE.to_string()),
                    Some(n) => cur.push(n),
                    None => cur.push('\\'),
                }
            }
            ' ' | '\t' => {
                if in_word {
                    args.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            '\n' | '\r' | '|' | ';' | '&' | '<' | '>' | '(' | ')' | '$' | '`' => {
                return Err(SHELL_FEATURE.to_string())
            }
            other => {
                in_word = true;
                cur.push(other);
            }
        }
    }
    if in_word {
        args.push(cur);
    }
    Ok(args)
}

/// git:exec — arbitrary git command (mini-terminal). Only `git ` commands.
#[tauri::command]
pub async fn git_exec(cwd: String, command: String) -> Result<OkOutput, String> {
    // The line is split here, without a shell: before, it went to `$SHELL -c`
    // as typed, so "only git commands" also ran `git status; rm -rf ~` and a
    // file name like `$(…)` quoted by a caller was expanded.
    let args = match split_command_line(command.trim()) {
        Ok(args) => args,
        Err(e) => {
            return Ok(OkOutput {
                ok: false,
                output: Some(e),
                error: None,
            })
        }
    };
    if args.first().map(String::as_str) != Some("git") || args.len() < 2 {
        return Ok(OkOutput {
            ok: false,
            output: Some("Only git commands are allowed.".to_string()),
            error: None,
        });
    }
    let git_args: Vec<&str> = args[1..].iter().map(String::as_str).collect();
    match spawn_shell_git(&git_args, &cwd, 300) {
        Ok(out) => Ok(OkOutput {
            ok: true,
            output: Some(out.trim().to_string()),
            error: None,
        }),
        // Note: the error goes in the `output` field, NOT in `error`.
        Err(msg) => Ok(OkOutput {
            ok: false,
            output: Some(msg),
            error: None,
        }),
    }
}

/// git:list-branches
#[tauri::command]
pub async fn git_list_branches(cwd: String) -> Result<ListBranchesResult, String> {
    let r = run_git(&cwd, &["branch", "-a", "--no-color"]);
    if !r.ok {
        return Ok(ListBranchesResult {
            ok: false,
            branches: None,
            current: None,
            error: Some(err_detail(&r)),
        });
    }
    let current = get_branch(&cwd);
    let branches: Vec<GitBranch> = r
        .out
        .split('\n')
        .map(|l| {
            // l.replace(/^\*?\s+/, '').trim()
            let mut s = l;
            if let Some(rest) = s.strip_prefix('*') {
                s = rest;
            }
            s.trim().to_string()
        })
        .filter(|l| !l.is_empty() && !l.starts_with("HEAD"))
        .map(|name| {
            let display = name
                .strip_prefix("remotes/")
                .map(|s| s.to_string())
                .unwrap_or_else(|| name.clone());
            GitBranch {
                current: name == current,
                remote: name.starts_with("remotes/"),
                name: display,
            }
        })
        .collect();

    Ok(ListBranchesResult {
        ok: true,
        branches: Some(branches),
        current: Some(current),
        error: None,
    })
}

/// git:checkout
#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<OkOutput, String> {
    if let Err(e) = validate_ref_arg(&branch, "branch") {
        return Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(e),
        });
    }
    // Trailing `--`: the name is always a revision, never a path (a file
    // called like the branch would otherwise be checked out over local edits).
    let r = run_git(&cwd, &["checkout", &branch, "--"]);
    if r.ok {
        Ok(OkOutput {
            ok: true,
            output: Some(r.out.trim().to_string()),
            error: None,
        })
    } else {
        Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:create-branch — checkout -b, optionally at `startPoint` (the
/// "Create branch here…" action on a commit of the graph).
#[tauri::command]
pub async fn git_create_branch(
    cwd: String,
    branch: String,
    start_point: Option<String>,
) -> Result<OkOutput, String> {
    let start = start_point.filter(|s| !s.trim().is_empty());
    let checks = validate_ref_arg(&branch, "branch name").and_then(|_| match &start {
        Some(s) => validate_ref_arg(s, "start point"),
        None => Ok(()),
    });
    if let Err(e) = checks {
        return Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(e),
        });
    }
    let mut args = vec!["checkout", "-b", branch.as_str()];
    if let Some(s) = &start {
        args.push(s.as_str());
    }
    args.push("--");
    let r = run_git(&cwd, &args);
    if r.ok {
        Ok(OkOutput {
            ok: true,
            output: Some(r.out.trim().to_string()),
            error: None,
        })
    } else {
        Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:file-diff — per-file diff for the viewer. Staged → unstaged → untracked.
#[tauri::command]
pub async fn git_file_diff(cwd: String, file_path: String) -> Result<DiffResult, String> {
    let mut diff = String::new();

    let staged = run_git(&cwd, &["diff", "--cached", "--", &file_path]);
    if staged.ok {
        diff = staged.out.trim().to_string();
    }
    if diff.is_empty() {
        let unstaged = run_git(&cwd, &["diff", "--", &file_path]);
        if unstaged.ok {
            diff = unstaged.out.trim().to_string();
        }
    }
    // Untracked file: show the whole content as "added" — only for a regular
    // file inside the repository (no `../`, no symlink out, no FIFO, ≤ 5 MB).
    if diff.is_empty() {
        let content = contained_path(&cwd, &file_path)
            .and_then(|full| read_text_capped(&full, FILE_AT_HEAD_MAX_BYTES as u64));
        if let Ok(content) = content {
            let line_count = content.split('\n').count();
            let body: String = content
                .split('\n')
                .map(|l| format!("+{l}"))
                .collect::<Vec<_>>()
                .join("\n");
            diff = format!("--- /dev/null\n+++ b/{file_path}\n@@ -0,0 +1,{line_count} @@\n{body}");
        }
    }

    Ok(DiffResult {
        ok: true,
        diff: Some(diff),
        truncated: None,
        error: None,
    })
}

/// Content of a file at HEAD, for the editor's side-by-side diff.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAtHeadResult {
    pub ok: bool,
    /// `false` if the file does not exist at HEAD (untracked/new or repo without commits).
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Beyond this threshold the side-by-side diff is not useful and is costly: no content.
const FILE_AT_HEAD_MAX_BYTES: usize = 5 * 1024 * 1024;

/// git:file-at-head — `git show HEAD:./<path>` (path relative to cwd).
#[tauri::command]
pub async fn git_file_at_head(cwd: String, file_path: String) -> Result<FileAtHeadResult, String> {
    let rel = file_path.trim_start_matches(['/', '\\']).replace('\\', "/");
    let spec = format!("HEAD:./{rel}");
    let run = run_git(&cwd, &["show", &spec]);
    if !run.ok {
        // New/untracked file or repo without commits: the left side is empty.
        return Ok(FileAtHeadResult {
            ok: true,
            exists: false,
            content: Some(String::new()),
            error: None,
        });
    }
    if run.out.len() > FILE_AT_HEAD_MAX_BYTES {
        return Ok(FileAtHeadResult {
            ok: false,
            exists: true,
            content: None,
            error: Some("File too large to diff".to_string()),
        });
    }
    Ok(FileAtHeadResult {
        ok: true,
        exists: true,
        content: Some(run.out),
        error: None,
    })
}

/// git:log — recent commits (graph). Maps the format string with the ‡‡‡ separator.
#[tauri::command]
pub async fn git_log(cwd: String, limit: Option<u32>) -> Result<LogResult, String> {
    let n = limit.unwrap_or(20);
    const SEP: &str = "‡‡‡";
    let format = format!("%H{s}%h{s}%P{s}%an{s}%ae{s}%aI{s}%ar{s}%D{s}%s", s = SEP);

    let max_count = format!("--max-count={n}");
    let pretty = format!("--pretty=format:{format}");

    // GIT_PAGER=cat, GIT_TERMINAL_PROMPT=0 to avoid hangs.
    let result = git_cmd()
        .args(["log", &max_count, "--all", &pretty, "--no-color"])
        .current_dir(&cwd)
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();

    let r = match result {
        Ok(o) => GitRun {
            ok: o.status.success(),
            out: String::from_utf8_lossy(&o.stdout).to_string(),
            err: String::from_utf8_lossy(&o.stderr).to_string(),
        },
        Err(e) => GitRun {
            ok: false,
            out: String::new(),
            err: e.to_string(),
        },
    };

    if !r.ok {
        let e = r.err.trim();
        return Ok(LogResult {
            ok: false,
            commits: None,
            branches: None,
            current_branch: None,
            error: Some(if e.is_empty() {
                "git log failed".to_string()
            } else {
                e.to_string()
            }),
        });
    }

    let raw = r.out.trim();
    if raw.is_empty() {
        return Ok(LogResult {
            ok: true,
            commits: Some(vec![]),
            branches: Some(vec![]),
            current_branch: Some(get_branch(&cwd)),
            error: None,
        });
    }

    let commits: Vec<GitCommit> = raw
        .split('\n')
        .map(|line| {
            let parts: Vec<&str> = line.split(SEP).collect();
            let g = |i: usize| parts.get(i).copied().unwrap_or("");
            GitCommit {
                hash: g(0).to_string(),
                short_hash: g(1).to_string(),
                parents: if !g(2).is_empty() {
                    g(2).split(' ').map(|s| s.to_string()).collect()
                } else {
                    vec![]
                },
                author: g(3).to_string(),
                email: g(4).to_string(),
                date: g(5).to_string(),
                relative_date: g(6).to_string(),
                refs: if !g(7).is_empty() {
                    g(7).split(", ")
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .collect()
                } else {
                    vec![]
                },
                message: g(8).to_string(),
            }
        })
        .collect();

    // branchSet: refs without "HEAD -> " and without "tag:"
    let mut branch_set: Vec<String> = Vec::new();
    for c in &commits {
        for r#ref in &c.refs {
            let clean = r#ref
                .strip_prefix("HEAD -> ")
                .unwrap_or(r#ref)
                .trim()
                .to_string();
            if !clean.is_empty() && !clean.starts_with("tag:") && !branch_set.contains(&clean) {
                branch_set.push(clean);
            }
        }
    }

    Ok(LogResult {
        ok: true,
        commits: Some(commits),
        branches: Some(branch_set),
        current_branch: Some(get_branch(&cwd)),
        error: None,
    })
}

// History browsing never materializes a whole commit patch. Bound subprocess output,
// runtime and concurrency before it reaches IPC or the webview.
static HISTORY_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
const HISTORY_PATCH_BYTES: usize = 256 * 1024;
const HISTORY_BLOB_BYTES: u64 = 2 * 1024 * 1024;

async fn history_git(cwd: &str, args: &[&str], cap: usize) -> Result<(String, bool), String> {
    use tokio::io::AsyncReadExt;
    let _permit = HISTORY_READS.acquire().await.map_err(|e| e.to_string())?;
    let mut child = crate::commands::util_cmd::tokio_cmd("git")
        .args(GIT_SAFE_ARGS)
        .args(["--no-pager", "--literal-pathspecs"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Cannot read Git output")?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .take((cap + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        let truncated = bytes.len() > cap;
        if truncated {
            child.kill().await.map_err(|e| e.to_string())?;
            bytes.truncate(cap);
        } else if !child.wait().await.map_err(|e| e.to_string())?.success() {
            return Err("Unable to read this revision or file".to_string());
        }
        Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), operation)
        .await
        .map_err(|_| "Git preview timed out".to_string())?
}

fn validate_history_hash(hash: &str) -> Result<(), String> {
    if !(hash.len() == 40 || hash.len() == 64) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid commit hash".to_string());
    }
    Ok(())
}

fn history_files(raw: &str) -> Vec<JsonValue> {
    let mut fields = raw.split_terminator('\0');
    let mut files = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        files.push(json!({ "path": path, "status": match status {
            "A" => "added", "D" => "deleted", _ => "modified",
        }}));
    }
    files
}

/// Lightweight file manifest; merges are compared with their first parent.
#[tauri::command]
pub async fn git_commit_files(cwd: String, hash: String) -> Result<JsonValue, String> {
    validate_history_hash(&hash)?;
    let (raw, truncated) = history_git(
        &cwd,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "-r",
            "--diff-merges=first-parent",
            "--no-renames",
            "--name-status",
            "-z",
            &hash,
            "--",
        ],
        2 * 1024 * 1024,
    )
    .await?;
    if truncated {
        return Err("File list exceeds the preview limit".to_string());
    }
    let (body, _) =
        history_git(&cwd, &["log", "-1", "--format=%B", &hash, "--"], 32 * 1024).await?;
    Ok(json!({ "ok": true, "files": history_files(&raw), "body": body }))
}

/// One literal path only. Oversized blobs are refused before Git computes a diff.
#[tauri::command]
pub async fn git_commit_file_diff(
    cwd: String,
    hash: String,
    file_path: String,
) -> Result<JsonValue, String> {
    validate_history_hash(&hash)?;
    if file_path.is_empty() || file_path.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    for rev in [hash.clone(), format!("{hash}^1")] {
        let spec = format!("{rev}:{file_path}");
        // A missing side is normal for additions, deletions and root commits.
        if let Ok((size, _)) = history_git(&cwd, &["cat-file", "-s", &spec], 128).await {
            if size.trim().parse::<u64>().unwrap_or(u64::MAX) > HISTORY_BLOB_BYTES {
                return Err(
                    "File exceeds the 2 MiB preview limit. Inspect it with a local Git tool."
                        .to_string(),
                );
            }
        }
    }
    let (mut diff, truncated) = history_git(
        &cwd,
        &[
            "show",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--diff-merges=first-parent",
            "--unified=3",
            &hash,
            "--",
            &file_path,
        ],
        HISTORY_PATCH_BYTES,
    )
    .await?;
    if truncated {
        // Never render an incomplete final line (including partial UTF-8).
        diff.truncate(diff.rfind('\n').unwrap_or(0));
    }
    Ok(json!({ "ok": true, "diff": diff, "truncated": truncated }))
}

/// git:show — body + stat + patch of a commit.
#[tauri::command]
pub async fn git_show(cwd: String, hash: String) -> Result<ShowResult, String> {
    // `--output=<file>` as a "hash" made git log write a file anywhere.
    if let Err(e) = validate_ref_arg(&hash, "commit") {
        return Ok(ShowResult {
            ok: false,
            body: None,
            stat: None,
            diff: None,
            error: Some(e),
        });
    }
    let body = run_git(&cwd, &["log", "-1", "--format=%B", &hash, "--"]);
    if !body.ok {
        return Ok(ShowResult {
            ok: false,
            body: None,
            stat: None,
            diff: None,
            error: Some(err_detail(&body)),
        });
    }
    let stat = run_git(
        &cwd,
        &["show", "--stat", "--format=", "--no-color", &hash, "--"],
    );
    if !stat.ok {
        return Ok(ShowResult {
            ok: false,
            body: None,
            stat: None,
            diff: None,
            error: Some(err_detail(&stat)),
        });
    }
    let (diff, _) = run_git_capped(
        &cwd,
        &[
            "show",
            "--patch",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            &hash,
            "--",
        ],
        WORKTREE_DIFF_CAP,
        WORKTREE_DIFF_TIMEOUT_SECS,
    );
    if !diff.ok {
        return Ok(ShowResult {
            ok: false,
            body: None,
            stat: None,
            diff: None,
            error: Some(err_detail(&diff)),
        });
    }
    Ok(ShowResult {
        ok: true,
        body: Some(body.out.trim().to_string()),
        stat: Some(stat.out.trim().to_string()),
        diff: Some(diff.out.trim().to_string()),
        error: None,
    })
}

/// git:conflict-files — conflicted files (diff-filter=U).
#[tauri::command]
pub async fn git_conflict_files(cwd: String) -> Result<ConflictFilesResult, String> {
    let r = run_git(&cwd, &["diff", "--name-only", "-z", "--diff-filter=U"]);
    if !r.ok {
        return Ok(ConflictFilesResult {
            ok: false,
            files: vec![],
            error: Some(err_detail(&r)),
        });
    }
    // `-z`: names with spaces or non-ASCII bytes are not quoted.
    let files = split_z(&r.out);
    Ok(ConflictFilesResult {
        ok: true,
        files,
        error: None,
    })
}

/// git:resolve-conflict — conflict resolution via AI provider.
#[tauri::command]
pub async fn git_resolve_conflict(
    app: tauri::AppHandle,
    cwd: String,
    file_path: String,
    provider: String,
) -> Result<OkResult, String> {
    // The AI output is written back to this path: it must stay inside the repo.
    let full_path = match contained_path(&cwd, &file_path) {
        Ok(p) => p,
        Err(e) => {
            return Ok(OkResult {
                ok: false,
                error: Some(e),
            })
        }
    };
    let content = match read_text_capped(&full_path, FILE_AT_HEAD_MAX_BYTES as u64) {
        Ok(c) => c,
        Err(e) => {
            return Ok(OkResult {
                ok: false,
                error: Some(e),
            })
        }
    };

    if !content.contains("<<<<<<<") && !content.contains(">>>>>>>") {
        return Ok(OkResult {
            ok: false,
            error: Some("No conflict markers found in this file".to_string()),
        });
    }

    let snippet: String = content.chars().take(12000).collect();
    let prompt = format!(
        "This file has git merge conflicts. Resolve ALL conflicts by choosing the best combination of both sides. Return ONLY the resolved file content, no explanation, no markdown code blocks, no backticks. Preserve the original formatting and indentation exactly.\n\nFile: {file_path}\n\n{snippet}"
    );

    // AI call — spawn_provider() shell pipeline.
    let resolved = match spawn_provider(&provider, &prompt, &cwd) {
        Ok(r) => r,
        Err(e) => {
            return Ok(OkResult {
                ok: false,
                error: Some(e),
            })
        }
    };
    let cleaned = resolved.trim();

    if cleaned.contains("<<<<<<<") || cleaned.contains(">>>>>>>") {
        return Ok(OkResult {
            ok: false,
            error: Some("AI output still contains conflict markers".to_string()),
        });
    }

    if let Err(e) = std::fs::write(&full_path, cleaned) {
        return Ok(OkResult {
            ok: false,
            error: Some(e.to_string()),
        });
    }
    let staged = run_git(&cwd, &["add", "--", &file_path]);
    if !staged.ok {
        return Ok(OkResult {
            ok: false,
            error: Some(err_detail(&staged)),
        });
    }

    // creditAiPrompt: successful AI utility call → ranking.
    crate::commands::session::credit_ai_utility(&app, "git-resolve-conflict", None, Some(&cwd));
    Ok(OkResult {
        ok: true,
        error: None,
    })
}

/// Git settings that shape the AI commit message / branch name (sent by the
/// git panel; every field optional so older callers keep working).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiGitOptions {
    /// "conventional" (default) | "plain".
    pub convention: Option<String>,
    /// "auto" (default) | "en" | "it".
    pub language: Option<String>,
    /// Free-form extra instructions from the settings.
    pub instructions: Option<String>,
    /// Branch naming: "simple" (default) | "gitflow".
    pub style: Option<String>,
}

impl AiGitOptions {
    fn language_instruction(&self) -> &'static str {
        match self.language.as_deref() {
            Some("en") => " Write it in English.",
            Some("it") => " Write it in Italian.",
            _ => "",
        }
    }

    fn extra_instructions(&self) -> String {
        let text: String = self
            .instructions
            .as_deref()
            .unwrap_or("")
            .trim()
            .chars()
            .take(1000)
            .collect();
        if text.is_empty() {
            String::new()
        } else {
            format!(" Additional instructions from the user: {text}")
        }
    }
}

/// git:generate-branch-name — generates a branch name via AI provider.
#[tauri::command]
pub async fn git_generate_branch_name(
    app: tauri::AppHandle,
    cwd: String,
    provider: String,
    options: Option<AiGitOptions>,
) -> Result<GenBranchNameResult, String> {
    let options = options.unwrap_or_default();
    let mut diff = String::new();
    let (d, _) = run_git_capped(
        &cwd,
        &["diff", "--no-ext-diff"],
        WORKTREE_DIFF_CAP,
        WORKTREE_DIFF_TIMEOUT_SECS,
    );
    if d.ok {
        diff = d.out.trim().to_string();
    }
    if diff.is_empty() {
        let st = run_git(&cwd, &["status", "--porcelain", "-u"]);
        if st.ok {
            let status = st.out.trim_end();
            if !status.is_empty() {
                diff = format!("Changed files:\n{status}");
            }
        }
    }
    if diff.is_empty() {
        return Ok(GenBranchNameResult {
            ok: false,
            name: None,
            error: Some("No changes to generate branch name from".to_string()),
        });
    }

    let truncated = if diff.chars().count() > 4000 {
        let s: String = diff.chars().take(4000).collect();
        format!("{s}\n...(truncated)")
    } else {
        diff.clone()
    };
    let convention = if options.style.as_deref() == Some("gitflow") {
        "the git-flow convention \"prefix/short-description\" with prefix feature, bugfix, hotfix or release (e.g. feature/add-auth, bugfix/login-crash, hotfix/payment-timeout)"
    } else {
        "the convention \"type/short-description\" (e.g. feat/add-auth, fix/login-bug, refactor/cleanup-utils)"
    };
    let prompt = format!(
        "Based on these code changes, generate a git branch name following {convention}. Output ONLY the branch name on a single line. Do NOT add any preamble, acknowledgement, or sentences like \"I'll generate…\" or \"Here's…\". No quotes, no markdown, no explanation.{extra}\n\n{truncated}",
        extra = options.extra_instructions(),
    );

    // AI call — spawn_provider().
    match spawn_provider(&provider, &prompt, &cwd) {
        Ok(result) => match clean_branch_name(&result) {
            Some(name) => {
                crate::commands::session::credit_ai_utility(
                    &app,
                    "git-branch-name",
                    None,
                    Some(&cwd),
                );
                Ok(GenBranchNameResult {
                    ok: true,
                    name: Some(name),
                    error: None,
                })
            }
            None => Ok(GenBranchNameResult {
                ok: false,
                name: None,
                error: Some("Provider returned no usable branch name, please retry".to_string()),
            }),
        },
        Err(e) => Ok(GenBranchNameResult {
            ok: false,
            name: None,
            error: Some(e),
        }),
    }
}

/// git:generate-commit-msg — generates a commit message via AI provider (one-shot).
#[tauri::command]
pub async fn git_generate_commit_msg(
    app: tauri::AppHandle,
    cwd: String,
    provider: String,
    options: Option<AiGitOptions>,
) -> Result<GenCommitMsgResult, String> {
    let options = options.unwrap_or_default();
    let mut diff = String::new();
    let (cached, _) = run_git_capped(
        &cwd,
        &["diff", "--cached", "--no-ext-diff"],
        WORKTREE_DIFF_CAP,
        WORKTREE_DIFF_TIMEOUT_SECS,
    );
    if cached.ok {
        diff = cached.out.trim().to_string();
    }
    if diff.is_empty() {
        let (unstaged, _) = run_git_capped(
            &cwd,
            &["diff", "--no-ext-diff"],
            WORKTREE_DIFF_CAP,
            WORKTREE_DIFF_TIMEOUT_SECS,
        );
        if unstaged.ok {
            diff = unstaged.out.trim().to_string();
        }
    }
    if diff.is_empty() {
        let st = run_git(&cwd, &["status", "--porcelain", "-u"]);
        if st.ok {
            let status = st.out.trim();
            if !status.is_empty() {
                diff = format!("New/untracked files:\n{status}");
            }
        }
    }
    if diff.is_empty() {
        return Ok(GenCommitMsgResult {
            ok: false,
            message: None,
            error: Some("No changes detected to generate a commit message from".to_string()),
        });
    }

    let max_diff_len = 6000;
    let truncated_diff = if diff.chars().count() > max_diff_len {
        let s: String = diff.chars().take(max_diff_len).collect();
        format!("{s}\n\n... (diff truncated)")
    } else {
        diff.clone()
    };
    let style = if options.convention.as_deref() == Some("plain") {
        "a concise, plain git commit message (imperative mood, no \"type:\" prefix"
    } else {
        "a concise, conventional git commit message (Conventional Commits \"type(scope): subject\""
    };
    let prompt = format!(
        "Generate {style}, one line, max 72 characters) for these changes.{language} Output ONLY the commit message on a single line. Do NOT add any preamble, acknowledgement, or sentences like \"I'll generate…\" or \"Here's…\". No quotes, no markdown, no code fences, no prefix.{extra}\n\n{truncated_diff}",
        language = options.language_instruction(),
        extra = options.extra_instructions(),
    );

    // AI call — spawn_provider().
    match spawn_provider(&provider, &prompt, &cwd) {
        Ok(message) => match clean_commit_message(&message) {
            Some(cleaned) => {
                crate::commands::session::credit_ai_utility(
                    &app,
                    "git-commit-message",
                    None,
                    Some(&cwd),
                );
                Ok(GenCommitMsgResult {
                    ok: true,
                    message: Some(cleaned),
                    error: None,
                })
            }
            None => Ok(GenCommitMsgResult {
                ok: false,
                message: None,
                error: Some("Provider returned no usable commit message, please retry".to_string()),
            }),
        },
        Err(e) => Ok(GenCommitMsgResult {
            ok: false,
            message: None,
            error: Some(e),
        }),
    }
}

/// git:discover-repos — git repos in the immediate subfolders.
#[tauri::command]
pub async fn git_discover_repos(cwd: String) -> Result<DiscoverReposResult, String> {
    let entries = match std::fs::read_dir(&cwd) {
        Ok(e) => e,
        Err(e) => {
            return Ok(DiscoverReposResult {
                ok: false,
                repos: vec![],
                error: Some(e.to_string()),
            })
        }
    };

    let mut repos = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir || name.starts_with('.') {
            continue;
        }
        let sub_path = Path::new(&cwd).join(&name);
        let git_dir = sub_path.join(".git");
        // statSync(gitDir).isDirectory()
        if git_dir.is_dir() {
            let sub_str = sub_path.to_string_lossy().to_string();
            let branch = get_branch(&sub_str);
            repos.push(DiscoverRepo {
                name,
                path: sub_str,
                branch,
            });
        }
    }

    Ok(DiscoverReposResult {
        ok: true,
        repos,
        error: None,
    })
}

/// git:clone — via login shell, long timeout.
#[tauri::command]
pub async fn git_clone(
    url: String,
    destination: String,
    branch: Option<String>,
) -> Result<CloneResult, String> {
    // A "URL" like `--upload-pack=touch /tmp/x` used to be quoted for the shell
    // but still parsed by git as an option (command execution); and on
    // Windows the POSIX quoting did not protect PowerShell at all.
    let url = url.trim().to_string();
    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    let checks = validate_ref_arg(&url, "repository URL")
        .and_then(|_| match &branch {
            Some(b) => validate_ref_arg(b, "branch"),
            None => Ok(()),
        })
        .and_then(|_| {
            if destination.trim().is_empty() {
                Err("Empty destination".to_string())
            } else {
                Ok(())
            }
        });
    if let Err(e) = checks {
        return Ok(CloneResult {
            ok: false,
            output: None,
            path: None,
            error: Some(e),
        });
    }
    let mut args: Vec<&str> = vec!["clone"];
    if let Some(b) = &branch {
        args.push("--branch");
        args.push(b);
    }
    args.push("--");
    args.push(&url);
    args.push(&destination);

    // cwd = process.cwd()
    let proc_cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    match spawn_shell_git(&args, &proc_cwd, 900) {
        Ok(out) => {
            let trimmed = out.trim();
            Ok(CloneResult {
                ok: true,
                output: Some(if trimmed.is_empty() {
                    "Clone completed".to_string()
                } else {
                    trimmed.to_string()
                }),
                path: Some(destination),
                error: None,
            })
        }
        Err(e) => Ok(CloneResult {
            ok: false,
            output: None,
            path: None,
            error: Some(e),
        }),
    }
}

/// git:merge — merges one or more source branches into a target.
/// Strategies: default | no-ff | squash | ff-only.
#[tauri::command]
pub async fn git_merge(
    cwd: String,
    sources: Vec<String>,
    target: String,
    strategy: Option<String>,
    message: Option<String>,
    // Tauri 2 automatically maps the camelCase JS key `autoStash` -> `auto_stash`.
    auto_stash: Option<bool>,
) -> Result<MergeResult, String> {
    let mut results: Vec<MergeSourceResult> = Vec::new();
    let strat = strategy.unwrap_or_else(|| "default".to_string());
    let auto_stash = auto_stash.unwrap_or(false);
    let mut stashed = false;

    if sources.is_empty() {
        return Ok(MergeResult {
            ok: false,
            error: Some("No source branches provided".to_string()),
            results,
            ..Default::default()
        });
    }
    if target.is_empty() {
        return Ok(MergeResult {
            ok: false,
            error: Some("No target branch provided".to_string()),
            results,
            ..Default::default()
        });
    }
    let invalid = std::iter::once(&target)
        .chain(sources.iter())
        .find_map(|name| validate_ref_arg(name, "branch").err());
    if let Some(e) = invalid {
        return Ok(MergeResult {
            ok: false,
            error: Some(e),
            results,
            ..Default::default()
        });
    }

    // Pre-flight: clean working tree (or auto-stash).
    let dirty_run = run_git(&cwd, &["status", "--porcelain"]);
    let dirty = dirty_run.out.trim();
    if !dirty.is_empty() {
        if auto_stash {
            let label = format!("promptops-merge-{}", now_millis());
            let s = run_git(&cwd, &["stash", "push", "-u", "-m", &label]);
            if !s.ok {
                return Ok(MergeResult {
                    ok: false,
                    error: Some(format!("Auto-stash failed: {}", err_detail(&s))),
                    results,
                    ..Default::default()
                });
            }
            stashed = true;
        } else {
            return Ok(MergeResult {
                ok: false,
                dirty: Some(true),
                error: Some(
                    "Working tree has uncommitted changes. Commit, stash, or enable auto-stash before merging."
                        .to_string(),
                ),
                results,
                ..Default::default()
            });
        }
    }

    // Check out the target if not already active.
    let current_branch = get_branch(&cwd);
    if current_branch != target {
        let co = run_git(&cwd, &["checkout", &target, "--"]);
        if !co.ok {
            let detail = err_detail(&co);
            if stashed {
                try_stash_pop(&cwd);
            }
            return Ok(MergeResult {
                ok: false,
                error: Some(format!("Checkout target failed: {detail}")),
                results,
                ..Default::default()
            });
        }
    }

    // Sequential merge; stop at the first conflict.
    for src in &sources {
        let mut args: Vec<String> = vec!["merge".to_string()];
        match strat.as_str() {
            "no-ff" => args.push("--no-ff".to_string()),
            "squash" => args.push("--squash".to_string()),
            "ff-only" => args.push("--ff-only".to_string()),
            _ => {}
        }
        if let Some(m) = &message {
            if strat != "squash" && strat != "ff-only" {
                args.push("-m".to_string());
                args.push(m.clone());
            }
        }
        args.push(src.clone());
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let merged = run_git(&cwd, &arg_refs);
        if merged.ok {
            // Squash leaves the changes staged but not committed → commit.
            if strat == "squash" {
                let commit_msg = message
                    .as_ref()
                    .map(|m| m.trim().to_string())
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| format!("Squash merge {src} into {target}"));
                let committed = run_git(&cwd, &["commit", "-m", &commit_msg]);
                if !committed.ok {
                    let detail = err_detail(&committed);
                    results.push(MergeSourceResult {
                        source: src.clone(),
                        ok: false,
                        output: None,
                        error: Some(format!("Squash commit failed: {detail}")),
                        conflict: None,
                    });
                    if stashed {
                        try_stash_pop(&cwd);
                    }
                    return Ok(MergeResult {
                        ok: false,
                        error: Some(detail),
                        results,
                        stash_restored: Some(stashed),
                        ..Default::default()
                    });
                }
            }
            results.push(MergeSourceResult {
                source: src.clone(),
                ok: true,
                output: Some(merged.out.trim().to_string()),
                error: None,
                conflict: None,
            });
        } else {
            let stderr = merged.err.trim();
            let stdout = merged.out.trim();
            let detail = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else {
                "merge failed".to_string()
            };
            let detail_lower = detail.to_lowercase();
            let conflict_detected = detail_lower.contains("conflict")
                || stdout.to_lowercase().contains("merge conflict")
                || has_unmerged_files(&cwd);

            results.push(MergeSourceResult {
                source: src.clone(),
                ok: false,
                output: None,
                error: Some(detail.clone()),
                conflict: Some(conflict_detected),
            });

            // Do not pop the stash on conflict.
            return Ok(MergeResult {
                ok: false,
                error: Some(detail),
                conflict: Some(conflict_detected),
                results,
                stash_restored: Some(false),
                stashed: Some(stashed),
                ..Default::default()
            });
        }
    }

    // All merges ok — restore the stash if present.
    if stashed {
        let pop_ok = try_stash_pop(&cwd);
        return Ok(MergeResult {
            ok: true,
            results,
            stash_restored: Some(pop_ok),
            ..Default::default()
        });
    }
    Ok(MergeResult {
        ok: true,
        results,
        ..Default::default()
    })
}

/// git:merge-abort
#[tauri::command]
pub async fn git_merge_abort(cwd: String) -> Result<OkOutput, String> {
    let r = run_git(&cwd, &["merge", "--abort"]);
    if r.ok {
        let out = r.out.trim();
        Ok(OkOutput {
            ok: true,
            output: Some(if out.is_empty() {
                "Merge aborted".to_string()
            } else {
                out.to_string()
            }),
            error: None,
        })
    } else {
        Ok(OkOutput {
            ok: false,
            output: None,
            error: Some(err_detail(&r)),
        })
    }
}

/// git:ai-resolve-sync — "safe-only" resolver: cleans up state, syncs,
/// repairs pull/push. Never reset, never force-push, never history rewriting.
///
/// `auto = true` is the mode launched ON ITS OWN after a failed pull/push:
/// it only does operations that cannot lose work (clean merge, upstream,
/// stale lock, already-resolved merge to conclude). Anything that requires
/// a choice — content conflicts, half-done rebase/cherry-pick — stops it,
/// restores the repo as it was and returns the error.
///
/// The wrapper credits the AI feature to the ranking on success (creditAiPrompt
/// 'git-resolve-conflict').
#[tauri::command]
pub async fn git_ai_resolve_sync(
    app: tauri::AppHandle,
    cwd: String,
    operation: String,
    provider: String,
    last_error: Option<String>,
    auto: Option<bool>,
) -> Result<AiResolveSyncResult, String> {
    let result = Resolver::new(cwd.clone(), provider, auto.unwrap_or(false))
        .run(&operation, last_error.as_deref());
    if matches!(&result, Ok(r) if r.ok) {
        crate::commands::session::credit_ai_utility(&app, "git-resolve-conflict", None, Some(&cwd));
    }
    result
}

/// Backup of uncommitted work made by the resolver.
struct ResolverStash {
    sha: String,
    label: String,
}

struct Resolver {
    cwd: String,
    provider: String,
    auto: bool,
    steps: Vec<String>,
    stash: Option<ResolverStash>,
    backup_ref: Option<String>,
}

/// How many `refs/promptops/backup/*` safety points to keep per repo.
const RESOLVER_BACKUPS_KEEP: usize = 20;
/// An `index.lock` older than this belongs to a dead git (crash/kill).
const STALE_LOCK_SECS: u64 = 120;

impl Resolver {
    fn new(cwd: String, provider: String, auto: bool) -> Self {
        Self {
            cwd,
            provider,
            auto,
            steps: Vec::new(),
            stash: None,
            backup_ref: None,
        }
    }

    fn log(&mut self, s: impl Into<String>) {
        self.steps.push(s.into());
    }

    fn git(&self, args: &[&str]) -> GitRun {
        try_git(&self.cwd, args)
    }

    fn done(
        self,
        ok: bool,
        error: Option<String>,
        partial: Option<bool>,
    ) -> Result<AiResolveSyncResult, String> {
        Ok(AiResolveSyncResult {
            ok,
            steps: self.steps,
            error,
            partial,
        })
    }

    /// Stop: puts stashed work back (if safe) and returns the error.
    fn fail(mut self, msg: impl Into<String>) -> Result<AiResolveSyncResult, String> {
        let mut msg = msg.into();
        if let Err(e) = self.restore_stash() {
            msg = format!("{msg}\n{e}");
        }
        if let Some(b) = self.backup_ref.clone() {
            self.log(format!("Nothing was lost — safety point: {b}"));
        }
        self.done(false, Some(msg), None)
    }

    fn unmerged_files(&self) -> Vec<String> {
        // `-z` and untrimmed output: the names are used as paths on disk.
        split_z(&run_git(&self.cwd, &["diff", "--name-only", "-z", "--diff-filter=U"]).out)
    }

    fn git_dir(&self) -> Option<std::path::PathBuf> {
        let r = self.git(&["rev-parse", "--absolute-git-dir"]);
        if r.ok && !r.out.is_empty() {
            Some(std::path::PathBuf::from(r.out))
        } else {
            None
        }
    }

    fn merge_in_progress(&self) -> bool {
        self.git_dir()
            .map(|d| d.join("MERGE_HEAD").exists())
            .unwrap_or(false)
    }

    fn short_list(files: &[String]) -> String {
        let mut s = files.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        if files.len() > 5 {
            s.push_str(&format!(" (+{} more)", files.len() - 5));
        }
        s
    }

    fn run(
        mut self,
        operation: &str,
        last_error: Option<&str>,
    ) -> Result<AiResolveSyncResult, String> {
        if let Some(le) = last_error {
            let first: String = le.lines().next().unwrap_or("").chars().take(200).collect();
            self.log(format!("Detected error: {first}"));
        }
        if self.auto {
            self.log("Automatic safe mode: stops at anything that needs a decision.");
        }

        let branch = get_branch(&self.cwd);
        if branch.is_empty() || branch == "unknown" || branch == "HEAD" {
            return self.fail(
                "Cannot detect current branch (detached HEAD?). Refusing to act for safety.",
            );
        }
        self.log(format!("Current branch: {branch}"));
        if !self.git(&["remote", "get-url", "origin"]).ok {
            return self.fail("No \"origin\" remote configured. Open Git Setup first.");
        }

        // 1. clean up state left by interrupted operations
        if let Err(e) = self.clean_leftovers() {
            return self.fail(e);
        }

        // 2. safety point: a ref pointing at the current HEAD, to go back
        self.save_backup_ref();

        // 3. fetch — without fresh data nothing can be decided
        self.log("Fetching from origin…");
        if let Err(e) = spawn_shell_cmd("git fetch --prune origin", &self.cwd) {
            let first = e.lines().next().unwrap_or("").to_string();
            return self.fail(format!("Fetch failed: {first}"));
        }
        self.log("Fetch ok.");

        // 4. upstream
        let has_upstream = self.ensure_upstream(&branch);

        let want_push = operation == "push" || operation == "auto";
        let want_pull = operation == "pull" || operation == "auto" || want_push;

        // 5. integrate origin (if there are new commits: typically a CI auto bump)
        if want_pull && has_upstream {
            if let Err(e) = self.integrate_upstream() {
                return self.fail(e);
            }
        } else if want_pull {
            self.log("No remote branch yet — nothing to pull.");
        }

        // 6. push, with a second round if the remote moved ahead in the meantime
        if want_push {
            if let Err(e) = self.push(&branch, has_upstream) {
                return self.fail(e);
            }
        }

        // 7. restore uncommitted work
        let restore = self.restore_stash();

        // 8. final check: no half-done merge, no conflicts
        if !self.unmerged_files().is_empty() {
            let files = self.unmerged_files();
            return self.done(
                false,
                Some(format!(
                    "Conflicts still present in: {}",
                    Self::short_list(&files)
                )),
                None,
            );
        }
        if let Err(e) = restore {
            return self.done(true, Some(e), Some(true));
        }
        self.log("Repository clean and in sync.");
        self.done(true, None, None)
    }

    /// Stale locks, half-done merge/rebase/cherry-pick.
    fn clean_leftovers(&mut self) -> Result<(), String> {
        let Some(git_dir) = self.git_dir() else {
            return Err("Not a git repository.".into());
        };

        let lock = git_dir.join("index.lock");
        if lock.exists() {
            let age = std::fs::metadata(&lock)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if age < STALE_LOCK_SECS {
                return Err("Another git operation is running (.git/index.lock is recent). Wait a moment and retry.".into());
            }
            std::fs::remove_file(&lock)
                .map_err(|e| format!("Cannot remove stale index.lock: {e}"))?;
            self.log(format!(
                "Removed stale .git/index.lock left by an interrupted git ({age}s old)."
            ));
        }

        if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
            if self.auto {
                return Err("A rebase is in progress. Nothing was touched — finish it or abort it (git rebase --abort) first.".into());
            }
            let r = self.git(&["rebase", "--abort"]);
            if !r.ok {
                return Err(format!(
                    "A rebase is in progress and could not be aborted: {}",
                    r.err
                ));
            }
            self.log("Aborted an unfinished rebase (branch restored to its pre-rebase state).");
        }

        for (head, what) in [
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
        ] {
            if git_dir.join(head).exists() {
                return Err(format!(
                    "A {what} is in progress. Nothing was touched — finish it or run git {what} --abort first."
                ));
            }
        }

        if git_dir.join("MERGE_HEAD").exists() {
            let files = self.unmerged_files();
            if !files.is_empty() {
                if self.auto {
                    return Err(format!(
                        "A merge is in progress with conflicts in: {}. Nothing was touched — run the AI Resolver to resolve them.",
                        Self::short_list(&files)
                    ));
                }
                self.log("Unfinished merge with conflicts found.");
                self.resolve_conflicts_via_ai()?;
            }
            let c = self.git(&["commit", "--no-edit"]);
            if !c.ok {
                return Err(format!(
                    "Could not conclude the unfinished merge: {}",
                    c.err
                ));
            }
            self.log("Concluded a merge that was left half-finished.");
        }
        Ok(())
    }

    fn save_backup_ref(&mut self) {
        let head = self.git(&["rev-parse", "HEAD"]);
        if !head.ok {
            return;
        }
        let name = format!("refs/promptops/backup/{}", now_millis());
        if self.git(&["update-ref", &name, &head.out]).ok {
            let short: String = head.out.chars().take(8).collect();
            self.log(format!("Safety point saved at {short} ({name})."));
            self.backup_ref = Some(name);
        }
        // Keep only the last N.
        let list = self.git(&[
            "for-each-ref",
            "--sort=-refname",
            "--format=%(refname)",
            "refs/promptops/backup/",
        ]);
        for old in list.out.lines().skip(RESOLVER_BACKUPS_KEEP) {
            self.git(&["update-ref", "-d", old]);
        }
    }

    /// true if the branch has (or just got) an upstream.
    fn ensure_upstream(&mut self, branch: &str) -> bool {
        if self
            .git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .ok
        {
            return true;
        }
        if !is_safe_branch_chars(branch) {
            return false;
        }
        let remote_ref = format!("refs/remotes/origin/{branch}");
        if self.git(&["rev-parse", "--verify", &remote_ref]).ok {
            self.log(format!("Linking upstream to origin/{branch}."));
            return self
                .git(&[
                    "branch",
                    &format!("--set-upstream-to=origin/{branch}"),
                    branch,
                ])
                .ok;
        }
        false
    }

    /// Upstream commits we do not have locally.
    fn behind_count(&self) -> u64 {
        self.git(&["rev-list", "--count", "HEAD..@{u}"])
            .out
            .parse()
            .unwrap_or(0)
    }

    fn ahead_count(&self) -> u64 {
        self.git(&["rev-list", "--count", "@{u}..HEAD"])
            .out
            .parse()
            .unwrap_or(0)
    }

    fn is_dirty(&self) -> bool {
        !self.git(&["status", "--porcelain"]).out.is_empty()
    }

    /// Merge of @{u} into the current branch. Stashes ONLY if git refuses because
    /// of modified local files (most merges do not need it).
    fn integrate_upstream(&mut self) -> Result<(), String> {
        let behind = self.behind_count();
        if behind == 0 {
            self.log("Already up to date with origin.");
            return Ok(());
        }
        self.log(format!(
            "{behind} new commit(s) on origin — merging (no rebase)…"
        ));

        let mut r = self.git(&["merge", "--no-edit", "@{u}"]);
        if !r.ok && self.stash.is_none() && self.is_dirty() && !self.merge_in_progress() {
            let lower = r.err.to_lowercase();
            if lower.contains("would be overwritten")
                || lower.contains("commit your changes or stash")
            {
                self.stash_local_changes()?;
                r = self.git(&["merge", "--no-edit", "@{u}"]);
            }
        }
        if r.ok {
            self.log("Merge ok.");
            return Ok(());
        }

        let files = self.unmerged_files();
        if files.is_empty() {
            if self.merge_in_progress() {
                self.git(&["merge", "--abort"]);
            }
            return Err(format!("Merge failed: {}", r.err));
        }
        if self.auto {
            self.git(&["merge", "--abort"]);
            self.log("Merge aborted — tree is back as it was.");
            return Err(format!(
                "Conflicts with origin in {} file(s): {}. Stopped for safety — run the AI Resolver to resolve them.",
                files.len(),
                Self::short_list(&files)
            ));
        }
        self.log("Merge conflicts detected — invoking AI resolver…");
        if let Err(e) = self.resolve_conflicts_via_ai() {
            self.git(&["merge", "--abort"]);
            self.log("Merge aborted to keep tree clean.");
            return Err(e);
        }
        let c = self.git(&["commit", "--no-edit"]);
        if !c.ok && !c.err.to_lowercase().contains("nothing to commit") {
            let fb = self.git(&["commit", "-m", "Merge branch via PromptOps AI Resolver"]);
            if !fb.ok {
                self.git(&["merge", "--abort"]);
                return Err(format!("Merge commit failed: {}", fb.err));
            }
        }
        self.log("Merge committed.");
        Ok(())
    }

    fn push(&mut self, branch: &str, has_upstream: bool) -> Result<(), String> {
        if has_upstream && self.ahead_count() == 0 {
            self.log("Nothing to push — origin already has everything.");
            return Ok(());
        }
        for attempt in 0..2 {
            let args: Vec<&str> = if has_upstream {
                vec!["push"]
            } else if is_safe_branch_chars(branch) {
                self.log(format!(
                    "Creating the remote branch: push -u origin {branch}…"
                ));
                vec!["push", "-u", "origin", branch]
            } else {
                return Err(format!(
                    "Branch name \"{branch}\" is not safe to auto-push."
                ));
            };
            if attempt == 0 {
                self.log("Pushing to origin…");
            }
            match spawn_shell_git(&args, &self.cwd, NETWORK_TIMEOUT_SECS) {
                Ok(out) => {
                    let last: String = out
                        .lines()
                        .rfind(|l| !l.is_empty())
                        .unwrap_or("done")
                        .chars()
                        .take(120)
                        .collect();
                    self.log(format!("Push ok: {last}"));
                    return Ok(());
                }
                Err(e) => {
                    let m = e.to_lowercase();
                    let moved = m.contains("non-fast-forward")
                        || m.contains("fetch first")
                        || m.contains("rejected");
                    if !moved || attempt == 1 || !has_upstream {
                        return Err(format!("Push failed: {e}. Refusing force-push for safety."));
                    }
                    self.log("Origin moved meanwhile — fetching and merging again…");
                    spawn_shell_cmd("git fetch --prune origin", &self.cwd)
                        .map_err(|e| format!("Fetch failed: {e}"))?;
                    self.integrate_upstream()?;
                }
            }
        }
        Ok(())
    }

    /// `git stash push -u` with a label; stores the exact SHA so the
    /// restore never touches someone else's stash.
    fn stash_local_changes(&mut self) -> Result<(), String> {
        let label = format!("promptops-ai-resolver-{}", now_millis());
        self.log(
            "Local changes block the merge — backing them up in a stash (includes untracked).",
        );
        let r = self.git(&["stash", "push", "-u", "-m", &label]);
        if !r.ok {
            return Err(format!(
                "Auto-stash failed: {}",
                if r.err.is_empty() { "unknown" } else { &r.err }
            ));
        }
        let list = self.git(&["stash", "list", "--format=%H%x09%gs"]);
        let sha = list
            .out
            .lines()
            .find(|l| l.contains(&label))
            .and_then(|l| l.split('\t').next())
            .map(|s| s.to_string());
        match sha {
            Some(sha) => {
                self.stash = Some(ResolverStash { sha, label });
                Ok(())
            }
            None => Err("Auto-stash did not produce a stash entry — stopping for safety.".into()),
        }
    }

    /// Reapplies the stash ONLY if it cannot conflict: if the stashed
    /// files were also touched by the merge, the stash stays intact and
    /// we say so clearly (work never ends up under conflict markers).
    fn restore_stash(&mut self) -> Result<(), String> {
        let Some(st) = self.stash.take() else {
            return Ok(());
        };
        let mut stashed: std::collections::BTreeSet<String> = self
            .git(&["diff", "--name-only", &format!("{}^1", st.sha), &st.sha])
            .out
            .lines()
            .map(|s| s.to_string())
            .collect();
        let untracked = self.git(&["ls-tree", "-r", "--name-only", &format!("{}^3", st.sha)]);
        if untracked.ok {
            stashed.extend(untracked.out.lines().map(|s| s.to_string()));
        }
        let changed: std::collections::BTreeSet<String> = self
            .git(&["diff", "--name-only", &format!("{}^1", st.sha), "HEAD"])
            .out
            .lines()
            .map(|s| s.to_string())
            .collect();
        let overlap: Vec<String> = stashed.intersection(&changed).cloned().collect();
        if !overlap.is_empty() {
            return Err(format!(
                "Synced. Your uncommitted changes touch files that also changed on origin ({}), so they were NOT re-applied automatically: they're safe in stash \"{}\" (git stash list → git stash apply).",
                Self::short_list(&overlap),
                st.label
            ));
        }
        self.log("Restoring your uncommitted changes…");
        let mut r = self.git(&["stash", "apply", "--index", &st.sha]);
        if !r.ok && !self.is_dirty() {
            r = self.git(&["stash", "apply", &st.sha]);
        }
        if !r.ok {
            return Err(format!(
                "Could not re-apply your changes ({}). They're safe in stash \"{}\".",
                r.err, st.label
            ));
        }
        let list = self.git(&["stash", "list", "--format=%gd%x09%H"]);
        if let Some(entry) = list
            .out
            .lines()
            .find(|l| l.ends_with(&st.sha))
            .and_then(|l| l.split('\t').next())
        {
            self.git(&["stash", "drop", entry]);
        }
        self.log("Changes restored.");
        Ok(())
    }

    /// AI-resolve of all conflicts + stage. Never in auto mode.
    fn resolve_conflicts_via_ai(&mut self) -> Result<(), String> {
        if self.auto {
            return Err("Conflicts need a decision — stopped (automatic mode never edits conflicted files).".into());
        }
        let files = self.unmerged_files();
        if files.is_empty() {
            return Ok(());
        }
        self.log(format!("AI resolving {} conflicted file(s)…", files.len()));
        for f in files {
            let full =
                contained_path(&self.cwd, &f).map_err(|e| format!("Failed to resolve {f}: {e}"))?;
            let content = read_text_capped(&full, FILE_AT_HEAD_MAX_BYTES as u64)
                .map_err(|e| format!("Failed to resolve {f}: {e}"))?;
            if !content.contains("<<<<<<<") {
                self.git(&["add", "--", &f]);
                continue;
            }
            // The provider only sees the first 12k characters: on larger files
            // its answer would be a truncated file → never write it.
            if content.chars().count() > 12000 {
                return Err(format!(
                    "{f} is too large to resolve safely with AI — resolve it manually."
                ));
            }
            let snippet = content.as_str();
            let prompt = format!(
                "This file has git merge conflicts. Resolve ALL conflicts by choosing the safest combination of both sides — preserve all functionality from both branches when possible, never delete logic blindly. Return ONLY the resolved file content, no explanation, no markdown code blocks, no backticks. Preserve formatting and indentation exactly.\n\nFile: {f}\n\n{snippet}"
            );
            let resolved = spawn_provider(&self.provider, &prompt, &self.cwd)
                .map_err(|e| format!("Failed to resolve {f}: {e}"))?;
            let cleaned = resolved.trim();
            if cleaned.is_empty() {
                return Err(format!(
                    "AI returned an empty file for {f} — aborting for safety."
                ));
            }
            if cleaned.contains("<<<<<<<") || cleaned.contains(">>>>>>>") {
                return Err(format!(
                    "AI output for {f} still contains conflict markers — aborting for safety."
                ));
            }
            let mut body = cleaned.to_string();
            if content.ends_with('\n') {
                body.push('\n');
            }
            std::fs::write(&full, body).map_err(|e| format!("Failed to resolve {f}: {e}"))?;
            self.git(&["add", "--", &f]);
            self.log(format!("Resolved: {f}"));
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// util
// ─────────────────────────────────────────────────────────────────────────────

/// `Date.now()` equivalent (millis since the epoch).
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Git Explorer — the 12 advanced handlers (cherry-pick, revert, rebase,
// reset, delete/rename branch,
// amend, fetch, ahead/behind, tag, remote-url, show-file-base64).
// ─────────────────────────────────────────────────────────────────────────────

use serde_json::{json, Value as JsonValue};

/// getBranch — current branch or "unknown".
fn current_branch(cwd: &str) -> String {
    let r = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    if r.ok {
        r.out.trim().to_string()
    } else {
        "unknown".into()
    }
}

/// isDirtyTree — working tree with changes (staged or not).
fn is_dirty_tree(cwd: &str) -> bool {
    let r = run_git(cwd, &["status", "--porcelain"]);
    r.ok && !r.out.trim().is_empty()
}

/// normalizeRemoteUrl — browsable https URL from a remote (https or scp-ssh).
fn normalize_remote_url(raw: &str) -> Option<String> {
    use regex::Regex;
    use std::sync::OnceLock;
    static HTTP_RE: OnceLock<Regex> = OnceLock::new();
    static SSH_RE: OnceLock<Regex> = OnceLock::new();
    let url = raw.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let http = HTTP_RE.get_or_init(|| Regex::new(r"^https?://(?:[^@/]+@)?([^/]+)/(.+)$").unwrap());
    if let Some(m) = http.captures(url) {
        return Some(format!("https://{}/{}", &m[1], &m[2]));
    }
    let ssh =
        SSH_RE.get_or_init(|| Regex::new(r"^(?:ssh://)?(?:[^@/]+@)?([\w.-]+)[:/](.+)$").unwrap());
    ssh.captures(url)
        .map(|m| format!("https://{}/{}", &m[1], &m[2]))
}

/// Shared cherry-pick/revert logic: dirty-tree guard, execution, abort on
/// conflict (the repo goes back to clean, the UI can suggest a merge).
fn pick_like(cwd: &str, args: &[&str], abort_args: &[&str]) -> JsonValue {
    if is_dirty_tree(cwd) {
        return json!({
            "ok": false,
            "dirty": true,
            "error": "Working tree has uncommitted changes. Commit or stash before continuing.",
        });
    }
    let r = run_git(cwd, args);
    if r.ok {
        return json!({ "ok": true, "output": r.out.trim() });
    }
    let detail = err_detail(&r);
    let conflict = detail.to_lowercase().contains("conflict") || has_unmerged_files(cwd);
    if conflict {
        let _ = run_git(cwd, abort_args);
        return json!({ "ok": false, "conflict": true, "aborted": true, "error": detail });
    }
    json!({ "ok": false, "error": detail })
}

/// git:cherry-pick.
#[tauri::command]
pub async fn git_cherry_pick(cwd: String, hash: String) -> JsonValue {
    if let Err(e) = validate_ref_arg(&hash, "commit") {
        return json!({ "ok": false, "error": e });
    }
    pick_like(&cwd, &["cherry-pick", &hash], &["cherry-pick", "--abort"])
}

/// git:revert — creates a revert commit.
#[tauri::command]
pub async fn git_revert(cwd: String, hash: String) -> JsonValue {
    if let Err(e) = validate_ref_arg(&hash, "commit") {
        return json!({ "ok": false, "error": e });
    }
    pick_like(
        &cwd,
        &["revert", "--no-edit", &hash],
        &["revert", "--abort"],
    )
}

/// git:rebase — rebase of the current branch onto a ref. On ANY failure
/// it attempts the abort (the repo may stay mid-rebase).
#[tauri::command]
pub async fn git_rebase(cwd: String, onto: String) -> JsonValue {
    // `--exec=<cmd>` as "onto" ran a command for every rebased commit.
    if let Err(e) = validate_ref_arg(&onto, "branch") {
        return json!({ "ok": false, "error": e });
    }
    if is_dirty_tree(&cwd) {
        return json!({
            "ok": false,
            "dirty": true,
            "error": "Working tree has uncommitted changes. Commit or stash before rebasing.",
        });
    }
    let current = current_branch(&cwd);
    if current == "HEAD" || current == "unknown" {
        return json!({ "ok": false, "error": "Cannot rebase: not on a branch (detached HEAD)." });
    }
    let r = run_git(&cwd, &["rebase", &onto]);
    if r.ok {
        return json!({ "ok": true, "output": r.out.trim() });
    }
    let detail = err_detail(&r);
    let conflict = detail.to_lowercase().contains("conflict") || has_unmerged_files(&cwd);
    let _ = run_git(&cwd, &["rebase", "--abort"]);
    json!({ "ok": false, "conflict": conflict, "aborted": true, "error": detail })
}

/// git:reset — resets the current branch to a commit (soft/mixed/hard).
#[tauri::command]
pub async fn git_reset(cwd: String, hash: String, mode: Option<String>) -> JsonValue {
    let m = match mode.as_deref() {
        Some("soft") => "soft",
        Some("hard") => "hard",
        _ => "mixed",
    };
    if let Err(e) = validate_ref_arg(&hash, "commit") {
        return json!({ "ok": false, "error": e });
    }
    let current = current_branch(&cwd);
    if current == "HEAD" || current == "unknown" {
        return json!({ "ok": false, "error": "Cannot reset: not on a branch (detached HEAD)." });
    }
    let flag = format!("--{m}");
    let r = run_git(&cwd, &["reset", &flag, &hash, "--"]);
    if r.ok {
        json!({ "ok": true, "output": r.out.trim() })
    } else {
        json!({ "ok": false, "error": err_detail(&r) })
    }
}

/// git:delete-branch — local (-d/-D) or remote (push --delete via login shell).
#[tauri::command]
pub async fn git_delete_branch(
    cwd: String,
    branch: String,
    force: Option<bool>,
    remote: Option<bool>,
) -> JsonValue {
    let name = if remote.unwrap_or(false) {
        branch.strip_prefix("origin/").unwrap_or(&branch)
    } else {
        branch.as_str()
    };
    if let Err(e) = validate_ref_arg(name, "branch") {
        return json!({ "ok": false, "error": e });
    }
    if remote.unwrap_or(false) {
        // Remote delete needs the SSH agent → login shell like push. The name
        // comes from the remote: it travels as an argument, never as shell
        // text (the old POSIX quoting did not protect PowerShell).
        return match spawn_shell_git(
            &["push", "origin", "--delete", name],
            &cwd,
            NETWORK_TIMEOUT_SECS,
        ) {
            Ok(out) => json!({ "ok": true, "output": out.trim() }),
            Err(err) => json!({ "ok": false, "error": err }),
        };
    }
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    let r = run_git(&cwd, &["branch", flag, "--", &branch]);
    if r.ok {
        json!({ "ok": true, "output": r.out.trim() })
    } else {
        let detail = err_detail(&r);
        // "not fully merged" → the UI can offer escalation to -D.
        let not_merged = detail.to_lowercase().contains("not fully merged");
        json!({ "ok": false, "error": detail, "notMerged": not_merged })
    }
}

/// git:rename-branch.
#[tauri::command]
pub async fn git_rename_branch(cwd: String, branch: String, new_name: String) -> JsonValue {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return json!({ "ok": false, "error": "Empty branch name" });
    }
    if let Err(e) =
        validate_ref_arg(&branch, "branch").and(validate_ref_arg(trimmed, "branch name"))
    {
        return json!({ "ok": false, "error": e });
    }
    let r = run_git(&cwd, &["branch", "-m", "--", &branch, trimmed]);
    if r.ok {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": err_detail(&r) })
    }
}

/// git:commit-amend — guard: if the last commit is already on a remote, amend
/// rewrites published history → refuse (unless allowPushed).
#[tauri::command]
pub async fn git_commit_amend(
    cwd: String,
    message: String,
    allow_pushed: Option<bool>,
) -> JsonValue {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return json!({ "ok": false, "error": "Empty commit message" });
    }
    if !allow_pushed.unwrap_or(false) {
        let r = run_git(&cwd, &["branch", "-r", "--contains", "HEAD"]);
        if r.ok && !r.out.trim().is_empty() {
            return json!({
                "ok": false,
                "pushed": true,
                "error": "The last commit is already on a remote branch — amending rewrites published history.",
            });
        }
    }
    let r = run_git(&cwd, &["commit", "--amend", "-m", trimmed]);
    if r.ok {
        json!({ "ok": true, "output": r.out.trim() })
    } else {
        json!({ "ok": false, "error": err_detail(&r) })
    }
}

/// git:fetch — background sync (login shell for the SSH agent).
#[tauri::command]
pub async fn git_fetch(cwd: String) -> JsonValue {
    match spawn_shell_cmd("git fetch --prune", &cwd) {
        Ok(out) => json!({ "ok": true, "output": out.trim() }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

/// git:ahead-behind — counters vs upstream. No upstream = not an error.
#[tauri::command]
pub async fn git_ahead_behind(cwd: String) -> JsonValue {
    let up = run_git(
        &cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    if !up.ok {
        return json!({ "ok": false, "noUpstream": true, "error": err_detail(&up) });
    }
    let upstream = up.out.trim().to_string();
    let counts = run_git(
        &cwd,
        &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    );
    if !counts.ok {
        return json!({ "ok": false, "noUpstream": true, "error": err_detail(&counts) });
    }
    let mut parts = counts.out.split_whitespace();
    let behind: i64 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let ahead: i64 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    json!({ "ok": true, "ahead": ahead, "behind": behind, "upstream": upstream })
}

/// git:tag — tag on a commit (annotated if there is a message).
#[tauri::command]
pub async fn git_tag(
    cwd: String,
    name: String,
    hash: String,
    message: Option<String>,
) -> JsonValue {
    let msg = message.unwrap_or_default();
    let msg = msg.trim();
    // A tag called `-d` turned "create" into "delete the tag named <hash>".
    if let Err(e) = validate_ref_arg(&name, "tag name").and(validate_ref_arg(&hash, "commit")) {
        return json!({ "ok": false, "error": e });
    }
    let r = if msg.is_empty() {
        run_git(&cwd, &["tag", &name, &hash])
    } else {
        run_git(&cwd, &["tag", "-a", &name, "-m", msg, &hash])
    };
    if r.ok {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": err_detail(&r) })
    }
}

/// git:remote-url — raw origin URL + browsable https form.
#[tauri::command]
pub async fn git_remote_url(cwd: String) -> JsonValue {
    let r = run_git(&cwd, &["remote", "get-url", "origin"]);
    if !r.ok {
        return json!({ "ok": false, "error": err_detail(&r) });
    }
    let raw = r.out.trim().to_string();
    json!({ "ok": true, "url": raw, "webUrl": normalize_remote_url(&raw) })
}

/// File size cap for base64 previews (20 MB, like MAX_SHOW_FILE_SIZE).
const MAX_SHOW_FILE_SIZE: u64 = 20 * 1024 * 1024;

/// git:show-file-base64 — bytes of a file at a revision (`git show rev:path`)
/// in base64. `exists:false` = path missing at that revision (file
/// added/deleted) — a normal case for previews, not an error.
#[tauri::command]
pub async fn git_show_file_base64(cwd: String, rev: String, file_path: String) -> JsonValue {
    if rev.is_empty() || file_path.is_empty() || rev.starts_with('-') || file_path.starts_with('-')
    {
        return json!({ "ok": false, "error": "Invalid argument" });
    }
    let spec = format!("{rev}:{file_path}");
    let size_run = run_git(&cwd, &["cat-file", "-s", &spec]);
    if !size_run.ok {
        return json!({ "ok": true, "exists": false });
    }
    let size: u64 = size_run.out.trim().parse().unwrap_or(0);
    if size > MAX_SHOW_FILE_SIZE {
        return json!({ "ok": false, "error": "File too large" });
    }
    // Binary output: no run_git (which does lossy-utf8) — raw bytes.
    match git_cmd().args(["show", &spec]).current_dir(&cwd).output() {
        Ok(out) if out.status.success() => {
            let ext = Path::new(&file_path)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e.to_lowercase()))
                .unwrap_or_default();
            json!({
                "ok": true,
                "exists": true,
                "data": crate::commands::assets_ext::base64_encode(&out.stdout),
                "mimeType": crate::commands::assets_ext::get_mime_type(&ext),
                "size": size,
            })
        }
        Ok(out) => {
            let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
            json!({ "ok": false, "error": detail })
        }
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

#[cfg(test)]
mod history_preview_tests {
    use super::*;

    static NEXT_REPO: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new() -> Self {
            let id = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT_REPO.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let repo = Self(std::env::temp_dir().join(format!(
                "promptops-history-{}-{id}-{sequence}",
                std::process::id()
            )));
            std::fs::create_dir_all(&repo.0).unwrap();
            repo.git(&["init", "-b", "main"]);
            repo.git(&["config", "user.name", "History Test"]);
            repo.git(&["config", "user.email", "history@example.invalid"]);
            repo.git(&["config", "core.autocrlf", "false"]);
            repo
        }
        fn cwd(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
        fn git(&self, args: &[&str]) -> String {
            let output = crate::commands::util_cmd::cmd("git")
                .current_dir(&self.0)
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        fn write(&self, path: &str, contents: &[u8]) {
            std::fs::write(self.0.join(path), contents).unwrap();
        }
        fn commit(&self) -> String {
            self.git(&["add", "--all"]);
            self.git(&["commit", "-m", "fixture"]);
            self.git(&["rev-parse", "HEAD"])
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn working_tree_status_returns_names_without_computing_diff_statistics() {
        let repo = Repo::new();
        repo.write("large.txt", &vec![b'x'; 3 * 1024 * 1024]);
        repo.commit();
        repo.write("large.txt", &vec![b'y'; 3 * 1024 * 1024]);
        for n in 0..1000 {
            repo.write(&format!("untracked-{n}.txt"), b"new\n");
        }
        let status = git_status(repo.cwd()).await.unwrap();
        assert!(status.ok);
        assert_eq!(status.files.len(), 1001);
        assert!(status.diff_stat.is_none());
        assert_eq!(status.counts.unwrap().total, 1001);
        assert!(status
            .files
            .iter()
            .any(|file| file.path == "large.txt" && file.status == "modified"));
    }

    // Windows does not allow a tab in a file name.
    #[cfg(unix)]
    #[tokio::test]
    async fn root_manifest_and_literal_paths_do_not_load_other_files() {
        let repo = Repo::new();
        let path = "special[1] é\tname.txt";
        repo.write(path, b"selected content\n");
        repo.write("special1.txt", b"must not appear\n");
        repo.write("binary.dat", b"\0binary\0");
        let hash = repo.commit();
        let manifest = git_commit_files(repo.cwd(), hash.clone()).await.unwrap();
        assert_eq!(manifest["files"].as_array().unwrap().len(), 3);
        assert!(manifest.get("diff").is_none());
        assert!(manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == path && f["status"] == "added"));
        let patch = git_commit_file_diff(repo.cwd(), hash.clone(), path.into())
            .await
            .unwrap();
        assert!(patch["diff"]
            .as_str()
            .unwrap()
            .contains("+selected content"));
        assert!(!patch["diff"].as_str().unwrap().contains("must not appear"));
        let binary = git_commit_file_diff(repo.cwd(), hash, "binary.dat".into())
            .await
            .unwrap();
        assert!(binary["diff"].as_str().unwrap().contains("Binary files"));
    }

    #[tokio::test]
    async fn merge_uses_first_parent_and_deletions_remain_browsable() {
        let repo = Repo::new();
        repo.write("base.txt", b"base\n");
        repo.commit();
        repo.git(&["checkout", "-b", "side"]);
        repo.write("side.txt", b"side\n");
        repo.commit();
        repo.git(&["checkout", "main"]);
        repo.write("main.txt", b"main\n");
        repo.commit();
        repo.git(&["merge", "--no-ff", "side", "-m", "merge"]);
        let hash = repo.git(&["rev-parse", "HEAD"]);
        let manifest = git_commit_files(repo.cwd(), hash.clone()).await.unwrap();
        assert_eq!(
            manifest["files"],
            json!([{ "path": "side.txt", "status": "added" }])
        );
        let patch = git_commit_file_diff(repo.cwd(), hash, "side.txt".into())
            .await
            .unwrap();
        assert!(patch["diff"].as_str().unwrap().contains("+side"));
        repo.git(&["rm", "base.txt"]);
        let hash = repo.commit();
        let manifest = git_commit_files(repo.cwd(), hash.clone()).await.unwrap();
        assert_eq!(manifest["files"][0]["status"], "deleted");
        let patch = git_commit_file_diff(repo.cwd(), hash, "base.txt".into())
            .await
            .unwrap();
        assert!(patch["diff"].as_str().unwrap().contains("-base"));
    }

    #[tokio::test]
    async fn large_commit_is_metadata_only_and_large_previews_are_bounded() {
        let repo = Repo::new();
        for n in 0..1000 {
            repo.write(&format!("file-{n}.txt"), b"small\n");
        }
        repo.write("large.txt", "line of text\n".repeat(40_000).as_bytes());
        repo.write(
            "oversized.txt",
            &vec![b'x'; HISTORY_BLOB_BYTES as usize + 1],
        );
        let hash = repo.commit();
        let manifest = git_commit_files(repo.cwd(), hash.clone()).await.unwrap();
        assert_eq!(manifest["files"].as_array().unwrap().len(), 1002);
        assert!(manifest.to_string().len() < 100_000);
        let patch = git_commit_file_diff(repo.cwd(), hash.clone(), "large.txt".into())
            .await
            .unwrap();
        assert_eq!(patch["truncated"], true);
        assert!(patch["diff"].as_str().unwrap().len() <= HISTORY_PATCH_BYTES);
        let error = git_commit_file_diff(repo.cwd(), hash, "oversized.txt".into())
            .await
            .unwrap_err();
        assert!(error.contains("2 MiB"));
        assert!(git_commit_files(repo.cwd(), "--all".into()).await.is_err());
    }
}

#[cfg(test)]
mod resolver_tests {
    use super::*;

    /// bare origin + two clones: `me` (the user) and `ci` (the automatic bump).
    struct Fixture {
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let id = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!("promptops-resolver-{tag}-{id}"));
            std::fs::create_dir_all(&root).unwrap();
            let f = Self { root };
            f.run(".", &["init", "--bare", "-b", "main", "origin.git"]);
            f.run(
                ".",
                &["clone", "-c", "core.autocrlf=false", "origin.git", "me"],
            );
            f.configure("me");
            f.write("me", "app.txt", "one\ntwo\nthree\n");
            f.write("me", "version.json", "{\"build\": 1}\n");
            f.commit("me", "initial");
            f.run("me", &["push", "-u", "origin", "main"]);
            f.run(
                ".",
                &["clone", "-c", "core.autocrlf=false", "origin.git", "ci"],
            );
            f.configure("ci");
            f
        }
        fn dir(&self, who: &str) -> std::path::PathBuf {
            self.root.join(who)
        }
        fn cwd(&self, who: &str) -> String {
            self.dir(who).to_string_lossy().into_owned()
        }
        fn configure(&self, who: &str) {
            self.run(who, &["config", "user.name", "Resolver Test"]);
            self.run(who, &["config", "user.email", "resolver@example.invalid"]);
            self.run(who, &["config", "commit.gpgsign", "false"]);
            self.run(who, &["config", "core.hooksPath", "/dev/null"]);
            // Windows runners default to autocrlf=true: keep the bytes the tests write
            // (the clones above also pass it, so their first checkout keeps LF too).
            self.run(who, &["config", "core.autocrlf", "false"]);
        }
        fn run(&self, who: &str, args: &[&str]) -> String {
            let out = crate::commands::util_cmd::cmd("git")
                .current_dir(self.root.join(who))
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        fn write(&self, who: &str, path: &str, body: &str) {
            std::fs::write(self.dir(who).join(path), body).unwrap();
        }
        fn read(&self, who: &str, path: &str) -> String {
            std::fs::read_to_string(self.dir(who).join(path)).unwrap()
        }
        fn commit(&self, who: &str, msg: &str) {
            self.run(who, &["add", "--all"]);
            self.run(who, &["commit", "-m", msg]);
        }
        /// CI commits a bump and pushes it: `me` falls behind.
        fn ci_bump(&self, path: &str, body: &str) {
            self.run("ci", &["pull"]);
            self.write("ci", path, body);
            self.commit("ci", "ci: bump build [skip ci]");
            self.run("ci", &["push"]);
        }
        fn resolve(&self, op: &str, auto: bool) -> AiResolveSyncResult {
            Resolver::new(self.cwd("me"), "claude-code-cli".into(), auto)
                .run(op, None)
                .unwrap()
        }
        fn stash_count(&self) -> usize {
            self.run("me", &["stash", "list"]).lines().count()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn push_after_ci_bump_merges_and_pushes_keeping_dirty_work() {
        let f = Fixture::new("bump");
        f.ci_bump("version.json", "{\"build\": 2}\n");
        f.write("me", "app.txt", "one\ntwo\nthree\nfour\n");
        f.commit("me", "feature");
        f.write("me", "notes.txt", "wip\n"); // uncommitted work, not touched by the bump

        let err = spawn_shell_cmd("git push", &f.cwd("me")).unwrap_err();
        assert!(
            err.contains("rejected") || err.contains("fetch first"),
            "{err}"
        );

        let r = f.resolve("push", true);
        assert!(r.ok, "{:?} {:?}", r.error, r.steps);
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(f.read("me", "notes.txt"), "wip\n");
        assert_eq!(f.stash_count(), 0);
        let remote_head = f.run("me", &["rev-parse", "origin/main"]);
        assert_eq!(remote_head, f.run("me", &["rev-parse", "HEAD"]));
        assert_eq!(f.read("me", "version.json"), "{\"build\": 2}\n");
    }

    #[test]
    fn auto_mode_stops_on_conflict_and_leaves_repo_as_it_was() {
        let f = Fixture::new("conflict");
        f.ci_bump("app.txt", "one\nCI\nthree\n");
        f.write("me", "app.txt", "one\nME\nthree\n");
        f.commit("me", "local edit");
        let before = f.run("me", &["rev-parse", "HEAD"]);
        f.write("me", "notes.txt", "wip\n");

        let r = f.resolve("push", true);
        assert!(!r.ok);
        assert!(
            r.error.as_deref().unwrap_or("").contains("Conflicts"),
            "{:?}",
            r.error
        );
        assert_eq!(f.run("me", &["rev-parse", "HEAD"]), before);
        assert!(f
            .run("me", &["diff", "--name-only", "--diff-filter=U"])
            .is_empty());
        assert!(!f.dir("me").join(".git/MERGE_HEAD").exists());
        assert_eq!(f.read("me", "app.txt"), "one\nME\nthree\n");
        assert_eq!(f.read("me", "notes.txt"), "wip\n");
        // safety point created
        assert!(!f
            .run("me", &["for-each-ref", "refs/promptops/backup/"])
            .is_empty());
    }

    #[test]
    fn overlapping_dirty_changes_stay_in_stash_instead_of_conflicting() {
        let f = Fixture::new("overlap");
        f.ci_bump("version.json", "{\"build\": 2}\n");
        f.write("me", "version.json", "{\"build\": 99}\n"); // local change on the same file

        let r = f.resolve("pull", true);
        assert!(r.ok, "{:?} {:?}", r.error, r.steps);
        assert_eq!(r.partial, Some(true));
        assert!(r
            .error
            .as_deref()
            .unwrap_or("")
            .contains("promptops-ai-resolver-"));
        assert_eq!(f.read("me", "version.json"), "{\"build\": 2}\n");
        assert_eq!(f.stash_count(), 1);
        assert!(f
            .run("me", &["stash", "show", "-p", "stash@{0}"])
            .contains("99"));
    }

    #[test]
    fn stale_index_lock_is_removed_fresh_one_blocks() {
        let f = Fixture::new("lock");
        let lock = f.dir("me").join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let r = f.resolve("pull", true);
        assert!(!r.ok);
        assert!(lock.exists());

        let old =
            std::time::SystemTime::now() - std::time::Duration::from_secs(STALE_LOCK_SECS + 60);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let r = f.resolve("pull", true);
        assert!(r.ok, "{:?}", r.error);
        assert!(!lock.exists());
    }

    #[test]
    fn half_finished_merge_without_conflicts_is_concluded() {
        let f = Fixture::new("halfmerge");
        f.ci_bump("version.json", "{\"build\": 2}\n");
        f.write("me", "app.txt", "one\ntwo\nthree\nfour\n");
        f.commit("me", "feature");
        f.run("me", &["fetch"]);
        f.run("me", &["merge", "--no-commit", "--no-ff", "origin/main"]);
        assert!(f.dir("me").join(".git/MERGE_HEAD").exists());

        let r = f.resolve("push", true);
        assert!(r.ok, "{:?} {:?}", r.error, r.steps);
        assert!(!f.dir("me").join(".git/MERGE_HEAD").exists());
        assert_eq!(
            f.run("me", &["rev-parse", "origin/main"]),
            f.run("me", &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn hung_command_times_out_instead_of_blocking() {
        let started = std::time::Instant::now();
        let err = spawn_shell_cmd_timeout("sleep 30", &std::env::temp_dir().to_string_lossy(), 1)
            .unwrap_err();
        assert!(err.contains("Timed out"), "{err}");
        assert!(started.elapsed().as_secs() < 10);
    }

    #[test]
    fn pull_never_opens_an_editor() {
        let f = Fixture::new("editor");
        f.ci_bump("version.json", "{\"build\": 2}\n");
        f.write("me", "app.txt", "one\ntwo\nthree\nfour\n");
        f.commit("me", "feature");
        f.run("me", &["config", "pull.rebase", "false"]);
        // an editor that never exits: before the fix, the pull hung here
        f.run("me", &["config", "core.editor", "sleep 600"]);
        let started = std::time::Instant::now();
        let out = spawn_shell_cmd("git pull", &f.cwd("me"));
        assert!(out.is_ok(), "{out:?}");
        assert!(started.elapsed().as_secs() < 60);
    }
}

/// Fixture repos for every awkward state and hostile name the git panel can
/// meet (audit checkpoint 9): nothing a file or branch name contains may reach
/// a shell or be parsed by git as an option.
#[cfg(test)]
mod hostile_input_tests {
    use super::*;

    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new(tag: &str) -> Self {
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("po-git-hostile-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let r = Self(dir);
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.name", "T"]);
            r.git(&["config", "user.email", "t@example.invalid"]);
            r.git(&["config", "commit.gpgsign", "false"]);
            r.git(&["config", "core.hooksPath", "/dev/null"]);
            r.git(&["config", "core.autocrlf", "false"]);
            r
        }
        fn cwd(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
        fn git(&self, args: &[&str]) -> String {
            let o = crate::commands::util_cmd::cmd("git")
                .current_dir(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                o.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&o.stderr)
            );
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        fn write(&self, p: &str, body: &str) {
            let full = self.0.join(p);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, body).unwrap();
        }
        fn commit_all(&self, msg: &str) -> String {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
            self.git(&["rev-parse", "HEAD"])
        }
        fn no_marker(&self) {
            for entry in std::fs::read_dir(&self.0).unwrap().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                assert!(
                    !name.starts_with("PWNED"),
                    "command injection: {name} created"
                );
            }
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    const HOSTILE: &[&str] = &[
        "sp ace.txt",
        "quote\"d.txt",
        "single'q.txt",
        "semi;colon.txt",
        "dollar$(touch PWNED_SUBST).txt",
        "back`touch PWNED_BT`tick.txt",
        "-leading-dash.txt",
        "unicodé-文件.txt",
        "hash#name.txt",
        "new\nline.txt",
    ];

    #[cfg(unix)]
    #[tokio::test]
    async fn status_reports_raw_paths_and_every_one_can_be_staged() {
        let r = Repo::new("status");
        r.write("base.txt", "base\n");
        for n in HOSTILE {
            r.write(n, "x\n");
        }
        r.commit_all("hostile");
        for n in HOSTILE {
            r.write(n, "x\nchanged\n");
        }
        r.git(&["mv", "base.txt", "renamed.txt"]);

        let st = git_status(r.cwd()).await.unwrap();
        assert!(st.ok, "{:?}", st.error);
        for n in HOSTILE {
            assert!(
                st.files
                    .iter()
                    .any(|f| f.path == *n && f.status == "modified"),
                "{n:?} missing from {:?}",
                st.files.iter().map(|f| &f.path).collect::<Vec<_>>()
            );
        }
        let renamed = st.files.iter().find(|f| f.path == "renamed.txt").unwrap();
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.orig_path.as_deref(), Some("base.txt"));

        let paths: Vec<String> = HOSTILE.iter().map(|s| s.to_string()).collect();
        let staged = git_stage(r.cwd(), paths.clone()).await.unwrap();
        assert!(staged.ok, "{:?}", staged.error);
        let st = git_status(r.cwd()).await.unwrap();
        for n in HOSTILE {
            assert!(
                st.files.iter().any(|f| f.path == *n && f.staged),
                "{n:?} not staged"
            );
        }
        let unstaged = git_unstage(r.cwd(), paths).await.unwrap();
        assert!(unstaged.ok, "{:?}", unstaged.error);
        r.no_marker();
    }

    #[test]
    fn porcelain_z_parser_handles_renames_and_copies() {
        let raw =
            "R  new name.txt\0old name.txt\0 M plain.txt\0?? un\"tracked\0C  copy.txt\0src.txt\0";
        let files = parse_porcelain_z(raw);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "new name.txt");
        assert_eq!(files[0].orig_path.as_deref(), Some("old name.txt"));
        assert!(files[0].staged);
        assert_eq!(files[1].path, "plain.txt");
        assert!(!files[1].staged);
        assert_eq!(files[2].path, "un\"tracked");
        assert_eq!(files[2].status, "untracked");
        assert_eq!(files[3].orig_path.as_deref(), Some("src.txt"));
    }

    #[test]
    fn command_line_split_never_needs_a_shell() {
        assert_eq!(
            split_command_line("git log --format='%s $(x)' -n 2").unwrap(),
            vec!["git", "log", "--format=%s $(x)", "-n", "2"]
        );
        // Backslash escapes are a POSIX shell rule: on Windows a backslash is
        // literal (paths), so this case only holds elsewhere.
        if !is_windows() {
            assert_eq!(
                split_command_line(r#"git commit -m "fix: \"quoted\" msg""#).unwrap(),
                vec!["git", "commit", "-m", "fix: \"quoted\" msg"]
            );
        }
        for bad in [
            "git status; touch PWNED",
            "git status && rm -rf x",
            "git log | head",
            "git log > out.txt",
            "git show $(whoami)",
            "git show `whoami`",
            "git show \"$(whoami)\"",
            "git status\ntouch PWNED",
        ] {
            assert!(split_command_line(bad).is_err(), "{bad:?} accepted");
        }
        assert!(split_command_line("git log 'unterminated").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mini_terminal_runs_git_without_a_shell() {
        let r = Repo::new("exec");
        r.write("dollar$(touch PWNED_SUBST).txt", "one\n");
        r.commit_all("one");
        r.write("dollar$(touch PWNED_SUBST).txt", "two\n");

        let out = git_exec(r.cwd(), "git status; touch PWNED_SEMI".into())
            .await
            .unwrap();
        assert!(!out.ok);
        // Exactly what the Discard button sends: a single-quoted path.
        let discard = git_exec(
            r.cwd(),
            "git checkout -- 'dollar$(touch PWNED_SUBST).txt'".into(),
        )
        .await
        .unwrap();
        assert!(discard.ok, "{:?}", discard.output);
        assert_eq!(
            std::fs::read_to_string(r.0.join("dollar$(touch PWNED_SUBST).txt")).unwrap(),
            "one\n"
        );
        // The explorer's quoteArg(): `'` becomes `'"'"'`.
        let quote = |a: &str| format!("'{}'", a.replace('\'', "'\"'\"'"));
        for name in [
            "single'q.txt",
            "new\nline.txt",
            "back`touch PWNED_BT`tick.txt",
        ] {
            r.write(name, "one\n");
            r.git(&["add", "--", name]);
            r.git(&["commit", "-q", "-m", "n"]);
            r.write(name, "two\n");
            let out = git_exec(r.cwd(), format!("git checkout -- {}", quote(name)))
                .await
                .unwrap();
            assert!(out.ok, "{name:?}: {:?}", out.output);
            assert_eq!(std::fs::read_to_string(r.0.join(name)).unwrap(), "one\n");
        }
        let refs = git_exec(r.cwd(), "git show-ref --head".into())
            .await
            .unwrap();
        assert!(refs.ok && refs.output.unwrap_or_default().contains("HEAD"));
        let not_git = git_exec(r.cwd(), "touch PWNED_NOTGIT".into())
            .await
            .unwrap();
        assert!(!not_git.ok);
        r.no_marker();
    }

    #[tokio::test]
    async fn option_like_refs_are_refused_before_git_sees_them() {
        let r = Repo::new("opts");
        r.write("a.txt", "a\n");
        let head = r.commit_all("a");
        let marker = r.0.join("PWNED_EXEC");

        let rebase = git_rebase(r.cwd(), format!("--exec=touch {}", marker.display())).await;
        assert_eq!(rebase["ok"], false);
        let out_file = r.0.join("PWNED_OUTPUT");
        let show = git_show(r.cwd(), format!("--output={}", out_file.display()))
            .await
            .unwrap();
        assert!(!show.ok);
        let tag = git_tag(r.cwd(), "-d".into(), head.clone(), None).await;
        assert_eq!(tag["ok"], false);
        let pick = git_cherry_pick(r.cwd(), "--abort".into()).await;
        assert_eq!(pick["ok"], false);
        let reset = git_reset(r.cwd(), "--hard".into(), Some("soft".into())).await;
        assert_eq!(reset["ok"], false);
        let merged = git_merge(
            r.cwd(),
            vec!["--no-verify".into()],
            "main".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!merged.ok);
        let del = git_delete_branch(r.cwd(), "-D".into(), None, None).await;
        assert_eq!(del["ok"], false);
        let clone_dest = r.0.join("clone-dest").to_string_lossy().into_owned();
        let clone = git_clone(
            format!("--upload-pack=touch {}", r.0.join("PWNED_CLONE").display()),
            clone_dest,
            None,
        )
        .await
        .unwrap();
        assert!(!clone.ok);
        assert!(!marker.exists() && !out_file.exists());
        r.no_marker();
    }

    #[tokio::test]
    async fn checkout_never_falls_back_to_restoring_a_file() {
        let r = Repo::new("ckfile");
        r.write("notes.txt", "committed\n");
        r.commit_all("notes");
        r.write("notes.txt", "precious local edit\n");
        // No branch is called notes.txt: before the fix git treated the name as
        // a path and silently threw the local edit away.
        let out = git_checkout(r.cwd(), "notes.txt".into()).await.unwrap();
        assert!(!out.ok);
        assert_eq!(
            std::fs::read_to_string(r.0.join("notes.txt")).unwrap(),
            "precious local edit\n"
        );
        r.git(&["branch", "feature"]);
        assert!(git_checkout(r.cwd(), "feature".into()).await.unwrap().ok);
    }

    #[tokio::test]
    async fn create_branch_honors_the_start_point() {
        let r = Repo::new("startpoint");
        r.write("a.txt", "1\n");
        let first = r.commit_all("one");
        r.write("a.txt", "2\n");
        r.commit_all("two");
        let out = git_create_branch(r.cwd(), "from-first".into(), Some(first.clone()))
            .await
            .unwrap();
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(r.git(&["rev-parse", "HEAD"]), first);
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "from-first");
        let bad = git_create_branch(r.cwd(), "x".into(), Some("--orphan".into()))
            .await
            .unwrap();
        assert!(!bad.ok);
    }

    #[tokio::test]
    async fn branch_names_with_shell_characters_are_plain_data() {
        let r = Repo::new("brnames");
        r.write("a.txt", "a\n");
        r.commit_all("a");
        for name in [
            "br'quote",
            "br;semi",
            "br$(touch${IFS}PWNED_BR)",
            "brünicode",
        ] {
            r.git(&["branch", name]);
            let out = git_checkout(r.cwd(), name.into()).await.unwrap();
            assert!(out.ok, "{name}: {:?}", out.error);
            let renamed = format!("{name}-2");
            let mv = git_rename_branch(r.cwd(), name.into(), renamed.clone()).await;
            assert_eq!(mv["ok"], true, "{name}: {mv}");
            r.git(&["checkout", "-q", "main"]);
            let del = git_delete_branch(r.cwd(), renamed.clone(), Some(true), None).await;
            assert_eq!(del["ok"], true, "{name}: {del}");
            // Remote delete goes through the login shell: no origin here, so it
            // fails — but the name must never be executed.
            let remote =
                git_delete_branch(r.cwd(), format!("origin/{name}"), None, Some(true)).await;
            assert_eq!(remote["ok"], false);
        }
        r.no_marker();
    }

    #[tokio::test]
    async fn untracked_preview_and_ai_resolve_stay_inside_the_repo() {
        let r = Repo::new("contain");
        r.write("a.txt", "a\n");
        r.commit_all("a");
        let outside = std::env::temp_dir().join(format!("po-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "SECRET-OUTSIDE\n").unwrap();
        let rel = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        let diff = git_file_diff(r.cwd(), rel.clone()).await.unwrap();
        assert!(!diff.diff.unwrap_or_default().contains("SECRET-OUTSIDE"));
        let abs = git_file_diff(r.cwd(), outside.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(!abs.diff.unwrap_or_default().contains("SECRET-OUTSIDE"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, r.0.join("link.txt")).unwrap();
            let linked = git_file_diff(r.cwd(), "link.txt".into()).await.unwrap();
            assert!(!linked.diff.unwrap_or_default().contains("SECRET-OUTSIDE"));
            // A FIFO used to block the read forever.
            let fifo = r.0.join("pipe");
            let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            let started = std::time::Instant::now();
            let _ = git_file_diff(r.cwd(), "pipe".into()).await.unwrap();
            assert!(started.elapsed().as_secs() < 10);
        }
        assert!(contained_path(&r.cwd(), &rel).is_err());
        assert!(contained_path(&r.cwd(), "sub/../a.txt").is_ok());
        let _ = std::fs::remove_file(&outside);
    }

    #[tokio::test]
    async fn worktree_diff_is_bounded() {
        let r = Repo::new("bigdiff");
        r.write("big.txt", "x\n");
        r.commit_all("small");
        r.write("big.txt", &"line of changed text\n".repeat(120_000));
        let d = git_diff(r.cwd(), None).await.unwrap();
        assert!(d.ok);
        assert_eq!(d.truncated, Some(true));
        assert!(d.diff.unwrap().len() <= WORKTREE_DIFF_CAP);
    }

    #[test]
    fn model_output_with_multibyte_case_does_not_panic() {
        // 'İ' lowercases to 3 bytes: byte offsets taken on a fully lowercased
        // copy used to slice the original mid-character.
        for raw in [
            "İİİ commit message: fix: handle ü",
            "İ Commit Message is: feat(é): add",
            "COMMIT: İ fix: x",
            "ẞẞ feat: ok",
            // panicked before the fix: the cut landed inside 'é'
            "İ commit message:évite les doublons",
        ] {
            let _ = clean_commit_message(raw);
            let _ = clean_branch_name(raw);
        }
        assert_eq!(
            clean_commit_message("İİ The commit message: fix: résumé").as_deref(),
            Some("fix: résumé")
        );
    }

    #[test]
    fn ref_validation() {
        for bad in ["", "-x", "--exec=sh", "a\nb", "a\0b"] {
            assert!(validate_ref_arg(bad, "ref").is_err(), "{bad:?}");
        }
        for ok in [
            "main",
            "origin/main",
            "feat/x-y",
            "br'quote",
            "v1.2.3",
            "HEAD~2",
            "abc123",
        ] {
            assert!(validate_ref_arg(ok, "ref").is_ok(), "{ok:?}");
        }
        assert!(!is_safe_branch_chars("-x"));
    }

    /// A cloned repository's `core.fsmonitor` command never runs from the
    /// panel's own git calls (status poll, log, diff).
    #[cfg(unix)]
    #[tokio::test]
    async fn repository_fsmonitor_never_runs_from_panel_git() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::commands::util_cmd::PrivateTempDir::new("po-fsmon").unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let git = |args: &[&str]| {
            let o = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        };
        git(&["init", "-q"]);
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        git(&["add", "a.txt"]);
        git(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "one",
        ]);
        std::fs::write(dir.path().join("a.txt"), "y").unwrap();
        let marker = dir.path().join("fsmonitor-ran");
        let hook = dir.path().join("hook.sh");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&["config", "core.fsmonitor", &hook.to_string_lossy()]);
        let st = git_status(cwd.clone()).await.unwrap();
        assert!(st.ok, "{:?}", st.error);
        let _ = run_git(&cwd, &["diff", "--stat"]);
        let _ = history_git(&cwd, &["status", "--porcelain"], 4096).await;
        let (_, env) = shell_git_script(&["status"]);
        assert_eq!(env.len(), 1);
        assert!(!marker.exists(), "repository fsmonitor hook ran");
    }

    #[test]
    fn shell_git_script_references_arguments_only_through_env() {
        let (script, env) = shell_git_script(&["push", "origin", "--delete", "x';calc;'"]);
        assert!(!script.contains("calc"));
        assert_eq!(env.len(), 4);
        assert_eq!(env[3].1, "x';calc;'");
    }

    /// Fake provider CLIs on a controlled PATH: checks the pipeline for every
    /// provider the commit writer offers without touching real accounts.
    #[cfg(unix)]
    #[test]
    fn provider_pipeline_works_for_every_listed_provider() {
        use std::os::unix::fs::PermissionsExt;
        let bin = std::env::temp_dir().join(format!("po-fake-providers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bin);
        std::fs::create_dir_all(&bin).unwrap();
        let script = |name: &str, body: &str| {
            let p = bin.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // Each fake echoes its own name plus the size of the prompt it received.
        script(
            "claude",
            r#"n=$(wc -c | tr -d ' '); echo "feat: claude $n $*""#,
        );
        script("gemini", r#"n=$(wc -c | tr -d ' '); echo "fix: gemini $n""#);
        script(
            "grok",
            r#"[ "$1" = "--prompt-file" ] || exit 2; n=$(wc -c < "$2" | tr -d ' '); echo "docs: grok $n""#,
        );
        script(
            "copilot",
            r#"case "$3" in --prompt=*) ;; *) exit 2;; esac; n=$(printf '%s\n' "${3#--prompt=}" | wc -c | tr -d ' '); echo "chore: copilot $n""#,
        );
        script(
            "codex",
            r#"out=""; while [ $# -gt 0 ]; do [ "$1" = "--output-last-message" ] && out="$2"; shift; done
n=$(wc -c | tr -d ' '); echo "refactor: codex $n" > "$out"; echo "noise on stdout""#,
        );
        script("slow", "sleep 30");
        let shell = ProviderShell {
            program: "/bin/sh".into(),
            args_before_cmd: vec!["-c".into()],
            script_prefix: String::new(),
            path: format!("{}:/usr/bin:/bin", bin.display()),
        };
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let prompt = "diff with 'quotes' and $(no expansion) — ünïcode\n";
        let len = prompt.len();
        let run = |p: &str| spawn_provider_with(p, prompt, &cwd, &shell, 20, None);
        assert_eq!(
            run("claude-code-cli").unwrap(),
            format!("feat: claude {len} -p --output-format text")
        );
        assert_eq!(run("gemini-cli").unwrap(), format!("fix: gemini {len}"));
        assert_eq!(run("grok").unwrap(), format!("docs: grok {len}"));
        // `$(cat …)` drops the trailing newline; printf adds one back.
        assert_eq!(run("copilot").unwrap(), format!("chore: copilot {len}"));
        assert_eq!(run("codex").unwrap(), format!("refactor: codex {len}"));
        // Unknown providers keep the documented Claude fallback.
        assert!(run("some-other-cli").unwrap().starts_with("feat: claude"));
        // A CLI that never answers is stopped.
        let slow_shell = ProviderShell {
            path: format!("{}:/usr/bin:/bin", bin.display()),
            ..shell
        };
        std::fs::copy(bin.join("slow"), bin.join("claude")).unwrap();
        let started = std::time::Instant::now();
        let err =
            spawn_provider_with("claude-code-cli", prompt, &cwd, &slow_shell, 1, None).unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        assert!(started.elapsed().as_secs() < 10);
        let _ = std::fs::remove_dir_all(&bin);
    }

    /// The model reaches each CLI as one argument, a prompt that looks like a
    /// flag stays the prompt, and a timeout ends the CLI's whole process group.
    #[cfg(unix)]
    #[test]
    fn provider_pipeline_passes_model_keeps_prompt_a_value_and_kills_the_group() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::commands::util_cmd::PrivateTempDir::new("po-fake-model").unwrap();
        let bin = dir.path().to_path_buf();
        let script = |name: &str, body: &str| {
            let p = bin.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // Prints its argv one per line.
        let echo_args = r#"cat >/dev/null; for a in "$@"; do printf '[%s]\n' "$a"; done"#;
        script("claude", echo_args);
        script("gemini", echo_args);
        script(
            "codex",
            r#"all=""; out=""; prev=""; for a in "$@"; do all="$all[$a]
"; [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done; cat >/dev/null; printf '%s' "$all" > "$out""#,
        );
        script("copilot", r#"for a in "$@"; do printf '[%s]\n' "$a"; done"#);
        let shell = ProviderShell {
            program: "/bin/sh".into(),
            args_before_cmd: vec!["-c".into()],
            script_prefix: String::new(),
            path: format!("{}:/usr/bin:/bin", bin.display()),
        };
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let run = |p: &str, prompt: &str, model: Option<&str>| {
            spawn_provider_with(p, prompt, &cwd, &shell, 20, model).unwrap()
        };
        let out = run("claude-code-cli", "hi", Some("opus-5.5"));
        assert!(out.contains("[--model]\n[opus-5.5]"), "{out}");
        let out = run("gemini-cli", "hi", Some("gemini-3-pro"));
        assert!(out.contains("[-m]\n[gemini-3-pro]"), "{out}");
        let out = run("codex", "hi", Some("gpt-6"));
        assert!(out.contains("[-m]\n[gpt-6]"), "{out}");
        // A model that is not a plain id (or looks like a flag) is dropped.
        let out = run(
            "claude-code-cli",
            "hi",
            Some("--dangerously-skip-permissions"),
        );
        assert!(
            !out.contains("dangerously") && !out.contains("[--model]"),
            "{out}"
        );
        let out = run("claude-code-cli", "hi", Some("x; touch /tmp/pwn"));
        assert!(!out.contains("pwn"), "{out}");
        // Copilot: the prompt is the value of --prompt=, never extra flags.
        let out = run("copilot", "--allow-all-tools \"--add-dir=/\" hi", None);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3, "{out}");
        assert_eq!(lines[2], "[--prompt=--allow-all-tools \"--add-dir=/\" hi]");

        // Timeout: a background child of the CLI dies with it.
        let pidfile = bin.join("bg.pid");
        script(
            "claude",
            &format!("sleep 60 & echo $! > '{}'; wait", pidfile.display()),
        );
        let err = spawn_provider_with("claude-code-cli", "hi", &cwd, &shell, 1, None).unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        let bg: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        // SAFETY: signal 0 only checks whether the pid exists.
        assert!(
            unsafe { libc::kill(bg, 0) } != 0,
            "orphaned provider child {bg}"
        );
    }

    #[tokio::test]
    async fn awkward_repository_states_answer_without_errors_or_hangs() {
        // no commits
        let empty = Repo::new("empty");
        empty.write("a.txt", "a\n");
        empty.git(&["add", "a.txt"]);
        let st = git_status(empty.cwd()).await.unwrap();
        assert!(st.ok && st.files.iter().any(|f| f.path == "a.txt" && f.staged));
        let log = git_log(empty.cwd(), Some(10)).await.unwrap();
        assert!(log.ok, "{:?}", log.error);
        assert!(
            git_unstage(empty.cwd(), vec!["a.txt".into()])
                .await
                .unwrap()
                .ok
        );
        let head = git_file_at_head(empty.cwd(), "a.txt".into()).await.unwrap();
        assert!(head.ok && !head.exists);

        // detached HEAD: the resolver refuses to act, status still works
        let det = Repo::new("detached");
        det.write("f", "1\n");
        det.commit_all("one");
        det.write("f", "2\n");
        det.commit_all("two");
        det.git(&["checkout", "-q", "HEAD~1"]);
        let st = git_status(det.cwd()).await.unwrap();
        assert!(st.ok);
        assert_eq!(st.branch.as_deref(), Some("HEAD"));
        let reset = git_reset(det.cwd(), "HEAD".into(), None).await;
        assert_eq!(reset["ok"], false);

        // merge conflict: conflict files listed raw, status marks them
        let c = Repo::new("conflict");
        c.write("sp ace.txt", "a\nb\nc\n");
        c.commit_all("base");
        c.git(&["checkout", "-q", "-b", "side"]);
        c.write("sp ace.txt", "a\nSIDE\nc\n");
        c.commit_all("side");
        c.git(&["checkout", "-q", "main"]);
        c.write("sp ace.txt", "a\nMAIN\nc\n");
        c.commit_all("main");
        let _ = crate::commands::util_cmd::cmd("git")
            .current_dir(&c.0)
            .args(["merge", "side", "-m", "m"])
            .output();
        let cf = git_conflict_files(c.cwd()).await.unwrap();
        assert_eq!(cf.files, vec!["sp ace.txt".to_string()]);
        let st = git_status(c.cwd()).await.unwrap();
        assert!(st
            .files
            .iter()
            .any(|f| f.status == "conflict" && f.path == "sp ace.txt"));
        assert!(git_merge_abort(c.cwd()).await.unwrap().ok);

        // rebase in progress: status/log still answer
        let rb = Repo::new("rebase");
        rb.write("f.txt", "a\nb\n");
        rb.commit_all("base");
        rb.git(&["checkout", "-q", "-b", "topic"]);
        rb.write("f.txt", "a\nTOPIC\n");
        rb.commit_all("topic");
        rb.git(&["checkout", "-q", "main"]);
        rb.write("f.txt", "a\nMAIN\n");
        rb.commit_all("main");
        rb.git(&["checkout", "-q", "topic"]);
        let _ = crate::commands::util_cmd::cmd("git")
            .current_dir(&rb.0)
            .args(["rebase", "main"])
            .output();
        assert!(git_status(rb.cwd()).await.unwrap().ok);
        assert!(git_log(rb.cwd(), Some(5)).await.unwrap().ok);
        let again = git_rebase(rb.cwd(), "main".into()).await;
        assert_eq!(again["ok"], false);

        // LFS pointer committed without git-lfs installed: a normal text file
        let lfs = Repo::new("lfs");
        lfs.write(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        lfs.write(
            "big.bin",
            "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n",
        );
        let _ = crate::commands::util_cmd::cmd("git")
            .current_dir(&lfs.0)
            .args(["-c", "filter.lfs.required=false", "add", "-A"])
            .output();
        let st = git_status(lfs.cwd()).await.unwrap();
        assert!(st.ok);
    }
}
