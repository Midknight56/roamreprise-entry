import { test, expect } from './fixtures';
import { startTrip, quote, hold, press, waitPhase, checkRepair, receiptPage, watchErrors, idle } from './helpers';
import type { Page } from '@playwright/test';
import type { TripView } from '../src/domain/types';

const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
async function checkMandate(page: Page, view: TripView) {
  const authorized = [...view.payments].reverse().find(payment => !!payment.authorizationId);
  const captured = view.payments.filter(payment => payment.state === 'captured');
  const refunded = view.payments.flatMap(payment => payment.refunds).filter(refund => refund.state === 'completed');
  await expect(page.locator('.mandate-strip li')).toHaveText([
    `You allow up to ${usd(view.ceilingCents)}`,
    `Agent proposes ${usd(view.quote?.totalCents ?? view.itinerary.totalCents)}`,
    `PayPal holds${authorized ? ` ${usd(authorized.amountCents)}` : ''}`,
    `Captured${captured.length ? ` ${usd(captured.reduce((sum, payment) => sum + payment.amountCents, 0))}` : ''} when every booking is confirmed`,
    `Refunded${refunded.length ? ` ${usd(refunded.reduce((sum, refund) => sum + refund.amountCents, 0))}` : ''} when an activity was cancelled`,
  ]);
}

