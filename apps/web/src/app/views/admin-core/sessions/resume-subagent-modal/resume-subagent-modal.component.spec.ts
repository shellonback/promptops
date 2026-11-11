import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { of } from 'rxjs';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SubAgentService } from '../services/sub-agent.service';
import { ResumeSubAgentModalComponent } from './resume-subagent-modal.component';

describe('ResumeSubAgentModalComponent (logic)', () => {
  let component: ResumeSubAgentModalComponent;
  let modal: jasmine.SpyObj<NgbActiveModal>;
  let listArchived: jasmine.Spy;

  beforeEach(() => {
    modal = jasmine.createSpyObj('NgbActiveModal', ['close', 'dismiss']);
    listArchived = jasmine.createSpy('listArchived').and.resolveTo([]);
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        { provide: NgbActiveModal, useValue: modal },
        { provide: SubAgentService, useValue: { listArchived } },
        { provide: Store, useValue: { select: () => of([]), dispatch: () => undefined } },
      ],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      SUBAGENTS: { ARCHIVE: { 'Minutes ago': '{{n}}m ago', 'Just now': 'just now' } },
    });
    translate.use('en');
    component = TestBed.runInInjectionContext(() => new ResumeSubAgentModalComponent());
  });

  function enter(target: HTMLElement): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    component.onEnter(event);
    return event;
  }

  it('Enter resumes the selected entry from the search field', () => {
    const entry = { title: 't' } as any;
    component.selectedEntry.set(entry);
    const event = enter(document.createElement('input'));
    expect(modal.close).toHaveBeenCalledWith(entry);
    expect(event.defaultPrevented).toBeTrue();
  });

  it('Enter does nothing without a selection or on a focused button', () => {
    enter(document.createElement('input'));
    expect(modal.close).not.toHaveBeenCalled();

    component.selectedEntry.set({ title: 't' } as any);
    enter(document.createElement('button'));
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('shows the empty state instead of rejecting when the archive cannot be read', async () => {
    listArchived.and.rejectWith(new Error('ipc down'));
    await expectAsync(component.ngOnInit()).toBeResolved();
    expect(component.loading()).toBeFalse();
    expect(component.filteredEntries()).toEqual([]);
  });

  it('formats relative times through the translations', () => {
    expect(component.timeAgo(new Date().toISOString())).toBe('just now');
    expect(component.timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });
});
