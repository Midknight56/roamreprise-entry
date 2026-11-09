import { test, expect } from './fixtures';
import { eventLabels, startTrip } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

test('desktop itinerary names every stop without clipping', async ({ page }) => {
  await startTrip(page);
  await eventLabels(page, 'horizontal');
});

for (const view of ['bryntum', 'basic']) {
  test(`${view} short bars keep times inside and separate overlapping labels`, async ({ page }) => {
    const trip = await startTrip(page, true);
    await page.evaluate(async ({ trip, view }) => {
      const host = document.createElement('div');
      host.id = 'lane-check'; host.style.width = '1100px';
      document.querySelector('body')!.appendChild(host);
      // Put two short stops close enough to require a second label row.
      trip.itinerary.items = trip.itinerary.items.filter(i => i.kind === 'transfer').map((i, n) => ({
        ...i, day: 0, start: n ? '09:20' : '09:00', end: n ? '09:50' : '09:15', bufferMin: 0,
      }));
      if (view === 'basic') {
        // @ts-ignore Served browser module.
        const { BasicSchedule } = await import('/js/schedule-basic.js');
        new BasicSchedule(host).update(trip);
      } else {
        // @ts-ignore Served browser module.
        const { BryntumSchedule } = await import('/js/schedule-bryntum.js');
        // @ts-ignore Served vendor module.
        const vendor = await import('/vendor/bryntum/scheduler/scheduler.module.js');
        await new BryntumSchedule(host, vendor).update(trip);
      }
    }, { trip, view });
    const labels = page.locator('#lane-check .rr-short-name.compact');
    await expect(labels).toHaveCount(2);
    await expect(labels).toHaveText(['Airport car', 'Airport car']);
    const boxes = await labels.evaluateAll(es => es.map(e => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, width: e.clientWidth, scroll: e.scrollWidth };
    }));
    expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[1].top);
    for (const box of boxes) expect(box.scroll).toBeLessThanOrEqual(box.width);
    const times = await page.locator('#lane-check .rr-bar-time').evaluateAll(es => es.map(e => {
      const r = e.getBoundingClientRect(), bar = e.closest('.rr-event,.schedule-event')!.getBoundingClientRect();
      return { text: e.textContent, inside: r.left >= bar.left && r.right <= bar.right && r.top >= bar.top && r.bottom <= bar.bottom };
    }));
    expect(times.map(t => t.text)).toEqual(['09:00', '09:20']);
    expect(times.every(t => t.inside)).toBe(true);
  });
}

