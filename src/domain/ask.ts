import { fromMinutes, toMinutes } from './clock';
import { offer } from './offers';
import { scheduleSelection, type SlotCandidates } from './planner';
import { selectionOf } from './repair';
import { slotLabel, slots } from './slots';
import type { Issue, Item, Itinerary } from './types';
import { eventEnd, isActive, orderedItems, validateSchedule } from './validate';

/** Exactly one change. Nothing else (a price, a payment field, a second change) can ride along. */
export type AskChange = { slot: string; offerId: string } | { slot: string; shiftMinutes: number };
export type AskResult =
  | { ok: true; itinerary: Itinerary; slot: string; slotLabel: string; from: string; to: string; totalCents: number; dropped: string[] }
  | { ok: false; message: string };
export const SHIFT_LIMIT_MIN = 60;
export const SHIFT_STEP_MIN = 15;
export const RULE_SHIFT_MIN = 30;

/** Whitelist one parsed value: its slot is listed, its offer is in that slot's list, its shift is bounded. */
export function checkChange(raw: unknown, options: SlotCandidates): AskChange | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>, keys = Object.keys(value).sort().join();
  if (typeof value.slot !== 'string' || !Object.hasOwn(options, value.slot)) return null;
  if (keys === 'offerId,slot') {
    return typeof value.offerId === 'string' && options[value.slot].some(o => o.id === value.offerId) ? { slot: value.slot, offerId: value.offerId } : null;
  }
  if (keys === 'shiftMinutes,slot') {
    const n = value.shiftMinutes;
    return typeof n === 'number' && Number.isInteger(n) && n !== 0 && Math.abs(n) <= SHIFT_LIMIT_MIN && n % SHIFT_STEP_MIN === 0 ? { slot: value.slot, shiftMinutes: n } : null;
  }
  return null;
}
export function parseAsk(text: string, options: SlotCandidates): AskChange | null {
  let raw: unknown; try { raw = JSON.parse(text); } catch { return null; }
  return checkChange(raw, options);
}

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const withoutArticle = (text: string) => text.replace(/^(?:the|a|an|some|my)\s+/, '');
/** Find the planned stop named in a swap request using the rule parser's "from" matching. */
export function namedSlot(text: string, itinerary: Itinerary, options: SlotCandidates): string | null {
  const said = words(text), swap = /\b(?:swap|replace|change)\s+(.+?)\s+(?:for|with)\s+(.+)$/.exec(said);
  if (!swap) return null;
  const from = withoutArticle(swap[1]);
  if (!from) return null;
  const item = orderedItems(itinerary).filter(i => Object.hasOwn(options, i.slot))
    .find(i => words(i.name).includes(from) || offer(i.offerId).tags.includes(from) || words(slotLabel(i.slot)) === from);
  return item?.slot ?? null;
}
/** A small rule parser for plain phrases. It runs when no AI answer is usable. */
export function ruleAsk(text: string, itinerary: Itinerary, options: SlotCandidates): AskChange | null {
  const said = words(text), planned = orderedItems(itinerary).filter(i => Object.hasOwn(options, i.slot));
  const swap = /\b(?:swap|replace|change)\s+(.+?)\s+(?:for|with)\s+(.+)$/.exec(said);
  if (swap) {
    const from = withoutArticle(swap[1]), wanted = withoutArticle(swap[2]);
    if (!from || !wanted) return null;
    const item = planned.find(i => words(i.name).includes(from) || offer(i.offerId).tags.includes(from) || words(slotLabel(i.slot)) === from);
    if (!item) return null;
    const others = options[item.slot].filter(o => o.id !== item.offerId);
    const pick = others.find(o => o.tags.some(tag => tag === wanted || (wanted.length >= 4 && tag.includes(wanted)))) ?? others.find(o => words(o.name).includes(wanted));
    return pick ? checkChange({ slot: item.slot, offerId: pick.id }, options) : null;
  }
  if (/\b(?:slower|later|sleep in)\b/.test(said)) {
    const sunday = /\b(?:sunday|day (?:2|two))\b/.test(said), saturday = /\b(?:saturday|day (?:1|one))\b/.test(said);
    if (sunday === saturday) return null;
    const item = planned.find(i => i.kind === 'activity' && i.day === (sunday ? 1 : 0));
    return item ? checkChange({ slot: item.slot, shiftMinutes: RULE_SHIFT_MIN }, options) : null;
  }
  return null;
}

