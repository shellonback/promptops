//! Windows shell selection — port of utils/windows-shells.ts +
//! ipc/handlers/terminal-shell-handlers.ts.
//!
//! Shell ids persisted in SessionConfig.shell:
//!   'powershell' | 'pwsh' | 'cmd' | 'gitbash' | 'wsl:<distro>'
//! No id = platform default. Off-Windows the list is [] and every probe
//! is false (byte-identical to the original).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};

const DETECTION_TTL_MS: u128 = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS: u64 = 8000;
/// The cold start of a WSL distro can take seconds.
const WSL_PROBE_TIMEOUT_MS: u64 = 15000;

#[derive(Clone, Serialize)]
pub struct TerminalShellInfo {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

/// CLI probed per provider by the "detect" button. None = nothing to probe
/// (always available). Kept separate from provider-check on purpose.
fn provider_probe_command(provider: &str) -> Option<&'static str> {
    match provider {
        "claude-code-cli" | "zai" | "kimi" => Some("claude"),
        "codex" => Some("codex"),
        "gemini-cli" => Some("gemini"),
        "antigravity" => Some("agy"),
        // Same binaries the launch line runs (session::provider_command): `gh`
        // and the `cursor` editor answered "installed" without the agent CLI.
        "copilot" => Some("copilot"),
        "cursor" => Some("cursor-agent"),
        "grok" => Some("grok"),
        "hermes" => Some("hermes"),
        "muse" => Some("muse"),
        "opencode" => Some("opencode"),
        "kora" => Some("kora"),
        _ => None, // promptops-cli, generic-shell, unknown
    }
}

/// Kind from the id ('wsl:Ubuntu' → 'wsl').
fn shell_kind(shell_id: &str) -> Option<&'static str> {
    let kind = shell_id.split(':').next().unwrap_or("");
    match kind {
        "powershell" => Some("powershell"),
        "pwsh" => Some("pwsh"),
        "cmd" => Some("cmd"),
        "gitbash" => Some("gitbash"),
        "wsl" => Some("wsl"),
        _ => None,
    }
}

/// Runs and waits with a timeout (try_wait polling). Returns (success, stdout).
fn exec_with_timeout(file: &str, args: &[&str], timeout_ms: u64) -> (bool, Vec<u8>) {
    let child = crate::commands::util_cmd::cmd(file)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => return (false, Vec::new()),
    };
    let mut stdout = child.stdout.take();
    // Reader on a separate thread: avoids the full-pipe deadlock.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break false,
        }
    };
    let out = reader.join().unwrap_or_default();
    (success, out)
}

fn exec_ok(file: &str, args: &[&str], timeout_ms: u64) -> bool {
    exec_with_timeout(file, args, timeout_ms).0
}

fn exec_probe(file: &str, args: &[&str], timeout_ms: u64) -> bool {
    let (ok, out) = exec_with_timeout(file, args, timeout_ms);
    ok && !String::from_utf8_lossy(&out).trim().is_empty()
}

// ── Git Bash ─────────────────────────────────────────────────────────────

fn git_bash_cache() -> &'static Mutex<Option<PathBuf>> {
    static CACHE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn git_bash_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(v) = std::env::var(var) {
            roots.push(PathBuf::from(v));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(Path::new(&local).join("Programs"));
    }
    roots
        .into_iter()
        .map(|r| r.join("Git").join("bin").join("bash.exe"))
        .collect()
}

fn find_git_bash_sync() -> Option<PathBuf> {
    {
        let cached = git_bash_cache().lock();
        if let Some(p) = cached.as_ref() {
            if p.exists() {
                return Some(p.clone());
            }
        }
    }
    for candidate in git_bash_candidates() {
        if candidate.exists() {
            *git_bash_cache().lock() = Some(candidate.clone());
            return Some(candidate);
        }
    }
    None
}

