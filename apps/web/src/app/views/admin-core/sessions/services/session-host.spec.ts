import { TestBed } from '@angular/core/testing';
import {
  MAX_REMEMBERED_COMMANDS,
  REMOTE_COMMANDS_STORAGE_KEY,
  SessionHostsService,
  buildRemoteHosts,
  commandHost,
  commandHostKey,
  commandHostLabel,
  forgetCommandIn,
  normalizeCommand,
  parseStoredCommands,
  rememberCommandIn,
  sshHost,
  sshHostKey,
} from './session-host';
import { SessionService } from './session.service';

const CONN = { id: 'c1', name: 'Staging', host: 'staging.example.com', port: 22, username: 'deploy' };

describe('session-host (pure helpers)', () => {
  it('normalizes a connect command', () => {
    expect(normalizeCommand('  ssh   ubuntu@203.0.113.10  ')).toBe('ssh ubuntu@203.0.113.10');
    expect(normalizeCommand(null)).toBe('');
    expect(normalizeCommand(undefined)).toBe('');
  });

  it('extracts a human label from the command', () => {
    expect(commandHostLabel('ssh ubuntu@203.0.113.10')).toBe('203.0.113.10');
    expect(commandHostLabel('ssh -i ~/.ssh/k.pem ec2-user@my-box.example.com')).toBe('my-box.example.com');
    expect(commandHostLabel('aws ssm start-session --target i-0123456789abcdef0')).toBe('i-0123456789abcdef0');
    expect(commandHostLabel('aws ssm start-session --target=i-0abc')).toBe('i-0abc');
    expect(commandHostLabel('mosh somewhere')).toBe('remote');
  });

  it('gives the same key to the same command typed with different spacing', () => {
    expect(commandHostKey('ssh  a@b')).toBe(commandHostKey(' ssh a@b '));
    expect(commandHostKey('ssh a@b')).not.toBe(commandHostKey('ssh a@c'));
    expect(sshHostKey('c1')).toBe('ssh:c1');
  });

  it('describes an SSH connection, showing the port only when it is not 22', () => {
    expect(sshHost(CONN)).toEqual({
      key: 'ssh:c1', kind: 'ssh', name: 'Staging', detail: 'deploy@staging.example.com', connId: 'c1',
    });
    expect(sshHost({ ...CONN, port: 2222 }).detail).toBe('deploy@staging.example.com:2222');
    expect(sshHost({ ...CONN, name: '' }).name).toBe('staging.example.com');
  });

  it('describes a command host', () => {
    expect(commandHost(' ssh  ubuntu@10.0.0.1 ')).toEqual({
      key: 'cmd:ssh ubuntu@10.0.0.1',
      kind: 'command',
      name: '10.0.0.1',
      detail: 'ssh ubuntu@10.0.0.1',
      command: 'ssh ubuntu@10.0.0.1',
    });
  });

  it('lists SSH connections first, then commands, without duplicates or blanks', () => {
    const hosts = buildRemoteHosts(
      [CONN, CONN, { ...CONN, id: '' }],
      ['ssh a@b', '  ', 'ssh  a@b', 'ssh c@d'],
    );
    expect(hosts.map((h) => h.key)).toEqual(['ssh:c1', 'cmd:ssh a@b', 'cmd:ssh c@d']);
  });

  it('returns no remote host when nothing is configured', () => {
    expect(buildRemoteHosts([], [])).toEqual([]);
  });

  it('reads the stored list tolerantly', () => {
    expect(parseStoredCommands(null)).toEqual([]);
    expect(parseStoredCommands('')).toEqual([]);
    expect(parseStoredCommands('not json')).toEqual([]);
    expect(parseStoredCommands('{"a":1}')).toEqual([]);
    expect(parseStoredCommands('["ssh a@b", 3, null, " ssh  a@b ", "ssh c@d"]')).toEqual(['ssh a@b', 'ssh c@d']);
  });

  it('remembers the most recent command first, deduplicated and capped', () => {
    expect(rememberCommandIn(['ssh a@b', 'ssh c@d'], 'ssh c@d')).toEqual(['ssh c@d', 'ssh a@b']);
    expect(rememberCommandIn(['ssh a@b'], '   ')).toEqual(['ssh a@b']);
    const many = Array.from({ length: MAX_REMEMBERED_COMMANDS + 5 }, (_, i) => `ssh u@h${i}`);
    const out = rememberCommandIn(many, 'ssh new@host');
    expect(out.length).toBe(MAX_REMEMBERED_COMMANDS);
    expect(out[0]).toBe('ssh new@host');
  });

  it('forgets a command regardless of spacing', () => {
    expect(forgetCommandIn(['ssh a@b', 'ssh c@d'], ' ssh  a@b')).toEqual(['ssh c@d']);
    expect(forgetCommandIn(['ssh a@b'], 'ssh x@y')).toEqual(['ssh a@b']);
  });
});

