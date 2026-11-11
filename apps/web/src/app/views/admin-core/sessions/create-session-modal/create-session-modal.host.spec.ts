import { NO_ERRORS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { Store } from '@ngrx/store';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { DataBackend } from '@core/data/data-backend';
import { SwalService } from '@core/services/swal.service';
import { UiStyleService } from '@core/services/ui-style.service';
import { AuthenticationService } from '@core/services/auth.service';
import { ProviderService } from '@core/services/provider.service';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { ProjectFolderImportService } from '../services/project-folder-import.service';
import { SessionHistoryService } from '../services/session-history.service';
import { REMOTE_COMMANDS_STORAGE_KEY } from '../services/session-host';
import { RemoteProbeResult, SessionService } from '../services/session.service';
import { SpawnSelectionService } from '../services/spawn-selection.service';
import { CreateSessionModalComponent } from './create-session-modal.component';

const CONN = { id: 'c1', name: 'Staging', host: 'staging.example.com', port: 22, username: 'deploy' };
const CMD = 'ssh ubuntu@203.0.113.10';
const PROBE_OK: RemoteProbeResult = {
  ok: true, os: 'Linux', arch: 'x86_64', kernel: '6.8', distro: 'Ubuntu 24.04',
  home: '/home/ubuntu', user: 'ubuntu', host: 'box', shell: 'bash', clis: ['claude'],
};
const PROBE_KO = { ...PROBE_OK, ok: false, error: 'Connection refused' } as RemoteProbeResult;

/** Host layer of the create-session wizard: local vs configured remote machines. */
describe('CreateSessionModalComponent — host picker', () => {
  let fixture: ComponentFixture<CreateSessionModalComponent>;
  let cmp: CreateSessionModalComponent;
  let isTauri: boolean;
  let session: {
    isTauri: boolean;
    isWindowsDesktop: boolean;
    isRemotePath: (p: string | null | undefined) => boolean;
    listSshConnections: jasmine.Spy;
    remoteProbe: jasmine.Spy;
    remoteCmdListDir: jasmine.Spy;
    remoteListDir: jasmine.Spy;
  };

  const text = (): string => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const q = (sel: string): HTMLElement | null => (fixture.nativeElement as HTMLElement).querySelector(sel);
  const qa = (sel: string): HTMLElement[] => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(sel));

  async function create(setup?: (c: CreateSessionModalComponent) => void): Promise<void> {
    fixture = TestBed.createComponent(CreateSessionModalComponent);
    cmp = fixture.componentInstance;
    setup?.(cmp);
    await cmp.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.removeItem(REMOTE_COMMANDS_STORAGE_KEY);
    isTauri = true;
    session = {
      get isTauri() { return isTauri; },
      isWindowsDesktop: false,
      isRemotePath: (p: string | null | undefined) => !!p && p.startsWith('ssh://'),
      listSshConnections: jasmine.createSpy('listSshConnections').and.resolveTo([CONN]),
      remoteProbe: jasmine.createSpy('remoteProbe').and.resolveTo(PROBE_OK),
      remoteCmdListDir: jasmine.createSpy('remoteCmdListDir').and.callFake(async (_c: string, path?: string) => ({
        ok: true, path: path || '/home/ubuntu', entries: [{ name: 'app', isDir: true }],
      })),
      remoteListDir: jasmine.createSpy('remoteListDir').and.callFake(async (_id: string, path: string) => ({
        ok: true, path: path || '/home/deploy', entries: [],
      })),
    } as any;

    TestBed.configureTestingModule({
      imports: [CreateSessionModalComponent, TranslateModule.forRoot()],
      providers: [
        { provide: NgbActiveModal, useValue: { close: jasmine.createSpy('close'), dismiss: jasmine.createSpy('dismiss') } },
        { provide: SessionService, useValue: session },
        { provide: SpawnSelectionService, useValue: { provider: () => 'claude-code-cli' } },
        { provide: SessionHistoryService, useValue: { createSessionCategory: async () => null } },
        { provide: DataBackend, useValue: { call: async () => null } },
        { provide: SwalService, useValue: {} },
        { provide: AuthenticationService, useValue: { setPreferredProvider: () => of(null) } },
        { provide: ProviderService, useValue: { refreshDetection: async () => undefined, resolveDefaultProvider: async () => 'claude-code-cli' } },
        { provide: ProjectFolderImportService, useValue: { supported: false, scan: async () => null, isProjectContainer: () => false } },
        { provide: Store, useValue: { select: () => of(null), dispatch: () => undefined } },
        { provide: UiStyleService, useValue: { style: () => 'minimal' } },
        { provide: BuiltinPluginsService, useValue: { isOn: () => false } },
      ],
    });
    // The host layer is plain template + signals: child components are out of scope.
    TestBed.overrideComponent(CreateSessionModalComponent, {
      set: { imports: [CommonModule, FormsModule, TranslateModule], schemas: [NO_ERRORS_SCHEMA] },
    });
  });

  afterEach(() => localStorage.removeItem(REMOTE_COMMANDS_STORAGE_KEY));

  it('is hidden outside the Tauri desktop: step 1 is the provider only, as before', async () => {
    isTauri = false;
    await create();
    expect(cmp.hostPickerVisible).toBeFalse();
    expect(q('.host-section')).toBeNull();
    expect(text()).toContain('SESSIONS.Step provider title');
    expect(session.listSshConnections).not.toHaveBeenCalled();
    expect(cmp.canGoNext).toBeTrue();
  });

  it('is hidden when a workspace is preset: the workspace already decides the machine', async () => {
    await create((c) => { c.presetWorkspace = { id: 'w1', path: '/tmp/p', name: 'p' }; });
    expect(cmp.hostPickerVisible).toBeFalse();
    expect(q('.host-section')).toBeNull();
    expect(cmp.workspace?.path).toBe('/tmp/p');
  });

  it('is hidden in edit mode, where the legacy "Remote folder" path mode stays', async () => {
    await create((c) => { c.editSession = { id: 's1', name: 'x', provider: 'claude-code-cli' }; });
    expect(cmp.hostPickerVisible).toBeFalse();
    expect(q('.host-section')).toBeNull();
    expect(text()).toContain('SESSIONS.REMOTE.Remote folder');
  });

  it('shows this computer selected by default, with the remote machines in their own group', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    await create();
    expect(cmp.hostKey()).toBe('local');
    expect(cmp.isRemoteHost).toBeFalse();
    expect(text()).toContain('SESSIONS.HOST.Step title');
    expect(qa('.host-group-label').map((e) => e.textContent?.trim())).toEqual([
      'SESSIONS.HOST.Group local', 'SESSIONS.HOST.Group remote',
    ]);
    const rows = qa('.host-row[role="radio"]');
    expect(rows.length).toBe(3); // local + ssh + command
    expect(rows[0].getAttribute('aria-checked')).toBe('true');
    expect(rows[1].textContent).toContain('Staging');
    expect(rows[1].textContent).toContain('deploy@staging.example.com');
    expect(rows[2].textContent).toContain(CMD);
    expect(qa('.host-forget').length).toBe(1); // only the command host can be forgotten here
    expect(q('.host-add')).not.toBeNull();
    expect(session.remoteProbe).not.toHaveBeenCalled();
  });

  it('with no remote machine configured still offers local + "add remote machine"', async () => {
    session.listSshConnections.and.resolveTo([]);
    await create();
    expect(qa('.host-row[role="radio"]').length).toBe(1);
    expect(q('.host-add')).not.toBeNull();
    expect(cmp.canGoNext).toBeTrue();
  });

  it('keeps the local folder modes (and no remote one) in step 2 when the host is local', async () => {
    await create();
    cmp.goToStepId('config');
    fixture.detectChanges();
    expect(q('.path-mode-toggle')).not.toBeNull();
    expect(text()).not.toContain('SESSIONS.REMOTE.Remote folder');
    expect(q('.host-summary')).toBeNull();
  });

  it('selecting a command host verifies it and drives step 2 straight to its folders', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    await create();
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'command')!);
    fixture.detectChanges();

    expect(session.remoteProbe).toHaveBeenCalledOnceWith(null, CMD);
    expect(cmp.isRemoteHost).toBeTrue();
    expect(cmp.pathMode()).toBe('remote');
    expect(cmp.remoteConnected).toBeTrue();
    expect(cmp.canGoNext).toBeTrue();
    expect(text()).toContain('SESSIONS.REMOTE.Connected');

    cmp.goToStepId('config');
    fixture.detectChanges();
    expect(q('.path-mode-toggle:not(.remote-folder-tabs)')).toBeNull();
    expect(q('.remote-steps')).toBeNull();
    expect(q('.host-summary')?.textContent).toContain(CMD);
    expect(cmp.remoteBrowserPath()).toBe('/home/ubuntu');

    cmp.remoteEnter('app');
    await fixture.whenStable();
    cmp.remoteSelectCurrent();
    expect(cmp.workspace).toEqual({ path: 'cmd:///home/ubuntu/app', name: 'app @ 203.0.113.10' });
    expect((cmp as any).remoteCommandForConfig()).toBe(CMD);
    expect(cmp.submitDisabled).toBeFalse();
  });

  it('selecting a saved SSH connection verifies it and builds an ssh:// folder', async () => {
    await create();
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'ssh')!);
    fixture.detectChanges();

    expect(session.remoteProbe).toHaveBeenCalledOnceWith('c1', null);
    expect(cmp.remoteType()).toBe('ssh');
    expect(cmp.hostKey()).toBe('ssh:c1');
    session.remoteListDir.calls.reset();
    await cmp.remoteBrowse('/srv/app');
    cmp.remoteSelectCurrent();
    expect(cmp.workspace).toEqual({ path: 'ssh://c1/srv/app', name: 'app @ staging.example.com' });
    expect((cmp as any).remoteCommandForConfig()).toBeUndefined();
  });

  it('a host that does not answer stays selected, shows the error and can be retried', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    session.remoteProbe.and.resolveTo(PROBE_KO);
    await create();
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'command')!);
    fixture.detectChanges();
    expect(cmp.hostKey()).toBe(`cmd:${CMD}`);
    expect(cmp.remoteConnected).toBeFalse();
    expect(text()).toContain('Connection refused');
    expect(text()).toContain('SESSIONS.REMOTE.Reconnect');

    session.remoteProbe.and.resolveTo(PROBE_OK);
    await cmp.remoteConnect();
    expect(cmp.remoteConnected).toBeTrue();
    expect(cmp.remoteError()).toBeNull();
  });

  it('adding a machine blocks Next until it connects, then remembers and selects it', async () => {
    session.listSshConnections.and.resolveTo([]);
    await create();
    cmp.startAddHost();
    fixture.detectChanges();
    expect(cmp.addingHost()).toBeTrue();
    expect(cmp.canGoNext).toBeFalse();
    expect(text()).toContain('SESSIONS.REMOTE.Connect command');

    cmp.onRemoteCommandChange(`  ${CMD} `);
    await cmp.remoteConnect();
    fixture.detectChanges();

    expect(cmp.addingHost()).toBeFalse();
    expect(cmp.hostKey()).toBe(`cmd:${CMD}`);
    expect(cmp.canGoNext).toBeTrue();
    expect(cmp.remoteHosts().map((h) => h.key)).toEqual([`cmd:${CMD}`]);
    expect(JSON.parse(localStorage.getItem(REMOTE_COMMANDS_STORAGE_KEY)!)).toEqual([CMD]);
    expect(qa('.host-row[role="radio"]').length).toBe(2);
  });

  it('a machine that cannot be verified is not saved until the user continues by hand', async () => {
    session.listSshConnections.and.resolveTo([]);
    session.remoteProbe.and.resolveTo(PROBE_KO);
    await create();
    cmp.startAddHost();
    cmp.onRemoteCommandChange('aws ssm start-session --target i-0abc');
    await cmp.remoteConnect();
    expect(cmp.addingHost()).toBeTrue();
    expect(cmp.canGoNext).toBeFalse();
    expect(localStorage.getItem(REMOTE_COMMANDS_STORAGE_KEY)).toBeNull();

    cmp.remoteContinueWithoutProbe();
    await fixture.whenStable();
    expect(cmp.addingHost()).toBeFalse();
    expect(cmp.hostKey()).toBe('cmd:aws ssm start-session --target i-0abc');
    expect(cmp.remoteFolderMode()).toBe('manual');
    expect(cmp.canGoNext).toBeTrue();
  });

  it('canceling the add form goes back to this computer', async () => {
    await create();
    cmp.startAddHost();
    cmp.onRemoteCommandChange(CMD);
    cmp.cancelAddHost();
    expect(cmp.addingHost()).toBeFalse();
    expect(cmp.hostKey()).toBe('local');
    expect(cmp.pathMode()).toBe('browse');
    expect(cmp.remoteCommand()).toBe('');
    expect(cmp.canGoNext).toBeTrue();
  });

  it('going back to this computer drops the remote folder and its auto-filled name', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    await create();
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'command')!);
    cmp.remoteSelectCurrent();
    expect(cmp.workspace?.path).toBe('cmd:///home/ubuntu');
    expect(cmp.name).toBe('ubuntu @ 203.0.113.10');

    cmp.selectLocalHost();
    expect(cmp.workspace).toBeNull();
    expect(cmp.name).toBe('');
    expect(cmp.pathMode()).toBe('browse');
    expect(cmp.isRemoteHost).toBeFalse();
    expect((cmp as any).remoteCommandForConfig()).toBeUndefined();
  });

  it('keeps a session name typed by the user when the machine changes', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    await create();
    cmp.name = 'my session';
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'command')!);
    cmp.remoteSelectCurrent();
    cmp.selectLocalHost();
    expect(cmp.name).toBe('my session');
  });

  it('forgetting the selected command host falls back to this computer', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    await create();
    const host = cmp.remoteHosts().find((h) => h.kind === 'command')!;
    await cmp.selectRemoteHost(host);
    cmp.forgetRemoteHost(host);
    expect(cmp.hostKey()).toBe('local');
    expect(cmp.pathMode()).toBe('browse');
    expect(cmp.remoteHosts().map((h) => h.key)).toEqual(['ssh:c1']);
  });

  it('asks one thing per step: machine, then provider, then configuration', async () => {
    await create();
    expect(cmp.wizardSteps).toEqual(['host', 'provider', 'config']);
    expect(qa('.wizard-step').length).toBe(3);
    expect(cmp.stepId).toBe('host');
    expect(q('.host-section')).not.toBeNull();
    expect(q('.provider-section')).toBeNull();
    expect(text()).toContain('SESSIONS.Cancel');

    cmp.goNextStep();
    fixture.detectChanges();
    expect(cmp.stepId).toBe('provider');
    expect(q('.host-section')).toBeNull();
    expect(q('.provider-section')).not.toBeNull();
    expect(text()).toContain('SESSIONS.Step provider title');
    expect(text()).toContain('SESSIONS.Back');
    expect(text()).toContain('SESSIONS.Next');

    cmp.goNextStep();
    fixture.detectChanges();
    expect(cmp.stepId).toBe('config');
    expect(q('.provider-section')).toBeNull();
    expect(text()).toContain('SESSIONS.Create Session');

    cmp.goPrevStep();
    expect(cmp.stepId).toBe('provider');
    cmp.goPrevStep();
    expect(cmp.stepId).toBe('host');
    cmp.goPrevStep();
    expect(cmp.currentStep()).toBe(1);
  });

  it('keeps the two original steps where no machine can be picked', async () => {
    isTauri = false;
    await create();
    expect(cmp.wizardSteps).toEqual(['provider', 'config']);
    expect(qa('.wizard-step').length).toBe(2);
    expect(cmp.stepId).toBe('provider');
    expect(q('.provider-section')).not.toBeNull();
    cmp.goNextStep();
    expect(cmp.stepId).toBe('config');
  });

  it('cannot jump past a machine that is still being added', async () => {
    await create();
    cmp.startAddHost();
    fixture.detectChanges();
    cmp.goToStep(2);
    cmp.goToStep(3);
    cmp.goNextStep();
    expect(cmp.stepId).toBe('host');
    const steps = qa('.wizard-step') as HTMLButtonElement[];
    expect(steps[1].disabled).toBeTrue();
    expect(steps[2].disabled).toBeTrue();
    cmp.cancelAddHost();
    fixture.detectChanges();
    expect((qa('.wizard-step')[2] as HTMLButtonElement).disabled).toBeFalse();
  });

  it('warns about a missing provider CLI only once the provider has been asked', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    session.remoteProbe.and.resolveTo({ ...PROBE_OK, clis: [] });
    await create();
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'command')!);
    fixture.detectChanges();
    expect(text()).not.toContain('SESSIONS.REMOTE.Provider missing');
    cmp.goToStepId('config');
    fixture.detectChanges();
    expect(text()).toContain('SESSIONS.REMOTE.Provider missing');
  });

  it('"change machine" goes back to the machine step', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify([CMD]));
    await create();
    await cmp.selectRemoteHost(cmp.remoteHosts().find((h) => h.kind === 'command')!);
    cmp.goToStepId('config');
    fixture.detectChanges();
    (q('.host-summary button') as HTMLButtonElement).click();
    expect(cmp.stepId).toBe('host');
  });

  it('never forgets a saved SSH connection from here', async () => {
    await create();
    const host = cmp.remoteHosts().find((h) => h.kind === 'ssh')!;
    cmp.forgetRemoteHost(host);
    expect(cmp.remoteHosts().map((h) => h.key)).toEqual(['ssh:c1']);
  });
});