/// Standard path first, then derived from `where git` (<root>\bin\bash.exe).
fn find_git_bash() -> Option<PathBuf> {
    if let Some(p) = find_git_bash_sync() {
        return Some(p);
    }
    let (ok, out) = exec_with_timeout("where.exe", &["git"], 4000);
    if !ok {
        return None;
    }
    for line in String::from_utf8_lossy(&out).lines() {
        let git_exe = line.trim();
        if git_exe.is_empty() {
            continue;
        }
        let bash = Path::new(git_exe)
            .parent()
            .map(|d| d.join("..").join("bin").join("bash.exe"));
        if let Some(bash) = bash {
            if bash.exists() {
                let resolved = bash.canonicalize().unwrap_or(bash);
                *git_bash_cache().lock() = Some(resolved.clone());
                return Some(resolved);
            }
        }
    }
    None
}

/// WSL distributions via `wsl.exe -l -q`. Output is UTF-16LE on stock Windows,
/// UTF-8 with WSL_UTF8=1 — sniff the NULs to pick the decoding.
/// docker-desktop* filtered out.
fn list_wsl_distros() -> Vec<String> {
    let (ok, out) = exec_with_timeout("wsl.exe", &["-l", "-q"], 5000);
    if !ok || out.is_empty() {
        return Vec::new();
    }
    let text = if out.contains(&0u8) {
        let utf16: Vec<u16> = out
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(&out).to_string()
    };
    text.replace('\u{0}', "")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.to_lowercase().starts_with("docker-desktop"))
        .map(str::to_string)
        .collect()
}

// ── Detection ────────────────────────────────────────────────────────────

struct DetectionCache {
    shells: Vec<TerminalShellInfo>,
    ts: u128,
}

fn detection_cache() -> &'static Mutex<Option<DetectionCache>> {
    static CACHE: OnceLock<Mutex<Option<DetectionCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Shells available on this Windows machine. [] elsewhere. 5 min cache.
fn detect_windows_shells(force: bool) -> Vec<TerminalShellInfo> {
    if !cfg!(windows) {
        return Vec::new();
    }
    if !force {
        let cache = detection_cache().lock();
        if let Some(entry) = cache.as_ref() {
            if now_ms().saturating_sub(entry.ts) < DETECTION_TTL_MS {
                return entry.shells.clone();
            }
        }
    }

    let mut shells = vec![TerminalShellInfo {
        id: "powershell".into(),
        kind: "powershell".into(),
        label: "PowerShell".into(),
        distro: None,
    }];

    if exec_ok("where.exe", &["pwsh"], 6000) {
        shells.push(TerminalShellInfo {
            id: "pwsh".into(),
            kind: "pwsh".into(),
            label: "PowerShell 7 (pwsh)".into(),
            distro: None,
        });
    }
    shells.push(TerminalShellInfo {
        id: "cmd".into(),
        kind: "cmd".into(),
        label: "Command Prompt (cmd)".into(),
        distro: None,
    });
    if find_git_bash().is_some() {
        shells.push(TerminalShellInfo {
            id: "gitbash".into(),
            kind: "gitbash".into(),
            label: "Git Bash".into(),
            distro: None,
        });
    }
    for distro in list_wsl_distros() {
        shells.push(TerminalShellInfo {
            id: format!("wsl:{distro}"),
            kind: "wsl".into(),
            label: format!("WSL · {distro}"),
            distro: Some(distro),
        });
    }

    *detection_cache().lock() = Some(DetectionCache {
        shells: shells.clone(),
        ts: now_ms(),
    });
    shells
}

// ── Probe on-demand ──────────────────────────────────────────────────────

