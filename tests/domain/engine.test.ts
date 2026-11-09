import { describe, expect, test } from 'vitest';
import { addMinutes, compare, fromMinutes, toMinutes } from '../../src/domain/clock';
import { ceil5, haversineKm, travelCostCents, travelMinutes, travelMode } from '../../src/domain/geo';
import { activitiesAndMeals, airportTransfer, askAlternatives, hotels, offer } from '../../src/domain/offers';
import { places } from '../../src/domain/places';
import { buildItinerary, candidatesForSlots, DEFAULT_TASTES, hotelCandidates, scheduleSelection } from '../../src/domain/planner';
import { applyCandidate, repairFailedLeg, replanSlot } from '../../src/domain/repair';
import { allowedTransitions, transition } from '../../src/domain/reservations';
import { slots } from '../../src/domain/slots';
import { SimulatedSupplier } from '../../src/domain/supplier';
import { SUPPLIER, type Itinerary, type Item, type IssueCode, type PaymentAttempt, type Quote } from '../../src/domain/types';
import { eventEnd, isActive, totalCents, validateSchedule } from '../../src/domain/validate';
import { applyPayPalRead, blockedByUnknown, canCapture, canRefund, canVoid, refundableCents, toCents, toValue } from '../../src/domain/money';

const plan = () => buildItinerary({ tastes: [...DEFAULT_TASTES], note: '', ceilingCents: 60000 });
const itemAt = (p: Itinerary, slot: string): Item => p.items.find(i => i.slot === slot && isActive(i))!;
const booked = (): Item[] => plan().itinerary.items.map(i => ({ ...i, state: 'confirmed' }));
const now = '2027-03-13T12:00:00Z';
const quote = (): Quote => ({ version: 1, totalCents: plan().itinerary.totalCents, approvedAt: now });
const attempt = (state: PaymentAttempt['state'] = 'authorized'): PaymentAttempt => ({
  quoteVersion: 1, amountCents: quote().totalCents, method: 'card', state, orderId: 'ORDER', authorizationId: 'AUTH',
  expiresAt: '2027-03-14T12:00:00Z', refunds: [], receipts: [], ...(state === 'captured' ? { captureId: 'CAP' } : {}),
});
function assertBuffers(p: Itinerary) {
  const items = p.items.filter(isActive);
  for (let n = 1; n < items.length; n++) {
    const a = items[n - 1], b = items[n];
    if (a.day !== b.day) continue;
    const destination = b.offerId === 't-depart' ? offer(p.hotelId).placeId : b.placeId;
    expect(b.bufferMin).toBe(travelMinutes(a.placeId, destination));
    expect(toMinutes(b.start)).toBeGreaterThanOrEqual(eventEnd(a) + b.bufferMin + 10);
  }
}
describe('geography and fixtures', () => {
  test('known walk pair takes ten minutes and costs nothing', () => {
    expect(travelMode('alfama', 'castle')).toBe('walk');
    expect(travelMinutes('alfama', 'castle')).toBe(10);
    expect(travelCostCents('alfama', 'castle')).toBe(0);
  });
  test('known metro pair takes twenty minutes and costs two dollars', () => {
    expect(travelMode('ribeira', 'tilemuseum')).toBe('metro');
    expect(travelMinutes('ribeira', 'tilemuseum')).toBe(20);
    expect(travelCostCents('ribeira', 'tilemuseum')).toBe(200);
  });
  test('known taxi pair takes thirty minutes and uses the distance fare', () => {
    expect(travelMode('lis', 'alfama')).toBe('taxi');
    expect(travelMinutes('lis', 'alfama')).toBe(30);
    expect(travelCostCents('lis', 'alfama')).toBe(1515);
    expect(airportTransfer('t-arrive', 'alfama').priceCents).toBe(2900);
  });
  test('ceil5 rounds up with a minimum of five and same place takes zero', () => {
    expect([0, 1, 5, 5.01, 12].map(ceil5)).toEqual([5, 5, 5, 10, 15]);
    expect(travelMinutes('alfama', 'alfama')).toBe(0);
    expect(travelMode('alfama', 'alfama')).toBe('none');
    expect(haversineKm('lis', 'alfama')).toBeCloseTo(6.97, 1);
  });
  test('clock arithmetic rejects midnight overflow and malformed times', () => {
    expect(toMinutes('10:45')).toBe(645);
    expect(fromMinutes(645)).toBe('10:45');
    expect(addMinutes('10:45', 30)).toBe('11:15');
    expect(compare('12:00', '11:59')).toBe(1);
    for (const value of ['24:00', '9:00', '10:60', 'bad']) expect(() => toMinutes(value)).toThrow();
    expect(() => addMinutes('23:59', 1)).toThrow();
  });
  test('fixtures contain every place hotel visit and slot with simulation labels', () => {
    expect(places).toHaveLength(16); expect(hotels).toHaveLength(5); expect(activitiesAndMeals).toHaveLength(15); expect(askAlternatives).toHaveLength(1); expect(slots).toHaveLength(11);
    expect([...hotels, ...activitiesAndMeals, ...askAlternatives].every(o => o.supplier === SUPPLIER)).toBe(true);
    expect(offer('h-terraco').available).toBe(false);
    expect(offer('a-gulbenkian').days).toEqual([0]);
  });
});
describe('planning and checks', () => {
  test('default plan matches the frozen offers hotel and total and passes all checks', () => {
    const { itinerary, issues } = plan();
    expect(itinerary.hotelId).toBe('h-patio');
    expect(itemAt(itinerary, 'd1-lunch').offerId).toBe('m-ribeira');
    expect(['a-tilemuseum', 'a-castle']).toContain(itemAt(itinerary, 'd1-pm').offerId);
    expect(itemAt(itinerary, 'd1-dinner').offerId).toBe('m-fado');
    expect(itemAt(itinerary, 'd2-am').offerId).toBe('a-tileclass');
    expect(itinerary.totalCents).toBeGreaterThanOrEqual(38000); expect(itinerary.totalCents).toBeLessThanOrEqual(52000);
    expect(issues).toEqual([]); expect(validateSchedule(itinerary, 60000)).toEqual({ ok: true, issues: [] }); assertBuffers(itinerary);
    expect(itinerary.items.filter(i => i.kind === 'lodging' && i.booked)).toHaveLength(1);
  });
  test('contemporary art street art and coffee produce a different valid plan', () => {
    const p = buildItinerary({ tastes: ['contemporary art', 'street art', 'coffee'], note: 'quiet galleries', ceilingCents: 60000 });
    expect(p.issues).toEqual([]); expect(p.itinerary).not.toEqual(plan().itinerary); assertBuffers(p.itinerary);
    expect(p.itinerary.items.some(i => i.offerId === 'a-streetart')).toBe(true);
    expect(p.itinerary.items.some(i => i.offerId === 'm-coffee')).toBe(true);
  });
  test('candidate lists have at most four day eligible offers in the required rank order', () => {
    const lists = candidatesForSlots(DEFAULT_TASTES, 'h-patio');
    for (const slot of slots.filter(s => s.kind === 'activity' || s.kind === 'meal')) {
      expect(lists[slot.id].length).toBeLessThanOrEqual(4);
      expect(lists[slot.id].every(o => o.days.includes(slot.day) && o.kind === slot.kind)).toBe(true);
    }
    expect(hotelCandidates(DEFAULT_TASTES)[0].id).toBe('h-patio');
  });
  test('an invented AI pick is ignored and logged and a valid pick is used', () => {
    const input = { tastes: DEFAULT_TASTES, note: '', ceilingCents: 60000 };
    const bad = buildItinerary(input, { hotelId: 'fake-hotel', slots: { 'd1-lunch': 'fake-offer' } });
    expect(bad.log.some(l => l.summary.includes('Ignored pick fake-offer'))).toBe(true);
    expect(bad.log.some(l => l.summary.includes('Ignored pick fake-hotel'))).toBe(true);
    const good = buildItinerary(input, { slots: { 'd1-pm': 'a-castle' } });
    expect(itemAt(good.itinerary, 'd1-pm').offerId).toBe('a-castle'); expect(good.issues).toEqual([]);
  });
  test('single taste requests and every individual candidate pick keep a valid schedule', () => {
    const tastes = ['tile art', 'fado music', 'viewpoints', 'food markets', 'contemporary art', 'street art', 'coffee', 'history', 'river walks', 'live music'];
    for (const taste of tastes) {
      const p = buildItinerary({ tastes: [taste], note: '', ceilingCents: 60000 });
      expect(p.issues, `${taste}: ${JSON.stringify(p.itinerary)}`).toEqual([]);
    }
    const input = { tastes: DEFAULT_TASTES, note: '', ceilingCents: 60000 };
    for (const [slot, options] of Object.entries(candidatesForSlots(DEFAULT_TASTES))) for (const o of options) {
      const p = buildItinerary(input, { slots: { [slot]: o.id } });
      expect(p.issues, `${slot}: ${o.id}`).toEqual([]);
    }
  });
  test('a three hundred dollar ceiling uses cheaper fixtures without inventing prices', () => {
    const result = buildItinerary({ tastes: DEFAULT_TASTES, note: '', ceilingCents: 30000 });
    expect(result.issues).toEqual([]); expect(result.itinerary.totalCents).toBeLessThanOrEqual(30000);
    expect(result.log.some(l => l.summary.includes('lower priced'))).toBe(true); assertBuffers(result.itinerary);
  });
  const badCases: [IssueCode, (p: Itinerary) => void, number?][] = [
    ['BUFFER', p => { itemAt(p, 'd1-lunch').bufferMin = 0; }],
    ['OVERLAP', p => { itemAt(p, 'd1-lunch').start = '11:00'; }],
    ['OPEN_HOURS', p => { itemAt(p, 'd1-pm').end = '18:01'; }],
    ['DAY_WINDOW', p => { itemAt(p, 'd2-depart').end = '17:01'; }],
    ['CHECKIN', p => { itemAt(p, 'd1-checkin').start = '14:59'; }],
    ['PRICE_MATCH', p => { itemAt(p, 'd1-lunch').priceCents = 1; }],
    ['CEILING', () => {}, 1],
    ['DAYS', p => { const i = itemAt(p, 'd2-am'); i.offerId = 'a-gulbenkian'; }],
    ['DUPLICATE', p => { itemAt(p, 'd1-pm').offerId = itemAt(p, 'd2-am').offerId; }],
    ['STATE', p => { itemAt(p, 'd1-lunch').state = 'fake' as Item['state']; }],
  ];
  test.each(badCases)('%s fires on a hand built bad itinerary', (code, change, ceiling) => {
    const p = structuredClone(plan().itinerary); change(p);
    expect(validateSchedule(p, ceiling ?? 60000).issues.map(i => i.code)).toContain(code);
  });
  test('missing transfers wrong route duration and checkout after eleven are refused', () => {
    const p = plan().itinerary; p.items = p.items.filter(i => i.offerId !== 't-arrive');
    expect(validateSchedule(p, 60000).issues.some(i => i.code === 'DAY_WINDOW')).toBe(true);
    const q = plan().itinerary; itemAt(q, 'd2-checkout').end = '11:01';
    expect(validateSchedule(q, 60000).issues.some(i => i.code === 'CHECKIN')).toBe(true);
    const r = plan().itinerary; itemAt(r, 'd1-arrive').end = '11:00';
    expect(validateSchedule(r, 60000).issues.some(i => i.code === 'OPEN_HOURS')).toBe(true);
  });
});
describe('repair', () => {
  const failed = () => {
    const p = plan().itinerary;
    p.items = p.items.map(i => ({ ...i, state: i.slot === 'd1-checkin' ? 'failed' : 'held', supplierRef: 'SIM-ABC234' }));
    return p;
  };
  test('hotel repair rejects unavailable and expensive hotels and checks both viable hotels', () => {
    const p = failed(), before = structuredClone(p), repair = repairFailedLeg(p, 'd1-checkin', 60000);
    const find = (id: string) => repair.candidates.find(c => c.hotelId === id)!;
    expect(find('h-terraco').checks.issues.some(i => i.code === 'AVAILABILITY')).toBe(true);
    expect(find('h-avenida').checks.issues.some(i => i.code === 'CEILING')).toBe(true);
    expect(find('h-lumen').checks.ok).toBe(true); expect(find('h-riocalmo').checks.ok).toBe(true);
    expect(find('h-riocalmo').moves.length).toBeGreaterThanOrEqual(3);
    expect(find('h-lumen').moves.length).toBeGreaterThanOrEqual(0);
    expect(repair.pickId).toBe('h-riocalmo'); expect(repair.rulePickId).toBe('h-riocalmo');
    const rio = find('h-riocalmo');
    expect(rio.moves).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'd1-arrive', fromStart: '10:45', toStart: '10:45', fromEnd: '11:15', toEnd: '11:20' }),
      expect.objectContaining({ itemId: 'd1-late', fromStart: '17:15', toStart: '17:25' }),
      expect.objectContaining({ itemId: 'd2-depart', fromStart: '16:20', toStart: '16:05' }),
    ]));
    for (const c of repair.candidates) assertBuffers(c.itinerary);
    const ranked = repair.candidates.filter(c => c.checks.ok).sort((a, b) => a.newTotalCents - b.newTotalCents || a.moves.length - b.moves.length);
    expect(repair.pickId).toBe(ranked[0].id); expect(p).toEqual(before);
  });
  test('repair reports real time moves separately from price changes', () => {
    const p = failed(), repair = repairFailedLeg(p, 'd1-checkin', 60000);
    for (const candidate of repair.candidates) {
      for (const move of candidate.moves) expect(move.fromStart !== move.toStart || move.fromEnd !== move.toEnd).toBe(true);
      for (const change of candidate.repriced) {
        const old = p.items.find(i => i.id === change.itemId)!;
        const next = candidate.itinerary.items.find(i => i.id === change.itemId)!;
        expect(change).toEqual({ itemId: next.id, name: next.name, fromCents: old.priceCents, toCents: next.priceCents });
        expect(change.fromCents).not.toBe(change.toCents);
      }
    }
    const lumen = repair.candidates.find(c => c.id === 'h-lumen')!;
    expect(lumen.moves).toEqual([]);
    expect(lumen.repriced).toEqual([{ itemId: 'd1-checkin', name: 'Lumen Rooms', fromCents: 16800, toCents: 21400 }]);
    const rio = repair.candidates.find(c => c.id === 'h-riocalmo')!;
    expect(rio.repriced.map(i => i.itemId)).toEqual(['d1-arrive', 'd1-checkin', 'd2-depart']);
  });
  test('departure returns to the hotel for bags and uses the hotel airport duration and fare', () => {
    const p = failed(), repair = repairFailedLeg(p, 'd1-checkin', 60000);
    for (const itinerary of [p, ...repair.candidates.map(c => c.itinerary)]) {
      const hotel = offer(itinerary.hotelId), car = airportTransfer('t-depart', hotel.placeId);
      const departure = itemAt(itinerary, 'd2-depart'), last = itemAt(itinerary, 'd2-pm');
      expect(departure.bufferMin).toBe(travelMinutes(last.placeId, hotel.placeId));
      expect(toMinutes(departure.start)).toBeGreaterThanOrEqual(eventEnd(last) + departure.bufferMin + 10);
      expect(toMinutes(departure.end) - toMinutes(departure.start)).toBe(car.minutes);
      expect(departure.priceCents).toBe(car.priceCents);
      expect(toMinutes(departure.start)).toBeLessThanOrEqual(1020 - car.minutes);
      expect(toMinutes(departure.end)).toBeLessThanOrEqual(1020);
    }
  });
  test('a late Day Two activity is dropped or swapped with a log to preserve the hotel airport connection', () => {
    const input = { tastes: DEFAULT_TASTES, note: '', ceilingCents: 60000 };
    const result = buildItinerary(input, { slots: { 'd2-pm': 'a-streetart' } });
    expect(result.log.some(l => /Swapped the Day 2 afternoon to .+ so the airport car leaves on time\./.test(l.summary))).toBe(true);
    expect(itemAt(result.itinerary, 'd2-pm')?.offerId).not.toBe('a-streetart');
    expect(validateSchedule(result.itinerary, 60000).ok).toBe(true); assertBuffers(result.itinerary);
    const selection = Object.fromEntries(plan().itinerary.items.filter(i => i.kind === 'activity' || i.kind === 'meal').map(i => [i.slot, i.offerId]));
    const dropped = scheduleSelection('h-patio', { ...selection, 'd2-pm': 'a-streetart' });
    expect(dropped.dropped).toContain('d2-pm');
    expect(dropped.itinerary.items.some(i => i.slot === 'd2-pm')).toBe(false);
    expect(validateSchedule(dropped.itinerary, 60000).ok).toBe(true); assertBuffers(dropped.itinerary);
  });
  test('planner log names a swapped place and slot and removes the failed drop message', () => {
    const result = buildItinerary({ tastes: DEFAULT_TASTES, note: '', ceilingCents: 60000 }, { slots: { 'd2-pm': 'a-streetart' } });
    const swap = result.log.find(l => l.summary.includes('Swapped'))!.summary;
    expect(swap).toMatch(/Swapped the Day 2 afternoon to .+ so the airport car leaves on time\./);
    expect(result.log.some(l => /Dropped d2-pm|Swapped d2-pm|a-[\w-]+/.test(l.summary))).toBe(false);
  });
  test('planner ranking step never exposes raw slot ids and appears once', () => {
    const result = buildItinerary({ tastes: DEFAULT_TASTES, note: '', ceilingCents: 30000 });
    const ranking = result.log.filter(l => l.tool === 'rank_options');
    expect(ranking).toHaveLength(1);
    expect(ranking[0]).toMatchObject({ source: 'rule' });
    expect(/d[12]-/.test(ranking[0].summary)).toBe(false);
  });
  test('the full default story repairs the hotel then replans the cancelled class with a fifty eight dollar refund', () => {
    const supplier = new SimulatedSupplier('default-story');
    let itinerary = plan().itinerary;
    const check = () => { expect(validateSchedule(itinerary, 60000)).toEqual({ ok: true, issues: [] }); assertBuffers(itinerary); };
    check();
    itinerary.items = itinerary.items.map(i => i.booked ? supplier.hold(i) : i); check();
    supplier.flags.hotelUnavailable = true;
    itinerary.items = itinerary.items.map(i => i.booked && i.kind === 'lodging' ? supplier.confirm(i) : i); check();
    const failedHotel = itinerary.items.find(i => i.booked && i.kind === 'lodging' && i.state === 'failed')!;
    const repair = repairFailedLeg(itinerary, failedHotel.id, 60000);
    expect(repair.rulePickId).toBe('h-riocalmo');
    itinerary = applyCandidate(itinerary, repair.candidates.find(c => c.id === repair.rulePickId)!); check();
    supplier.flags.hotelUnavailable = false;
    itinerary.items = itinerary.items.map(i => isActive(i) && i.booked && i.state === 'planned' ? supplier.hold(i) : i); check();
    itinerary.items = itinerary.items.map(i => isActive(i) && i.booked ? supplier.confirm(i) : i); check();
    expect(itinerary.items.filter(i => isActive(i) && i.booked).every(i => i.state === 'confirmed')).toBe(true);
    const activity = itinerary.items.find(i => isActive(i) && i.offerId === 'a-tileclass')!;
    // Supplier cancellation and its checked replan form one itinerary action; publish only the repaired quote/buffers.
    const result = replanSlot({ ...itinerary, items: itinerary.items.map(i => i.id === activity.id ? supplier.cancel(i) : i) }, activity.id, 60000);
    expect(result.replacementOfferId).toBe('a-graca'); expect(result.refundCents).toBe(5800);
    itinerary = result.itinerary; check();
  });
  test('applying a candidate increments version archives the hotel and preserves unaffected items', () => {
    const p = failed(), c = repairFailedLeg(p, 'd1-checkin', 60000).candidates.find(c => c.id === 'h-lumen')!;
    const next = applyCandidate(p, c);
    expect(next.version).toBe(p.version + 1); expect(next.items.find(i => i.id === 'd1-checkin')?.state).toBe('replaced');
    expect(itemAt(next, 'd1-checkin').state).toBe('planned');
    for (const i of c.itinerary.items.filter(i => i.state === 'held')) expect(next.items.find(n => n.id === i.id)).toEqual(p.items.find(n => n.id === i.id));
    expect(validateSchedule(next, 60000).issues).toEqual([]); assertBuffers(next);
    expect(() => applyCandidate(p, { ...c, checks: { ok: false, issues: [] } })).toThrow();
    expect(() => applyCandidate({ ...p, version: 2 }, c)).toThrow('stale');
  });
  test('repair preserves a valid later booking time instead of resetting it to the skeleton', () => {
    const p = failed();
    Object.assign(itemAt(p, 'd1-lunch'), { start: '12:35', end: '13:50' });
    Object.assign(itemAt(p, 'd1-pm'), { start: '14:20', end: '15:50' });
    expect(validateSchedule(p, 60000).ok).toBe(true);
    const c = repairFailedLeg(p, 'd1-checkin', 60000).candidates.find(c => c.id === 'h-lumen')!;
    expect(c.checks.ok).toBe(true);
    expect(itemAt(applyCandidate(p, c), 'd1-pm')).toEqual(itemAt(p, 'd1-pm'));
  });
  test('a second hotel repair retains earlier reservation history and unique item ids', () => {
    const p = failed();
    const first = applyCandidate(p, repairFailedLeg(p, 'd1-checkin', 60000).candidates.find(c => c.id === 'h-lumen')!);
    const hotel = itemAt(first, 'd1-checkin'); hotel.state = 'failed';
    const second = applyCandidate(first, repairFailedLeg(first, hotel.id, 60000).candidates.find(c => c.id === 'h-riocalmo')!);
    expect(second.items.filter(i => i.state === 'replaced')).toHaveLength(2);
    expect(new Set(second.items.map(i => i.id)).size).toBe(second.items.length);
    expect(validateSchedule(second, 60000).ok).toBe(true);
  });
  test('cancelled tile class becomes the free Graca walk and refunds fifty eight dollars', () => {
    const p = plan().itinerary;
    p.items = p.items.map(i => ({ ...i, state: i.offerId === 'a-tileclass' ? 'cancelled' : 'confirmed' }));
    const before = structuredClone(p), result = replanSlot(p, 'd2-am', 60000);
    expect(result.replacementOfferId).toBe('a-graca'); expect(result.refundCents).toBe(5800);
    expect(itemAt(result.itinerary, 'd2-am').state).toBe('planned'); expect(result.checks).toEqual({ ok: true, issues: [] });
    expect(result.itinerary.items.find(i => i.id === 'd2-am')?.state).toBe('cancelled'); assertBuffers(result.itinerary); expect(p).toEqual(before);
  });
  test('an unavailable free replacement leaves the cancelled slot empty with a checked refund', () => {
    const p = buildItinerary({ tastes: DEFAULT_TASTES, note: '', ceilingCents: 60000 }, { slots: { 'd2-am': 'a-graca' } }).itinerary;
    itemAt(p, 'd2-am').state = 'cancelled';
    const result = replanSlot(p, 'd2-am', 60000);
    expect(result.replacementOfferId).toBeUndefined(); expect(result.refundCents).toBe(0);
    expect(result.checks.ok).toBe(true); assertBuffers(result.itinerary);
  });
});
describe('reservations and supplier', () => {
  test('every allowed reservation transition works without mutating the old item', () => {
    const original = itemAt(plan().itinerary, 'd1-checkin');
    expect(allowedTransitions).toEqual({
      planned: ['held', 'replaced'], held: ['confirmed', 'failed', 'released', 'replaced'],
      confirmed: ['cancelled', 'replaced'], failed: ['replaced'], cancelled: ['replaced'], released: [], replaced: [],
    });
    for (const [from, targets] of Object.entries(allowedTransitions)) for (const to of targets) {
      const i = { ...original, state: from as Item['state'] }; expect(transition(i, to).state).toBe(to); expect(i.state).toBe(from);
    }
  });
  test('three forbidden reservation transitions throw STATE', () => {
    const original = itemAt(plan().itinerary, 'd1-checkin');
    for (const [from, to] of [['planned', 'confirmed'], ['failed', 'held'], ['confirmed', 'released']] as const) expect(() => transition({ ...original, state: from }, to)).toThrow(/STATE/);
  });
  test('supplier refs are seeded stable distinct and labelled through the full lifecycle', () => {
    const p = plan().itinerary, a = new SimulatedSupplier('trip-one'), b = new SimulatedSupplier('trip-one');
    const held = a.hold(itemAt(p, 'd1-checkin'));
    expect(held.supplierRef).toMatch(/^SIM-[A-Z2-7]{6}$/); expect(held.supplierRef).toBe(b.hold(itemAt(p, 'd1-checkin')).supplierRef);
    expect(a.hold(itemAt(p, 'd1-lunch')).supplierRef).not.toBe(held.supplierRef);
    expect(a.confirm(held).supplier).toBe(SUPPLIER); expect(a.cancel(a.confirm(held)).state).toBe('cancelled'); expect(a.release(held).state).toBe('released');
  });
  test('supplier scenarios fail the hotel and cancel only the selected activity', () => {
    const supplier = new SimulatedSupplier('trip-two', { hotelUnavailable: true, cancelActivityId: 'a-tileclass' });
    const p = plan().itinerary;
    expect(supplier.confirm(supplier.hold(itemAt(p, 'd1-checkin'))).state).toBe('failed');
    const activity = supplier.confirm(supplier.hold(itemAt(p, 'd2-am')));
    expect(supplier.cancel(activity).state).toBe('cancelled');
    expect(() => supplier.cancel({ ...itemAt(p, 'd1-pm'), state: 'confirmed' })).toThrow('STATE');
  });
});
describe('money', () => {
  test('capture requires confirmed items an exact current quote and a live authorization', () => {
    const a = attempt(), items = booked(); expect(canCapture(a, items, quote(), now)).toBe(true);
    expect(canCapture(a, [{ ...items[0], state: 'held' }, ...items.slice(1)], quote(), now)).toBe(false);
    expect(canCapture(a, [{ ...items[0], state: 'released' }, ...items.slice(1)], quote(), now)).toBe(false);
    expect(canCapture({ ...a, amountCents: a.amountCents + 1 }, items, quote(), now)).toBe(false);
    expect(canCapture(a, items, { ...quote(), version: 2 }, now)).toBe(false);
    expect(canCapture({ ...a, expiresAt: now }, items, quote(), now)).toBe(false);
    expect(canCapture({ ...a, expiresAt: undefined }, items, quote(), now)).toBe(false);
    expect(canCapture({ ...a, state: 'unknown' }, items, quote(), now)).toBe(false);
  });
  test('unknown attempts block every write and void is refused after capture', () => {
    expect(blockedByUnknown([attempt(), attempt('unknown')])).toBe(true); expect(blockedByUnknown([attempt()])).toBe(false);
    expect(canVoid(attempt())).toBe(true); expect(canVoid(attempt('captured'))).toBe(false); expect(canVoid(attempt('unknown'))).toBe(false);
    expect(canRefund(attempt('unknown'), 100)).toBe(false);
  });
  test('refunds cannot exceed the captured remainder and pending refunds reserve funds', () => {
    const a = attempt('captured');
    expect(canRefund(a, a.amountCents + 1)).toBe(false); expect(canRefund(a, 0)).toBe(false); expect(canRefund(a, 1.5)).toBe(false);
    a.refunds = [{ id: 'R', amountCents: 5800, state: 'completed', reason: 'Cancelled tile class' }];
    expect(refundableCents(a)).toBe(a.amountCents - 5800);
    a.refunds.push({ amountCents: 1000, state: 'pending', reason: 'Cancelled item' });
    expect(refundableCents(a)).toBe(a.amountCents - 6800);
  });
  test('stale VOIDED and earlier order reads never move a captured payment backwards', () => {
    const a = attempt('captured'); const result = applyPayPalRead(a, 'authorization', { id: 'AUTH', status: 'VOIDED' });
    expect(result.state).toBe('captured'); expect(result.log?.join(' ')).toContain('VOIDED');
    expect(applyPayPalRead(result, 'order', { id: 'ORDER', status: 'CREATED' }).state).toBe('captured'); expect(a.log).toBeUndefined();
  });
  test('a completed authorize order reconciles to authorized rather than captured', () => {
    const a = attempt('unknown');
    const result = applyPayPalRead(a, 'order', { id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH', status: 'CREATED', expiration_time: '2027-03-14T12:00:00Z' }] } }] });
    expect(result.state).toBe('authorized'); expect(result.authorizationId).toBe('AUTH'); expect(blockedByUnknown([result])).toBe(false);
  });
  test('capture pending and completed reads reconcile forward and refund completion is separate', () => {
    expect(applyPayPalRead(attempt('unknown'), 'capture', { id: 'CAP', status: 'PENDING' }).state).toBe('capturing');
    const pending = applyPayPalRead(attempt(), 'capture', { id: 'CAP', status: 'PENDING' }); expect(pending.state).toBe('capturing');
    const captured = applyPayPalRead(pending, 'capture', { id: 'CAP', status: 'COMPLETED' }); expect(captured.state).toBe('captured');
    captured.refunds.push({ id: 'REF', amountCents: 5800, state: 'pending', reason: 'Cancelled tile class' });
    const refunded = applyPayPalRead(captured, 'refund', { id: 'REF', status: 'COMPLETED', amount: { currency_code: 'USD', value: '58.00' } });
    expect(refunded.refunds[0].state).toBe('completed'); expect(refunded.state).toBe('captured');
    expect(applyPayPalRead(refunded, 'refund', { id: 'REF', status: 'PENDING' }).refunds[0].state).toBe('completed');
  });
  test('mismatched resources currencies amounts and incomplete reads leave uncertainty blocked', () => {
    const a = attempt('unknown');
    for (const body of [null, {}, { id: 'OTHER', status: 'CREATED' }, { id: 'AUTH', status: 'CREATED', amount: { currency_code: 'EUR', value: '412.00' } }, { id: 'AUTH', status: 'CREATED', amount: { currency_code: 'USD', value: '0.01' } }]) {
      expect(applyPayPalRead(a, 'authorization', body).state).toBe('unknown');
    }
  });
  test('decimal amounts round trip without floating point arithmetic', () => {
    for (const value of ['0.10', '412.00', '1500.00', '0.01', '0.00']) expect(toValue(toCents(value))).toBe(value);
    for (const value of ['0.001', '-1.00', '1e2', 'Infinity', '1.1']) expect(() => toCents(value)).toThrow();
    expect(() => toValue(0.1)).toThrow(); expect(() => toValue(-1)).toThrow();
  });
  test('unknown refunds reconcile by their persisted amount and failed refunds release the reserved amount', () => {
    const a = attempt('captured');
    a.refunds = [{ amountCents: 5800, state: 'unknown', reason: 'Cancelled tile class' }];
    expect(blockedByUnknown([a])).toBe(true); expect(canRefund(a, 100)).toBe(false);
    const p = applyPayPalRead(a, 'refund', { id: 'R', status: 'PENDING', amount: { currency_code: 'USD', value: '58.00' } });
    expect(p.refunds[0]).toMatchObject({ id: 'R', state: 'pending' }); expect(blockedByUnknown([p])).toBe(false);
    const f = applyPayPalRead(p, 'refund', { id: 'R', status: 'FAILED' });
    expect(refundableCents(f)).toBe(f.amountCents);
    expect(applyPayPalRead(f, 'refund', { id: 'R', status: 'PENDING' }).refunds[0].state).toBe('failed');
    expect(applyPayPalRead(f, 'refund', { id: 'R', status: 'COMPLETED', amount: { currency_code: 'USD', value: 'bad' } }).refunds[0].state).toBe('failed');
  });
  test('authorization order and capture reads map every supported terminal status', () => {
    expect(applyPayPalRead(attempt('none'), 'order', { id: 'ORDER', status: 'CREATED' }).state).toBe('order_created');
    for (const [status, state] of [['VOIDED', 'voided'], ['DENIED', 'declined'], ['EXPIRED', 'expired'], ['CAPTURED', 'captured']] as const) {
      expect(applyPayPalRead(attempt('unknown'), 'authorization', { id: 'AUTH', status }).state).toBe(state);
    }
    for (const status of ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED']) expect(applyPayPalRead(attempt('unknown'), 'capture', { id: 'CAP', status }).state).toBe('captured');
    expect(applyPayPalRead(attempt('unknown'), 'capture', { id: 'CAP', status: 'DECLINED' }).state).toBe('declined');
    expect(applyPayPalRead(attempt('voided'), 'authorization', { id: 'AUTH', status: 'CREATED' }).state).toBe('voided');
  });
});
