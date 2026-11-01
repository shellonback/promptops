// Tauri commands take many arguments and the managers keep callback types
// inline; these lints are style preferences we do not enforce.
#![allow(
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::large_enum_variant,
    clippy::doc_lazy_continuation,
    clippy::doc_overindented_list_items
)]

// Keep this before commands so every diagnostic eprintln! uses best-effort I/O.
#[macro_use]
mod logging;

/// Folder name of the app's data (under Application Support, AppData or
/// ~/.local/share). Distinct from PromptOps Desktop, so both editions can be
/// installed side by side without sharing any file.
pub(crate) const APP_DIR_NAME: &str = "promptops-oss";

mod commands;
mod demo_mode;
mod detached_window;
mod diagnostics;
#[cfg(target_os = "linux")]
mod linux_env;
mod local_backup;
mod local_data;
mod local_data_more;
mod local_store;
mod plugins;
mod security_selftest;
mod vault;

use std::sync::Arc;

pub use tauri::Manager;

// On macOS AppKit delivers mouseMoved to the first responder: if the WKWebView
// loses that role (cmd-tab, devtools, tao paths that promote the container
// view) the CSS cursor stops updating and stays an arrow even
// over links/buttons — known bug wry#175/#1333, no upstream fix (wry 0.55).
// Re-establishing the webview as first responder restores the pointer.
#[cfg(target_os = "macos")]
fn ensure_webview_first_responder(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|pw| unsafe {
        // with_webview runs on the main thread; inner() is the WKWebView (NSView).
        let view = &*(pw.inner() as *const objc2_app_kit::NSView);
        if let Some(ns_window) = view.window() {
            let responder: &objc2_app_kit::NSResponder = view;
            ns_window.makeFirstResponder(Some(responder));
            // Without acceptsMouseMovedEvents AppKit does NOT deliver mouseMoved:
            // the WKWebView never recomputes the CSS cursor while the pointer
            // moves (fixed arrow, resize cursor not showing on the splitter).
            ns_window.setAcceptsMouseMovedEvents(true);
            // Rebuilds the view's tracking area + cursor rects.
            view.updateTrackingAreas();
            ns_window.invalidateCursorRectsForView(view);
        }
        objc2_app_kit::NSCursor::setHiddenUntilMouseMoves(false);
    });
}

// Green (traffic light) button on macOS: the AppKit default for a
// Titled+Resizable window is `toggleFullScreen:`, i.e. the dedicated full-screen
// space — not the classic "zoom/restore" the user expects
// from the maximize button. Here the green button goes back to zooming.
//
// Real fullscreen does NOT go away: it stays under View → Enter Full Screen
// (Ctrl+Cmd+F, see commands::menu). And if the window IS in fullscreen the green
// button must go back to `toggleFullScreen:`, otherwise there would be no way out
// with the mouse from the auto-hiding titlebar: hence the `zoom` parameter.
#[cfg(target_os = "macos")]
fn set_green_button_action(win: &tauri::Window, zoom: bool) {
    let win = win.clone();
    // AppKit APIs must be touched on the main thread: window events already
    // arrive there, but the first pass (setup) and the retries do not.
    let _ = win.clone().run_on_main_thread(move || {
        let Ok(ptr) = win.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        unsafe {
            let ns_window = &*(ptr as *const objc2_app_kit::NSWindow);
            let Some(button) =
                ns_window.standardWindowButton(objc2_app_kit::NSWindowButton::ZoomButton)
            else {
                return;
            };
            button.setTarget(Some(ns_window));
            button.setAction(Some(if zoom {
                objc2::sel!(zoom:)
            } else {
                objc2::sel!(toggleFullScreen:)
            }));
        }
    });
}

/// Realigns the green button with the current fullscreen state. Both transitions
/// (enter/exit) go through a `Resized`, which however also arrives in bursts
/// during manual resizing: the applied state is remembered so we don't
/// bounce into AppKit on every frame.
#[cfg(target_os = "macos")]
fn sync_green_button(win: &tauri::Window) {
    use std::sync::atomic::{AtomicI8, Ordering};
    // A single app window ("main"): global state is enough.
    static LAST_APPLIED: AtomicI8 = AtomicI8::new(-1);
    if win.label() != "main" {
        return;
    }
    let zoom = !win.is_fullscreen().unwrap_or(false);
    let next = i8::from(zoom);
    if LAST_APPLIED.swap(next, Ordering::Relaxed) == next {
        return;
    }
    set_green_button_action(win, zoom);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Script injected before the Angular bootstrap in EVERY app window (main and detached).
pub(crate) fn init_script(app: &tauri::AppHandle) -> String {
    let intel_mac = cfg!(all(target_os = "macos", target_arch = "x86_64"));
    // Real OS for `promptops.platform`: the WebKitGTK userAgent pretends to be
    // Safari on Mac, so on Linux the bridge believed it was running on macOS
    // (plain Ctrl+C/Ctrl+V went to the PTY instead of copying/pasting).
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };
    format!(
        "window.__PROMPTOPS_APP_VERSION__ = \"{}\";\nwindow.__PROMPTOPS_INTEL_MAC__ = {};\nwindow.__PROMPTOPS_OS__ = \"{}\";\n{}{}",
        app.package_info().version,
        intel_mac,
        os,
        demo_mode::init_script(),
        include_str!("promptops_bridge.js")
    )
}

/// Where an app window (main, detached) may navigate. The app is a single page: a link without
/// `target="_blank"` (agent output, a plugin's text, a markdown preview) must never replace the
/// app with a remote site that keeps the window, its menu and `window.__TAURI__`. Allowed: the
/// app's own origin (`tauri://localhost`, `http(s)://tauri.localhost` on Windows, the dev server
/// in debug builds), `about:`/`data:`/`blob:` documents of frames, and local servers framed by the
/// ports panel (`http://localhost:*`, `http://127.0.0.1:*`, the same origins the CSP `frame-src`
/// allows). Anything else is refused; http, https and mailto open in the system browser instead.
pub(crate) fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        ),
        _ => false,
    }
}