/// True if `command` resolves inside the shell. Login+interactive flags for
/// bash/WSL so PATH additions from .bashrc/.profile (nvm, ~/.local/bin)
/// are honored — that is where WSL users install the CLIs.
pub(crate) fn probe_command_in_shell(shell_id: &str, command: &str) -> bool {
    if !cfg!(windows)
        || !command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return false;
    }
    match shell_kind(shell_id) {
        Some("powershell") | Some("pwsh") => {
            let file = if shell_kind(shell_id) == Some("pwsh") {
                "pwsh.exe"
            } else {
                "powershell.exe"
            };
            let script = format!(
                "if (Get-Command {command} -ErrorAction SilentlyContinue) {{ Write-Output ok; exit 0 }} else {{ exit 1 }}"
            );
            exec_probe(file, &["-NoProfile", "-Command", &script], PROBE_TIMEOUT_MS)
        }
        Some("cmd") => {
            let cmdline = format!("where {command}");
            exec_probe("cmd.exe", &["/d", "/c", &cmdline], PROBE_TIMEOUT_MS)
        }
        Some("gitbash") => match find_git_bash() {
            Some(bash) => {
                let script = format!("command -v {command}");
                exec_probe(
                    &bash.to_string_lossy(),
                    &["-ilc", &script],
                    PROBE_TIMEOUT_MS,
                )
            }
            None => false,
        },
        Some("wsl") => {
            let distro = shell_id.split_once(':').map(|(_, d)| d).unwrap_or("");
            let script = format!("command -v {command}");
            let mut base: Vec<&str> = Vec::new();
            if !distro.is_empty() {
                base.extend(["-d", distro]);
            }
            // bash -lic first (sources .bashrc/.profile → nvm & co.),
            // sh -lc as fallback for distros whose user has no bash.
            let mut via_bash = base.clone();
            via_bash.extend(["--", "bash", "-lic", &script]);
            if exec_probe("wsl.exe", &via_bash, WSL_PROBE_TIMEOUT_MS) {
                return true;
            }
            let mut via_sh = base;
            via_sh.extend(["--", "sh", "-lc", &script]);
            exec_probe("wsl.exe", &via_sh, WSL_PROBE_TIMEOUT_MS)
        }
        _ => false,
    }
}

// ── Hook environment probe inside a WSL distro ────────────────────────────

/// What we need to know about the distro to write Claude hooks that work
/// IN THERE (see hook.rs::wsl_hook_plan): node available for the shim,
/// claude CLI version (HTTP hooks >= 2.1.63) and the host through which the distro
/// can reach the HookServer running on Windows.
pub struct WslHookEnv {
    pub has_node: bool,
    /// Raw output of `claude --version` (empty if claude does not resolve).
    pub claude_version_raw: String,
    /// `127.0.0.1` for WSL1 (shared network stack) and mirrored networking;
    /// the gateway IP (= WSL vEthernet on the Windows side) for WSL2 in NAT.
    pub host_candidate: String,
}

/// A single round-trip into the distro for all the information. `bash -lic`
/// first (PATH from .bashrc/.profile → nvm & co., like probe_command_in_shell),
/// `sh -lc` as fallback. Any failure → conservative defaults.
pub fn probe_wsl_hook_env(distro: &str) -> WslHookEnv {
    let fallback = WslHookEnv {
        has_node: false,
        claude_version_raw: String::new(),
        host_candidate: "127.0.0.1".into(),
    };
    if !cfg!(windows) {
        return fallback;
    }
    const SCRIPT: &str = concat!(
        r#"echo "PO_NODE=$(command -v node >/dev/null 2>&1 && echo yes)"; "#,
        r#"echo "PO_CLAUDE=$(claude --version 2>/dev/null | head -1)"; "#,
        r#"echo "PO_NET=$(wslinfo --networking-mode 2>/dev/null)"; "#,
        r#"echo "PO_GW=$(ip route show default 2>/dev/null | awk '{print $3; exit}')"; "#,
        r#"echo "PO_KERNEL=$(uname -r 2>/dev/null)""#
    );
    let mut base: Vec<&str> = Vec::new();
    if !distro.is_empty() {
        base.extend(["-d", distro]);
    }
    let mut via_bash = base.clone();
    via_bash.extend(["--", "bash", "-lic", SCRIPT]);
    let (mut ok, mut out) = exec_with_timeout("wsl.exe", &via_bash, WSL_PROBE_TIMEOUT_MS);
    if !ok || out.is_empty() {
        let mut via_sh = base;
        via_sh.extend(["--", "sh", "-lc", SCRIPT]);
        let r = exec_with_timeout("wsl.exe", &via_sh, WSL_PROBE_TIMEOUT_MS);
        ok = r.0;
        out = r.1;
    }
    if !ok {
        return fallback;
    }
    let text = String::from_utf8_lossy(&out).to_string();
    let field = |key: &str| -> String {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(|v| v.trim().to_string()))
            .unwrap_or_default()
    };
    let net = field("PO_NET=").to_ascii_lowercase();
    let gw = field("PO_GW=");
    let kernel = field("PO_KERNEL=").to_ascii_lowercase();
    // WSL2: kernel "…-microsoft-standard-WSL2"; WSL1: "…-Microsoft" (no
    // "standard") and shares the Windows network stack → loopback ok.
    let is_wsl2 = kernel.contains("microsoft-standard") || kernel.contains("wsl2");
    let gw_valid = gw.parse::<std::net::Ipv4Addr>().is_ok();
    let host_candidate = if net == "mirrored" || !gw_valid || !(net == "nat" || is_wsl2) {
        "127.0.0.1".to_string()
    } else {
        gw
    };
    WslHookEnv {
        has_node: field("PO_NODE=") == "yes",
        claude_version_raw: field("PO_CLAUDE="),
        host_candidate,
    }
}

