import { describe, expect, test } from 'vitest';
import type { TripView } from '../../src/domain/types';
// @ts-expect-error Browser module is plain JavaScript.
import { candidateFacts, failedItemName, repairSummary } from '../../public/js/repair-view.js';
// @ts-expect-error Browser module is plain JavaScript.
import { request } from '../../public/js/mock-api.js';

describe('repair failed item name', () => {
  test('uses the name of the failed item and not Casa do Patio', () => {
    const mockTrip: TripView = {
      phase: 'repair_proposed',
      itinerary: {
        version: 1,
        hotelId: 'h-teste',
        totalCents: 40000,
        items: [
          {
            id: 'd1-checkin',
            offerId: 'h-teste',
            slot: 'd1-checkin',
            kind: 'lodging',
            name: 'Hotel Teste',
            placeId: 'alfama',
            day: 0,
            start: '16:30',
            end: '09:00',
            bufferMin: 15,
            priceCents: 16800,
            booked: true,
            travelMode: 'metro',
            state: 'failed',
          },
        ],
      },
      repair: {
        failedItemId: 'd1-checkin',
        candidates: [],
        pickId: 'rio',
        pickReason: 'test',
        pickSource: 'rule',
      },
      payments: [],
      log: [],
      issues: [],
      next: [],
      ceilingCents: 60000,
      tastes: [],
      note: '',
      webhooks: [],
      id: 'test-trip',
    };

    const name = failedItemName(mockTrip);
    expect(name).toBe('Hotel Teste');
    expect(name).not.toContain('Casa do Pátio');

    const summary = repairSummary(mockTrip);
    expect(summary).toContain('Hotel Teste');
    expect(summary).not.toContain('Casa do Pátio');
  });
});

describe('repair candidate facts on default mock repair', () => {
  test('computes the five facts for Rio Calmo and Lumen from real mock data', async () => {
    let storeData = '{}';
    globalThis.localStorage = {
      getItem: () => storeData,
      setItem: (_k: string, v: string) => {
        storeData = v;
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    let trip = await request('/api/trips', 'POST', {});
    trip = await request(`/api/trips/${trip.id}/quote`, 'POST');
    trip = await request(`/api/trips/${trip.id}/pay/card`, 'POST');
    trip = await request(`/api/trips/${trip.id}/supplier/hotel-unavailable`, 'POST');

    const repair = trip.repair;
    expect(repair).toBeDefined();

    const lumen = repair.candidates.find((c: { id: string }) => c.id === 'lumen');
    const rio = repair.candidates.find((c: { id: string }) => c.id === 'rio');

    expect(lumen).toBeDefined();
    expect(rio).toBeDefined();

    const lumenFacts = candidateFacts(trip, lumen);
    expect(lumenFacts.fact1).toBe('$474.00 total, $48.00 more than your approved $426.00');
    expect(lumenFacts.fact2).toBe('Keeps every activity');
    expect(lumenFacts.fact3).toBe('1 stop moves, 25 min in total');
    expect(lumenFacts.fact4.main).toBe('Every schedule check passed');
    expect(lumenFacts.fact4.sub).toBe('opening hours, budget, estimated travel times');
    expect(lumenFacts.fact5).toBe('Using it releases the $426.00 PayPal hold. Nothing is charged. Then you approve the new total.');

    const rioFacts = candidateFacts(trip, rio);
    expect(rioFacts.fact1).toBe('$406.00 total, $20.00 less than your approved $426.00');
    expect(rioFacts.fact2).toBe('Keeps every activity'); // mock candidates drop nothing
    expect(rioFacts.fact3).toBe('5 stops move, 200 min in total');
    expect(rioFacts.fact4.main).toBe('Every schedule check passed');
    expect(rioFacts.fact4.sub).toBe('opening hours, budget, estimated travel times');
    expect(rioFacts.fact5).toBe('Using it releases the $426.00 PayPal hold. Nothing is charged. Then you approve the new total.');
  });
});

describe('repair candidate facts name dropped activities', () => {
  test('server droppedActivities wins, and dropped ids map to activity names only', () => {
    const base = { ceilingCents: 60000, quote: { version: 1, totalCents: 42800, approvedAt: '' }, payments: [],
      itinerary: { version: 1, hotelId: 'h-patio', totalCents: 42800, items: [
        { id: 'd1-late', slot: 'd1-late', kind: 'activity', name: 'Castle hill walk' },
        { id: 'd1-dinner', slot: 'd1-dinner', kind: 'meal', name: 'Fado dinner' },
      ] } } as unknown as TripView;
    const fromServer = { newTotalCents: 39700, moves: [], dropped: ['d1-late'], droppedActivities: ['Castle hill walk'] };
    expect(candidateFacts(base, fromServer).fact2).toBe('Drops Castle hill walk');
    const fromIds = { newTotalCents: 39700, moves: [], dropped: ['d1-late', 'd1-dinner'] };
    expect(candidateFacts(base, fromIds).fact2).toBe('Drops Castle hill walk');
    expect(candidateFacts(base, fromIds).fact1).toBe('$397.00 total, $31.00 less than your approved $428.00');
  });
});