describe('SessionHostsService', () => {
  let isTauri: boolean;
  let listSshConnections: jasmine.Spy;
  let service: SessionHostsService;

  beforeEach(() => {
    localStorage.removeItem(REMOTE_COMMANDS_STORAGE_KEY);
    isTauri = true;
    listSshConnections = jasmine.createSpy('listSshConnections').and.resolveTo([CONN]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SessionService,
          useValue: {
            get isTauri() { return isTauri; },
            listSshConnections,
          },
        },
      ],
    });
    service = TestBed.inject(SessionHostsService);
  });

  afterEach(() => localStorage.removeItem(REMOTE_COMMANDS_STORAGE_KEY));

  it('lists nothing and never calls the native side outside Tauri', async () => {
    isTauri = false;
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify(['ssh a@b']));
    expect(await service.refresh()).toEqual([]);
    expect(service.remoteHosts()).toEqual([]);
    expect(listSshConnections).not.toHaveBeenCalled();
  });

  it('merges saved SSH connections with remembered commands', async () => {
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify(['ssh a@b']));
    await service.refresh();
    expect(service.remoteHosts().map((h) => h.key)).toEqual(['ssh:c1', 'cmd:ssh a@b']);
    expect(service.loading()).toBeFalse();
  });

  it('still shows the commands when the SSH listing fails', async () => {
    listSshConnections.and.rejectWith(new Error('boom'));
    localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify(['ssh a@b']));
    await service.refresh();
    expect(service.remoteHosts().map((h) => h.key)).toEqual(['cmd:ssh a@b']);
    expect(service.loading()).toBeFalse();
  });

  it('remembers a command, persists it and returns the host', async () => {
    await service.refresh();
    const host = service.rememberCommand('  ssh  ubuntu@10.0.0.1 ');
    expect(host?.key).toBe('cmd:ssh ubuntu@10.0.0.1');
    expect(service.find('cmd:ssh ubuntu@10.0.0.1')?.name).toBe('10.0.0.1');
    expect(JSON.parse(localStorage.getItem(REMOTE_COMMANDS_STORAGE_KEY)!)).toEqual(['ssh ubuntu@10.0.0.1']);
    // Same command again: no duplicate.
    service.rememberCommand('ssh ubuntu@10.0.0.1');
    expect(service.remoteHosts().filter((h) => h.kind === 'command').length).toBe(1);
  });

  it('ignores an empty command', () => {
    expect(service.rememberCommand('   ')).toBeNull();
    expect(localStorage.getItem(REMOTE_COMMANDS_STORAGE_KEY)).toBeNull();
  });

  it('forgets a command and keeps the SSH connections', async () => {
    await service.refresh();
    service.rememberCommand('ssh a@b');
    service.forgetCommand('ssh a@b');
    expect(service.remoteHosts().map((h) => h.key)).toEqual(['ssh:c1']);
    expect(JSON.parse(localStorage.getItem(REMOTE_COMMANDS_STORAGE_KEY)!)).toEqual([]);
  });

  it('keeps the list in memory when localStorage refuses the write', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('quota');
    const host = service.rememberCommand('ssh a@b');
    expect(host).not.toBeNull();
    expect(service.remoteHosts().map((h) => h.key)).toEqual(['cmd:ssh a@b']);
  });
});
