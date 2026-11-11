/**
 * Project search in the sidebar: it appears with 2+ folders or 7+ projects and
 * filters by folder name, workspace (or folder on disk) and session.
 */
export const SEARCH_MIN_FOLDERS = 2;
export const SEARCH_MIN_PROJECTS = 7;

export function shouldShowProjectSearch(folders: number, projects: number): boolean {
  return folders >= SEARCH_MIN_FOLDERS || projects >= SEARCH_MIN_PROJECTS;
}

export function normalizeProjectQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Only the last piece of the path: "projects" or "Users" must not make everything match. */
export function pathBasename(path: string | null | undefined): string {
  return (path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** `query` is already normalized. */
export function matchesProjectQuery(query: string, ...values: (string | null | undefined)[]): boolean {
  return values.some((v) => !!v && v.toLowerCase().includes(query));
}

interface SearchableGroup<S extends { name: string }> {
  workspace: { name: string; projectPath: string };
  sessions: S[];
}

/** Matching workspace → whole; otherwise only the matching sessions; null when nothing matches. */
export function filterWorkspaceGroup<S extends { name: string }, G extends SearchableGroup<S>>(group: G, query: string): G | null {
  const { name, projectPath } = group.workspace;
  if (matchesProjectQuery(query, name, pathBasename(projectPath))) return group;
  const sessions = group.sessions.filter((s) => matchesProjectQuery(query, s.name));
  return sessions.length > 0 ? { ...group, sessions } : null;
}
