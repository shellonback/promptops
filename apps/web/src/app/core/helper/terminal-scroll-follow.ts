import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * "Reading further up" state of a terminal, for the ↓ new output button.
 *
 * xterm does not drag down a user who scrolled up (good), but the user cannot
 * tell that more output arrived below. This tracks `viewportY` against
 * `baseY`: while the viewport is not at the bottom it counts the new lines.
 * `onChange` fires only when the state actually changes (not on every
 * chunk), so the component can re-enter the Angular zone at no per-frame cost.
 */
export interface ScrollFollowState {
  /** Viewport is not at the bottom of the buffer. */
  away: boolean;
  /** Lines that arrived below since the user left the bottom. */
  newLines: number;
}

export interface ScrollFollowHandle {
  scrollToBottom(): void;
  dispose(): void;
}

/** The count on the button updates at most this often. */
const COUNT_THROTTLE_MS = 250;

export function attachScrollFollow(
  xterm: Terminal,
  onChange: (state: ScrollFollowState) => void,
): ScrollFollowHandle {
  let away = false;
  let newLines = 0;
  let baseAtLeave = 0;
  let lastEmitted: ScrollFollowState = { away: false, newLines: 0 };
  let countTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    if (lastEmitted.away === away && lastEmitted.newLines === newLines) return;
    lastEmitted = { away, newLines };
    onChange(lastEmitted);
  };

  const check = () => {
    const buf = xterm.buffer.active;
    // Alternate screen (full-screen TUI): no scrollback to follow.
    const atBottom = buf.type === 'alternate' || buf.viewportY >= buf.baseY;
    if (atBottom) {
      if (!away) return;
      away = false;
      newLines = 0;
      if (countTimer !== null) { clearTimeout(countTimer); countTimer = null; }
      emit();
      return;
    }
    if (!away) {
      away = true;
      newLines = 0;
      baseAtLeave = buf.baseY;
      emit();
      return;
    }
    const grown = Math.max(0, buf.baseY - baseAtLeave);
    if (grown !== newLines && countTimer === null) {
      countTimer = setTimeout(() => {
        countTimer = null;
        if (!away) return;
        newLines = Math.max(0, xterm.buffer.active.baseY - baseAtLeave);
        emit();
      }, COUNT_THROTTLE_MS);
    }
  };

  const subs: IDisposable[] = [
    xterm.onScroll(() => check()),
    xterm.onWriteParsed(() => { if (away) check(); }),
    xterm.buffer.onBufferChange(() => check()),
  ];

  return {
    scrollToBottom() {
      xterm.scrollToBottom();
      check();
    },
    dispose() {
      if (countTimer !== null) clearTimeout(countTimer);
      for (const s of subs) { try { s.dispose(); } catch { /* already disposed */ } }
    },
  };
}
