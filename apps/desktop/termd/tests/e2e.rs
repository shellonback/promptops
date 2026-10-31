//! termd end-to-end: real server on a real socket, real PTYs.
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use interprocess::local_socket::{prelude::*, Stream};
use termd::client::{Client, Event};
use termd::proto::*;
use termd::server::{Server, ServerConfig, ServerHandle};

const T: Duration = Duration::from_secs(10);

fn temp_dir() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!(
        "termd-e2e-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&d);
    d
}

struct Running {
    dir: PathBuf,
    handle: ServerHandle,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.handle.stop();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start() -> Running {
    let dir = temp_dir();
    let server = Server::bind(ServerConfig {
        dir: dir.clone(),
        idle_exit: None,
        orphan_timeout: None,
    })
    .expect("bind");
    let handle = server.handle();
    std::thread::spawn(move || server.run());
    Running { dir, handle }
}

/// Program + arguments for a shell script, per platform.
fn shell(script: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        ("cmd.exe".into(), vec!["/C".into(), script.into()])
    } else {
        ("/bin/sh".into(), vec!["-c".into(), script.into()])
    }
}

fn env() -> Vec<(String, String)> {
    ["PATH", "SystemRoot", "TERM"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect()
}

fn spawn(c: &Client, id: &str, script: &str, cols: u16, rows: u16) {
    let (program, args) = shell(script);
    c.request(&Request::Spawn {
        id: id.into(),
        program,
        args,
        cwd: None,
        env: env(),
        cols,
        rows,
    })
    .unwrap();
    let ev = c.wait_for(T, |e| {
        matches!(
            e,
            Event::Reply(Reply::Spawned { .. }) | Event::Reply(Reply::Error { .. })
        )
    });
    assert!(
        matches!(ev, Some(Event::Reply(Reply::Spawned { .. }))),
        "spawn failed: {ev:?}"
    );
}

/// Visible text (snapshot + output) until the exit arrives or `until` shows up.
fn collect(c: &Client, until: Option<&str>) -> (String, Option<Option<u32>>) {
    let mut text = String::new();
    let deadline = std::time::Instant::now() + T;
    while std::time::Instant::now() < deadline {
        match c.events.recv_timeout(Duration::from_millis(100)) {
            Ok(Event::Replay { snapshot, .. }) => {
                text.push_str(&String::from_utf8_lossy(&snapshot))
            }
            Ok(Event::Output { data, .. }) => text.push_str(&String::from_utf8_lossy(&data)),
            Ok(Event::Reply(Reply::Exited { code, .. })) => return (text, Some(code)),
            Ok(Event::Closed) => break,
            _ => {}
        }
        if until.is_some_and(|u| text.contains(u)) {
            return (text, None);
        }
    }
    (text, None)
}

#[test]
fn spawn_attach_output_and_exit() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    spawn(&c, "a", "echo hello-termd", 80, 24);
    c.request(&Request::Attach { id: "a".into() }).unwrap();
    let (text, exit) = collect(&c, None);
    assert!(text.contains("hello-termd"), "{text:?}");
    assert_eq!(exit, Some(Some(0)));
}

#[test]
fn pty_outlives_client_and_reattach_gets_the_screen() {
    let s = start();
    let (script_first, script) = if cfg!(windows) {
        (
            "first",
            "echo first & ping -n 2 127.0.0.1 >NUL & echo second & ping -n 30 127.0.0.1 >NUL",
        )
    } else {
        ("first", "echo first; sleep 1; echo second; sleep 30")
    };
    {
        let a = Client::connect(&s.dir).unwrap();
        spawn(&a, "p", script, 80, 24);
        a.request(&Request::Attach { id: "p".into() }).unwrap();
        let (text, _) = collect(&a, Some(script_first));
        assert!(text.contains("first"));
        // The client goes away (app restart): the PTY must stay alive.
    }
    std::thread::sleep(Duration::from_millis(2500));
    let b = Client::connect(&s.dir).unwrap();
    b.request(&Request::List).unwrap();
    let Some(Event::Reply(Reply::List { ptys })) =
        b.wait_for(T, |e| matches!(e, Event::Reply(Reply::List { .. })))
    else {
        panic!("no list")
    };
    assert!(ptys.iter().any(|p| p.id == "p" && p.alive), "{ptys:?}");
    b.request(&Request::Attach { id: "p".into() }).unwrap();
    let Some(Event::Replay {
        snapshot,
        cols,
        rows,
        ..
    }) = b.wait_for(T, |e| matches!(e, Event::Replay { .. }))
    else {
        panic!("no snapshot")
    };
    let snap = String::from_utf8_lossy(&snapshot);
    assert!(
        snap.contains("first") && snap.contains("second"),
        "{snap:?}"
    );
    assert_eq!((cols, rows), (80, 24));
    b.request(&Request::Kill { id: "p".into() }).unwrap();
    let ev = b.wait_for(T, |e| matches!(e, Event::Reply(Reply::Exited { .. })));
    assert!(ev.is_some(), "kill without Exited");
}

