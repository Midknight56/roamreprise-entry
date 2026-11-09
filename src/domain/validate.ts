import { toMinutes } from './clock';
import { travelMinutes, travelMode } from './geo';
import { airportTransfer, offer } from './offers';
import { MIN_SLACK_MIN, slots } from './slots';
import type { Checks, Item, Itinerary, IssueCode, ReservationState } from './types';

export const reservationStates: ReservationState[] = ['planned', 'held', 'confirmed', 'failed', 'released', 'cancelled', 'replaced'];
export const isActive = (item: Item): boolean => !['released', 'cancelled', 'replaced'].includes(item.state);
/** The stay spans nights; only its 20 minute check-in occupies the travel chain. */
export const eventEnd = (item: Item): number => item.slot === 'd1-checkin' ? toMinutes(item.start) + 20 : toMinutes(item.end);
export const incomingPlace = (item: Item, hotelPlace: string): string => item.offerId === 't-depart' ? hotelPlace : item.offerId === 't-arrive' ? 'lis' : item.placeId;
export function orderedItems(itinerary: Itinerary): Item[] {
  const order = new Map(slots.map((s, i) => [s.id, i]));
  return itinerary.items.filter(isActive).slice().sort((a, b) => a.day - b.day ||
    (order.get(a.slot) ?? 100) - (order.get(b.slot) ?? 100) || toMinutes(a.start) - toMinutes(b.start));
}
export function totalCents(items: Item[]): number {
  return items.filter(i => isActive(i) && i.booked).reduce((sum, i) => sum + i.priceCents, 0);
}
export function validateSchedule(itinerary: Itinerary, ceilingCents: number): Checks {
  const issues: Checks['issues'] = [];
  const add = (code: IssueCode, message: string, itemId?: string) => issues.push({ code, message, ...(itemId ? { itemId } : {}) });
  let hotel;
  try { hotel = offer(itinerary.hotelId); } catch { add('CHECKIN', 'The hotel is missing.'); }
  if (hotel?.kind !== 'lodging') add('CHECKIN', 'Choose a hotel.');
  if (hotel && !hotel.available) add('AVAILABILITY', 'No rooms (simulated inventory).');
  for (const i of itinerary.items) {
    if (!reservationStates.includes(i.state)) add('STATE', 'Unknown reservation state.', i.id);
  }
  const active = orderedItems(itinerary), seen = new Set<string>();
  for (const slot of slots.filter(s => !s.optional)) {
    if (!active.some(i => i.slot === slot.id) && !itinerary.items.some(i => i.slot === slot.id && i.state === 'cancelled')) {
      add('DAY_WINDOW', 'A required trip slot is missing.', slot.id);
    }
  }
  for (const i of active) {
    let fixture;
    try {
      fixture = i.offerId === 't-arrive' || i.offerId === 't-depart'
        ? airportTransfer(i.offerId, hotel!.placeId) : offer(i.offerId);
    } catch { add('PRICE_MATCH', 'Unknown fixture.', i.id); continue; }
    const checkout = i.slot === 'd2-checkout';
    if (fixture.kind !== i.kind || fixture.placeId !== i.placeId ||
      i.priceCents !== (checkout ? 0 : fixture.priceCents) || i.booked === checkout) {
      add('PRICE_MATCH', 'The item must match its fixture.', i.id);
    }
    if (!checkout) {
      if (seen.has(i.offerId)) add('DUPLICATE', 'Use each offer once.', i.id);
      seen.add(i.offerId);
    }
    if (!fixture.days.includes(i.day)) add('DAYS', 'This offer does not run that day.', i.id);
    let start: number, end: number;
    try { start = toMinutes(i.start); end = eventEnd(i); } catch { add('DAY_WINDOW', 'Use a valid local time.', i.id); continue; }
    if ((i.day !== 0 && i.day !== 1) || (i.day === 0 && start < 630) || end > 1439 || end <= start) add('DAY_WINDOW', 'The item is outside the trip day.', i.id);
    if (fixture.kind === 'lodging') {
      if (i.offerId !== itinerary.hotelId || (checkout ? i.day !== 1 || end > 660 || end - start !== 15 :
        i.slot !== 'd1-checkin' || i.day !== 0 || start < 900)) add('CHECKIN', 'Check hotel arrival and checkout times.', i.id);
    } else if (start < toMinutes(fixture.opens) || end > toMinutes(fixture.closes) || end - start !== fixture.minutes) {
      add('OPEN_HOURS', 'Keep the full visit inside opening hours.', i.id);
    }
    if (i.offerId === 't-arrive' && (i.day !== 0 || start < 645)) add('DAY_WINDOW', 'The arrival car starts at 10:45 or later.', i.id);
    if (i.offerId === 't-depart' && (i.day !== 1 || end > 1020)) add('DAY_WINDOW', 'Reach LIS by 17:00.', i.id);
  }
  const checkin = active.find(i => i.slot === 'd1-checkin'), checkout = active.find(i => i.slot === 'd2-checkout');
  if (!checkin || !checkout || checkin.end !== checkout.start) add('CHECKIN', 'One stay must link check-in to checkout.');
  if (!active.some(i => i.offerId === 't-arrive') || !active.some(i => i.offerId === 't-depart')) add('DAY_WINDOW', 'Both airport cars are required.');
  // Pairwise overlap uses check-in/check-out events, never the overnight stay bar.
  for (let n = 0; n < active.length; n++) {
    const i = active[n];
    try {
      for (const other of active.slice(0, n)) {
        if (i.day === other.day && toMinutes(i.start) < eventEnd(other) && toMinutes(other.start) < eventEnd(i)) add('OVERLAP', 'Items overlap.', i.id);
      }
      const prev = active[n - 1];
      const sameDay = prev?.day === i.day;
      const destination = incomingPlace(i, hotel!.placeId);
      const buffer = sameDay ? travelMinutes(prev.placeId, destination) : 0;
      const mode = i.kind === 'transfer' ? 'car' : sameDay ? travelMode(prev.placeId, destination) : 'none';
      if (i.bufferMin !== buffer || i.travelMode !== mode || (sameDay && toMinutes(i.start) < eventEnd(prev) + buffer + MIN_SLACK_MIN)) add('BUFFER', 'Keep travel time and ten minutes of slack.', i.id);
    } catch { add('BUFFER', 'The route or time is invalid.', i.id); }
  }
  const total = totalCents(active);
  if (!Number.isSafeInteger(total) || total !== itinerary.totalCents) add('PRICE_MATCH', 'The quote must equal the booked total.');
  if (!Number.isSafeInteger(ceilingCents) || ceilingCents < 0 || total > ceilingCents) add('CEILING', 'The total is over the ceiling.');
  return { ok: issues.length === 0, issues };
}
