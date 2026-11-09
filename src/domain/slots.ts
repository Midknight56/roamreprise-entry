import type { Slot } from './types';
export const MIN_SLACK_MIN = 10;
export const slots: Slot[] = [
  { id: 'd1-arrive', day: 0, kind: 'transfer', targetStart: '10:45' },
  { id: 'd1-lunch', day: 0, kind: 'meal', targetStart: '12:30' },
  { id: 'd1-pm', day: 0, kind: 'activity', targetStart: '14:15' },
  { id: 'd1-checkin', day: 0, kind: 'lodging', targetStart: '16:30' },
  { id: 'd1-late', day: 0, kind: 'activity', targetStart: '17:15', optional: true },
  { id: 'd1-dinner', day: 0, kind: 'meal', targetStart: '20:00' },
  { id: 'd2-checkout', day: 1, kind: 'lodging', targetStart: '09:00' },
  { id: 'd2-am', day: 1, kind: 'activity', targetStart: '09:45' },
  { id: 'd2-lunch', day: 1, kind: 'meal', targetStart: '12:45' },
  { id: 'd2-pm', day: 1, kind: 'activity', targetStart: '14:15', optional: true },
  { id: 'd2-depart', day: 1, kind: 'transfer', targetStart: '16:00' },
];
export const SLOTS = slots;
export const SLOT_LABELS: Record<string, string> = {
  'd1-arrive': 'Day 1 arrival', 'd1-lunch': 'Day 1 lunch', 'd1-pm': 'Day 1 afternoon',
  'd1-checkin': 'Day 1 check-in', 'd1-late': 'Day 1 evening', 'd1-dinner': 'Day 1 dinner',
  'd2-checkout': 'Day 2 checkout', 'd2-am': 'Day 2 morning', 'd2-lunch': 'Day 2 lunch',
  'd2-pm': 'Day 2 afternoon', 'd2-depart': 'Day 2 departure',
};
export const slotLabel = (id: string): string => SLOT_LABELS[id] ?? 'this time slot';
