import type { Terminal, IDisposable } from '@xterm/xterm';
import { bangAt, bangScanRange } from './terminal-bang-command-runner';
import { FILE_PATH_RE, stripLineSuffix } from './terminal-file-link-provider';
import { createRowButtonLayer, isTerminalVisible, makeActionButton, type RowButton } from './terminal-row-buttons';

/**
 * Copy button on long links printed by the CLI (e.g. Claude Code `/login`
 * "Use the url below to sign in").
 *
 * The TUI hard-wraps long URLs into several rows (real newlines, not xterm
 * soft-wraps), so a mouse selection copies a broken link. This helper
 * rebuilds the full URL from the consecutive rows and anchors a "⧉ Copy"
 * button that copies it in one click.
 *
 * Everything else worth copying gets a small `⧉` icon right after it: any
 * other URL in the text, and Claude's `! <command>` rows (next to the play
 * button of terminal-bang-command-runner.ts). With `openUrl` / `openFile`
 * a `↗` icon opens the link, or the file / image path Claude mentions (same
 * paths as terminal-file-link-provider.ts). Normal and alternate screen, see
 * terminal-row-buttons.ts.
 */

// Optional box border (fullscreen TUI dialogs) around the URL text.
const URL_START_RE = /^(\s*(?:[│┃|]\s*)?)(https?:\/\/[^\s│┃]+)\s*(?:[│┃|]\s*)?$/;
// Continuation rows of a hard-wrapped URL: URL characters only, no spaces.
const URL_CONT_RE = /^(\s*(?:[│┃]\s*)?)([A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)\s*(?:[│┃]\s*)?$/;
const LOGIN_HINT_RE = /oauth|authorize|login|signin|sign-in|auth\?/i;
const MIN_PLAIN_URL_LEN = 100;
const MAX_CONT_ROWS = 20;
const SCAN_BACK_LINES = 300;
const MAX_BUTTONS = 80;
const BTN_WIDTH = 6;

const INLINE_URL_RE = /https?:\/\/[^\s│┃<>"`]+/g;
const URL_TAIL_RE = /^[^\s│┃<>"`]+/;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'»]+$/;

export interface LinkCopierLabels {
  copy: string;
  copied: string;
  copyLink: string;
  openLink: string;
  copyCommand: string;
  openFile: (path: string) => string;
}

const DEFAULT_LABELS: LinkCopierLabels = {
  copy: 'Copy',
  copied: 'Copied',
  copyLink: 'Copy link',
  openLink: 'Open link',
  copyCommand: 'Copy command',
  openFile: (path) => `Open ${path}`,
};

export interface LinkCopierOptions {
  /** Re-evaluated on every scan (provider can change in place). */
  isEnabled: () => boolean;
  /** Clipboard write (navigator.clipboard / native bridge). */
  copy: (text: string) => Promise<void>;
  /** Button texts, translated by the caller (English when omitted). */
  labels?: Partial<LinkCopierLabels>;
  /** Open a URL: adds a `↗` icon next to the copy one. */
  openUrl?: (url: string) => void;
  /** Open a file path printed by the CLI (code editor / image preview): `↗` icon after it. */
  openFile?: (path: string) => void;
}

function rowText(terminal: Terminal, index: number): string {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(index);
  if (!line) return '';
  let text = line.translateToString(true);
  for (let i = index + 1; i < buffer.length; i++) {
    const next = buffer.getLine(i);
    if (!next?.isWrapped) break;
    text += next.translateToString(true);
  }
  return text;
}

/** Rows that start a soft-wrapped run, from `index` on. */
function nextLogicalRow(terminal: Terminal, index: number): number {
  const buffer = terminal.buffer.active;
  let i = index + 1;
  while (i < buffer.length && buffer.getLine(i)?.isWrapped) i++;
  return i;
}

/** Full URL starting at row `index` (hard-wrapped continuations joined), or null. */
export function readUrlAt(terminal: Terminal, index: number): { url: string; indent: number; rows: number } | null {
  const m = URL_START_RE.exec(rowText(terminal, index));
  if (!m) return null;
  let url = m[2];
  let rows = 1;
  // Wrap width = where the first URL segment ends (terminal edge, or the
  // inner edge of a padded/bordered dialog in the fullscreen TUI).
  const wrapEnd = m[1].length + m[2].length;
  let prevEnd = wrapEnd;
  let i = nextLogicalRow(terminal, index);
  // A continuation only follows a row that ran to the wrap edge, and starts
  // at the same column as the first segment.
  while (rows <= MAX_CONT_ROWS && i < terminal.buffer.active.length && prevEnd >= wrapEnd - 1) {
    const c = URL_CONT_RE.exec(rowText(terminal, i));
    if (!c || c[1].length !== m[1].length || /^https?:\/\//.test(c[2])) break;
    url += c[2];
    rows++;
    prevEnd = c[1].length + c[2].length;
    i = nextLogicalRow(terminal, i);
  }
  const interesting = rows > 1 || LOGIN_HINT_RE.test(url) || url.length >= MIN_PLAIN_URL_LEN;
  return interesting ? { url, indent: m[1].length, rows } : null;
}

export function attachLinkCopier(terminal: Terminal, opts: LinkCopierOptions): IDisposable {
  const layer = createRowButtonLayer(terminal, MAX_BUTTONS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Row text, read once per scan.
  let rowCache = new Map<number, string>();
  const physical = (i: number) => {
    let t = rowCache.get(i);
    if (t === undefined) {
      t = terminal.buffer.active.getLine(i)?.translateToString(true) ?? '';
      rowCache.set(i, t);
    }
    return t;
  };

  const labels: LinkCopierLabels = { ...DEFAULT_LABELS, ...opts.labels };

  const copyIcon = (text: string, title: string) => () =>
    makeActionButton(terminal, { label: '⧉', title, run: () => opts.copy(text) });

  const openIcon = (title: string, open: () => void) => () =>
    makeActionButton(terminal, { label: '↗', title, run: async () => open() });

  /**
   * Cells for up to `count` icons right after `endCol` on `row` (as many as
   * the blank run allows, at least one), else the blank before `startCol`.
   */
  const iconSlots = (
    row: number,
    endCol: number,
    startRow: number,
    startCol: number,
    count: number,
  ): { row: number; x: number; width: number }[] => {
    const rest = physical(row).slice(endCol);
    const free = Math.min(
      terminal.cols - endCol,
      rest.trim() === '' ? Infinity : rest.length - rest.trimStart().length,
    );
    for (let n = count; n >= 1; n--) {
      if (free >= 2 * n + 1) return Array.from({ length: n }, (_, k) => ({ row, x: endCol + 1 + 2 * k, width: 2 }));
      if (free >= 2 * n) return Array.from({ length: n }, (_, k) => ({ row, x: endCol + 2 * k, width: 2 }));
    }
    if (free >= 1) return [{ row, x: endCol, width: 1 }];
    if (startCol >= 1 && physical(startRow).slice(startCol - 1, startCol).trim() === '') {
      return [{ row: startRow, x: startCol - 1, width: 1 }];
    }
    return [];
  };

  const scan = () => {
    timer = null;
    if (disposed) return;
    // Hidden tab / pane: no work now, look again later (cheap check).
    if (!isTerminalVisible(terminal)) {
      timer = setTimeout(scan, 1500);
      return;
    }
    const buffer = terminal.buffer.active;
    // Normal AND alternate buffer: Claude Code with `"tui": "fullscreen"`
    // draws on the alternate screen.
    if (!opts.isEnabled()) {
      layer.clear();
      return;
    }

    rowCache = new Map();
    const cursorAbs = buffer.baseY + buffer.cursorY;
    // Alternate screen: no scrollback, the cursor can sit anywhere → whole screen.
    const lastRow = buffer.type === 'alternate' ? buffer.length - 1 : cursorAbs;
    const from = Math.max(0, lastRow - SCAN_BACK_LINES);
    const cols = terminal.cols;
    const items: RowButton[] = [];
    const bigRows = new Set<number>();
    const openUrl = opts.openUrl;
    const openFile = opts.openFile;

    // 1) Long / login URLs alone on their rows: "⧉ Copy" button.
    for (let i = from; i <= lastRow; i++) {
      const row = buffer.getLine(i);
      if (!row || row.isWrapped || bigRows.has(i) || !physical(i).includes('http')) continue;
      const found = readUrlAt(terminal, i);
      if (!found) continue;
      let end = i;
      for (let r = 0; r < found.rows; r++) end = nextLogicalRow(terminal, end);
      for (let r = i; r < end; r++) bigRows.add(r);
      // Anchor: room on the row above (e.g. "…sign in:", not a border) →
      // button after its text; else the indent gutter; else the right edge.
      const aboveRaw = i > 0 ? rowText(terminal, i - 1).replace(/\s+$/, '') : null;
      const above = aboveRaw !== null && !/[─━╭╮┌┐]{3,}/.test(aboveRaw) ? aboveRaw : null;
      let anchorRow = i;
      let x: number;
      if (above !== null && above.length + 1 + BTN_WIDTH <= cols) {
        anchorRow = i - 1;
        x = above.length + 1;
      } else if (found.indent >= BTN_WIDTH) {
        x = found.indent - BTN_WIDTH;
      } else {
        x = cols - BTN_WIDTH;
      }
      const url = found.url;
      // Open icon just left of the Copy button, when that cell pair is blank.
      if (openUrl && x >= 3 && physical(anchorRow).slice(x - 3, x).trim() === '') {
        items.push({ row: anchorRow, x: x - 2, width: 2, key: `O:${url}`, create: openIcon(labels.openLink, () => openUrl(url)) });
      }
      items.push({
        row: anchorRow,
        x,
        width: BTN_WIDTH,
        key: `U:${url}`,
        create: () =>
          makeActionButton(terminal, {
            label: `⧉ ${labels.copy}`,
            title: labels.copyLink,
            doneLabel: `✓ ${labels.copied}`,
            fontSize: '0.75em',
            run: () => opts.copy(url),
          }),
      });
    }

    // 2) Any other URL in the text: `⧉` icon right after it.
    for (let i = from; i <= lastRow; i++) {
      if (bigRows.has(i)) continue;
      const text = physical(i);
      const hasUrl = text.includes('http');
      if (!hasUrl && !(openFile && text.includes('/') && text.includes('.'))) continue;
      const urlSpans: [number, number][] = [];
      INLINE_URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (hasUrl && (m = INLINE_URL_RE.exec(text))) {
        urlSpans.push([m.index, m.index + m[0].length]);
        let url = m[0];
        let endRow = i;
        let endCol = m.index + url.length;
        // Soft-wrapped onto the next rows.
        while (endCol >= cols && buffer.getLine(endRow + 1)?.isWrapped) {
          const tail = URL_TAIL_RE.exec(physical(endRow + 1));
          if (!tail) break;
          url += tail[0];
          endRow++;
          endCol = tail[0].length;
        }
        const punct = TRAILING_PUNCT_RE.exec(url);
        if (punct && punct[0].length < endCol) {
          url = url.slice(0, -punct[0].length);
        }
        if (url.length < 12) continue;
        const target = url;
        const actions = [{ key: `u:${target}`, create: copyIcon(target, labels.copyLink) }];
        if (openUrl) actions.push({ key: `o:${target}`, create: openIcon(labels.openLink, () => openUrl(target)) });
        iconSlots(endRow, endCol, i, m.index, actions.length).forEach((slot, k) => items.push({ ...slot, ...actions[k] }));
      }

      // 2b) File / image paths Claude mentions: `↗` opens them.
      if (!openFile || !text.includes('/') || !text.includes('.')) continue;
      FILE_PATH_RE.lastIndex = 0;
      while ((m = FILE_PATH_RE.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (urlSpans.some(([a, b]) => start < b && end > a)) continue;
        const path = stripLineSuffix(m[0]);
        const [slot] = iconSlots(i, end, i, start, 1);
        if (slot) items.push({ ...slot, key: `f:${path}`, create: openIcon(labels.openFile(path), () => openFile(path)) });
      }
    }

    // 3) Claude's `! <command>` rows: `⧉` icon after the command.
    const bang = bangScanRange(terminal);
    for (let i = Math.max(from, bang.from); i < bang.limit; i++) {
      const row = buffer.getLine(i);
      if (!row || row.isWrapped || !physical(i).includes('! ')) continue;
      const b = bangAt(terminal, i, bang.limit);
      if (!b || b.endCol + 3 > cols) continue;
      items.push({
        row: b.endRow,
        x: b.endCol + 1,
        width: 2,
        key: `c:${b.command}`,
        create: copyIcon(b.command, labels.copyCommand),
      });
    }

    layer.sync(items, from);
  };

  const schedule = () => {
    if (timer === null && !disposed) timer = setTimeout(scan, 300);
  };
  const subs = [terminal.onWriteParsed(schedule), terminal.buffer.onBufferChange(schedule), terminal.onResize(schedule)];
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
