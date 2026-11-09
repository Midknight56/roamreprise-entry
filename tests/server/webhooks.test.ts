import { describe, expect, test, vi } from 'vitest';
import { PayPal } from '../../src/paypal/client';
import { buildVerifyBody, handleWebhook, type PayPalEvent } from '../../src/paypal/webhooks';
import { ApiError } from '../../src/errors';
import { FakePayPal } from '../helpers/fake-paypal';
import { ID, world } from '../helpers/world';
const sig = () => new Headers({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 'transmission', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-11-06T20:00:00Z' });
const event = (custom_id = `rr-${ID}-v1`): PayPalEvent => ({ id: 'EVENT-1', event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: 'AUTH', status: 'CREATED', custom_id } });
describe('verified and monotone webhooks', () => {
  test('signature body preserves raw event whitespace byte for byte', () => {
    const raw = '{  "id" : "e",\n "resource": {"custom_id":"rr-abc"} }';
    expect(buildVerifyBody(sig(), 'WH-1', raw)!.endsWith(',"webhook_event":' + raw + '}')).toBe(true);
  });
  test('bad signature returns 400 and applies nothing', async () => {
    const sb = new FakePayPal(); sb.signatureValid = false;
    const w = await world();
    const pp = new PayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, sb.fetch), process = vi.fn((id: string, evt: PayPalEvent) => w.engine().webhook(evt));
    const response = await handleWebhook(new Request('https://test/webhooks/paypal', { method: 'POST', headers: sig(), body: JSON.stringify(event()) }), pp, 'WH-1', process);
    expect(response.status).toBe(400); expect(process).not.toHaveBeenCalled(); expect((await w.view()).webhooks).toEqual([]);
  });
  test('foreign custom_id is verified then ignored with 200', async () => {
    const sb = new FakePayPal(), pp = new PayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, sb.fetch), process = vi.fn();
    const response = await handleWebhook(new Request('https://test/webhooks/paypal', { method: 'POST', headers: sig(), body: JSON.stringify(event('circlekeeper-foreign')) }), pp, 'WH-1', process);
    expect(response.status).toBe(200); expect(process).not.toHaveBeenCalled(); expect(sb.calls('POST /v1/notifications/verify')).toHaveLength(1);
  });
  test('verified custom_id for a missing trip is acknowledged and logged once without storage', async () => {
    const sb = new FakePayPal(), pp = new PayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, sb.fetch);
    const process = vi.fn().mockRejectedValue(new ApiError('NOT_FOUND', 'Trip not found.', 404));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await handleWebhook(new Request('https://test/webhooks/paypal', { method: 'POST', headers: sig(), body: JSON.stringify(event()) }), pp, 'WH-1', process);
      expect(response.status).toBe(200);
      expect(process).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('{"webhook":"ignored","reason":"unknown trip"}');
    } finally { log.mockRestore(); }
  });
  test('owned custom_id routes to its trip and unsupported event is ignored', async () => {
    const sb = new FakePayPal(), pp = new PayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, sb.fetch), process = vi.fn();
    const evt = event();
    const request = () => new Request('https://test/webhooks/paypal', { method: 'POST', headers: sig(), body: JSON.stringify(evt) });
    expect((await handleWebhook(request(), pp, 'WH-1', process)).status).toBe(200);
    expect(process).toHaveBeenCalledWith(ID, evt);
    evt.event_type = 'UNSUPPORTED'; await handleWebhook(request(), pp, 'WH-1', process); expect(process).toHaveBeenCalledTimes(1);
  });
  test('duplicate event is stored uniquely and applied once', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card');
    const a = (await w.view()).payments[0], evt = event(); evt.resource.id = a.authorizationId;
    evt.create_time = '2026-11-06T19:59:00Z';
    await w.engine().webhook(evt);
    expect((await w.view()).webhooks).toEqual([{
      eventId: 'EVENT-1', eventType: 'PAYMENT.AUTHORIZATION.CREATED', createTime: evt.create_time,
      receivedAt: '2026-11-06T20:00:00.000Z', signatureVerified: true, quoteVersion: 1,
      resourceId: a.authorizationId, outcome: 'already known',
    }]);
    const before = await w.record(); await w.engine().webhook(evt);
    expect(await w.record()).toEqual(before); expect(w.store.events.size).toBe(1);
  });
  test('verified event stores its fields and applied outcome', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card');
    const a = (await w.view()).payments[0], evt = event();
    evt.event_type = 'PAYMENT.AUTHORIZATION.VOIDED'; evt.create_time = '2026-11-06T19:59:00Z';
    evt.resource.id = a.authorizationId; evt.resource.status = 'VOIDED';
    await w.engine().webhook(evt);
    expect((await w.view()).webhooks).toEqual([{
      eventId: 'EVENT-1', eventType: evt.event_type, createTime: evt.create_time,
      receivedAt: '2026-11-06T20:00:00.000Z', signatureVerified: true, quoteVersion: 1,
      resourceId: a.authorizationId, outcome: 'applied',
    }]);
    expect((await w.view()).payments[0].state).toBe('voided');
  });
  test('VOIDED after CAPTURED and late CREATED never regress captured money', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card'); await w.action('confirm');
    const a = (await w.view()).payments[0], evt = event(); evt.resource.id = a.authorizationId; evt.resource.status = 'VOIDED'; evt.event_type = 'PAYMENT.AUTHORIZATION.VOIDED';
    await w.engine().webhook(evt); evt.id = 'EVENT-2'; evt.resource.status = 'CREATED'; evt.event_type = 'PAYMENT.AUTHORIZATION.CREATED';
    await w.engine().webhook(evt); expect((await w.view()).payments[0].state).toBe('captured');
    expect((await w.view()).webhooks.at(-1)).toMatchObject({ eventId: 'EVENT-2', outcome: 'ignored (older than the current state)' });
    expect((await w.view()).webhooks[0]).toMatchObject({ outcome: 'ignored (older than the current state)' });
  });
  test('late authorization webhook cannot unlock an unresolved lost capture', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card');
    const a = (await w.view()).payments[0];
    await w.action('dev/fault', { kind: 'lose_next_response' }); await w.action('confirm');
    // Make reads temporarily unable to find the capture, as can happen during propagation.
    const order = w.sb.orders.get(a.orderId!)!; delete order.purchase_units[0].payments.captures;
    w.sb.authorizations.get(a.authorizationId!)!.status = 'CREATED';
    const evt = event(); evt.resource.id = a.authorizationId; await w.engine().webhook(evt);
    expect((await w.view()).phase).toBe('checking_payment');
  });
  test('refund webhook adopts an unknown refund id without issuing another refund', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card'); await w.action('confirm');
    w.sb.loseRefund = true; await w.action('supplier/cancel-activity');
    const refund = w.sb.refunds.values().next().value!;
    await w.engine().webhook({ id: 'REF-EVENT', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: structuredClone(refund) });
    expect((await w.view()).phase).toBe('refunded'); expect(w.sb.calls('POST /v2/payments/captures/')).toHaveLength(1);
  });
  test('old quote webhooks cannot change the new quote payment', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card');
    const old = (await w.view()).payments[0]; await w.action('supplier/hotel-unavailable');
    await w.action('repair/accept', { candidateId: (await w.view()).repair!.pickId }); await w.action('pay/card');
    await w.engine().webhook({ id: 'OLD-EVENT', event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: old.authorizationId, custom_id: `rr-${ID}-v1`, status: 'CREATED' } });
    expect((await w.view()).payments[0].state).toBe('voided'); expect((await w.view()).payments[1].state).toBe('authorized');
  });
});
