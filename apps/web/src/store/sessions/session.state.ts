export type SessionStatus = 'idle' | 'running' | 'in_progress' | 'waiting_input' | 'completed' | 'error' | 'exited';
export type ProviderType = 'claude-code-cli' | 'codex' | 'gemini-cli' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'hermes' | 'muse' | 'zai' | 'kimi' | 'opencode' | 'kora' | 'promptops-cli' | 'generic-shell';
export type LayoutMode = 'standard' | 'code';

/** Status of a session's workspace on the current device. */
export type DeviceWorkspaceStatus = 'configured' | 'not_configured' | 'invalid_path';

export interface DeviceWorkspaceInfo {
  id: string;
  localPath: string;
  status: DeviceWorkspaceStatus;
  updatedAt: string;
}

export interface WorkspaceBinding {
  path: string;
  name: string;
}

/**
 * Per-session UI layout state. Persisted in the local store so each session
 * keeps its own panel sizes, lock flags, and sub-agent view mode on reopen.
 *
 * Intentionally excludes per-sub-agent panel sizes — sub-agents always
 * restart at their native/default size when the session is reopened.
 */
export interface SessionViewState {
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  subAgentsHeight?: number;
  subAgentsListMode?: boolean;
  subAgentTabMode?: boolean;
  subAgentGridMode?: boolean;
  /** New layout identifier: 'auto' (grid, default) | 'columns' (formerly split) | 'tabs'. */
  subAgentLayout?: 'auto' | 'columns' | 'rows' | 'tabs';
  subAgentsCoverMain?: boolean;
  userExplicitLayout?: boolean;
  ideSubAgentsHeight?: number;
  actionCenterWidth?: number;
  actionCenterCollapsed?: boolean;
  ideRightWidth?: number | null;
  ideRightCollapsed?: boolean;
  lockedSubAgentIds?: string[];
}

export interface SessionSummary {
  id: string;
  name: string;
  provider: ProviderType;
  status: SessionStatus;
  workspace?: WorkspaceBinding;
  workspaceId?: string | null;
  createdAt: string;
  pendingInteractionCount: number;
  categoryId?: number | null;
  teamId?: number | null;
  teamName?: string | null;
  projectId?: number | null;
  projectName?: string | null;
  layoutMode?: LayoutMode;
  repoUrl?: string | null;
  repoBranch?: string | null;
  deviceWorkspace?: DeviceWorkspaceInfo | null;
  viewState?: SessionViewState;
  subAgentsOrder?: string[] | null;
  /**
   * Standby (parked) marker. When set, the session's provider process was
   * killed to save resources; it stays in the list (dimmed + moon icon) and is
   * woken on click. Orthogonal to `status`.
   */
  standbyAt?: string | null;
  /**
   * Stored id — stable across app restarts and renames (the local `id`
   * is not). Keys the per-session localStorage stash of parked sub-agents.
   */
  dbId?: string | null;
  /**
   * Pinned provider account (mirrors the desktop session's
   * config.providerAccountId): string = account, null = opt-out, undefined =
   * follows the global active account.
   */
  providerAccountId?: string | null;
}

export interface Interaction {
  id: string;
  sessionId: string;
  type: 'input_request' | 'human_action_request';
  status: string;
  prompt?: string;
  description?: string;
  inputType?: string;
  actionType?: string;
  choices?: string[];
  details?: Record<string, unknown>;
  context?: string[];
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  provider: ProviderType;
  config: Record<string, unknown>;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionsState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  pendingInteractions: Record<string, Interaction[]>;
  profiles: AgentProfile[];
  loading: boolean;
  /** True once the first loadSessions cycle has settled (success or failure).
   *  Used by the UI to avoid flashing the welcome/empty state during the
   *  initial bootstrap before we know whether the user actually has sessions. */
  hasLoadedOnce: boolean;
  /** Last list fetch failed with nothing to show (no cache, no live sessions). */
  listLoadFailed: boolean;
  error: string | null;
}

export const initialSessionsState: SessionsState = {
  sessions: [],
  activeSessionId: null,
  pendingInteractions: {},
  profiles: [],
  loading: false,
  hasLoadedOnce: false,
  listLoadFailed: false,
  error: null,
};

/**
 * Local cache of the last successfully-loaded session list. Used to hydrate
 * the store synchronously at boot so the Sessions page paints instantly
 * instead of showing the bootstrap loader while the first local store fetch
 * (network + CORS preflight, especially slow on Tauri) is in flight.
 * Contains only SessionSummary metadata — never prompt text.
 */
const SESSIONS_CACHE_KEY = 'promptops_sessions_cache_v1';

export function readSessionsCache(): SessionSummary[] | null {
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw) as SessionSummary[];
    if (!Array.isArray(list)) return null;
    // Live-only fields are stale after a restart: normalize to a quiet idle
    // snapshot so no phantom "running"/"waiting" badges flash before refresh.
    return list.map((s) => ({ ...s, status: 'idle' as SessionStatus, pendingInteractionCount: 0 }));
  } catch {
    return null;
  }
}

const SESSIONS_SEEN_KEY = 'promptops_sessions_seen_v1';

export function writeSessionsCache(sessions: SessionSummary[]): void {
  try {
    localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify(sessions));
    if (sessions.length > 0) localStorage.setItem(SESSIONS_SEEN_KEY, '1');
  } catch { /* quota/serialization issues are non-critical */ }
}

/** True once this account has had at least one session on this device: an
 *  empty list afterwards is far more likely a load glitch than a new user, so
 *  the first-run welcome/guide must not show. */
export function hasEverHadSessions(): boolean {
  try {
    return localStorage.getItem(SESSIONS_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearSessionsCache(): void {
  try {
    localStorage.removeItem(SESSIONS_CACHE_KEY);
    localStorage.removeItem(SESSIONS_SEEN_KEY);
  } catch { /* non-critical */ }
}

/**
 * Boot-time state: initialSessionsState hydrated from the local cache.
 * Kept separate from initialSessionsState so clearSessions (logout) resets
 * to a truly empty state, not back to the cached list.
 */
export const hydratedSessionsState: SessionsState = (() => {
  const cached = readSessionsCache();
  return cached
    ? { ...initialSessionsState, sessions: cached, hasLoadedOnce: true }
    : initialSessionsState;
})();
