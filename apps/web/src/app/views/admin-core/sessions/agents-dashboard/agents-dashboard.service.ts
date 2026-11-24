import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { FloorPlanService } from '../floor-plan/floor-plan.service';
import { SnapshotStatus } from '../../plugins/plugin-workspace-snapshot';
import { SidebarExpandStateService } from '../session-sidebar/sidebar-expand-state.service';

/** Where the panel sits in the sessions view: closed or in place of the agents. */
export type AgentsDashboardMode = 'off' | 'full';
/** Workspaces = list grouped by folder and workspace; Pipeline = one column per status. */
export type AgentsDashboardView = 'list' | 'pipeline';
export type AwayStatus = 'waiting' | 'error' | 'idle' | 'working';
export type AwayFilter = 'all' | 'fresh' | AwayStatus;

/** An active agent, with where it lives and when its status last changed. */
export interface AwayAgent {
  key: string;
  sessionId: string;
  /** Pane to focus: `main` or `sa:<id>`. */
  paneId: string;
  name: string;
  isMain: boolean;
  session: string;
  provider: string;
  status: AwayStatus;
  /** Group: workspace id, or the session id when it has none. */
  groupKey: string;
  workspaceId: string | null;
  workspace: string;
  folderId: string | null;
  folder: string | null;
  folderColor: string | null;
  /** Last status change seen by this window (ms), null if it has not changed since the window opened. */
  since: number | null;
  /** Changed after the last look at the panel. */
  fresh: boolean;
}

export interface AwayGroup {
  key: string;
  /** Sidebar workspace: open/closed as it is there. Null = session without a workspace, always open. */
  workspaceId: string | null;
  open: boolean;
  title: string;
  folder: string | null;
  color: string | null;
  /** Most urgent status of the group. */
  status: AwayStatus;
  counts: Record<AwayStatus, number>;
  fresh: number;
  agents: AwayAgent[];
}

/** Sidebar folder with its workspaces, in the same order and open/closed as it is there. */
export interface AwaySection {
  key: string;
  folderId: string | null;
  title: string;
  color: string | null;
  open: boolean;
  status: AwayStatus;
  counts: Record<AwayStatus, number>;
  fresh: number;
  groups: AwayGroup[];
}

export interface AwayColumn { status: AwayStatus; title: string; hint: string; agents: AwayAgent[] }

export const STATUS_LABEL: Record<AwayStatus, string> = { waiting: 'Needs you', error: 'Error', idle: 'Done', working: 'Working' };
const STATUS_HINT: Record<AwayStatus, string> = {
  waiting: 'A question or a permission is open', error: 'Stopped with an error',
  idle: 'Finished its turn, ready for the next prompt', working: 'Busy right now',
};
export const STATUS_ORDER: AwayStatus[] = ['waiting', 'error', 'idle', 'working'];
// Agents waiting for you come first, then errors, then finished ones, then the ones working.
const RANK: Record<AwayStatus, number> = { waiting: 0, error: 1, idle: 2, working: 3 };
const isActive = (s: SnapshotStatus): s is AwayStatus => s in RANK;

const VIEW_KEY = 'po.agentsDashboard.view';
const SEEN_KEY = 'po.agentsDashboard.lastSeen';
const INTRO_KEY = 'po.agentsDashboard.opened';

/**
 * Built-in "Agents Dashboard" plugin: one brain over every session. Lists the active agents of every
 * workspace by status, with a button that takes you straight to their terminal. It reads the same snapshot
 * as Floor Plan: no calls, no extra data.
 */
@Injectable({ providedIn: 'root' })
export class AgentsDashboardService {
  private floor = inject(FloorPlanService);
  /** Open/closed state of folders and workspaces: the same as the sessions sidebar. */
  private expand = inject(SidebarExpandStateService);

  readonly mode = signal<AgentsDashboardMode>('off');
  readonly view = signal<AgentsDashboardView>(this.read(VIEW_KEY) === 'pipeline' ? 'pipeline' : 'list');
  readonly query = signal('');
  readonly filter = signal<AwayFilter>('all');
  /** Last time the panel was closed: whatever changes afterwards is "new". */
  readonly lastSeen = signal<number>(Number(this.read(SEEN_KEY)) || Date.now());
  /** Never opened on this device: the entry shows the NEW badge. */
  readonly neverOpened = signal(this.read(INTRO_KEY) !== '1');

