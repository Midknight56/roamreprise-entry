import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import worker from '../../src/worker';
import type { Env } from '../../src/env';
import { D1Ledger } from '../../src/ai/ledger';
import type { TripView } from '../../src/domain/types';
import type { TripRecord } from '../../src/trip/store';
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
describe('Worker routes and actual SQLite Durable Objects', () => {
  test('health, public config, honest recorded fallback, secure HttpOnly session cookie', async () => {
    const health = await request('/healthz'); expect(await health.json()).toMatchObject({ ok: true });
    expect(health.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax'); expect(health.headers.get('set-cookie')).toContain('Secure');
    const config = await request('/api/config'); expect(await config.json()).toMatchObject({ liveAi: false, paypalClientId: 'test-id', recordedRunDate: null });
    const recorded = await request('/api/recorded'); expect(await recorded.json()).toMatchObject({ placeholder: true, capturedAt: null });
  });
  test('API ownership is 403 for another sid; JSON errors and invalid payloads are 400', async () => {
    const { cookie, path, trip } = await created(); expect(trip.id).toMatch(/^[a-z2-7]{16}$/);
    expect((await request(path, 'GET', cookie)).status).toBe(200);
    const foreign = await request(path, 'GET', 'rr_sid=abcdefghijklmnop'); expect(foreign.status).toBe(403);
    expect(await foreign.json()).toHaveProperty('error', 'NOT_YOUR_TRIP');
    expect((await request(path + '/quote', 'POST', 'rr_sid=abcdefghijklmnop')).status).toBe(403);
    expect((await request('/api/trips', 'POST', undefined, { ...input(), ceilingCents: 1 })).status).toBe(400);
  });
  test('fault and AI recording routes are 404 when DEV_ROUTES is disabled', async () => {
    const { path, cookie } = await created();
    expect((await request(path + '/dev/fault', 'POST', cookie, { kind: 'lose_next_response' })).status).toBe(404);
    expect((await request('/api/dev/record-ai', 'POST', cookie, input())).status).toBe(404);
  });
  test('malformed JSON and oversized UTF-8 bodies are rejected before trip creation', async () => {
    const malformed = await worker.fetch(new Request('https://test/api/trips', { method: 'POST', body: '{' }), runtime);
    expect(malformed.status).toBe(400);
    const large = await request('/api/trips', 'POST', undefined, { ...input(), note: '界'.repeat(3_000) });
    expect(large.status).toBe(413);
  });
  test('SQLite TripDO serializes concurrent confirms across PayPal fetches; one capture', async () => {
    const { cookie, path, trip } = await created();
    expect((await request(path + '/quote', 'POST', cookie)).status).toBe(200);
    const paid = await request(path + '/pay/card', 'POST', cookie); expect(paid.status).toBe(200);
    const confirmed = await Promise.all([request(path + '/confirm', 'POST', cookie), request(path + '/confirm', 'POST', cookie)]);
    expect(confirmed.map(r => r.status)).toEqual([200, 200]);
    expect(sb.calls('POST /v2/payments/authorizations/').filter(c => c.path.endsWith('/capture'))).toHaveLength(1);
    const snapshot = await runInDurableObject(runtime.TRIP.getByName(trip.id), (_instance, state) => {
      const data = state.storage.sql.exec<{value: string}>('SELECT value FROM trip_json WHERE key = ?', 'trip').one().value;
      return { trip: JSON.parse(data) as TripRecord, ops: state.storage.sql.exec('SELECT * FROM ops').toArray().length };
    });
    expect(snapshot.trip.payments[0].state).toBe('captured'); expect(snapshot.ops).toBe(3);
  });
  test('actual GateDO atomically refuses the 13th sid trip and daily global limits', async () => {
    const gate = runtime.GATE.getByName('gate');
    for (let i = 0; i < 12; i++) expect(await gate.takeTrip('sid')).toBe(true);
    expect(await gate.takeTrip('sid')).toBe(false);
    const day = new Date().toISOString().slice(0, 10);
    await runInDurableObject(gate, (_instance, state) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO counters VALUES (?, ?, ?)', day, 'trips', 400);
      state.storage.sql.exec('INSERT OR REPLACE INTO counters VALUES (?, ?, ?)', day, 'writes', 799);
    });
    expect(await gate.takeTrip('fresh')).toBe(false);
    expect((await Promise.all([gate.takeWrite(), gate.takeWrite()])).sort()).toEqual([false, true]);
  });
  test('actual GateDO cache persists in SQLite and expires at 24 hours', async () => {
    const gate = runtime.GATE.getByName('gate'), answer = { capturedAt: new Date().toISOString(), answer: { picks: {}, why: {} } };
    await gate.cache('key', answer); expect(await gate.cached('key')).toEqual(answer);
    await runInDurableObject(gate, (_instance, state) => { state.storage.sql.exec('UPDATE proposal_cache SET expires = ?', Date.now() - 1); });
    expect(await gate.cached('key')).toBeNull();
  });
  test('actual shared D1 ledger uses one atomic reservation across concurrent callers', async () => {
    const ledger = new D1Ledger(runtime.LEDGER); await ledger.charge('roamreprise', '2026-11-06', 880, 900, 9500);
    const results = await Promise.all([ledger.charge('roamreprise', '2026-11-06', 15, 900, 9500), ledger.charge('roamreprise', '2026-11-06', 15, 900, 9500)]);
    expect(results.filter(Boolean)).toHaveLength(1); await ledger.settle(results.find(Boolean)!, 3);
    expect(await ledger.spent('roamreprise', '2026-11-06')).toBe(883);
  });
  test('static assets use ASSETS and unknown API route is JSON 404', async () => {
    expect((await request('/data/ne_110m_land.geojson')).status).toBe(200);
    const unknown = await request('/api/unknown'); expect(unknown.status).toBe(404); expect(await unknown.json()).toHaveProperty('error', 'NOT_FOUND');
  });
});
