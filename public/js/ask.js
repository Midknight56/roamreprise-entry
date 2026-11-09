export const ASK_CHIPS = ['Make Sunday morning slower', 'Swap the castle for coffee'];
export const ASK_MAX_CHARS = 160;
export const ASK_BUTTON = 'Ask the agent';

export function askPanel(trip, recorded) {
  const allowed = trip.phase === 'holding' ? trip.payments.at(-1)?.state === 'authorized' : ['planned', 'quoted'].includes(trip.phase) && !trip.payments.length;
  if (recorded || !allowed || trip.asksLeft === undefined) return { mode: 'hidden' };
  return trip.asksLeft > 0 ? { mode: 'input' } : { mode: 'used', text: 'You used both changes for this trip.' };
}
export function quoteNote(trip) {
  return trip.phase === 'planned' && trip.lastAsk?.reapprove ? trip.lastAsk.quoteNote || '' : '';
}
export function answerText(trip) { return trip.lastAsk?.message || ''; }
export function askSourceName(step) {
  return step.sample ? 'Sample answer' : step.source === 'live' ? 'AI change · code checked' : 'Rule change';
}
