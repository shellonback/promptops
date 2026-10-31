# Changelog

All notable changes to the open-source edition are listed here. Versions of
PromptOps Desktop, the hosted edition, have their own release notes.

## Unreleased

### Added

- Kora CLI as an agent provider: launch (`kora`), resume by session id
  (`kora --resume <id>`, discovered by probing `kora sessions --json`) and
  auto-approve (`-y`). Model, provider and effort stay inside Kora's own
  CLI; state degrades to PTY activity like the other hookless CLIs.

## 2.1.7 — 2026-10-24

First public release of the source. From here the open-source edition uses
the same version numbers as PromptOps Desktop; each edition keeps its own
list of changes.

### Added

- Backup & restore in Settings: a passphrase-encrypted file (Argon2id and
  AES-256-GCM) with all your local data, including saved connections and API
  keys, to move to another computer or recover lost data. Restore can replace
  or merge, and keeps a copy of the previous data.
- Stars on prompts (a personal bookmark with a Starred filter) and session
  categories, stored locally.
- Arabic is laid out right to left, and the page language follows the UI
  language. Dates are formatted in the UI language.
- More of the interface is translated: the Plugins page, Plugin Studio,
  plugin permissions, session screens, modals, menus and panels.
- A **Question** issue template.

### Security

- Agent CLIs are never typed into your shells: provider commands, key paths
  and hosts are no longer pasted into terminals or Git Setup shells, and Git,
  terminal and editor commands are started without re-parsed command lines.
- Usage limits are read from a provider CLI only when you ask (Refresh in the
  Usage panel) or from a session of that CLI you already started; opening a
  session no longer launches one.
- PromptOps no longer writes into your repository when a session opens: the
  project context snapshot lives in the app data folder, and Claude Code
  hooks are passed with `--settings` instead of `.claude/settings.local.json`
  (except for older Claude Code versions and WSL).
- Agent profiles, recent workspaces and the last active session name moved
  into the encrypted store; the PromptOps CLI API key is kept there too and
  cannot be read through `ctl.json`.
- A damaged data file is set aside instead of overwritten, a file from a
  newer version or a second running copy opens read-only, and the app tells
  you.
- Plugins: IPv6 addresses that hide an internal IPv4 address are refused,
  `tasks:write` is enforced, `agents:propose` is no longer accepted, plugin
  text is stripped of control characters, and Tauri's own shell and dialog
  scripts no longer run in the plugin host page.
- The control plane refuses callers that are not a live session or
  sub-agent, and checks the model and effort of spawned agents.
- App windows cannot navigate to remote sites, links open without `cmd.exe`
  on Windows, remote files that can run code are not opened automatically,
  and the code editor writes only inside the real workspace.
- The database explorer enforces read-only mode and keeps connection URIs
  out of the process list; database passwords stay out of browser storage;
  passwords in `.env` URLs are masked before the dev links scan sends them to
  your AI provider.
- Voice input uses only keys saved in the app and verifies downloaded
  Whisper models. Recordings and prompts for headless AI runs go through a
  private temporary folder.
- The embeddings sidecar loads its library only from known places, never
  from the folder the app was started in.
- Vulnerable transitive dependencies were patched; the rest are documented
  in `docs/supply-chain.md`.

### Fixed

- Sessions: race-free create, restore and close; same-name sessions no
  longer share a record; a missing workspace folder no longer starts the
  session in your home folder; a parked session wakes up before a sub-agent
  is added or a library prompt is sent to it; a spawned prompt is counted
  once and sent with a single Enter.
- Headless AI features (commit messages, smart context, database AI) share
  one provider pipeline with the right flags for Grok and Copilot, run off
  the main thread, and stop as a whole on cancel or timeout.
- Git: the last change is never dropped, renames are unstaged as a whole,
  worktree git folders are watched, and repository fsmonitor settings no
  longer slow down context snapshots.
- Terminals end without zombie or orphan processes, also when the app is
  killed.
- Hooks: user configs are backed up and restored around hook installs, and
  System cleanup also removes the hooks PromptOps installed.
- Claude Code transcripts of managed accounts are found, and only Claude Code
  sub-agents are told they run in Claude Code.
- Trash works without Finder automation on macOS.
- The SSH panel works with the desktop commands, with deadlines on every
  step.
- Text that claimed savings, privacy or saves that the app does not provide
  was corrected, and the AI Agent Evals page says what it measures.
- Many smaller fixes for stale panel data, stuck polls, contrast in both
  themes, keyboard and screen reader access, and unhandled errors.

## 0.1.0 (pre-release)

First release of the open-source edition.

- Runs entirely on your computer: no account, no sign-in, no server. Every
  request the interface makes is answered on the device.
- Session Vault: sessions, prompts, notes, settings, saved SSH and database
  connections and terminal history are encrypted with AES-256-GCM, with the
  key in the OS keychain.
- Agents that run agents through a built-in MCP server, sub-agents with their
  own provider and model, Floor Plan, prompt library, plugins you build on
  your computer, voice input on the device.
- Features that need a server (Teams, sync, mobile app, organizations,
  community) are part of PromptOps Desktop and show a lock here.
- The local hook and control servers only accept requests that carry the
  token of the running app.
- After a restart the app opens the session you were working in.
- A strict Content Security Policy, fonts bundled with the app and no
  inline scripts.
