import type { Terminal } from '@xterm/xterm';

/**
 * Coalesces a PTY's live output into ONE `write()` per frame.
 *
 * The channel delivers output in small, dense chunks (a streaming TUI sends
 * dozens per frame): one write per chunk means one parse and one scheduled
 * render per chunk, and text scrolls in jerks. Here chunks pile up and go out
 * together on the next frame.
 *
 * Hidden pane (inactive tab, `visibility:hidden`): xterm would keep parsing
 * and drawing through WebGL for nothing. Output stays queued and is released
 * when the pane is visible again, or right away past `MAX_PENDING`, so memory
 * cannot grow without bound.
 *
 * Schedulers run outside the Angular zone (`runOutside`): a rAF inside the
 * zone would trigger change detection on every frame of output.
 */
const MAX_PENDING = 2 * 1024 * 1024;
const HIDDEN_RECHECK_MS = 250;
/** rAF does not run while the window is minimized: a timer guarantees the flush. */
const FALLBACK_MS = 50;

export interface TerminalWriteBatcher {
  write(data: string): void;
  /** Writes what is queued right away (before replay/resize/dispose). */
  flush(): void;
  dispose(): void;
}

export function createTerminalWriteBatcher(
  xterm: Terminal,
  opts: {
    /** Pane element: while it is not visible, output stays queued. */
    element?: () => HTMLElement | null | undefined;
    runOutside?: (fn: () => void) => void;
    /** Direct writes, no queue (the previous behavior). */
    passthrough?: boolean;
  } = {},
): TerminalWriteBatcher {
  const run = opts.runOutside ?? ((fn: () => void) => fn());
  let pending: string[] = [];
  let pendingSize = 0;
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancel = () => {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  const isHidden = (): boolean => {
    const el = opts.element?.();
    if (!el) return false;
    const anyEl = el as HTMLElement & { checkVisibility?: (o?: object) => boolean };
    if (typeof anyEl.checkVisibility === 'function') {
      return !anyEl.checkVisibility({ visibilityProperty: true });
    }
    return getComputedStyle(el).visibility === 'hidden';
  };

  const flush = () => {
    cancel();
    if (disposed || pending.length === 0) return;
    const data = pending.length === 1 ? pending[0] : pending.join('');
    pending = [];
    pendingSize = 0;
    try { xterm.write(data); } catch { /* terminal already disposed */ }
  };

  const tick = () => {
    cancel();
    if (disposed || pending.length === 0) return;
    if (pendingSize < MAX_PENDING && isHidden()) {
      run(() => { timer = setTimeout(tick, HIDDEN_RECHECK_MS); });
      return;
    }
    flush();
  };

  const schedule = () => {
    if (raf !== null || timer !== null) return;
    run(() => {
      raf = requestAnimationFrame(tick);
      timer = setTimeout(tick, FALLBACK_MS);
    });
  };

  return {
    write(data: string) {
      if (disposed || !data) return;
      if (opts.passthrough) { try { xterm.write(data); } catch { /* disposed */ } return; }
      pending.push(data);
      pendingSize += data.length;
      if (pendingSize >= MAX_PENDING) { flush(); return; }
      schedule();
    },
    flush,
    dispose() {
      cancel();
      disposed = true;
      pending = [];
      pendingSize = 0;
    },
  };
}
