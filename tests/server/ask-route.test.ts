import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import worker from '../../src/worker';
import type { Env } from '../../src/env';
import type { TripView } from '../../src/domain/types';
import { FakePayPal } from '../helpers/fake-paypal';
import { input } from '../helpers/world';
vi.mock('../../src/recorded/default-propose.json', async () => ({ default: (await import('../helpers/recorded')).placeholderRecorded.propose }));
vi.mock('../../src/recorded/default-repair.json', async () => ({ default: (await import('../helpers/recorded')).placeholderRecorded.repair }));
const runtime = env as Env;
let sb: FakePayPal;
const request = (path: string, method = 'GET', cookie?: string, body?: unknown) => worker.fetch(new Request('https://test' + path, { method,
  headers: { ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }), runtime);
beforeEach(async () => {
  sb = new FakePayPal(); vi.stubGlobal('fetch', sb.fetch);
  await runtime.LEDGER.exec('CREATE TABLE IF NOT EXISTS ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, day TEXT NOT NULL, neurons REAL NOT NULL, at TEXT NOT NULL)');
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function created() {
  const response = await request('/api/trips', 'POST', undefined, input());
  expect(response.status).toBe(201);
  const cookie = response.headers.get('set-cookie')!.split(';')[0], trip = await response.json() as TripView;
  return { cookie, trip, path: `/api/trips/${trip.id}` };
}
describe('POST /api/trips/:id/ask', () => {
  test('a held ask uses the queued route and returns a new quote with the old authorization voided', async () => {
    const { cookie, path } = await created();
    await request(path + '/quote', 'POST', cookie);
    await request(path + '/pay/card', 'POST', cookie);
    const response = await request(path + '/ask', 'POST', cookie, { text: 'Swap the castle for coffee' });
    expect(response.status).toBe(200);
    const view = await response.json() as TripView;
    expect(view.phase).toBe('requote');
    expect(view.payments[0].state).toBe('voided');
    expect(view.quote?.version).toBe(view.itinerary.version);
    expect(sb.sent.filter(s => s.path.endsWith('/void'))).toHaveLength(1);
  });
  test('concurrent asks share the queue and cannot spend a third change', async () => {
    const { cookie, path } = await created();
    const responses = await Promise.all(['one', 'two', 'three'].map(text => request(path + '/ask', 'POST', cookie, { text })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 200, 409]);
    const view = await (await request(path, 'GET', cookie)).json() as TripView;
    expect(view.asksLeft).toBe(0);
    expect(view.log.filter(step => step.tool === 'ask_agent')).toHaveLength(2);
    expect(sb.sent).toHaveLength(0);
  });
  test('is a real route inside the trip queue: it answers with the changed TripView', async () => {
    const { cookie, path, trip } = await created();
    const response = await request(path + '/ask', 'POST', cookie, { text: 'Swap the castle for coffee' });
    expect(response.status).toBe(200);
    const view = await response.json() as TripView;
    expect(view.itinerary.version).toBe(trip.itinerary.version + 1);
    expect(view.lastAsk).toMatchObject({ changed: true });
    expect(view.asksLeft).toBe(1);
    expect(view.log.at(-1)).toMatchObject({ tool: 'ask_agent', source: 'rule' });
    expect(Object.keys(view)).not.toContain('asks');
    expect(sb.sent).toHaveLength(0);
  });
  test('another browser gets 403, bad text gets 400, a nonsense request changes nothing', async () => {
    const { cookie, path, trip } = await created();
    expect((await request(path + '/ask', 'POST', 'rr_sid=abcdefghijklmnop', { text: 'Make Sunday morning slower' })).status).toBe(403);
    expect((await request(path + '/ask', 'POST', cookie, { text: 'x'.repeat(161) })).status).toBe(400);
    expect((await request(path + '/ask', 'POST', cookie, {})).status).toBe(400);
    const nothing = await request(path + '/ask', 'POST', cookie, { text: 'Wire me some money' });
    expect(nothing.status).toBe(200);
    const view = await nothing.json() as TripView;
    expect(view.itinerary).toEqual(trip.itinerary);
    expect(view.lastAsk).toMatchObject({ changed: false, message: 'I could not turn that into a change. Try one of the examples.' });
  });
  test('the third ask and any ask after capture answer 409 with a plain message', async () => {
    const { cookie, path } = await created();
    expect((await request(path + '/ask', 'POST', cookie, { text: 'Make Sunday morning slower' })).status).toBe(200);
    expect((await request(path + '/ask', 'POST', cookie, { text: 'Swap the castle for coffee' })).status).toBe(200);
    const third = await request(path + '/ask', 'POST', cookie, { text: 'Make Saturday slower' });
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ message: 'You used both changes for this trip.' });
    const other = await created();
    expect((await request(other.path + '/quote', 'POST', other.cookie)).status).toBe(200);
    expect((await request(other.path + '/pay/card', 'POST', other.cookie)).status).toBe(200);
    expect((await request(other.path + '/confirm', 'POST', other.cookie)).status).toBe(200);
    const held = await request(other.path + '/ask', 'POST', other.cookie, { text: 'Make Sunday morning slower' });
    expect(held.status).toBe(409);
    expect(typeof (await held.json() as { message: string }).message).toBe('string');
  });
});
