import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { EMPTY, from, of, forkJoin, merge } from 'rxjs';
import { map, switchMap, catchError, withLatestFrom, debounceTime, filter, groupBy, mergeMap, tap, finalize } from 'rxjs/operators';
import { isDataError } from '../../app/core/data/data-backend';
import {
  loadSessions,
  loadSessionsSuccess,
  loadSessionsFailure,
  createSession,
  createSessionSuccess,
  createSessionFailure,
  destroySession,
  destroySessionSuccess,
  standbySession,
  wakeSession,
  wakeSessionSuccess,
  wakeSessionFailure,
  standbyWorkspace,
  wakeWorkspace,
  sessionStandbyChanged,
  updateSessionSuccess,
  updateSessionViewState,
  loadProfiles,
  loadProfilesSuccess,
  promoteSession,
  promoteSessionSuccess,
  promoteSessionFailure,
  promoteSessionToWorkspace,
  clearSessions,
  sessionNameKey,
} from './session.actions';
import { decrementSessionCount, incrementSessionCount, upsertWorkspace } from '../workspaces/workspace.actions';
import { getSessions } from './session.selectors';
import { clearSessionsCache, readSessionsCache, writeSessionsCache } from './session.state';
import { getWorkspaces } from '../workspaces/workspace.selectors';
import { SessionSummary } from './session.state';
import { mergeLiveWithSaved } from './session-merge';
import { TranslateService } from '@ngx-translate/core';
import { SessionService } from '../../app/views/admin-core/sessions/services/session.service';
import { PromptInjectionService } from '../../app/views/admin-core/sessions/services/prompt-injection.service';
import { PtyDimsRegistry } from '../../app/views/admin-core/sessions/services/pty-dims-registry.service';
import { SwalService } from '../../app/core/services/swal.service';
import { SubAgentStashService } from '../../app/views/admin-core/sessions/services/sub-agent-stash.service';
import { SessionAccountGuardService } from '../../app/views/admin-core/sessions/services/session-account-guard.service';
import { TodoStoreService } from '../../app/views/admin-core/sessions/services/todo-store.service';
import { purgeBenchStorage, purgeLockStorage } from '../../app/views/admin-core/sessions/services/sub-agent-bench-storage';
import { DesktopSessionApiService } from '../../app/views/admin-core/sessions/services/desktop-session-api.service';
import { SessionHistoryService } from '../../app/views/admin-core/sessions/services/session-history.service';
import { WorkspaceApiService } from '../../app/views/admin-core/sessions/services/workspace-api.service';
import { SidebarFoldersService } from '../../app/views/admin-core/sessions/services/sidebar-folders.service';
import { isDetachedWindow, tauri } from '../../app/detached/detached-window';

@Injectable()
export class SessionEffects {
  private actions$ = inject(Actions);
  private store = inject(Store);
  private sessionService = inject(SessionService);
  private promptInjection = inject(PromptInjectionService);
  private subAgentStash = inject(SubAgentStashService);
  private accountGuard = inject(SessionAccountGuardService);
  private todoStore = inject(TodoStoreService);
  private apiService = inject(DesktopSessionApiService);
  private historyService = inject(SessionHistoryService);
  private workspaceApi = inject(WorkspaceApiService);
  private sidebarFolders = inject(SidebarFoldersService);
  private dimsRegistry = inject(PtyDimsRegistry);
  private swal = inject(SwalService);
  private translate = inject(TranslateService);
  private migrationTriggered = false;

  /**
   * Last successfully-fetched saved sessions. Reused as a fallback when the
   * local store list call fails (e.g. a transient storage error) so
   * a failed refresh never wipes the user's persisted sessions from the UI.
   */
  private lastSavedSessions: SessionSummary[] | null = null;

