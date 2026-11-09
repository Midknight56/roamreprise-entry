import type { Item, ReservationState } from './types';
export const allowedTransitions: Record<ReservationState, ReservationState[]> = {
  planned: ['held', 'replaced'], held: ['confirmed', 'failed', 'released', 'replaced'],
  confirmed: ['cancelled', 'replaced'], failed: ['replaced'], cancelled: ['replaced'], released: [], replaced: [],
};
export function transition(item: Item, to: ReservationState): Item {
  if (!allowedTransitions[item.state]?.includes(to)) throw Object.assign(new Error(`STATE: Cannot move ${item.state} to ${to}.`), { code: 'STATE' });
  return { ...item, state: to };
}
