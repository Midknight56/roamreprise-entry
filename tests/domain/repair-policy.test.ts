import { describe, expect, test } from 'vitest';
import { buildItinerary } from '../../src/domain/planner';
import { aiChoices, applyCandidate, rankCandidates, repairFailedLeg } from '../../src/domain/repair';
import type { Itinerary } from '../../src/domain/types';
import recorded from '../../src/recorded/default-propose.json';
import { input } from '../helpers/world';

// The plan from the recorded live AI answer ($428.00): there, Rio Calmo drops the castle walk.
const plan = () => buildItinerary(input(), recorded.answer.picks).itinerary;
const hotelId = (itinerary: Itinerary) => itinerary.items.find(i => i.kind === 'lodging' && i.booked)!.id;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

describe('repair policy', () => {
  test('lowest total picks Rio Calmo, which drops the castle walk; keep activities picks Lumen', () => {
    const itinerary = plan();
    const cheap = repairFailedLeg(itinerary, hotelId(itinerary), 60_000, 'lowest_total');
    const keep = repairFailedLeg(itinerary, hotelId(itinerary), 60_000, 'keep_activities');
    expect(cheap.pickId).toBe('h-riocalmo');
    expect(cheap.candidates.find(c => c.id === 'h-riocalmo')!.droppedActivities).toEqual(['Castle hill walk']);
    expect(keep.pickId).toBe('h-lumen');
    expect(keep.candidates.find(c => c.id === 'h-lumen')!.droppedActivities).toEqual([]);
    const rio = keep.candidates.find(c => c.id === 'h-riocalmo')!;
    expect(rio.checks.ok).toBe(false);
    expect(rio.checks.issues).toContainEqual({ code: 'POLICY', message: 'Drops Castle hill walk. You asked to keep your activities.' });
  });

  test('keep activities with a ceiling below Lumen finds no replacement instead of dropping an activity', () => {
    const itinerary = plan();
    const lumen = repairFailedLeg(itinerary, hotelId(itinerary), 60_000, 'keep_activities').candidates.find(c => c.id === 'h-lumen')!;
    const tight = repairFailedLeg(itinerary, hotelId(itinerary), lumen.newTotalCents - 1, 'keep_activities');
    expect(tight.pickId).toBeUndefined();
    expect(tight.candidates.filter(c => c.checks.ok)).toEqual([]);
    expect(tight.candidates.find(c => c.id === 'h-riocalmo')!.checks.issues.map(i => i.code)).toContain('POLICY');
  });

  test('a candidate that breaks the policy cannot be applied', () => {
    const itinerary = plan();
    const id = hotelId(itinerary);
    const rio = repairFailedLeg(itinerary, id, 60_000, 'lowest_total').candidates.find(c => c.id === 'h-riocalmo')!;
    expect(() => applyCandidate(itinerary, rio, 'keep_activities')).toThrow();
    expect(() => applyCandidate(itinerary, rio, 'lowest_total')).not.toThrow();
  });

  test('movedMinutes is the sum of absolute start changes, or end changes for end only moves', () => {
    const itinerary = plan();
    for (const c of repairFailedLeg(itinerary, hotelId(itinerary), 60_000).candidates) {
      const expected = c.moves.reduce((sum, m) => sum + Math.abs(m.fromStart === m.toStart
        ? minutes(m.toEnd) - minutes(m.fromEnd) : minutes(m.toStart) - minutes(m.fromStart)), 0);
      expect(c.movedMinutes).toBe(expected);
    }
  });

  test('rank and AI choices follow the policy', () => {
    const itinerary = plan();
    const cheap = repairFailedLeg(itinerary, hotelId(itinerary), 60_000, 'lowest_total').candidates;
    expect(rankCandidates(cheap, 'lowest_total')[0].id).toBe('h-riocalmo');
    expect(aiChoices(cheap, 'lowest_total').map(c => c.id)).toEqual(['h-riocalmo']);
    const keep = repairFailedLeg(itinerary, hotelId(itinerary), 60_000, 'keep_activities').candidates;
    expect(aiChoices(keep, 'keep_activities').map(c => c.id)).toEqual(['h-lumen']);
  });
});
