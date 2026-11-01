//! Detached windows: a section of the app (Floor plan) or one session in a window of its own, to
//! drag to another screen. They load the SAME web app as the main window, with the same startup
//! script: the web app recognizes the `detached-*` label and starts a minimal shell, without the
//! global services (agent control plane) that must run once, in the main window.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Section → (webapp route, title, width, height). Only these: no URLs chosen by the page.
fn section(kind: &str) -> Option<(&'static str, &'static str, f64, f64)> {
    match kind {
        "floor-plan" => Some((
            "index.html#/floor-plan",
            "Floor plan — PromptOps",
            1180.0,
            780.0,
        )),
        _ => None,
    }
}

/// Opens the section window, or brings the already open one to the front.
#[tauri::command]
pub fn open_detached_window(app: AppHandle, kind: String) -> Result<(), String> {
    let (route, title, w, h) = section(&kind).ok_or("unknown section")?;
    open(
        &app,
        &format!("detached-{kind}"),
        route.to_string(),
        title.to_string(),
        w,
        h,
    )
}

/// Session id accepted in the label and the route: no characters that escape the path.
fn session_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A session in its own top-level window: no sidebar, when closed everything returns to the main one.
#[tauri::command]
pub fn open_session_window(app: AppHandle, session_id: String, name: String) -> Result<(), String> {
    if !session_id_ok(&session_id) {
        return Err("invalid session id".into());
    }
    let title: String = format!(
        "{} — PromptOps",
        name.chars()
            .filter(|c| !c.is_control())
            .take(60)
            .collect::<String>()
    );
    open(
        &app,
        &format!("detached-session-{session_id}"),
        format!("index.html#/session/{session_id}"),
        title,
        1100.0,
        760.0,
    )
}

/// "Bring back here": the main window closes the session window (on close it resumes the terminals).
#[tauri::command]
pub fn close_session_window(app: AppHandle, session_id: String) -> Result<(), String> {
    if !session_id_ok(&session_id) {
        return Err("invalid session id".into());
    }
    if let Some(win) = app.get_webview_window(&format!("detached-session-{session_id}")) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn open(
    app: &AppHandle,
    label: &str,
    route: String,
    title: String,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        let _ = win.show();
        return win.set_focus().map_err(|e| e.to_string());
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
        .title(title)
        .inner_size(w, h)
        .min_inner_size(520.0, 420.0)
        .disable_drag_drop_handler()
        .on_navigation(crate::guard_navigation)
        .initialization_script(crate::init_script(app));
    // Never a child of the main window: on macOS a child window stays stuck to its parent's
    // Space and cannot be moved to another virtual desktop.
    #[cfg(target_os = "macos")]
    if crate::demo_mode::enabled() {
        builder = builder.data_store_identifier(crate::demo_mode::DATA_STORE_ID);
        // "Two screens" recordings: the child window opens on the screen to the right of the
        // main one's (the virtual screen next to it), never on the user's monitor.
        if let Some(mon) = app
            .get_webview_window("main")
            .and_then(|m| m.current_monitor().ok().flatten())
        {
            let (p, s, k) = (mon.position(), mon.size(), mon.scale_factor());
            builder = builder.position(
                (p.x as f64 + s.width as f64) / k + 80.0,
                p.y as f64 / k + 60.0,
            );
        }
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    // Closed: no more output copies for it, and the main window knows (it resumes the session).
    let closed_label = label.to_string();
    let app_for_close = app.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            crate::commands::output_watchers::forget_window(&closed_label);
            let _ = app_for_close.emit(
                "detached:closed",
                serde_json::json!({ "label": closed_label }),
            );
        }
    });
    Ok(())
}

/// A detached window opened something in the main one (a session from the floor plan):
/// the main window comes back to the front.
#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let _ = win.unminimize();
    let _ = win.show();
    win.set_focus().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::section;

    #[test]
    fn session_ids_stay_inside_the_route() {
        assert!(super::session_id_ok("3f2a-91_bc"));
        for bad in ["", "../x", "a/b", "a#b", "a b", "x?y=1"] {
            assert!(!super::session_id_ok(bad), "{bad}");
        }
    }

    #[test]
    fn only_known_sections_open() {
        assert!(section("floor-plan").is_some());
        for bad in ["", "sessions", "teams", "../x", "https://evil.example"] {
            assert!(section(bad).is_none(), "{bad}");
        }
    }
}
