import { TestBed } from '@angular/core/testing';
import { SessionService } from '../services/session.service';
import {
  FOLDER_MACHINE_STORAGE_KEY,
  MACHINE_EXPANDED_STORAGE_KEY,
  SESSION_COMMAND_STORAGE_KEY,
  SidebarMachineStateService,
} from './sidebar-machine-state.service';

const KEYS = [FOLDER_MACHINE_STORAGE_KEY, MACHINE_EXPANDED_STORAGE_KEY, SESSION_COMMAND_STORAGE_KEY];

describe('SidebarMachineStateService', () => {
  let getSession: jasmine.Spy;

  const make = (): SidebarMachineStateService => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: { getSession } }] });
    return TestBed.inject(SidebarMachineStateService);
  };

  beforeEach(() => {
    KEYS.forEach((k) => localStorage.removeItem(k));
    getSession = jasmine.createSpy('getSession').and.callFake(async (id: string) => ({
      config: { remoteCommand: id === 's-none' ? undefined : `ssh  u@${id}` },
    }));
  });

  afterEach(() => KEYS.forEach((k) => localStorage.removeItem(k)));

  it('remembers the machine of a folder across restarts', () => {
    make().setFolderHome('f1', 'ssh:c1');
    const again = make();
    expect(again.folderHomes().get('f1')).toBe('ssh:c1');
  });

  it('does not rewrite storage when nothing changes', () => {
    const svc = make();
    svc.setFolderHome('f1', 'ssh:c1');
    const before = svc.folderHomes();
    const spy = spyOn(Storage.prototype, 'setItem').and.callThrough();
    svc.setFolderHomes(new Map([['f1', 'ssh:c1']]));
    expect(spy).not.toHaveBeenCalled();
    expect(svc.folderHomes()).toBe(before);
  });

  it('remembers which machines are collapsed; unseen machines start open', () => {
    const svc = make();
    expect(svc.isExpanded('ssh:c1')).toBeTrue();
    svc.toggle('ssh:c1');
    expect(svc.isExpanded('ssh:c1')).toBeFalse();
    const again = make();
    expect(again.isExpanded('ssh:c1')).toBeFalse();
    expect(again.isExpanded('local')).toBeTrue();
    again.toggle('ssh:c1');
    expect(make().isExpanded('ssh:c1')).toBeTrue();
  });

  it('resolves the connect command of a session once and remembers it', async () => {
    const svc = make();
    await svc.resolveCommands([{ id: 'h1', key: 'db1' }]);
    expect(svc.commandOf('db1')).toBe('ssh u@h1');
    await svc.resolveCommands([{ id: 'h1', key: 'db1' }]);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(make().commandOf('db1')).toBe('ssh u@h1');
  });

  it('asks only once per run for a session without a command', async () => {
    const svc = make();
    await svc.resolveCommands([{ id: 's-none', key: 'k' }]);
    await svc.resolveCommands([{ id: 's-none', key: 'k' }]);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(svc.commandOf('k')).toBeNull();
  });

  it('survives a session the native side does not know', async () => {
    getSession.and.rejectWith(new Error('not found'));
    const svc = make();
    await expectAsync(svc.resolveCommands([{ id: 'x', key: 'k' }])).toBeResolved();
    expect(svc.commandOf('k')).toBeNull();
  });

  it('ignores corrupted storage', () => {
    localStorage.setItem(FOLDER_MACHINE_STORAGE_KEY, '{not json');
    localStorage.setItem(MACHINE_EXPANDED_STORAGE_KEY, '["a"]');
    localStorage.setItem(SESSION_COMMAND_STORAGE_KEY, JSON.stringify({ a: 1, b: '', c: 'ssh u@h' }));
    const svc = make();
    expect(svc.folderHomes().size).toBe(0);
    expect(svc.expanded().size).toBe(0);
    expect([...svc.sessionCommands()]).toEqual([['c', 'ssh u@h']]);
  });

  it('keeps working in memory when storage refuses the write', () => {
    const svc = make();
    spyOn(Storage.prototype, 'setItem').and.throwError('quota');
    svc.setFolderHome('f1', 'ssh:c1');
    svc.toggle('local');
    expect(svc.folderHomes().get('f1')).toBe('ssh:c1');
    expect(svc.isExpanded('local')).toBeFalse();
  });
});