  /**
   * Load sessions by merging:
   * 1. Saved sessions from local store (idle, persisted across restarts)
   * 2. Live sessions from the desktop SessionManager (running terminals)
   *
   * Live sessions take priority — if a saved session's workspace matches
   * a live one, the live version is used instead of the idle DB copy.
   */
  loadSessions$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadSessions),
      switchMap(() => {
        // Discriminate a real local store failure from a genuinely-empty result so
        // we can keep prior sessions on failure (ok:false) instead of wiping them.
        const saved$ = this.apiService.pollList().pipe(
          map((sessions) => ({ ok: true as const, sessions })),
          catchError(() => of({ ok: false as const, sessions: [] as SessionSummary[] })),
        );
        const live$ = this.sessionService.isDesktop
          ? from(this.sessionService.listSessions()).pipe(catchError(() => of([] as SessionSummary[])))
          : of([] as SessionSummary[]);

        return forkJoin([saved$, live$]).pipe(
          map(([savedResult, liveSessions]) => {
            // On a successful fetch, refresh the cache and use the fresh data.
            // On failure, fall back to the last known-good saved sessions so the
            // poll merges with what the user already had rather than dropping it.
            if (savedResult.ok) {
              this.lastSavedSessions = savedResult.sessions;
            }
            // Never fetched successfully in this run: fall back to the boot cache.
            // With nothing to show at all, report a failure instead of a fake
            // "zero sessions" success — that rendered the welcome screen and the
            // first-run guide to users who simply had no network at startup.
            const savedSessions = savedResult.ok
              ? savedResult.sessions
              : (this.lastSavedSessions ?? readSessionsCache() ?? []);
            if (!savedResult.ok && savedSessions.length === 0 && liveSessions.length === 0) {
              return loadSessionsFailure({ error: 'sessions_list_unavailable' });
            }

            // Saved (local store) metadata onto live sessions; see mergeLiveWithSaved.
            // The desktop app is always v2: match by stored record id first.
            const finalSessions = mergeLiveWithSaved(liveSessions, savedSessions, true);

            // Auto-migrate legacy sessions if we detect any with workspace_path but empty device_workspace.id
            if (this.sessionService.isDesktop) {
              const hasLegacy = savedSessions.some(s => s.workspace?.path && (!s.deviceWorkspace || !s.deviceWorkspace.id));
              if (hasLegacy && !this.migrationTriggered) {
                this.migrationTriggered = true;
                this.sessionService.migrateDeviceWorkspaces().then((result) => {
                  if (result.migrated && result.migrated > 0) {
                  }
                }).catch(() => {});
              }

              // Validate paths for sessions that have device workspaces
              this.validateSessionPaths(finalSessions);
            }

            // Refresh the boot cache only on a real local store success, so a
            // transient failure never overwrites the last known-good list.
            if (savedResult.ok) {
              writeSessionsCache(finalSessions);
            }

            return loadSessionsSuccess({
              sessions: finalSessions,
            });
          }),
          catchError((err) => of(loadSessionsFailure({ error: err.message }))),
        );
      }),
    ),
  );

  /** Drop the boot cache on logout so another account never sees this list. */
  clearSessionsCache$ = createEffect(
    () => this.actions$.pipe(
      ofType(clearSessions),
      tap(() => clearSessionsCache()),
    ),
    { dispatch: false },
  );

  /**
   * Create a session:
   * 1. Spawn terminal via desktop IPC
   * 2. Save to local store for persistence
   */
  /** Names of creates still in flight: two creates with one name must not both pass the check below. */
  private readonly creatingNames = new Set<string>();

  createSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(createSession),
      withLatestFrom(this.store.select(getSessions)),
      // mergeMap: a second create while the first is still spawning must not
      // drop the first one's save (its terminal is already running).
      mergeMap(([{ name, provider, config, categoryId, teamId, projectId, workspaceId, initialPrompt, requestId }, sessions]) => {
        // Saving a session upserts by name: creating one with a name already
        // in use would take over the other session's record (its resume id,
        // sub-agents and workspace) and the native spawn would hand back that
        // session's live terminal. Refuse instead; the caller picks a free name.
        const key = name?.trim() ? sessionNameKey(name) : null;
        if (key && (this.creatingNames.has(key) || sessions.some((s) => s.name && sessionNameKey(s.name) === key))) {
          return of(createSessionFailure({
            error: this.translate.instant('USERS_ADMIN.Session name taken'),
            code: 'session_name_taken',
            requestId,
            name,
          }));
        }
        if (key) this.creatingNames.add(key);
        const fail = (error: string, code?: string) => createSessionFailure({ error, code, requestId, name });
        return from(this.sessionService.createSession({ name, provider, config, workspaceId })).pipe(
          switchMap((result) => {
            if (!result.ok || !result.session) {
              return of(fail(result.error ?? 'Unknown error'));
            }

            const session: SessionSummary = {
              ...result.session,
              name: name ?? result.session.name,
              categoryId: categoryId ?? null,
              workspaceId: workspaceId ?? null,
            };

            // Update workspace session count
            if (workspaceId) {
              this.store.dispatch(incrementSessionCount({ workspaceId }));
            }

            // Inject initial prompt once the provider has booted (retries +
            // submit-Enter re-send handled by the service).
            if (initialPrompt && this.sessionService.isDesktop) {
              this.promptInjection.injectIntoNewSession(session.id, initialPrompt);
            }

            // Save to local store and wait for completion before dispatching success.
            // This prevents a race condition where loadSessions() runs before the
            // local store has the record, causing the session to be filtered out.
            return this.apiService.create({
              name: session.name,
              provider: session.provider,
              workspace_path: session.workspace?.path,
              workspace_name: session.workspace?.name,
              workspace_id: workspaceId,
              config: config as Record<string, unknown>,
              category_id: categoryId,
              team_id: teamId,
              project_id: projectId,
              // The record belongs to this terminal: the store accepts it even
              // if a fresh record with the same name exists for it.
              local_session_id: session.id,
            }, { rethrowNameTaken: true }).pipe(
              map((saved) => {
                const dbId = saved?.id ?? session.id;
                this.historyService.setCategory(categoryId ?? null, session.name, dbId);
                this.historyService.logStart(session.provider);
                // Merge deviceWorkspace from API response so the session doesn't
                // show "not configured" until the next loadSessions refresh.
                const merged: SessionSummary = {
                  ...session,
                  dbId: saved?.id ?? session.dbId,
                  deviceWorkspace: saved?.deviceWorkspace ?? session.deviceWorkspace,
                };
                return createSessionSuccess({ session: merged, requestId });
              }),
            );
          }),
          catchError((err) => of(isDataError(err, 'session_name_taken')
            ? fail(this.translate.instant('USERS_ADMIN.Session name taken'), 'session_name_taken')
            : fail(err?.message ?? String(err)))),
          finalize(() => { if (key) this.creatingNames.delete(key); }),
        );
      }),
    ),
  );

  /**
   * Destroy a session:
   * 1. Kill terminal via desktop IPC
   * 2. Delete from local store
   */
  destroySession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(destroySession),
      withLatestFrom(this.store.select(getSessions)),
      switchMap(([{ sessionId }, sessions]) => {
        // Find workspace ID before removing the session from the store
        const session = sessions.find((s) => s.id === sessionId);
        const workspaceId = session?.workspaceId ?? null;

        // A deliberately closed session must never resurrect sub-agents, nor
        // leave a bench/TODO list behind for a same-named newcomer to inherit.
        if (session && this.sessionService.isDesktop) {
          this.subAgentStash.remove(session);
          purgeBenchStorage(session);
          purgeLockStorage(session);
        }
        if (session) this.todoStore.remove(session);

        const doDestroy = async () => {
          if (this.sessionService.isDesktop) {
            // Kill the desktop terminal
            try {
              await this.sessionService.destroySession(sessionId);
            } catch { /* already gone */ }
          }

          // Delete from local store by ID only — never fall back to name-based
          // deletion as it could delete the wrong session if names collide
          this.apiService.destroy(sessionId).pipe(
            catchError(() => of(false)),
          ).subscribe();
        };

        doDestroy();

        // Update workspace session count
        if (workspaceId) {
          this.store.dispatch(decrementSessionCount({ workspaceId }));
        }

        return of(destroySessionSuccess({ sessionId }));
      }),
    ),
  );

  /**
   * Park a session (standby): kill its provider process via the desktop app to
   * free CPU/RAM/FD, keep the record. The desktop app also updates the local store;
   * the non-desktop path PATCHes standby_at directly so other clients reflect it.
   */
  standbySession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(standbySession),
      mergeMap(({ sessionId }) => {
        const standbyAt = new Date().toISOString();
        if (this.sessionService.isDesktop) {
          return from(this.sessionService.standbySession(sessionId)).pipe(
            map((res) => sessionStandbyChanged({ sessionId, standbyAt: res?.session?.standbyAt ?? standbyAt })),
            catchError(() => of(sessionStandbyChanged({ sessionId, standbyAt }))),
          );
        }
        this.apiService.update(sessionId, { standby_at: standbyAt }, { silent: true }).subscribe();
        return of(sessionStandbyChanged({ sessionId, standbyAt }));
      }),
    ),
  );

  constructor() {
    // Live sessions left on the previous account after an AI Accounts switch.
    this.accountGuard.init();
  }

  /**
   * Wake a parked session: re-spawn its provider (desktop, --resume) and clear
   * the standby marker. Focus/switch-to is handled by the view component.
   * The localStorage stash of the session's parked sub-agents rides the wake
   * invoke so main can respawn them after an app restart (its in-memory copy
   * wins when present). Single choke point: every wake trigger (sidebar click,
   * selectSession, auto-wake, wakeWorkspace fan-out) dispatches this action.
   */
  /**
   * Session ids with a wake in flight. A second wake for the same id
   * is a no-op in Rust but still re-inits the terminal: dropped here.
   */
  private readonly wakesInFlight = new Set<string>();

  wakeSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(wakeSession),
      withLatestFrom(this.store.select(getSessions)),
      mergeMap(([{ sessionId }, sessions]) => {
        // Dedicated window: the main window does the resume (the output channel stays with it,
        // here we get a copy). If this window did it, closing it would kill the output.
        if (isDetachedWindow()) {
          void tauri()?.event.emit('session-window:action', { type: 'wake', sessionId });
          return EMPTY;
        }
        if (this.sessionService.isDesktop) {
          const session = sessions.find((s) => s.id === sessionId);
          const stash = session ? this.subAgentStash.read(session) : [];
          // Optimistic flip (the cover drops right away) PLUS an
          // awaited IPC: the resolve is the only true "PTY is live" signal
          // (the view re-attaches the terminal on wakeSessionSuccess); the
          // reject surfaces as wakeSessionFailure (toast) while the Rust
          // re-park emit restores the cover. Current xterm dims ride the
          // invoke so the new PTY spawns at the right grid.
          if (this.wakesInFlight.has(sessionId)) return EMPTY;
          this.wakesInFlight.add(sessionId);
          // Account switched in AI Accounts: a conversation of the old
          // account cannot resume on the new one — the guard asks first.
          return from(this.accountGuard.beforeWake(sessionId)).pipe(
            mergeMap((proceed) => {
              if (!proceed) return EMPTY;
              const dims = this.dimsRegistry.get(`session:${sessionId}`) ?? undefined;
              return merge(
                of(sessionStandbyChanged({ sessionId, standbyAt: null })),
                from(this.sessionService.wakeSession(sessionId, stash, dims)).pipe(
                  map(() => wakeSessionSuccess({ sessionId })),
                  catchError((err) =>
                    of(wakeSessionFailure({ sessionId, error: String(err?.message ?? err ?? '') })),
                  ),
                ),
              );
            }),
            finalize(() => this.wakesInFlight.delete(sessionId)),
          );
        }
        this.apiService.update(sessionId, { standby_at: null }, { silent: true }).subscribe();
        return of(sessionStandbyChanged({ sessionId, standbyAt: null }));
      }),
    ),
  );

  /**
   * [Tauri] A wake failed (provider binary missing, TCC-denied cwd, PTY spawn
   * error): make it visible. The cover itself is restored by the Rust re-park
   * emit (session:standby-changed with the old timestamp) — this only toasts.
   */
  wakeSessionFailed$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(wakeSessionFailure),
        tap(({ error }) => {
          const label = this.translate.instant('SESSIONS.Wake_Failed');
          this.swal.error(error ? `${label} — ${error}` : label);
        }),
      ),
    { dispatch: false },
  );

  /**
   * Create failed (missing provider, remote SSH folder/connection down,
   * PTY spawn): the error used to stay only in the state — now it's a toast,
   * as for wake. Born with remote sessions ("warn if the connection
   * fails") but it applies to every provider.
   */
  createSessionFailed$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(createSessionFailure),
        tap(({ error }) => {
          const label = this.translate.instant('SESSIONS.Create_Failed');
          this.swal.error(error ? `${label} — ${error}` : label);
        }),
      ),
    { dispatch: false },
  );

  /**
   * Hand parked sub-agent stashes back to main for sessions restored HOT
   * (lazy-boot active session, profile switch) — no wake will ever fire for
   * them, yet their sub-agents died with the previous run. Idempotent on
   * main's side, so running on every successful sessions load is safe.
   */
  restoreSubAgentStashes$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(loadSessionsSuccess),
        tap(({ sessions }) => {
          // A session's dedicated window: only the main window hands back the saved sub-agents.
          if (isDetachedWindow()) return;
          if (this.sessionService.isDesktop) this.subAgentStash.seedRestore(sessions);
        }),
      ),
    { dispatch: false },
  );

  /** Park every non-parked session in a workspace (per-session fan-out). */
  standbyWorkspace$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(standbyWorkspace),
        withLatestFrom(this.store.select(getSessions), this.store.select(getWorkspaces)),
        tap(([{ workspaceId }, sessions, workspaces]) => {
          this.sessionsInWorkspace(sessions, workspaces, workspaceId)
            .filter((s) => !s.standbyAt)
            .forEach((s) => this.store.dispatch(standbySession({ sessionId: s.id })));
        }),
      ),
    { dispatch: false },
  );

  /** Wake every parked session in a workspace (per-session fan-out). */
  wakeWorkspace$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(wakeWorkspace),
        withLatestFrom(this.store.select(getSessions), this.store.select(getWorkspaces)),
        tap(([{ workspaceId }, sessions, workspaces]) => {
          this.sessionsInWorkspace(sessions, workspaces, workspaceId)
            .filter((s) => !!s.standbyAt)
            .forEach((s) => this.store.dispatch(wakeSession({ sessionId: s.id })));
        }),
      ),
    { dispatch: false },
  );

  /**
   * Sessions belonging to a workspace — matches the sidebar grouping: by FK
   * `workspaceId` OR by legacy path equality. Filtering only on workspaceId
   * would miss path-bound sessions whose FK isn't set yet.
   */
  private sessionsInWorkspace(
    sessions: SessionSummary[],
    workspaces: { id: string; projectPath: string }[],
    workspaceId: string,
  ): SessionSummary[] {
    const ws = workspaces.find((w) => w.id === workspaceId);
    return sessions.filter(
      (s) =>
        s.workspaceId === workspaceId ||
        (!!ws && !!s.workspace?.path && s.workspace.path === ws.projectPath),
    );
  }

  loadProfiles$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadProfiles),
      switchMap(() =>
        from(this.sessionService.listProfiles()).pipe(
          map((profiles) => loadProfilesSuccess({ profiles })),
          catchError(() => of(loadProfilesSuccess({ profiles: [] }))),
        ),
      ),
    ),
  );

  /**
   * Promote a standalone session into an existing workspace.
   * The local store enforces the unidirectional constraint (sessions.promote).
   */
  promoteSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(promoteSession),
      withLatestFrom(this.store.select(getSessions)),
      switchMap(([{ sessionId, targetWorkspaceId }, sessions]) => {
        const folderId = this.folderOfSession(sessions, sessionId);
        return this.apiService.promote(sessionId, targetWorkspaceId).pipe(
          map((session) => {
            if (!session) {
              return promoteSessionFailure({ error: 'Promote failed (already in a workspace, or saving failed).' });
            }
            this.store.dispatch(incrementSessionCount({ workspaceId: targetWorkspaceId }));
            this.carryFolderToWorkspace(folderId, targetWorkspaceId);
            return promoteSessionSuccess({ session });
          }),
          catchError((err) => of(promoteSessionFailure({ error: err?.message ?? 'Promote failed.' }))),
        );
      }),
    ),
  );

  /**
   * Combo: find-or-create a workspace by project_path, then promote the session.
   * Used by the "Promote to Workspace" UI flow.
   */
  promoteSessionToWorkspace$ = createEffect(() =>
    this.actions$.pipe(
      ofType(promoteSessionToWorkspace),
      withLatestFrom(this.store.select(getSessions)),
      switchMap(([{ sessionId, projectPath, workspaceName }, sessions]) => {
        const folderId = this.folderOfSession(sessions, sessionId);
        return this.workspaceApi.findOrCreate({ project_path: projectPath, name: workspaceName }).pipe(
          switchMap((workspace) => {
            if (!workspace) {
              return of(promoteSessionFailure({ error: 'Workspace find-or-create failed.' }));
            }
            // The workspace may be brand new: without this upsert the sidebar
            // (which groups sessions on the workspaces store) shows nothing
            // until the next full reload.
            this.store.dispatch(upsertWorkspace({ workspace }));
            return this.apiService.promote(sessionId, workspace.id).pipe(
              map((session) => {
                if (!session) {
                  return promoteSessionFailure({ error: 'Promote failed after workspace creation.' });
                }
                this.store.dispatch(incrementSessionCount({ workspaceId: workspace.id }));
                this.carryFolderToWorkspace(folderId, workspace.id);
                return promoteSessionSuccess({ session });
              }),
              catchError((err) => of(promoteSessionFailure({ error: err?.message ?? 'Promote failed.' }))),
            );
          }),
          catchError((err) => of(promoteSessionFailure({ error: err?.message ?? 'Workspace find-or-create failed.' }))),
        );
      }),
    ),
  );

  /** Sidebar folder holding this standalone session (by stored dbId), if any. */
  private folderOfSession(sessions: SessionSummary[], sessionId: string): string | null {
    const s = sessions.find((x) => x.id === sessionId);
    const dbId = s?.dbId ?? sessionId;
    return this.sidebarFolders.sessionFolderMap().get(dbId) ?? null;
  }

  /**
   * Folders hold workspaces and standalone sessions separately: a promoted
   * session leaves the folder's sessionIds and its workspace would land at the
   * top level. Carry the folder over unless the workspace already has one.
   */
  private carryFolderToWorkspace(folderId: string | null, workspaceId: string): void {
    if (!folderId || this.sidebarFolders.workspaceFolderMap().has(workspaceId)) return;
    void this.sidebarFolders.assignWorkspace(workspaceId, folderId);
  }

  /**
   * Persist per-session view state (size, lock, sub-agent view mode).
   * Debounced per sessionId so drag-resize events at 60fps collapse into a
   * single local store write — but each session has its own debounce bucket so
   * fast switching between sessions doesn't drop writes for the others.
   *
   * Also forwards the update to the desktop app via IPC so the local session.json
   * cache matches (the local store is the source of truth, but the cache is the
   * offline fallback used by restoreAll when the local store is unreachable).
   */
  updateSessionViewState$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(updateSessionViewState),
        // Dedicated window: its dimensions are not the session's saved layout.
        filter(() => !isDetachedWindow()),
        withLatestFrom(this.store.select(getSessions)),
        tap(([{ sessionId, viewState }, sessions]) => {
          if (this.sessionService.isDesktop) {
            const merged = { ...(sessions.find((s) => s.id === sessionId)?.viewState ?? {}), ...viewState };
            this.sessionService.updateSessionMeta(sessionId, { viewState: merged }).catch(() => {});
          }
        }),
        groupBy(([{ sessionId }]) => sessionId),
        mergeMap((group$) =>
          group$.pipe(
            debounceTime(500),
            switchMap(([{ sessionId, viewState }, sessions]) => {
              const session = sessions.find((s) => s.id === sessionId);
              if (!session) return of(null);
              const merged = { ...(session.viewState ?? {}), ...viewState };
              return this.apiService
                .update(session.id, { view_state: merged, _lookup_name: session.name }, { silent: true })
                .pipe(catchError(() => of(null)));
            }),
          ),
        ),
      ),
    { dispatch: false },
  );

  /**
   * Validate local paths for sessions with device workspaces.
   * Updates the session's deviceWorkspace.status to 'invalid_path' if the path doesn't exist.
   */
  private async validateSessionPaths(sessions: SessionSummary[]): Promise<void> {
    for (const session of sessions) {
      if (session.deviceWorkspace?.localPath && session.deviceWorkspace.status === 'configured') {
        try {
          const result = await this.sessionService.validateWorkspacePath(session.deviceWorkspace.localPath);
          if (!result.valid) {
            // Update the session in the store with invalid_path status
            this.store.dispatch(updateSessionSuccess({
              session: {
                ...session,
                deviceWorkspace: {
                  ...session.deviceWorkspace,
                  status: 'invalid_path',
                },
              },
            }));
          }
        } catch {
          // Best-effort validation
        }
      }
    }
  }
}
