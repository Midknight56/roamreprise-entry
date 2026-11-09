import { describe, expect, test, vi } from 'vitest';
// @ts-ignore Browser JavaScript
import * as ask from '../../public/js/ask.js';
// @ts-ignore Browser JavaScript
import { moneyStory } from '../../public/js/money-story.js';
import about from '../../public/about.html?raw';
import appSource from '../../public/js/app.js?raw';
import indexHtml from '../../public/index.html?raw';

const trip = (over: Record<string, unknown> = {}) => ({ phase: 'planned', payments: [], asksLeft: 2, itinerary: { totalCents: 43600 }, ...over });

describe('the ask panel state', () => {
  test('shows the input before a hold when asks are left', () => {
    for (const phase of ['planned', 'quoted']) expect(ask.askPanel(trip({ phase }), false)).toEqual({ mode: 'input' });
  });
  test('replaces the input with the plain sentence after two asks', () => {
    expect(ask.askPanel(trip({ asksLeft: 0 }), false)).toEqual({ mode: 'used', text: 'You used both changes for this trip.' });
  });
  test('shows holding only with the latest payment authorized', () => {
    expect(ask.askPanel(trip({ phase: 'holding', payments: [{ state: 'voided' }, { state: 'authorized' }] }), false)).toEqual({ mode: 'input' });
    for (const state of ['captured', 'unknown', 'voided', 'declined']) expect(ask.askPanel(trip({ phase: 'holding', payments: [{ state }] }), false)).toEqual({ mode: 'hidden' });
  });
  test.each(['authorized', 'holding', 'repair_proposed', 'requote', 'confirmed_captured', 'refund_pending', 'refunded', 'declined', 'checking_payment'])('hides the input without an eligible authorization in phase %s', phase => {
    expect(ask.askPanel(trip({ phase }), false)).toEqual({ mode: 'hidden' });
    expect(ask.askPanel(trip({ phase, asksLeft: 0 }), false)).toEqual({ mode: 'hidden' });
    if (phase !== 'holding') expect(ask.askPanel(trip({ phase, payments: [{ state: 'authorized' }] }), false)).toEqual({ mode: 'hidden' });
  });
  test('hides the input in the recorded viewer, for old snapshots and while a payment exists', () => {
    expect(ask.askPanel(trip(), true)).toEqual({ mode: 'hidden' });
    expect(ask.askPanel(trip({ asksLeft: undefined }), false)).toEqual({ mode: 'hidden' });
    expect(ask.askPanel(trip({ phase: 'quoted', payments: [{ state: 'order_created' }] }), false)).toEqual({ mode: 'hidden' });
  });
});

describe('ask copy', () => {
  test('example chips, limit and button name follow the job', () => {
    expect(ask.ASK_CHIPS).toEqual(['Make Sunday morning slower', 'Swap the castle for coffee']);
    expect(ask.ASK_MAX_CHARS).toBe(160);
    expect(ask.ASK_BUTTON).toBe('Ask the agent');
  });
  test('the money panel says the quote changed and to approve it again', () => {
    expect(ask.quoteNote(trip({ lastAsk: { changed: true, reapprove: true, quoteNote: 'The quote changed to $424.00. Approve it again.' } }))).toBe('The quote changed to $424.00. Approve it again.');
    expect(ask.quoteNote(trip({ lastAsk: { changed: true, reapprove: false } }))).toBe('');
    expect(ask.quoteNote(trip({ phase: 'quoted', lastAsk: { changed: true, reapprove: true, quoteNote: 'x' } }))).toBe('');
    expect(ask.quoteNote(trip())).toBe('');
  });
  test('answer text comes from the server and an unchanged answer is shown as is', () => {
    expect(ask.answerText(trip({ lastAsk: { text: 'a', changed: true, message: 'The agent changed Day 2 morning: 10:00 to 10:30.' } }))).toBe('The agent changed Day 2 morning: 10:00 to 10:30.');
    expect(ask.answerText(trip())).toBe('');
  });
  test('step source labels never say cached', () => {
    expect(ask.askSourceName({ source: 'live' })).toBe('AI change · code checked');
    expect(ask.askSourceName({ source: 'rule' })).toBe('Rule change');
    expect(ask.askSourceName({ source: 'rule', sample: true })).toBe('Sample answer');
  });
  test('the page wires one input, the button, the chips and the answer line under the Scheduler', () => {
    expect(indexHtml).toMatch(/id="ask-panel"/);
    expect(indexHtml.indexOf('id="schedule"')).toBeLessThan(indexHtml.indexOf('id="ask-panel"'));
    expect(indexHtml.indexOf('id="ask-panel"')).toBeLessThan(indexHtml.indexOf('id="repair-panel"'));
    expect(appSource).toContain("api.ask(");
    expect(appSource).toContain("from './ask.js'");
  });
  test('about page names four calls and the three kinds', () => {
    const visible = about.replace(/<[^>]*>/g, ' ');
    expect(visible).toContain('At most 4 AI calls run per trip');
    expect(visible).toContain('one plan, one repair and up to two changes you ask for');
    expect(visible).not.toContain('At most 2 AI calls');
  });
  test('the money story is unchanged by asks (no payment text before a hold)', () => {
    expect(moneyStory({ ceilingCents: 60000, payments: [] })).toBe('You allow up to $600.00. No payment has been charged.');
  });
});

