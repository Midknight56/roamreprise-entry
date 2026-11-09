// Node 24+. Records the round 2 film from the live sandbox site with RR_BASE set.
// One real run, in time order. dev/film_timeline.py then cuts it into the 14 beats of docs/FILM.md
// (the film opens on the failure, so beats 1 and 2 are recorded after beats 3 to 5).
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { idle, press, readTrip, waitPhase } from '../e2e/helpers.ts';

const OUT = new URL('../video/raw/', import.meta.url);
const DESK = { width: 1280, height: 720 }, PHONE = { width: 390, height: 844 };
const marks = { desk: {}, phone: {}, rects: {}, facts: {}, beats: {} };
let browser, page, context, sceneName, started, beat = 0, tripUrl;
const save = () => writeFile(new URL('marks.json', OUT), JSON.stringify(marks, null, 2) + '\n');
const seconds = () => Number(((performance.now() - started) / 1000).toFixed(3));
const pause = (ms = 1500) => page.waitForTimeout(ms);
const usd = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const HOLD = /^Hold .* with card \(no sign in\)$/;

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

const loc = target => typeof target === 'string' ? page.locator(target).first() : target;
async function focus(target, block = 'center') {
  const locator = loc(target);
  await locator.waitFor({ state: 'visible' });
  await locator.evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block }), block);
  await pause(1500);
  return locator;
}
// A mark is a time in the scene's video plus the visible rectangle the film crops to.
async function mark(name, target) {
  const rect = await loc(target).evaluate(el => {
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
    repairPolicy: trip.repairPolicy ?? 'lowest_total',
    holdAmounts: trip.payments.map(p => usd(p.amountCents)),
    voidedAmounts: trip.payments.filter(p => p.state === 'voided').map(p => usd(p.amountCents)),
    capturedAmounts: trip.payments.filter(p => p.state === 'captured' || p.previousState === 'captured').map(p => usd(p.amountCents)),
    refundAmounts: trip.payments.flatMap(p => p.refunds.filter(r => r.state === 'completed').map(r => usd(r.amountCents))),
    refundCents: trip.payments.flatMap(p => p.refunds.filter(r => r.state === 'completed').map(r => r.amountCents)),
    capturedCents: trip.payments.filter(p => p.state === 'captured' || p.previousState === 'captured').map(p => p.amountCents),
    paypal: trip.payments.flatMap(p => [
      ...[['order', p.orderId], ['authorization', p.authorizationId], ['capture', p.captureId]].filter(([, id]) => id).map(([kind, id]) => ({ kind, id })),
      ...p.refunds.filter(r => r.id).map(r => ({ kind: 'refund', id: r.id, status: r.state })),
    ]),
  };
  if (trip.repair?.candidates?.length) {
    marks.facts.candidates = trip.repair.candidates.map(c => ({ id: c.id, name: c.name, total: usd(c.newTotalCents),
      totalCents: c.newTotalCents, ok: c.checks.ok, dropped: c.droppedActivities ?? [] }));
    marks.facts.pickId = trip.repair.pickId ?? null;
  }
  const cancelled = trip.itinerary.items.find(i => i.state === 'cancelled' && i.kind !== 'lodging');
  if (cancelled) {
    const replacement = trip.itinerary.items.find(i => i.slot === cancelled.slot && i.id !== cancelled.id && i.state !== 'cancelled' && i.kind !== 'lodging');
    marks.facts.cancelledName = cancelled.name; marks.facts.cancelledPrice = usd(cancelled.priceCents);
    if (replacement) { marks.facts.replacementName = replacement.name; marks.facts.replacementPrice = usd(replacement.priceCents); }
  }
  await save();
  return trip;
}
// Beat numbers are the film's order; the run records them in time order.
async function runBeat(n, fn) {
  beat = n;
  const begin = seconds();
  await fn();
  await pause(2500);
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
      await mark(label, '#schedule'); await pause(6000); return;
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
    // Beat 3, "Earlier": tastes, ceiling, the repair choice, Plan, a short globe, the plan.
    await runBeat(3, async () => {
      const config = page.waitForResponse(r => new URL(r.url()).pathname === '/api/config');
      await page.goto('/');
      const response = await config;
      if (!response.ok()) throw new Error(`/api/config HTTP ${response.status()}`);
      await response.finished();
      await page.locator('#globe.globe-idle .idle-globe').waitFor({ state: 'visible' });
      await focus('#plan-form'); await mark('b3-form', '#plan-form'); await pause(5700);
      const lowest = page.locator('.repair-choice input[value="lowest_total"]');
      await move(lowest); await mark('b3-choice-click', '.repair-choice'); await lowest.check(); await pause(2000);
      await click(/^Plan my two days/, 'b3-plan-click', '#plan-form');
      await waitPhase(page, 'planned'); await focus('#schedule');
      await mark('b3-plan', '#schedule'); await pause(6200); await facts(); tripUrl = page.url();
    });
    // Beat 4: a stop the AI picked, one asked change, a new approval.
    await runBeat(4, async () => {
      await tooltip('#schedule .rr-event:not(.ghost):not(.rr-stay)', 'The AI said', 'b4-tooltip');
      await click('Approve quote', 'b4-quote-click'); await waitPhase(page, 'quoted');
      // A Saturday change keeps the hotel trade off of beat 6 (a slower Sunday makes both hotels drop the castle walk).
      const input = page.locator('#ask-input');
      await move(input); await mark('b4-chip-click', '#ask-panel');
      await input.pressSequentially('Make Saturday morning slower', { delay: 45 });
      await click('Ask the agent', 'b4-ask-click', '#ask-panel');
      await page.locator('#ask-answer').filter({ hasText: /\S/ }).waitFor({ state: 'visible' });
      await focus('#ask-panel'); await mark('b4-changed', '#ask-panel'); await pause(7700); await facts();
    });
    // Beat 5: approve, hold the exact quote; the strip shows the ceiling beside the hold.
    await runBeat(5, async () => {
      await click('Approve quote', 'b5-quote-click'); await waitPhase(page, 'quoted');
      await click(HOLD, 'b5-hold-click'); await waitPhase(page, 'holding');
      await focus('#mandate'); await mark('b5-held', '#mandate'); await pause(10200); await facts();
    });
    // Beat 1: the film's opening. The held trip, then the hotel cancels.
    await runBeat(1, async () => {
      await focus('#schedule'); await mark('b1-trip', '#schedule'); await pause(6700);
      const button = page.getByRole('button', { name: 'Simulate: the hotel cancels our room', exact: true });
      await move(button); await mark('b1-cancel-click', '.money-panel');
      await button.click();
      await page.locator('#schedule').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await pause(1200); await mark('b1-hotel', '#schedule'); await pause(4200);
    });
    // Beat 2: what failed, and the money is still only held.
    await runBeat(2, async () => {
      await waitPhase(page, 'repair_proposed'); await facts();
      await focus('#repair-panel', 'start'); await mark('b2-failed', '#repair-panel'); await pause(5500);
      await focus('#mandate'); await mark('b2-strip', '#mandate'); await pause(8400);
    });
    // Beat 6, "Later": the repair cards, close, then the rejected list with reasons.
    await runBeat(6, async () => {
      const cards = page.locator('.candidate-grid .candidate');
      for (let i = 0; i < await cards.count(); i++) {
        await focus(cards.nth(i)); await mark(`b6-card-${i}`, cards.nth(i)); await pause(9500);
      }
      await focus('.rejected-block'); await mark('b6-rejected', '.rejected-block'); await pause(6000);
    });
    // Beat 7: preview on the Scheduler. Preview writes nothing to PayPal.
    await runBeat(7, async () => {
      const trip = await readTrip(page);
      const pick = trip.repair.candidates.find(c => c.id === trip.repair.pickId);
      if (!pick?.checks.ok) throw new Error('Repair pick is not checked');
      const alternate = trip.repair.candidates.find(c => c.checks.ok && c.id !== pick.id);
      for (const [candidate, label] of [...(alternate ? [[alternate, 'b7-alt-click']] : []), [pick, 'b7-pick-click']]) {
        const button = page.locator(`[data-candidate="${candidate.id}"]`);
        await move(button); await mark(label, button.locator('xpath=ancestor::*[contains(@class,"candidate")][1]')); await button.click();
        await page.locator('#schedule').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await pause(2500);
      }
      await expect(page.locator('[data-accept]')).toHaveAttribute('data-accept', pick.id);
      await expect(page.locator('#schedule .ghost').first()).toBeVisible();
      await mark('b7-preview', '#schedule'); await pause(10700);
    });
    // Beat 8: use the pick; the old hold is released, never captured.
    await runBeat(8, async () => {
      const trip = await readTrip(page), pick = trip.repair.candidates.find(c => c.id === trip.repair.pickId);
      await click(`Use ${pick.name}`, 'b8-use-click', '#repair-panel'); await waitPhase(page, 'requote');
      await expect(page.locator('#mandate')).toContainText('released');
      await focus('#mandate'); await mark('b8-released', '#mandate'); await pause(13700); await facts();
    });
    // Beat 9: approve the new total, a new authorization with a new id.
    // Using the repair is the approval of the new total; the next step is the new hold.
    await runBeat(9, async () => {
      await click(HOLD, 'b9-hold-click'); await waitPhase(page, 'holding');
      await focus('#mandate'); await mark('b9-held', '#mandate'); await pause(4700);
      await focus('#payment-attempts'); await mark('b9-ids', '#payment-attempts'); await pause(9100); await facts();
    });
    // Beat 10: every simulated booking confirmed, then the capture.
    await runBeat(10, async () => {
      await click('Confirm bookings', 'b10-confirm-click'); await waitPhase(page, 'confirmed_captured');
      await focus('#mandate'); await mark('b10-captured', '#mandate'); await pause(5700);
      await focus('#payment-attempts'); await mark('b10-ids', '#payment-attempts'); await pause(9200); await facts();
    });
    // Beat 11: the operator cancels an activity; the refund state PayPal returns.
    await runBeat(11, async () => {
      await click('Simulate: the operator cancels an activity', 'b11-cancel-click');
      let trip = await waitPhase(page, ['refund_pending', 'refunded']);
      await focus('.money-panel'); await mark('b11-replacement', '.money-panel'); await pause(8700);
      for (let i = 0; trip.phase === 'refund_pending' && i < 8; i++) {
        await pause(8000); await click('Check refund status', `b11-check-${i}-click`); trip = await readTrip(page);
      }
      if (trip.phase !== 'refunded') throw new Error('Refund not completed after 8 checks');
      await expect(page.locator('#phase-summary')).toContainText('completed');
      await focus('.money-panel'); await mark('b11-completed', '.money-panel'); await pause(9700); await facts();
    });
    // Beat 12: the receipt page, the net line and one verified webhook.
    await runBeat(12, async () => {
      const link = page.getByRole('link', { name: 'All receipts', exact: true });
      await move(link); await link.click();
      await page.locator('.receipt-attempt').first().waitFor({ state: 'visible' });
      for (let i = 0; !(await page.locator('.receipt-webhook').count()) && i < 12; i++) {
        await pause(10000); await page.reload(); await page.locator('.receipt-attempt').first().waitFor({ state: 'visible' });
      }
      if (!(await page.locator('.receipt-webhook').count())) throw new Error('No verified webhook after 12 reloads');
      await focus('#receipt-net-summary'); await mark('b12-net', '#receipt-net-summary'); await pause(8700);
      await focus(page.locator('.receipt-webhook').first()); await mark('b12-webhooks', page.locator('.receipt-webhook').first());
      await pause(8700); await facts();
    });
    // Beat 14: the receipt ids under the end card.
    await runBeat(14, async () => {
      const rows = page.locator('.receipt-attempt h2, .receipt-ids');
      await focus(rows.first()); await mark('b14-ids', rows.first()); await pause(7700);
    });
    return context.storageState();
  });
  await scene('phone', PHONE, state, async () => {
    // Beat 13: the same trip at phone width.
    await runBeat(13, async () => {
      await page.goto(tripUrl); await idle(page);
      await expect(page.locator('#schedule')).toHaveAttribute('data-view', 'bryntum');
      await focus('#schedule'); await mark('phone-schedule', '#schedule'); await pause(6700);
      await focus('#mandate'); await mark('phone-money', '#mandate'); await pause(6700);
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
