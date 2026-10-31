import type { Terminal } from '@xterm/xterm';
import { createTerminalWriteBatcher } from './terminal-write-batcher';

function fakeXterm() {
  const writes: string[] = [];
  return { writes, xterm: { write: (d: string) => writes.push(d) } as unknown as Terminal };
}

describe('terminal-write-batcher', () => {
  beforeEach(() => jasmine.clock().install());
  afterEach(() => jasmine.clock().uninstall());

  it('coalesces chunks into one write, in order', () => {
    const { writes, xterm } = fakeXterm();
    const b = createTerminalWriteBatcher(xterm);
    b.write('a');
    b.write('b');
    b.write('c');
    expect(writes).toEqual([]);
    jasmine.clock().tick(60);
    expect(writes).toEqual(['abc']);
  });

  it('flush writes pending data immediately', () => {
    const { writes, xterm } = fakeXterm();
    const b = createTerminalWriteBatcher(xterm);
    b.write('x');
    b.flush();
    expect(writes).toEqual(['x']);
    jasmine.clock().tick(60);
    expect(writes).toEqual(['x']);
  });

  it('holds output while the pane is hidden and releases it when shown', () => {
    const { writes, xterm } = fakeXterm();
    const el = document.createElement('div');
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    const b = createTerminalWriteBatcher(xterm, { element: () => el });
    b.write('hidden');
    jasmine.clock().tick(600);
    expect(writes).toEqual([]);
    el.style.visibility = 'visible';
    jasmine.clock().tick(300);
    expect(writes).toEqual(['hidden']);
    el.remove();
  });

  it('drops everything after dispose', () => {
    const { writes, xterm } = fakeXterm();
    const b = createTerminalWriteBatcher(xterm);
    b.write('a');
    b.dispose();
    b.write('b');
    jasmine.clock().tick(60);
    expect(writes).toEqual([]);
  });
});
