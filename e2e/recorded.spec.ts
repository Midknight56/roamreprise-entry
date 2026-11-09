import { test, expect } from './fixtures';
import { press, phoneLayout, startTrip, quote, hold, waitPhase } from './helpers';
import { buildItinerary, DEFAULT_TASTES } from '../src/domain/planner';

test.use({ viewport: { width: 390, height: 844 } });
test('static recording plays offline with phone spacing and no API or PayPal calls', async ({ page }) => {
  const { itinerary } = buildItinerary({ tastes: [...DEFAULT_TASTES], note: '', ceilingCents: 60000 });
  const view = { id: 'recorded-trip', phase: 'planned', tastes: DEFAULT_TASTES, note: '', ceilingCents: 60000, itinerary, payments: [], log: [], issues: [], next: [] };
  await page.route('**/api/config', route => route.fulfill({ json: { liveAi: false, paypalClientId: '' } }));
  await page.route('**/data/recorded-run.json', route => route.fulfill({ json: { capturedAt: '2026-11-06', build: 'test', snapshots: [view, { ...view, phase: 'quoted' }] } }));
  await page.goto('/');
  await expect(page.locator('#watch-recorded')).toBeVisible();
  await phoneLayout(page);
  await page.locator('#planner').screenshot({ path: 'artifacts/j6/phone-planner.png' });
  const requests: string[] = [];
  page.on('request', r => { if (/\/api\/|paypal\.com/.test(r.url())) requests.push(r.url()); });
  await press(page, 'Watch a recorded run');
  await expect(page.locator('#recorded-step')).toHaveText('1 / 2');
  await press(page, 'Next step'); await expect(page.locator('#recorded-step')).toHaveText('2 / 2');
  await expect(page.locator('#pay-panel button,#actions button,#repair-panel button')).toHaveCount(0);
  await press(page, 'Previous step'); await expect(page.locator('#recorded-step')).toHaveText('1 / 2');
  expect(requests).toEqual([]);
});

test('missing static recording hides Watch recorded without an error panel', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { liveAi: false, paypalClientId: '' } }));
  await page.route('**/data/recorded-run.json', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('#watch-recorded')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();
});

test('phone repair preview and Use buttons keep at least 12px between them', async ({ page }) => {
  await startTrip(page, true); await quote(page); await hold(page);
  await press(page, 'Simulate: the hotel cancels our room'); await waitPhase(page, 'repair_proposed');
  await phoneLayout(page);
  const buttons = page.locator('.candidate.selected button');
  const preview = await buttons.nth(0).boundingBox(), accept = await buttons.nth(1).boundingBox();
  expect(accept!.y - preview!.y - preview!.height).toBeGreaterThanOrEqual(12);
  await page.locator('.candidate.selected').screenshot({ path: 'artifacts/j6/phone-repair.png' });
});
