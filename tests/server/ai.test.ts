import { describe, expect, test, vi } from 'vitest';
import { Agent, parseProposal, parseRepair } from '../../src/ai/agent';
import { MemoryLedger } from '../../src/ai/ledger';
import { BoundedModel } from '../../src/ai/model';
import { ACCOUNT_DAILY_NEURONS_GUARD, DAILY_NEURONS, DEPRECATED_MODELS, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, MODEL_ID } from '../../src/caps';
import { buildItinerary, candidatesForSlots, hotelCandidates } from '../../src/domain/planner';
import { repairFailedLeg } from '../../src/domain/repair';
import { MemoryGate, proposalKey } from '../../src/gate/engine';
import { repairReason, TripEngine, tripInput } from '../../src/trip/engine';
import { MemoryStore } from '../../src/trip/store';
import { ID, SID, input, world } from '../helpers/world';
const clock = () => new Date('2026-11-06T20:00:00Z');
describe('AI hard cap and honest fallback', () => {
  test('MODEL_ID is not deprecated', () => { expect(DEPRECATED_MODELS).not.toContain(MODEL_ID); expect(MODEL_ID).toBe('@cf/ibm-granite/granite-4.0-h-micro'); });
  test('chat messages are bounded and actual neurons settle the reservation', async () => {
    const ledger = new MemoryLedger();
    const ai = { run: vi.fn(async (model: string, request: {messages: {role: string; content: string}[]; response_format: {type: string}; max_tokens: number}) => {
      expect(ledger.rows[0].neurons).toBe(15); expect(model).toBe(MODEL_ID);
      expect(request.messages.map(m => m.content).join('\n')).toHaveLength(MAX_INPUT_CHARS); expect(request.response_format).toEqual({ type: 'json_object' }); expect(request.max_tokens).toBe(MAX_OUTPUT_TOKENS);
      return { choices: [{ message: { content: '{}' } }], usage: { neurons: 2.75, prompt_tokens: 100, completion_tokens: 50 } };
    }) };
    const result = await new BoundedModel(ai, ledger, '1', clock).call('system', 'x'.repeat(20_000));
    expect(result!.neurons).toBe(2.75); expect(ledger.rows[0].neurons).toBe(2.75);
  });
  test.each(['missing', 'failed'])('%s usage keeps the 15 neuron reserve', async kind => {
    const ledger = new MemoryLedger(), ai = { run: vi.fn(async () => { if (kind === 'failed') throw new Error('offline'); return { response: '{}' }; }) };
    await new BoundedModel(ai, ledger, '1', clock).call('system', 'prompt'); expect(ledger.rows[0].neurons).toBe(15);
  });
  test('LIVE_AI 0 means no charge and no call', async () => {
    const ledger = new MemoryLedger(), ai = { run: vi.fn() };
    expect(await new BoundedModel(ai, ledger, '0', clock).call('system', 'prompt')).toBeNull();
    expect(ai.run).not.toHaveBeenCalled(); expect(ledger.rows).toHaveLength(0);
  });
  test('Granite chat JSON returns a live itinerary pick', async () => {
    const ledger = new MemoryLedger(), w = await world();
    const ai = { run: vi.fn(async (_model: string, _request: unknown) => ({ choices: [{ message: { content: JSON.stringify({ hotelId: 'h-patio', slots: {} }) } }], usage: { prompt_tokens: 20, completion_tokens: 8, neurons: 0.4 } })) };
    const e = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: new Agent(new BoundedModel(ai, ledger, '1', clock)) });
    const v = await e.create(ID, SID, input());
    expect(v.itinerary.hotelId).toBe('h-patio');
    expect(v.log.find(l => l.tool === 'propose_itinerary')?.source).toBe('live');
    expect(v.log.filter(l => l.tool === 'rank_options')).toMatchObject([{ source: 'rule' }]);
    expect(new Set(v.log.map(l => l.tool)).size).toBe(v.log.length);
  });
  test('empty legacy completion falls back and logs measured neurons', async () => {
    const ledger = new MemoryLedger(), w = await world();
    const ai = { run: vi.fn(async () => ({ choices: [{ text: '' }], usage: { neurons: 1.25 } })) };
    const e = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: new Agent(new BoundedModel(ai, ledger, '1', clock)) });
    const v = await e.create(ID, SID, input());
    const log = v.log.find(l => l.tool === 'propose_itinerary')!;
    expect(log.source).toBe('rule'); expect(log.summary).toBe('AI answer unusable; rule pick'); expect(log.neurons).toBe(1.25);
    expect(ledger.rows[0].neurons).toBe(1.25);
  });
  test('repair reason is code built from checked candidate facts', async () => {
    const w = await world();
    const ai = { proposeItinerary: async () => null, repairPick: async (candidates: import('../../src/domain/types').Candidate[]) => ({ answer: { id: candidates.find(c => c.checks.ok && c.priceDeltaCents < 0)!.id, reason: '' }, neurons: 1 }) };
    const e = new TripEngine({ ...w.deps, store: new MemoryStore(), ai });
    await e.create(ID, SID, input()); await e.action(SID, 'quote'); await e.action(SID, 'pay/card'); await e.action(SID, 'supplier/hotel-unavailable');
    const view = await e.get(SID), log = view.log.find(l => l.tool === 'repair_failed_leg')!;
    expect(log.summary).toMatch(/Saves \$\d+\.\d{2} against .*\. \d+ stops move; every travel buffer kept\./);
    expect(log.source).toBe('live');
  });
  test.each([
    { count: 1, delta: -3100, expected: 'Saves $31.00 against Casa do Pátio. 1 stop moves; every travel buffer kept.' },
    { count: 3, delta: -3100, expected: 'Saves $31.00 against Casa do Pátio. 3 stops move; every travel buffer kept.' },
    { count: 1, delta: 4600, expected: 'Costs $46.00 more than Casa do Pátio. 1 stop moves; every travel buffer kept.' },
  ])('repair reason: $expected', ({ count, delta, expected }) => {
    expect(repairReason({ moves: Array.from({ length: count }, () => ({} as import('../../src/domain/types').Candidate['moves'][number])), priceDeltaCents: delta }, 'Casa do Pátio')).toBe(expected);
  });
  test('ledger refuses at app cap: no model call and visibly labelled rule pick', async () => {
    const ledger = new MemoryLedger(); await ledger.charge('roamreprise', '2026-11-06', DAILY_NEURONS, DAILY_NEURONS, ACCOUNT_DAILY_NEURONS_GUARD);
    const ai = { run: vi.fn() }, w = await world();
    const e = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: new Agent(new BoundedModel(ai, ledger, '1', clock)) });
    const v = await e.create(ID, SID, input());
    expect(ai.run).not.toHaveBeenCalled(); expect(v.log.find(l => l.tool === 'propose_itinerary' && l.summary.includes('Rule pick'))!.source).toBe('rule');
  });
  test('ledger error fails closed before AI; account guard includes other apps', async () => {
    const ai = { run: vi.fn() }, ledger = new MemoryLedger();
    ledger.charge = async () => { throw new Error('D1 unavailable'); };
    expect(await new BoundedModel(ai, ledger, '1', clock).call('system', 'prompt')).toBeNull(); expect(ai.run).not.toHaveBeenCalled();
    const shared = new MemoryLedger(); await shared.charge('other', '2026-11-06', 9_490, 10_000, 10_000);
    expect(await new BoundedModel(ai, shared, '1', clock).call('system', 'prompt')).toBeNull(); expect(ai.run).not.toHaveBeenCalled();
  });
  test('concurrent reservations cannot both slip under the cap', async () => {
    const ledger = new MemoryLedger(); await ledger.charge('roamreprise', '2026-11-06', 880, 900, 9500);
    const results = await Promise.all([ledger.charge('roamreprise', '2026-11-06', 15, 900, 9500), ledger.charge('roamreprise', '2026-11-06', 15, 900, 9500)]);
    expect(results.filter(Boolean)).toHaveLength(1); expect(await ledger.spent('roamreprise', '2026-11-06')).toBe(895);
  });
  test('proposal parser drops unknown ids, ignores model prices, limits why; malformed JSON rejected', () => {
    const slots = candidatesForSlots(input().tastes), hotels = hotelCandidates(input().tastes);
    const result = parseProposal(JSON.stringify({ hotelId: 'fake', slots: { 'd1-lunch': { offerId: slots['d1-lunch'][0].id, why: 'word '.repeat(25), price: 1 }, 'd2-am': { offerId: 'fake' }, unknown: { offerId: 'm-ribeira' } }, totalCents: 1 }), slots, hotels)!;
    expect(Object.keys(result.picks.slots!)).toEqual(['d1-lunch']); expect(result.picks.hotelId).toBeUndefined();
    expect(result.why['d1-lunch'].split(' ')).toHaveLength(8);
    expect(parseProposal('```json\n{}\n```', slots, hotels)).toBeNull();
  });
  test('proposal parser accepts array and keyed slot forms without reusing offers', () => {
    const hotels = hotelCandidates(input().tastes);
    const slots = {
      'd1-lunch': [{ id: 'm-ribeira' }],
      'd1-pm': [{ id: 'a-tilemuseum' }],
      'd1-dinner': [{ id: 'm-fado' }],
    } as unknown as import('../../src/domain/planner').SlotCandidates;
    const measured = parseProposal(JSON.stringify({ hotelId: 'h-patio', slots: [
      { offerId: 'm-ribeira', why: 'Explore food markets' },
      { offerId: 'a-tilemuseum', why: 'Discover tile art history' },
      { offerId: 'm-fado', why: 'Enjoy fado music' },
    ] }), slots, hotels)!;
    expect(measured.picks.slots).toEqual({ 'd1-lunch': 'm-ribeira', 'd1-pm': 'a-tilemuseum', 'd1-dinner': 'm-fado' });
    expect(parseProposal(JSON.stringify({ slots: { 'd1-lunch': 'm-ribeira' } }), slots, hotels)!.picks.slots)
      .toEqual({ 'd1-lunch': 'm-ribeira' });
    const duplicate = parseProposal(JSON.stringify({ slots: [
      { offerId: 'm-ribeira', why: 'First pick' }, { offerId: 'm-ribeira', why: 'Second pick' },
    ] }), slots, hotels)!;
    expect(duplicate.picks.slots).toEqual({ 'd1-lunch': 'm-ribeira' });
  });
  test('repair parser only accepts checked ids and caps its reason at 30 words', () => {
    const itinerary = buildItinerary(input()).itinerary, hotel = itinerary.items.find(i => i.kind === 'lodging')!;
    const candidates = repairFailedLeg(itinerary, hotel.id, 60_000).candidates;
    expect(parseRepair('{"id":"h-terraco"}', candidates)).toBeNull();
    expect(parseRepair('{"id":"unknown","reason":"nice"}', candidates)).toBeNull();
    expect(parseRepair(JSON.stringify({ id: 'h-lumen', fit: 'word '.repeat(40) }), candidates)!.reason.split(' ')).toHaveLength(8);
    expect(parseRepair('{"id":"h-lumen","fit":"fits 3 tastes"}', candidates)!.reason).toBe('');
  });
  test('cache hit uses zero AI; sorted tastes share a hash; cached live label has its time', async () => {
    const w = await world(), key = await proposalKey(input().tastes, '');
    expect(await proposalKey([...input().tastes].reverse(), '')).toBe(key);
    await w.gate.cache(key, { capturedAt: clock().toISOString(), answer: { picks: { hotelId: 'h-patio' }, why: {} } });
    const ai = { proposeItinerary: vi.fn(), repairPick: vi.fn() };
    const v = await new TripEngine({ ...w.deps, store: new MemoryStore(), ai }).create(ID, SID, input());
    expect(ai.proposeItinerary).not.toHaveBeenCalled();
    expect(v.log.some(l => l.source === 'cached' && l.summary.includes('20:00 UTC'))).toBe(true);
  });
  test('cached proposal remains recordable as a live answer', async () => {
    const w = await world(), key = await proposalKey(input().tastes, '');
    await w.gate.cache(key, { capturedAt: clock().toISOString(), answer: { picks: { hotelId: 'h-patio' }, why: {} } });
    const ai = { proposeItinerary: vi.fn(), repairPick: vi.fn(async (candidates: import('../../src/domain/types').Candidate[]) => ({ answer: { id: candidates.find(c => c.checks.ok)!.id, reason: '' }, neurons: 1 })) };
    const engine = new TripEngine({ ...w.deps, store: new MemoryStore(), ai });
    await engine.create(ID, SID, input());
    const recorded = await engine.recordAnswers(SID);
    expect(recorded.propose).toEqual({ picks: { hotelId: 'h-patio' }, why: {} });
    expect(ai.proposeItinerary).not.toHaveBeenCalled(); expect(ai.repairPick).toHaveBeenCalledOnce();
  });
  test('24-hour cache expiry is exact and note changes produce distinct keys', async () => {
    let at = clock(); const gate = new MemoryGate(() => at), key = await proposalKey(input().tastes, '');
    await gate.cache(key, { capturedAt: at.toISOString(), answer: { picks: {}, why: {} } });
    at = new Date(at.getTime() + 24 * 60 * 60 * 1000); expect(await gate.cached(key)).toBeNull();
    expect(await proposalKey(input().tastes, 'different')).not.toBe(key);
  });
  test('placeholder recorded answers are always rule picks', async () => {
    const w = await world(), v = await w.view(); expect(v.log.some(l => l.source === 'recorded')).toBe(false);
    await w.action('quote'); await w.action('pay/card'); await w.action('supplier/hotel-unavailable');
    expect((await w.view()).repair!.pickSource).toBe('rule');
  });
  test('non placeholder recorded answers are used and labelled with their capture date', async () => {
    const w = await world(), capturedAt = clock().toISOString();
    const recorded = {
      propose: { placeholder: false, capturedAt, answer: { picks: { hotelId: 'h-patio' }, why: {} } },
      repair: { placeholder: false, capturedAt, answer: { id: 'h-lumen', reason: 'Fado music nearby' } },
    };
    const engine = new TripEngine({ ...w.deps, store: new MemoryStore(), recorded });
    const v = await engine.create(ID, SID, input());
    expect(v.log.find(l => l.tool === 'propose_itinerary')).toMatchObject({ source: 'recorded', summary: `Recorded answer from ${capturedAt}.` });
    await engine.action(SID, 'quote'); await engine.action(SID, 'pay/card');
    const repair = await engine.action(SID, 'supplier/hotel-unavailable') as import('../../src/domain/types').TripView;
    expect(repair.repair).toMatchObject({ pickId: 'h-lumen', pickSource: 'recorded' });
    expect(repair.repair!.pickReason).toContain(`Recorded answer from ${capturedAt}.`);
  });
  test.each(['move', 'moves', 'stop', 'stops', 'fewer', 'less', 'more', 'cheap', 'cheaper', 'price', 'cost', 'save', 'saves', 'budget', 'total', 'buffer', 'minute', 'time', '3', '$', '€'])('proposal why and repair fit drop factual claims: %s', word => {
    const slots = candidatesForSlots(input().tastes), hotels = hotelCandidates(input().tastes);
    const itinerary = buildItinerary(input()).itinerary;
    const candidates = repairFailedLeg(itinerary, itinerary.items.find(i => i.kind === 'lodging')!.id, 60_000).candidates;
    const text = `Enjoy tile art, ${word.toUpperCase()}.`;
    expect(parseProposal(JSON.stringify({ slots: { 'd1-lunch': { offerId: slots['d1-lunch'][0].id, why: text } } }), slots, hotels)!.why).toEqual({});
    expect(parseRepair(JSON.stringify({ id: 'h-lumen', fit: text }), candidates)!.reason).toBe('');
  });
  test('taste text preserves whole words inside tastes and caps both fields at eight words', () => {
    const slots = candidatesForSlots(input().tastes), hotels = hotelCandidates(input().tastes);
    const itinerary = buildItinerary(input()).itinerary;
    const candidates = repairFailedLeg(itinerary, itinerary.items.find(i => i.kind === 'lodging')!.id, 60_000).candidates;
    const text = 'Timeless art movements beside historic food markets and fado';
    expect(parseProposal(JSON.stringify({ slots: { 'd1-lunch': { offerId: slots['d1-lunch'][0].id, why: text } } }), slots, hotels)!.why['d1-lunch']).toBe('Timeless art movements beside historic food markets and');
    expect(parseRepair(JSON.stringify({ id: 'h-lumen', fit: text }), candidates)!.reason).toBe('Timeless art movements beside historic food markets and');
  });
  test('default trip rule repair pick is h-riocalmo', async () => {
    const w = await world();
    await w.action('quote'); await w.action('pay/card'); await w.action('supplier/hotel-unavailable');
    const trip = await w.view();
    expect(trip.repair?.pickId).toBe('h-riocalmo');
    const candidate = trip.repair!.candidates.find(c => c.id === trip.repair!.pickId)!;
    const oldHotel = trip.itinerary.items.find(i => i.kind === 'lodging' && i.booked)!;
    expect(trip.repair?.pickReason).toBe(`Rule pick: ${repairReason(candidate, oldHotel.name)}`);
  });
  test('request validation enforces taste allowlist, cents ceiling and 280 character note', () => {
    for (const invalid of [{ ...input(), tastes: ['unknown'] }, { ...input(), note: 'x'.repeat(281) }, { ...input(), ceilingCents: 29999 }, { ...input(), ceilingCents: 150001 }, { ...input(), ceilingCents: 30000.1 }]) expect(() => tripInput(invalid)).toThrow();
    expect(tripInput({ ...input(), note: 'x'.repeat(280) }).note).toHaveLength(280);
  });
  test('live recording returns two actual answers, enforces two calls per trip, sends no PayPal writes', async () => {
    const w = await world(), call = vi.fn()
      .mockResolvedValueOnce({ text: '{"hotelId":"h-patio","slots":{"d1-lunch":{"offerId":"m-ribeira","why":"Markets fit your tastes"}}}', neurons: 1 })
      .mockResolvedValueOnce({ text: '{"id":"h-lumen","reason":"Fewest changed times"}', neurons: 1 });
    const engine = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: new Agent({ call }) });
    await engine.create(ID, SID, input()); const recorded = await engine.recordAnswers(SID);
    expect(recorded.propose).toBeTruthy(); expect(recorded.repair.id).toBe('h-lumen'); expect(recorded.capturedAt).toBe(clock().toISOString());
    expect(call).toHaveBeenCalledTimes(2); expect(w.sb.sent).toHaveLength(0);
    await expect(engine.recordAnswers(SID)).rejects.toMatchObject({ code: 'STATE' }); expect(call).toHaveBeenCalledTimes(2);
  });
});
