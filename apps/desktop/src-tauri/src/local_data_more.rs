//! Local data, part two: your local profile and preferences, the personal
//! Prompt Library, sidebar shortcuts, session action slots and notes.
//!
//! See `local_data.rs` for the entry point and the error codes.

use serde_json::{json, Value};

use crate::local_data::{
    has, invalid, is_live, live, not_found, now_iso, s, storage_error, validate_required, Ctx,
    LocalError, LocalResult, LOCAL_USER_ID, SESSIONS,
};
use crate::local_store::LocalStore;

const USER: &str = "user";
const USER_ID: &str = "me";
const PROMPTS: &str = "prompts";
const PROMPT_VERSIONS: &str = "prompt_versions";
const CATEGORIES: &str = "prompt_categories";
const TAGS: &str = "prompt_tags";
const SHORTCUTS: &str = "menu_shortcuts";
const SLOTS: &str = "action_slots";
const NOTES: &str = "notes";

const MAX_SHORTCUTS: usize = 15;
const MAX_SLOTS: usize = 30;

const PROVIDERS: &[&str] = &[
    "claude-code-cli",
    "codex",
    "gemini-cli",
    "antigravity",
    "copilot",
    "cursor",
    "grok",
    "hermes",
    "muse",
    "zai",
    "kimi",
    "opencode",
    "kora",
    "promptops-cli",
    "generic-shell",
];

/// Methods of this file; `None` when the name is not one of them.
pub(crate) fn dispatch(ctx: &Ctx, method: &str) -> Option<LocalResult> {
    Some(match method {
        // ── Local profile and preferences ──
        "user.me" => Ok(user_view(ctx.store)),
        "user.updateUiPreferences" => ui_preferences(ctx),
        "user.setPreferredProvider" => preferred_provider(ctx),
        "user.completeOnboarding" => onboarding_complete(ctx),

        // ── Personal Prompt Library ──
        "prompts.list" => prompt_list(ctx),
        "prompts.get" => prompt_get(ctx),
        "prompts.create" => prompt_create(ctx),
        "prompts.update" => prompt_update(ctx),
        "prompts.delete" => prompt_delete(ctx),
        "prompts.versions" => prompt_versions(ctx),
        "prompts.restoreVersion" => prompt_restore(ctx),
        "prompts.toggleStar" => prompt_toggle_star(ctx),
        "promptCategories.list" => category_list(ctx),
        "promptCategories.create" => category_create(ctx),
        "promptTags.list" => {
            let mut tags = ctx.store.list(TAGS);
            tags.sort_by_key(|a| s(a, "name"));
            Ok(Value::Array(tags))
        }
        "promptTags.create" => tag_create(ctx),

        // ── Sidebar shortcuts and session action slots ──
        "shortcuts.list" => shortcut_list(ctx),
        "shortcuts.create" => shortcut_create(ctx),
        "shortcuts.update" => shortcut_update(ctx),
        "shortcuts.reorder" => shortcut_reorder(ctx),
        "shortcuts.delete" => delete_hard(ctx, SHORTCUTS, "Shortcut"),
        "actionSlots.list" => slot_list(ctx),
        "actionSlots.create" => slot_create(ctx),
        "actionSlots.reorder" => slot_reorder(ctx),
        "actionSlots.delete" => slot_delete(ctx),

        // ── Personal notes on a session or file ──
        "notes.list" => note_list(ctx),
        "notes.create" => note_create(ctx),
        "notes.delete" => delete_hard(ctx, NOTES, "Note"),

        _ => return None,
    })
}

// ───────────────────────────── local profile ─────────────────────────────
//
// A local install has one user: you. The record holds your display name, UI
// preferences and onboarding state.

/// Full name of the OS account (macOS `id -F`, the GECOS field on Linux), or
/// the login name with a capital letter. Looked up once per run: until the
/// profile is first saved, every prompt and note listed builds the user view,
/// and each lookup started a process.
fn os_display_name() -> (String, String) {
    static NAME: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    NAME.get_or_init(read_os_display_name).clone()
}

fn read_os_display_name() -> (String, String) {
    let login = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let full = full_name_of(&login).unwrap_or_default();
    let full = full.trim();
    if !full.is_empty() {
        let mut parts = full.splitn(2, ' ');
        let first = parts.next().unwrap_or("").to_string();
        let last = parts.next().unwrap_or("").trim().to_string();
        return (first, last);
    }
    let mut chars = login.chars();
    match chars.next() {
        Some(c) => (c.to_uppercase().chain(chars).collect(), String::new()),
        None => ("You".to_string(), String::new()),
    }
}

fn full_name_of(login: &str) -> Option<String> {
    if login.is_empty() {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let out = crate::commands::util_cmd::cmd("id")
            .arg("-F")
            .arg(login)
            .output()
            .ok()?;
        return out
            .status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let out = crate::commands::util_cmd::cmd("getent")
            .arg("passwd")
            .arg(login)
            .output()
            .ok()?;
        let line = String::from_utf8_lossy(&out.stdout).to_string();
        return line
            .split(':')
            .nth(4)
            .map(|gecos| gecos.split(',').next().unwrap_or("").to_string());
    }
    #[allow(unreachable_code)]
    None
}