/// `on_navigation` handler of the app windows: see [`navigation_allowed`].
pub(crate) fn guard_navigation(url: &tauri::Url) -> bool {
    if navigation_allowed(url) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let target = url.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = commands::shell::shell_open_external(target).await;
        });
    }
    eprintln!(
        "[navigation] refused {}://{}",
        url.scheme(),
        url.host_str().unwrap_or("")
    );
    false
}

pub fn run() {
    // Demo mode (debug only, PROMPTOPS_DEMO=1): sandbox HOME before anything else.
    demo_mode::apply();
    // Before GTK/WebKit and any other thread (fb AppImage Fedora COLRv1).
    #[cfg(target_os = "linux")]
    linux_env::apply();
    // `attach` is the identity in release; in debug + PROMPTOPS_SECURITY_SELFTEST=1
    // it mounts the webview containment self-test (see security_selftest.rs).
    security_selftest::attach(tauri::Builder::default())
        // Plugin JS init scripts never run in the capability-less plugin host
        // webview (see plugins::host::NotInPluginHost).
        .plugin(plugins::host::NotInPluginHost(tauri_plugin_shell::init()))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(plugins::host::NotInPluginHost(tauri_plugin_dialog::init()))
        .plugin(plugins::host::WithoutInitScript(
            tauri_plugin_notification::init(),
        ))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // No updater plugin: the open-source edition is updated from GitHub Releases.
        // Voice push-to-talk: global Alt+M (registered in setup if enabled).
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    commands::voice::handle_voice_shortcut_event(app, shortcut, event);
                })
                .build(),
        )
        // Native application menu. On macOS it REPLACES the default one:
        // build_app_menu includes the predefined items (copy/paste/cut/select_all),
        // without which Cmd+C/V would die across the whole webview.
        .menu(commands::menu::build_app_menu_or_default)
        .on_menu_event(|app, event| {
            // The application menu and the tray menu share this handler:
            // the tray takes its own ids and the rest goes to the menu.
            if commands::tray::handle_menu_event(app, &event) {
                return;
            }
            commands::menu::handle_menu_event(app, event);
        })
        // --- State managers (one pool/registry per domain) ---
        .manage(commands::dialogs::CloseConfirmationState::default())
        .manage(Arc::new(commands::terminal::TerminalManager::new()))
        .manage(Arc::new(commands::browser::BrowserMirrorManager::new()))
        .manage(Arc::new(commands::session::SessionManager::new()))
        .manage(Arc::new(commands::fs::WatchManager::new()))
        .manage(Arc::new(commands::git_watch::GitWatchManager::new()))
        .manage(Arc::new(commands::subagent::SubAgentManager::new()))
        .manage(Arc::new(commands::subagent_review::ReviewManager::default()))
        .manage(Arc::new(commands::ssh::SshManager::new()))
        .manage(Arc::new(commands::remote::RemotePool::new()))
        .manage(Arc::new(
            commands::provider_account::ProviderAccountManager::new(),
        ))
        .manage(Arc::new(commands::db::DbManager::new()))
        .manage(commands::git_setup::shared_agent_env())
        .manage(Arc::new(commands::voice::VoiceShortcutManager::new()))
        .manage(Arc::new(commands::hook::HookManager::new()))
        .manage(Arc::new(commands::folder_access::FolderAccessMonitor::new()))
        .manage(Arc::new(commands::interaction::InteractionManager::new()))
        .manage(Arc::new(commands::workspace::FocusManager::new()))
        .manage(Arc::new(commands::workspace::DeviceWorkspaceState::new()))
        .manage(Arc::new(commands::profile::ProfileManager::new()))
        .manage(Arc::new(commands::metrics::TokenTracker::new()))
        .manage(Arc::new(commands::metrics::UsageAggregator::new()))
        .manage(Arc::new(commands::metrics::ProviderUsageProbe::new()))
        .manage(Arc::new(commands::metrics::FileReadCache::new()))
        .manage(Arc::new(commands::system_info::StorageManagerState::new()))
        .manage(Arc::new(commands::system_info::BackgroundTaskManager::new()))
        .manage(Arc::new(commands::smart_context::SmartActionCache::new()))
        .manage(Arc::new(commands::smart_context::SharedContextStore::new()))
        .manage(Arc::new(commands::smart_context::DesktopStateStore::new()))
        .manage(Arc::new(
            commands::smart_context::ContextSnapshotEngine::new(),
        ))
        .manage(Arc::new(commands::assets_ext::ExtensionsState::new()))
        .manage(Arc::new(commands::assets_ext::FccConfigState::new()))
        .manage(Arc::new(commands::semantic::EmbeddingEngine::new()))
        .manage(Arc::new(commands::semantic::CodeGraph::new()))
        .manage(Arc::new(commands::semantic::SessionMemory::new()))
        .manage(Arc::new(commands::update::UpdateManager::new()))
        .manage(commands::providers::ProviderRegistryState::new())
        .manage(plugins::PluginRuntime::new())
        // Plugin channel: answers only the `plugin-host` webview (see plugins/host.rs).
        .register_asynchronous_uri_scheme_protocol(plugins::SCHEME, plugins::host::handle)
        .invoke_handler(tauri::generate_handler![
            diagnostics::diagnostics_report,
            // detached windows (Floor plan, Teams) and return to the main one
            detached_window::open_detached_window,
            detached_window::focus_main_window,
            detached_window::open_session_window,
            detached_window::close_session_window,
            commands::output_watchers::session_output_watch,
            commands::term_host::session_output_attach,
            commands::term_state::term_vt_replay_set,
            commands::termd_link::termd_set_enabled,
            commands::output_watchers::subagent_output_watch,
            // plugins (third-party runtime, sandbox + broker)
            plugins::commands::plugin_runtime_list,
            plugins::commands::plugin_runtime_install,
            plugins::commands::plugin_runtime_uninstall,
            plugins::commands::plugin_runtime_set_enabled,
            plugins::commands::plugin_runtime_get_config,
            plugins::commands::plugin_runtime_set_config,
            plugins::commands::plugin_runtime_apply_registry_status,
            plugins::commands::plugin_runtime_audit,
            plugins::commands::plugin_runtime_set_developer_mode,
            plugins::commands::plugin_runtime_link_local,
            plugins::commands::plugin_runtime_run_action,
            plugins::commands::plugin_runtime_invoke,
            plugins::commands::plugin_runtime_emit_event,
            plugins::commands::plugin_runtime_grant_repo,
            plugins::commands::plugin_runtime_confirm,
            plugins::studio::plugin_studio_prepare,
            plugins::studio::plugin_studio_changes,
            plugins::studio::plugin_studio_run_tests,
            // assets_ext
            commands::assets_ext::assets_list,
            commands::assets_ext::assets_upload,
            commands::assets_ext::assets_delete,
            commands::assets_ext::assets_rename,
            commands::assets_ext::assets_read,
            commands::assets_ext::assets_read_base64,
            commands::assets_ext::assets_import_from_url,
            commands::assets_ext::assets_import_paths,
            commands::assets_ext::assets_open_folder,
            commands::assets_ext::remote_fetch_file,
            commands::assets_ext::download_url_to_downloads,
            commands::assets_ext::remote_outbox_collect,
            commands::assets_ext::remote_bridge_setup,
            commands::assets_ext::remote_bridge_remove,
            commands::assets_ext::extensions_catalog_list,
            commands::assets_ext::extensions_materialize,
            commands::assets_ext::extensions_installed,
            commands::assets_ext::extensions_local_skills,
            commands::assets_ext::fcc_config_get,
            commands::assets_ext::fcc_config_save,
            commands::assets_ext::fcc_config_test,
            commands::assets_ext::fcc_config_catalog,
            // auth
            commands::device::access_control_get_device_id,
            local_store::local_store_key_source,
            local_backup::local_backup_export,
            local_backup::local_backup_import,
            local_backup::local_backup_pick_file,
            // db
            commands::db::db_detect,
            commands::db::db_connect,
            commands::db::db_list_configs,
            commands::db::db_switch_config,
            commands::db::db_delete_config,
            commands::db::db_tables,
            commands::db::db_query,
            commands::db::db_nl_query,
            commands::db::db_manual_connect,
            commands::db::db_disconnect,
            // dev_links
            commands::dev_links::dev_links_scan,
            commands::dev_links::dev_links_open,
            commands::dev_links::dev_links_default_browser,
            // ports (VS Code-style Forward Ports)
            commands::ports::ports_list,
            commands::ports::ports_forward,
            commands::ports::ports_stop,
            // docker
            commands::docker::docker_ps,
            // folder_access (TCC macOS)
            commands::folder_access::folder_access_check,
            commands::folder_access::folder_access_retry,
            commands::folder_access::folder_access_open_settings,
            commands::folder_access::folder_access_reset_permissions,
            commands::folder_access::folder_access_relaunch,
            // fs
            commands::fs::fs_list_dir,
            commands::fs::fs_list_dir_shallow,
            commands::fs::fs_read_file,
            commands::fs::fs_read_file_base64,
            commands::fs::fs_write_file,
            commands::fs::fs_search_files,
            commands::fs::fs_search_paths,
            commands::fs::fs_search_content,
            commands::fs::fs_delete,
            commands::fs::fs_rename,
            commands::fs::fs_new_file,
            commands::fs::fs_new_folder,
            commands::fs::fs_duplicate,
            commands::fs::fs_watch_start,
            commands::fs::fs_watch_stop,
            // git
            commands::git::git_status,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_diff,
            commands::git::git_stash,
            commands::git::git_stash_pop,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_exec,
            commands::git::git_list_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_file_diff,
            commands::git::git_file_at_head,
            commands::git::git_log,
            commands::git::git_show,
            commands::git::git_commit_files,
            commands::git::git_commit_file_diff,
            commands::git::git_conflict_files,
            commands::git::git_resolve_conflict,
            commands::git::git_generate_branch_name,
            commands::git::git_generate_commit_msg,
            commands::git::git_discover_repos,
            commands::git::git_clone,
            commands::git::git_merge,
            commands::git::git_merge_abort,
            commands::git::git_ai_resolve_sync,
            commands::git::git_cherry_pick,
            commands::git::git_revert,
            commands::git::git_rebase,
            commands::git::git_reset,
            commands::git::git_delete_branch,
            commands::git::git_rename_branch,
            commands::git::git_commit_amend,
            commands::git::git_fetch,
            commands::git::git_ahead_behind,
            commands::git::git_tag,
            commands::git::git_remote_url,
            commands::git::git_show_file_base64,
            // git_setup
            commands::git_setup::git_setup_diagnose,
            commands::git_setup::git_setup_list_keys,
            commands::git_setup::git_setup_generate_key,
            commands::git_setup::git_setup_save_key,
            commands::git_setup::git_setup_start_agent,
            commands::git_setup::git_setup_add_key,
            commands::git_setup::git_setup_list_agent_keys,
            commands::git_setup::git_setup_set_identity,
            commands::git_setup::git_setup_convert_remote,
            commands::git_setup::git_setup_test_connection,
            commands::git_setup::git_setup_set_pref,
            // hook
            commands::hook::hook_start,
            commands::hook::hook_get_port,
            commands::hook::hook_write_settings,
            commands::hook::hook_cleanup_settings,
            commands::hook::hook_uninstall_integrations,
            // interaction
            commands::cursor::set_native_cursor,
            commands::interaction::interaction_list,
            commands::interaction::interaction_respond,
            commands::interaction::interaction_create_input,
            commands::interaction::interaction_create_action,
            commands::interaction::auto_approve_get,
            commands::interaction::auto_approve_set,
            commands::interaction::tailer_inject,
            // metrics
            commands::metrics::token_get_stats,
            commands::metrics::token_get_all_stats,
            commands::metrics::token_record_usage,
            commands::metrics::token_set_flags,
            commands::metrics::token_request_compact,
            commands::metrics::optimization_get_status,
            commands::metrics::optimization_refresh_context,
            commands::metrics::optimization_get_file_cache,
            commands::metrics::usage_get_summary,
            commands::metrics::usage_export,
            commands::metrics::usage_clear,
            commands::metrics::usage_run_scan,
            commands::metrics::provider_usage_get,
            commands::metrics::provider_usage_get_all,
            commands::metrics::provider_usage_probe,
            // profile
            commands::profile::profile_list,
            commands::profile::profile_get,
            commands::profile::profile_create,
            commands::profile::profile_update,
            commands::profile::profile_delete,
            // provider_account
            commands::provider_account::provider_account_list,
            commands::provider_account::provider_account_list_by_provider,
            commands::provider_account::provider_account_get,
            commands::provider_account::provider_account_get_active,
            commands::provider_account::provider_account_set_active,
            commands::provider_account::provider_account_create,
            commands::provider_account::provider_account_duplicate,
            commands::provider_account::provider_account_rename,
            commands::provider_account::provider_account_update,
            commands::provider_account::provider_account_delete,
            commands::provider_account::provider_account_open_folder,
            commands::provider_account::provider_account_import,
            commands::provider_account::provider_account_capabilities,
            // providers
            commands::providers::providers_list,
            commands::providers::providers_detect,
            commands::providers::providers_models,
            commands::providers::ai_generate_text,
            // semantic
            commands::semantic::knowledge_index,
            commands::semantic::knowledge_query,
            commands::semantic::knowledge_find_path,
            commands::semantic::knowledge_impact_analysis,
            commands::semantic::knowledge_stats,
            commands::semantic::knowledge_overview,
            commands::semantic::memory_add,
            commands::semantic::memory_search,
            commands::semantic::memory_search_files,
            commands::semantic::memory_resolve,
            commands::semantic::memory_stats,
            commands::semantic::memory_prune,
            commands::semantic::semantic_index,
            commands::semantic::semantic_search,
            commands::semantic::semantic_search_brief,
            commands::semantic::semantic_status,
            // session
            commands::session::session_create,
            commands::session::session_status_subscribe,
            commands::session::session_destroy,
            commands::session::session_list,
            commands::session::session_get,
            commands::session::session_current_model,
            commands::session::session_write,
            commands::session::session_switch_provider,
            commands::session::session_handoff_context,
            commands::session::session_resize,
            commands::session::session_rename,
            commands::session::session_update_meta,
            commands::session::session_buffer,
            commands::session::session_standby,
            commands::session::session_wake,
            commands::session::auto_standby_get_config,
            commands::session::auto_standby_set_config,
            commands::session::session_profile_get_active,
            commands::session::session_profile_set_active,
            commands::session::session_apply_account_to_workspace,
            commands::session::session_account_check,
            commands::session::session_prepare_account_relaunch,
            commands::session::app_set_terminal_detection,
            commands::session::app_set_terminal_safe_mode,
            // speedtest
            commands::speedtest::speedtest_list_models,
            commands::speedtest::speedtest_run,
            commands::speedtest::speedtest_abort,
            // browser (Browser page: real Chrome via CDP)
            commands::browser::browser_chrome_status,
            commands::browser::browser_chrome_launch,
            commands::browser::browser_chrome_open_tab,
            commands::browser::browser_chrome_close_tab,
            commands::browser::browser_chrome_activate_tab,
            commands::browser::browser_mirror_start,
            commands::browser::browser_mirror_send,
            commands::browser::browser_mirror_stop,
            commands::browser::browser_integration_probe,
            commands::browser::browser_profile_import_extension,
            commands::browser::browser_terminal_cwd,
            commands::browser::browser_window_mirror_start,
            commands::browser::browser_window_mirror_stop,
            commands::browser::browser_chrome_focus,
            // windows_shells
            commands::windows_shells::terminal_shells_list,
            commands::windows_shells::terminal_shells_set_default,
            commands::windows_shells::terminal_shells_probe_provider,
            commands::session::provider_check,
            // shell
            commands::shell::shell_show_in_folder,
            commands::shell::shell_open_terminal,
            commands::shell::clipboard_write,
            commands::shell::clipboard_read,
            commands::shell::clipboard_write_image,
            commands::shell::clipboard_read_image,
            commands::shell::installer_write_script,
            commands::shell::drag_drop_paths,
            commands::shell::editor_detect,
            commands::shell::editor_open,
            commands::shell::shell_open_external,
            // smart_context
            commands::smart_context::smart_action_detect,
            commands::smart_context::smart_action_execute,
            commands::smart_context::smart_action_commands,
            commands::smart_context::smart_action_scan_folders,
            commands::smart_context::smart_action_run_terminal,
            commands::smart_context::intent_generate_plan,
            commands::smart_context::intent_enhance_prompt,
            commands::smart_context::shared_context_get,
            commands::smart_context::shared_context_patch,
            commands::smart_context::shared_context_clear,
            commands::smart_context::shared_context_get_pref,
            commands::smart_context::shared_context_set_pref,
            commands::smart_context::context_snapshot_generate,
            commands::smart_context::context_snapshot_status,
            commands::smart_context::context_snapshot_get,
            commands::smart_context::context_snapshot_refresh,
            commands::smart_context::context_snapshot_provider_summary,
            // remote sessions (SSH, beta)
            commands::remote::remote_list_dir,
            commands::remote::remote_home_dir,
            commands::remote::remote_create_folder,
            commands::remote::remote_check_provider,
            commands::remote::remote_test_connection,
            commands::remote::remote_cmd_list_dir,
            commands::remote::remote_cmd_create_folder,
            commands::remote::remote_probe,
            commands::remote::remote_shell_exec,
            // ssh
            commands::ssh::ssh_list,
            commands::ssh::ssh_save,
            commands::ssh::ssh_delete,
            commands::ssh::ssh_test,
            commands::ssh::ssh_spawn,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_close,
            commands::ssh::ssh_list_active,
            // subagent
            commands::subagent_review::subagent_review_request,
            commands::subagent_review::subagent_review_list,
            commands::subagent_review::subagent_review_cancel,
            commands::subagent::subagent_spawn,
            commands::subagent::subagent_output_channel,
            commands::subagent::subagent_spawn_request,
            commands::subagent::bridge_debug,
            commands::subagent::subagent_destroy,
            commands::subagent::subagent_list,
            commands::subagent::subagent_list_all,
            commands::subagent::subagent_write,
            commands::subagent::subagent_switch_provider,
            commands::subagent::subagent_buffer,
            commands::subagent::subagent_resize,
            commands::subagent::subagent_list_archived,
            commands::subagent::subagent_clear_archived,
            commands::subagent::subagent_worker_transcript,
            commands::subagent::subagent_worker_send,
            commands::subagent::subagent_worker_cancel,
            commands::goal_loop::subagent_goal_state,
            commands::goal_loop::subagent_goal_stop,
            commands::agents::agents_meta_get,
            commands::agents::agents_set_lead,
            commands::agents::agents_set_order,
            commands::agents::agents_close_lead,
            commands::agents::agents_reopen_lead,
            commands::agents::agents_clear_lead_closed_all,
            commands::subagent::subagent_get_suggestions,
            commands::subagent::subagent_restore_stash,
            // system_info
            commands::system_info::storage_audit,
            commands::system_info::storage_cleanup,
            commands::system_info::storage_get_last_audit,
            commands::system_info::diagnostics_memory,
            commands::system_info::hardware_scan,
            commands::system_info::background_task_update,
            commands::system_info::background_task_list,
            // terminal
            commands::terminal::terminal_open,
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_list,
            commands::terminal::terminal_buffer, // menu (native chrome)
            commands::menu::menu_apply_labels,
            commands::menu::menu_refresh_recents,
            commands::menu::menu_popup,
            // notify (system notifications + dock badge)
            commands::notify::notify_native,
            commands::notify::notify_set_badge,
            commands::notify::notify_set_labels,
            // local data (sessions, workspaces, prompts… kept on this device)
            local_data::local_call,
            // git_watch (event-driven git status instead of the 15s poll)
            commands::git_watch::git_watch_start,
            commands::git_watch::git_watch_stop,
            // dialogs (destructive confirmations / system error box)
            commands::dialogs::dialog_confirm,
            commands::dialogs::dialog_set_close_labels,
            commands::dialogs::dialog_error,
            // update
            commands::update::update_check,
            commands::update::update_download,
            commands::update::update_install,
            commands::update::update_get_status,
            commands::update::update_open_manual_download,
            // voice
            commands::voice::voice_check_mic,
            commands::voice::voice_open_mic_settings,
            commands::voice::voice_get_api_key,
            commands::voice::voice_set_api_key,
            commands::voice::voice_test_api_key,
            commands::voice::voice_transcribe,
            commands::voice::voice_hotkey_toggle,
            commands::voice::voice_hotkey_cancel,
            commands::voice::voice_get_shortcut_config,
            commands::voice::voice_set_shortcut_config,
            commands::voice::voice_open_system_settings,
            commands::voice_local::voice_local_model_status,
            commands::voice_local::voice_local_model_download,
            // workspace
            commands::workspace::workspace_select,
            commands::workspace::workspace_recent,
            commands::workspace::device_workspace_get,
            commands::workspace::device_workspace_list,
            commands::workspace::device_workspace_upsert,
            commands::workspace::device_workspace_update,
            commands::workspace::device_workspace_delete,
            commands::workspace::device_workspace_migrate,
            commands::workspace::device_workspace_validate_path,
            commands::workspace::desktop_state_save,
            commands::workspace::desktop_state_get,
            commands::workspace::app_get_auto_launch,
            commands::workspace::app_set_auto_launch,
            commands::workspace::focus_get_active,
            commands::workspace::focus_set_active,
            commands::workspace::workspace_create_folder,
            commands::workspace::workspace_context_file_check,
            commands::workspace::workspace_context_policy_set,
            commands::workspace::project_brief_collect,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    commands::dialogs::confirm_app_close(window);
                }
            }
            // System notifications fire ONLY when the window is not focused:
            // this keeps that flag up to date (see commands::notify).
            if let tauri::WindowEvent::Focused(focused) = event {
                commands::notify::set_window_focused(*focused);
            }
            // Entering/exiting fullscreen goes through a Resized: that is where the
            // green button gets remapped (zoom outside, exit inside).
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                sync_green_button(window);
            }
            // TCC self-heal: re-probe (debounced) when the window comes back
            // into focus — the user typically returns from System Settings.
            if let tauri::WindowEvent::Focused(true) = event {
                let app = window.app_handle().clone();
                let monitor = app
                    .state::<Arc<commands::folder_access::FolderAccessMonitor>>()
                    .inner()
                    .clone();
                commands::folder_access::on_window_focus(&app, &monitor);
                // Regaining focus (cmd-tab) is the classic trigger for the
                // webview losing first responder → arrow cursor.
                #[cfg(target_os = "macos")]
                if let Some(win) = app.get_webview_window(window.label()) {
                    ensure_webview_first_responder(&win);
                }
                // Safety net: if a fullscreen transition went through
                // without a useful Resized, regaining focus realigns the green button.
                #[cfg(target_os = "macos")]
                sync_green_button(window);
            }
        })
        .setup(|app| {
            diagnostics::init(app.handle());
            commands::notify::bootstrap(app.handle());
            commands::promptops_cli::install(&app.path().app_data_dir()?.join("cli"))
                .map_err(std::io::Error::other)?;
            // ── Hook server ↔ manager wiring ──
            // The resolvers must be registered BEFORE the first hook arrives.
            let hook = app
                .state::<Arc<commands::hook::HookManager>>()
                .inner()
                .clone();
            let sessions = app
                .state::<Arc<commands::session::SessionManager>>()
                .inner()
                .clone();
            let subagents = app
                .state::<Arc<commands::subagent::SubAgentManager>>()
                .inner()
                .clone();
            let interactions = app
                .state::<Arc<commands::interaction::InteractionManager>>()
                .inner()
                .clone();

            // Voice shortcut: config persisted from disk (without this load the
            // "saved" toggle disappeared on every restart) + Alt+M registration.
            {
                let vsm = app
                    .state::<Arc<commands::voice::VoiceShortcutManager>>()
                    .inner()
                    .clone();
                vsm.load_from_disk(app.handle());
                commands::voice::apply_voice_shortcut_registration(
                    app.handle(),
                    vsm.get_config().enabled,
                );
            }

            // Load the saved global selection before restored sessions can spawn.
            app.state::<Arc<commands::provider_account::ProviderAccountManager>>()
                .ensure_init(app.handle())
                .map_err(std::io::Error::other)?;

            // Provider account → env at spawn.
            commands::provider_account::set_global_manager(
                app.state::<Arc<commands::provider_account::ProviderAccountManager>>()
                    .inner()
                    .clone(),
            );

            {
                let sa = subagents.clone();
                hook.set_resolve_parent_fn(Arc::new(move |sid| {
                    sa.resolve_parent_session(sid)
                        .unwrap_or_else(|| sid.to_string())
                }));
            }
            {
                let sa = subagents.clone();
                hook.set_resolve_sub_agent_fn(Arc::new(move |sid| sa.resolve_sub_agent_id(sid)));
            }
            {
                let sm = sessions.clone();
                hook.set_resolve_name_fn(Arc::new(move |sid| {
                    sm.display_name(sid)
                        .unwrap_or_else(|| sid.chars().take(8).collect())
                }));
            }
            {
                let sm = sessions.clone();
                hook.set_update_status_fn(Arc::new(move |sid, status| sm.set_status(sid, status)));
            }
            {
                let sm = sessions.clone();
                hook.set_set_claude_session_fn(Arc::new(move |sid, csid| {
                    sm.set_claude_session_id(sid, csid)
                }));
            }
            hook.set_auto_approve_check_fn(Arc::new(move |sid| {
                interactions.auto_approve_enabled(sid)
            }));

            // Prompt-count flusher ALWAYS armed at boot: lazy arming on
            // create_session left restored-only runs (restart + wake)
            // without periodic flushes to the local store.
            sessions.ensure_sync_timer();

            // TokenTracker flush timer (15s): auto-finalize + fallback
            // estimate from output.
            {
                let tracker = app
                    .state::<Arc<commands::metrics::TokenTracker>>()
                    .inner()
                    .clone();
                let app_for_flush = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    tracker.flush_tick(&app_for_flush);
                });
            }

            // ProviderUsageProbe → TokenTracker (token-based snapshot).
            app.state::<Arc<commands::metrics::ProviderUsageProbe>>()
                .set_token_tracker(
                    app.state::<Arc<commands::metrics::TokenTracker>>()
                        .inner()
                        .clone(),
                );

            // Start the hook server at boot (before the window).
            if let Err(err) = commands::hook::hook_start(
                app.handle().clone(),
                app.state::<Arc<commands::hook::HookManager>>(),
            ) {
                eprintln!("[hook] start failed: {err}");
            }

            // TurnRunner (headless stream-json turns of sub-agent workers).
            commands::turn_runner::set_global(Arc::new(commands::turn_runner::TurnRunner::new()));

            // SessionTailer (auto-approve): DI + 500ms tick. Consumes
            // output from the tap (no .tail file, no fs polling).
            {
                let tailer = Arc::new(commands::session_tailer::SessionTailer::new());
                let ia_flags = app
                    .state::<Arc<commands::interaction::InteractionManager>>()
                    .inner()
                    .clone();
                let ia_disable = ia_flags.clone();
                let sm_inject = sessions.clone();
                let sa_inject = subagents.clone();
                tailer.set_deps(
                    Arc::new(move |sid| ia_flags.get_flags(sid)),
                    Arc::new(move |app, sid| {
                        ia_disable.set_flags(
                            app,
                            sid,
                            commands::interaction::AutoApproveFlags::default(),
                        );
                    }),
                    // Inject without counting: the credit for the auto-approved turn
                    // happens in the tailer itself (tailer:auto-approved). The tailer
                    // also watches sub-agent PTYs (keyed by subAgentId) →
                    // fallback to SubAgentManager when the id is not a session.
                    Arc::new(move |sid, data| {
                        if sm_inject.write(sid, data, false).is_err() {
                            let _ = sa_inject.write_to(sid, data, false);
                        }
                    }),
                );
                commands::session_tailer::set_global(tailer.clone());
                let app_for_tick = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(
                        commands::session_tailer::POLL_MS,
                    ));
                    tailer.tick_all(&app_for_tick);
                });
            }

            // Sub-agent prompt credit → parent session.
            {
                let sessions_credit = sessions.clone();
                subagents.set_credit_fn(Arc::new(move |parent_id, n| {
                    sessions_credit.increment_prompt_count(parent_id, n);
                }));
            }

            // Output tap on session PTYs: token estimate fallback and the
            // session tailer (context for auto-approve).
            {
                let tracker_tap = app
                    .state::<Arc<commands::metrics::TokenTracker>>()
                    .inner()
                    .clone();
                let tailer_tap = commands::session_tailer::global_tailer()
                    .expect("tailer initialized before the tap")
                    .clone();
                sessions.set_output_tap(Arc::new(move |sid, chunk| {
                    // session:output → accumulator for the fallback estimate.
                    tracker_tap.record_output(sid, chunk.len() as i64);
                    // SessionTailer: context/delta for auto-approve.
                    tailer_tap.on_output(sid, chunk);
                }));
            }

            // Folder-access TCC (macOS): DI + revocation watcher.
            {
                let monitor = app
                    .state::<Arc<commands::folder_access::FolderAccessMonitor>>()
                    .inner()
                    .clone();
                let sm_roots = sessions.clone();
                monitor.set_session_roots_fn(Arc::new(move || {
                    sm_roots
                        .list()
                        .into_iter()
                        .filter(|s| s.standby_at.is_none())
                        .filter_map(|s| s.workspace.map(|w| w.path))
                        .collect()
                }));
                let sm_wake = sessions.clone();
                let app_for_wake = app.handle().clone();
                monitor.set_wake_parked_fn(Arc::new(move || {
                    // Wake all standby sessions.
                    // TODO: track the TCC-parked sessions as a separate set and
                    // wake only those.
                    let parked: Vec<String> = sm_wake
                        .list()
                        .into_iter()
                        .filter(|s| s.standby_at.is_some())
                        .map(|s| s.id)
                        .collect();
                    for id in &parked {
                        commands::session::wake_without_renderer(&app_for_wake, &sm_wake, id);
                    }
                    parked
                }));
                commands::folder_access::set_global(monitor.clone());
                commands::folder_access::start_watcher(app.handle().clone(), monitor);
            }

            // Auto-standby scheduler: parks inactive sessions after
            // the configured grace period.
            commands::session::start_auto_standby_scheduler(
                app.handle().clone(),
                sessions.clone(),
                subagents.clone(),
                app.state::<Arc<commands::workspace::FocusManager>>()
                    .inner()
                    .clone(),
            );

            // Activity monitor (1 s tick): in_progress ⇄ idle from the PTY output
            // of sessions and sub-agents — the only way to close a turn
            // without a Stop hook (Codex, Gemini, shell, lost hooks).
            commands::session::start_activity_monitor(
                app.handle().clone(),
                sessions.clone(),
                subagents.clone(),
            );

            // Open the encrypted local store before anything reads sessions.
            {
                let service = format!("{}.session-vault", app.config().identifier);
                if let Err(err) = local_store::init(&commands::hook::hook_data_dir(), &service) {
                    eprintln!("[local-store] cannot open the local store: {err}");
                }
            }

            // Restore sessions from the local store (lazy boot: no PTY until
            // the session is reopened). Dedicated thread, off the main thread.
            {
                let sessions_for_restore = sessions.clone();
                let device_ws = app
                    .state::<Arc<commands::workspace::DeviceWorkspaceState>>()
                    .inner()
                    .clone();
                let app_for_restore = app.handle().clone();
                std::thread::spawn(move || {
                    // Active profile persisted per device (API header + restore scope).
                    let profile_id = commands::session::read_active_profile();
                    sessions_for_restore.set_active_profile_id(profile_id.clone());
                    let device_id = commands::device::get_or_create_device_id();
                    sessions_for_restore.set_api_device_id(device_id.clone());
                    device_ws.set_device_id(Some(device_id));
                    let n = sessions_for_restore.restore_from_store();
                    // Gate opened RIGHT after the restore (before the pre-warm):
                    // from here session_list sees the restored ones with the local id.
                    sessions_for_restore.mark_boot_restore_done();
                    // Pre-warm of the check_provider cache (only `which` via
                    // login shell, no CLI launched): the first wake after
                    // boot does not pay the seconds of login-shell dotfiles.
                    {
                        let mut providers: Vec<String> = sessions_for_restore
                            .list()
                            .into_iter()
                            .map(|s| s.provider)
                            .collect();
                        providers.sort();
                        providers.dedup();
                        std::thread::spawn(move || {
                            for p in providers {
                                let _ = commands::session::check_provider(&p);
                            }
                        });
                    }
                    if n > 0 {
                        eprintln!("[SessionManager] restored {n} session(s) from the local store");
                        // The restore runs alongside the webview boot. If the renderer already
                        // loaded the (empty) list, this emit makes it redo
                        // clearSessions+loadSessions via the same channel as the
                        // profile switch — so the restored ones appear parked with
                        // the local id and wake/--resume works.
                        use tauri::Emitter;
                        let _ = app_for_restore.emit(
                            "session-profile:changed",
                            serde_json::json!({ "activeProfileId": profile_id }),
                        );
                    }
                });
            }

            // Injects the `window.promptops` bridge BEFORE the Angular bootstrap
            // (initialization_script runs before page scripts), so the
            // webapp runs in desktop mode.
            // The native version (tauri.conf.json) must be exposed BEFORE the bridge:
            // the webapp uses it as APP_VERSION.
            // Intel Mac (dual GPU): with external monitors the Radeon stays
            // always on and compositing backdrop-filter + infinite
            // animations slows down all of WindowServer. index.html reads it and enables
            // the same fallbacks as WebKitGTK.
            let bridge = init_script(app.handle());
            #[allow(unused_mut)]
            let mut win_builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("PromptOps")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(900.0, 600.0)
                    // wry's drag-drop handler consumes EVERY drag on the webview
                    // (including internal HTML5 DnD, e.g. sessions→folders) and file
                    // drops never reach the DOM. Disabled: the webview
                    // handles drags natively; native paths come from the drag
                    // pasteboard via the `drag_drop_paths` command (see bridge).
                    .disable_drag_drop_handler()
                    .on_navigation(guard_navigation)
                    .initialization_script(bridge);
            #[cfg(target_os = "macos")]
            if demo_mode::enabled() {
                win_builder = win_builder.data_store_identifier(demo_mode::DATA_STORE_ID);
            }

            // Titlebar: we stay on the default `TitleBarStyle::Visible`, i.e. the
            // full system bar. The overlay (traffic lights over the webview,
            // hidden title) was tried and withdrawn: without a real bar
            // the double click that resizes the window also disappears, and the
            // draggable strip that replaced it was covered by the traffic lights
            // themselves. If retried, it needs a ~30px FULL-width strip
            // with `data-tauri-drag-region` and the content pushed below.

            let _win = win_builder.build()?;

            // Plugin runtime: loads the index and opens the host webview only if
            // at least one plugin is active.
            if let Ok(data_dir) = app.path().app_data_dir() {
                let rt = app.state::<Arc<plugins::PluginRuntime>>().inner().clone();
                rt.init(data_dir.join("plugins"));
                // Debug builds only: links a local folder at startup for end-to-end tests.
                #[cfg(debug_assertions)]
                // Multiple folders are separated by a comma.
                for dir in std::env::var("PROMPTOPS_PLUGIN_DEV_LINK")
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                {
                    match plugins::commands::link_local(app.handle(), &rt, dir) {
                        Ok(p) => {
                            eprintln!("[plugins] dev link: {} {}", p.plugin_id, p.version);
                            // PROMPTOPS_PLUGIN_DEV_INVOKE="method:[JSON arguments]" calls the
                            // section contract as soon as the plugin is ready, and prints the result.
                            // PROMPTOPS_PLUGIN_DEV_SCRIPT=<file.json> does the same for several steps in a row:
                            // `[["open", ["writer", {}]], ["event", ["writer", {...}]]]`.
                            // PROMPTOPS_PLUGIN_DEV_GRANT=<folder> grants a repository first: its
                            // handle replaces `{{repo}}` in the arguments.
                            let mut steps: Vec<(String, String)> = Vec::new();
                            if let Ok(spec) = std::env::var("PROMPTOPS_PLUGIN_DEV_INVOKE") {
                                let (method, args) =
                                    spec.split_once(':').unwrap_or((spec.as_str(), "[]"));
                                steps.push((method.to_string(), args.to_string()));
                            }
                            if let Some(list) = std::env::var("PROMPTOPS_PLUGIN_DEV_SCRIPT")
                                .ok()
                                .and_then(|f| std::fs::read(f).ok())
                                .and_then(|b| {
                                    serde_json::from_slice::<Vec<(String, serde_json::Value)>>(&b)
                                        .ok()
                                })
                            {
                                steps.extend(list.into_iter().map(|(m, a)| (m, a.to_string())));
                            }
                            if !steps.is_empty() {
                                let (app_h, rt_h) = (app.handle().clone(), rt.clone());
                                tauri::async_runtime::spawn(async move {
                                    for _ in 0..60 {
                                        if rt_h.contributions.lock().contains_key(&p.plugin_id) {
                                            break;
                                        }
                                        tokio::time::sleep(std::time::Duration::from_millis(500))
                                            .await;
                                    }
                                    eprintln!(
                                        "[plugins] dev contributions: {}",
                                        rt_h.contributions
                                            .lock()
                                            .get(&p.plugin_id)
                                            .cloned()
                                            .unwrap_or_default()
                                    );
                                    let mut handle = String::new();
                                    if let Ok(dir) = std::env::var("PROMPTOPS_PLUGIN_DEV_GRANT") {
                                        match plugins::native::resolve_repo(&dir).await {
                                            Ok((root, name)) => {
                                                handle = rt_h.grant_repo(&p.plugin_id, root, name)
                                            }
                                            Err(e) => eprintln!("[plugins] dev grant fallito: {e}"),
                                        }
                                    }
                                    for (method, args) in steps {
                                        let args: serde_json::Value = serde_json::from_str(
                                            &args.replace("{{repo}}", &handle),
                                        )
                                        .unwrap_or(serde_json::json!([]));
                                        let out = plugins::host::invoke(
                                            &app_h,
                                            &rt_h,
                                            &p.plugin_id,
                                            &p.category,
                                            &method,
                                            &args,
                                        )
                                        .await;
                                        let text = match out {
                                            Ok(v) => format!("OK {v}"),
                                            Err(e) => format!("ERR {e}"),
                                        };
                                        eprintln!(
                                            "[plugins] dev invoke {}.{method}: {}",
                                            p.category,
                                            text.chars().take(4000).collect::<String>()
                                        );
                                    }
                                });
                            }
                        }
                        Err(e) => eprintln!("[plugins] dev link fallito: {e}"),
                    }
                }
                plugins::host::sync(app.handle());
            }

            // Tray: on Linux it depends on libayatana-appindicator and may fail.
            // It is not critical — the app starts anyway, without an icon.
            if let Err(err) = commands::tray::setup(app.handle()) {
                eprintln!("[tray] unavailable: {err}");
            }
            #[cfg(target_os = "linux")]
            linux_env::tune_webview(&_win);
            #[cfg(target_os = "macos")]
            {
                ensure_webview_first_responder(&_win);
                // The green button starts as "zoom": the window always starts non-fullscreen.
                set_green_button_action(&_win.as_ref().window(), true);
                // In setup the NSWindow is often not on-screen yet: there
                // makeFirstResponder is a silent no-op and the cursor stays an
                // arrow until cmd-tab. Second pass after the first
                // paint (main thread, the webview is attached by then).
                let retry_win = _win.clone();
                std::thread::spawn(move || {
                    for delay_ms in [300u64, 1200, 3000] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        let w = retry_win.clone();
                        let _ = retry_win.run_on_main_thread(move || {
                            ensure_webview_first_responder(&w);
                            // Same reason: in setup the standard titlebar buttons
                            // may not exist yet.
                            let win = w.as_ref().window();
                            let zoom = !win.is_fullscreen().unwrap_or(false);
                            set_green_button_action(&win, zoom);
                        });
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Persist all state: before quitting, drains the
            // prompt-counts and batch-persists sessions + archived sub-agents
            // to the local store (source of truth). Blocking but quick:
            // the store is a local encrypted file.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle
                    .state::<Arc<commands::metrics::TokenTracker>>()
                    .checkpoint_all(app_handle);
                let sessions = app_handle
                    .state::<Arc<commands::session::SessionManager>>()
                    .inner()
                    .clone();
                let subagents = app_handle
                    .state::<Arc<commands::subagent::SubAgentManager>>()
                    .inner()
                    .clone();
                sessions.flush_prompt_counts();
                // On-disk buffer BEFORE the persist: on next boot the
                // restored sessions restart with the last screen (no black
                // terminal during the provider's resume).
                sessions.persist_live_buffers_to_disk();
                let subs = subagents.archived_snapshot_json();
                let _ = sessions.save_all_to_store(&subs);
                // Normal quit: agents in termd stop like the in-process ones
                // (no-op with the flag off or during the restart for an update).
                commands::termd_link::shutdown_on_exit();
            }
        });
}

