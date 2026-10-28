/**
 * Open/closed state of workspaces in the sidebar: a manual choice always
 * wins, and an automatic expand (wake) only undoes an automatic collapse
 * (park). `auto` = workspaces closed by the auto-collapse, not by the user.
 */
export interface WorkspaceExpandState {
  expanded: Map<string, boolean>;
  auto: Set<string>;
}

/** Workspaces never seen before start open. */
export function isExpanded(expanded: Map<string, boolean>, id: string): boolean {
  return expanded.get(id) ?? true;
}

export function applyParkTransitions(
  state: WorkspaceExpandState,
  collapse: string[],
  expand: string[],
): WorkspaceExpandState & { changed: boolean } {
  const expanded = new Map(state.expanded);
  const auto = new Set(state.auto);
  let changed = false;
  for (const id of collapse) {
    // Already closed (by hand or automatically): it does not become "auto",
    // so a wake never reopens a workspace the user closed.
    if (!isExpanded(expanded, id)) continue;
    expanded.set(id, false);
    auto.add(id);
    changed = true;
  }
  for (const id of expand) {
    if (!auto.has(id)) continue;
    auto.delete(id);
    expanded.set(id, true);
    changed = true;
  }
  return { expanded, auto, changed };
}

/** User toggle: from here on the state is theirs, never touched by a wake. */
export function applyManualToggle(state: WorkspaceExpandState, id: string): WorkspaceExpandState {
  const expanded = new Map(state.expanded);
  const auto = new Set(state.auto);
  expanded.set(id, !isExpanded(expanded, id));
  auto.delete(id);
  return { expanded, auto };
}

export function parseIdSet(raw: string | null): Set<string> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}
