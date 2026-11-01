import {
  __markTerminalKeyForTests,
  __resetTerminalFocusGuardForTests,
  canAutoFocus,
  isEditingOutsideTerminal,
  pickFallbackPane,
  recentlyTypedInTerminal,
} from './terminal-focus-guard';

describe('terminal-focus-guard', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    __resetTerminalFocusGuardForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    host.remove();
  });

  function add<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement = host): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    parent.appendChild(el);
    return el;
  }

  describe('isEditingOutsideTerminal', () => {
    it('is false with nothing focused', () => {
      expect(isEditingOutsideTerminal()).toBeFalse();
    });

    it('is true for a focused textarea (commit message) or input', () => {
      add('textarea').focus();
      expect(isEditingOutsideTerminal()).toBeTrue();
      add('input').focus();
      expect(isEditingOutsideTerminal()).toBeTrue();
    });

    it('is true for a focused contenteditable', () => {
      const div = add('div');
      div.setAttribute('contenteditable', 'true');
      div.tabIndex = 0;
      div.focus();
      expect(isEditingOutsideTerminal()).toBeTrue();
    });

    it('is false for the xterm helper textarea', () => {
      const xterm = add('div');
      xterm.className = 'xterm';
      add('textarea', xterm).focus();
      expect(isEditingOutsideTerminal()).toBeFalse();
    });

    it('is false for a focused button', () => {
      add('button').focus();
      expect(isEditingOutsideTerminal()).toBeFalse();
    });

    it('is true while a modal is open', () => {
      add('ngb-modal-window' as any);
      expect(isEditingOutsideTerminal()).toBeTrue();
    });
  });

  describe('recentlyTypedInTerminal / canAutoFocus', () => {
    it('blocks spawn focus right after typing in a terminal, not open focus', () => {
      __markTerminalKeyForTests(Date.now());
      expect(recentlyTypedInTerminal()).toBeTrue();
      expect(canAutoFocus('spawn')).toBeFalse();
      expect(canAutoFocus('open')).toBeTrue();
    });

    it('allows spawn focus once the typing window has passed', () => {
      __markTerminalKeyForTests(Date.now() - 5000);
      expect(recentlyTypedInTerminal()).toBeFalse();
      expect(canAutoFocus('spawn')).toBeTrue();
    });

    it('blocks every kind while a text field has the caret', () => {
      add('textarea').focus();
      expect(canAutoFocus('spawn')).toBeFalse();
      expect(canAutoFocus('open')).toBeFalse();
      expect(canAutoFocus('restore')).toBeFalse();
    });
  });

  describe('pickFallbackPane', () => {
    it('returns null for an empty roster', () => {
      expect(pickFallbackPane([], 0, null)).toBeNull();
    });

    it('prefers the previous neighbor of the removed pane', () => {
      // was [a, b, c], b (index 1) removed
      expect(pickFallbackPane(['a', 'c'], 1, 'c')).toBe('a');
    });

    it('falls to the next pane when the first one is removed', () => {
      // was [a, b, c], a (index 0) removed
      expect(pickFallbackPane(['b', 'c'], 0, 'c')).toBe('b');
    });

    it('takes the new last pane when the last one is removed', () => {
      // was [a, b, c], c (index 2) removed
      expect(pickFallbackPane(['a', 'b'], 2, null)).toBe('b');
    });

    it('uses the lead when nothing was focused before', () => {
      expect(pickFallbackPane(['a', 'lead', 'b'], -1, 'lead')).toBe('lead');
      expect(pickFallbackPane(['a', 'b'], -1, 'gone')).toBe('a');
    });
  });
});
