import type { TripDependencies } from '../../src/trip/engine';
// Deliberately independent of the shipped recordings: tests choose their fallback.
export const placeholderRecorded: TripDependencies['recorded'] = {
  propose: { placeholder: true, capturedAt: null, answer: { picks: {}, why: {} } },
  repair: { placeholder: true, capturedAt: null, answer: { id: '', reason: '' } },
};
