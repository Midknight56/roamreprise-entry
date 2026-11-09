import { test, expect } from './fixtures';
import { startTrip, quote, fault, hold, waitPhase, press, receiptPage } from './helpers';

test('lost authorization response reconciles the original order without another create', async ({ page }) => {
  await startTrip(page); await quote(page); await fault(page, 'lose_next_response');
  await hold(page);
  const unknown = await waitPhase(page, 'checking_payment');
  await expect(page.locator('#state-chips')).toContainText('Checking payment');
  expect(unknown.next).toEqual(['reconcile']);
  await expect(page.locator('#actions button')).toHaveCount(1);
  await expect(page.locator('#actions button')).toHaveText('Check payment');
  await expect(page.locator('#pay-panel button,#repair-panel button:visible')).toHaveCount(0);
  await press(page, 'Check payment');
  const view = await waitPhase(page, 'holding');
  expect(view.payments.at(-1)?.state).toBe('authorized');
  await expect(page.locator('#state-chips')).toContainText('Authorized');
  expect(view.payments).toHaveLength(1);
  expect(view.payments.flatMap(p => p.receipts).filter(r => r.method === 'POST' && r.path === '/v2/checkout/orders')).toHaveLength(1);
  expect(view.payments.flatMap(p => p.receipts).filter(r => r.method === 'POST' && r.path.endsWith('/authorize'))).toHaveLength(1);
  expect(view.payments.at(-1)!.receipts.slice(0, 3).map(r => [r.op, r.status, r.paypalStatus])).toEqual([
    ['create', 201, 'CREATED'], ['authorize', 0, 'RESPONSE_LOST'], ['read_order', 200, 'COMPLETED'],
  ]);
  await receiptPage(page, view);
});