#[test]
fn live_output_continues_exactly_from_the_snapshot_offset() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    let script = if cfg!(windows) {
        "for /L %i in (1,1,200) do @echo line-%i"
    } else {
        "i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done; sleep 0.5"
    };
    spawn(&c, "o", script, 80, 24);
    // A second client attaches to an already running stream: snapshot + live are contiguous.
    let c = Client::connect(&s.dir).unwrap();
    c.request(&Request::Attach { id: "o".into() }).unwrap();
    let mut expected: Option<u64> = None;
    let deadline = std::time::Instant::now() + T;
    while std::time::Instant::now() < deadline {
        match c.events.recv_timeout(Duration::from_millis(200)) {
            Ok(Event::Replay { end_offset, .. }) => expected = Some(end_offset),
            Ok(Event::Output { offset, data, .. }) => {
                let exp = expected.expect("output before the snapshot");
                assert_eq!(offset, exp, "gap or duplicate in the stream");
                expected = Some(exp + data.len() as u64);
            }
            Ok(Event::Reply(Reply::Exited { .. })) => break,
            _ => {}
        }
    }
    assert!(expected.is_some_and(|n| n > 0));
}

#[test]
fn input_reaches_the_process() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    let script = if cfg!(windows) {
        "set /p x= & echo got:%x%"
    } else {
        "read x; echo got:$x"
    };
    spawn(&c, "i", script, 80, 24);
    c.request(&Request::Attach { id: "i".into() }).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    c.input("i", b"abc\r").unwrap();
    let (text, _) = collect(&c, Some("got:abc"));
    assert!(text.contains("got:abc"), "{text:?}");
}

#[cfg(unix)]
#[test]
fn resize_reaches_the_process() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    spawn(&c, "r", "sleep 0.5; stty size", 80, 24);
    c.request(&Request::Resize {
        id: "r".into(),
        cols: 100,
        rows: 30,
    })
    .unwrap();
    c.request(&Request::Attach { id: "r".into() }).unwrap();
    let (text, _) = collect(&c, Some("30 100"));
    assert!(text.contains("30 100"), "{text:?}");
}

#[test]
fn wrong_token_gets_no_bytes_at_all() {
    let s = start();
    let name = termd::paths::socket_name(&s.dir).unwrap();
    let conn = Stream::connect(name).unwrap();
    conn.set_recv_timeout(Some(Duration::from_secs(3))).unwrap();
    let hello = encode_control(&Request::Hello {
        version: PROTOCOL_VERSION,
        token: "0".repeat(64),
    });
    (&conn).write_all(&hello).unwrap();
    let mut buf = [0u8; 16];
    let n = (&conn).read(&mut buf).unwrap_or(0);
    assert_eq!(n, 0, "the server replied to a wrong token");
}

#[test]
fn silent_connection_gets_no_bytes_and_is_closed() {
    let s = start();
    let conn = Stream::connect(termd::paths::socket_name(&s.dir).unwrap()).unwrap();
    conn.set_recv_timeout(Some(Duration::from_secs(8))).unwrap();
    let mut buf = [0u8; 16];
    let n = (&conn).read(&mut buf).unwrap_or(0);
    assert_eq!(n, 0);
}

#[test]
fn version_mismatch_is_refused_cleanly() {
    let s = start();
    let token = termd::paths::read_token(&s.dir).unwrap();
    let conn = Stream::connect(termd::paths::socket_name(&s.dir).unwrap()).unwrap();
    conn.set_recv_timeout(Some(Duration::from_secs(3))).unwrap();
    (&conn)
        .write_all(&encode_control(&Request::Hello {
            version: 999,
            token,
        }))
        .unwrap();
    let mut fr = FrameReader::default();
    let ReadOutcome::Frame(kind, payload) = fr.next(&mut &conn).unwrap() else {
        panic!("no reply")
    };
    assert_eq!(kind, KIND_CONTROL);
    assert!(matches!(
        serde_json::from_slice::<Reply>(&payload).unwrap(),
        Reply::Error { .. }
    ));
}

#[test]
fn second_server_on_the_same_dir_is_refused() {
    let s = start();
    let err = Server::bind(ServerConfig {
        dir: s.dir.clone(),
        idle_exit: None,
        orphan_timeout: None,
    })
    .err()
    .expect("double instance");
    assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    // And the first one still works (token not rewritten).
    assert!(Client::connect(&s.dir).is_ok());
}

