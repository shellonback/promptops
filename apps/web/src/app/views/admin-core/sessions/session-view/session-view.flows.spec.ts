import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { SessionViewComponent } from './session-view.component';

/**
 * Session flows of the Sessions view, exercised on the component's own
 * methods with a minimal `this` (the full component needs the desktop shell).
 */
const proto = SessionViewComponent.prototype as any;

function session(over: Record<string, unknown> = {}): any {
  return { id: 'saved-b', name: 'api', provider: 'claude-code-cli', status: 'idle', workspace: { path: '/w', name: 'w' }, ...over };
}

function baseView(over: Record<string, unknown> = {}): any {
  const dispatched: any[] = [];
  const errors: string[] = [];
  const view: any = {
    dispatched,
    errors,
    dedicatedSessionId: null,
    floorPlan: { dock() {}, acknowledge() {} },
    agentsDashboard: { mode: () => 'off', close() {} },
    activeSessionId: signal<string | null>(null),
    sessions: signal<any[]>([]),
    store: { dispatch: (a: any) => dispatched.push(a) },
    swalService: { error: (m: string) => errors.push(m) },
    translateService: { instant: (k: string) => k },
    openingIdleSessions: new Set<string>(),
    scheduleAutoFocusOnOpen() {},
    nudgeLayoutForRefit() {},
    resyncLiveStatus() {},
    switched: [] as string[],
    switchToSession(id: string) { this.switched.push(id); },
    ...over,
  };
  return view;
}

describe('SessionViewComponent.selectSession (idle saved session)', () => {
  it('never attaches a live terminal already bound to another session with the same name', async () => {
    const created: any[] = [];
    const view = baseView({
      sessions: signal([session({ id: 'live-a', status: 'running' }), session()]),
      sessionService: {
        isDesktop: true, isTauri: true,
        listSessions: async () => [{ id: 'live-a', name: 'api', status: 'running' }],
        createSession: async (req: any) => { created.push(req); return { ok: true, session: { id: 'live-b', status: 'idle' } }; },
      },
    });
    await proto.selectSession.call(view, 'saved-b');
    expect(created.length).toBe(1);
    const act = view.dispatched.find((a: any) => a.savedSessionId === 'saved-b');
    expect(act.liveSession.id).toBe('live-b');
  });

  it('spawns one terminal when clicked twice while the first spawn is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let creates = 0;
    const view = baseView({
      sessions: signal([session()]),
      sessionService: {
        isDesktop: true, isTauri: true,
        listSessions: async () => { await gate; return []; },
        createSession: async () => { creates++; return { ok: true, session: { id: 'live-b' } }; },
      },
    });
    const first = proto.selectSession.call(view, 'saved-b');
    const second = proto.selectSession.call(view, 'saved-b');
    release();
    await Promise.all([first, second]);
    expect(creates).toBe(1);
    expect(view.openingIdleSessions.size).toBe(0);
  });

  it('tells the user when the terminal cannot be started', async () => {
    const view = baseView({
      sessions: signal([session()]),
      sessionService: {
        isDesktop: true, isTauri: true,
        listSessions: async () => [],
        createSession: async () => ({ ok: false, error: 'boom' }),
      },
    });
    await proto.selectSession.call(view, 'saved-b');
    expect(view.errors).toEqual(['SESSIONS.Wake_Failed']);
  });
});

describe('SessionViewComponent.addTabSessionFor (first tab of a standalone session)', () => {
  function tabView(update: () => any, create: () => any, sessions: any[]) {
    const created: any[] = [];
    const view = baseView({
      sessions: signal(sessions),
      builtins: { isOn: () => true },
      sessionService: { isDesktop: false, updateSessionMeta: async () => {} },
      workspaceApiService: { findOrCreate: () => of({ id: 'ws1' }) },
      historyService: { logWorkspaceCreated() {}, createSessionCategory: async () => null, logTabAdded() {} },
      desktopSessionApiService: {
        update: () => update(),
        create: (req: any) => { created.push(req); return create(); },
      },
    });
    return { view, created };
  }
  const current = session({ id: 'live-foo', name: 'Foo', workspaceId: null, workspace: { path: '/p', name: 'p' } });

  it('does not overwrite another session that already has the first tab name', async () => {
    const other = session({ id: 'other', name: 'Foo 1' });
    const { view, created } = tabView(() => of(null), () => of({}), [current, other]);
    await proto.addTabSessionFor.call(view, current);
    expect(created).toEqual([]);
    expect(view.errors).toEqual(['USERS_ADMIN.Session name taken']);
    expect(view.dispatched.some((a: any) => a.session?.name === 'Foo 1')).toBeFalse();
  });

  it('stops on a name conflict reported by the store instead of creating over it', async () => {
    const { view, created } = tabView(
      () => throwError(() => ({ code: 'session_name_taken', message: 'x' })), () => of({}), [current],
    );
    await proto.addTabSessionFor.call(view, current);
    expect(created).toEqual([]);
    expect(view.errors).toEqual(['USERS_ADMIN.Session name taken']);
  });

  it('creates the saved session only when it was never saved, then opens tab 2', async () => {
    const { view, created } = tabView(
      () => throwError(() => ({ code: 'not_found', message: 'x' })), () => of({ id: 'saved' }), [current],
    );
    await proto.addTabSessionFor.call(view, current);
    expect(created.length).toBe(1);
    expect(created[0].name).toBe('Foo 1');
    const create = view.dispatched.find((a: any) => a.type?.includes('Create') || a.name === 'Foo 2');
    expect(create?.name).toBe('Foo 2');
  });

  it('skips a tab name another session already uses', async () => {
    const saved = session({ id: 'live-foo', name: 'Foo 1', workspaceId: 'ws1', workspace: { path: '/p', name: 'p' } });
    const elsewhere = session({ id: 'x', name: 'Foo 2', workspaceId: 'ws-other' });
    const { view } = tabView(() => of({}), () => of({}), [saved, elsewhere]);
    await proto.addTabSessionFor.call(view, saved);
    const create = view.dispatched.find((a: any) => typeof a.name === 'string' && a.name.startsWith('Foo '));
    expect(create.name).toBe('Foo 3');
  });
});