const priority: Issue['code'][] = ['CEILING', 'DAY_WINDOW', 'OPEN_HOURS', 'OVERLAP', 'BUFFER', 'DUPLICATE'];
const kept = (what: string) => `${what}, so I kept the plan.`;
const rank = (code: Issue['code']) => { const at = priority.indexOf(code); return at < 0 ? priority.length : at; };
function plain(issues: Issue[], itinerary: Itinerary): string {
  const issue = [...issues].sort((a, b) => rank(a.code) - rank(b.code))[0];
  const name = itinerary.items.find(i => i.id === issue.itemId)?.name;
  switch (issue.code) {
    case 'CEILING': return kept('That would put the total over your ceiling');
    case 'OPEN_HOURS': return kept(`${name ?? 'A stop'} would run outside its opening hours`);
    case 'OVERLAP': return kept('That would make two stops overlap');
    case 'BUFFER': return kept('That would leave too little time to travel between stops');
    case 'DAY_WINDOW': return kept(issue.itemId === 'd2-depart' ? 'That would not leave time to reach the airport by 17:00' : 'That would push a stop outside the trip day');
    case 'DUPLICATE': return kept('That place is already in your plan');
    default: return kept('That would not pass the schedule checks');
  }
}
/** Why a shifted stop could not start exactly where it was asked to, in words. */
function whyNotThere(old: Item, wanted: number, next: Itinerary): string {
  const fixture = offer(old.offerId);
  if (wanted < toMinutes(fixture.opens)) return kept(`${old.name} opens at ${fixture.opens}`);
  const ahead = orderedItems(next).filter(i => i.day === old.day && toMinutes(i.start) < toMinutes(old.start) && i.slot !== old.slot).at(-1);
  if (!ahead) return kept('That would not pass the schedule checks');
  const gap = wanted - eventEnd(ahead);
  return gap <= 0 ? kept(`That would overlap the stop before ${old.name}`) : kept(`That would leave ${gap} minute${gap === 1 ? '' : 's'} to reach ${old.name}`);
}

/**
 * Apply one checked change through scheduleSelection, then run every schedule check.
 * Optional stops that no longer fit are left out, as the planner already does. The input is never changed.
 */
export function applyAsk(itinerary: Itinerary, change: AskChange, ceilingCents: number, options: SlotCandidates): AskResult {
  const fail = (message: string): AskResult => ({ ok: false, message });
  const checked = checkChange(change, options), old = itinerary.items.find(i => i.slot === change.slot && isActive(i));
  if (!checked || !old) return fail(kept('I could not find that stop'));
  const selection = selectionOf(itinerary);
  let baseline = itinerary, wanted: number | undefined;
  if ('offerId' in checked) {
    if (selection[checked.slot] === checked.offerId) return fail('That is already in your plan, so nothing changed.');
    selection[checked.slot] = checked.offerId;
  } else {
    wanted = toMinutes(old.start) + checked.shiftMinutes;
    if (wanted < 0 || wanted >= 1440) return fail(kept('That would push a stop outside the trip day'));
    baseline = { ...itinerary, items: itinerary.items.map(i => i === old ? { ...i, start: fromMinutes(wanted!) } : i) };
  }
  const rebuilt = scheduleSelection(itinerary.hotelId, selection, itinerary.version + 1, baseline);
  const required = rebuilt.dropped.filter(id => id === change.slot || !slots.find(s => s.id === id)?.optional);
  if (required.length) return fail(kept(required[0] === 'd2-pm' ? 'That would not leave time to reach the airport by 17:00' : `${slotLabel(required[0])} would no longer fit with its travel time or opening hours`));
  const next = rebuilt.itinerary, moved = next.items.find(i => i.slot === change.slot);
  if (!moved) return fail(kept(`${slotLabel(change.slot)} would no longer fit with its travel time`));
  if (wanted !== undefined && toMinutes(moved.start) !== wanted) return fail(whyNotThere(old, wanted, next));
  const checks = validateSchedule(next, ceilingCents);
  if (!checks.ok) return fail(plain(checks.issues, next));
  next.items = next.items.map(i => {
    const before = itinerary.items.find(p => p.slot === i.slot && isActive(p));
    return before?.why && before.offerId === i.offerId ? { ...i, why: before.why } : i;
  });
  return { ok: true, itinerary: next, slot: change.slot, slotLabel: slotLabel(change.slot), totalCents: next.totalCents,
    from: wanted === undefined ? old.name : old.start, to: wanted === undefined ? moved.name : moved.start,
    dropped: rebuilt.dropped.map(slotLabel) };
}
