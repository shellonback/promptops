import { TestBed } from '@angular/core/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { SessionService } from '../services/session.service';
import { WorkspaceSetupModalComponent } from './workspace-setup-modal.component';

describe('WorkspaceSetupModalComponent error states', () => {
  let component: WorkspaceSetupModalComponent;
  let sessions: Record<string, jasmine.Spy | boolean>;
  let modal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(() => {
    modal = jasmine.createSpyObj('modal', ['close', 'dismiss']);
    sessions = {
      isWindowsDesktop: false,
      isTauri: false,
      selectWorkspace: jasmine.createSpy('selectWorkspace'),
      validateWorkspacePath: jasmine.createSpy('validateWorkspacePath'),
      upsertDeviceWorkspace: jasmine.createSpy('upsertDeviceWorkspace'),
      updateSessionMeta: jasmine.createSpy('updateSessionMeta'),
      gitClone: jasmine.createSpy('gitClone'),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: NgbActiveModal, useValue: modal },
      { provide: SessionService, useValue: sessions },
      { provide: TranslateService, useValue: { instant: (key: string) => `t:${key}` } },
    ] });
    component = TestBed.runInInjectionContext(() => new WorkspaceSetupModalComponent());
  });

  it('shows a translated error when the folder picker fails', async () => {
    (sessions['selectWorkspace'] as jasmine.Spy).and.rejectWith(new Error('boom'));
    await component.selectFolder();
    expect(component.error()).toBe('t:SESSIONS.DEVICE_WORKSPACE.Error select folder');
  });

  it('shows a translated error and keeps the modal open for an invalid path', async () => {
    component.selectedPath.set('/nope');
    (sessions['validateWorkspacePath'] as jasmine.Spy).and.resolveTo({ valid: false });
    await component.confirm();
    expect(component.error()).toBe('t:SESSIONS.DEVICE_WORKSPACE.Error invalid path');
    expect(component.saving()).toBeFalse();
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('falls back to a translated clone error when the bridge gives none', async () => {
    component.cloneUrl.set('https://github.com/user/repo');
    component.cloneDestination.set('/tmp');
    (sessions['gitClone'] as jasmine.Spy).and.resolveTo({ ok: false });
    await component.cloneRepository();
    expect(component.error()).toBe('t:SESSIONS.DEVICE_WORKSPACE.Error clone');
    expect(component.cloning()).toBeFalse();
  });

  it('relink binds the folder to the stored session record, not the live id', async () => {
    component.sessionId = 'live-uuid';
    component.sessionDbId = 'db-id';
    component.selectedPath.set('/home/user/new-folder');
    (sessions['validateWorkspacePath'] as jasmine.Spy).and.resolveTo({ valid: true });
    (sessions['upsertDeviceWorkspace'] as jasmine.Spy).and.resolveTo({ ok: true });
    (sessions['updateSessionMeta'] as jasmine.Spy).and.resolveTo({ ok: true });
    await component.confirm();
    expect(sessions['upsertDeviceWorkspace']).toHaveBeenCalledWith('db-id', '/home/user/new-folder');
    expect(sessions['updateSessionMeta']).toHaveBeenCalledWith('live-uuid', {
      workspace: { path: '/home/user/new-folder', name: 'new-folder' },
    });
    expect(modal.close).toHaveBeenCalledWith({ localPath: '/home/user/new-folder' });
  });

  it('relink of a session never stored falls back to the live id', async () => {
    component.sessionId = 'live-uuid';
    component.selectedPath.set('/tmp/x');
    (sessions['validateWorkspacePath'] as jasmine.Spy).and.resolveTo({ valid: true });
    (sessions['upsertDeviceWorkspace'] as jasmine.Spy).and.resolveTo({ ok: true });
    (sessions['updateSessionMeta'] as jasmine.Spy).and.resolveTo({ ok: true });
    await component.confirm();
    expect(sessions['upsertDeviceWorkspace']).toHaveBeenCalledWith('live-uuid', '/tmp/x');
  });
});
