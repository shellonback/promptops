import { Injectable, inject } from "@angular/core";
import { DataBackend } from "@core/data/data-backend";
import { Store } from "@ngrx/store";
import { setCurrentUser } from "@/store/authentication/authentication.actions";
import { getUser } from "@/store/authentication/authentication.selector";
import { changetheme, changesidebarsize } from "@/store/layout/layout-action";
import type { UiPreferences } from "@core/models/user";
import { TERMINAL_PREFS_EVENT } from "@core/helper/terminal-appearance";

/**
 * ui_style is deliberately excluded: it's the manual A/B override managed by
 * UiStyleService alone. Keeping it out of the defaults/resolve cycle means
 * the settings form can never persist it wholesale and silently clobber the
 * minimal default that ships to users who never chose manually.
 */
export type ResolvedUiPreferences = Required<Omit<UiPreferences, "ui_style">>;

/**
 * Terminal performance/detection flags are device-specific (a slow Windows box
 * and a fast Mac want different settings for the SAME account), so they are
 * persisted in localStorage instead of the local profile. They are still part of
 * ResolvedUiPreferences for the settings form; resolve()/save() route them to
 * localStorage and keep them out of the server payload.
 */
const LOCAL_TERMINAL_FLAG_KEYS: (keyof UiPreferences)[] = [
  "terminal_gpu_acceleration",
  "terminal_link_detection",
  "terminal_cursor_blink",
  "terminal_command_detection",
  "terminal_input_detection",
  "terminal_activity_tail",
  "terminal_safe_mode",
  "terminal_host_screen",
  "terminal_persistent_agents",
];
/** Device-local string prefs (same localStorage routing as the boolean flags). */
const LOCAL_TERMINAL_STRING_KEYS: (keyof UiPreferences)[] = [
  "terminal_default_shell",
];
const LOCAL_TERMINAL_FLAGS_KEY = "po_terminal_flags";

const DEFAULTS: ResolvedUiPreferences = {
  theme: "dark",
  font_family: "Geist",
  font_size: 13,
  terminal_font_family: "Geist Mono",
  terminal_font_size: 14,
  terminal_cursor_style: "block",
  terminal_line_height: 1.4,
  terminal_gpu_acceleration: true,
  terminal_link_detection: true,
  terminal_cursor_blink: true,
  terminal_command_detection: true,
  terminal_input_detection: true,
  terminal_activity_tail: true,
  terminal_safe_mode: false,
  terminal_host_screen: true,
  // On by default on macOS/Linux; Windows waits for real-machine testing.
  terminal_persistent_agents: !isWindowsDesktop(),
  terminal_default_shell: "powershell",
  sidebar_size: "sm-hover-active",
};

/**
 * True only when running inside the desktop app on Windows. The "Safe
 * terminal" master switch is a Windows-only relief/diagnostic; on macOS/Linux it
 * stays completely inert so nothing changes there.
 */
function isWindowsDesktop(): boolean {
  const plat = (window as any).promptops?.platform;
  if (plat) return plat === "win32";
  return /Windows/i.test(navigator.userAgent);
}

@Injectable({ providedIn: "root" })
export class UiPreferencesService {
  private readonly data = inject(DataBackend);
  private readonly store = inject(Store);
  private readonly isDesktop = !!(window as any).promptops;

  get defaults(): ResolvedUiPreferences {
    return { ...DEFAULTS };
  }

  /**
   * Merge saved prefs with defaults to get a complete object. Device-local
   * terminal flags (localStorage) win over both, so they survive even though
   * the profile record never stores them.
   */
  resolve(saved?: UiPreferences | null): ResolvedUiPreferences {
    const { ui_style, ...rest } = saved ?? {};
    return { ...DEFAULTS, ...rest, ...this.loadLocalFlags() };
  }

  /**
   * Persist partial UI preferences. Terminal performance flags go to
   * localStorage (device-specific); everything else is saved in the local profile.
   */
  async save(partial: Partial<UiPreferences>): Promise<UiPreferences> {
    // Device-local terminal flags → localStorage, stripped from the payload.
    this.saveLocalFlags(partial);
    const profilePartial: Partial<UiPreferences> = { ...partial };
    for (const k of LOCAL_TERMINAL_FLAG_KEYS) delete profilePartial[k];
    for (const k of LOCAL_TERMINAL_STRING_KEYS) delete profilePartial[k];

    const user = await this.data.call<any>("user.updateUiPreferences", profilePartial);
    this.store.dispatch(setCurrentUser({ user }));
    return user.ui_preferences ?? {};
  }

