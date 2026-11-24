import { fileUrisFromDrop, isLinux } from './file-drop-zone.directive';

// Drop simulato con il solo text/uri-list, come lo consegna WebKitGTK quando si
// trascina un file dal file manager Linux (dataTransfer.files vuoto).
function uriListDrop(uriList: string): DragEvent {
  const dt = new DataTransfer();
  dt.setData('text/uri-list', uriList);
  return new DragEvent('drop', { dataTransfer: dt });
}

describe('file-drop-zone: rilevamento Linux e ripiego text/uri-list', () => {
  const w = window as { __PROMPTOPS_OS__?: string };
  let saved: string | undefined;

  beforeEach(() => (saved = w.__PROMPTOPS_OS__));
  afterEach(() => {
    if (saved === undefined) delete w.__PROMPTOPS_OS__;
    else w.__PROMPTOPS_OS__ = saved;
  });

  it('usa il sistema operativo iniettato da Rust anche se lo userAgent dice Mac', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    expect(isLinux()).toBeTrue();
    w.__PROMPTOPS_OS__ = 'darwin';
    expect(isLinux()).toBeFalse();
    w.__PROMPTOPS_OS__ = 'win32';
    expect(isLinux()).toBeFalse();
  });

  it('su Linux estrae i percorsi assoluti decodificati, ignorando commenti e URL non file', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    const e = uriListDrop(
      '# commento\r\nfile:///home/utente/Immagini/foto%20mare.png\r\nhttps://example.com/x.png\r\nfile:///tmp/%C3%A8.txt\r\n',
    );
    expect(fileUrisFromDrop(e)).toEqual(['/home/utente/Immagini/foto mare.png', '/tmp/è.txt']);
  });

  it('fuori da Linux non attiva il ripiego (macOS/Windows usano dataTransfer.files)', () => {
    w.__PROMPTOPS_OS__ = 'darwin';
    expect(fileUrisFromDrop(uriListDrop('file:///Users/u/a.png'))).toEqual([]);
  });

  it('uri-list vuota (WebKitGTK la nasconde): usa i percorsi letti da Rust via bridge', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    const win = window as { promptops?: { getDragPaths?: () => string[] } };
    const savedBridge = win.promptops;
    win.promptops = { getDragPaths: () => ['/home/utente/foto mare.png', 'relativo.txt'] };
    try {
      expect(fileUrisFromDrop(uriListDrop(''))).toEqual(['/home/utente/foto mare.png']);
    } finally {
      win.promptops = savedBridge;
    }
  });

  it('drop senza uri-list: nessun percorso', () => {
    w.__PROMPTOPS_OS__ = 'linux';
    expect(fileUrisFromDrop(new DragEvent('drop'))).toEqual([]);
  });
});