/// Does the distro actually reach `host:port`? Verified FROM INSIDE with
/// bash's /dev/tcp (no dependency on curl/nc). The Windows firewall can
/// block WSL→host traffic on the vEthernet: never trust the bind alone.
pub fn probe_wsl_tcp_reachable(distro: &str, host: &str, port: u16) -> bool {
    if !cfg!(windows) || host.parse::<std::net::Ipv4Addr>().is_err() {
        return false;
    }
    let script = format!("exec 3<>/dev/tcp/{host}/{port} && echo PO_TCP_OK");
    let mut args: Vec<&str> = Vec::new();
    if !distro.is_empty() {
        args.extend(["-d", distro]);
    }
    args.extend(["--", "bash", "-c", &script]);
    let (ok, out) = exec_with_timeout("wsl.exe", &args, PROBE_TIMEOUT_MS);
    ok && String::from_utf8_lossy(&out).contains("PO_TCP_OK")
}

// ── Settings default shell (device-local, pushed by the webapp) ───────

fn default_shell_store() -> &'static Mutex<Option<String>> {
    static STORE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

/// terminal-shells:set-default — the webapp pushes the Settings value here
/// (terminal_default_shell) on every boot/change, so Rust-side wake/restore
/// sees it without going through the renderer.
#[tauri::command]
pub fn terminal_shells_set_default(shell: Option<String>) {
    *default_shell_store().lock() = shell.filter(|s| !s.is_empty());
}

// ── Spawning the chosen shell (port of resolveShellSpawn) ─────────────────

/// How to launch the chosen shell in the session PTY.
pub struct ResolvedShellSpawn {
    pub file: String,
    pub args: Vec<String>,
    /// PTY cwd override. WSL: the Windows cwd only hosts wsl.exe
    /// (a workspace on \\wsl$ would break ConPTY); the Linux cwd travels
    /// via --cd.
    pub cwd: Option<String>,
    pub is_wsl: bool,
}

/// True for shells whose environment is NOT the Windows host one: the provider
/// CLI may exist only in there, so the host check must be skipped.
pub fn is_cross_env_shell(shell_id: Option<&str>) -> bool {
    matches!(shell_id.and_then(shell_kind), Some("gitbash") | Some("wsl"))
}

/// Distro of a WSL shell ('wsl:Ubuntu' → Some("Ubuntu"), 'wsl' → Some("")
/// = default distro). None for any non-WSL shell.
pub fn wsl_distro_of(shell_id: Option<&str>) -> Option<String> {
    let id = shell_id?;
    if shell_kind(id) != Some("wsl") {
        return None;
    }
    Some(id.split_once(':').map(|(_, d)| d).unwrap_or("").to_string())
}

/// Workspace on the file share of a WSL distro:
/// `\\wsl.localhost\Ubuntu\home\u\repo` o `\\wsl$\Ubuntu\home\u\repo`
/// (also with `/`) → ("Ubuntu", "/home/u/repo"). None for any other path.
pub fn wsl_unc_path(path: &str) -> Option<(String, String)> {
    let norm = path.trim().replace('/', "\\");
    let rest = norm.strip_prefix("\\\\")?;
    let (host, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    let host = host.to_ascii_lowercase();
    if host != "wsl.localhost" && host != "wsl$" {
        return None;
    }
    let (distro, linux) = tail.split_once('\\').unwrap_or((tail, ""));
    if distro.is_empty() {
        return None;
    }
    let linux = format!("/{}", linux.replace('\\', "/").trim_end_matches('/'));
    Some((distro.to_string(), linux))
}

/// Shell inferred from the workspace: a project that lives inside a WSL distro
/// (`\\wsl.localhost\<distro>\…`) runs in that distro even if the user
/// did not pick the shell — PowerShell on that folder would look for the CLI
/// on the host, where it is not (reported by a user). Windows only.
pub fn infer_shell_for_cwd(cwd: Option<&str>) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let (distro, _) = wsl_unc_path(cwd?)?;
    Some(format!("wsl:{distro}"))
}

