import { test, expect } from './fixtures';

test('receipt page renders the verified webhook rows for their quote attempts', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('roamreprise-mock-v1', JSON.stringify({
      'SAMPLE-TRIP': {
        id: 'SAMPLE-TRIP', payments: [
          { quoteVersion: 1, amountCents: 1000, state: 'authorized', method: 'card', receipts: [], refunds: [] },
          { quoteVersion: 2, amountCents: 1200, state: 'captured', method: 'card', receipts: [], refunds: [] },
        ],
        webhooks: [
          { eventId: 'SAMPLE-1', eventType: 'PAYMENT.AUTHORIZATION.CREATED', receivedAt: '2026-11-06T20:00:03Z', signatureVerified: true, quoteVersion: 1, outcome: 'already known', sample: true },
          { eventId: 'SAMPLE-2', eventType: 'PAYMENT.CAPTURE.COMPLETED', receivedAt: '2026-11-06T20:05:12Z', signatureVerified: true, quoteVersion: 2, outcome: 'already known', sample: true },
        ],
      },
    }));
  });
  await page.goto('/receipt.html?trip=SAMPLE-TRIP&mock=1');
  await expect(page.locator('.receipt-attempt')).toHaveCount(2);
  await expect(page.locator('.receipt-webhook')).toHaveCount(2);
  await expect(page.locator('.receipt-webhook').nth(0)).toContainText('PAYMENT.AUTHORIZATION.CREATED · received 20:00:03 UTC · signature verified · already known to attempt 1 · sample');
  await expect(page.locator('.receipt-webhook').nth(1)).toContainText('PAYMENT.CAPTURE.COMPLETED · received 20:05:12 UTC · signature verified · already known to attempt 2 · sample');
});
