import { test as base, expect } from '@playwright/test';
import { readTrip } from './helpers';

/** Preserve returned state and browser errors even when an assertion fails. */
export const test = base.extend<{ evidence: void }>({
  evidence: [async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    const failedRequests: { url: string; error?: string }[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => failedRequests.push({
      url: r.url().replace(/client-id=[^&]+/, 'client-id=REDACTED'), error: r.failure()?.errorText,
    }));
    await use();
    let trip, readError;
    try { if (new URL(page.url()).searchParams.has('trip')) trip = await readTrip(page); }
    catch (error) { readError = String(error); }
    await testInfo.attach('trip-and-browser-errors', {
      body: JSON.stringify({ trip, readError, errors, failedRequests }, null, 2), contentType: 'application/json',
    });
    if (testInfo.status !== testInfo.expectedStatus)
      await testInfo.attach('failure-screen', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }, { auto: true }],
});
export { expect };
