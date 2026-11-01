/**
 * Single guard for AUTOMATIC terminal focus (spawn, session open, end of veil,
 * restore). Explicit focus (click, tab, shortcuts) does not go through here:
 * the user decides.
 *
 * Rule: an automatic focus must never steal the caret from a text field
 * (commit message, composer, rename, search) or from an open modal; for spawn,
 * not even from someone who is typing to another agent right now.
 */

export type AutoFocusKind = 'spawn' | 'open' | 'restore';

const MODAL_SELECTOR = 'ngb-modal-window, .swal2-container.swal2-backdrop-show, [role="dialog"][aria-modal="true"]';
const TYPING_WINDOW_MS = 1500;

let lastTerminalKeyAt = 0;
let typingListenerInstalled = false;

function isInsideTerminal(el: Element | null): boolean {
  return !!el?.closest?.('.xterm');
}

/** true if the caret is in an editable field outside xterm, or a modal is open. */
export function isEditingOutsideTerminal(doc: Document = document): boolean {
  if (doc.querySelector(MODAL_SELECTOR)) return true;
  const el = doc.activeElement as HTMLElement | null;
  if (!el || el === doc.body || isInsideTerminal(el)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';
}

/** Records (once, in capture phase) the last key pressed inside a terminal. */
export function installTerminalTypingTracker(doc: Document = document): void {
  if (typingListenerInstalled) return;
  typingListenerInstalled = true;
  doc.addEventListener('keydown', (e) => {
    if (isInsideTerminal(e.target as Element | null)) lastTerminalKeyAt = Date.now();
  }, true);
}

/** true if the user pressed a key in a terminal within the last `ms`. */
export function recentlyTypedInTerminal(ms = TYPING_WINDOW_MS, now = Date.now()): boolean {
  return lastTerminalKeyAt > 0 && now - lastTerminalKeyAt < ms;
}

/** Can an automatic focus move the caret right now? */
export function canAutoFocus(kind: AutoFocusKind, doc: Document = document): boolean {
  if (isEditingOutsideTerminal(doc)) return false;
  if (kind === 'spawn' && recentlyTypedInTerminal()) return false;
  return true;
}

/** Tests only. */
export function __resetTerminalFocusGuardForTests(): void {
  lastTerminalKeyAt = 0;
  typingListenerInstalled = false;
}

/** Tests only. */
export function __markTerminalKeyForTests(at: number): void {
  lastTerminalKeyAt = at;
}

/**
 * Pane to focus when the current one goes away (close, exit, bench, move):
 * the neighbor in display order (previous first, then next),
 * otherwise the lead, otherwise the first available one.
 *
 * @param roster   ids of the visible panes, in display order
 * @param goneIndex index the leaving pane had in the previous roster (-1 if unknown)
 * @param leadId   id of the lead/main pane to prefer as a fallback
 */
export function pickFallbackPane(roster: string[], goneIndex: number, leadId: string | null): string | null {
  if (roster.length === 0) return null;
  if (goneIndex >= 0) {
    const prev = roster[Math.min(goneIndex, roster.length) - 1];
    if (prev !== undefined) return prev;
    return roster[0];
  }
  if (leadId && roster.includes(leadId)) return leadId;
  return roster[0];
}
