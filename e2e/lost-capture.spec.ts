import { test, expect } from './fixtures';
import { startTrip, quote, fault, hold, waitPhase, press, receiptPage } from './helpers';

test('lost capture response reconciles to Captured with exactly one capture', async ({ page }) => {
  await startTrip(page); await quote(page); await hold(page); await waitPhase(page, 'holding');
  await fault(page, 'lose_next_response'); await press(page, 'Confirm bookings');
  const unknown = await waitPhase(page, 'checking_payment');
  expect(unknown.next).toEqual(['reconcile']);
  await expect(page.locator('#state-chips')).toContainText('Checking payment');
  await expect(page.getByRole('button', { name: 'Confirm bookings', exact: true })).toHaveCount(0);
  await press(page, 'Check payment');
  const view = await waitPhase(page, 'confirmed_captured');
  expect(view.payments.at(-1)?.state).toBe('captured');
  expect(view.payments.at(-1)?.captureId).toBeTruthy();
  await expect(page.locator('#state-chips')).toContainText('Captured');
  expect(view.payments.flatMap(p => p.receipts).filter(r => r.method === 'POST' && /\/capture$/.test(r.path))).toHaveLength(1);
  await receiptPage(page, view);
});
