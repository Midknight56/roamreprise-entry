import { cleanPreferences, checkoutFor, type Preferences } from './preferences';
import { fromMinutes, toMinutes } from './clock';
import { travelMinutes, travelMode } from './geo';
import { activitiesAndMeals, airportTransfer, askAlternatives, hotels, offer } from './offers';
import { MIN_SLACK_MIN, slotLabel, slots } from './slots';
import { SUPPLIER, type AgentStep, type Item, type Itinerary, type Offer, type Slot } from './types';
import { eventEnd, orderedItems, totalCents, validateSchedule } from './validate';

export const DEFAULT_TASTES = ['tile art', 'fado music', 'viewpoints', 'food markets'];
export interface PlanInput { tastes: string[]; note: string; ceilingCents: number }
export interface Picks { hotelId?: string; slots?: Record<string, string> }
export type SlotCandidates = Record<string, Offer[]>;
const overlap = (o: Offer, tastes: string[]) => o.tags.filter(t => tastes.includes(t)).length;
const isDefault = (tastes: string[]) => new Set(tastes).size === DEFAULT_TASTES.length && DEFAULT_TASTES.every(t => tastes.includes(t));
// The demo reserves its hands-on class for Sunday and leaves a free viewpoint as the cancellation fallback.
const demoPicks: Record<string, string> = { 'd1-lunch': 'm-ribeira', 'd1-pm': 'a-tilemuseum', 'd1-late': 'a-castle', 'd1-dinner': 'm-fado', 'd2-am': 'a-tileclass', 'd2-lunch': 'm-chiado', 'd2-pm': 'a-tower' };
const LATEST_END: Record<string, number> = { 'd1-lunch': 855, 'd1-pm': 1020, 'd1-late': 1200, 'd2-am': 765, 'd2-lunch': 900 };
export function hotelCandidates(tastes: string[]): Offer[] {
  const matched = activitiesAndMeals.filter(o => overlap(o, tastes) > 0);
  const distance = (h: Offer) => matched.reduce((sum, o) => sum + travelMinutes(h.placeId, o.placeId), 0);
  return hotels.filter(h => h.available).slice().sort((a, b) => distance(a) - distance(b) || a.priceCents - b.priceCents || a.id.localeCompare(b.id));
}
function ranked(slot: Slot, tastes: string[], previousPlace: string, used: Set<string>, extras: Offer[] = []): Offer[] {
  return [...activitiesAndMeals, ...extras].filter(o => o.kind === slot.kind && o.days.includes(slot.day) && !used.has(o.id))
    .sort((a, b) => overlap(b, tastes) - overlap(a, tastes) || travelMinutes(previousPlace, a.placeId) - travelMinutes(previousPlace, b.placeId) || a.priceCents - b.priceCents || a.id.localeCompare(b.id));
}
function makeItem(slot: Slot, o: Offer, previous?: Item): Item | undefined {
  const sameDay = previous?.day === slot.day;
  const bufferMin = sameDay ? travelMinutes(previous.placeId, o.placeId) : 0;
  const start = Math.max(toMinutes(slot.targetStart), toMinutes(o.opens), sameDay ? eventEnd(previous) + bufferMin + MIN_SLACK_MIN : 0);
  const end = start + o.minutes;
  if (end > toMinutes(o.closes) || end >= 1440) return;
  return { id: slot.id, slot: slot.id, offerId: o.id, name: o.name, kind: o.kind, placeId: o.placeId, day: slot.day,
    start: fromMinutes(start), end: fromMinutes(end), bufferMin,
    travelMode: sameDay ? travelMode(previous.placeId, o.placeId) : 'none', priceCents: o.priceCents,
    booked: true, state: 'planned', supplier: SUPPLIER };
}
/** Rebuild a fixed offer selection. Used for repair without changing unaffected choices. */
export function scheduleSelection(hotelId: string, selection: Record<string, string>, version = 1, baseline?: Itinerary, prefs: Preferences = {}): { itinerary: Itinerary; dropped: string[] } {
  const h = offer(hotelId), items: Item[] = [], dropped: string[] = [];
  const oldCheckout = baseline?.items.find(i => i.slot === 'd2-checkout' && !['replaced', 'released', 'cancelled'].includes(i.state));
  const checkoutStart = oldCheckout?.start ?? checkoutFor(prefs);
  for (const skeleton of slots) {
    const old = baseline?.items.find(i => i.slot === skeleton.id && !['replaced', 'released', 'cancelled'].includes(i.state));
    const slot = old ? { ...skeleton, targetStart: old.start } : skeleton.id === 'd2-am' && prefs.startAfter ? { ...skeleton, targetStart: prefs.startAfter } : skeleton;
    if (prefs.pace === 'slow' && slot.optional) continue;
    const prev = items.at(-1);
    if (slot.id === 'd1-arrive') {
      const o = airportTransfer('t-arrive', h.placeId);
      items.push({ id: slot.id, slot: slot.id, offerId: o.id, kind: 'transfer', name: o.name, placeId: h.placeId, day: 0,
        start: slot.targetStart, end: fromMinutes(toMinutes(slot.targetStart) + o.minutes), bufferMin: 0, travelMode: 'car', priceCents: o.priceCents, booked: true, state: 'planned', supplier: SUPPLIER });
    } else if (slot.kind === 'lodging') {
      const checkout = slot.day === 1, buffer = checkout || !prev ? 0 : travelMinutes(prev.placeId, h.placeId);
      const start = checkout ? toMinutes(checkoutStart) : Math.max(toMinutes(slot.targetStart), 900, prev ? eventEnd(prev) + buffer + MIN_SLACK_MIN : 900);
      items.push({ id: slot.id, slot: slot.id, offerId: h.id, kind: 'lodging', name: checkout ? `${h.name} checkout` : h.name,
        placeId: h.placeId, day: slot.day, start: fromMinutes(start), end: checkout ? fromMinutes(start + 15) : checkoutStart,
        bufferMin: buffer, travelMode: checkout || !prev ? 'none' : travelMode(prev.placeId, h.placeId), priceCents: checkout ? 0 : h.priceCents,
        booked: !checkout, state: 'planned', supplier: SUPPLIER });
    } else if (slot.id === 'd2-depart') {
      const o = airportTransfer('t-depart', h.placeId), buffer = prev ? travelMinutes(prev.placeId, h.placeId) : 0;
      // A new hotel changes the bags stop and car route. Recompute its target instead of retaining the old car time.
      const target = baseline && baseline.hotelId !== hotelId ? skeleton.targetStart : slot.targetStart;
      const latestStart = 1020 - o.minutes;
      const start = Math.max(Math.min(toMinutes(target), latestStart), prev ? eventEnd(prev) + buffer + MIN_SLACK_MIN : 960);
      items.push({ id: slot.id, slot: slot.id, offerId: o.id, kind: 'transfer', name: o.name, placeId: 'lis', day: 1,
        start: fromMinutes(start), end: fromMinutes(start + o.minutes), bufferMin: buffer, travelMode: 'car', priceCents: o.priceCents, booked: true, state: 'planned', supplier: SUPPLIER });
    } else if (selection[slot.id]) {
      const item = makeItem(slot, offer(selection[slot.id]), prev);
      if (!item) { dropped.push(slot.id); continue; }
      if (slot.id === 'd1-late') {
        const dinner = selection['d1-dinner'] ? offer(selection['d1-dinner']) : undefined;
        if (dinner && eventEnd(item) + travelMinutes(item.placeId, dinner.placeId) + MIN_SLACK_MIN > Math.max(1200, toMinutes(dinner.opens))) { dropped.push(slot.id); continue; }
      }
      if (slot.id === 'd2-pm') {
        const transfer = airportTransfer('t-depart', h.placeId);
        if (eventEnd(item) + travelMinutes(item.placeId, h.placeId) + MIN_SLACK_MIN + transfer.minutes > 1020) { dropped.push(slot.id); continue; }
      }
      items.push(item);
    }
  }
  return { itinerary: { version, hotelId, items, totalCents: totalCents(items) }, dropped };
}
function choose(tastes: string[], hotelId: string, picks: Picks = {}, budget = false, prefs: Preferences = {}) {
  const h = offer(hotelId), used = new Set<string>(), selection: Record<string, string> = {}, candidates: SlotCandidates = {}, messages: string[] = [];
  for (const skeleton of slots) {
    const slot = skeleton.id === 'd2-am' && prefs.startAfter ? { ...skeleton, targetStart: prefs.startAfter } : skeleton;
    if (prefs.pace === 'slow' && slot.optional) { candidates[slot.id] = []; continue; }
    if (slot.kind === 'lodging' || slot.kind === 'transfer') continue;
    if (budget && slot.optional && !picks.slots?.[slot.id]) {
      candidates[slot.id] = [];
      messages.push(`Dropped ${slotLabel(slot.id)} to keep the quote within the ceiling.`);
      continue;
    }
    const partial = scheduleSelection(hotelId, selection, 1, undefined, prefs).itinerary;
    const previous = partial.items.filter(i => i.day === slot.day && slots.findIndex(s => s.id === i.slot) < slots.indexOf(skeleton)).at(-1);
    const previousPlace = previous?.placeId ?? h.placeId;
    // A morning/lunch slot cannot silently turn into a night event because it opens late.
    let list = ranked(slot, [...tastes, ...(prefs.prefer ?? [])], previousPlace, used).filter(o => {
      const item = makeItem(slot, o, previous);
      return item && eventEnd(item) <= (LATEST_END[slot.id] ?? 1439);
    });
    const allowed = list.filter(o => !o.tags.some(tag => prefs.avoid?.includes(tag)));
    if (allowed.length) list = allowed;
    list.sort((a, b) => overlap(b, prefs.prefer ?? []) - overlap(a, prefs.prefer ?? []));
    list = list.slice(0, 4);
    candidates[slot.id] = list;
    const requested = picks.slots?.[slot.id];
    let chosen = list.find(o => o.id === requested);
    if (requested && !chosen) messages.push(`Ignored pick ${requested} for ${slotLabel(slot.id)}: it is not a candidate.`);
    if (!chosen && !budget && isDefault(tastes) && !Object.keys(prefs).length) chosen = list.find(o => o.id === demoPicks[slot.id]);
    chosen ??= budget ? list.slice().sort((a, b) => a.priceCents - b.priceCents)[0] : list[0];
    if (chosen) { selection[slot.id] = chosen.id; used.add(chosen.id); }
    else if (slot.optional) messages.push(`Dropped ${slotLabel(slot.id)}: no offer fits the slot with its travel buffers.`);
  }
  return { selection, candidates, messages };
}
export function candidatesForSlots(tastes: string[], hotelId = hotelCandidates(tastes)[0].id): SlotCandidates {
  return choose(tastes, hotelId).candidates;
}
export function buildItinerary(input: PlanInput, picks: Picks = {}, rawPrefs: Preferences = {}): { itinerary: Itinerary; candidates: SlotCandidates; log: AgentStep[]; issues: import('./types').Issue[]; prefsRejected: boolean } {
  const prefs = cleanPreferences(rawPrefs);
  const rankedHotels = hotelCandidates(input.tastes), messages: string[] = [];
  let h = rankedHotels.find(h => h.id === picks.hotelId) ?? rankedHotels[0];
  if (picks.hotelId && h.id !== picks.hotelId) messages.push(`Ignored pick ${picks.hotelId}: it is not a hotel candidate.`);
  let chosen = choose(input.tastes, h.id, picks, false, prefs);
  messages.push(...chosen.messages);
  let result = scheduleSelection(h.id, chosen.selection, 1, undefined, prefs);
  for (const id of result.dropped) messages.push(`Dropped ${slotLabel(id)}: it cannot fit with the travel buffers.`);
  if (result.dropped.includes('d2-pm')) {
    for (const o of chosen.candidates['d2-pm'] ?? []) {
      const next = scheduleSelection(h.id, { ...chosen.selection, 'd2-pm': o.id }, 1, undefined, prefs);
      if (!next.dropped.includes('d2-pm') && validateSchedule(next.itinerary, input.ceilingCents).ok) {
        result = next;
        const id = 'd2-pm';
        const label = slotLabel(id);
        const placeName = offer(o.id).name;
        const swapLabel = `Swapped the ${label} to ${placeName} so the airport car leaves on time.`;
        const previousDrop = messages.findIndex(message => message.startsWith('Dropped ') && message.includes(label));
        if (previousDrop >= 0) messages.splice(previousDrop, 1);
        messages.push(swapLabel); break;
      }
    }
  }
  // The ceiling is enforced on the complete quote, never by changing fixture prices.
  if (result.itinerary.totalCents > input.ceilingCents) {
    const selection = { ...chosen.selection };
    for (const id of ['d1-late', 'd2-pm']) {
      delete selection[id];
      messages.push(`Dropped ${slotLabel(id)} to keep the quote within the ceiling.`);
      result = scheduleSelection(h.id, selection, 1, undefined, prefs);
      if (result.itinerary.totalCents <= input.ceilingCents) break;
    }
    if (result.itinerary.totalCents > input.ceilingCents) {
      for (const hotel of picks.hotelId === h.id ? [h] : rankedHotels) {
        const economical = choose(input.tastes, hotel.id, picks, true, prefs);
        const next = scheduleSelection(hotel.id, economical.selection, 1, undefined, prefs);
        if (validateSchedule(next.itinerary, input.ceilingCents).ok) {
          h = hotel; chosen = economical; result = next;
          messages.push('Used lower priced checked offers to keep the quote within the ceiling.', ...economical.messages);
          break;
        }
      }
    }
  }
  const checks = validateSchedule(result.itinerary, input.ceilingCents);
  if (!checks.ok && Object.keys(prefs).length) return { ...buildItinerary(input, picks), prefsRejected: true };
  const at = ''; // Pure engine: the caller stamps these steps with the actual execution time.
  const log: AgentStep[] = [
    { tool: 'read_trip_request', at, summary: `Read ${input.tastes.length} tastes and the spending ceiling.`, source: 'rule' },
    { tool: 'find_options', at, summary: 'Found checked simulated offers.', source: 'rule' },
    { tool: 'rank_options', at, summary: ['Applied the ranking rules to checked offers.', ...messages].join(' '), source: 'rule' },
    { tool: 'validate_schedule', at, summary: checks.ok ? 'The plan passes every schedule check.' : 'No complete plan fits these constraints.', source: 'rule' },
  ];
  return { itinerary: result.itinerary, candidates: chosen.candidates, log, issues: checks.issues, prefsRejected: false };
}

/** Every checked offer that can fill a planned activity or meal slot, for "Ask the agent". The current pick is listed too. */
export function askOptions(itinerary: Itinerary, tastes: string[]): SlotCandidates {
  const active = orderedItems(itinerary), options: SlotCandidates = {}, hotelPlace = offer(itinerary.hotelId).placeId;
  active.forEach((item, index) => {
    const skeleton = slots.find(s => s.id === item.slot);
    if (!skeleton || (item.kind !== 'activity' && item.kind !== 'meal')) return;
    const previous = active[index - 1]?.day === item.day ? active[index - 1] : undefined;
    const used = new Set(active.filter(i => i !== item).map(i => i.offerId)), slot = { ...skeleton, targetStart: item.start };
    const list = ranked(slot, tastes, previous?.placeId ?? hotelPlace, used, askAlternatives).filter(o => {
      const made = makeItem(slot, o, previous);
      return made && eventEnd(made) <= (LATEST_END[slot.id] ?? 1439);
    });
    if (!list.some(o => o.id === item.offerId)) list.unshift(offer(item.offerId));
    options[item.slot] = list;
  });
  return options;
}
