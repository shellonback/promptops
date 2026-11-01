import { TestBed } from '@angular/core/testing';
import { SessionAssetsService, AssetInfo } from './session-assets.service';

const asset = (name: string): AssetInfo => ({
  name,
  relativePath: `.promptops-assets/${name}`,
  size: 10,
  mimeType: 'image/png',
  isImage: true,
  createdAt: '',
  modifiedAt: '',
});

describe('SessionAssetsService agent paths (worktree-safe)', () => {
  let svc: SessionAssetsService;
  beforeEach(() => { svc = TestBed.inject(SessionAssetsService); });

  it('uses absolute paths for local POSIX workspaces', () => {
    expect(svc.agentPath('/Users/me/repo/', '.promptops-assets/a.png')).toBe('/Users/me/repo/.promptops-assets/a.png');
  });

  it('uses backslashes for Windows workspaces', () => {
    expect(svc.agentPath('C:\\code\\repo', '.promptops-assets/a.png')).toBe('C:\\code\\repo\\.promptops-assets\\a.png');
  });

  it('keeps relative paths for remote sessions and missing cwd', () => {
    expect(svc.agentPath('ssh://conn/home/x', '.promptops-assets/a.png')).toBe('.promptops-assets/a.png');
    expect(svc.agentPath('cmd:///srv/app', '.promptops-assets/a.png')).toBe('.promptops-assets/a.png');
    expect(svc.agentPath(null, '.promptops-assets/a.png')).toBe('.promptops-assets/a.png');
  });

  it('quotes inline paths containing spaces', () => {
    expect(svc.agentPathsInline('/Users/me/My Repo', [asset('a.png'), asset('b c.png')]))
      .toBe('"/Users/me/My Repo/.promptops-assets/a.png" "/Users/me/My Repo/.promptops-assets/b c.png"');
  });

  it('puts absolute paths in intent prompts', () => {
    const p = svc.buildIntentPrompt([asset('a.png')], 'custom', '/w');
    expect(p).toContain('- /w/.promptops-assets/a.png');
  });
});
