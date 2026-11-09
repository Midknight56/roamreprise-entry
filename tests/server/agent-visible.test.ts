import { expect, test, vi } from 'vitest';
import { Agent, parseProposal } from '../../src/ai/agent';
import { buildItinerary, candidatesForSlots, hotelCandidates } from '../../src/domain/planner';
import { TripEngine } from '../../src/trip/engine';
import { MemoryStore } from '../../src/trip/store';
import { validateSchedule } from '../../src/domain/validate';
import { ID, SID, input, world } from '../helpers/world';

for (const source of ['live', 'rule', 'cached', 'recorded'] as const) {
  test(source === 'recorded' ? 'empty note ignores recorded prefs and has one Read your note step with source recorded' : `note 'slow mornings' gives Day 2 activity at or after 10:30 and one Read your note step with source ${source}`, async () => {
    const w = await world();
    const request = { ...input(), note: source === 'recorded' ? '' : 'slow mornings' };
    const answer = { picks: { hotelId: 'h-patio' }, why: {}, prefs: { startAfter: '10:30' } };
    const ai = new Agent({ call: vi.fn(async () => source === 'live' ? { text: JSON.stringify({ hotelId: 'h-patio', slots: {}, prefs: answer.prefs }), neurons: 1 } : null) });
    const gate = w.gate;
    gate.cached = async () => source === 'cached' ? { answer, capturedAt: w.deps.clock().toISOString() } : null;
    const engine = new TripEngine({ ...w.deps, store: new MemoryStore(), ai, gate,
      recorded: source === 'recorded' ? { ...w.deps.recorded, propose: { placeholder: false, capturedAt: w.deps.clock().toISOString(), answer } } : w.deps.recorded });
    const view = await engine.create(ID, SID, request);
    if (source !== 'recorded') expect(view.itinerary.items.find(i => i.slot === 'd2-am')!.start >= '10:30').toBe(true);
    expect(view.log.filter(l => l.tool === 'read_note')).toMatchObject([{ source, summary: expect.stringContaining(source === 'recorded' ? 'nothing to change' : '10:30') }]);
    expect(view.log.filter(l => l.tool === 'read_note')).toHaveLength(1);
    expect(validateSchedule(view.itinerary, request.ceilingCents).ok).toBe(true);
  });
}
test('prefs fields outside the whitelist are dropped', () => {
  const result = parseProposal(JSON.stringify({ hotelId: 'h-patio', slots: {}, prefs: { pace: 'sprint', startAfter: '06:00', prefer: ['coffee', 'unknown'], avoid: ['history', 'unknown'], price: 1 } }), candidatesForSlots(input().tastes), hotelCandidates(input().tastes));
  expect(result).toHaveProperty('prefs', { prefer: ['coffee'], avoid: ['history'] });
});
test('pace slow drops optional slots and quote passes every check', () => {
  const plan = buildItinerary(input(), {}, { pace: 'slow' });
  expect(plan.itinerary.items.some(i => ['d1-late', 'd2-pm'].includes(i.slot))).toBe(false);
  expect(validateSchedule(plan.itinerary, input().ceilingCents).ok).toBe(true);
});
import { cleanPreferences, rulePreferences } from '../../src/domain/preferences';
import { offer } from '../../src/domain/offers';

test('rule note parser recognises plain phrases and avoids only whitelisted tastes', () => {
  for (const note of ['slow morning', 'slow mornings', 'late start', 'sleep in']) expect(rulePreferences(note).startAfter).toBe('10:30');
  for (const note of ['slow', 'relaxed', 'easy']) expect(rulePreferences(note).pace).toBe('slow');
  for (const note of ['busy', 'packed']) expect(rulePreferences(note).pace).toBe('busy');
  expect(rulePreferences('No coffee, not history, no helicopters')).toEqual({ avoid: ['coffee', 'history'] });
  expect(rulePreferences('')).toEqual({});
});
test('startAfter whitelist accepts only quarter hours from 09:00 through 11:30', () => {
  for (const time of ['09:00', '09:15', '10:30', '11:30']) expect(cleanPreferences({ startAfter: time }).startAfter).toBe(time);
  for (const time of ['08:45', '11:45', '10:31', '9:00', '06:00', 'garbage']) expect(cleanPreferences({ startAfter: time })).toEqual({});
});
test('prefer ranks matching offers and avoid removes a tagged offer when alternatives exist', () => {
  const plan = buildItinerary(input(), {}, { prefer: ['history'], avoid: ['tile art'] });
  expect(plan.candidates['d1-pm'][0].tags).toContain('history');
  for (const list of Object.values(plan.candidates)) {
    if (list.some(o => !o.tags.includes('tile art'))) expect(list.every(o => !o.tags.includes('tile art'))).toBe(true);
  }
  expect(plan.itinerary.items.filter(i => i.kind === 'activity').every(i => !offer(i.offerId).tags.includes('tile art'))).toBe(true);
  expect(validateSchedule(plan.itinerary, input().ceilingCents).ok).toBe(true);
});
test('failed preference checks drop preferences and report the fallback', () => {
  const plan = buildItinerary({ ...input(), ceilingCents: 1 }, {}, { startAfter: '10:30' });
  expect(plan.prefsRejected).toBe(true);
  expect(plan.itinerary.items.find(i => i.slot === 'd2-checkout')!.start).toBe('09:00');
});
test('one proposal call reads the note, empty notes ignore AI preferences, unmatched reasons are not attributed', async () => {
  const w = await world();
  const call = vi.fn(async () => ({ text: JSON.stringify({ hotelId: 'h-patio', slots: { 'd1-pm': { offerId: 'a-tilemuseum', why: 'Explore tile art' } }, prefs: { pace: 'slow', startAfter: '10:30' } }), neurons: 1 }));
  const engine = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: new Agent({ call }) });
  const view = await engine.create(ID, SID, input());
  expect(call).toHaveBeenCalledTimes(1);
  expect(view.log.find(l => l.tool === 'read_note')?.summary).toBe('Read your note: nothing to change.');
  expect(view.itinerary.items.find(i => i.slot === 'd2-checkout')!.start).toBe('09:00');
  const avoiding = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: new Agent({ call: async () => ({ text: JSON.stringify({ hotelId: 'h-patio', slots: { 'd1-pm': { offerId: 'a-tilemuseum', why: 'Explore tile art' } }, prefs: { avoid: ['tile art'] } }), neurons: 1 }) }) });
  const changed = await avoiding.create(ID, SID, { ...input(), note: 'no tile art' });
  expect(changed.itinerary.items.find(i => i.slot === 'd1-pm')!.offerId).not.toBe('a-tilemuseum');
  expect(changed.itinerary.items.find(i => i.slot === 'd1-pm')!.why).toBeUndefined();
});
test('live repair without fit sets aiWords false and explains code authorship', async () => {
  const w = await world();
  const engine = new TripEngine({ ...w.deps, store: new MemoryStore(), ai: {
    proposeItinerary: async () => null,
    repairPick: async candidates => ({ answer: { id: candidates.find(c => c.checks.ok)!.id, reason: '' }, neurons: 1 }),
  } });
  await engine.create(ID, SID, input());
  await engine.action(SID, 'quote'); await engine.action(SID, 'pay/card'); await engine.action(SID, 'supplier/hotel-unavailable');
  const view = await engine.get(SID);
  expect(view.repair?.pickReason).toMatch(/The AI gave no reason; this sentence is from the code checks\.$/);
  expect(view.log.find(l => l.tool === 'repair_failed_leg')).toMatchObject({ source: 'live', aiWords: false });
});
