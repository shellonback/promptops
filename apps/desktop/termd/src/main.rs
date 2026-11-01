//! `promptops-termd serve --dir <folder> [--idle-exit-secs N] [--orphan-timeout-secs N]`
//! `promptops-termd version`
use std::path::PathBuf;
use std::time::Duration;

use termd::server::{Server, ServerConfig};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version") => println!("{}", termd::proto::PROTOCOL_VERSION),
        Some("serve") => {
            let mut dir: Option<PathBuf> = None;
            let mut idle: Option<Duration> = None;
            let mut orphan: Option<Duration> = None;
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--dir" => dir = it.next().map(PathBuf::from),
                    "--idle-exit-secs" => idle = it.next().and_then(|v| v.parse().ok()).map(Duration::from_secs),
                    "--orphan-timeout-secs" => orphan = it.next().and_then(|v| v.parse().ok()).map(Duration::from_secs),
                    other => fail(&format!("unknown argument: {other}")),
                }
            }
            let Some(dir) = dir else { fail("missing --dir") };
            // The app launches us detached from its session; to be safe, a
            // SIGHUP from the originating terminal must not close the PTYs.
            #[cfg(unix)]
            // SAFETY: changes the SIGHUP disposition at startup, before any threads.
            unsafe {
                libc::signal(libc::SIGHUP, libc::SIG_IGN);
            }
            match Server::bind(ServerConfig { dir, idle_exit: idle, orphan_timeout: orphan }) {
                Ok(server) => {
                    eprintln!("[termd] ready (pid {}, protocol {})", std::process::id(), termd::proto::PROTOCOL_VERSION);
                    if let Err(e) = server.run() {
                        fail(&e.to_string());
                    }
                }
                // Already running: not an error, the app connects to that one.
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    eprintln!("[termd] already running");
                    std::process::exit(3);
                }
                Err(e) => fail(&e.to_string()),
            }
        }
        _ => fail("usage: promptops-termd serve --dir <folder> [--idle-exit-secs N] [--orphan-timeout-secs N] | version"),
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("[termd] {msg}");
    std::process::exit(2);
}