  /** Terminal requested by the panel: the sessions view consumes it. */
  readonly pendingGoto = signal<{ sessionId: string; paneId: string } | null>(null);

  private sinceByKey = signal<ReadonlyMap<string, number>>(new Map());
  private lastStatus = new Map<string, SnapshotStatus>();

  constructor() {
    effect(() => {
      const sessions = this.floor.snapshot().sessions;
      untracked(() => {
        const now = Date.now();
        const next = new Map(this.sinceByKey());
        const seen = new Set<string>();
        let changed = false;
        for (const s of sessions) {
          for (const a of s.agents) {
            const key = `${s.id}/${a.id}`;
            seen.add(key);
            const prev = this.lastStatus.get(key);
            if (prev !== undefined && prev !== a.status) { next.set(key, now); changed = true; }
            this.lastStatus.set(key, a.status);
          }
        }
        for (const key of [...this.lastStatus.keys()]) {
          if (!seen.has(key)) { this.lastStatus.delete(key); if (next.delete(key)) changed = true; }
        }
        if (changed) this.sinceByKey.set(next);
      });
    });
  }

  /** All the active agents, sorted by urgency. */
  readonly agents = computed<AwayAgent[]>(() => {
    const since = this.sinceByKey();
    const seenAt = this.lastSeen();
    const snap = this.floor.snapshot();
    const wsById = new Map(snap.workspaces.map((w) => [w.id, w]));
    const folderById = new Map(snap.folders.map((f) => [f.id, f]));
    const out: AwayAgent[] = [];
    for (const s of snap.sessions) {
      const ws = s.workspaceId ? wsById.get(s.workspaceId) : undefined;
      const folder = folderById.get((ws ? ws.folderId : s.folderId) ?? '') ?? null;
      for (const a of s.agents) {
        if (!isActive(a.status)) continue;
        const key = `${s.id}/${a.id}`;
        const at = since.get(key) ?? null;
        out.push({
          key, sessionId: s.id, paneId: a.isMain ? 'main' : `sa:${a.id}`,
          name: a.isMain ? s.name : a.name, isMain: a.isMain, session: s.name, provider: a.provider, status: a.status,
          groupKey: ws ? `w:${ws.id}` : `s:${s.id}`, workspaceId: ws?.id ?? null, workspace: ws?.name ?? s.name,
          folderId: folder?.id ?? null, folder: folder?.name || null, folderColor: folder?.color && /^#[0-9a-fA-F]{6}$/.test(folder.color) ? folder.color : null,
          since: at, fresh: at !== null && at > seenAt && a.status !== 'working',
        });
      }
    }
    return out.sort((x, y) => RANK[x.status] - RANK[y.status] || (y.since ?? 0) - (x.since ?? 0) || x.name.localeCompare(y.name));
  });

  readonly counts = computed(() => {
    const list = this.agents();
    const by = (s: AwayStatus) => list.filter((a) => a.status === s).length;
    return { all: list.length, fresh: list.filter((a) => a.fresh).length, waiting: by('waiting'), error: by('error'), idle: by('idle'), working: by('working') };
  });

