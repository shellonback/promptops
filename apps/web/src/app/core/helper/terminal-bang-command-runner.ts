import type { Terminal, IDisposable } from '@xterm/xterm';
import { createRowButtonLayer, isTerminalVisible, makeActionButton, type RowButton } from './terminal-row-buttons';

/**
 * Play button on Claude Code's "run this yourself" lines.
 *
 * When Claude needs the user to run a command it prints it as `  ! <command>`
 * (the `!` prefix = Claude Code bash mode). This helper scans the normal
 * buffer after each parsed write, anchors an xterm decoration (marker-based,
 * so it scrolls with the line) in the indent gutter left of the `!`, and on
 * click types the command into the TUI: `!` (enter bash mode), the command,
 * then Enter.
 *
 * Lines inside/below Claude's input box (between the `────` rules at the
 * bottom) are ignored, so the user's own `! …` draft never gets a button.
 *
 * Works on the alternate screen too (Claude Code `"tui": "fullscreen"`):
 * see terminal-row-buttons.ts. The copy icon at the end of the same rows is
 * drawn by terminal-link-copier.ts.
 */

// The command can also be the FIRST line of Claude's reply: then the row is
// `● ! <command>` (reply bullet, `⏺` on older CLIs) and the button covers the bullet.
const BANG_LINE_RE = /^(\s{1,8}|\s{0,4}[●⏺]\s{1,4})! (\S.*?)\s*$/;
const INPUT_RULE_RE = /^[\s╭╰]*[─━]{10,}/;
const SCAN_BACK_LINES = 300;
const BOTTOM_LOOKUP_LINES = 30;
const MAX_BUTTONS = 60;

export interface BangCommandRunnerOptions {
  /** Re-evaluated on every scan (provider can change in place). */
  isEnabled: () => boolean;
  /** Raw write to the PTY of this terminal. */
  write: (data: string) => void;
  /** Accessible name / tooltip of the ▶ button (translated by the caller). */
  runLabel?: (command: string) => string;
}

/** Type `! <command>` + Enter into a Claude Code TUI. */
export async function typeBangCommand(write: (data: string) => void, command: string): Promise<void> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Empty the input first: `!` switches to bash mode only as the first char
  // of an empty prompt, otherwise it is typed literally.
  write('\x05\x15'); // Ctrl+E (end of line) + Ctrl+U (delete to line start)
  await pause(80);
  // `!` alone first: Claude switches to bash mode only on a lone keystroke.
  write('!');
  await pause(250);
  write(command);
  // A long chunk is handled as a paste: an Enter arriving while Claude is
  // still ingesting it becomes a newline instead of submitting.
  await pause(300 + Math.min(700, command.length * 2));
  write('\r');
}

function lineText(terminal: Terminal, index: number): string {
  return terminal.buffer.active.getLine(index)?.translateToString(true) ?? '';
}

// Rows that open something new: never a continuation of the command.
const NEW_ITEM_RE = /^\s*(?:\d+[.)]|[-*•●⏺]|!)\s/;

/**
 * Command on the `!` row plus its continuation rows. Claude's TUI word-wraps
 * long commands with hard newlines (not xterm soft wraps), so a following row
 * is a continuation when its first word could not have fit on the row above.
 */
export function bangAt(
  terminal: Terminal,
  index: number,
  limit: number,
): { indent: number; command: string; endRow: number; endCol: number } | null {
  const m = BANG_LINE_RE.exec(lineText(terminal, index));
  if (!m) return null;
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  let command = m[2];
  let prev = lineText(terminal, index).replace(/\s+$/, '');
  let endRow = index;
  for (let i = index + 1; i < limit; i++) {
    const row = buffer.getLine(i);
    if (!row) break;
    const text = lineText(terminal, i);
    if (row.isWrapped) {
      command += text.replace(/\s+$/, '');
      prev = text;
      endRow = i;
      continue;
    }
    const body = text.trim();
    if (!body || NEW_ITEM_RE.test(text)) break;
    if (text.length - text.trimStart().length > m[1].length + 2) break;
    const firstWord = body.split(/\s/, 1)[0];
    if (prev.length + 1 + firstWord.length <= cols) break;
    command += ' ' + body;
    prev = text.replace(/\s+$/, '');
    endRow = i;
  }
  return { indent: m[1].length, command, endRow, endCol: prev.replace(/\s+$/, '').length };
}

/**
 * Rows `[from, limit)` where a `! command` can be Claude's: everything above
 * the input box (the user's own draft never gets a button).
 */
export function bangScanRange(terminal: Terminal): { from: number; limit: number } {
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'normal') {
    // Fullscreen TUI: the cursor can sit anywhere. The input box is the last
    // pair of rules near the bottom, its top rule is the limit.
    let limit = buffer.length;
    let rules = 0;
    for (let i = buffer.length - 1; i >= Math.max(0, buffer.length - BOTTOM_LOOKUP_LINES) && rules < 2; i--) {
      if (INPUT_RULE_RE.test(lineText(terminal, i))) { limit = i; rules++; }
    }
    return { from: 0, limit };
  }
  const cursorAbs = buffer.baseY + buffer.cursorY;
  let limit = cursorAbs + 1;
  for (let i = cursorAbs; i >= Math.max(0, cursorAbs - BOTTOM_LOOKUP_LINES); i--) {
    if (INPUT_RULE_RE.test(lineText(terminal, i))) limit = i;
  }
  return { from: Math.max(0, limit - SCAN_BACK_LINES), limit };
}

export function attachBangCommandRunner(terminal: Terminal, opts: BangCommandRunnerOptions): IDisposable {
  const layer = createRowButtonLayer(terminal, MAX_BUTTONS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const scan = () => {
    timer = null;
    if (disposed) return;
    // Hidden tab / pane: no work now, look again later (cheap check).
    if (!isTerminalVisible(terminal)) {
      timer = setTimeout(scan, 1500);
      return;
    }
    if (!opts.isEnabled()) {
      layer.clear();
      return;
    }
    const buffer = terminal.buffer.active;
    const { from, limit } = bangScanRange(terminal);
    const items: RowButton[] = [];
    for (let i = from; i < limit; i++) {
      const row = buffer.getLine(i);
      if (!row || row.isWrapped) continue;
      const b = bangAt(terminal, i, limit);
      if (!b) continue;
      const command = b.command;
      items.push({
        row: i,
        x: Math.max(0, b.indent - 2),
        width: Math.min(2, b.indent),
        key: command,
        create: () =>
          makeActionButton(terminal, {
            label: '▶',
            title: opts.runLabel ? opts.runLabel(command) : `Run: ${command}`,
            run: () => typeBangCommand(opts.write, command),
          }),
      });
    }
    layer.sync(items, from);
  };

  const schedule = () => {
    if (timer === null && !disposed) timer = setTimeout(scan, 200);
  };
  const subs = [
    terminal.onWriteParsed(schedule),
    terminal.buffer.onBufferChange(schedule),
    terminal.onResize(schedule),
  ];
  schedule();

  return {
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      for (const s of subs) s.dispose();
      layer.dispose();
    },
  };
}
