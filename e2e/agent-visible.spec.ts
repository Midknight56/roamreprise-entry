import { test, expect } from './fixtures';
import { startTrip } from './helpers';
for (const mock of [true, false]) {
  test(`agent reasons strip and Scheduler tooltip (${mock ? 'mock sample' : 'real local server'})`, async ({ page }) => {
    const view = await startTrip(page, mock);
    await expect(page.locator('#why-weekend')).toContainText('Why this weekend');
    const words = view.itinerary.items.find(item => item.why);
    const source = view.log.find(step => step.tool === 'propose_itinerary')?.source;
    if (!mock && !['live', 'cached'].includes(source || '')) {
      await expect(page.locator('#why-weekend')).toContainText(words ? words.why! : 'Picked by the rules from your tastes.');
      test.info().annotations.push({ type: 'limitation', description: `AI source is ${source}; remote live or cached tooltip cannot be proven locally` });
      if (!words) return;
    }
    expect(words).toBeTruthy();
    const bar = page.locator(`[data-event-id="${words!.id}"]`).first();
    if (await bar.count()) {
      await bar.hover();
      await expect(page.locator('.schedule-tip')).toContainText('The AI said:');
    } else {
      await expect(page.locator('.schedule-event').filter({ hasText: /Viewpoint|Tile/ }).first()).toHaveAttribute('title', /The AI said:/);
    }
    if (mock) await expect(page.locator('#why-weekend')).toContainText('Sample');
  });
}

// These response fixtures test both AI source labels without remote inference.
for (const source of ['live', 'cached']) for (const schedule of ['bryntum', 'basic']) {
  test(`controlled ${source} response renders reasons in ${schedule} tooltip and strip`, async ({ page }) => {
    await page.route('**/api/trips', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      const view = await response.json();
      view.itinerary.items.find((item: any) => item.slot === 'd1-lunch').why = 'Explore food markets';
      view.log.find((step: any) => step.tool === 'propose_itinerary').source = source;
      await route.fulfill({ response, json: view });
    });
    const view = await startTrip(page);
    await expect(page.locator('#why-weekend')).toContainText('Explore food markets');
    if (schedule === 'basic') {
      await page.evaluate(async view => {
        // @ts-ignore Served browser module.
        const { BasicSchedule } = await import('/js/schedule-basic.js');
        const host = document.createElement('div'); host.id = 'controlled-basic';
        document.body.appendChild(host);
        new BasicSchedule(host).update(view);
      }, view);
      await expect(page.locator('#controlled-basic [data-schedule-key="d1-lunch"]')).toHaveAttribute('title', /The AI said: Explore food markets/);
    } else {
      await page.locator('[data-event-id="d1-lunch"]').first().hover();
      await expect(page.locator('.schedule-tip')).toContainText('The AI said: Explore food markets');
      await expect(page.locator('#why-weekend')).toContainText('Explore food markets');
      await expect(page.locator('#why-weekend .state-chip')).toContainText(['food markets']);
      const chip = await page.locator('#why-weekend .state-chip').filter({ hasText: 'food markets' }).boundingBox();
      const quote = await page.locator('#why-weekend q').first().boundingBox();
      expect(chip!.width).toBeLessThan(160);
      expect(Math.abs(chip!.y - quote!.y)).toBeLessThan(20);
      await page.locator('.schedule-card').screenshot({ path: `artifacts/j10/${source}-reasons.png` });
    }
  });
}

test('recorded viewer shows saved AI reasons and tooltips without changing the recording', async ({ page }) => {
  const { buildItinerary } = await import('../src/domain/planner');
  const plan = buildItinerary({ tastes: ['tile art', 'fado music', 'viewpoints', 'food markets'], note: '', ceilingCents: 60000 });
  plan.itinerary.items.find(item => item.slot === 'd1-lunch')!.why = 'Explore food markets';
  const view = { id: 'saved-reasons', phase: 'planned', tastes: ['food markets'], note: '', ceilingCents: 60000, itinerary: plan.itinerary, payments: [], log: [], issues: [], next: [] };
  await page.route('**/api/config', route => route.fulfill({ json: { liveAi: false, paypalClientId: '' } }));
  await page.route('**/data/recorded-run.json', route => route.fulfill({ json: { capturedAt: '2026-11-06', snapshots: [view] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Watch a recorded run', exact: true }).click();
  await expect(page.locator('#why-weekend')).toContainText('Explore food markets');
  await page.locator('[data-event-id="d1-lunch"]').first().hover();
  await expect(page.locator('.schedule-tip')).toContainText('The AI said: Explore food markets');
});