fn default_user() -> Value {
    let (first_name, last_name) = os_display_name();
    let now = now_iso();
    json!({
        "id": LOCAL_USER_ID,
        "first_name": first_name,
        "last_name": last_name,
        "email": "local@localhost",
        "username": null,
        "is_guest": false,
        "ui_preferences": null,
        "onboarding_completed_at": null,
        "onboarding_interest": null,
        "preferred_provider": null,
        "created_at": now,
        "updated_at": now,
    })
}

fn stored_user(store: &LocalStore) -> Value {
    store.get(USER, USER_ID).unwrap_or_else(default_user)
}

/// The user as the UI reads it. Every feature of this build is available, so
/// the plan reads as PRO; there is no admin role.
fn user_view(store: &LocalStore) -> Value {
    let mut u = stored_user(store);
    let full_name = format!(
        "{} {}",
        s(&u, "first_name").unwrap_or_default(),
        s(&u, "last_name").unwrap_or_default()
    )
    .trim()
    .to_string();
    let extra = json!({
        "full_name": full_name,
        "avatar_url": null,
        "is_pro": true,
        "pro_remaining_days": 9999,
        "role_id": 2,
        "role": { "id": 2, "name": "user" },
        "platforms_list": [],
        "desktop_app_version": null,
        "total_hours": 0,
        "ui_version": 2,
        "is_banned": false,
        "deleted_at": null,
    });
    for (k, v) in extra.as_object().into_iter().flatten() {
        u[k] = v.clone();
    }
    u
}

fn save_user(store: &LocalStore, user: &Value) -> Result<(), LocalError> {
    let mut record = user.clone();
    record["id"] = json!(LOCAL_USER_ID);
    record["updated_at"] = json!(now_iso());
    store.put(USER, USER_ID, record).map_err(storage_error)
}

