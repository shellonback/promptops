import type { Terminal, IMarker, IDecoration } from '@xterm/xterm';

/** False while the terminal sits in a hidden tab / pane: callers skip their scan. */
export function isTerminalVisible(terminal: Terminal): boolean {
  const el = terminal.element;
  return !!el && el.offsetParent !== null;
}

/**
 * Small DOM buttons anchored to terminal cells (play on `! command` rows,
 * copy on links…), shared by terminal-bang-command-runner.ts and
 * terminal-link-copier.ts.
 *
 * Normal buffer: xterm decorations on markers, so they scroll with the row.
 * Alternate buffer (Claude Code `"tui": "fullscreen"`): xterm hides every
 * decoration there (BufferDecorationRenderer → display:none), so the buttons
 * go in our own overlay inside `.xterm-screen` (no scrollback: buffer row =
 * viewport row), rebuilt by the caller's scan on every write. The TUI
 * redraws the rows itself when it scrolls, so each overlay button remembers
 * the text of its row and is removed in the same frame the row changes: it
 * never lingers over the wrong line while waiting for the next scan.
 */

export interface RowButton {
  /** Absolute buffer line. */
  row: number;
  /** First cell and width in cells. */
  x: number;
  width: number;
  /** Identity of the content (same row + x + key = same button, kept as is). */
  key: string;
  create: () => HTMLElement;
}

export interface RowButtonLayer {
  /**
   * Make the buttons match `items`. Buttons above `scannedFrom` (rows the
   * caller did not re-read: old scrollback) are kept untouched.
   */
  sync(items: RowButton[], scannedFrom: number): void;
  clear(): void;
  dispose(): void;
}

interface Entry {
  key: string;
  x: number;
  marker: IMarker;
  decoration: IDecoration;
}

const idOf = (row: number, x: number, key: string) => `${row}|${x}|${key}`;

export function createRowButtonLayer(terminal: Terminal, maxButtons: number): RowButtonLayer {
  let entries: Entry[] = [];
  let overlay: HTMLElement | null = null;
  const cells = new Map<string, { el: HTMLElement; row: number; text: string }>();
  const rowText = (row: number) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '';

  const drop = (e: Entry) => {
    e.decoration.dispose();
    e.marker.dispose();
  };
  const clearNormal = () => {
    for (const e of entries) drop(e);
    entries = [];
  };
  const clearAlt = () => {
    cells.clear();
    overlay?.remove();
    overlay = null;
  };

  const syncNormal = (items: RowButton[], scannedFrom: number) => {
    const buffer = terminal.buffer.active;
    const cursorAbs = buffer.baseY + buffer.cursorY;
    const wanted = new Map(items.map((it) => [idOf(it.row, it.x, it.key), it]));
    entries = entries.filter((e) => {
      if (!e.marker.isDisposed) {
        if (e.marker.line < scannedFrom) return true;
        if (wanted.delete(idOf(e.marker.line, e.x, e.key))) return true;
      }
      drop(e);
      return false;
    });
    for (const it of wanted.values()) {
      const marker = terminal.registerMarker(it.row - cursorAbs);
      if (!marker) continue;
      const decoration = terminal.registerDecoration({ marker, x: it.x, width: it.width, layer: 'top' });
      if (!decoration) { marker.dispose(); continue; }
      decoration.onRender((el) => {
        if (el.dataset['poRowBtn']) return;
        el.dataset['poRowBtn'] = '1';
        el.style.pointerEvents = 'auto';
        el.style.zIndex = '7';
        el.appendChild(it.create());
      });
      entries.push({ key: it.key, x: it.x, marker, decoration });
    }
    while (entries.length > maxButtons) drop(entries.shift()!);
  };

  const syncAlt = (items: RowButton[]) => {
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    const cellW = screen.clientWidth / terminal.cols;
    const cellH = screen.clientHeight / terminal.rows;
    const seen = new Set<string>();
    for (const it of items.slice(-maxButtons)) {
      const id = idOf(it.row, it.x, it.key);
      seen.add(id);
      const known = cells.get(id);
      let cell = known?.el;
      if (known) known.text = rowText(it.row);
      if (!cell) {
        if (!overlay || !overlay.isConnected) {
          overlay = document.createElement('div');
          Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '7' });
          screen.appendChild(overlay);
        }
        cell = document.createElement('div');
        cell.style.position = 'absolute';
        cell.style.pointerEvents = 'auto';
        cell.appendChild(it.create());
        overlay.appendChild(cell);
        cells.set(id, { el: cell, row: it.row, text: rowText(it.row) });
      }
      Object.assign(cell.style, {
        left: `${it.x * cellW}px`,
        top: `${it.row * cellH}px`,
        width: `${it.width * cellW}px`,
        height: `${cellH}px`,
        fontSize: `${terminal.options.fontSize ?? 13}px`,
      });
    }
    for (const [id, cell] of cells) {
      if (seen.has(id)) continue;
      cell.el.remove();
      cells.delete(id);
    }
  };

  // Alternate screen only: drop at once the buttons whose row was redrawn.
  const onWrite = terminal.onWriteParsed(() => {
    if (!cells.size) return;
    for (const [id, cell] of cells) {
      if (rowText(cell.row) === cell.text) continue;
      cell.el.remove();
      cells.delete(id);
    }
  });

  return {
    sync: (items, scannedFrom) => {
      if (terminal.buffer.active.type === 'normal') {
        clearAlt();
        syncNormal(items, scannedFrom);
      } else {
        clearNormal();
        syncAlt(items);
      }
    },
    clear: () => {
      clearNormal();
      clearAlt();
    },
    dispose: () => {
      onWrite.dispose();
      clearNormal();
      clearAlt();
    },
  };
}

export interface ActionButtonOptions {
  label: string;
  title: string;
  /** Label shown for 1.5s after `run` resolved (default `✓`). */
  doneLabel?: string;
  fontSize?: string;
  run: () => Promise<void>;
}

/** Accent button filling its cell(s): ✓ green when `run` resolves, ✗ red when it rejects. */
export function makeActionButton(terminal: Terminal, o: ActionButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = o.label;
  btn.title = o.title;
  btn.setAttribute('aria-label', o.title);
  Object.assign(btn.style, {
    width: '100%',
    height: '100%',
    padding: '0',
    margin: '0',
    border: 'none',
    borderRadius: '3px',
    background: '#4F41FA',
    color: '#fff',
    fontSize: o.fontSize ?? '0.7em',
    lineHeight: '1',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  // Keep xterm from starting a selection / stealing the click.
  btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    void o.run()
      .then(() => {
        btn.textContent = o.doneLabel ?? '✓';
        btn.style.background = '#16a34a';
      })
      .catch(() => {
        btn.textContent = '✗';
        btn.style.background = '#dc2626';
      })
      .finally(() => {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = o.label;
          btn.style.background = '#4F41FA';
        }, 1500);
        terminal.focus();
      });
  });
  return btn;
}
