// Node 24+. The owner runs this against the live sandbox site with RR_BASE set.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { idle, press, readTrip, waitPhase } from '../e2e/helpers.ts';

const OUT = new URL('../video/raw/', import.meta.url);
const DESK = { width: 1280, height: 720 }, PHONE = { width: 390, height: 844 };
const LENGTHS = [7, 10, 13, 15, 15, 8, 12, 25, 15, 12, 13, 10, 8, 7];
const marks = { desk: {}, phone: {}, rects: {}, facts: {}, beats: {} };
let browser, page, context, sceneName, started, beat = 1, tripUrl;
const save = () => writeFile(new URL('marks.json', OUT), JSON.stringify(marks, null, 2) + '\n');
const seconds = () => Number(((performance.now() - started) / 1000).toFixed(3));
const pause = (ms = 1500) => page.waitForTimeout(ms);
const usd = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

// Film cursor only. No site files, app state or API responses are changed.
function cursor() {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;border-radius:50%;background:#1F6F8B99;border:2px solid white;box-sizing:border-box;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0';
    document.body.append(dot);
    addEventListener('mousemove', e => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; dot.style.opacity = '1'; });
    addEventListener('mousedown', () => dot.animate([
      { boxShadow: '0 0 0 0 #1F6F8Baa' }, { boxShadow: '0 0 0 18px #1F6F8B00' },
    ], { duration: 450 }));
  });
}

async function focus(target) {
  const locator = typeof target === 'string' ? page.locator(target).first() : target;
  await locator.waitFor({ state: 'visible' });
  await locator.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(1500);
  return locator;
}
async function mark(name, target) {
  const locator = typeof target === 'string' ? page.locator(target).first() : target;
  // Clip a large panel to what the viewer can actually see at this scroll position.
  const rect = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    return { x: x / innerWidth, y: y / innerHeight,
      w: (Math.min(innerWidth, r.right) - x) / innerWidth,
      h: (Math.min(innerHeight, r.bottom) - y) / innerHeight };
  });
  if (rect.w <= 0 || rect.h <= 0) throw new Error(`Focus outside viewport: ${name}`);
  marks[sceneName][name] = [seconds()];
  marks.rects[name] = rect;
  await save();
}
async function move(target) {
  await focus(target);
  const r = await target.boundingBox();
  if (!r) throw new Error('Target has no rectangle');
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 25 });
}
async function click(name, label, about = '.money-panel') {
  const target = page.getByRole('button', { name, exact: typeof name === 'string' });
  await move(target);
  await mark(label, about);
  await press(page, name);
  await pause();
}
async function facts() {
  const trip = await readTrip(page);
  // Deliberate allowlist: never serialize TripView, storageState, cookies or config.
  marks.facts = { ...marks.facts, tripId: trip.id, ceiling: usd(trip.ceilingCents),
    holdAmounts: trip.payments.map(p => usd(p.amountCents)),
    voidedAmounts: trip.payments.filter(p => p.state === 'voided').map(p => usd(p.amountCents)),
    capturedAmounts: trip.payments.filter(p => p.state === 'captured' || p.previousState === 'captured').map(p => usd(p.amountCents)),
    refundAmounts: trip.payments.flatMap(p => p.refunds.map(r => usd(r.amountCents))),
    paypal: trip.payments.flatMap(p => [
      ...[['order', p.orderId], ['authorization', p.authorizationId], ['capture', p.captureId]].filter(([, id]) => id).map(([kind, id]) => ({
        kind, id, status: p.receipts.filter(r => ({
          order: ['create', 'authorize', 'read_order'],
          authorization: ['void', 'read_authorization'],
          capture: ['capture', 'read_capture'],
        })[kind].includes(r.op)).at(-1)?.paypalStatus || p.state,
      })),
      ...p.refunds.filter(r => r.id).map(r => ({ kind: 'refund', id: r.id, status: r.state })),
    ]),
  };
  await save();
  return trip;
}
async function runBeat(n, fn) {
  beat = n;
  const begin = seconds();
  await fn();
  // Leave real footage to trim, without letting the next beat leak into this one.
  await pause(Math.max(1500, (LENGTHS[n - 1] + 3 - (seconds() - begin)) * 1000));
  marks.beats[n] = { scene: sceneName, start: begin, end: seconds() };
  await save();
}
async function tooltip(selector, words, label) {
  const bars = page.locator(selector);
  for (let i = 0; i < await bars.count(); i++) {
    await move(bars.nth(i));
    const tip = page.locator('.b-tooltip:visible').filter({ hasText: words });
    try {
      await tip.first().waitFor({ state: 'visible', timeout: 2500 });
      await mark(label, '#schedule'); await pause(2500); return;
    } catch { await page.mouse.move(5, 5, { steps: 25 }); }
  }
  throw new Error(`No Bryntum tooltip with ${words}`);
}
async function scene(name, viewport, state, fn) {
  sceneName = name;
  started = performance.now();
  context = await browser.newContext({ baseURL: process.env.RR_BASE, viewport,
    recordVideo: { dir: fileURLToPath(OUT), size: viewport },
    colorScheme: 'light', ...(state ? { storageState: state } : {}) });
  await context.addInitScript(cursor);
  page = await context.newPage();
  page.setDefaultTimeout(90000);
  const video = page.video();
  try { return await fn(); }
  catch (error) {
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', OUT)) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    if (video) await rename(await video.path(), new URL(`${name}.webm`, OUT));
    await save();
  }
}