/// Effective shell taking the workspace into account: per-session override >
/// distro inferred from the WSL UNC path > Settings default.
pub fn effective_shell_for(config_shell: Option<&str>, cwd: Option<&str>) -> Option<String> {
    match config_shell {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => infer_shell_for_cwd(cwd).or_else(|| default_shell_store().lock().clone()),
    }
}

/// `C:\foo\bar` → `/mnt/c/foo/bar` (WSL default automount). None for
/// non-drive-letter paths (UNC, relative): better no hook than a broken hook.
pub fn windows_to_wsl_path(win: &str) -> Option<String> {
    let b = win.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || (b[2] != b'\\' && b[2] != b'/')
    {
        return None;
    }
    let drive = (b[0] as char).to_ascii_lowercase();
    let rest = win[3..].replace('\\', "/");
    Some(format!("/mnt/{drive}/{rest}"))
}

/// resolveShellSpawn — None = use the platform default (login_shell).
pub fn resolve_shell_spawn(
    shell_id: Option<&str>,
    requested_cwd: Option<&str>,
) -> Option<ResolvedShellSpawn> {
    if !cfg!(windows) {
        return None;
    }
    let id = shell_id?;
    match shell_kind(id)? {
        // -ExecutionPolicy Bypass (per-process, no admin): the npm shims
        // (claude.ps1 & co.) run even with a Restricted/GPO policy —
        // PSSecurityException "running scripts is disabled" fixed at the root.
        "powershell" => Some(ResolvedShellSpawn {
            file: "powershell.exe".into(),
            args: ps_bypass_args(),
            cwd: None,
            is_wsl: false,
        }),
        "pwsh" => Some(ResolvedShellSpawn {
            file: "pwsh.exe".into(),
            args: ps_bypass_args(),
            cwd: None,
            is_wsl: false,
        }),
        "cmd" => Some(ResolvedShellSpawn {
            file: "cmd.exe".into(),
            args: vec![],
            cwd: None,
            is_wsl: false,
        }),
        "gitbash" => find_git_bash().map(|bash| ResolvedShellSpawn {
            file: bash.to_string_lossy().into_owned(),
            args: vec!["-i".into(), "-l".into()],
            cwd: None,
            is_wsl: false,
        }),
        "wsl" => {
            let distro = id.split_once(':').map(|(_, d)| d).unwrap_or("");
            let mut args: Vec<String> = Vec::new();
            if !distro.is_empty() {
                args.push("-d".into());
                args.push(distro.into());
            }
            args.push("--cd".into());
            args.push(match requested_cwd {
                // Workspace on the distro's own file share: --cd wants the
                // absolute Linux path, not the UNC \\wsl.localhost\… seen from
                // Windows.
                Some(c) if !c.trim().is_empty() => match wsl_unc_path(c) {
                    Some((d, linux)) if distro.is_empty() || d.eq_ignore_ascii_case(distro) => {
                        linux
                    }
                    _ => c.into(),
                },
                _ => "~".into(),
            });
            let home = std::env::var("USERPROFILE").ok();
            Some(ResolvedShellSpawn {
                file: "wsl.exe".into(),
                args,
                cwd: home,
                is_wsl: true,
            })
        }
        _ => None,
    }
}

/// PowerShell/pwsh arguments for the app's PTYs.
pub fn ps_bypass_args() -> Vec<String> {
    vec!["-ExecutionPolicy".into(), "Bypass".into()]
}

/// PowerShell arguments that run a remote connection command (ssh, SSM…) in
/// an interactive PTY: no profile, and the execution-policy bypass so a
/// machine with a Restricted policy still runs the `.ps1` npm shims.
pub fn ps_connect_args(command: &str) -> Vec<String> {
    let mut args = vec!["-NoLogo".to_string(), "-NoProfile".to_string()];
    args.extend(ps_bypass_args());
    args.extend(["-Command".to_string(), command.to_string()]);
    args
}

