import { createReducer, on } from '@ngrx/store';
import { hydratedSessionsState, initialSessionsState, SessionSummary, SessionsState } from './session.state';
import {
  loadSessions,
  loadSessionsSuccess,
  loadSessionsFailure,
  createSessionSuccess,
  createSessionFailure,
  destroySessionSuccess,
  setActiveSession,
  activateSavedSession,
  sessionStatusChanged,
  sessionStandbyChanged,
  updateSessionSuccess,
  interactionCreated,
  interactionResolved,
  loadProfilesSuccess,
  reorderSessions,
  setLayoutMode,
  updateSessionViewState,
  clearSessions,
  promoteSessionSuccess,
} from './session.actions';
import { deleteWorkspaceSuccess } from '../workspaces/workspace.actions';

export const sessionsReducer = createReducer(
  // Hydrated from the local session-list cache so the Sessions page paints
  // instantly at boot (no bootstrap loader) while the real fetch refreshes it.
  hydratedSessionsState,

  // `listLoadFailed` is kept while a retry is in flight so the load-error
  // screen doesn't flicker back to the welcome state on every attempt.
  on(loadSessions, (state): SessionsState => ({
    ...state,
    loading: true,
    error: null,
  })),

  on(loadSessionsSuccess, (state, { sessions: incoming }): SessionsState => {
    // Polled summaries carry no layoutMode (it lives in the view state): keep
    // the one already in the store, else every poll of a session in code
    // layout replaced the whole list and the view re-applied its layout.
    const prevById = new Map(state.sessions.map((p) => [p.id, p]));
    const sessions = incoming.map((s) => {
      if (s.layoutMode) return s;
      const kept = prevById.get(s.id)?.layoutMode
        ?? (s.viewState as { layoutMode?: SessionSummary['layoutMode'] } | undefined)?.layoutMode;
      return kept ? { ...s, layoutMode: kept } : s;
    });
    // The effect already merges live (desktop) + saved (DB) sessions.
    // Replace the entire list to avoid accumulating duplicates across
    // multiple loadSessions() dispatches.
    // Skip array replacement when data is unchanged to avoid triggering
    // downstream effects (e.g. git panel reset) on every poll cycle.
    const unchanged =
      sessions.length === state.sessions.length &&
      sessions.every((s, i) => {
        const prev = state.sessions[i];
        return (
          prev.id === s.id &&
          prev.dbId === s.dbId &&
          prev.status === s.status &&
          prev.name === s.name &&
          prev.pendingInteractionCount === s.pendingInteractionCount &&
          prev.workspaceId === s.workspaceId &&
          prev.standbyAt === s.standbyAt &&
          prev.layoutMode === s.layoutMode
        );
      });
    return {
      ...state,
      sessions: unchanged ? state.sessions : sessions,
      activeSessionId: unchanged ? state.activeSessionId : followActiveSession(state, sessions),
      loading: false,
      hasLoadedOnce: true,
      listLoadFailed: false,
    };
  }),

  on(loadSessionsFailure, (state, { error }): SessionsState => ({
    ...state,
    loading: false,
    hasLoadedOnce: true,
    listLoadFailed: state.sessions.length === 0,
    error,
  })),

  on(createSessionSuccess, (state, { session }): SessionsState => ({
    ...state,
    // Dedup: if a session with the same name already exists (e.g. from a
    // concurrent loadSessionsSuccess), update it instead of appending a duplicate.
    sessions: state.sessions.some((s) => s.name === session.name)
      ? state.sessions.map((s) => (s.name === session.name ? { ...s, ...session } : s))
      : [...state.sessions, session],
    activeSessionId: session.id,
  })),

  on(createSessionFailure, (state, { error }): SessionsState => ({
    ...state,
    error,
  })),

  on(destroySessionSuccess, (state, { sessionId }): SessionsState => {
    const pendingInteractions = { ...state.pendingInteractions };
    delete pendingInteractions[sessionId];
    const remaining = state.sessions.filter((s) => s.id !== sessionId);

    let newActiveId = state.activeSessionId;
    if (state.activeSessionId === sessionId) {
      // Try to activate a sibling in the same workspace
      const destroyed = state.sessions.find(s => s.id === sessionId);
      const sibling = destroyed?.workspaceId
        ? remaining.find(s => s.workspaceId === destroyed.workspaceId)
        : null;
      newActiveId = sibling?.id ?? remaining[0]?.id ?? null;
    }

    return {
      ...state,
      sessions: remaining,
      activeSessionId: newActiveId,
      pendingInteractions,
    };
  }),

  on(setActiveSession, (state, { sessionId }): SessionsState => ({
    ...state,
    activeSessionId: sessionId,
  })),

  on(activateSavedSession, (state, { savedSessionId, liveSession }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === savedSessionId ? { ...liveSession, status: liveSession.status ?? s.status ?? 'idle' } : s,
    ),
    activeSessionId: liveSession.id,
  })),

  on(updateSessionSuccess, (state, { session }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === session.id ? { ...s, ...session, status: s.status ?? session.status ?? 'idle' } : s,
    ),
  })),

  on(sessionStatusChanged, (state, { sessionId, status }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, status } : s,
    ),
  })),

  on(sessionStandbyChanged, (state, { sessionId, standbyAt }): SessionsState => {
    const sessions = state.sessions.map((s) =>
      s.id === sessionId ? { ...s, standbyAt } : s,
    );
    // Parking the active session keeps it active: the view shows the standby
    // cover (wake CTA) instead of jumping to an unrelated session the user
    // wasn't working on (e.g. auto-standby while idle on it).
    return { ...state, sessions };
  }),

  on(interactionCreated, (state, { interaction }): SessionsState => {
    const sessionInteractions = state.pendingInteractions[interaction.sessionId] ?? [];
    return {
      ...state,
      pendingInteractions: {
        ...state.pendingInteractions,
        [interaction.sessionId]: [...sessionInteractions, interaction],
      },
      sessions: state.sessions.map((s) =>
        s.id === interaction.sessionId
          ? { ...s, pendingInteractionCount: s.pendingInteractionCount + 1 }
          : s,
      ),
    };
  }),

  on(interactionResolved, (state, { interactionId, sessionId }): SessionsState => {
    const sessionInteractions = (state.pendingInteractions[sessionId] ?? [])
      .filter((i) => i.id !== interactionId);
    return {
      ...state,
      pendingInteractions: {
        ...state.pendingInteractions,
        [sessionId]: sessionInteractions,
      },
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, pendingInteractionCount: Math.max(0, s.pendingInteractionCount - 1) }
          : s,
      ),
    };
  }),

  on(setLayoutMode, (state, { sessionId, layoutMode }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, layoutMode } : s,
    ),
  })),

  on(updateSessionViewState, (state, { sessionId, viewState }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === sessionId
        ? { ...s, viewState: { ...(s.viewState ?? {}), ...viewState } }
        : s,
    ),
  })),

  on(reorderSessions, (state, { sessionIds }): SessionsState => {
    const byId = new Map(state.sessions.map(s => [s.id, s]));
    const reordered = sessionIds
      .map(id => byId.get(id))
      .filter((s): s is SessionSummary => !!s);
    // Append any sessions not in the reorder list (e.g. from other workspaces)
    const reorderedIds = new Set(sessionIds);
    const rest = state.sessions.filter(s => !reorderedIds.has(s.id));
    return {
      ...state,
      sessions: [...reordered, ...rest],
    };
  }),

  on(loadProfilesSuccess, (state, { profiles }): SessionsState => ({
    ...state,
    profiles,
  })),

  on(clearSessions, (): SessionsState => ({ ...initialSessionsState })),

  // When a workspace is deleted, unlink its sessions
  on(deleteWorkspaceSuccess, (state, { workspaceId }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.workspaceId === workspaceId ? { ...s, workspaceId: null } : s,
    ),
  })),

  // Promote standalone → workspace: replace the session entity with the
  // stored copy (workspaceId, team/project, workspace.path).
  on(promoteSessionSuccess, (state, { session }): SessionsState => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === session.id ? { ...s, ...session, status: s.status ?? session.status ?? 'idle' } : s,
    ),
  })),
);

/**
 * Keeps the selection when a list refresh gives the active session a new id.
 * At boot the list comes from the local cache first, and a parked session gets
 * a new live id once the real list arrives: without this the restored session
 * would be deselected a moment after it was selected.
 */
function followActiveSession(state: SessionsState, sessions: SessionSummary[]): string | null {
  const activeId = state.activeSessionId;
  if (!activeId || sessions.some((s) => s.id === activeId)) return activeId;
  const previous = state.sessions.find((s) => s.id === activeId);
  if (!previous) return activeId;
  const sameName = sessions.filter((s) => s.name === previous.name);
  const match = sameName.find((s) => s.workspaceId === previous.workspaceId) ?? (sameName.length === 1 ? sameName[0] : undefined);
  return match?.id ?? activeId;
}
