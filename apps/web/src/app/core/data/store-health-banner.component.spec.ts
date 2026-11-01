import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { DataBackend } from './data-backend';
import { readOnlyKind, StoreHealthBannerComponent, storeHealthNeedsNotice, UNREADABLE_ACK_KEY } from './store-health-banner.component';

class FakeBackend extends DataBackend {
  constructor(private answer: () => Promise<unknown>) { super(); }
  calls: string[] = [];
  call<T>(method: string): Promise<T> {
    this.calls.push(method);
    return this.answer() as Promise<T>;
  }
}

async function render(answer: () => Promise<unknown>) {
  const backend = new FakeBackend(answer);
  TestBed.configureTestingModule({
    imports: [StoreHealthBannerComponent, TranslateModule.forRoot()],
    providers: [{ provide: DataBackend, useValue: backend }],
  });
  const fixture = TestBed.createComponent(StoreHealthBannerComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, backend, el: fixture.nativeElement as HTMLElement };
}

describe('StoreHealthBannerComponent', () => {
  beforeEach(() => localStorage.removeItem(UNREADABLE_ACK_KEY));
  afterEach(() => localStorage.removeItem(UNREADABLE_ACK_KEY));

  it('asks the desktop shell how the data file opened', async () => {
    const { backend } = await render(async () => ({ unreadable: 0, formatVersion: 1 }));
    expect(backend.calls).toEqual(['store.health']);
  });

  it('shows nothing when the store is healthy', async () => {
    const { el } = await render(async () => ({ unreadable: 0, formatVersion: 1 }));
    expect(el.querySelector('[data-testid="store-health-banner"]')).toBeNull();
  });

  it('shows nothing (and does not throw) outside the desktop shell', async () => {
    const { el } = await render(() => Promise.reject({ code: 'unavailable', message: 'x' }));
    expect(el.querySelector('[data-testid="store-health-banner"]')).toBeNull();
  });

  it('tells the user where an unreadable data file was set aside', async () => {
    const { el } = await render(async () => ({ quarantined: '/data/store.json.corrupt-1', unreadable: 0, formatVersion: 1 }));
    const q = el.querySelector('[data-testid="store-health-quarantined"]');
    expect(q?.textContent).toContain('/data/store.json.corrupt-1');
  });

  it('warns that changes are not saved when the store is read-only, until dismissed', async () => {
    const { el, fixture } = await render(async () => ({
      readOnly: 'Another copy of PromptOps is using this data.', unreadable: 2, formatVersion: 1,
    }));
    expect(el.querySelector('[data-testid="store-health-read-only"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="store-health-unreadable"]')).not.toBeNull();
    (el.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="store-health-banner"]')).toBeNull();
  });

  it('shows unreadable records alone as information, and only again when there are more', async () => {
    const first = await render(async () => ({ unreadable: 1, formatVersion: 1 }));
    const banner = first.el.querySelector('[data-testid="store-health-banner"]');
    expect(banner?.classList.contains('info')).toBeTrue();
    expect(banner?.getAttribute('role')).toBe('status');
    (first.el.querySelector('button') as HTMLButtonElement).click();
    first.fixture.detectChanges();
    expect(localStorage.getItem(UNREADABLE_ACK_KEY)).toBe('1');

    TestBed.resetTestingModule();
    const again = await render(async () => ({ unreadable: 1, formatVersion: 1 }));
    expect(again.el.querySelector('[data-testid="store-health-banner"]')).toBeNull();

    TestBed.resetTestingModule();
    const more = await render(async () => ({ unreadable: 2, formatVersion: 1 }));
    expect(more.el.querySelector('[data-testid="store-health-banner"]')).not.toBeNull();
  });

  it('keeps real problems as an alert even when unreadable records were acknowledged', async () => {
    localStorage.setItem(UNREADABLE_ACK_KEY, '5');
    const { el } = await render(async () => ({ readOnly: 'disk full', unreadable: 1, formatVersion: 1 }));
    const banner = el.querySelector('[data-testid="store-health-banner"]');
    expect(banner?.classList.contains('info')).toBeFalse();
    expect(banner?.getAttribute('role')).toBe('alert');
  });

  it('classifies the read-only reasons the desktop shell sends', () => {
    expect(readOnlyKind('This data was saved by a newer version of PromptOps (format 2).')).toBe('newer');
    expect(readOnlyKind('Another copy of PromptOps is using this data.')).toBe('busy');
    expect(readOnlyKind('disk full')).toBe('other');
    expect(storeHealthNeedsNotice({ unreadable: 0, formatVersion: 1 })).toBeFalse();
    expect(storeHealthNeedsNotice(null)).toBeFalse();
  });
});