/// `user.updateUiPreferences` — theme, fonts, sidebar size, UI style. Returns the user.
fn ui_preferences(ctx: &Ctx) -> LocalResult {
    const KEYS: &[&str] = &[
        "theme",
        "font_family",
        "font_size",
        "terminal_font_family",
        "terminal_font_size",
        "terminal_cursor_style",
        "terminal_line_height",
        "sidebar_size",
        "ui_style",
    ];
    let mut user = stored_user(ctx.store);
    let mut prefs = user["ui_preferences"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for key in KEYS {
        if let Some(v) = ctx.params.get(*key) {
            if v.is_null() {
                return Err(invalid(format!("{key} cannot be empty.")));
            }
            prefs.insert((*key).to_string(), v.clone());
        }
    }
    user["ui_preferences"] = Value::Object(prefs);
    save_user(ctx.store, &user)?;
    Ok(user_view(ctx.store))
}

/// `user.setPreferredProvider` — `{ provider }` (null clears it).
fn preferred_provider(ctx: &Ctx) -> LocalResult {
    let provider = ctx.params.get("provider").cloned().unwrap_or(Value::Null);
    if let Some(p) = provider.as_str() {
        if !PROVIDERS.contains(&p) {
            return Err(invalid(format!("Unknown provider: {p}.")));
        }
    }
    let mut user = stored_user(ctx.store);
    user["preferred_provider"] = provider.clone();
    save_user(ctx.store, &user)?;
    Ok(json!({ "preferred_provider": provider }))
}

/// `user.completeOnboarding` — `{ interest }`.
fn onboarding_complete(ctx: &Ctx) -> LocalResult {
    let interest = ctx.params.get("interest").cloned().unwrap_or(Value::Null);
    if let Some(i) = interest.as_str() {
        if !["sessions", "prompts", "teams", "explore"].contains(&i) {
            return Err(invalid(format!("Unknown interest: {i}.")));
        }
    }
    let mut user = stored_user(ctx.store);
    if user["onboarding_completed_at"].is_null() {
        user["onboarding_completed_at"] = json!(now_iso());
    }
    user["onboarding_interest"] = interest.clone();
    save_user(ctx.store, &user)?;
    Ok(
        json!({ "onboarding_completed_at": user["onboarding_completed_at"], "onboarding_interest": interest }),
    )
}

// ───────────────────────────── prompt library ─────────────────────────────
//
// Your personal prompts, with versions, categories and tags. Prompts, versions,
// categories, tags, shortcuts, slots and notes use integer ids.

/// Next integer id in a collection.
fn next_int_id(store: &LocalStore, collection: &str) -> i64 {
    store
        .list(collection)
        .iter()
        .filter_map(|r| r["id"].as_i64())
        .max()
        .unwrap_or(0)
        + 1
}

fn put_int(store: &LocalStore, collection: &str, record: &Value) -> Result<(), LocalError> {
    let id = record["id"]
        .as_i64()
        .map(|n| n.to_string())
        .unwrap_or_default();
    store
        .put(collection, &id, record.clone())
        .map_err(storage_error)
}

fn get_int(store: &LocalStore, collection: &str, id: &str) -> Option<Value> {
    store.get(collection, id)
}

/// A required integer id parameter (sent as a number or as text).
fn int_id(ctx: &Ctx, key: &str) -> Result<String, LocalError> {
    ctx.text(key)
        .filter(|v| v.parse::<i64>().is_ok())
        .ok_or_else(|| invalid(format!("{key} is required.")))
}

/// `{{name}}` placeholders, unique, in order of appearance.
fn variables(body: &str) -> Value {
    let re = regex::Regex::new(r"\{\{(\w+)\}\}").expect("static regex");
    let mut out: Vec<String> = Vec::new();
    for cap in re.captures_iter(body) {
        let name = cap[1].to_string();
        if !out.contains(&name) {
            out.push(name);
        }
    }
    if out.is_empty() {
        Value::Null
    } else {
        json!(out)
    }
}

fn prompt_view(ctx: &Ctx, p: &Value, detail: bool) -> Value {
    let mut out = p.clone();
    let category = p["category_id"]
        .as_i64()
        .and_then(|id| get_int(ctx.store, CATEGORIES, &id.to_string()));
    out["category"] = category.unwrap_or(Value::Null);
    let tag_ids: Vec<i64> = p["tag_ids"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let tags: Vec<Value> = tag_ids
        .iter()
        .filter_map(|id| get_int(ctx.store, TAGS, &id.to_string()))
        .collect();
    out["tags"] = json!(tags);
    out.as_object_mut().map(|o| o.remove("tag_ids"));
    let sub_agents = p["sub_agents"].as_array().cloned().unwrap_or_default();
    out["sub_agents_count"] = json!(sub_agents.len());
    out["is_workflow"] = json!(!sub_agents.is_empty());
    // Stars are personal here: the only possible star is your own.
    let starred = p["is_starred"].as_bool().unwrap_or(false);
    out["is_starred"] = json!(starred);
    out["stars_count"] = json!(u8::from(starred));
    out["is_fork"] = json!(false);
    out["forks_count"] = json!(0);
    out["forked_from_id"] = Value::Null;
    out["user"] = user_view(ctx.store);
    if detail {
        out["versions"] = json!(versions_of(ctx, p["id"].as_i64().unwrap_or(0)));
    } else if let Some(o) = out.as_object_mut() {
        o.remove("sub_agents");
    }
    out
}

fn versions_of(ctx: &Ctx, prompt_id: i64) -> Vec<Value> {
    let mut list: Vec<Value> = ctx
        .store
        .list(PROMPT_VERSIONS)
        .into_iter()
        .filter(|v| v["prompt_id"].as_i64() == Some(prompt_id))
        .collect();
    list.sort_by(|a, b| {
        b["version_number"]
            .as_i64()
            .cmp(&a["version_number"].as_i64())
    });
    list
}

const CONTENT_FIELDS: &[&str] = &[
    "title",
    "body",
    "variables",
    "category_id",
    "notes",
    "ai_model",
    "temperature",
    "max_tokens",
    "system_prompt",
    "provider_ids",
];

/// Saves the prompt's current content as version `current_version`.
fn snapshot_version(ctx: &Ctx, prompt: &Value, summary: Option<&str>) -> Result<(), LocalError> {
    let now = now_iso();
    let mut v = json!({
        "id": next_int_id(ctx.store, PROMPT_VERSIONS),
        "prompt_id": prompt["id"],
        "version_number": prompt["current_version"],
        "status": prompt["status"],
        "change_summary": summary,
        "created_by": LOCAL_USER_ID,
        "created_at": now,
        "updated_at": now,
    });
    for key in CONTENT_FIELDS {
        v[*key] = prompt.get(*key).cloned().unwrap_or(Value::Null);
    }
    let user = user_view(ctx.store);
    v["creator"] = json!({ "id": user["id"], "first_name": user["first_name"], "last_name": user["last_name"], "full_name": user["full_name"], "avatar_url": null });
    put_int(ctx.store, PROMPT_VERSIONS, &v)
}

fn validate_prompt(params: &Value, creating: bool) -> Result<(), LocalError> {
    for key in ["title", "body"] {
        if creating || has(params, key) {
            match params.get(key).and_then(Value::as_str) {
                Some(v) if !v.trim().is_empty() => {}
                _ => return Err(invalid(format!("{key} is required."))),
            }
        }
    }
    if params
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|t| t.chars().count() > 255)
    {
        return Err(invalid("title is too long (at most 255 characters)."));
    }
    if let Some(status) = params.get("status").and_then(Value::as_str) {
        if !["draft", "published", "archived"].contains(&status) {
            return Err(invalid(format!("Unknown prompt status: {status}.")));
        }
    }
    Ok(())
}

/// Applies the editable fields present in the parameters.
fn apply_prompt_fields(prompt: &mut Value, params: &Value) {
    for key in [
        "title",
        "body",
        "category_id",
        "notes",
        "ai_model",
        "max_tokens",
        "system_prompt",
        "status",
        "visibility",
        "provider_ids",
    ] {
        if has(params, key) {
            prompt[key] = params[key].clone();
        }
    }
    if has(params, "temperature") {
        prompt["temperature"] = match params["temperature"].as_f64() {
            Some(t) => json!(format!("{t:.2}")),
            None => params["temperature"]
                .as_str()
                .map(|t| json!(t))
                .unwrap_or(Value::Null),
        };
    }
    if let Some(tags) = params.get("tags").and_then(Value::as_array) {
        prompt["tag_ids"] = json!(tags.iter().filter_map(Value::as_i64).collect::<Vec<_>>());
    }
    if let Some(list) = params.get("sub_agents").and_then(Value::as_array) {
        let id = prompt["id"].clone();
        let now = now_iso();
        let agents: Vec<Value> = list
            .iter()
            .enumerate()
            .map(|(i, a)| {
                json!({
                    "id": i + 1,
                    "prompt_id": id,
                    "name": a.get("name").cloned().unwrap_or(Value::Null),
                    "role": a.get("role").cloned().unwrap_or(Value::Null),
                    "icon": a.get("icon").cloned().unwrap_or(Value::Null),
                    "system_prompt": a.get("system_prompt").cloned().unwrap_or(Value::Null),
                    "execution_order": a.get("execution_order").cloned().unwrap_or(json!(i)),
                    "auto_run": a.get("auto_run").cloned().unwrap_or(json!(false)),
                    "enabled": a.get("enabled").cloned().unwrap_or(json!(true)),
                    "created_at": now,
                    "updated_at": now,
                })
            })
            .collect();
        prompt["sub_agents"] = json!(agents);
    } else if params.get("sub_agents").is_some_and(Value::is_null) {
        prompt["sub_agents"] = json!([]);
    }
    let text = s(prompt, "body").unwrap_or_default();
    prompt["variables"] = variables(&text);
}

/// `prompts.list` — filters: `search` (title, body, notes), `category_id`,
/// `status`, `visibility`, `ai_model`, `tags` (ids, any of them), `starred`.
/// Sorting: `sort_field` (`id`, `created_at`, `updated_at`, `title`,
/// `stars_count`) and `sort_dir`
/// (`asc`/`desc`, default `desc`). Paging: `page` and `per_page`.
/// Returns `{ prompts, pagination }`.
fn prompt_list(ctx: &Ctx) -> LocalResult {
    let search = ctx.text("search").map(|t| t.to_lowercase());
    let tag_filter: Vec<i64> = match ctx.params.get("tags") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|t| {
                t.as_i64()
                    .or_else(|| t.as_str().and_then(|v| v.parse().ok()))
            })
            .collect(),
        Some(Value::String(v)) => v
            .split(',')
            .filter_map(|t| t.trim().parse::<i64>().ok())
            .collect(),
        _ => Vec::new(),
    };
    let category = ctx.text("category_id");
    let starred_only = ctx.flag("starred");
    let mut list: Vec<Value> = ctx
        .store
        .list(PROMPTS)
        .into_iter()
        .filter(is_live)
        .filter(|p| !s(p, "title").unwrap_or_default().starts_with("[Sub-Agent]"))
        .filter(|p| match &search {
            Some(t) => ["title", "body", "notes"]
                .iter()
                .any(|k| s(p, k).is_some_and(|v| v.to_lowercase().contains(t))),
            None => true,
        })
        .filter(|p| {
            category.as_ref().is_none_or(|c| {
                p["category_id"].as_i64().map(|v| v.to_string()).as_ref() == Some(c)
            })
        })
        .filter(|p| {
            ["status", "visibility", "ai_model"]
                .iter()
                .all(|k| ctx.text(k).is_none_or(|v| s(p, k) == Some(v)))
        })
        .filter(|p| !starred_only || p["is_starred"].as_bool().unwrap_or(false))
        .filter(|p| {
            tag_filter.is_empty()
                || p["tag_ids"].as_array().is_some_and(|a| {
                    a.iter()
                        .filter_map(Value::as_i64)
                        .any(|t| tag_filter.contains(&t))
                })
        })
        .collect();
    let field = match ctx.text("sort_field").as_deref() {
        Some(f @ ("created_at" | "updated_at" | "title" | "id" | "stars_count")) => f.to_string(),
        _ => "id".to_string(),
    };
    let desc = ctx
        .text("sort_dir")
        .is_none_or(|d| !d.eq_ignore_ascii_case("asc"));
    list.sort_by(|a, b| {
        let ord = match field.as_str() {
            "id" => a["id"].as_i64().cmp(&b["id"].as_i64()),
            "stars_count" => a["is_starred"]
                .as_bool()
                .unwrap_or(false)
                .cmp(&b["is_starred"].as_bool().unwrap_or(false))
                .then_with(|| a["id"].as_i64().cmp(&b["id"].as_i64())),
            f => s(a, f)
                .unwrap_or_default()
                .to_lowercase()
                .cmp(&s(b, f).unwrap_or_default().to_lowercase()),
        };
        if desc {
            ord.reverse()
        } else {
            ord
        }
    });
    let per_page = ctx
        .text("per_page")
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| if n == 0 { 15 } else { n })
        .unwrap_or(20);
    let page = ctx
        .text("page")
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|p| *p >= 1)
        .unwrap_or(1);
    let total = list.len();
    let last_page = total.div_ceil(per_page).max(1);
    // A huge `page` from the caller must not overflow (panic in debug builds).
    let start = (page - 1).saturating_mul(per_page);
    let items: Vec<Value> = list
        .iter()
        .skip(start)
        .take(per_page)
        .map(|p| prompt_view(ctx, p, false))
        .collect();
    let (from, to) = if items.is_empty() {
        (Value::Null, Value::Null)
    } else {
        (json!(start + 1), json!(start + items.len()))
    };
    Ok(
        json!({ "prompts": items, "pagination": { "total": total, "per_page": per_page, "current_page": page, "last_page": last_page, "from": from, "to": to } }),
    )
}