#[cfg(test)]
mod navigation_tests {
    use super::navigation_allowed;

    #[test]
    fn app_windows_never_navigate_to_a_remote_site() {
        for ok in [
            "tauri://localhost/index.html#/admin/sessions",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "http://localhost:4200/",
            "http://127.0.0.1:5173/app",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(navigation_allowed(&ok.parse().unwrap()), "{ok}");
        }
        for bad in [
            "https://evil.example/phish",
            "http://localhost.evil.example/",
            "https://tauri.localhost.evil.example/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:a@b.c",
            "ftp://localhost/",
            "http://10.0.0.1/",
        ] {
            assert!(!navigation_allowed(&bad.parse().unwrap()), "{bad}");
        }
    }

    /// The ports panel previews local servers over http or https; the CSP
    /// must allow exactly those frame origins and nothing broader.
    #[test]
    fn csp_frames_only_local_servers_over_http_and_https() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let frame_src = conf["app"]["security"]["csp"]["frame-src"]
            .as_str()
            .unwrap();
        let mut sources: Vec<&str> = frame_src.split_whitespace().collect();
        sources.sort_unstable();
        assert_eq!(
            sources,
            [
                "http://127.0.0.1:*",
                "http://localhost:*",
                "https://127.0.0.1:*",
                "https://localhost:*"
            ]
        );
        for src in sources {
            assert!(navigation_allowed(
                &src.replace(":*", ":8443").parse().unwrap()
            ));
        }
    }
}
