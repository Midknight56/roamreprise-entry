// Real sandbox flow. No server is started and no API responses are substituted.
// Node 24+ executes the shared, erasable TypeScript helpers directly.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { idle, press, quote, hold, fault, readTrip, waitPhase, checkRepair, noHorizontalScroll, openPlanner } from '../e2e/helpers.ts';

const baseURL = process.env.RR_BASE || 'http://127.0.0.1:8811';
const recordedOnly = process.argv.includes('--recorded-only');
const report = recordedOnly
  ? JSON.parse(await readFile('shots/manifest.json', 'utf8'))
  : { at: new Date().toISOString(), baseURL, mode: 'real sandbox; live server assets and APIs', shots: [], errors: [], failedRequests: [], failures: [] };
if (recordedOnly) report.recordedSupplementAt = new Date().toISOString();
const browser = await chromium.launch({ channel: process.env.RR_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const directory = `shots/${width}`;
    await mkdir(directory, { recursive: true });
    const context = await browser.newContext({ baseURL, viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push({ width, type: 'pageerror', message: e.message }));
    page.on('console', m => { if (m.type() === 'error') report.errors.push({ width, type: 'console', message: m.text() }); });
    page.on('requestfailed', r => report.failedRequests.push({ width, url: r.url().replace(/client-id=[^&]+/, 'client-id=REDACTED'), error: r.failure()?.errorText }));
    async function prepareScreenshot() {
      await page.mouse.move(2, 2);
      await page.waitForTimeout(300);
    }
    async function shot(name, focus, animation = false) {
      if (!animation && await page.locator('#main').count()) await idle(page);
      if (focus === '#agent-log') await page.locator('#agent-log').evaluate(el => { el.open = true; });
      if (focus) await page.locator(focus).scrollIntoViewIfNeeded();
      else await page.evaluate(() => scrollTo(0, 0));
      await noHorizontalScroll(page);
      await prepareScreenshot();
      const path = `${directory}/${name}.png`;
      await page.screenshot({ path, animations: 'disabled' });
      report.shots.push({ path, phase: new URL(page.url()).searchParams.has('trip') ? (await readTrip(page)).phase : 'plan' });
    }
    try {
      if (!recordedOnly) {
      await openPlanner(page);
      await expect(page.locator('#tastes button')).toHaveCount(10);
      await shot('01-plan');
      await page.locator('#globe.globe-idle .idle-globe').waitFor({ state: 'visible', timeout: 20000 });
      await shot('02a-globe-idle', '#globe', true);
      await page.getByRole('button', { name: 'Plan my two days', exact: true }).click();
      await page.locator('#globe.globe-active canvas').waitFor({ state: 'visible', timeout: 90000 });
      await page.waitForTimeout(2700);
      await shot('02b-globe-landed', '#globe', true);
      await waitPhase(page, 'planned');
      await shot('03-itinerary', '#schedule');
      await shot('04-route-map', '#route-map');
      await shot('05-agent-log', '#agent-log');
      await quote(page); await shot('06-hold', '#pay-panel');
      await hold(page); await waitPhase(page, 'holding'); await shot('07-holding', '.money-panel');
      await press(page, 'Simulate: the hotel cancels our room');
      const pick = await checkRepair(page);
      await shot('08-repair-preview', '#repair-panel');
      const repairFull = `${directory}/08b-repair-full.png`;
      await prepareScreenshot();
      await page.locator('#repair-panel').screenshot({ path: repairFull, animations: 'disabled' });
      report.shots.push({ path: repairFull, phase: 'repair_proposed', kind: 'full repair panel' });
      await shot('09-repair-timeline', '#schedule');
      await press(page, `Use ${pick.name}`); await waitPhase(page, 'requote');
      await shot('10-money-follows', '.money-panel');
      const tripUrl = page.url();
      await page.getByRole('link', { name: 'All receipts', exact: true }).click();
      await expect(page.locator('.receipt-operation')).not.toHaveCount(0);
      await expect(page.locator('#receipts')).toContainText('VOIDED');
      await shot('11-void-receipt');
      await page.goto(tripUrl); await idle(page);
      await hold(page); await waitPhase(page, 'holding'); await shot('12-fresh-hold', '.money-panel');
      await press(page, 'Confirm bookings'); await waitPhase(page, 'confirmed_captured');
      await shot('13-captured', '.money-panel');
      await press(page, 'Simulate: the operator cancels an activity');
      let view = await waitPhase(page, ['refund_pending', 'refunded']);
      await shot('14-after-cancellation', '.money-panel');
      for (let n = 0; view.phase === 'refund_pending' && n < 3; n++) {
        await press(page, 'Check refund status'); view = await readTrip(page);
      }
      await shot('15-refund-status', '.money-panel');
      await page.getByRole('link', { name: 'All receipts', exact: true }).click();
      await expect(page.locator('.receipt-attempt')).toHaveCount(2);
      await shot('16-receipt-page');
      const receiptFull = `${directory}/16b-receipts-full.png`;
      await prepareScreenshot();
      await page.screenshot({ path: receiptFull, fullPage: true, animations: 'disabled' });
      report.shots.push({ path: receiptFull, phase: view.phase, kind: 'full receipts page' });

      await openPlanner(page); await press(page, 'Plan my two days'); await quote(page);
      await page.locator('.failure-paths summary').click();
      await press(page, 'Try a declined card'); await waitPhase(page, 'declined');
      await shot('17-declined', '.money-panel');
      await fault(page, 'lose_next_response'); await hold(page); await waitPhase(page, 'checking_payment');
      await shot('18-checking-payment', '.money-panel');
      await press(page, 'Check payment'); await waitPhase(page, 'holding');
      // Close the outstanding screenshot-only authorization with a real void.
      await press(page, 'Simulate: the hotel cancels our room'); const cleanupPick = await checkRepair(page);
      await press(page, `Use ${cleanupPick.name}`); await waitPhase(page, 'requote');

      }
    } catch (error) {
      report.failures.push({ width, message: error.stack || String(error) });
      await prepareScreenshot();
      await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
    } finally {
      // Recorded viewing is independent of payment recovery. Still photograph it
      // when a preceding real sandbox scenario failed.
      try {
        await openPlanner(page); await press(page, 'Watch a recorded run', true);
        if (await page.locator('#recorded-banner').isVisible()) {
          await expect(page.locator('#recorded-banner')).toContainText('No PayPal request is sent.');
          await shot('19-recorded-run', '#recorded-banner');
        } else {
          await shot('19-recorded-unavailable', '#error');
          report.failures.push({ width, screen: 'recorded-run', message: await page.locator('#error').innerText() });
        }
      } catch (error) {
        report.failures.push({ width, screen: 'recorded-run', message: String(error) });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await mkdir('shots', { recursive: true });
  await writeFile('shots/manifest.json', JSON.stringify(report, null, 2));
  await writeFile('shots/index.html', `<!doctype html><meta charset="utf-8"><title>J4 real sandbox screens</title><style>body{font:16px system-ui;margin:24px}img{max-width:100%;border:1px solid #ddd}article{margin-bottom:32px}</style><h1>Real sandbox screens</h1><p>${report.at}</p><a href="manifest.json">Manifest, actual phases and errors</a>${report.shots.map(s => `<article><h2>${s.path} (${s.phase})</h2><a href="${s.path.replace('shots/', '')}"><img src="${s.path.replace('shots/', '')}"></a></article>`).join('')}`);
}
console.log(JSON.stringify({ shots: report.shots.length, failures: report.failures, errors: report.errors }, null, 2));
if (report.failures.length) process.exitCode = 1;