fn live_prompt(ctx: &Ctx) -> Result<Value, LocalError> {
    let id = int_id(ctx, "id")?;
    live(get_int(ctx.store, PROMPTS, &id)).ok_or_else(|| not_found("Prompt"))
}

/// `prompts.create` — the first version is saved too.
fn prompt_create(ctx: &Ctx) -> LocalResult {
    validate_prompt(ctx.params, true)?;
    let now = now_iso();
    let mut prompt = json!({
        "id": next_int_id(ctx.store, PROMPTS),
        "user_id": LOCAL_USER_ID,
        "status": "draft",
        "visibility": "private",
        "current_version": 1,
        "notes": null, "ai_model": null, "temperature": null, "max_tokens": null, "system_prompt": null,
        "category_id": null, "provider_ids": null, "tag_ids": [], "sub_agents": [],
        "first_published_at": null, "publication_notified_at": null,
        "created_at": now, "updated_at": now, "deleted_at": null,
    });
    apply_prompt_fields(&mut prompt, ctx.params);
    put_int(ctx.store, PROMPTS, &prompt)?;
    snapshot_version(ctx, &prompt, Some("Initial version"))?;
    Ok(prompt_view(ctx, &prompt, true))
}

/// `prompts.get` — `{ id }`, with versions.
fn prompt_get(ctx: &Ctx) -> LocalResult {
    let p = live_prompt(ctx)?;
    Ok(prompt_view(ctx, &p, true))
}