describe('SessionViewComponent.runProviderCheck', () => {
  it('drops the result of a check that finished after the user switched session', async () => {
    let resolveA!: (v: any) => void;
    const view = baseView({
      providerCheckSeq: 0,
      activeSessionId: signal<string | null>('A'),
      providerChecking: signal(false),
      providerMissing: signal(false),
      providerPlatform: signal(''),
      providerCommand: signal(''),
      manualPlatform: signal('darwin'),
      sessionService: {
        checkProvider: (p: string) => p === 'a'
          ? new Promise((r) => (resolveA = r))
          : Promise.resolve({ installed: true, platform: 'darwin', command: 'b' }),
      },
    });
    const a = proto.runProviderCheck.call(view, 'a', false, 'A');
    view.activeSessionId.set('B');
    await proto.runProviderCheck.call(view, 'b', false, 'B');
    resolveA({ installed: false, platform: 'darwin', command: 'a' });
    await a;
    expect(view.providerMissing()).toBeFalse();
    expect(view.providerCommand()).toBe('b');
    expect(view.providerChecking()).toBeFalse();
  });
});

describe('SessionViewComponent.onSubAgentKeyDown', () => {
  function keyView() {
    const switched: string[] = [];
    const view = baseView({
      isMac: false,
      paneRoster: () => [{ id: '__main__' }, { id: 'sa1' }, { id: 'sa2' }],
      sessionShortcuts: { actionFor: () => null },
      subAgentsExpanded: signal(false),
      switchSubAgentTab: (id: string) => switched.push(id),
    });
    return { view, switched };
  }

  it('numbers panes like the tab badges and stops the key before the terminal sees it', () => {
    const { view, switched } = keyView();
    const ev = new KeyboardEvent('keydown', { code: 'Digit2', altKey: true, cancelable: true });
    const stop = spyOn(ev, 'stopPropagation').and.callThrough();
    proto.onSubAgentKeyDown.call(view, ev);
    expect(switched).toEqual(['sa1']);
    expect(ev.defaultPrevented).toBeTrue();
    expect(stop).toHaveBeenCalled();
  });

  it('lets keys that are not shortcuts reach the terminal', () => {
    const { view, switched } = keyView();
    const ev = new KeyboardEvent('keydown', { code: 'KeyQ', altKey: true, cancelable: true });
    proto.onSubAgentKeyDown.call(view, ev);
    expect(switched).toEqual([]);
    expect(ev.defaultPrevented).toBeFalse();
  });
});

describe('SessionViewComponent.onSaDropZoneDrop (drop on the session screen)', () => {
  function dropView(importPaths: (ws: string, paths: string[]) => Promise<any>) {
    const highlighted: string[][] = [];
    const view = baseView({
      activeSession: () => session(),
      sessionAssetsService: { importPaths, assets: () => [] },
      assetsPanel: { expandAndHighlight: (names: string[]) => highlighted.push(names) },
      uploadAssetsFromDrop: jasmine.createSpy('uploadAssetsFromDrop'),
    });
    view.importAssetsFromDrop = proto.importAssetsFromDrop;
    return { view, highlighted };
  }

  // Linux/WebKitGTK: no File objects, the paths come from the native drag tracker.
  function linuxDrop(paths: string[]): DragEvent {
    (window as any).__PROMPTOPS_OS__ = 'linux';
    (window as any).promptops = { getDragPaths: () => paths };
    return { dataTransfer: { files: [], types: ['text/uri-list'], getData: () => '' } } as unknown as DragEvent;
  }

  afterEach(() => {
    delete (window as any).promptops;
    delete (window as any).__PROMPTOPS_OS__;
  });

  it('imports the dropped paths into the session assets when the drop has no File objects', async () => {
    const calls: Array<[string, string[]]> = [];
    const { view, highlighted } = dropView(async (ws, paths) => {
      calls.push([ws, paths]);
      return [{ name: 'a.png' }];
    });
    proto.onSaDropZoneDrop.call(view, linuxDrop(['/home/u/a.png']));
    await new Promise((r) => setTimeout(r));
    expect(calls).toEqual([['/w', ['/home/u/a.png']]]);
    expect(highlighted).toEqual([['a.png']]);
    expect(view.uploadAssetsFromDrop).not.toHaveBeenCalled();
  });

  it('shows the error when the import fails', async () => {
    const { view } = dropView(async () => { throw new Error('denied'); });
    proto.onSaDropZoneDrop.call(view, linuxDrop(['/home/u/locked.png']));
    await new Promise((r) => setTimeout(r));
    expect(view.errors).toEqual(['ASSETS.Upload failed']);
  });

  it('keeps uploading File objects when the drop carries them', () => {
    const { view } = dropView(async () => []);
    const file = new File(['x'], 'b.txt');
    proto.onSaDropZoneDrop.call(view, { dataTransfer: { files: [file] } } as unknown as DragEvent);
    expect(view.uploadAssetsFromDrop).toHaveBeenCalledOnceWith([file]);
  });
});