  /** Agents after search and filter. */
  readonly visible = computed<AwayAgent[]>(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    return this.agents().filter((a) =>
      (f === 'all' || (f === 'fresh' ? a.fresh : a.status === f))
      && (!q || `${a.name} ${a.session} ${a.workspace} ${a.folder ?? ''} ${a.provider}`.toLowerCase().includes(q)));
  });

  /**
   * Folders as in the sidebar (same order, same open/closed state), with the workspaces and their agents
   * inside: the most urgent workspace on top. While searching everything is open, as in the sidebar.
   */
  readonly sections = computed<AwaySection[]>(() => {
    const searching = !!this.query().trim();
    const wsOpen = this.expand.workspaces();
    const fOpen = this.expand.folders();
    const snapFolders = this.floor.snapshot().folders;
    const groups = new Map<string, AwayGroup>();
    const sectionOf = new Map<string, string>();
    for (const a of this.visible()) {
      let g = groups.get(a.groupKey);
      if (!g) {
        g = { key: a.groupKey, workspaceId: a.workspaceId, title: a.workspace, folder: a.folder, color: a.folderColor, status: a.status,
          open: searching || !a.workspaceId || (wsOpen.get(a.workspaceId) ?? true),
          counts: { waiting: 0, error: 0, idle: 0, working: 0 }, fresh: 0, agents: [] };
        groups.set(a.groupKey, g);
        sectionOf.set(a.groupKey, a.folderId ?? '~');
      }
      g.agents.push(a);
      g.counts[a.status]++;
      if (a.fresh) g.fresh++;
      if (RANK[a.status] < RANK[g.status]) g.status = a.status;
    }
    const byUrgency = (x: AwayGroup, y: AwayGroup) => RANK[x.status] - RANK[y.status] || y.fresh - x.fresh || x.title.localeCompare(y.title);
    const order = [...snapFolders.map((f) => ({ id: f.id, title: f.name || 'Folder', color: f.color && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : null })),
      { id: '~', title: snapFolders.length ? 'Outside folders' : 'All workspaces', color: null }];
    const out: AwaySection[] = [];
    for (const f of order) {
      const list = [...groups.values()].filter((g) => sectionOf.get(g.key) === f.id).sort(byUrgency);
      if (!list.length) continue;
      const counts = { waiting: 0, error: 0, idle: 0, working: 0 } as Record<AwayStatus, number>;
      for (const g of list) for (const st of STATUS_ORDER) counts[st] += g.counts[st];
      out.push({
        key: f.id, folderId: f.id === '~' ? null : f.id, title: f.title, color: f.color,
        open: searching || f.id === '~' || (fOpen.get(f.id) ?? true),
        status: list.reduce<AwayStatus>((m, g) => (RANK[g.status] < RANK[m] ? g.status : m), 'working'),
        counts, fresh: list.reduce((n, g) => n + g.fresh, 0), groups: list,
      });
    }
    return out;
  });

  /** Visible groups, in section order. */
  readonly groups = computed<AwayGroup[]>(() => this.sections().flatMap((s) => s.groups));

  readonly columns = computed<AwayColumn[]>(() => {
    const list = this.visible();
    return STATUS_ORDER.map((status) => ({ status, title: STATUS_LABEL[status], hint: STATUS_HINT[status], agents: list.filter((a) => a.status === status) }));
  });

  /** Keyboard-navigable rows, in the order they appear. */
  readonly navOrder = computed<AwayAgent[]>(() => {
    if (this.view() === 'pipeline') return this.columns().flatMap((c) => c.agents);
    return this.sections().flatMap((s) => (s.open ? s.groups.flatMap((g) => (g.open ? g.agents : [])) : []));
  });

  /** Count on the sidebar entry: what happened since the last look and who is waiting for you. */
  readonly alertCount = computed(() => this.agents().filter((a) => a.fresh || a.status === 'waiting').length);

  toggle(): void {
    if (this.mode() === 'full') this.close();
    else this.open();
  }

  open(): void {
    this.floor.close();
    this.mode.set('full');
    if (this.neverOpened()) {
      this.neverOpened.set(false);
      this.write(INTRO_KEY, '1');
    }
  }

  /** Closing counts as "seen": the status changes so far are no longer new. */
  close(): void {
    this.mode.set('off');
    this.markSeen();
  }

  markSeen(): void {
    const now = Date.now();
    this.lastSeen.set(now);
    this.write(SEEN_KEY, String(now));
  }

  setView(v: AgentsDashboardView): void {
    this.view.set(v);
    this.write(VIEW_KEY, v);
  }

  setFilter(f: AwayFilter): void {
    this.filter.set(this.filter() === f && f !== 'all' ? 'all' : f);
  }

  /** Opens or closes the workspace in the sidebar too. */
  toggleGroup(g: AwayGroup): void {
    if (g.workspaceId) this.expand.toggleWorkspace(g.workspaceId);
  }

  /** Opens or closes the folder in the sidebar too. */
  toggleSection(s: AwaySection): void {
    if (s.folderId) this.expand.toggleFolder(s.folderId);
  }

  /** Expand or collapse all: visible folders and workspaces, as if you did it in the sidebar. */
  setAllOpen(open: boolean): void {
    for (const s of this.sections()) {
      if (s.folderId) this.expand.setFolderOpen(s.folderId, open);
      for (const g of s.groups) if (g.workspaceId) this.expand.setWorkspaceOpen(g.workspaceId, open);
    }
  }

  goTo(a: AwayAgent): void {
    this.close();
    this.pendingGoto.set({ sessionId: a.sessionId, paneId: a.paneId });
  }

  private read(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  private write(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* stays in memory */ }
  }
}
