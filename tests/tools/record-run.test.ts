import { expect, test } from 'vitest';
// @ts-expect-error Operator script is plain JavaScript, imported without running its CLI.
import { recordRun, withoutSession } from '../../dev/record_run.mjs';

test('record run saves every returned TripView in order and removes session data recursively', async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const phases = ['planned', 'quoted', 'holding', 'repair_proposed', 'requote', 'holding', 'confirmed_captured', 'refund_pending', 'refunded'];
  const fetch = async (url: URL, init?: RequestInit) => {
    calls.push({ path: url.pathname, init });
    if (url.pathname === '/healthz') return Response.json({ build: 'record-test' }, { headers: { 'set-cookie': 'rr_sid=private; HttpOnly' } });
    const phase = phases.shift();
    return Response.json({ id: 'test-trip', phase, itinerary: {}, payments: [], repair: { pickId: 'checked-hotel' },
      sid: 'private', sessionId: 'private', cookie: 'private', nested: { rr_sid: 'private' } });
  };
  const recording = await recordRun('http://localhost:8812', fetch);
  expect(recording.build).toBe('record-test');
  expect(recording.snapshots.map((v: { phase: string }) => v.phase)).toEqual([
    'planned', 'quoted', 'holding', 'repair_proposed', 'requote', 'holding', 'confirmed_captured', 'refund_pending', 'refunded',
  ]);
  expect(JSON.stringify(recording)).not.toContain('private');
  expect(calls[1].init!.headers).toMatchObject({ Cookie: 'rr_sid=private' });
  expect(calls.filter(c => c.path.endsWith('/pay/card'))).toHaveLength(2);
  expect(calls.find(c => c.path.endsWith('/repair/accept'))!.init!.body).toBe('{"candidateId":"checked-hotel"}');
  expect(withoutSession({ 'set-cookie': 'secret', safe: [{ session_id: 'secret', phase: 'planned' }] })).toEqual({ safe: [{ phase: 'planned' }] });
});

test('record run stops on a payment error instead of repeating the write', async () => {
  const calls: string[] = [];
  const fetch = async (url: URL) => {
    calls.push(url.pathname);
    if (url.pathname === '/healthz') return Response.json({ build: 'test' });
    if (url.pathname.endsWith('/pay/card')) return Response.json({ error: 'PAYPAL_CAP' }, { status: 429 });
    return Response.json({ id: 'test-trip', phase: 'quoted', itinerary: {}, payments: [] });
  };
  await expect(recordRun('http://localhost:8812', fetch)).rejects.toThrow('HTTP 429 PAYPAL_CAP');
  expect(calls.filter(path => path.endsWith('/pay/card'))).toHaveLength(1);
});