/// `prompts.update` — `{ id, ...fields, change_summary? }`. Each save becomes a
/// new version, so you can go back.
fn prompt_update(ctx: &Ctx) -> LocalResult {
    let mut prompt = live_prompt(ctx)?;
    validate_prompt(ctx.params, false)?;
    apply_prompt_fields(&mut prompt, ctx.params);
    prompt["current_version"] = json!(prompt["current_version"].as_i64().unwrap_or(1) + 1);
    prompt["updated_at"] = json!(now_iso());
    put_int(ctx.store, PROMPTS, &prompt)?;
    snapshot_version(
        ctx,
        &prompt,
        ctx.params.get("change_summary").and_then(Value::as_str),
    )?;
    // Shortcuts pinned to this prompt show its new title.
    if let Some(title) = s(&prompt, "title") {
        for mut sc in ctx
            .store
            .list(SHORTCUTS)
            .into_iter()
            .filter(|sc| sc["prompt_id"] == prompt["id"])
        {
            sc["label"] = json!(title);
            put_int(ctx.store, SHORTCUTS, &sc)?;
        }
    }
    Ok(prompt_view(ctx, &prompt, true))
}

/// `prompts.delete` — `{ id }` (soft delete).
fn prompt_delete(ctx: &Ctx) -> LocalResult {
    let mut p = live_prompt(ctx)?;
    p["deleted_at"] = json!(now_iso());
    put_int(ctx.store, PROMPTS, &p)?;
    Ok(Value::Null)
}

/// `prompts.versions` — `{ id }`, newest first.
fn prompt_versions(ctx: &Ctx) -> LocalResult {
    let p = live_prompt(ctx)?;
    Ok(json!(versions_of(ctx, p["id"].as_i64().unwrap_or(0))))
}

/// `prompts.restoreVersion` — `{ id, version_id }`: restores an earlier version
/// as a new version (nothing is overwritten).
fn prompt_restore(ctx: &Ctx) -> LocalResult {
    let mut prompt = live_prompt(ctx)?;
    let version_id = int_id(ctx, "version_id")?;
    let version = get_int(ctx.store, PROMPT_VERSIONS, &version_id)
        .filter(|v| v["prompt_id"] == prompt["id"])
        .ok_or_else(|| not_found("Version"))?;
    for key in CONTENT_FIELDS {
        prompt[*key] = version.get(*key).cloned().unwrap_or(Value::Null);
    }
    prompt["current_version"] = json!(prompt["current_version"].as_i64().unwrap_or(1) + 1);
    prompt["updated_at"] = json!(now_iso());
    put_int(ctx.store, PROMPTS, &prompt)?;
    let summary = format!("Restored from version {}", version["version_number"]);
    snapshot_version(ctx, &prompt, Some(&summary))?;
    Ok(prompt_view(ctx, &prompt, true))
}

/// `prompts.toggleStar` — `{ id }`: stars or unstars one of your prompts.
/// It is a bookmark, not an edit: no new version, `updated_at` unchanged.
fn prompt_toggle_star(ctx: &Ctx) -> LocalResult {
    let mut prompt = live_prompt(ctx)?;
    let starred = !prompt["is_starred"].as_bool().unwrap_or(false);
    prompt["is_starred"] = json!(starred);
    put_int(ctx.store, PROMPTS, &prompt)?;
    Ok(prompt_view(ctx, &prompt, false))
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "category".to_string()
    } else {
        slug
    }
}

