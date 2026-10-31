// The runtime version comes from the native bridge (window.promptops.appVersion).
// The literal below is only a fallback; keep it equal to tauri.conf.json.
export const APP_VERSION =
  (typeof window !== "undefined" && (window as any).promptops?.appVersion) ||
  "2.2.0-beta.0";
