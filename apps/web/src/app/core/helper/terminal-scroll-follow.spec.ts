import { Terminal } from '@xterm/xterm';
import { attachScrollFollow, ScrollFollowState } from './terminal-scroll-follow';

function write(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

describe('terminal-scroll-follow', () => {
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true });
  });
  afterEach(() => term.dispose());

  it('reports away when scrolled up and back when at bottom', async () => {
    const states: ScrollFollowState[] = [];
    const h = attachScrollFollow(term, (s) => states.push(s));
    await write(term, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\r\n'));
    expect(states).toEqual([]);
    term.scrollLines(-3);
    expect(states.at(-1)).toEqual({ away: true, newLines: 0 });
    h.scrollToBottom();
    expect(states.at(-1)).toEqual({ away: false, newLines: 0 });
    h.dispose();
  });

  it('counts new lines that arrive while away', async () => {
    const states: ScrollFollowState[] = [];
    const h = attachScrollFollow(term, (s) => states.push(s));
    await write(term, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\r\n'));
    term.scrollLines(-3);
    await write(term, '\r\nnew 1\r\nnew 2');
    await new Promise((r) => setTimeout(r, 320));
    expect(states.at(-1)?.away).toBeTrue();
    expect(states.at(-1)?.newLines).toBe(2);
    h.dispose();
  });
});
