import { fromMinutes, toMinutes } from './clock';
export const TASTES = ['tile art', 'fado music', 'viewpoints', 'food markets', 'contemporary art', 'street art', 'coffee', 'history', 'river walks', 'live music'];
export interface Preferences { pace?: 'slow' | 'normal' | 'busy'; startAfter?: string; prefer?: string[]; avoid?: string[] }
export function cleanPreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>, prefs: Preferences = {};
  if (['slow', 'normal', 'busy'].includes(value.pace as string)) prefs.pace = value.pace as Preferences['pace'];
  if (typeof value.startAfter === 'string' && /^(09|10|11):(00|15|30|45)$/.test(value.startAfter) && value.startAfter <= '11:30') prefs.startAfter = value.startAfter;
  for (const key of ['prefer', 'avoid'] as const) {
    if (Array.isArray(value[key])) {
      const tags = [...new Set(value[key].filter((tag): tag is string => typeof tag === 'string' && TASTES.includes(tag)))];
      if (tags.length) prefs[key] = tags;
    }
  }
  return prefs;
}
export function rulePreferences(note: string): Preferences {
  const prefs: Preferences = {}, text = note.toLowerCase();
  if (/\b(slow mornings?|late start|sleep in)\b/.test(text)) prefs.startAfter = '10:30';
  if (/\b(slow|relaxed|easy)\b/.test(text)) prefs.pace = 'slow';
  else if (/\b(busy|packed)\b/.test(text)) prefs.pace = 'busy';
  const avoid = TASTES.filter(tag => new RegExp(`\\b(?:no|not)\\s+${tag}\\b`).test(text));
  if (avoid.length) prefs.avoid = avoid;
  return prefs;
}
export const checkoutFor = (prefs: Preferences) => prefs.startAfter ? fromMinutes(Math.max(540, toMinutes(prefs.startAfter) - 45)) : '09:00';
export function noteSummary(prefs: Preferences, rejected = false): string {
  if (rejected) return 'Read your note: the changes failed schedule checks, so the preferences were dropped.';
  const parts = [prefs.startAfter ? `Day 2 starts at ${prefs.startAfter}` : '', prefs.pace === 'slow' ? 'a relaxed pace with optional stops removed' : prefs.pace === 'busy' ? 'a busy pace with optional stops kept where they fit' : '', prefs.prefer?.length ? `prefer ${prefs.prefer.join(', ')}` : '', prefs.avoid?.length ? `avoid ${prefs.avoid.join(', ')}` : ''].filter(Boolean);
  return `Read your note: ${parts.length ? parts.join('; ') : 'nothing to change'}.`;
}
