import { test, expect } from './fixtures';
import { idle, phoneLayout, press, quote, readTrip, scheduler, startTrip, waitPhase, watchErrors } from './helpers';
import type { Page } from '@playwright/test';

const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
/** The moment a Scheduler bar starts, read from Bryntum's own store. */
async function barStart(page: Page, id: string) {
  return page.locator('#schedule').evaluate(async (element, eventId) => {
    // @ts-ignore Browser only vendor module.
    const { Widget } = await import('/vendor/bryntum/scheduler/scheduler.module.js');
    const widget = Widget.fromElement(element.firstElementChild);
    const record = widget.eventStore.getById(eventId);
    return record ? `${String(record.startDate.getHours()).padStart(2, '0')}:${String(record.startDate.getMinutes()).padStart(2, '0')}` : null;
  }, id);
}

for (const mock of [true, false]) {
  test(`PART A ${mock ? 'mock' : 'real local server'}: ask the agent moves an item, changes the total and asks to approve again`, async ({ page }) => {
    const errors = watchErrors(page), requests: string[] = [];
    page.on('request', r => requests.push(`${r.method()} ${new URL(r.url()).host}${new URL(r.url()).pathname}`));
    const planned = await startTrip(page, mock);
    await scheduler(page);
    const panel = page.locator('#ask-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Ask the agent', exact: true })).toBeVisible();
    // Example chips fill the input and respect the 160 character limit.
    await expect(panel.locator('#ask-input')).toHaveAttribute('maxlength', '160');
    await panel.getByRole('button', { name: 'Swap the castle for coffee', exact: true }).click();
    await expect(panel.locator('#ask-input')).toHaveValue('Swap the castle for coffee');
    await panel.getByRole('button', { name: 'Make Sunday morning slower', exact: true }).click();
    await expect(panel.locator('#ask-input')).toHaveValue('Make Sunday morning slower');

    // A quoted trip returns to planned and says the quote changed.
    await quote(page);
    await expect(page.locator('#total')).toHaveText(usd(planned.itinerary.totalCents));
    const castle = planned.itinerary.items.find(i => i.offerId === 'a-castle')!;
    expect(castle).toBeTruthy();
    expect(await barStart(page, castle.id)).toBe(castle.start);
    await panel.locator('#ask-input').fill('Swap the castle for coffee');
    await press(page, 'Ask the agent');
    const swapped = await waitPhase(page, 'planned');
    expect(swapped.itinerary.version).toBe(planned.itinerary.version + 1);
    expect(swapped.itinerary.items.find(i => i.slot === castle.slot)!.offerId).toBe('a-roastery');
    expect(swapped.itinerary.totalCents).toBe(planned.itinerary.totalCents - 300);
    expect(swapped.quote).toBeUndefined();
    await expect(page.locator('#total')).toHaveText(usd(swapped.itinerary.totalCents));
    await expect(page.locator('#version')).toHaveText(`v${swapped.itinerary.version}`);
    await expect(page.locator('#phase-summary')).toContainText(`The quote changed to ${usd(swapped.itinerary.totalCents)}. Approve it again.`);
    await expect(page.getByRole('button', { name: 'Approve quote', exact: true })).toBeVisible();
    await expect(page.locator('#ask-answer')).toContainText('Castle hill walk to Coffee roastery tasting.');
    await expect(page.locator('#log-list')).toContainText('You asked: Swap the castle for coffee.');
    await expect(page.locator('#schedule')).toContainText('Coffee');
    await panel.screenshot({ path: `artifacts/j19/ask-${mock ? 'mock' : 'local'}.png` });
    // The ask is just the plan: no PayPal request at all.
    // Loading the existing wallet SDK for an approved quote is not a payment operation.
    expect(requests.filter(r => /^POST .*\/api\/trips\/.*\/(pay|reserve)/.test(r))).toEqual([]);
    expect((await readTrip(page)).payments).toEqual([]);

    // The second ask moves a Scheduler bar in place, then the input is replaced.
    const before = await barStart(page, 'd2-am');
    expect(before).toBe('10:00');
    await panel.getByRole('button', { name: 'Make Sunday morning slower', exact: true }).click();
    await press(page, 'Ask the agent');
    const slower = await waitPhase(page, 'planned');
    expect(slower.itinerary.items.find(i => i.slot === 'd2-am')!.start).toBe('10:30');
    await expect.poll(() => barStart(page, 'd2-am')).toBe('10:30');
    await expect(panel).toContainText('You used both changes for this trip.');
    await expect(panel.locator('#ask-input')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Ask the agent', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve quote', exact: true })).toBeVisible();

    // Approve again: the quote is the changed total and the trip is quoted, not requoted.
    await quote(page);
    const again = await readTrip(page);
    expect(again.quote!.totalCents).toBe(slower.itinerary.totalCents);
    await expect(page.locator('#phase-summary')).not.toContainText('The quote changed');
    // The input stays gone for a trip with no asks left, and a reload keeps the sentence.
    await page.reload(); await idle(page);
    await expect(page.locator('#ask-panel')).toContainText('You used both changes for this trip.');
    expect(errors).toEqual([]);
  });
}

