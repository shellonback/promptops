import { TestBed } from '@angular/core/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { Store } from '@ngrx/store';
import { DataBackend } from '@core/data/data-backend';
import { SwalService } from '@core/services/swal.service';
import { UiStyleService } from '@core/services/ui-style.service';
import { AuthenticationService } from '@core/services/auth.service';
import { ProviderService } from '@core/services/provider.service';
import { SessionService } from '../services/session.service';
import { SessionHistoryService } from '../services/session-history.service';
import { SpawnSelectionService } from '../services/spawn-selection.service';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { CreateSessionModalComponent } from './create-session-modal.component';

describe('CreateSessionModalComponent', () => {
  let component: CreateSessionModalComponent;
  let sessionService: Record<string, jasmine.Spy | boolean>;

  beforeEach(() => {
    sessionService = {
      isTauri: true,
      isWindowsDesktop: false,
      remoteCmdCreateFolder: jasmine.createSpy('remoteCmdCreateFolder'),
      isRemotePath: jasmine.createSpy('isRemotePath').and.returnValue(false),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: NgbActiveModal, useValue: jasmine.createSpyObj('modal', ['close', 'dismiss']) },
      { provide: SpawnSelectionService, useValue: { provider: () => null } },
      { provide: SessionService, useValue: sessionService },
      { provide: SessionHistoryService, useValue: {} },
      { provide: DataBackend, useValue: {} },
      { provide: SwalService, useValue: jasmine.createSpyObj('swal', ['error', 'confirm']) },
      { provide: TranslateService, useValue: { instant: (key: string) => `t:${key}` } },
      { provide: AuthenticationService, useValue: {} },
      { provide: ProviderService, useValue: {} },
      { provide: Store, useValue: {} },
      { provide: UiStyleService, useValue: { style: () => 'classic' } },
      { provide: BuiltinPluginsService, useValue: { isOn: () => true } },
    ] });
    component = TestBed.runInInjectionContext(() => new CreateSessionModalComponent());
    // A picked folder: otherwise the primary button is disabled and every Enter test passes trivially.
    component.workspace = { path: '/tmp/acme', name: 'acme' };
  });

  function enterFrom(el: HTMLElement): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'target', { value: el });
    component.onEnter(ev);
    return ev;
  }

  describe('Enter = primary action', () => {
    it('goes to step 2 from step 1', () => {
      enterFrom(document.createElement('div'));
      expect(component.currentStep()).toBe(2);
    });

    it('submits on the last step from a plain input', () => {
      const submit = spyOn(component, 'submit').and.resolveTo();
      component.currentStep.set(component.totalSteps);
      const ev = enterFrom(document.createElement('input'));
      expect(submit).toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(true);
    });

    it('ignores Enter on buttons, selects and textareas', () => {
      const submit = spyOn(component, 'submit').and.resolveTo();
      component.currentStep.set(component.totalSteps);
      for (const tag of ['button', 'select', 'textarea', 'a']) enterFrom(document.createElement(tag));
      expect(submit).not.toHaveBeenCalled();
    });

    it('ignores Enter inside the inline clone / new-folder / remote forms', () => {
      const submit = spyOn(component, 'submit').and.resolveTo();
      component.currentStep.set(component.totalSteps);
      const form = document.createElement('div');
      form.className = 'clone-inline-form';
      const input = document.createElement('input');
      form.appendChild(input);
      enterFrom(input);
      expect(submit).not.toHaveBeenCalled();
    });

    it('does nothing while the primary button is disabled', () => {
      const submit = spyOn(component, 'submit').and.resolveTo();
      component.currentStep.set(component.totalSteps);
      component.saving.set(true);
      enterFrom(document.createElement('input'));
      expect(submit).not.toHaveBeenCalled();
    });

    it('does nothing while the context-file question is open', () => {
      const submit = spyOn(component, 'submit').and.resolveTo();
      component.currentStep.set(component.totalSteps);
      component.contextFilePrompt.set(['CLAUDE.md']);
      enterFrom(document.createElement('input'));
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it('surfaces a rejected remote mkdir instead of an unhandled rejection', async () => {
    (sessionService['remoteCmdCreateFolder'] as jasmine.Spy).and.rejectWith(new Error('permission denied'));
    component.remoteType.set('command');
    component.remoteCommand.set('ssh host');
    component.remoteBrowserPath.set('/home/u');
    component.remoteNewFolderName.set('x');
    await component.remoteMkdir();
    expect(component.remoteError()).toBe('permission denied');
    expect(component.remoteLoading()).toBe(false);
  });

  it('translates inline remote errors', async () => {
    component.remoteType.set('command');
    component.remoteCommand.set('');
    await component.remoteConnect();
    expect(component.remoteError()).toBe('t:SESSIONS.REMOTE.Type command first');
  });
});