/// The live prompt category with this id (a number or numeric text), if any.
/// Sessions point at one through `category_id`.
pub(crate) fn live_category(ctx: &Ctx, id: &Value) -> Option<Value> {
    let id = id
        .as_i64()
        .or_else(|| id.as_str().and_then(|v| v.parse().ok()))?;
    live(get_int(ctx.store, CATEGORIES, &id.to_string()))
}

fn category_list(ctx: &Ctx) -> LocalResult {
    let mut list = ctx
        .store
        .list(CATEGORIES)
        .into_iter()
        .filter(is_live)
        .collect::<Vec<_>>();
    list.sort_by_key(|a| s(a, "name"));
    Ok(Value::Array(list))
}

/// `promptCategories.create` — `{ name, description?, color? }`.
fn category_create(ctx: &Ctx) -> LocalResult {
    let name = validate_required(ctx.params, "name", 100)?;
    let base = slugify(&name);
    let existing: Vec<String> = ctx
        .store
        .list(CATEGORIES)
        .iter()
        .filter_map(|c| s(c, "slug"))
        .collect();
    let slug = std::iter::once(base.clone())
        .chain((1..).map(|n| format!("{base}-{n}")))
        .find(|candidate| !existing.contains(candidate))
        .unwrap_or(base);
    let now = now_iso();
    let category = json!({
        "id": next_int_id(ctx.store, CATEGORIES),
        "name": name,
        "slug": slug,
        "description": ctx.params.get("description").cloned().unwrap_or(Value::Null),
        "color": ctx.params.get("color").and_then(Value::as_str).unwrap_or("#6366f1"),
        "user_id": LOCAL_USER_ID,
        "created_at": now,
        "updated_at": now,
        "deleted_at": null,
    });
    put_int(ctx.store, CATEGORIES, &category)?;
    Ok(category)
}

/// `promptTags.create` — `{ name }`. A tag with the same slug is reused.
fn tag_create(ctx: &Ctx) -> LocalResult {
    let name = validate_required(ctx.params, "name", 50)?;
    let slug = slugify(&name);
    if let Some(tag) = ctx
        .store
        .list(TAGS)
        .into_iter()
        .find(|t| s(t, "slug").as_deref() == Some(slug.as_str()))
    {
        return Ok(tag);
    }
    let now = now_iso();
    let tag = json!({ "id": next_int_id(ctx.store, TAGS), "name": name, "slug": slug, "user_id": LOCAL_USER_ID, "created_at": now, "updated_at": now });
    put_int(ctx.store, TAGS, &tag)?;
    Ok(tag)
}

// ───────────────────────────── shortcuts and action slots ─────────────────────────────
//
// Shortcuts pin prompts to the sidebar; action slots put prompts on the
// buttons of a session, a workspace or every session.

fn prompt_summary(ctx: &Ctx, prompt_id: &Value, with_body: bool) -> Value {
    let id = prompt_id
        .as_i64()
        .map(|n| n.to_string())
        .unwrap_or_default();
    match live(get_int(ctx.store, PROMPTS, &id)) {
        Some(p) => {
            let mut out = json!({ "id": p["id"], "title": p["title"], "status": p["status"], "stars_count": 0, "is_fork": false, "forks_count": 0 });
            if with_body {
                out["body"] = p["body"].clone();
            }
            out
        }
        None => Value::Null,
    }
}

fn sorted(ctx: &Ctx, collection: &str) -> Vec<Value> {
    let mut list = ctx.store.list(collection);
    list.sort_by(|a, b| {
        a["sort_order"]
            .as_i64()
            .cmp(&b["sort_order"].as_i64())
            .then_with(|| a["id"].as_i64().cmp(&b["id"].as_i64()))
    });
    list
}