describe('mock api ask', () => {
  async function mockApi() {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
    vi.resetModules();
    // @ts-ignore Browser JavaScript
    return await import('../../public/js/mock-api.js') as { request(path: string, method?: string, body?: unknown): Promise<any> };
  }
  const slot = (t: any, id: string) => t.itinerary.items.find((i: any) => i.slot === id);
  test('the two example chips give fixed sample answers labelled sample', async () => {
    const api = await mockApi(), t = await api.request('/api/trips', 'POST', { tastes: ['tile art'], note: '', ceilingCents: 60000 });
    expect(t.asksLeft).toBe(2);
    const slower = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Make Sunday morning slower' });
    expect(slot(t, 'd2-am').start).toBe('10:00'); expect(slot(slower, 'd2-am').start).toBe('10:30');
    expect(slower.itinerary.version).toBe(2); expect(slower.asksLeft).toBe(1);
    expect(slower.log.at(-1)).toMatchObject({ tool: 'ask_agent', sample: true });
    expect(slower.log.at(-1).summary).toBe('You asked: Make Sunday morning slower. The agent changed Day 2 morning: 10:00 to 10:30.');
    const coffee = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Swap the castle for coffee' });
    expect(slot(coffee, 'd1-late').offerId).toBe('a-roastery');
    expect(coffee.itinerary.totalCents).toBe(slower.itinerary.totalCents - 300);
    expect(coffee.asksLeft).toBe(0);
    await expect(api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Make Saturday slower' })).rejects.toMatchObject({ status: 409, message: 'You used both changes for this trip.' });
  });
  test('other text goes through the rule parser and an unknown request changes nothing', async () => {
    const api = await mockApi(), t = await api.request('/api/trips', 'POST', { tastes: ['tile art'], note: '', ceilingCents: 60000 });
    const rule = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Let us sleep in on Saturday' });
    expect(slot(rule, 'd1-pm').start).toBe('14:45');
    expect(rule.log.at(-1)).toMatchObject({ tool: 'ask_agent', source: 'rule' });
    expect(rule.log.at(-1).sample).toBeUndefined();
    const none = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Book me a table somewhere nice' });
    expect(none.itinerary).toEqual(rule.itinerary);
    expect(none.lastAsk).toMatchObject({ changed: false, message: 'I could not turn that into a change. Try one of the examples.' });
  });
  test('a quoted mock trip returns to planned with the quote note, then approves again', async () => {
    const api = await mockApi(), t = await api.request('/api/trips', 'POST', { tastes: ['tile art'], note: '', ceilingCents: 60000 });
    await api.request(`/api/trips/${t.id}/quote`, 'POST');
    const changed = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Swap the castle for coffee' });
    expect(changed.phase).toBe('planned'); expect(changed.quote).toBeUndefined(); expect(changed.next).toEqual(['quote']);
    expect(changed.lastAsk.quoteNote).toBe(`The quote changed to $${(changed.itinerary.totalCents / 100).toFixed(2)}. Approve it again.`);
    const again = await api.request(`/api/trips/${t.id}/quote`, 'POST');
    expect(again.phase).toBe('quoted'); expect(again.quote.totalCents).toBe(changed.itinerary.totalCents);
  });
  test('the mock accepts an ask after a hold, voids it and rejects bad text', async () => {
    const api = await mockApi(), t = await api.request('/api/trips', 'POST', { tastes: ['tile art'], note: '', ceilingCents: 60000 });
    await expect(api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'x'.repeat(161) })).rejects.toMatchObject({ status: 400 });
    await expect(api.request(`/api/trips/${t.id}/ask`, 'POST', { text: '  ' })).rejects.toMatchObject({ status: 400 });
    await api.request(`/api/trips/${t.id}/quote`, 'POST'); await api.request(`/api/trips/${t.id}/pay/card`, 'POST', {});
    const changed = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Make Sunday morning slower' });
    expect(changed.phase).toBe('requote');
    expect(changed.payments[0].state).toBe('voided');
  });
  test('other swaps match tags and a ceiling failure keeps the mock plan and quote', async () => {
    const api = await mockApi(), t = await api.request('/api/trips', 'POST', { tastes: ['river walks'], note: '', ceilingCents: 60000 });
    const swapped = await api.request(`/api/trips/${t.id}/ask`, 'POST', { text: 'Swap the castle for river walks' });
    expect(slot(swapped, 'd1-late').offerId).toBe('a-maat');
    expect(swapped.log.at(-1)).toMatchObject({ source: 'rule' });
    expect(swapped.log.at(-1).sample).toBeUndefined();
    const tight = await api.request('/api/trips', 'POST', { tastes: ['coffee'], note: '', ceilingCents: t.itinerary.totalCents });
    const quoted = await api.request(`/api/trips/${tight.id}/quote`, 'POST');
    const failed = await api.request(`/api/trips/${tight.id}/ask`, 'POST', { text: 'Swap the tile art for coffee' });
    expect(failed.lastAsk.message).toContain('over your ceiling');
    expect(failed.itinerary).toEqual(quoted.itinerary);
    expect(failed.quote).toEqual(quoted.quote);
  });
});
