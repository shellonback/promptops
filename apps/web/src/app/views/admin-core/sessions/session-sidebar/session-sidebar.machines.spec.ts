import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { UiStyleService } from '@core/services/ui-style.service';
import { AGENTS_MODEL } from '../agents/agents-model.token';
import { AgentRosterService } from '../agents/agent-roster.service';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { PluginRuntimeService } from '../../plugins/plugin-runtime.service';
import { FloorPlanService } from '../floor-plan/floor-plan.service';
import { DesktopSessionApiService } from '../services/desktop-session-api.service';
import { EcoModeService } from '../services/eco-mode.service';
import { InteractionService } from '../services/interaction.service';
import { REMOTE_COMMANDS_STORAGE_KEY } from '../services/session-host';
import { SessionWindowsService } from '../services/session-windows.service';
import { SessionService } from '../services/session.service';
import { SidebarFolder } from '../services/sidebar-folder-api.service';
import { SidebarFoldersService } from '../services/sidebar-folders.service';
import { SubAgentService } from '../services/sub-agent.service';
import { SessionSidebarComponent } from './session-sidebar.component';
import {
  FOLDER_MACHINE_STORAGE_KEY,
  MACHINE_EXPANDED_STORAGE_KEY,
  SESSION_COMMAND_STORAGE_KEY,
} from './sidebar-machine-state.service';

const CMD = 'ssh ubuntu@203.0.113.10';
const KEYS = [FOLDER_MACHINE_STORAGE_KEY, MACHINE_EXPANDED_STORAGE_KEY, SESSION_COMMAND_STORAGE_KEY, REMOTE_COMMANDS_STORAGE_KEY];

const sess = (id: string, path: string, workspaceId: string | null = null, status = 'idle'): any => ({
  id, dbId: `db-${id}`, name: id, provider: 'claude-code-cli', status,
  workspace: { path, name: path.split('/').pop() }, workspaceId,
  createdAt: '2026-11-01T10:00:00Z', pendingInteractionCount: 0,
});
const ws = (id: string, projectPath: string): any => ({
  id, name: id, projectPath, activeSessionsCount: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
});
const folder = (id: string, workspaceIds: string[] = [], sessionIds: string[] = []): SidebarFolder => ({
  id, name: id, color: null, sortOrder: 0, workspaceIds, sessionIds,
});

const LOCAL = [sess('l1', '/p/one', 'w1'), sess('l2', '/p/two')];
const REMOTE = [sess('r1', 'ssh://c1/srv/api'), sess('r2', 'ssh://c1/srv/worker'), sess('r3', 'cmd:///home/u/app')];
const WORKSPACES = [ws('w1', '/p/one')];

