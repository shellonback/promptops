import { fileUrisFromDrop, isLinux } from './file-drop-zone.directive';

// Simulated drop carrying only text/uri-list, as WebKitGTK delivers it when a
// file is dragged from the Linux file manager (empty dataTransfer.files).
function uriListDrop(uriList: string): DragEvent {
  const dt = new DataTransfer();
  dt.setData('text/uri-list', uriList);
  return new DragEvent('drop', { dataTransfer: dt });
}

describe('file-drop-zone: Linux detection and text/uri-list fallback', () => {
  const w = window as { __PROMPTOPS_OS__?: string };
  let saved: string | undefined;

  beforeEach(() => (saved = w.__PROMPTOPS_OS__));
  afterEach(() => {
    if (saved === undefined) delete w.__PROMPTOPS_OS__;
    else w.__PROMPTOPS_OS__ = saved;
  });

  it('uses the OS injected by Rust even when the user agent says Mac', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    expect(isLinux()).toBeTrue();
    w.__PROMPTOPS_OS__ = 'darwin';
    expect(isLinux()).toBeFalse();
    w.__PROMPTOPS_OS__ = 'win32';
    expect(isLinux()).toBeFalse();
  });

  it('on Linux extracts decoded absolute paths, ignoring comments and non-file URLs', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    const e = uriListDrop(
      '# comment\r\nfile:///home/user/Pictures/beach%20photo.png\r\nhttps://example.com/x.png\r\nfile:///tmp/caf%C3%A9.txt\r\n',
    );
    expect(fileUrisFromDrop(e)).toEqual(['/home/user/Pictures/beach photo.png', '/tmp/café.txt']);
  });

  it('does not enable the fallback outside Linux (macOS/Windows use dataTransfer.files)', () => {
    w.__PROMPTOPS_OS__ = 'darwin';
    expect(fileUrisFromDrop(uriListDrop('file:///Users/u/a.png'))).toEqual([]);
  });

  it('empty uri-list (hidden by WebKitGTK): uses the paths read by Rust through the bridge', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    const win = window as { promptops?: { getDragPaths?: () => string[] } };
    const savedBridge = win.promptops;
    win.promptops = { getDragPaths: () => ['/home/user/beach photo.png', 'relative.txt'] };
    try {
      expect(fileUrisFromDrop(uriListDrop(''))).toEqual(['/home/user/beach photo.png']);
    } finally {
      win.promptops = savedBridge;
    }
  });

  it('drop without uri-list: no paths', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    expect(fileUrisFromDrop(new DragEvent('drop'))).toEqual([]);
  });
});
