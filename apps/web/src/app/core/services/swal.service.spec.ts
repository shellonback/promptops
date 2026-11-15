import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { SwalService } from './swal.service';

describe('SwalService closeWith', () => {
  let dismiss: jasmine.Spy;
  let service: SwalService;

  beforeEach(() => {
    dismiss = jasmine.createSpy('dismiss');
    const ref = { componentInstance: {}, dismiss, result: new Promise(() => {}) };
    TestBed.configureTestingModule({ providers: [
      SwalService,
      { provide: NgbModal, useValue: { open: () => ref } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ] });
    service = TestBed.inject(SwalService);
  });

  it('dismisses an open confirmation when its owner is destroyed', () => {
    const callbacks: (() => void)[] = [];
    const owner = { onDestroy: (cb: () => void) => { callbacks.push(cb); return () => {}; } } as unknown as DestroyRef;
    service.confirm('t', 'm', () => {}, owner);
    expect(dismiss).not.toHaveBeenCalled();
    callbacks.forEach((cb) => cb());
    expect(dismiss).toHaveBeenCalled();
  });
});

describe('SwalService promptLongText', () => {
  function setup(result: Promise<unknown>) {
    const ref = { componentInstance: {} as { options?: { input?: { value: string; multiline?: boolean } } }, dismiss: () => {}, result };
    const open = jasmine.createSpy('open').and.returnValue(ref);
    TestBed.configureTestingModule({ providers: [
      SwalService,
      { provide: NgbModal, useValue: { open } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ] });
    return { service: TestBed.inject(SwalService), ref, open };
  }

  it('opens a large dialog with a text area and resolves with the trimmed draft', async () => {
    const { service, ref, open } = setup(Promise.resolve({ isConfirmed: true, value: '  edited draft\n' }));
    const value = await service.promptLongText({ title: 't', defaultValue: 'draft' });
    expect(open.calls.mostRecent().args[1].size).toBe('lg');
    expect(ref.componentInstance.options?.input).toEqual({ value: 'draft', multiline: true });
    expect(value).toBe('edited draft');
  });

  it('resolves with null when the user cancels or empties the draft', async () => {
    expect(await setup(Promise.reject()).service.promptLongText({ title: 't' })).toBeNull();
    TestBed.resetTestingModule();
    expect(await setup(Promise.resolve({ isConfirmed: true, value: '   ' })).service.promptLongText({ title: 't' })).toBeNull();
  });
});
