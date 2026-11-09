import { activitiesAndMeals, hotels, offer } from './offers';
import { place } from './places';
import { scheduleSelection } from './planner';
import { isActive, totalCents, validateSchedule } from './validate';
import type { Candidate, Item, Itinerary, Move, Reprice } from './types';

export function selectionOf(itinerary: Itinerary): Record<string, string> {
  return Object.fromEntries(itinerary.items.filter(i => isActive(i) && (i.kind === 'activity' || i.kind === 'meal')).map(i => [i.slot, i.offerId]));
}
function movesBetween(old: Itinerary, next: Itinerary): Move[] {
  return next.items.filter(isActive).flatMap(i => {
    const prev = old.items.find(p => !['replaced', 'released'].includes(p.state) && (p.id === i.id || p.slot === i.slot));
    return prev && (prev.start !== i.start || prev.end !== i.end) ? [{ itemId: i.id, name: i.name, fromStart: prev.start, toStart: i.start, fromEnd: prev.end, toEnd: i.end, reason: 'Keep travel time and ten minutes of slack.' }] : [];
  });
}
/** Price changes are reported separately, even when the same item also changes time. */
function repricedBetween(old: Itinerary, next: Itinerary): Reprice[] {
  return next.items.filter(isActive).flatMap(i => {
    const prev = old.items.find(p => !['replaced', 'released'].includes(p.state) && (p.id === i.id || p.slot === i.slot));
    return prev && prev.priceCents !== i.priceCents
      ? [{ itemId: i.id, name: i.name, fromCents: prev.priceCents, toCents: i.priceCents }] : [];
  });
}
/** Preserve every byte of an unaffected reservation, including confirmation and supplier refs. */
function preserve(old: Itinerary, next: Itinerary): Itinerary {
  return { ...next, items: next.items.map(i => {
    const prev = old.items.find(p => isActive(p) && (p.id === i.id || p.slot === i.slot));
    if (!prev) return i;
    const changed = (['offerId', 'placeId', 'start', 'end', 'bufferMin', 'travelMode', 'priceCents'] as const).some(k => prev[k] !== i[k]);
    if (!changed) return { ...prev };
    const { supplierRef: _ref, ...rest } = i;
    return { ...rest, id: prev.id, state: 'planned' };
  }) };
}
export function repairFailedLeg(itinerary: Itinerary, failedItemId: string, ceilingCents: number) {
  const failed = itinerary.items.find(i => i.id === failedItemId);
  if (!failed || failed.kind !== 'lodging' || !failed.booked || !['failed', 'held', 'planned'].includes(failed.state)) throw Object.assign(new Error('STATE: Choose the failed hotel reservation.'), { code: 'STATE' });
  const candidates: Candidate[] = hotels.filter(h => h.id !== itinerary.hotelId).map(h => {
    const rebuilt = scheduleSelection(h.id, selectionOf(itinerary), itinerary.version, itinerary);
    const next = preserve(itinerary, rebuilt.itinerary);
    const checks = validateSchedule(next, ceilingCents);
    return { id: h.id, hotelId: h.id, name: h.name, area: place(h.placeId).area,
      priceDeltaCents: next.totalCents - itinerary.totalCents, newTotalCents: next.totalCents,
      moves: movesBetween(itinerary, next), repriced: repricedBetween(itinerary, next),
      dropped: rebuilt.dropped.map(slot => itinerary.items.find(i => i.slot === slot)?.id ?? slot), checks, itinerary: next };
  });
  const best = candidates.filter(c => c.checks.ok).sort((a, b) => a.newTotalCents - b.newTotalCents || a.moves.length - b.moves.length || a.id.localeCompare(b.id))[0];
  return { candidates, pickId: best?.id, rulePickId: best?.id };
}
export function applyCandidate(itinerary: Itinerary, candidate: Candidate): Itinerary {
  if (!candidate.checks.ok) throw new Error('Cannot apply a rejected candidate.');
  // Recompute from current state: a candidate from a different version must not overwrite the trip.
  if (candidate.itinerary.version !== itinerary.version) throw new Error('The candidate is stale.');
  const checked = repairFailedLeg(itinerary, itinerary.items.find(i => i.kind === 'lodging' && i.booked && isActive(i))!.id, candidate.newTotalCents).candidates.find(c => c.id === candidate.id);
  if (!checked?.checks.ok || JSON.stringify(checked.itinerary) !== JSON.stringify(candidate.itinerary)) throw new Error('The candidate does not match this trip.');
  const next = preserve(itinerary, checked.itinerary);
  const oldHotel = itinerary.items.find(i => i.kind === 'lodging' && i.booked && isActive(i))!;
  // The old row keeps its stable identity for receipt/history links. The new stay gets a new item id.
  next.items = next.items.map(i => i.id === oldHotel.id ? { ...i, id: `${oldHotel.slot}-v${itinerary.version + 1}`, state: 'planned' } : i);
  const activeIds = new Set(next.items.map(i => i.id));
  const history = itinerary.items.filter(i => !isActive(i) && !activeIds.has(i.id));
  next.items.push(...history.map(i => ({ ...i })), { ...oldHotel, state: 'replaced' });
  next.version = itinerary.version + 1;
  next.totalCents = totalCents(next.items);
  return next;
}
export function replanSlot(itinerary: Itinerary, cancelledItemId: string, ceilingCents: number) {
  const cancelled = itinerary.items.find(i => i.id === cancelledItemId);
  if (!cancelled || cancelled.kind !== 'activity' || cancelled.state !== 'cancelled') throw Object.assign(new Error('STATE: The supplier must cancel a confirmed activity first.'), { code: 'STATE' });
  const original = offer(cancelled.offerId), used = new Set(itinerary.items.filter(isActive).map(i => i.offerId));
  const options = activitiesAndMeals.filter(o => o.kind === 'activity' && o.id !== original.id && !used.has(o.id) && o.days.includes(cancelled.day) &&
    (o.priceCents === 0 || o.priceCents < cancelled.priceCents))
    .sort((a, b) => a.priceCents - b.priceCents || a.minutes - b.minutes || a.id.localeCompare(b.id));
  for (const o of options) {
    const selection = { ...selectionOf(itinerary), [cancelled.slot]: o.id };
    const rebuilt = scheduleSelection(itinerary.hotelId, selection, itinerary.version + 1, itinerary);
    if (rebuilt.dropped.length || !rebuilt.itinerary.items.some(i => i.slot === cancelled.slot)) continue;
    const next = preserve(itinerary, rebuilt.itinerary);
    next.items = next.items.map(i => i.slot === cancelled.slot ? { ...i, id: `${cancelled.slot}-v${next.version}`, state: 'planned' } : i);
    const ids = new Set(next.items.map(i => i.id));
    next.items.push(...itinerary.items.filter(i => !isActive(i) && !ids.has(i.id)).map(i => ({ ...i })));
    next.totalCents = totalCents(next.items);
    const checks = validateSchedule(next, ceilingCents);
    if (checks.ok) return { itinerary: next, replacementOfferId: o.id, refundCents: cancelled.priceCents - o.priceCents, moves: movesBetween(itinerary, next), checks };
  }
  // No checked replacement: leave the slot empty and refund the full cancelled price.
  const rebuilt = scheduleSelection(itinerary.hotelId, selectionOf(itinerary), itinerary.version + 1, itinerary);
  const next = preserve(itinerary, rebuilt.itinerary);
  const ids = new Set(next.items.map(i => i.id));
  next.items.push(...itinerary.items.filter(i => !isActive(i) && !ids.has(i.id)).map(i => ({ ...i })));
  next.totalCents = totalCents(next.items);
  return { itinerary: next, replacementOfferId: undefined, refundCents: cancelled.priceCents, moves: movesBetween(itinerary, next), checks: validateSchedule(next, ceilingCents) };
}