/// buildWslEnvValue — WSLENV that forwards the session's custom env
/// (PROMPTOPS_*, …) into the distro. Windows-path values with the /p flag;
/// PATH excluded (WSL appends the Windows one by itself).
///
/// `extra_env` = additional pairs set by the spawn (hook/attribution).
/// `verbatim_keys` = keys that must NOT get /p even if the value is a
/// Windows path: PROMPTOPS_WORKSPACE travels verbatim so hook payloads
/// report the same `C:\…` path the app knows the session by (a
/// translated /mnt/c/… would no longer match on the renderer side).
pub fn build_wsl_env_value(
    existing: Option<&str>,
    custom_env: Option<&std::collections::HashMap<String, String>>,
    extra_env: &[(String, String)],
    verbatim_keys: &[&str],
) -> Option<String> {
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    if let Some(env) = custom_env {
        for (k, v) in env {
            pairs.push((k.as_str(), v.as_str()));
        }
    }
    for (k, v) in extra_env {
        pairs.push((k.as_str(), v.as_str()));
    }
    pairs.retain(|(k, _)| *k != "PATH" && *k != "WSLENV");
    if pairs.is_empty() {
        return existing.map(str::to_string);
    }
    let mut entries: Vec<String> = Vec::new();
    if let Some(e) = existing {
        if !e.is_empty() {
            entries.push(e.to_string());
        }
    }
    for (k, v) in pairs {
        let b = v.as_bytes();
        let is_win_path = b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/');
        let translate = is_win_path && !verbatim_keys.contains(&k);
        entries.push(if translate {
            format!("{k}/p")
        } else {
            k.to_string()
        });
    }
    Some(entries.join(":"))
}

// ── Commands ──────────────────────────────────────────────────────────────

/// terminal-shells:list.
#[tauri::command]
pub async fn terminal_shells_list(force: Option<bool>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let shells = detect_windows_shells(force.unwrap_or(false));
        json!({ "ok": true, "shells": shells })
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "shells": [], "error": e.to_string() }))
}

