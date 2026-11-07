import { useSyncExternalStore } from 'react';

export interface Settings { timezone: string; density: 'comfortable' | 'compact'; pageSize: number }
export const DEFAULTS: Settings = { timezone: 'Europe/Zurich', density: 'comfortable', pageSize: 25 };
const KEY = 'runtrace.settings';

function read(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* the preference lasts for this tab only */ }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => current);
}

export const TIMEZONES = ['Europe/Zurich', 'UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore', 'Asia/Tokyo'];
export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
