import { getUsername } from './auth';

export type Theme = 'system' | 'light' | 'dark';

export interface UserSettings {
  theme: Theme;
  personality: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  personality: '',
};

function storageKey(): string {
  return `frio.settings.${getUsername() ?? 'guest'}.v1`;
}

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return {
      theme:
        parsed.theme === 'light' || parsed.theme === 'dark'
          ? parsed.theme
          : 'system',
      personality: typeof parsed.personality === 'string' ? parsed.personality : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(settings));
  } catch {
    /* give up silently */
  }
}
