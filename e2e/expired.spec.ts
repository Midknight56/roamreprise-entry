import { test, expect } from './fixtures';
import { startTrip, quote, fault, hold, waitPhase, press } from './helpers';

test('expired authorization refuses capture and asks for fresh approval', async ({ page }) => {
  await startTrip(page); await quote(page); await hold(page); await waitPhase(page, 'holding');
  await fault(page, 'expire_authorization');
  const response = page.waitForResponse(r => r.url().endsWith('/confirm') && r.request().method() === 'POST');
  await press(page, 'Confirm bookings', true);
  const refused = await response;
  expect(refused.status()).toBeGreaterThanOrEqual(400);
  expect((await refused.json()).error).toBe('AUTHORIZATION_EXPIRED');
  await expect(page.locator('#error')).toContainText('Pay again with fresh approval');
  const view = await waitPhase(page, 'declined');
  expect(view.payments.at(-1)?.state).toBe('expired');
  expect(view.payments.flatMap(p => p.receipts).some(r => r.op === 'capture')).toBe(false);
  expect(view.itinerary.items.some(i => i.state === 'confirmed')).toBe(false);
  await expect(page.locator('#pay-card')).toBeEnabled();
});
