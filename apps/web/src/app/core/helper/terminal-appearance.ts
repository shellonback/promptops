import type { ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';

/**
 * Single look for agent terminals (main session and sub-agents).
 *
 * Each used to carry its own: the main terminal read the user preferences,
 * sub-agents were pinned to 13px / line height 1.0 with a different palette,
 * so text was cramped and differed from pane to pane. This is the one source,
 * read from the user preferences (CSS variables published by
 * UiPreferencesService.apply) and re-applied live.
 */

/** Global event dispatched by UiPreferencesService.apply(). */
export const TERMINAL_PREFS_EVENT = 'po-terminal-prefs';

/** Shared dark palette. Terminals stay dark in light mode too: agent CLIs
 *  (Claude Code, Codex…) pick their colors for a dark background. */
export const TERMINAL_THEME: ITheme = {
  background: '#10121a',
  foreground: '#c3cddc',
  cursor: '#818cf8',
  cursorAccent: '#10121a',
  selectionBackground: 'rgba(99, 102, 241, 0.32)',
  // xterm 6 draws its own scrollbar: CSS on the viewport no longer applies.
  scrollbarSliderBackground: 'rgba(129, 140, 248, 0.22)',
  scrollbarSliderHoverBackground: 'rgba(129, 140, 248, 0.40)',
  scrollbarSliderActiveBackground: 'rgba(129, 140, 248, 0.55)',
  black: '#10121a',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#e3b341',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#aab8c5',
  brightBlack: '#6b7686',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#f0c74f',
  brightBlue: '#a5b4fc',
  brightMagenta: '#e0c3ff',
  brightCyan: '#7ee8f0',
  brightWhite: '#f1f1f1',
};

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'underline' | 'bar';
}

const DEFAULT_APPEARANCE: TerminalAppearance = {
  fontFamily: '"Geist Mono", ui-monospace, monospace',
  fontSize: 14,
  lineHeight: 1.4,
  cursorStyle: 'block',
};

/** Current font, size, line height and cursor from the user preferences. */
export function readTerminalAppearance(): TerminalAppearance {
  const prefs = (window as any).__PO_UI_PREFS__ ?? {};
  const root = document.documentElement.style;
  const family = root.getPropertyValue('--po-terminal-font')?.trim()
    || (prefs.terminal_font_family ? `"${prefs.terminal_font_family}", ui-monospace, monospace` : '')
    || DEFAULT_APPEARANCE.fontFamily;
  const size = parseInt(root.getPropertyValue('--po-terminal-font-size'), 10)
    || prefs.terminal_font_size || DEFAULT_APPEARANCE.fontSize;
  const lineHeight = parseFloat(root.getPropertyValue('--po-terminal-line-height'))
    || prefs.terminal_line_height || DEFAULT_APPEARANCE.lineHeight;
  const cursor = (root.getPropertyValue('--po-terminal-cursor')?.trim()
    || prefs.terminal_cursor_style || DEFAULT_APPEARANCE.cursorStyle) as TerminalAppearance['cursorStyle'];
  return { fontFamily: family, fontSize: size, lineHeight, cursorStyle: cursor };
}

/**
 * xterm options shared by every agent terminal. Callers add their own
 * (linkHandler, known cols/rows, cursorBlink…).
 */
export function buildTerminalOptions(): ITerminalOptions {
  const a = readTerminalAppearance();
  return {
    fontFamily: a.fontFamily,
    fontSize: a.fontSize,
    lineHeight: a.lineHeight,
    cursorStyle: a.cursorStyle,
    fontWeightBold: '600',
    // Keeps the agents' gray/dim text readable without flattening hierarchy.
    minimumContrastRatio: 3,
    // Ambiguous glyphs (icons, arrows) that overflow the cell get rescaled.
    rescaleOverlappingGlyphs: true,
    // Alt + wheel = fast scroll.
    fastScrollSensitivity: 5,
    theme: TERMINAL_THEME,
    scrollback: 10_000,
    allowProposedApi: true,
  };
}

/**
 * Applies font/size/line height/cursor live when the user changes settings.
 * `onMetricsChanged` should refit the component (a new cell size means new
 * cols/rows). Returns the cleanup function.
 */
export function watchTerminalAppearance(xterm: Terminal, onMetricsChanged: () => void): () => void {
  const handler = () => {
    const a = readTerminalAppearance();
    const o = xterm.options;
    let metrics = false;
    if (o.fontFamily !== a.fontFamily) { o.fontFamily = a.fontFamily; metrics = true; }
    if (o.fontSize !== a.fontSize) { o.fontSize = a.fontSize; metrics = true; }
    if (o.lineHeight !== a.lineHeight) { o.lineHeight = a.lineHeight; metrics = true; }
    if (o.cursorStyle !== a.cursorStyle) o.cursorStyle = a.cursorStyle;
    if (metrics) onMetricsChanged();
  };
  window.addEventListener(TERMINAL_PREFS_EVENT, handler);
  return () => window.removeEventListener(TERMINAL_PREFS_EVENT, handler);
}
