import { chromium } from '@playwright/test';

const base = process.env.RR_BASE;
if (!base) throw new Error('Set RR_BASE to the running RoamReprise URL.');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--window-position=-1900,1100', '--window-size=1400,900'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  let tripId;
  let orderResult;
  page.on('response', async (response) => {
    if (!response.url().includes('/pay/order')) return;
    let body = {};
    try { body = await response.json(); } catch {}
    orderResult = { status: response.status(), orderId: body.orderId };
  });

  await page.goto(base);
  await page.getByRole('button', { name: 'Plan my two days' }).click();
  await page.getByRole('heading', { name: 'Your trip, your approval.' }).waitFor();
  await page.getByRole('button', { name: 'Approve quote' }).click();
  await page.locator('#pay-panel .paypal-box').waitFor();
  tripId = new URL(page.url()).searchParams.get('trip');
  if (!tripId) throw new Error('Could not read the planned trip id from the page URL.');

  const popupPromise = page.waitForEvent('popup');
  await page.frameLocator('iframe[title*="PayPal"]').getByRole('button').first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  console.log(`PayPal popup host: ${new URL(popup.url()).host}`);

  const orderDeadline = Date.now() + 30_000;
  while (!orderResult && Date.now() < orderDeadline) await page.waitForTimeout(250);
  if (!orderResult) throw new Error('No pay/order response was observed within 30 seconds.');
  console.log(`pay/order HTTP status: ${orderResult.status}`);
  console.log(`PayPal order id: ${orderResult.orderId ?? '(missing from response)'}`);

  const deadline = Date.now() + 180_000;
  let trip;
  while (Date.now() < deadline) {
    const response = await context.request.get(`${new URL(base).origin}/api/trips/${encodeURIComponent(tripId)}`);
    if (response.ok()) {
      trip = await response.json();
      const authorized = trip.payments?.some((payment) => payment.method === 'paypal' && payment.state === 'authorized');
      if (authorized) break;
    }
    await page.waitForTimeout(2_000);
  }
  const payment = trip?.payments?.find((item) => item.method === 'paypal');
  console.log(`Final payment state: ${payment?.state ?? 'not authorized before timeout'}`);
  console.log(`Authorization id: ${payment?.authorizationId ?? '(none)'}`);
  console.log(`Receipts: ${JSON.stringify(payment?.receipts ?? [], null, 2)}`);
} finally {
  await browser.close();
}