  /** Read the device-local terminal flags from localStorage (booleans only). */
  private loadLocalFlags(): Partial<ResolvedUiPreferences> {
    try {
      const raw = localStorage.getItem(LOCAL_TERMINAL_FLAGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const out: Record<string, boolean | string> = {};
      for (const k of LOCAL_TERMINAL_FLAG_KEYS) {
        if (typeof parsed?.[k] === "boolean") out[k] = parsed[k];
      }
      for (const k of LOCAL_TERMINAL_STRING_KEYS) {
        if (typeof parsed?.[k] === "string" && parsed[k]) out[k] = parsed[k];
      }
      return out as Partial<ResolvedUiPreferences>;
    } catch {
      return {};
    }
  }

  /** Merge any terminal flags present in `prefs` into localStorage. */
  private saveLocalFlags(prefs: Partial<UiPreferences>): void {
    try {
      const next: Record<string, boolean | string> = { ...(this.loadLocalFlags() as Record<string, boolean | string>) };
      for (const k of LOCAL_TERMINAL_FLAG_KEYS) {
        const v = prefs[k];
        if (typeof v === "boolean") next[k] = v;
      }
      for (const k of LOCAL_TERMINAL_STRING_KEYS) {
        const v = prefs[k];
        if (typeof v === "string" && v) next[k] = v;
      }
      localStorage.setItem(LOCAL_TERMINAL_FLAGS_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — ignore */
    }
  }

  /**
   * Apply the resolved preferences to the DOM via CSS custom properties
   * and dispatch NgRx layout actions where relevant.
   */
  apply(prefs: ResolvedUiPreferences): void {
    this.lastApplied = prefs;
    // Publish the resolved prefs globally so terminal components (which read
    // synchronously at init, outside the NgRx flow) pick up live values —
    // including the performance toggles below.
    (window as any).__PO_UI_PREFS__ = prefs;
    const root = document.documentElement;

    // Theme
    let resolvedTheme = prefs.theme;
    if (resolvedTheme === "system") {
      resolvedTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    this.store.dispatch(changetheme({ color: resolvedTheme }));

    // Sidebar: the user preference is a desktop choice. On mobile (<=768)
    // we force 'full' (overlay), otherwise the push sidebar breaks the layout.
    const sidebarSize = document.documentElement.clientWidth <= 768 ? 'full' : prefs.sidebar_size;
    this.store.dispatch(changesidebarsize({ size: sidebarSize }));

    // Font family & size — set both the CSS var AND the actual body styles
    // so Bootstrap/components that don't use the var still pick up the change.
    // In minimal the skin's native system stack owns typography: inline
    // overrides would beat the scoped token, so they're cleared instead.
    const minimal = root.getAttribute("data-po-ui") === "minimal";
    if (minimal) {
      root.style.removeProperty("--po-font-body");
      document.body.style.removeProperty("font-family");
    } else {
      const fontStack = `"${prefs.font_family}", system-ui, sans-serif`;
      root.style.setProperty("--po-font-body", fontStack);
      document.body.style.fontFamily = fontStack;
    }
    root.style.setProperty("--po-text-base", `${prefs.font_size / 16}rem`);
    document.body.style.fontSize = `${prefs.font_size}px`;

    // Terminal
    root.style.setProperty("--po-terminal-font", `"${prefs.terminal_font_family}", ui-monospace, monospace`);
    root.style.setProperty("--po-terminal-font-size", `${prefs.terminal_font_size}px`);
    root.style.setProperty("--po-terminal-line-height", `${prefs.terminal_line_height}`);
    root.style.setProperty("--po-terminal-cursor", prefs.terminal_cursor_style);
    // Open terminals re-apply font/size/line height live.
    window.dispatchEvent(new Event(TERMINAL_PREFS_EVENT));

    // Push the background-detection toggles to the native side so the
    // tail pipeline (pattern matching + tail file) adopts them on live
    // terminals. Renderer-side toggles (GPU/links/cursor) are read directly by
    // the terminal components via __PO_UI_PREFS__ above.
    // "Safe terminal" (Windows-only): when on, force ALL background detection
    // off regardless of the individual toggles. On macOS/Linux `safe` is always
    // false → the individual flags apply exactly as before (no behavior change).
    const safe = isWindowsDesktop() && !!prefs.terminal_safe_mode;

    // Default Windows shell → native (Tauri v2): fallback for sessions
    // without a per-session override, applied on every spawn/wake/restore.
    // Guarded on the method: older builds don't expose it.
    const desktopApi = (window as any).promptops;
    if (isWindowsDesktop() && typeof desktopApi?.setDefaultTerminalShell === "function") {
      Promise.resolve(
        desktopApi.setDefaultTerminalShell(prefs.terminal_default_shell || "powershell")
      ).catch(() => { /* best-effort */ });
    }

    // Publish the resolved (already Windows-gated) safe flag so the session view
    // (post-switch reflow nudge) and the git-status pollers can skip their work
    // synchronously. Never true off-Windows → those paths are untouched there.
    (window as any).__PO_SAFE_TERMINAL__ = safe;

    const api = (window as any).promptops;
    if (api?.setTerminalDetection) {
      api.setTerminalDetection(
        safe
          ? { commandDetection: false, inputDetection: false, activityTail: false }
          : {
              commandDetection: prefs.terminal_command_detection,
              inputDetection: prefs.terminal_input_detection,
              activityTail: prefs.terminal_activity_tail,
            },
      ).catch(() => { /* main process not ready / older build — ignore */ });
    }
    // Pause/resume the tailer poll loop (main process hard-gates on Windows too).
    if (api?.setTerminalSafeMode) {
      api.setTerminalSafeMode(safe).catch(() => { /* older build — ignore */ });
    }
    // Agents in the separate terminal host (desktop v2 beta). Safe terminal turns it off.
    if (api?.setTerminalPersistentAgents) {
      api.setTerminalPersistentAgents(!safe && prefs.terminal_persistent_agents !== false)
        .catch(() => { /* older build — ignore */ });
    }
    // Host-kept terminal screens (desktop v2). Safe terminal turns it off too.
    if (api?.setTerminalHostScreen) {
      api.setTerminalHostScreen(!safe && prefs.terminal_host_screen !== false)
        .catch(() => { /* older build — ignore */ });
    }
  }

  /** Last applied prefs — lets the style switcher re-run apply() so the
   *  font ownership (skin vs preference) follows the active skin. */
  private lastApplied: ResolvedUiPreferences | null = null;

  reapply(): void {
    if (this.lastApplied) this.apply(this.lastApplied);
  }

  /** Load user prefs from store and apply them. Call once at app bootstrap. */
  init(): void {
    this.store.select(getUser).subscribe((user) => {
      if (user) {
        const prefs = this.resolve(user.ui_preferences);
        this.apply(prefs);
      }
    });
  }
}