#[test]
fn missing_cwd_is_a_clear_error() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    let (program, args) = shell("echo x");
    c.request(&Request::Spawn {
        id: "c".into(),
        program,
        args,
        cwd: Some("/definitely/not/here".into()),
        env: env(),
        cols: 80,
        rows: 24,
    })
    .unwrap();
    let ev = c.wait_for(T, |e| matches!(e, Event::Reply(_)));
    assert!(
        matches!(ev, Some(Event::Reply(Reply::Error { .. }))),
        "{ev:?}"
    );
}

#[cfg(unix)]
#[test]
fn private_files_on_unix() {
    use std::os::unix::fs::PermissionsExt;
    let s = start();
    let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(s.dir.clone()), 0o700);
    assert_eq!(mode(termd::paths::token_path(&s.dir)), 0o600);
}

/// A client that never reads, under a continuous stream: the server drops it
/// (bounded memory) and stays responsive for the others meanwhile.
#[cfg(unix)]
#[test]
fn slow_client_is_dropped_and_others_keep_working() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    spawn(
        &c,
        "f",
        "yes 0123456789012345678901234567890123456789",
        200,
        50,
    );

    let token = termd::paths::read_token(&s.dir).unwrap();
    let slow = Stream::connect(termd::paths::socket_name(&s.dir).unwrap()).unwrap();
    (&slow)
        .write_all(&encode_control(&Request::Hello {
            version: PROTOCOL_VERSION,
            token,
        }))
        .unwrap();
    (&slow)
        .write_all(&encode_control(&Request::Attach { id: "f".into() }))
        .unwrap();

    // The slow client does not read: after a few seconds the server must have dropped it.
    std::thread::sleep(Duration::from_secs(4));
    c.request(&Request::List).unwrap();
    assert!(
        c.wait_for(T, |e| matches!(e, Event::Reply(Reply::List { .. })))
            .is_some(),
        "server no longer responsive"
    );
    // While draining, the slow client must reach EOF (connection closed), not read forever.
    slow.set_recv_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0usize;
    let closed = loop {
        match (&slow).read(&mut buf) {
            Ok(0) => break true,
            Ok(n) => total += n,
            Err(_) => break false,
        }
        if total > 512 * 1024 * 1024 {
            break false;
        }
    };
    assert!(
        closed,
        "the slow client was not disconnected ({total} bytes read)"
    );
    c.request(&Request::Kill { id: "f".into() }).unwrap();
}

/// App crashed and never reopened: with no clients, after the timeout the PTYs
/// are closed and termd exits (agents do not run forever on their own).
#[cfg(unix)]
#[test]
fn orphaned_ptys_are_killed_after_the_timeout() {
    let dir = temp_dir();
    let server = Server::bind(ServerConfig {
        dir: dir.clone(),
        idle_exit: None,
        orphan_timeout: Some(Duration::from_secs(1)),
    })
    .unwrap();
    let done = std::thread::spawn(move || server.run());
    let pid = {
        let c = Client::connect(&dir).unwrap();
        let (program, args) = shell("sleep 60");
        c.request(&Request::Spawn {
            id: "z".into(),
            program,
            args,
            cwd: None,
            env: env(),
            cols: 80,
            rows: 24,
        })
        .unwrap();
        match c.wait_for(T, |e| matches!(e, Event::Reply(Reply::Spawned { .. }))) {
            Some(Event::Reply(Reply::Spawned { pid, .. })) => pid.expect("pid"),
            other => panic!("{other:?}"),
        }
        // The client goes away (app crash).
    };
    let deadline = std::time::Instant::now() + T;
    while !done.is_finished() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(done.is_finished(), "termd did not exit");
    // The child must no longer be alive (kill -0 fails).
    std::thread::sleep(Duration::from_millis(300));
    // SAFETY: kill with signal 0 only checks that the process exists.
    let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
    assert!(!alive, "the orphaned process is still alive");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The spawner receives all output from byte 0, without Attach (this was the
/// bug that left the app's agents stuck on "spawning").
#[test]
fn spawner_receives_output_from_the_first_byte() {
    let s = start();
    let c = Client::connect(&s.dir).unwrap();
    spawn(&c, "s", "echo from-spawn", 80, 24);
    let mut first: Option<u64> = None;
    let mut text = String::new();
    let deadline = std::time::Instant::now() + T;
    while std::time::Instant::now() < deadline {
        match c.events.recv_timeout(Duration::from_millis(100)) {
            Ok(Event::Output { offset, data, .. }) => {
                first.get_or_insert(offset);
                text.push_str(&String::from_utf8_lossy(&data));
            }
            Ok(Event::Replay { .. }) => panic!("no snapshot without Attach"),
            Ok(Event::Reply(Reply::Exited { .. })) => break,
            _ => {}
        }
    }
    assert_eq!(first, Some(0), "output does not start at the first byte");
    assert!(text.contains("from-spawn"), "{text:?}");
}
