/**
 * Storage for the Settings → App toggles. Kept apart from `AppSettingsTab` so
 * startup code can read a preference (auto-updates) without importing the
 * settings UI.
 */
const STORAGE_KEY = "thewired_app_settings";

export interface AppSettings {
  sidebarDefaultExpanded: boolean;
  memberListDefaultVisible: boolean;
  autoUpdates: boolean;
  developerMode: boolean;
}

const defaults: AppSettings = {
  sidebarDefaultExpanded: true,
  memberListDefaultVisible: true,
  autoUpdates: true,
  developerMode: false,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Read whether auto-updates are enabled (for use outside settings UI) */
export function getAutoUpdatesEnabled(): boolean {
  return loadSettings().autoUpdates;
}