await mkdir(OUT, { recursive: true });
try {
  if (!process.env.RR_BASE) throw new Error('RR_BASE must be set');
  const url = new URL(process.env.RR_BASE);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('RR_BASE must be an HTTP origin without credentials or query');
  browser = await chromium.launch({ channel: process.env.RR_BROWSER_CHANNEL || 'chrome', headless: true });
  const state = await scene('desk', DESK, null, async () => {
    await runBeat(1, async () => {
      const config = page.waitForResponse(r => new URL(r.url()).pathname === '/api/config');
      await page.goto('/');
      const response = await config;
      if (!response.ok()) throw new Error(`/api/config HTTP ${response.status()}`);
      await response.finished();
      await page.locator('#globe.globe-idle .idle-globe').waitFor({ state: 'visible' });
      await focus('#globe'); await mark('b1-idle', '#globe'); await pause(3000);
      const flyMark = page.locator('#globe.globe-active canvas').waitFor({ state: 'visible' }).then(async () => {
        const rect = await page.locator('#globe').evaluate(el => {
          const r = el.getBoundingClientRect();
          const x = Math.max(0, r.left), y = Math.max(0, r.top);
          return { x: x / innerWidth, y: y / innerHeight,
            w: (Math.min(innerWidth, r.right) - x) / innerWidth,
            h: (Math.min(innerHeight, r.bottom) - y) / innerHeight };
        });
        if (rect.w <= 0 || rect.h <= 0) throw new Error('Focus outside viewport: b1-fly');
        marks.desk['b1-fly'] = [seconds()];
        marks.rects['b1-fly'] = rect;
        await save();
      });
      await click(/^Plan my two days/, 'b1-plan-click', '#globe');
      await flyMark;
      await waitPhase(page, 'planned'); await focus('#map-stage');
      await mark('b1-landed', '#map-stage'); await facts(); tripUrl = page.url();
    });
    await runBeat(2, async () => { await focus('#schedule'); await expect(page.locator('#schedule')).toHaveAttribute('data-view', 'bryntum'); await mark('b2-map', '.workspace'); });
    await runBeat(3, async () => {
      await focus('#why-weekend'); await mark('b3-why', '#why-weekend'); await pause(2500);
      await tooltip('#schedule .rr-event:not(.ghost):not(.rr-stay)', 'The AI said', 'b3-tooltip');
    });
    await runBeat(4, async () => {
      await click('Approve quote', 'b4-quote-click'); await waitPhase(page, 'quoted');
      await click('Make Sunday morning slower', 'b4-chip-click', '#ask-panel');
      await click('Ask the agent', 'b4-ask-click', '#ask-panel');
      await expect(page.locator('#phase-summary')).toContainText('The quote changed to');
      await focus('.money-panel'); await mark('b4-changed', '.money-panel');
      const text = await page.locator('#phase-summary').innerText();
      marks.facts.quoteChanged = text.match(/The quote changed to (\$[\d,]+(?:\.\d{2})?)/)?.[1];
      if (!marks.facts.quoteChanged) throw new Error('Changed quote amount missing');
      await pause(2500); await facts();
    });
    const hold = /^Hold .* with sandbox test card \(no sign in\)$/;
    await runBeat(5, async () => {
      await click('Approve quote', 'b5-quote-click'); await waitPhase(page, 'quoted');
      await click(hold, 'b5-hold-click'); await waitPhase(page, 'holding');
      await focus('#mandate'); await mark('b5-held', '.money-panel'); await facts();
    });
    await runBeat(6, () => tooltip('#schedule .rr-event.state-held:not(.rr-stay)', 'Simulated supplier', 'b6-tooltip'));
    await runBeat(7, async () => {
      // Move first; keep the hotel visible while the request is in flight.
      const button = page.getByRole('button', { name: 'Simulate: the hotel cancels our room', exact: true });
      await move(button); await mark('b7-cancel-click', '.money-panel');
      await button.click();
      // Get the band on camera before the response starts its 900 ms pulse.
      await page.locator('#schedule').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await pause(1500); await mark('b7-hotel', '#schedule'); await pause(2500);
    });
    await runBeat(8, async () => {
      const trip = await waitPhase(page, 'repair_proposed');
      await expect(page.locator('.candidate.rejected')).toHaveCount(2);
      await focus('#repair-panel'); await mark('b8-repair', '#repair-panel');
      for (let i = 0; i < await page.locator('.candidate').count(); i++) {
        await focus(page.locator('.candidate').nth(i)); await mark(`b8-card-${i}`, page.locator('.candidate').nth(i)); await pause();
      }
      const pick = trip.repair.candidates.find(c => c.id === trip.repair.pickId);
      if (!pick?.checks.ok) throw new Error('Repair pick is not checked');
      // Replay a preview selection, without accepting a repair, so the camera
      // sees the in-place transition as well as the automatically selected pick.
      const alternate = trip.repair.candidates.find(c => c.checks.ok && c.id !== pick.id);
      if (alternate) {
        for (const [candidate, label] of [[alternate, 'b8-alternate-click'], [pick, 'b8-pick-click']]) {
          const button = page.locator(`[data-candidate="${candidate.id}"]`);
          await move(button); await mark(label, '#repair-panel'); await button.click();
          await page.locator('#schedule').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await pause(1500);
        }
      }
      await expect(page.locator('[data-accept]')).toHaveAttribute('data-accept', pick.id);
      await focus('#schedule'); await expect(page.locator('#schedule .ghost').first()).toBeVisible();
      await expect(page.locator('#schedule .preview').first()).toBeVisible();
      await mark('b8-preview', '#schedule'); await pause(4000);
    });
    await runBeat(9, async () => {
      const trip = await readTrip(page), pick = trip.repair.candidates.find(c => c.id === trip.repair.pickId);
      await click(`Use ${pick.name}`, 'b9-use-click', '#repair-panel'); await waitPhase(page, 'requote');
      await focus('#money-story-chips'); await expect(page.locator('#money-story-chips')).toContainText('Voided');
      await mark('b9-voided', '.money-panel'); await pause(); await facts();
      await click(hold, 'b9-hold-click'); await waitPhase(page, 'holding');
      await focus('#mandate'); await mark('b9-held', '.money-panel'); await facts();
    });
    await runBeat(10, async () => {
      await click('Confirm bookings', 'b10-confirm-click'); await waitPhase(page, 'confirmed_captured');
      await focus('#mandate'); await mark('b10-captured', '.money-panel'); await facts();
    });
    await runBeat(11, async () => {
      await click('Simulate: the operator cancels an activity', 'b11-cancel-click');
      let trip = await waitPhase(page, ['refund_pending', 'refunded']);
      await focus('.money-panel');
      if (trip.phase === 'refund_pending') {
        await expect(page.locator('#phase-summary')).toContainText('pending'); await mark('b11-pending', '.money-panel');
      }
      for (let i = 0; trip.phase === 'refund_pending' && i < 8; i++) {
        await pause(8000); await click('Check refund status', `b11-check-${i}-click`); trip = await readTrip(page);
      }
      if (trip.phase !== 'refunded') throw new Error('Refund not completed after 8 checks');
      await expect(page.locator('#phase-summary')).toContainText('completed');
      await mark('b11-completed', '.money-panel'); await facts();
    });
    await runBeat(12, async () => {
      const link = page.getByRole('link', { name: 'All receipts', exact: true });
      await move(link); await link.click();
      await page.locator('.receipt-attempt').first().waitFor({ state: 'visible' });
      await focus('#money-story-panel'); await mark('b12-receipts', '#money-story-panel');
      await mark('b12-story', '#money-story-panel'); await pause(3000);
      await focus(page.getByRole('heading', { name: 'Webhooks from PayPal', exact: true }).first());
      for (let i = 0; !(await page.locator('.receipt-webhook').count()) && i < 12; i++) {
        await pause(10000); await mark(`b12-reload-${i}`, '.receipt-webhooks');
        await page.reload(); await page.locator('.receipt-attempt').first().waitFor({ state: 'visible' });
      }
      if (!(await page.locator('.receipt-webhook').count())) throw new Error('No verified webhook after 12 reloads');
      await focus(page.locator('.receipt-webhook').first()); await mark('b12-webhooks', page.locator('.receipt-webhook').first()); await facts();
    });
    await runBeat(14, async () => {
      const rows = page.locator('.receipt-attempt h2, .receipt-ids');
      await focus(rows.first()); await mark('b14-ids', rows.first());
      // One continuous five second pass fits inside the seven second final shot.
      // Start at the first attempt and pass every operation and refund to the end.
      await rows.last().evaluate(async last => {
        const from = scrollY;
        const to = Math.min(document.documentElement.scrollHeight - innerHeight,
          last.getBoundingClientRect().bottom + scrollY - innerHeight * .75);
        const started = performance.now();
        await new Promise(resolve => {
          function frame(now) {
            const p = Math.min(1, (now-started)/4800);
            scrollTo(0, from+(to-from)*p);
            if (p < 1) requestAnimationFrame(frame); else resolve();
          }
          requestAnimationFrame(frame);
        });
      });
      await mark('b14-end', rows.last()); await pause();
      await facts();
    });
    return context.storageState();
  });
  await scene('phone', PHONE, state, async () => {
    await runBeat(13, async () => {
      await page.goto(tripUrl); await idle(page);
      await expect(page.locator('#schedule')).toHaveAttribute('data-view', 'bryntum');
      await focus('#schedule'); await mark('phone-start', '#schedule'); await pause();
      // Vertical mode may use a different internal scroll element across views.
      const scrolled = await page.locator('#schedule').evaluate(async schedule => {
        const candidates = [...schedule.querySelectorAll('*')]
          .map(el => ({ el, style: getComputedStyle(el), range: el.scrollHeight - el.clientHeight }))
          .filter(x => (x.style.overflowY === 'auto' || x.style.overflowY === 'scroll') && x.range > 0)
          .sort((a, b) => b.range - a.range);
        const target = candidates[0]?.el;
        const from = target ? target.scrollTop : scrollY;
        const to = target ? target.scrollHeight - target.clientHeight
          : Math.max(0, schedule.getBoundingClientRect().bottom + scrollY - innerHeight);
        const started = performance.now();
        await new Promise(resolve => {
          function frame(now) {
            const p = Math.min(1, (now - started) / 4200);
            if (target) target.scrollTop = from + (to - from) * p;
            else scrollTo(0, from + (to - from) * p);
            if (p < 1) requestAnimationFrame(frame); else resolve();
          }
          requestAnimationFrame(frame);
        });
        return Boolean(target);
      });
      await mark('phone-end', '#schedule'); await pause(3000);
    });
  });
} catch (error) {
  marks.failure = { beat };
  console.error(`FAILED beat ${beat}: ${String(error.message || error).split(/\r?\n/)[0]}`);
  process.exitCode = 1;
} finally {
  await save();
  if (browser) await browser.close();
}