/** Machine level of the sidebar tree: machine → folders → workspaces → sessions. */
describe('SessionSidebarComponent — machine level', () => {
  let fixture: ComponentFixture<SessionSidebarComponent>;
  let cmp: SessionSidebarComponent;
  let isTauri: boolean;
  let uiStyle: ReturnType<typeof signal<string>>;
  let folders: ReturnType<typeof signal<SidebarFolder[]>>;
  let foldersSvc: any;
  let getSession: jasmine.Spy;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const qa = (sel: string): HTMLElement[] => Array.from(el().querySelectorAll(sel));
  const machineNames = (): string[] => qa('.machine-name').map((e) => e.textContent!.trim());

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      // Not whenStable(): the sidebar keeps timers alive (attention clock).
      await new Promise((r) => setTimeout(r, 5));
    }
    fixture.detectChanges();
  }

  async function create(sessions: any[], opts: { collapsed?: boolean } = {}): Promise<void> {
    fixture = TestBed.createComponent(SessionSidebarComponent);
    cmp = fixture.componentInstance;
    fixture.componentRef.setInput('sessions', sessions);
    fixture.componentRef.setInput('workspaces', WORKSPACES);
    fixture.componentRef.setInput('collapsed', !!opts.collapsed);
    await settle();
  }

  const dragEvent = (): any => ({
    preventDefault: jasmine.createSpy('preventDefault'),
    stopPropagation: jasmine.createSpy('stopPropagation'),
    dataTransfer: { setData: () => undefined, effectAllowed: '', dropEffect: '' },
  });

  beforeEach(() => {
    KEYS.forEach((k) => localStorage.removeItem(k));
    isTauri = true;
    uiStyle = signal('minimal');
    folders = signal<SidebarFolder[]>([]);
    let created = 0;
    foldersSvc = {
      folders,
      loading: signal(false),
      workspaceFolderMap: () => new Map(folders().flatMap((f) => f.workspaceIds.map((w) => [w, f.id] as [string, string]))),
      sessionFolderMap: () => new Map(folders().flatMap((f) => f.sessionIds.map((s) => [s, f.id] as [string, string]))),
      createFolder: jasmine.createSpy('createFolder').and.callFake(async () => {
        const f = folder(`new${++created}`);
        folders.update((list) => [...list, f]);
        return f;
      }),
      assignWorkspace: jasmine.createSpy('assignWorkspace').and.resolveTo(),
      assignSession: jasmine.createSpy('assignSession').and.resolveTo(),
      reorderFolders: jasmine.createSpy('reorderFolders').and.resolveTo(),
      renameFolder: async () => undefined,
      deleteFolder: async () => undefined,
      setFolderColor: async () => undefined,
      load: async () => undefined,
    };
    getSession = jasmine.createSpy('getSession').and.callFake(async (id: string) => ({
      config: { remoteCommand: id === 'r3' ? CMD : undefined },
    }));

    TestBed.configureTestingModule({
      imports: [SessionSidebarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: SessionService, useValue: {
          get isTauri() { return isTauri; },
          isElectron: false,
          isWindowsDesktop: false,
          getSession,
          listSshConnections: async () => [{ id: 'c1', name: 'Staging', host: 'staging.example.com', port: 22, username: 'deploy' }],
        } },
        { provide: SidebarFoldersService, useValue: foldersSvc },
        { provide: UiStyleService, useValue: { style: uiStyle } },
        { provide: SubAgentService, useValue: { allSubAgents: signal([]), getSubAgents: () => [], subAgentsFor: () => [] } },
        { provide: AGENTS_MODEL, useValue: false },
        { provide: AgentRosterService, useValue: { ensureLoaded: () => undefined, rosterFor: () => [], leadClosed: () => false } },
        { provide: DesktopSessionApiService, useValue: {} },
        { provide: InteractionService, useValue: { isAutoApproved: () => false } },
        { provide: EcoModeService, useValue: { isActiveForSession: () => false, enabled: () => false } },
        { provide: BuiltinPluginsService, useValue: { isOn: () => false } },
        { provide: PluginRuntimeService, useValue: { sidebarPages: () => [] } },
        { provide: FloorPlanService, useValue: { mode: () => 'off', alertCount: () => 0, showFull: () => undefined, close: () => undefined } },
        { provide: SessionWindowsService, useValue: { open: () => undefined } },
        { provide: Router, useValue: { navigate: async () => true } },
        { provide: Store, useValue: { select: () => of(null), dispatch: () => undefined } },
      ],
    });
    TestBed.overrideComponent(SessionSidebarComponent, {
      set: { imports: [CommonModule, TranslateModule], schemas: [NO_ERRORS_SCHEMA] },
    });
  });

  afterEach(() => {
    fixture?.destroy();
    KEYS.forEach((k) => localStorage.removeItem(k));
  });

  // ── When the level shows ──

  it('stays off with local sessions only: the tree is the one from before', async () => {
    folders.set([folder('f1', ['w1'])]);
    await create(LOCAL);
    expect(cmp.machineLevel()).toBeFalse();
    expect(qa('.machine-section').length).toBe(0);
    expect(qa('.folder-section').length).toBe(1);
    expect(el().textContent).toContain('l2');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('stays off outside the Tauri desktop even with remote paths', async () => {
    isTauri = false;
    await create([...LOCAL, ...REMOTE]);
    expect(cmp.machineLevel()).toBeFalse();
    expect(qa('.machine-section').length).toBe(0);
    expect(getSession).not.toHaveBeenCalled();
    // l1 is the only session of workspace w1: the workspace row stands for it.
    for (const name of ['w1', 'l2', 'r1', 'r2', 'r3']) expect(el().textContent).toContain(name);
  });

  it('stays off in the classic UI', async () => {
    uiStyle.set('classic');
    await create([...LOCAL, ...REMOTE]);
    expect(cmp.machineLevel()).toBeFalse();
    expect(qa('.machine-section').length).toBe(0);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('shows one section per machine as soon as a remote session exists, this computer first', async () => {
    await create([...LOCAL, ...REMOTE]);
    expect(cmp.machineLevel()).toBeTrue();
    expect(machineNames()).toEqual(['SESSIONS.HOST.Local name', 'Staging', '203.0.113.10']);
    const sections = cmp.machineSections();
    expect(sections.map((m) => m.key)).toEqual(['local', 'ssh:c1', `cmd:${CMD}`]);
    expect(sections.map((m) => m.count)).toEqual([2, 2, 1]);
    expect(sections[1].detail).toBe('deploy@staging.example.com');
  });

  it('every session is rendered exactly once', async () => {
    await create([...LOCAL, ...REMOTE]);
    const seen = cmp.machineSections().flatMap((m) => [
      ...m.standalone.map((s) => s.id),
      ...m.groups.flatMap((g) => g.sessions.map((s) => s.id)),
      ...m.folders.flatMap((f) => [...f.standalone.map((s) => s.id), ...f.groups.flatMap((g) => g.sessions.map((s) => s.id))]),
    ]);
    expect(seen.sort()).toEqual(['l1', 'l2', 'r1', 'r2', 'r3']);
  });

  it('leaves the collapsed rail as it was', async () => {
    await create([...LOCAL, ...REMOTE], { collapsed: true });
    expect(qa('.machine-section').length).toBe(0);
    expect(qa('.collapsed-bar').length).toBe(1);
  });

  // ── cmd:// sessions ──

  it('resolves the connect command of a cmd:// session once and remembers it', async () => {
    await create([...LOCAL, ...REMOTE]);
    expect(getSession.calls.allArgs()).toEqual([['r3']]);
    expect(JSON.parse(localStorage.getItem(SESSION_COMMAND_STORAGE_KEY)!)).toEqual({ 'db-r3': CMD });
    fixture.componentRef.setInput('sessions', [...LOCAL, ...REMOTE, sess('l3', '/p/three')]);
    await settle();
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a cmd:// session under a generic remote machine while its command is unknown', async () => {
    getSession.and.resolveTo({ config: {} });
    await create([...LOCAL, REMOTE[2]]);
    expect(machineNames()).toEqual(['SESSIONS.HOST.Local name', 'SESSIONS.MACHINES.Unknown remote']);
  });

  it('names a machine from its command when the host is no longer configured', async () => {
    localStorage.setItem(SESSION_COMMAND_STORAGE_KEY, JSON.stringify({ 'db-r3': 'ssh me@gone.example.com' }));
    await create([REMOTE[2]]);
    expect(machineNames()).toEqual(['SESSIONS.HOST.Local name', 'gone.example.com']);
  });

  // ── Folders per machine ──

  it('gives each machine its own folders', async () => {
    folders.set([folder('work', ['w1']), folder('backend', [], ['db-r1', 'db-r2'])]);
    await create([...LOCAL, ...REMOTE]);
    const by = new Map(cmp.machineSections().map((m) => [m.key, m]));
    expect(by.get('local')!.folders.map((f) => f.folder.id)).toEqual(['work']);
    expect(by.get('ssh:c1')!.folders.map((f) => f.folder.id)).toEqual(['backend']);
    expect(by.get('ssh:c1')!.standalone).toEqual([]);
    // Inferred from the content, then remembered.
    expect(JSON.parse(localStorage.getItem(FOLDER_MACHINE_STORAGE_KEY)!)).toEqual({ work: 'local', backend: 'ssh:c1' });
  });

  it('keeps a folder on its machine once emptied', async () => {
    folders.set([folder('backend', [], ['db-r1'])]);
    await create([...LOCAL, ...REMOTE]);
    folders.set([folder('backend')]);
    await settle();
    const staging = cmp.machineSections().find((m) => m.key === 'ssh:c1')!;
    expect(staging.folders.map((f) => f.folder.id)).toEqual(['backend']);
  });

  it('keeps the level on for a remembered remote folder even with no remote session left', async () => {
    localStorage.setItem(FOLDER_MACHINE_STORAGE_KEY, JSON.stringify({ backend: 'ssh:c1' }));
    folders.set([folder('backend')]);
    await create(LOCAL);
    expect(cmp.machineLevel()).toBeTrue();
    expect(machineNames()).toEqual(['SESSIONS.HOST.Local name', 'Staging']);
  });

  it('ignores a remembered machine of a folder that no longer exists', async () => {
    localStorage.setItem(FOLDER_MACHINE_STORAGE_KEY, JSON.stringify({ gone: 'ssh:c1' }));
    await create(LOCAL);
    expect(cmp.machineLevel()).toBeFalse();
  });

  it('creates a folder on the machine whose header was used and opens that machine', async () => {
    localStorage.setItem(MACHINE_EXPANDED_STORAGE_KEY, JSON.stringify({ 'ssh:c1': false }));
    await create([...LOCAL, ...REMOTE]);
    await cmp.createFolderInline('ssh:c1');
    await settle();
    expect(JSON.parse(localStorage.getItem(FOLDER_MACHINE_STORAGE_KEY)!)['new1']).toBe('ssh:c1');
    expect(cmp.isMachineExpanded('ssh:c1')).toBeTrue();
    expect(cmp.machineSections().find((m) => m.key === 'ssh:c1')!.folders.map((f) => f.folder.id)).toEqual(['new1']);
  });

  it('the header "new folder" button still creates on this computer', async () => {
    await create([...LOCAL, ...REMOTE]);
    await cmp.createFolderInline();
    await settle();
    expect(cmp.machineSections()[0].folders.map((f) => f.folder.id)).toEqual(['new1']);
  });

  it('the machine header button creates the folder there (real click)', async () => {
    await create([...LOCAL, ...REMOTE]);
    qa('.machine-add-folder')[1].click();
    await settle();
    expect(foldersSvc.createFolder).toHaveBeenCalledTimes(1);
    // The click must not also collapse the machine.
    expect(cmp.isMachineExpanded('ssh:c1')).toBeTrue();
    expect(cmp.machineSections().find((m) => m.key === 'ssh:c1')!.folders.length).toBe(1);
  });

  // ── Open / closed, remembered ──

  it('collapses a machine on click, hides its content and remembers it', async () => {
    await create([...LOCAL, ...REMOTE]);
    expect(el().textContent).toContain('r1');
    qa('.machine-header')[1].click();
    await settle();
    expect(el().textContent).not.toContain('r1');
    expect(el().textContent).toContain('l2');
    expect(JSON.parse(localStorage.getItem(MACHINE_EXPANDED_STORAGE_KEY)!)).toEqual({ 'ssh:c1': false });
    expect(qa('.machine-header')[1].getAttribute('aria-expanded')).toBe('false');
  });

  it('starts with the machines closed last time still closed', async () => {
    localStorage.setItem(MACHINE_EXPANDED_STORAGE_KEY, JSON.stringify({ local: false }));
    await create([...LOCAL, ...REMOTE]);
    expect(el().textContent).not.toContain('l2');
    expect(el().textContent).toContain('r1');
  });

  it('toggles from the keyboard', async () => {
    await create([...LOCAL, ...REMOTE]);
    qa('.machine-header')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(cmp.isMachineExpanded('local')).toBeFalse();
  });

  it('surfaces a session waiting for input on a collapsed machine', async () => {
    localStorage.setItem(MACHINE_EXPANDED_STORAGE_KEY, JSON.stringify({ 'ssh:c1': false }));
    await create([...LOCAL, sess('r1', 'ssh://c1/srv/api', null, 'waiting_input')]);
    const headers = qa('.machine-header');
    expect(headers[1].classList).toContain('needs-attention');
    expect(headers[0].classList).not.toContain('needs-attention');
  });

  // ── Drag & drop ──

  it('accepts a drop only on a folder of the same machine', async () => {
    folders.set([folder('work', ['w1']), folder('backend', [], ['db-r1'])]);
    await create([...LOCAL, ...REMOTE]);

    cmp.onItemDragStart(dragEvent(), 'session', 'db-r2');
    expect(cmp.draggedMachine()).toBe('ssh:c1');

    const over = dragEvent();
    cmp.onFolderTargetDragOver(over, 'work');
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(cmp.dropTargetFolderId()).toBeNull();
    cmp.onFolderTargetDrop(dragEvent(), 'work');
    expect(foldersSvc.assignSession).not.toHaveBeenCalled();
    expect(cmp.draggedItem()).not.toBeNull();

    const ok = dragEvent();
    cmp.onFolderTargetDragOver(ok, 'backend');
    expect(ok.preventDefault).toHaveBeenCalled();
    cmp.onFolderTargetDrop(dragEvent(), 'backend');
    expect(foldersSvc.assignSession).toHaveBeenCalledOnceWith('db-r2', 'backend');
  });

  it('accepts a local workspace only on a local folder', async () => {
    folders.set([folder('work'), folder('backend', [], ['db-r1'])]);
    localStorage.setItem(FOLDER_MACHINE_STORAGE_KEY, JSON.stringify({ work: 'local' }));
    await create([...LOCAL, ...REMOTE]);
    cmp.onItemDragStart(dragEvent(), 'workspace', 'w1');
    cmp.onFolderTargetDrop(dragEvent(), 'backend');
    expect(foldersSvc.assignWorkspace).not.toHaveBeenCalled();
    cmp.onFolderTargetDrop(dragEvent(), 'work');
    expect(foldersSvc.assignWorkspace).toHaveBeenCalledOnceWith('w1', 'work');
  });

  it('reorders folders only within the same machine', async () => {
    folders.set([folder('work', ['w1']), folder('home', [], ['db-l2']), folder('backend', [], ['db-r1'])]);
    await create([...LOCAL, ...REMOTE]);
    cmp.onItemDragStart(dragEvent(), 'folder', 'backend');
    cmp.onFolderTargetDrop(dragEvent(), 'work');
    expect(foldersSvc.reorderFolders).not.toHaveBeenCalled();
    cmp.onItemDragEnd();
    cmp.onItemDragStart(dragEvent(), 'folder', 'home');
    cmp.onFolderTargetDrop(dragEvent(), 'work');
    expect(foldersSvc.reorderFolders).toHaveBeenCalledOnceWith(['home', 'work', 'backend']);
  });

  it('with the level off any folder still takes any item, as before', async () => {
    folders.set([folder('a'), folder('b')]);
    await create(LOCAL);
    cmp.onItemDragStart(dragEvent(), 'session', 'db-l2');
    cmp.onFolderTargetDrop(dragEvent(), 'b');
    expect(foldersSvc.assignSession).toHaveBeenCalledOnceWith('db-l2', 'b');
  });

  it('shows the "remove from folder" zone only on the machine of the dragged item', async () => {
    folders.set([folder('backend', [], ['db-r1'])]);
    await create([...LOCAL, ...REMOTE]);
    cmp.onItemDragStart(dragEvent(), 'session', 'db-r1');
    await settle();
    const zones = qa('.folder-unfile-zone');
    expect(zones.length).toBe(1);
    expect(zones[0].closest('.machine-section')!.querySelector('.machine-name')!.textContent).toContain('Staging');
  });

  // ── Context menu ──

  it('"move to folder" offers only the folders of the item\'s machine', async () => {
    folders.set([folder('work', ['w1']), folder('backend', [], ['db-r1'])]);
    await create([...LOCAL, ...REMOTE]);
    (cmp as any).ctxTargetRaw.set({ type: 'session', session: REMOTE[1] });
    expect(cmp.ctxMoveFolders().map((f) => f.id)).toEqual(['backend']);
    (cmp as any).ctxTargetRaw.set({ type: 'workspace', workspace: WORKSPACES[0] });
    expect(cmp.ctxMoveFolders().map((f) => f.id)).toEqual(['work']);
    (cmp as any).ctxTargetRaw.set({ type: 'session', session: LOCAL[1] });
    expect(cmp.ctxMoveFolders().map((f) => f.id)).toEqual(['work']);
  });

  it('"move to folder" offers every folder when the level is off', async () => {
    folders.set([folder('a'), folder('b')]);
    await create(LOCAL);
    (cmp as any).ctxTargetRaw.set({ type: 'session', session: LOCAL[1] });
    expect(cmp.ctxMoveFolders().map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('"move to a new folder" creates it on the machine of the item', async () => {
    await create([...LOCAL, ...REMOTE]);
    (cmp as any).ctxTargetRaw.set({ type: 'session', session: REMOTE[0] });
    await cmp.ctxMoveToNewFolder();
    expect(foldersSvc.assignSession).toHaveBeenCalledOnceWith('db-r1', 'new1');
    expect(JSON.parse(localStorage.getItem(FOLDER_MACHINE_STORAGE_KEY)!)['new1']).toBe('ssh:c1');
  });
});