test('mock mode shows mandate and money story through every phase and recorded viewer without /api calls', async ({ page }, testInfo) => {
  const requests: string[] = [], errors = watchErrors(page);
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api')) requests.push(r.url()); });
  const initial = await startTrip(page, true);
  await checkMandate(page, initial);
  await expect(page.locator('.mandate-strip .unreached')).toHaveCount(3);
  await expect(page.locator('#money-story-chips')).toBeHidden();
  await quote(page);
  await page.locator('.failure-paths summary').click();
  await press(page, 'Try a declined card'); await waitPhase(page, 'declined');
  // The scripted mock requires re-approving after a decline.
  await quote(page);
  await page.locator('.failure-paths summary').click();
  await press(page, 'Try a lost payment response'); await waitPhase(page, 'checking_payment');
  await press(page, 'Check payment'); await waitPhase(page, 'holding');
  await expect(page.getByRole('group', { name: 'Simulated tour operator' })).toContainText('Simulate: the hotel cancels our room');
  await press(page, 'Simulate: the hotel cancels our room'); const pick = await checkRepair(page);
  await press(page, `Use ${pick.name}`); const changed = await waitPhase(page, 'requote');
  await checkMandate(page, changed);
  await expect(page.locator('#money-story-chips')).toContainText(`Voided ${usd(changed.payments.at(-1)!.amountCents)}. Nothing charged.`);
  await hold(page); await waitPhase(page, 'holding');
  await press(page, 'Confirm bookings'); const paid = await waitPhase(page, 'confirmed_captured');
  await checkMandate(page, paid);
  await press(page, 'Simulate: the operator cancels an activity'); const pending = await waitPhase(page, 'refund_pending');
  await checkMandate(page, pending);
  await expect(page.locator('#money-story-chips')).toContainText(`Charged in total: ${usd(paid.payments.at(-1)!.amountCents)}`);
  await press(page, 'Check refund status'); const view = await waitPhase(page, 'refunded');
  await checkMandate(page, view);
  const net = view.payments.filter(payment => payment.state === 'captured').reduce((sum, payment) => sum + payment.amountCents, 0)
    - view.payments.flatMap(payment => payment.refunds).filter(refund => refund.state === 'completed').reduce((sum, refund) => sum + refund.amountCents, 0);
  await expect(page.locator('#money-story-chips')).toContainText(`Charged in total: ${usd(net)}`);
  await expect(page.locator('#money-story-chips')).toHaveCSS('flex-direction', 'row');
  await page.locator('.money-panel').screenshot({ path: testInfo.outputPath('mandate-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.money-panel').screenshot({ path: testInfo.outputPath('mandate-phone.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await receiptPage(page, view);
  await expect(page.locator('#money-story')).toContainText(`Charged in total: ${usd(net)}.`);
  await expect(page.locator('#money-story')).toContainText('That hold was voided and nothing was charged.');
  await page.locator('#money-story-panel').screenshot({ path: testInfo.outputPath('money-story-receipt.png') });
  await expect(page.getByRole('heading', { name: 'Webhooks from PayPal' })).toHaveCount(view.payments.length);
  await expect(page.locator('.receipt-webhook')).toHaveCount(2);
  await expect(page.locator('.receipt-webhook').first()).toContainText('sample');
  await page.goto('/?mock=1'); await press(page, 'Watch a recorded run');
  await expect(page.locator('#recorded-banner')).toContainText('No PayPal request is sent.');
  while (await page.locator('#recorded-next').isEnabled()) await press(page, 'Next step');
  await expect(page.locator('#recorded-step')).toHaveText('9 / 9');
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('mock Scheduler resizes from desktop to phone and back without errors', async ({ page }) => {
  const errors = watchErrors(page);
  await startTrip(page, true);
  for (const [width, mode] of [[1280, 'horizontal'], [390, 'vertical'], [1280, 'horizontal']] as const) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.locator('#schedule').evaluate(async element => {
      // @ts-ignore Browser vendor module.
      const { Widget } = await import('/vendor/bryntum/scheduler/scheduler.module.js');
      return Widget.fromElement(element.firstElementChild)?.mode;
    })).toBe(mode);
    await expect(page.locator('#schedule .rr-event').first()).toBeVisible();
    expect(errors).toEqual([]);
  }
});

for (const engine of ['bryntum', 'basic'] as const) {
  for (const reduced of [false, true]) {
    test(`${engine} repair preview ${reduced ? 'honours reduced motion' : 'slides and settles'}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await startTrip(page, true);
      if (engine === 'basic') {
        await page.goto(`${page.url()}&schedule=basic`);
        await idle(page);
      }
      await expect(page.locator('#schedule')).toHaveAttribute('data-view', engine);
      await quote(page); await hold(page); await waitPhase(page, 'holding');
      await press(page, 'Simulate: the hotel cancels our room');
      const trip = await waitPhase(page, 'repair_proposed');
      const alternate = trip.repair!.candidates.find(c => c.checks.ok && c.id !== trip.repair!.pickId)!;
      // Both mock candidates move this stop, to different times.
      await page.waitForTimeout(750);
      const result = await page.evaluate(async ({ candidateId, engine }) => {
        const container = document.querySelector('#schedule')!;
        let widget: any;
        if (engine === 'bryntum') {
          // @ts-ignore Browser vendor module.
          const { Widget } = await import('/vendor/bryntum/scheduler/scheduler.module.js');
          widget = Widget.fromElement(container.firstElementChild);
        }
        const record = widget?.eventStore.getById('d1-late');
        const element = () => engine === 'basic'
          ? container.querySelector('[data-schedule-key="d1-late"]')!
          : widget.getElementFromEventRecord(widget.eventStore.getById('d1-late'));
        const originalElement = element();
        const left = () => element().getBoundingClientRect().left;
        const before = left();
        (document.querySelector(`[data-candidate="${candidateId}"]`) as HTMLButtonElement).click();
        const samples: number[] = [];
        for (let i = 0; i < 10; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          samples.push(left());
        }
        const ghost = container.querySelector('.ghost')!;
        const failed = container.querySelector('.kind-lodging.state-failed')!;
        return {
          before, samples,
          same: engine === 'basic' ? element() === originalElement : widget.eventStore.getById('d1-late') === record,
          duration: widget?.transitionDuration,
          ghostAnimation: getComputedStyle(ghost).animationName,
          failedAnimation: getComputedStyle(failed).animationName,
        };
      }, { candidateId: alternate.id, engine });
      await testInfo.attach('animation-samples', {
        body: JSON.stringify(result, null, 2), contentType: 'application/json',
      });
      expect(result.same).toBe(true);
      expect(Math.abs(result.before - result.samples.at(-1)!)).toBeGreaterThan(1);
      expect(Math.abs(result.samples[8] - result.samples[9])).toBeLessThan(.1);
      if (reduced) {
        expect(Math.abs(result.samples[0] - result.samples[1])).toBeLessThan(.1);
        expect(result.ghostAnimation).toBe('none');
        expect(result.failedAnimation).toBe('none');
        if (engine === 'bryntum') expect(result.duration).toBe(0);
      } else {
        expect(Math.abs(result.samples[0] - result.samples[1])).toBeGreaterThan(.1);
        expect(result.ghostAnimation).toContain('rr-ghost-in');
        expect(result.failedAnimation).toContain('rr-hotel-failed');
      }
    });
  }
}
