import { decideTerminalLinuxUndoKey, decideTerminalMacLineKey } from './terminal-mac-line-keys';

function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', ...init } as KeyboardEvent;
}

describe('decideTerminalMacLineKey', () => {
  it('maps Cmd+Left/Right/Backspace on macOS', () => {
    expect(decideTerminalMacLineKey(ev({ metaKey: true, key: 'ArrowLeft' }), 'darwin')).toBe('\x01');
    expect(decideTerminalMacLineKey(ev({ metaKey: true, key: 'ArrowRight' }), 'darwin')).toBe('\x05');
    expect(decideTerminalMacLineKey(ev({ metaKey: true, key: 'Backspace' }), 'darwin')).toBe('\x15');
  });

  it('ignores other platforms and extra modifiers', () => {
    expect(decideTerminalMacLineKey(ev({ metaKey: true, key: 'ArrowLeft' }), 'win32')).toBeNull();
    expect(decideTerminalMacLineKey(ev({ metaKey: true, key: 'ArrowLeft' }), 'linux')).toBeNull();
    expect(decideTerminalMacLineKey(ev({ metaKey: true, shiftKey: true, key: 'ArrowLeft' }), 'darwin')).toBeNull();
    expect(decideTerminalMacLineKey(ev({ metaKey: true, altKey: true, key: 'ArrowRight' }), 'darwin')).toBeNull();
    expect(decideTerminalMacLineKey(ev({ ctrlKey: true, key: 'ArrowLeft' }), 'darwin')).toBeNull();
    expect(decideTerminalMacLineKey(ev({ metaKey: true, key: 'ArrowUp' }), 'darwin')).toBeNull();
  });
});

describe('decideTerminalLinuxUndoKey', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('maps Ctrl+Z to Ctrl+_ on Linux', () => {
    expect(decideTerminalLinuxUndoKey(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'linux')).toBe('\x1f');
  });

  it('leaves macOS and Windows untouched', () => {
    expect(decideTerminalLinuxUndoKey(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'darwin')).toBeNull();
    expect(decideTerminalLinuxUndoKey(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'win32')).toBeNull();
  });

  it('ignores other modifiers', () => {
    expect(decideTerminalLinuxUndoKey(key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'linux')).toBeNull();
    expect(decideTerminalLinuxUndoKey(key({ key: 'z', code: 'KeyZ' }), 'linux')).toBeNull();
  });
});