/// The prompt a shortcut or slot points to; it must exist.
fn required_prompt_id(ctx: &Ctx) -> Result<i64, LocalError> {
    let prompt_id = ctx
        .params
        .get("prompt_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("prompt_id is required."))?;
    if live(get_int(ctx.store, PROMPTS, &prompt_id.to_string())).is_none() {
        return Err(not_found("Prompt"));
    }
    Ok(prompt_id)
}

fn shortcut_list(ctx: &Ctx) -> LocalResult {
    let list: Vec<Value> = sorted(ctx, SHORTCUTS)
        .into_iter()
        .map(|mut sc| {
            sc["prompt"] = prompt_summary(ctx, &sc["prompt_id"], false);
            sc
        })
        .collect();
    Ok(Value::Array(list))
}

/// `shortcuts.create` — `{ prompt_id, label, icon? }`.
fn shortcut_create(ctx: &Ctx) -> LocalResult {
    let label = validate_required(ctx.params, "label", 100)?;
    let prompt_id = required_prompt_id(ctx)?;
    let existing = ctx.store.list(SHORTCUTS);
    if existing.len() >= MAX_SHORTCUTS {
        return Err(invalid(format!(
            "You can pin at most {MAX_SHORTCUTS} shortcuts."
        )));
    }
    if existing
        .iter()
        .any(|sc| sc["prompt_id"].as_i64() == Some(prompt_id))
    {
        return Err(LocalError::new(
            "conflict",
            "This prompt is already pinned.",
        ));
    }
    let now = now_iso();
    let mut sc = json!({
        "id": next_int_id(ctx.store, SHORTCUTS),
        "user_id": LOCAL_USER_ID,
        "prompt_id": prompt_id,
        "label": label,
        "icon": ctx.params.get("icon").and_then(Value::as_str).unwrap_or("ti-bolt"),
        "sort_order": existing.iter().filter_map(|r| r["sort_order"].as_i64()).max().map_or(0, |m| m + 1),
        "created_at": now,
        "updated_at": now,
    });
    put_int(ctx.store, SHORTCUTS, &sc)?;
    sc["prompt"] = prompt_summary(ctx, &sc["prompt_id"], false);
    Ok(sc)
}

/// `shortcuts.update` — `{ id, label?, icon? }`.
fn shortcut_update(ctx: &Ctx) -> LocalResult {
    let id = int_id(ctx, "id")?;
    let mut sc = get_int(ctx.store, SHORTCUTS, &id).ok_or_else(|| not_found("Shortcut"))?;
    for key in ["label", "icon"] {
        if let Some(v) = ctx.params.get(key).filter(|v| !v.is_null()) {
            sc[key] = v.clone();
        }
    }
    sc["updated_at"] = json!(now_iso());
    put_int(ctx.store, SHORTCUTS, &sc)?;
    sc["prompt"] = prompt_summary(ctx, &sc["prompt_id"], false);
    Ok(sc)
}

/// `shortcuts.reorder` — `{ order }`: shortcut ids in their new order.
fn shortcut_reorder(ctx: &Ctx) -> LocalResult {
    let ids: Vec<i64> = ctx
        .params
        .get("order")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    for (index, id) in ids.iter().enumerate() {
        if let Some(mut r) = get_int(ctx.store, SHORTCUTS, &id.to_string()) {
            r["sort_order"] = json!(index);
            put_int(ctx.store, SHORTCUTS, &r)?;
        }
    }
    Ok(Value::Null)
}

/// Removes a record for good: `{ id }`.
fn delete_hard(ctx: &Ctx, collection: &str, what: &str) -> LocalResult {
    let id = int_id(ctx, "id")?;
    get_int(ctx.store, collection, &id).ok_or_else(|| not_found(what))?;
    ctx.store.delete(collection, &id).map_err(storage_error)?;
    Ok(Value::Null)
}

/// Where a slot list applies: every session, a workspace, or one session.
enum SlotScope {
    Global,
    Workspace(String),
    Session(String),
}

impl SlotScope {
    fn describe(&self) -> Value {
        match self {
            SlotScope::Global => json!({ "type": "global", "id": "global" }),
            SlotScope::Workspace(id) => json!({ "type": "workspace", "id": id }),
            SlotScope::Session(id) => json!({ "type": "session", "id": id }),
        }
    }
}

/// `scope: "global"`, or a `session_id`: a session inside a workspace shares
/// the workspace's slots.
fn slot_scope(ctx: &Ctx) -> Result<SlotScope, LocalError> {
    if ctx.text("scope").as_deref() == Some("global") {
        return Ok(SlotScope::Global);
    }
    let session_id = ctx.required("session_id")?;
    // A session the store does not know yet (just created) is treated as standalone.
    let workspace = ctx
        .store
        .get(SESSIONS, &session_id)
        .and_then(|r| s(&r, "workspace_id"));
    Ok(match workspace {
        Some(w) => SlotScope::Workspace(w),
        None => SlotScope::Session(session_id),
    })
}

fn slot_in_scope(ctx: &Ctx, slot: &Value, scope: &SlotScope) -> bool {
    match scope {
        SlotScope::Global => slot["session_id"].is_null(),
        SlotScope::Session(id) => s(slot, "session_id").as_deref() == Some(id.as_str()),
        SlotScope::Workspace(w) => {
            s(slot, "session_id")
                .and_then(|sid| ctx.store.get(SESSIONS, &sid))
                .and_then(|session| s(&session, "workspace_id"))
                .as_deref()
                == Some(w.as_str())
        }
    }
}

fn slots_in(ctx: &Ctx, scope: &SlotScope) -> Vec<Value> {
    sorted(ctx, SLOTS)
        .into_iter()
        .filter(|slot| slot_in_scope(ctx, slot, scope))
        .collect()
}

/// `actionSlots.list` — returns `{ slots, scope }`.
fn slot_list(ctx: &Ctx) -> LocalResult {
    let scope = slot_scope(ctx)?;
    let slots: Vec<Value> = slots_in(ctx, &scope)
        .into_iter()
        .map(|mut slot| {
            slot["prompt"] = prompt_summary(ctx, &slot["prompt_id"], true);
            slot
        })
        .collect();
    Ok(json!({ "slots": slots, "scope": scope.describe() }))
}

/// `actionSlots.create` — `{ prompt_id, label, icon?, session_id | scope }`.
/// New slots go first. Returns `{ slot, scope }`.
fn slot_create(ctx: &Ctx) -> LocalResult {
    let scope = slot_scope(ctx)?;
    let label = validate_required(ctx.params, "label", 100)?;
    let prompt_id = required_prompt_id(ctx)?;
    let existing = slots_in(ctx, &scope);
    if existing.len() >= MAX_SLOTS {
        return Err(invalid(format!("At most {MAX_SLOTS} actions fit here.")));
    }
    if existing
        .iter()
        .any(|slot| slot["prompt_id"].as_i64() == Some(prompt_id))
    {
        return Err(LocalError::new("conflict", "This prompt is already here."));
    }
    for mut slot in existing {
        slot["sort_order"] = json!(slot["sort_order"].as_i64().unwrap_or(0) + 1);
        put_int(ctx.store, SLOTS, &slot)?;
    }
    let session_id = match scope {
        SlotScope::Global => Value::Null,
        _ => ctx
            .text("session_id")
            .map(Value::from)
            .unwrap_or(Value::Null),
    };
    let now = now_iso();
    let mut slot = json!({
        "id": next_int_id(ctx.store, SLOTS),
        "user_id": LOCAL_USER_ID,
        "session_id": session_id,
        "prompt_id": prompt_id,
        "label": label,
        "icon": ctx.params.get("icon").and_then(Value::as_str).unwrap_or("ti-bolt"),
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    });
    put_int(ctx.store, SLOTS, &slot)?;
    slot["prompt"] = prompt_summary(ctx, &slot["prompt_id"], true);
    Ok(json!({ "slot": slot, "scope": scope.describe() }))
}

/// `actionSlots.reorder` — `{ order, session_id | scope }`: every slot of the
/// scope, exactly once.
fn slot_reorder(ctx: &Ctx) -> LocalResult {
    let scope = slot_scope(ctx)?;
    let order: Vec<i64> = ctx
        .params
        .get("order")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let slots = slots_in(ctx, &scope);
    let mut wanted = order.clone();
    wanted.sort_unstable();
    let mut actual: Vec<i64> = slots.iter().filter_map(|r| r["id"].as_i64()).collect();
    actual.sort_unstable();
    if wanted != actual {
        return Err(invalid(
            "The order must list every action here exactly once.",
        ));
    }
    for (index, id) in order.iter().enumerate() {
        if let Some(mut slot) = slots
            .iter()
            .find(|r| r["id"].as_i64() == Some(*id))
            .cloned()
        {
            slot["sort_order"] = json!(index);
            put_int(ctx.store, SLOTS, &slot)?;
        }
    }
    Ok(Value::Null)
}

/// `actionSlots.delete` — `{ id, session_id | scope }`.
fn slot_delete(ctx: &Ctx) -> LocalResult {
    let scope = slot_scope(ctx)?;
    let id = int_id(ctx, "id")?;
    get_int(ctx.store, SLOTS, &id)
        .filter(|slot| slot_in_scope(ctx, slot, &scope))
        .ok_or_else(|| not_found("Action"))?;
    ctx.store.delete(SLOTS, &id).map_err(storage_error)?;
    Ok(Value::Null)
}

// ───────────────────────────── personal notes ─────────────────────────────
//
// Quick notes you attach to a session or a file.

/// `notes.list` — filters: `session_id`, `file_path`, `search`. Newest first.
fn note_list(ctx: &Ctx) -> LocalResult {
    let search = ctx.text("search").map(|v| v.to_lowercase());
    let session = ctx.text("session_id");
    let file = ctx.text("file_path");
    let mut notes: Vec<Value> = ctx
        .store
        .list(NOTES)
        .into_iter()
        .filter(|n| {
            session
                .as_ref()
                .is_none_or(|v| s(n, "session_id").as_ref() == Some(v))
        })
        .filter(|n| {
            file.as_ref()
                .is_none_or(|v| s(n, "file_path").as_ref() == Some(v))
        })
        .filter(|n| {
            search
                .as_ref()
                .is_none_or(|t| s(n, "content").is_some_and(|c| c.to_lowercase().contains(t)))
        })
        .map(|mut n| {
            n["creator"] = note_creator(ctx);
            n
        })
        .collect();
    notes.sort_by(|a, b| {
        s(b, "created_at")
            .cmp(&s(a, "created_at"))
            .then_with(|| b["id"].as_i64().cmp(&a["id"].as_i64()))
    });
    Ok(Value::Array(notes))
}

/// `notes.create` — `{ content, session_id?, file_path? }`.
fn note_create(ctx: &Ctx) -> LocalResult {
    let content = ctx
        .params
        .get("content")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| invalid("content is required."))?;
    let now = now_iso();
    let mut note = json!({
        "id": next_int_id(ctx.store, NOTES),
        "team_id": null,
        "session_id": ctx.params.get("session_id").cloned().unwrap_or(Value::Null),
        "file_path": ctx.params.get("file_path").cloned().unwrap_or(Value::Null),
        "content": content,
        "created_by": LOCAL_USER_ID,
        "created_at": now,
        "updated_at": now,
    });
    put_int(ctx.store, NOTES, &note)?;
    note["creator"] = note_creator(ctx);
    Ok(note)
}

fn note_creator(ctx: &Ctx) -> Value {
    let u = user_view(ctx.store);
    json!({ "id": u["id"], "first_name": u["first_name"], "last_name": u["last_name"], "username": null, "avatar": null })
}
