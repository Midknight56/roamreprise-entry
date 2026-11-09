import { expect, type Page } from '@playwright/test';
import type { TripView, Phase } from '../src/domain/types';

export async function idle(page: Page) {
  await expect(page.locator('#main')).not.toHaveAttribute('aria-busy', 'true', { timeout: 90000 });
  await expect(page.locator('#globe')).not.toHaveClass(/globe-active/);
}

/** Read through the page's API client, preserving its session and mock mode. */
export async function readTrip(page: Page): Promise<TripView> {
  return page.evaluate(async () => {
    const id = new URL(location.href).searchParams.get('trip');
    if (!id) throw new Error('No trip in the page URL');
    // @ts-ignore Browser module is served by the app under test.
    const { api } = await import('/js/api.js');
    return api.trip(id);
  });
}

export async function waitPhase(page: Page, phase: Phase | Phase[]) {
  await idle(page);
  const allowed = Array.isArray(phase) ? phase : [phase];
  await expect.poll(async () => (await readTrip(page)).phase).toMatch(new RegExp(`^(${allowed.join('|')})$`));
  return readTrip(page);
}

export async function press(page: Page, name: string | RegExp, allowError = false) {
  await page.getByRole('button', { name, exact: typeof name === 'string' }).click();
  await idle(page);
  if (!allowError) await expect(page.locator('#error')).toBeHidden();
}

export async function openPlanner(page: Page, mock = false) {
  // The config response establishes rr_sid. Do not race it with trip creation.
  const config = mock ? undefined : page.waitForResponse(r => new URL(r.url()).pathname === '/api/config');
  await page.goto(mock ? '/?mock=1' : '/');
  if (config) {
    const response = await config;
    expect(response.ok()).toBe(true);
    await response.finished();
  }
}

export async function startTrip(page: Page, mock = false) {
  await openPlanner(page, mock);
  await expect(page.locator('#tastes [aria-pressed="true"]')).toHaveText([
    'tile art', 'fado music', 'viewpoints', 'food markets',
  ]);
  await press(page, 'Plan my two days');
  return waitPhase(page, 'planned');
}

export async function quote(page: Page) {
  await press(page, 'Approve quote');
  return waitPhase(page, 'quoted');
}

export async function hold(page: Page) {
  await press(page, /^Hold .* with sandbox test card \(no sign in\)$/);
  return readTrip(page);
}

export async function fault(page: Page, kind: 'lose_next_response' | 'expire_authorization') {
  const id = (await readTrip(page)).id;
  const response = await page.request.post(`/api/trips/${id}/dev/fault`, { data: { kind } });
  expect(response.ok(), `dev fault ${kind}: ${response.status()} ${await response.text()}`).toBeTruthy();
}

export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

export async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

export async function phoneLayout(page: Page) {
  await noHorizontalScroll(page);
  const violations = await page.locator('button:visible').evaluateAll(buttons => {
    const boxes = buttons.map(button => ({
      text: button.textContent?.trim(), box: button.getBoundingClientRect(),
      overflow: button.scrollWidth > button.clientWidth,
    }));
    const bad: string[] = [];
    for (const { text, box, overflow } of boxes) {
      if (box.left < 16 - .5 || box.right > innerWidth - 16 + .5) bad.push(`${text}: less than 16px from edge`);
      if (overflow) bad.push(`${text}: text overflows`);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].box, b = boxes[j].box;
      const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const gapX = Math.max(a.left, b.left) - Math.min(a.right, b.right);
      const gapY = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
      if ((yOverlap > .5 && gapX < 11.5) || (xOverlap > .5 && gapY < 11.5))
        bad.push(`${boxes[i].text} / ${boxes[j].text}: gap ${Math.max(gapX, gapY).toFixed(1)}px`);
    }
    return bad;
  });
  // Collect all phone defects while still exercising the full payment flow.
  expect.soft(violations).toEqual([]);
}

export async function scheduler(page: Page) {
  await expect(page.locator('#schedule')).toHaveAttribute('data-view', 'bryntum');
  await expect(page.locator('#schedule')).toContainText('Day 1');
  await expect(page.locator('#schedule')).toContainText('Day 2');
  await expect(page.locator('.rr-travel-buffer').first()).toBeAttached();
  const data = await page.locator('#schedule').evaluate(async element => {
    // @ts-ignore Browser-only vendor module.
    const { Widget } = await import('/vendor/bryntum/scheduler/scheduler.module.js');
    const widget = Widget.fromElement(element.firstElementChild);
    return {
      rows: widget.resourceStore.records.map((r: { id: string }) => r.id),
      buffers: widget.eventStore.records.filter((e: { get: (key: string) => unknown }) => Number(e.get('preamble')) > 0).length,
      validDates: widget.eventStore.records.every((e: { endDate: Date; startDate: Date }) => e.endDate > e.startDate),
    };
  });
  expect(data.rows).toEqual(['d0', 'd1']);
  expect(data.buffers).toBeGreaterThan(0);
  expect(data.validDates).toBe(true);
}

