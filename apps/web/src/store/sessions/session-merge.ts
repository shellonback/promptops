import { SessionSummary } from './session.state';

/**
 * Backend created_at (microsecond precision) normalized to toISOString(); falls
 * back to the live value when missing/unparsable, so a bad row never moves.
 */
function stableCreatedAt(saved: string | undefined, live: string): string {
  const t = saved ? Date.parse(saved) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : live;
}

/**
 * Merge metadata from saved (backend) → live (Electron) sessions.
 * All live sessions are kept — the backend save may still be in-flight
 * for recently created sessions, so filtering them out would cause a race condition.
 * Match by backend row id first (the live summary carries its dbId):
 * a name that diverged between app and backend (rename from another
 * instance/device, failed PUT) used to split one session into two
 * tabs. The name match stays as fallback for rows without dbId.
 * v2 only (Tauri, `byDbId`): Electron keeps the historical name-only merge.
 */
export function mergeLiveWithSaved(
  liveSessions: SessionSummary[],
  savedSessions: SessionSummary[],
  byDbId: boolean,
): SessionSummary[] {
  const mergedLive = liveSessions.map((live) => {
    const liveDbId = byDbId ? ((live as any).dbId as string | undefined) : undefined;
    // Offline the saved list is the boot cache, i.e. an already-merged
    // list: a live row there has its local id in `id` and the backend
    // row id in `dbId`. Taking `saved.id` as dbId would hand the local
    // id over, and folder membership (keyed by dbId) would drop it.
    const saved = (liveDbId ? savedSessions.find((s) => s.id === liveDbId || s.dbId === liveDbId) : undefined)
      ?? savedSessions.find((s) => s.name === live.name);
    if (saved) {
      return {
        ...live,
        dbId: saved.dbId ?? saved.id,
        // v2: the restore stamps createdAt with the restore time (ties
        // broken by HashMap order on macOS/Windows) → the sidebar,
        // which sorts by createdAt, reshuffled at every restart. The
        // backend row's created_at is immutable: same order every boot.
        createdAt: byDbId ? stableCreatedAt(saved.createdAt, live.createdAt) : live.createdAt,
        workspaceId: saved.workspaceId ?? live.workspaceId,
        categoryId: saved.categoryId ?? live.categoryId,
        teamId: saved.teamId ?? live.teamId,
        teamName: saved.teamName ?? live.teamName,
        projectId: saved.projectId ?? live.projectId,
        projectName: saved.projectName ?? live.projectName,
        repoUrl: saved.repoUrl ?? live.repoUrl,
        repoBranch: saved.repoBranch ?? live.repoBranch,
        deviceWorkspace: saved.deviceWorkspace ?? live.deviceWorkspace,
      };
    }
    return live;
  });

  const liveNames = new Set(mergedLive.map((s) => s.name));
  const liveDbIds = new Set(byDbId ? mergedLive.map((s) => (s as any).dbId).filter(Boolean) : []);

  // Keep saved sessions that don't have a live counterpart, dedup by id and name
  const seenNames = new Set<string>(liveNames);
  const uniqueSaved = savedSessions.filter((s) => {
    if (liveDbIds.has(s.id) || (s.dbId && liveDbIds.has(s.dbId))) return false;
    if (seenNames.has(s.name)) return false;
    seenNames.add(s.name);
    return true;
  });

  return [...mergedLive, ...uniqueSaved];
}