/// terminal-shells:probe-provider — sweeps the provider CLI in every
/// detected shell, in parallel (one thread per shell).
#[tauri::command]
pub async fn terminal_shells_probe_provider(provider: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let command = provider_probe_command(&provider);
        let shells = detect_windows_shells(false);
        let Some(command) = command else {
            let results: Vec<Value> = shells
                .iter()
                .map(|s| json!({ "shellId": s.id, "installed": true }))
                .collect();
            return json!({ "ok": true, "provider": provider, "command": null, "results": results });
        };
        let handles: Vec<(String, std::thread::JoinHandle<bool>)> = shells
            .iter()
            .map(|s| {
                let shell_id = s.id.clone();
                let cmd = command.to_string();
                let id_for_thread = shell_id.clone();
                (
                    shell_id,
                    std::thread::spawn(move || probe_command_in_shell(&id_for_thread, &cmd)),
                )
            })
            .collect();
        let results: Vec<Value> = handles
            .into_iter()
            .map(|(shell_id, h)| {
                json!({ "shellId": shell_id, "installed": h.join().unwrap_or(false) })
            })
            .collect();
        json!({ "ok": true, "provider": provider, "command": command, "results": results })
    })
    .await
    .unwrap_or_else(
        |e| json!({ "ok": false, "command": null, "results": [], "error": e.to_string() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_connection_powershell_bypasses_the_execution_policy() {
        let args = ps_connect_args("ssh -t host");
        let policy = args.iter().position(|a| a == "-ExecutionPolicy").unwrap();
        let command = args.iter().position(|a| a == "-Command").unwrap();
        assert_eq!(args[policy + 1], "Bypass");
        assert!(policy < command, "options must come before -Command");
        assert_eq!(args.last().unwrap(), "ssh -t host");
        assert!(args.contains(&"-NoProfile".to_string()));
    }

    #[test]
    fn shell_probe_looks_for_the_binary_the_session_launches() {
        for provider in [
            "claude-code-cli",
            "codex",
            "gemini-cli",
            "antigravity",
            "copilot",
            "cursor",
            "grok",
            "hermes",
            "muse",
            "opencode",
            "kora",
        ] {
            assert_eq!(
                provider_probe_command(provider),
                crate::commands::session::provider_command(provider),
                "{provider}"
            );
        }
    }

    #[test]
    fn windows_to_wsl_path_translates_drive_paths() {
        assert_eq!(
            windows_to_wsl_path(
                r"C:\Users\alex\AppData\Roaming\promptops-oss\hooks\claude-notification.js"
            ),
            Some(
                "/mnt/c/Users/alex/AppData/Roaming/promptops-oss/hooks/claude-notification.js"
                    .into()
            )
        );
        assert_eq!(
            windows_to_wsl_path("D:/work/repo"),
            Some("/mnt/d/work/repo".into())
        );
        assert_eq!(windows_to_wsl_path(r"\\wsl$\Ubuntu\home\x"), None);
        assert_eq!(windows_to_wsl_path("relative/path"), None);
    }

    #[test]
    fn wsl_unc_path_parses_wsl_file_share_paths() {
        assert_eq!(
            wsl_unc_path(r"\\wsl.localhost\Ubuntu\home\alex\projects\acme-shop"),
            Some(("Ubuntu".into(), "/home/alex/projects/acme-shop".into()))
        );
        assert_eq!(
            wsl_unc_path(r"\\wsl$\Ubuntu-22.04\home\x\"),
            Some(("Ubuntu-22.04".into(), "/home/x".into()))
        );
        assert_eq!(
            wsl_unc_path("//WSL.LOCALHOST/Debian/srv"),
            Some(("Debian".into(), "/srv".into()))
        );
        assert_eq!(
            wsl_unc_path(r"\\wsl.localhost\Ubuntu"),
            Some(("Ubuntu".into(), "/".into()))
        );
        assert_eq!(wsl_unc_path(r"\\server\share\repo"), None);
        assert_eq!(wsl_unc_path(r"C:\work\repo"), None);
        assert_eq!(wsl_unc_path(r"\\wsl.localhost\"), None);
        assert_eq!(wsl_unc_path(""), None);
    }

    #[test]
    fn effective_shell_for_prefers_explicit_override() {
        // The per-session override always wins (even off-Windows, where
        // path inference is disabled).
        assert_eq!(
            effective_shell_for(Some("wsl:Ubuntu"), Some(r"C:\work")),
            Some("wsl:Ubuntu".into())
        );
        assert_eq!(
            effective_shell_for(Some("powershell"), Some(r"\\wsl$\Ubuntu\home")),
            Some("powershell".into())
        );
    }

    #[test]
    fn wsl_distro_of_extracts_distro() {
        assert_eq!(wsl_distro_of(Some("wsl:Ubuntu")), Some("Ubuntu".into()));
        assert_eq!(wsl_distro_of(Some("wsl")), Some("".into()));
        assert_eq!(wsl_distro_of(Some("powershell")), None);
        assert_eq!(wsl_distro_of(None), None);
    }

    #[test]
    fn build_wsl_env_value_forwards_extra_env_and_respects_verbatim() {
        let v = build_wsl_env_value(
            Some("EXISTING/p"),
            None,
            &[
                ("PROMPTOPS_HOOK_PORT".into(), "5123".into()),
                ("PROMPTOPS_WORKSPACE".into(), r"C:\work\repo".into()),
                ("PROMPTOPS_SESSION_ID".into(), "abc".into()),
            ],
            &["PROMPTOPS_WORKSPACE"],
        )
        .unwrap();
        assert_eq!(
            v,
            "EXISTING/p:PROMPTOPS_HOOK_PORT:PROMPTOPS_WORKSPACE:PROMPTOPS_SESSION_ID"
        );
    }

    #[test]
    fn build_wsl_env_value_still_translates_custom_paths() {
        let mut env = std::collections::HashMap::new();
        env.insert("MY_TOOL_HOME".to_string(), r"C:\tools\x".to_string());
        let v = build_wsl_env_value(None, Some(&env), &[], &[]).unwrap();
        assert_eq!(v, "MY_TOOL_HOME/p");
    }

    #[test]
    fn build_wsl_env_value_empty_returns_existing() {
        assert_eq!(
            build_wsl_env_value(Some("A"), None, &[], &[]),
            Some("A".into())
        );
        assert_eq!(build_wsl_env_value(None, None, &[], &[]), None);
    }
}
