/**
 * Treats Cmd as a "line" modifier in the terminal, macOS style.
 *
 * xterm.js explicitly ignores Cmd+arrow (`if (ev.metaKey) break`), so
 * Cmd+←/→ never reach the PTY. Here we translate them into the emacs readline
 * sequences every CLI understands (Claude Code, Codex, Gemini, zsh/bash):
 *   Cmd+←         → Ctrl+A (start of line)
 *   Cmd+→         → Ctrl+E (end of line)
 *   Cmd+Backspace → Ctrl+U (delete to start of line)
 * Option+←/→ (word) is already handled by xterm (ESC b / ESC f), we leave it alone.
 *
 * Returns the string to write to the PTY, or null to let the key through.
 * Plain Cmd only (no Ctrl/Alt/Shift) and macOS only: on Windows/Linux
 * metaKey is the Win/Super key, which the OS keeps for itself.
 */
export function decideTerminalMacLineKey(
  ev: KeyboardEvent,
  platform: string | undefined,
): string | null {
  if (platform !== 'darwin') return null;
  if (!ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  switch (ev.key) {
    case 'ArrowLeft': return '\x01';
    case 'ArrowRight': return '\x05';
    case 'Backspace': return '\x15';
    default: return null;
  }
}

/**
 * Linux: Ctrl+Z in an agent terminal sends SIGTSTP and suspends the CLI (Claude
 * Code goes to the background, leaving a bare shell that needs `fg`). Remap it to
 * Ctrl+_ (\x1f), the input undo of Claude Code and readline. Linux only.
 */
export function decideTerminalLinuxUndoKey(
  ev: KeyboardEvent,
  platform: string | undefined,
): string | null {
  if (platform !== 'linux') return null;
  if (!ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return null;
  return ev.key === 'z' || ev.key === 'Z' || ev.code === 'KeyZ' ? '\x1f' : null;
}
