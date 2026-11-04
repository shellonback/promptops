import { OrgPolicyService } from '@core/services/org-policy.service';
import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule } from '@ngx-translate/core';
import { IntentModalComponent } from './intent-modal.component';
import { IntentService, IntentPlan } from '../services/intent.service';

describe('IntentModalComponent', () => {
  let fixture: ComponentFixture<IntentModalComponent>;
  let component: IntentModalComponent;
  let intentServiceSpy: jasmine.SpyObj<IntentService>;
  let modalSpy: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    intentServiceSpy = jasmine.createSpyObj('IntentService', [
      'reset',
      'hardReset',
      'hasInFlightState',
      'generatePlan',
      'executeInDedicatedSession',
      'enhancePrompt',
      'stop',
      'getAgentPromptPreview',
    ], {
      phase: signal('input'),
      currentPlan: signal<IntentPlan | null>(null),
      error: signal<string | null>(null),
      currentWave: signal(0),
      waitingAgents: signal([]),
      activeSessionId: signal<string | null>(null),
      draftIntent: signal(''),
      draftProvider: signal<string | null>(null),
      draftAutoApprove: signal(false),
    });
    intentServiceSpy.hasInFlightState.and.returnValue(false);
    intentServiceSpy.generatePlan.and.resolveTo(null);
    intentServiceSpy.executeInDedicatedSession.and.resolveTo();
    intentServiceSpy.enhancePrompt.and.resolveTo('');

    modalSpy = jasmine.createSpyObj('NgbActiveModal', ['close', 'dismiss']);

    await TestBed.configureTestingModule({
      imports: [IntentModalComponent, TranslateModule.forRoot()],
      providers: [
        { provide: IntentService, useValue: intentServiceSpy },
        { provide: OrgPolicyService, useValue: { autoApproveAllowed: () => true, canEnableBuiltinPlugins: () => true } },
        { provide: NgbActiveModal, useValue: modalSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(IntentModalComponent);
    component = fixture.componentInstance;
  });

  // ── Initialization ─────────────────────────────────────────────
  describe('ngOnInit', () => {
    it('should reset the intent service', () => {
      component.ngOnInit();
      expect(intentServiceSpy.hardReset).toHaveBeenCalled();
    });

    it('should set selectedProvider from sessionProvider', () => {
      component.sessionProvider = 'codex';
      component.ngOnInit();
      expect(component.selectedProvider).toBe('codex');
    });

    it('should keep default provider when sessionProvider is empty', () => {
      component.sessionProvider = '' as any;
      component.ngOnInit();
      // Falsy sessionProvider → keeps default
      expect(component.selectedProvider).toBe('claude-code-cli');
    });
  });

  // ── toggleAutoApprove ──────────────────────────────────────────
  describe('toggleAutoApprove', () => {
    it('should toggle from false to true', () => {
      expect(component.autoApprove()).toBe(false);
      component.toggleAutoApprove();
      expect(component.autoApprove()).toBe(true);
    });

    it('should toggle from true to false', () => {
      component.autoApprove.set(true);
      component.toggleAutoApprove();
      expect(component.autoApprove()).toBe(false);
    });
  });

  // ── enhance ────────────────────────────────────────────────────
  describe('runEnhance', () => {
    it('should not call enhancePrompt with empty text', async () => {
      component.intentText = '   ';
      await component.runEnhance('medium');
      expect(intentServiceSpy.enhancePrompt).not.toHaveBeenCalled();
    });

    it('should call enhancePrompt and update intentText on success', async () => {
      intentServiceSpy.enhancePrompt.and.resolveTo('Enhanced version');
      component.intentText = 'rough draft';
      component.selectedProvider = 'claude-code-cli';

      await component.runEnhance('medium');

      expect(intentServiceSpy.enhancePrompt).toHaveBeenCalledWith(
        'rough draft',
        'claude-code-cli',
        undefined,
        undefined,
        'medium',
      );
      expect(component.intentText).toBe('Enhanced version');
    });

    it('should set enhancing signal during call', async () => {
      let wasEnhancing = false;
      intentServiceSpy.enhancePrompt.and.callFake(async () => {
        wasEnhancing = component.enhancing();
        return 'enhanced';
      });
      component.intentText = 'test';

      await component.runEnhance('medium');

      expect(wasEnhancing).toBe(true);
      expect(component.enhancing()).toBe(false);
    });

    it('should not call enhancePrompt when already enhancing', async () => {
      component.enhancing.set(true);
      component.intentText = 'test';

      await component.runEnhance('medium');

      expect(intentServiceSpy.enhancePrompt).not.toHaveBeenCalled();
    });

    it('should pass sessionContext and projectStructure', async () => {
      intentServiceSpy.enhancePrompt.and.resolveTo('ok');
      component.intentText = 'test';
      component.sessionContext = 'ctx';
      component.projectStructure = 'proj';

      await component.runEnhance('medium');

      expect(intentServiceSpy.enhancePrompt).toHaveBeenCalledWith(
        'test',
        'claude-code-cli',
        'ctx',
        'proj',
        'medium',
      );
    });
  });

  // ── generate ───────────────────────────────────────────────────
  describe('generate', () => {
    it('should not call generatePlan with empty text', async () => {
      component.intentText = '';
      await component.generate();
      expect(intentServiceSpy.generatePlan).not.toHaveBeenCalled();
    });

    it('should call generatePlan with trimmed text and selected provider', async () => {
      component.intentText = '  build feature  ';
      component.selectedProvider = 'gemini-cli';

      await component.generate();

      expect(intentServiceSpy.generatePlan).toHaveBeenCalledWith(
        'build feature',
        'gemini-cli',
        undefined,
        undefined,
      );
    });

    it('should pass sessionContext and projectStructure', async () => {
      component.intentText = 'test';
      component.sessionContext = 'ctx';
      component.projectStructure = 'proj';

      await component.generate();

      expect(intentServiceSpy.generatePlan).toHaveBeenCalledWith(
        'test',
        'claude-code-cli',
        'ctx',
        'proj',
      );
    });
  });

  // ── execute ────────────────────────────────────────────────────
  describe('execute', () => {
    it('should not call executePlan when there is no plan', async () => {
      intentServiceSpy.currentPlan.set(null);
      component.parentSessionId = 'session-1';

      await component.execute();

      expect(intentServiceSpy.executeInDedicatedSession).not.toHaveBeenCalled();
    });

    it('should not call executePlan when there is no parentSessionId', async () => {
      const plan: IntentPlan = { summary: 'p', agents: [] };
      intentServiceSpy.currentPlan.set(plan);
      component.parentSessionId = '';

      await component.execute();

      expect(intentServiceSpy.executeInDedicatedSession).not.toHaveBeenCalled();
    });

    it('should call executePlan with correct params', async () => {
      const plan: IntentPlan = {
        summary: 'test',
        agents: [{ name: 'A', role: 'backend', goal: 'g', description: 'd' }],
      };
      intentServiceSpy.currentPlan.set(plan);
      component.parentSessionId = 'session-1';
      component.selectedProvider = 'copilot';
      component.autoApprove.set(true);

      await component.execute();

      expect(intentServiceSpy.executeInDedicatedSession).toHaveBeenCalledWith(
        'session-1',
        plan,
        'copilot',
        true,
      );
    });
  });

  // ── failures surface instead of leaving the modal stuck ────────
  describe('error handling', () => {
    it('runEnhance: a rejected enhancement re-enables the textarea and keeps the typed text', async () => {
      intentServiceSpy.enhancePrompt.and.rejectWith(new Error('boom'));
      component.intentText = 'my goal';

      await component.runEnhance('medium');

      expect(component.enhancing()).toBe(false);
      expect(component.intentText).toBe('my goal');
    });

    it('runEnhance: an empty enhancement does not wipe the typed text', async () => {
      intentServiceSpy.enhancePrompt.and.resolveTo('   ');
      component.intentText = 'my goal';

      await component.runEnhance('short');

      expect(component.intentText).toBe('my goal');
    });

    it('generate: a rejection moves the modal to the error phase', async () => {
      intentServiceSpy.generatePlan.and.rejectWith(new Error('plan failed'));
      component.intentText = 'goal';

      await component.generate();

      expect(intentServiceSpy.phase()).toBe('error');
      expect(intentServiceSpy.error()).toBe('plan failed');
    });

    it('execute: a rejection moves the modal to the error phase', async () => {
      intentServiceSpy.executeInDedicatedSession.and.rejectWith(new Error('spawn failed'));
      intentServiceSpy.currentPlan.set({ summary: 's', agents: [{ name: 'A', role: 'backend', goal: 'g', description: 'd' }] });
      component.parentSessionId = 'session-1';

      await component.execute();

      expect(intentServiceSpy.phase()).toBe('error');
      expect(intentServiceSpy.error()).toBe('spawn failed');
    });
  });

  // ── cancel ─────────────────────────────────────────────────────
  describe('cancel', () => {
    it('should call intentService.reset', () => {
      component.cancel();
      expect(intentServiceSpy.reset).toHaveBeenCalled();
    });
  });

  // ── getRoleColor ───────────────────────────────────────────────
  describe('getRoleColor', () => {
    it('should return correct colors for known roles', () => {
      expect(component.getRoleColor('backend')).toBe('#3fb950');
      expect(component.getRoleColor('frontend')).toBe('#bc8cff');
      expect(component.getRoleColor('refactor')).toBe('#f0883e');
      expect(component.getRoleColor('debug')).toBe('#f85149');
      expect(component.getRoleColor('test')).toBe('#39c5cf');
      expect(component.getRoleColor('docs')).toBe('#8b949e');
      expect(component.getRoleColor('devops')).toBe('#4285f4');
    });

    it('should return fallback color for unknown role', () => {
      expect(component.getRoleColor('unknown')).toBe('#8391a2');
    });
  });

  // ── getRoleIcon ────────────────────────────────────────────────
  describe('getRoleIcon', () => {
    it('should return correct icons for known roles', () => {
      expect(component.getRoleIcon('backend')).toBe('solar:server-bold-duotone');
      expect(component.getRoleIcon('frontend')).toBe('solar:monitor-bold-duotone');
      expect(component.getRoleIcon('test')).toBe('solar:test-tube-bold-duotone');
    });

    it('should return fallback icon for unknown role', () => {
      expect(component.getRoleIcon('unknown')).toBe('solar:cpu-bolt-bold-duotone');
    });
  });

  // ── providers list ─────────────────────────────────────────────
  describe('providers', () => {
    it('should offer the main agent CLIs', () => {
      const values = component.providers.map(p => p.value);
      expect(values).toEqual(jasmine.arrayContaining(['claude-code-cli', 'codex', 'gemini-cli']));
    });

    it('should include claude-code-cli as first provider', () => {
      expect(component.providers[0].value).toBe('claude-code-cli');
    });
  });
});