export async function eventLabels(page: Page, mode: 'horizontal' | 'vertical') {
  const result = await page.locator('#schedule').evaluate(async element => {
    // @ts-ignore Browser-only vendor module.
    const { Widget } = await import('/vendor/bryntum/scheduler/scheduler.module.js');
    const widget = Widget.fromElement(element.firstElementChild);
    const rows = [...element.querySelectorAll('.rr-event:not(.ghost)')].map(event => {
      const label = event.querySelector('.rr-short-name') as HTMLElement | null;
      const name = label?.querySelector('span')?.textContent || label?.textContent || '';
      return { name: name.trim(), labelWidth: label?.clientWidth ?? 0, labelScrollWidth: label?.scrollWidth ?? 0 };
    });
    return { mode: widget.mode, rows };
  });
  expect(result.mode).toBe(mode);
  expect(result.rows.length).toBeGreaterThan(0);
  for (const row of result.rows) {
    expect(row.name).not.toBe('');
    expect(row.labelScrollWidth).toBeLessThanOrEqual(row.labelWidth);
  }
}

export async function checkRepair(page: Page) {
  const view = await waitPhase(page, 'repair_proposed');
  const repair = view.repair!;
  expect(repair.candidates.filter(c => c.checks.ok)).toHaveLength(2);
  expect(repair.candidates.filter(c => !c.checks.ok)).toHaveLength(2);
  for (const [hotel, code, reason] of [
    ['h-terraco', 'AVAILABILITY', /no rooms/i], ['h-avenida', 'CEILING', /ceiling/i],
  ] as const) {
    const candidate = repair.candidates.find(c => c.hotelId === hotel)!;
    expect(candidate.checks.ok).toBe(false);
    expect(candidate.checks.issues.some(i => i.code === code)).toBe(true);
    const card = page.locator('.candidate').filter({ has: page.getByRole('heading', { name: candidate.name, exact: true }) });
    await expect(card).toContainText('Rejected');
    await expect(card.locator('.rejection')).toContainText(reason);
  }
  await expect(page.locator('.candidate:not(.rejected)')).toHaveCount(2);
  const pick = repair.candidates.find(c => c.id === repair.pickId);
  expect(pick?.checks.ok).toBe(true);
  await expect(page.locator('[data-accept]')).toHaveAttribute('data-accept', repair.pickId);
  return pick!;
}

export async function receiptPage(page: Page, view: TripView) {
  await page.getByRole('link', { name: 'All receipts', exact: true }).click();
  await expect(page.locator('.receipt-attempt')).toHaveCount(view.payments.length);
  const operations = view.payments.flatMap(p => p.receipts);
  await expect(page.locator('.receipt-operation')).toHaveCount(operations.length);
  for (let i = 0; i < view.payments.length; i++) {
    const payment = view.payments[i], section = page.locator('.receipt-attempt').nth(i);
    for (const id of [payment.orderId, payment.authorizationId, payment.captureId, ...payment.refunds.map(r => r.id)].filter(Boolean))
      await expect(section).toContainText(id!);
    for (let n = 0; n < payment.receipts.length; n++) {
      const r = payment.receipts[n], row = section.locator('.receipt-operation').nth(n);
      for (const value of [r.op, r.path, String(r.status), r.paypalStatus, r.requestId, r.debugId, r.at].filter(Boolean))
        await expect(row).toContainText(value!);
    }
  }
  await noHorizontalScroll(page);
}

export async function happyPath(page: Page, checkLayout = noHorizontalScroll) {
  await startTrip(page);
  await scheduler(page);
  await checkLayout(page);
  await quote(page);
  await checkLayout(page);
  await hold(page);
  let view = await waitPhase(page, 'holding');
  expect(view.itinerary.items.filter(i => i.booked).every(i => i.state === 'held' && i.supplierRef?.startsWith('SIM-'))).toBe(true);
  await expect(page.locator('#price-list')).toContainText('held');
  await checkLayout(page);
  await press(page, 'Simulate: the hotel cancels our room');
  const pick = await checkRepair(page);
  await checkLayout(page);
  await press(page, `Use ${pick.name}`);
  view = await waitPhase(page, 'requote');
  expect(view.payments[0].state).toBe('voided');
  expect(view.payments[0].receipts.some(r => r.paypalStatus === 'VOIDED')).toBe(true);
  // Inspect the actual receipt before starting the replacement payment.
  const tripUrl = page.url();
  await receiptPage(page, view);
  await expect(page.locator('#receipts')).toContainText('VOIDED');
  await page.goto(tripUrl); await idle(page);
  await checkLayout(page);
  await hold(page); await waitPhase(page, 'holding');
  await checkLayout(page);
  await press(page, 'Confirm bookings');
  view = await waitPhase(page, 'confirmed_captured');
  expect(view.payments.at(-1)?.state).toBe('captured');
  expect(view.payments.at(-1)?.receipts.some(r => r.op === 'capture' && r.paypalStatus === 'COMPLETED')).toBe(true);
  expect(view.itinerary.items.filter(i => i.booked && !['replaced', 'released', 'cancelled'].includes(i.state)).every(i => i.state === 'confirmed')).toBe(true);
  await checkLayout(page);
  await press(page, 'Simulate: the operator cancels an activity');
  view = await waitPhase(page, ['refund_pending', 'refunded']);
  expect(view.payments.at(-1)?.refunds.at(-1)?.state).toMatch(/^(pending|completed)$/);
  await checkLayout(page);
  await receiptPage(page, view);
  await expect(page.locator('#receipts')).toContainText('COMPLETED');
  await checkLayout(page);
}