test('PART A real local server: a request the rules cannot read gets a checked change or a plain no change', async ({ page }) => {
  const errors = watchErrors(page);
  const planned = await startTrip(page, false);
  await page.locator('#ask-input').fill('Book me a table somewhere nice');
  await press(page, 'Ask the agent');
  await expect(page.locator('#ask-answer')).not.toHaveText('');
  const view = await readTrip(page);
  if (view.itinerary.version === planned.itinerary.version) {
    expect(view.itinerary.totalCents).toBe(planned.itinerary.totalCents);
    await expect(page.locator('#ask-answer')).toHaveText(/^(I could not turn that into a change\. Try one of the examples\.|.* so I kept the plan\.)$/);
  } else {
    expect(view.itinerary.version).toBe(planned.itinerary.version + 1);
    await expect(page.locator('#ask-answer')).toHaveText(/^The agent changed/);
  }
  expect(errors).toEqual([]);
});

test('PART A mock: an unknown request changes nothing and says so', async ({ page }) => {
  const planned = await startTrip(page, true);
  await page.locator('#ask-input').fill('Book me a table somewhere nice');
  await press(page, 'Ask the agent');
  await expect(page.locator('#ask-answer')).toHaveText('I could not turn that into a change. Try one of the examples.');
  const view = await readTrip(page);
  expect(view.itinerary.version).toBe(planned.itinerary.version);
  expect(view.itinerary.totalCents).toBe(planned.itinerary.totalCents);
});

test('the recorded viewer shows no ask input', async ({ page }) => {
  await page.goto('/?mock=1'); await press(page, 'Watch a recorded run');
  await expect(page.locator('#recorded-banner')).toContainText('No PayPal request is sent.');
  await expect(page.locator('#ask-panel')).toBeHidden();
  while (await page.locator('#recorded-next').isEnabled()) { await press(page, 'Next step'); await expect(page.locator('#ask-panel')).toBeHidden(); }
});

for (const mock of [true, false]) test(`PART B ${mock ? 'mock' : 'real local server'}: ask after a hold voids the old authorization and authorizes a new hold`, async ({ page }) => {
  await startTrip(page, mock); await quote(page);
  await press(page, /^Hold .* with sandbox test card \(no sign in\)$/);
  const before = await waitPhase(page, 'holding');
  await expect(page.locator('#ask-panel')).toBeVisible();
  await page.locator('#ask-input').fill('Swap the castle for coffee');
  await press(page, 'Ask the agent');
  const changed = await waitPhase(page, 'requote');
  expect(changed.payments[0].authorizationId).toBe(before.payments[0].authorizationId);
  expect(changed.payments[0].state).toBe('voided');
  expect(changed.payments[0].receipts.filter(r => r.op === 'void')).toHaveLength(1);
  expect(changed.payments[0].receipts.find(r => r.op === 'void')?.paypalStatus).toBe('VOIDED');
  expect(changed.quote!.totalCents).toBe(before.quote!.totalCents - 300);
  expect(changed.quote!.version).toBe(before.quote!.version + 1);
  await expect(page.locator('#money-story-chips')).toContainText('Voided');
  await press(page, /^Hold .* with sandbox test card \(no sign in\)$/);
  const again = await waitPhase(page, 'holding');
  expect(again.payments.map(p => p.state)).toEqual(['voided', 'authorized']);
  expect(again.payments[1].authorizationId).not.toBe(before.payments[0].authorizationId);
  expect(again.payments[1].amountCents).toBe(changed.quote!.totalCents);
  await expect(page.locator('#money-story-chips')).toContainText('Voided');
  await page.screenshot({ path: `artifacts/j24/ask-${mock ? 'mock' : 'local'}-new-hold.png`, fullPage: true });
});

test('PART B mock: capture hides the input and refuses asks', async ({ page }) => {
  await startTrip(page, true); await quote(page);
  await press(page, /^Hold .* with sandbox test card \(no sign in\)$/);
  await waitPhase(page, 'holding');
  await press(page, 'Confirm bookings');
  await waitPhase(page, 'confirmed_captured');
  await expect(page.locator('#ask-panel')).toBeHidden();
  const denied = await page.evaluate(async () => {
    // @ts-ignore Browser module.
    const { api } = await import('/js/api.js');
    try { await api.ask(new URL(location.href).searchParams.get('trip'), 'Make Sunday morning slower'); }
    catch (e) { return (e as { status: number }).status; }
  });
  expect(denied).toBe(409);
});

test('the phone ask form fits and submits a chip request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = watchErrors(page);
  await startTrip(page, true);
  await phoneLayout(page);
  const panel = page.locator('#ask-panel');
  await panel.getByRole('button', { name: 'Swap the castle for coffee', exact: true }).click();
  await press(page, 'Ask the agent');
  await expect(panel.locator('#ask-answer')).toContainText('Coffee roastery tasting');
  expect(await panel.locator('.ask-examples button').last().evaluate(chip => {
    const chipBottom = chip.getBoundingClientRect().bottom;
    const answerTop = document.querySelector('#ask-answer')!.getBoundingClientRect().top;
    return answerTop - chipBottom;
  })).toBeGreaterThanOrEqual(12);
  await phoneLayout(page);
  await panel.screenshot({ path: 'artifacts/j19/ask-phone.png' });
  expect(errors).toEqual([]);
});
