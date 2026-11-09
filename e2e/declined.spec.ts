import { test, expect } from './fixtures';
import { startTrip, quote, press, waitPhase, hold } from './helpers';

test('declined sandbox card confirms nothing and a new payment works', async ({ page }) => {
  await startTrip(page); await quote(page);
  await page.locator('.failure-paths summary').click();
  await press(page, 'Try a declined card');
  const declined = await waitPhase(page, 'declined');
  expect(declined.payments.at(-1)?.state).toBe('declined');
  expect(declined.itinerary.items.some(i => i.state === 'confirmed')).toBe(false);
  expect(declined.payments.some(p => p.captureId)).toBe(false);
  await expect(page.locator('#phase-summary')).toContainText('No bookings are confirmed');
  await hold(page);
  const view = await waitPhase(page, 'holding');
  expect(view.payments.at(-1)?.state).toBe('authorized');
  expect(view.payments).toHaveLength(2);
});
