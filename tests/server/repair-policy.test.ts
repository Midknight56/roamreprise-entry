import { describe, expect, test } from 'vitest';
import type { TripAI } from '../../src/ai/agent';
import type { Candidate } from '../../src/domain/types';
import { tripInput } from '../../src/trip/engine';
import recorded from '../../src/recorded/default-propose.json';
import { input, world } from '../helpers/world';

type World = Awaited<ReturnType<typeof world>>;
const failHotel = async (w: World) => { await w.action('quote'); await w.action('pay/card'); await w.action('supplier/hotel-unavailable'); return w.view(); };
// Every trip here starts from the recorded live AI plan ($428.00), where Rio Calmo drops the castle walk.
const plan = async () => ({ answer: recorded.answer as never, neurons: 1 });
const answering = (id: string): TripAI => ({ proposeItinerary: plan, repairPick: async () => ({ answer: { id, reason: '' }, neurons: 1 }) });
const noRepairAnswer: TripAI = { proposeItinerary: plan, repairPick: async () => null };

describe('repair policy on the server', () => {
  test('tripInput accepts both choices, defaults to lowest total and refuses anything else', () => {
    expect(tripInput({ ...input() }).repairPolicy).toBe('lowest_total');
    expect(tripInput({ ...input(), repairPolicy: 'keep_activities' }).repairPolicy).toBe('keep_activities');
    expect(tripInput({ ...input(), repairPolicy: 'lowest_total' }).repairPolicy).toBe('lowest_total');
    expect(() => tripInput({ ...input(), repairPolicy: 'cheapest' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('keep activities: the repair keeps every activity, then one capture', async () => {
    const w = await world({ input: { repairPolicy: 'keep_activities' }, ai: noRepairAnswer });
    expect((await w.view()).repairPolicy).toBe('keep_activities');
    const proposed = await failHotel(w);
    expect(proposed.repair!.pickId).toBe('h-lumen');
    expect(proposed.repair!.pickReason).toContain('Keeps every activity.');
    await w.action('repair/accept', { candidateId: 'h-lumen' });
    await w.action('pay/card'); await w.action('confirm');
    const v = await w.view();
    expect(v.phase).toBe('confirmed_captured');
    expect(v.payments.filter(p => p.state === 'captured')).toHaveLength(1);
    expect(v.itinerary.items.some(i => i.name === 'Castle hill walk' && i.state === 'confirmed')).toBe(true);
  });

  test('accepting a candidate that breaks the policy is refused', async () => {
    const w = await world({ input: { repairPolicy: 'keep_activities' }, ai: noRepairAnswer });
    await failHotel(w);
    await expect(w.action('repair/accept', { candidateId: 'h-riocalmo' })).rejects.toThrow();
  });

  test('an AI answer outside the policy is refused and the rule pick stands; one AI call either way', async () => {
    const keep = await world({ input: { repairPolicy: 'keep_activities' }, ai: answering('h-riocalmo') });
    const k = await failHotel(keep);
    expect(k.repair!.pickId).toBe('h-lumen'); expect(k.repair!.pickSource).toBe('rule');
    const cheap = await world({ ai: answering('h-lumen') });
    const c = await failHotel(cheap);
    expect(c.repair!.pickId).toBe('h-riocalmo'); expect(c.repair!.pickSource).toBe('rule');
    expect((await cheap.record())!.aiCalls).toBe(2); // one plan call plus one repair call, as before
  });

  test('an AI answer inside the policy is used', async () => {
    const w = await world({ input: { repairPolicy: 'keep_activities' }, ai: answering('h-lumen') });
    const v = await failHotel(w);
    expect(v.repair!.pickId).toBe('h-lumen'); expect(v.repair!.pickSource).toBe('live');
  });

  test('the AI is sent only the candidates the policy lets it choose', async () => {
    let sent: Candidate[] = [];
    const ai: TripAI = { proposeItinerary: plan, repairPick: async (candidates) => { sent = candidates; return null; } };
    const w = await world({ input: { repairPolicy: 'keep_activities' }, ai });
    await failHotel(w);
    expect(sent.map(c => c.id)).toEqual(['h-lumen']);
  });
});
