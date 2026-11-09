import { describe, expect, test } from 'vitest';
import { isActive, validateSchedule } from '../../src/domain/validate';
import { TripEngine } from '../../src/trip/engine';
import { MemoryStore } from '../../src/trip/store';
import { PayPal } from '../../src/paypal/client';
import { ID, SID, input, world } from '../helpers/world';
const pay = async (w: Awaited<ReturnType<typeof world>>) => { await w.action('quote'); await w.action('pay/card'); };
const capture = async (w: Awaited<ReturnType<typeof world>>) => { await pay(w); await w.action('confirm'); };
const writes = (w: Awaited<ReturnType<typeof world>>, ending: string) => w.sb.sent.filter(s => s.method === 'POST' && s.path.endsWith(ending));
describe('TripEngine payment flow', () => {
  test('happy card: intent persisted first, authorize, holds, confirm, final capture and receipts', async () => {
    const w = await world();
    w.sb.checkBeforeWrite = async sent => {
      const ops = await w.store.ops();
      expect(ops.some(o => o.requestId === sent.headers.get('paypal-request-id') && JSON.stringify(o.body) === sent.raw)).toBe(true);
      expect((await w.record())!.payments.at(-1)!.state).toBe('unknown');
    };
    await pay(w);
    expect((await w.view()).itinerary.items.filter(i => i.booked && isActive(i)).every(i => i.state === 'held' && i.supplierRef?.startsWith('SIM-'))).toBe(true);
    await w.action('confirm'); const v = await w.view();
    expect(v.phase).toBe('confirmed_captured');
    expect(writes(w, '/capture')[0].body.final_capture).toBe(true);
    expect(v.payments[0].receipts.some(r => r.debugId === 'test-debug')).toBe(true);
    expect(writes(w, '/orders')[0].body.purchase_units).toHaveLength(1);
    expect(writes(w, '/orders')[0].body.payment_source).toBeUndefined();
    expect(writes(w, '/authorize')[0].body.payment_source.card.number).toBe('4111111111111111');
    expect(writes(w, '/authorize')[0].headers.get('paypal-request-id')).not.toBe(writes(w, '/orders')[0].headers.get('paypal-request-id'));
  });
  test('retries reuse request id and exact body; every physical write is counted', async () => {
    const w = await world(); await pay(w); w.sb.transientCapture = 1; await w.action('confirm');
    const sent = writes(w, '/capture'); expect(sent).toHaveLength(2);
    expect(sent[0].headers.get('paypal-request-id')).toBe(sent[1].headers.get('paypal-request-id'));
    expect(sent[0].raw).toBe(sent[1].raw); expect((await w.record())!.writes).toBe(4);
  });
  test('declined card: nothing confirmed; phase declined and deliberate payment retry succeeds', async () => {
    const w = await world(); await w.action('quote'); await w.action('pay/card', { declineTest: true });
    let v = await w.view(); expect(v.phase).toBe('declined'); expect(v.next).toEqual(['pay']);
    expect(v.itinerary.items.some(i => i.state === 'confirmed')).toBe(false);
    expect(writes(w, '/capture')).toHaveLength(0);
    expect(writes(w, '/orders')[0].headers.has('paypal-mock-response')).toBe(false);
    expect(writes(w, '/authorize')[0].headers.get('paypal-mock-response')).toContain('INSTRUMENT_DECLINED');
    await w.action('pay/card'); v = await w.view(); expect(v.phase).toBe('holding'); expect(v.payments).toHaveLength(2);
  });
  test('wallet: create then authorize; foreign order id refused', async () => {
    const w = await world(); await w.action('quote');
    const answer = await w.action('pay/order') as {orderId: string};
    await expect(w.action('pay/authorize', { orderId: 'someone-else' })).rejects.toMatchObject({ code: 'ORDER_MISMATCH' });
    await w.action('pay/authorize', answer);
    expect((await w.view()).phase).toBe('holding'); expect(writes(w, '/authorize')).toHaveLength(1);
  });
  test('lost authorize: reads the original order, adopts authorization, places holds once; one order', async () => {
    const w = await world(); await w.action('quote');
    const order = await w.action('pay/order') as {orderId: string};
    w.sb.loseAuthorize = true; await w.action('pay/authorize', order);
    expect((await w.view()).phase).toBe('checking_payment');
    await expect(w.action('pay/card')).rejects.toMatchObject({ code: 'CHECKING_PAYMENT' });
    w.restart(); await w.action('reconcile'); const v = await w.view();
    expect(v.phase).toBe('holding'); expect(v.payments[0].authorizationId).toBeTruthy();
    expect(writes(w, '/orders')).toHaveLength(1); expect(writes(w, '/authorize')).toHaveLength(1);
    const refs = v.itinerary.items.map(i => i.supplierRef); await w.action('reserve');
    expect((await w.view()).itinerary.items.map(i => i.supplierRef)).toEqual(refs);
  });
  test('lost create response recovers only with the same persisted request and body', async () => {
    const w = await world(); await w.action('quote'); w.sb.loseCreate = true; await w.action('pay/card');
    w.restart(); await w.action('reconcile'); expect((await w.view()).phase).toBe('holding');
    const sent = writes(w, '/orders'); expect(sent).toHaveLength(2); expect(w.sb.orders.size).toBe(1);
    expect(sent[0].raw).toBe(sent[1].raw); expect(sent[0].headers.get('paypal-request-id')).toBe(sent[1].headers.get('paypal-request-id'));
  });
  test('lost card authorize: one create, one authorize, order read recovers the hold after restart', async () => {
    const w = await world(); await w.action('quote'); w.sb.loseAuthorize = true;
    await w.action('pay/card');
    expect((await w.view()).phase).toBe('checking_payment');
    w.restart(); await w.action('reconcile'); const v = await w.view();
    expect(v.phase).toBe('holding');
    expect(writes(w, '/orders')).toHaveLength(1); expect(writes(w, '/authorize')).toHaveLength(1);
    expect(w.sb.authorizations.size).toBe(1);
    expect(v.payments[0].receipts.slice(0, 3).map(r => [r.op, r.status])).toEqual([
      ['create', 201], ['authorize', 0], ['read_order', 200],
    ]);
  });
  test('lost authorize with no authorization in the read stays locked until a later read finds it', async () => {
    const w = await world(); await w.action('quote'); w.sb.loseAuthorize = true; await w.action('pay/card');
    const order = [...w.sb.orders.values()][0], payments = order.purchase_units[0].payments;
    delete order.purchase_units[0].payments; order.status = 'CREATED';
    w.restart(); await w.action('reconcile');
    expect((await w.view()).next).toEqual(['reconcile']);
    await expect(w.action('pay/card')).rejects.toMatchObject({ code: 'CHECKING_PAYMENT' });
    await w.action('reconcile'); expect((await w.view()).phase).toBe('checking_payment');
    expect(writes(w, '/authorize')).toHaveLength(1);
    order.purchase_units[0].payments = payments; order.status = 'COMPLETED';
    await w.action('reconcile'); expect((await w.view()).phase).toBe('holding');
    expect(writes(w, '/authorize')).toHaveLength(1);
  });
  test('create replay 422 cannot decline an uncertain payment or unlock another write', async () => {
    const w = await world(); await w.action('quote'); w.sb.loseCreate = true; await w.action('pay/card');
    const fetch = w.sb.fetch;
    w.deps.paypal = new PayPal(
      { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, async (url, init) =>
        String(url).endsWith('/v2/checkout/orders') && init?.method === 'POST'
          ? Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'TRANSACTION_REFUSED' }] }, { status: 422 }) : fetch(url, init));
    w.restart(); await w.action('reconcile');
    expect((await w.view()).phase).toBe('checking_payment');
    expect((await w.store.ops())[0].state).toBe('prepared');
    await expect(w.action('pay/card')).rejects.toMatchObject({ code: 'CHECKING_PAYMENT' });
  });
  test('authorize server error after applying the hold is read back without an automatic retry', async () => {
    const w = await world(), fetch = w.sb.fetch;
    w.deps.paypal = new PayPal(
      { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, async (url, init) => {
        const response = await fetch(url, init);
        return String(url).endsWith('/authorize') && init?.method === 'POST'
          ? Response.json({ name: 'INTERNAL_SERVER_ERROR' }, { status: 503 }) : response;
      });
    w.restart(); await w.action('quote'); await w.action('pay/card');
    expect((await w.view()).phase).toBe('checking_payment');
    await w.action('reconcile'); expect((await w.view()).phase).toBe('holding');
    expect(writes(w, '/authorize')).toHaveLength(1);
  });
  test('card fault receipts show create 201, authorize RESPONSE_LOST, then order read 200', async () => {
    const w = await world(); await w.action('quote');
    await w.action('dev/fault', { kind: 'lose_next_response' }); await w.action('pay/card');
    expect((await w.view()).next).toEqual(['reconcile']);
    w.restart(); await w.action('reconcile');
    const v = await w.view(); expect(v.phase).toBe('holding');
    expect(v.payments[0].receipts.slice(0, 3).map(r => [r.op, r.status, r.paypalStatus])).toEqual([
      ['create', 201, 'CREATED'], ['authorize', 0, 'RESPONSE_LOST'], ['read_order', 200, 'COMPLETED'],
    ]);
    expect(writes(w, '/orders')).toHaveLength(1); expect(writes(w, '/authorize')).toHaveLength(1);
  });
  test('unsent card authorize cap refusal keeps the original order and exposes a retry', async () => {
    const w = await world(); await w.action('quote');
    w.sb.checkBeforeWrite = sent => { if (sent.path.endsWith('/orders')) w.gate.counts.set('2026-11-06:writes', 800); };
    await expect(w.action('pay/card')).rejects.toMatchObject({ code: 'PAYPAL_CAP' });
    expect((await w.view()).next).toEqual(['pay']); expect(writes(w, '/authorize')).toHaveLength(0);
    w.sb.checkBeforeWrite = undefined; w.setNow('2026-11-07T00:00:00Z');
    await w.action('pay/card'); expect((await w.view()).phase).toBe('holding');
    expect(writes(w, '/orders')).toHaveLength(1); expect(writes(w, '/authorize')).toHaveLength(1);
  });
  test('hotel failed: release holds, checked candidates, void, approved v2 quote, second authorization', async () => {
    const w = await world(); await pay(w); await w.action('supplier/hotel-unavailable');
    const proposed = await w.view(); expect(proposed.phase).toBe('repair_proposed');
    expect(proposed.itinerary.items.some(i => i.state === 'held')).toBe(false);
    expect(proposed.repair!.candidates.find(c => c.id === 'h-terraco')!.checks.ok).toBe(false);
    await w.action('repair/accept', { candidateId: proposed.repair!.pickId });
    const accepted = await w.view(); expect(accepted.phase).toBe('requote'); expect(accepted.next).toEqual(['pay']);
    expect(accepted.quote!.version).toBe(2); expect(accepted.payments[0].state).toBe('voided');
    expect(validateSchedule(accepted.itinerary, accepted.ceilingCents).ok).toBe(true);
    await w.action('pay/card'); await w.action('confirm');
    const v = await w.view(); expect(v.phase).toBe('confirmed_captured'); expect(v.payments).toHaveLength(2);
    expect(v.payments[0].authorizationId).not.toBe(v.payments[1].authorizationId);
  });
  test('lost void reply reconciles and completes the accepted repair without another authorization', async () => {
    const w = await world(); await pay(w); await w.action('supplier/hotel-unavailable');
    const candidateId = (await w.view()).repair!.pickId;
    await w.action('dev/fault', { kind: 'lose_next_response' }); await w.action('repair/accept', { candidateId });
    expect((await w.view()).phase).toBe('checking_payment'); w.restart(); await w.action('reconcile');
    expect((await w.view()).phase).toBe('requote'); expect(writes(w, '/void')).toHaveLength(1);
  });
  test('lost capture: blocks writes, survives restart, read CAPTURED settles; never captures twice', async () => {
    const w = await world(); await pay(w); await w.action('dev/fault', { kind: 'lose_next_response' });
    await w.action('confirm'); expect((await w.view()).next).toEqual(['reconcile']);
    for (const action of ['quote', 'pay/card', 'confirm', 'supplier/hotel-unavailable', 'supplier/cancel-activity']) await expect(w.action(action)).rejects.toMatchObject({ code: 'CHECKING_PAYMENT' });
    w.restart(); await w.action('reconcile'); expect((await w.view()).phase).toBe('confirmed_captured');
    await w.action('confirm'); expect(writes(w, '/capture')).toHaveLength(1);
  });
  test('capture declined after holds: compensate confirmed bookings; no second capture', async () => {
    const w = await world(); await pay(w); w.sb.captureDeclined = true; await w.action('confirm');
    const v = await w.view(); expect(v.phase).toBe('declined');
    expect(v.itinerary.items.filter(i => i.booked).every(i => i.state === 'cancelled')).toBe(true);
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'STATE' }); expect(writes(w, '/capture')).toHaveLength(1);
  });
  test('compensation failures are listed and block another pay until reconciled', async () => {
    const w = await world(); await pay(w); w.sb.captureDeclined = true;
    const cancel = w.supplier.cancel.bind(w.supplier);
    w.supplier.cancel = () => { throw new Error('Simulated supplier unavailable'); };
    await w.action('confirm'); const v = await w.view(); expect(v.issues.some(i => i.message.includes('Unresolved Simulated supplier'))).toBe(true);
    await expect(w.action('pay/card')).rejects.toMatchObject({ code: 'STATE' });
    w.supplier.cancel = cancel; await w.action('reconcile'); expect((await w.record())!.compensation).toHaveLength(0);
  });
  test('expired authorization: capture refused, holds released, fresh pay required', async () => {
    const w = await world(); await pay(w); await w.action('dev/fault', { kind: 'expire_authorization' });
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' });
    expect((await w.view()).payments[0].state).toBe('expired'); expect(writes(w, '/capture')).toHaveLength(0);
    await w.action('pay/card'); expect(writes(w, '/orders')).toHaveLength(2);
  });
  test('activity cancellation: checked replacement, refund $58 pending then completed', async () => {
    const w = await world(); await capture(w); w.sb.refundStatus = 'PENDING'; await w.action('supplier/cancel-activity');
    let v = await w.view(); expect(v.phase).toBe('refund_pending'); expect(v.payments[0].refunds[0].amountCents).toBe(5800);
    expect(v.itinerary.items.some(i => i.offerId === 'a-graca' && i.state === 'confirmed')).toBe(true);
    expect(writes(w, '/refund')[0].body.amount.value).toBe('58.00');
    w.sb.refunds.values().next().value!.status = 'COMPLETED'; await w.action('reconcile'); v = await w.view();
    expect(v.phase).toBe('refunded'); expect(v.payments[0].refunds[0].state).toBe('completed');
    await w.action('supplier/cancel-activity'); expect(writes(w, '/refund')).toHaveLength(1);
  });
  test('refund pending then failed: outstanding money remains separate from the repaired itinerary', async () => {
    const w = await world(); await capture(w); w.sb.refundStatus = 'PENDING'; await w.action('supplier/cancel-activity');
    w.sb.refunds.values().next().value!.status = 'FAILED'; await w.action('reconcile');
    const v = await w.view(); expect(v.phase).toBe('refund_pending'); expect(v.payments[0].refunds[0]).toMatchObject({ state: 'failed', amountCents: 5800 });
    expect(v.log.some(l => l.summary.includes('outstanding'))).toBe(true);
  });
  test('lost refund reply: same-id replay recovers refund and no second refund is issued', async () => {
    const w = await world(); await capture(w); w.sb.loseRefund = true; await w.action('supplier/cancel-activity');
    expect((await w.view()).phase).toBe('checking_payment'); w.restart(); await w.action('reconcile');
    expect((await w.view()).phase).toBe('refunded'); expect(w.sb.refunds.size).toBe(1);
  });
  test('pending capture is never shown as paid', async () => {
    const w = await world(); await pay(w); w.sb.captureStatus = 'PENDING'; await w.action('confirm');
    expect((await w.view()).phase).toBe('checking_payment'); expect((await w.view()).payments[0].state).toBe('capturing');
    await expect(w.action('supplier/cancel-activity')).rejects.toMatchObject({ code: 'STATE' });
  });
  test('concurrent confirm presses through the same queue capture once', async () => {
    const w = await world(); await pay(w); await Promise.all([w.action('confirm'), w.action('confirm')]);
    expect(writes(w, '/capture')).toHaveLength(1);
  });
  test('mismatched amount is refused before capture', async () => {
    const w = await world(); await pay(w); const t = (await w.record())!; t.payments[0].amountCents++; await w.store.put('trip', t);
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' }); expect(writes(w, '/capture')).toHaveLength(0);
  });
  test('another sid gets NOT_YOUR_TRIP on reads and writes', async () => {
    const w = await world(); await expect(w.engine().get('different-sid')).rejects.toMatchObject({ code: 'NOT_YOUR_TRIP', status: 403 });
    await expect(w.engine().action('different-sid', 'quote')).rejects.toMatchObject({ code: 'NOT_YOUR_TRIP', status: 403 });
  });
  test('13th trip per sid is refused by daily gate; midnight resets', async () => {
    const w = await world();
    for (let n = 1; n < 12; n++) await new TripEngine({ ...w.deps, store: new MemoryStore() }).create(ID, SID, input());
    await expect(new TripEngine({ ...w.deps, store: new MemoryStore() }).create(ID, SID, input())).rejects.toMatchObject({ code: 'TRIP_CAP', status: 429 });
    w.setNow('2026-11-07T00:00:00Z'); await expect(new TripEngine({ ...w.deps, store: new MemoryStore() }).create(ID, SID, input())).resolves.toHaveProperty('phase', 'planned');
  });
  test('PayPal per-trip write cap refuses before a financial send', async () => {
    const w = await world(); await pay(w); const t = (await w.record())!; t.writes = 30; await w.store.put('trip', t);
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'PAYPAL_CAP', status: 429 }); expect(writes(w, '/capture')).toHaveLength(0);
  });
  test('daily PayPal write cap refuses; an unsent order retries safely after midnight', async () => {
    const w = await world(); await w.action('quote'); w.gate.counts.set('2026-11-06:writes', 800);
    await expect(w.action('pay/card')).rejects.toMatchObject({ code: 'PAYPAL_CAP', status: 429 });
    expect(writes(w, '/orders')).toHaveLength(0); expect((await w.view()).phase).toBe('quoted');
    await w.action('reconcile'); expect((await w.view()).next).toEqual(['pay']);
    w.setNow('2026-11-07T00:00:00Z'); await w.action('pay/card');
    expect(writes(w, '/orders')).toHaveLength(1); expect((await w.view()).payments).toHaveLength(1);
    expect((await w.view()).phase).toBe('holding');
  });
  test('unsent capture cap refusal stays authorized after reconcile', async () => {
    const w = await world(); await pay(w); w.gate.counts.set('2026-11-06:writes', 800);
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'PAYPAL_CAP' }); await w.action('reconcile');
    expect((await w.view()).payments[0].state).toBe('authorized');
    w.setNow('2026-11-07T00:00:00Z'); await w.action('confirm'); expect(writes(w, '/capture')).toHaveLength(1);
  });
  test('unknown create outside idempotency window is kept checking; no unsafe replay', async () => {
    const w = await world(); await w.action('quote'); w.sb.loseCreate = true; await w.action('pay/card');
    w.setNow('2026-11-07T03:00:00Z'); await w.action('reconcile');
    expect((await w.view()).phase).toBe('checking_payment'); expect(writes(w, '/orders')).toHaveLength(1);
  });
  test('PayPal authorization amount mismatch refuses capture before confirming suppliers', async () => {
    const w = await world(); await pay(w);
    const a = (await w.view()).payments[0]; w.sb.authorizations.get(a.authorizationId!)!.amount = { currency_code: 'USD', value: '1.00' };
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(writes(w, '/capture')).toHaveLength(0); expect((await w.view()).itinerary.items.some(i => i.state === 'confirmed')).toBe(false);
  });
  test.each([{ currency_code: 'EUR', value: '450.00' }, { currency_code: 'USD', value: 'invalid' }])('invalid PayPal authorization amount %j refuses capture', async amount => {
    const w = await world(); await pay(w); const a = (await w.view()).payments[0];
    w.sb.authorizations.get(a.authorizationId!)!.amount = amount;
    await expect(w.action('confirm')).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' }); expect(writes(w, '/capture')).toHaveLength(0);
  });
  test('hotel rejects during confirm: compensate and propose repair without capture', async () => {
    const w = await world(); await pay(w); w.supplier.flags.hotelUnavailable = true;
    await w.action('confirm'); const v = await w.view();
    expect(v.phase).toBe('repair_proposed'); expect(v.repair!.candidates.some(c => c.checks.ok)).toBe(true);
    expect(writes(w, '/capture')).toHaveLength(0);
    expect(v.itinerary.items.some(i => ['held', 'confirmed'].includes(i.state) && i.booked)).toBe(false);
    await w.action('repair/accept', { candidateId: v.repair!.pickId }); expect((await w.view()).phase).toBe('requote');
  });
  test('crash between operation outcome and trip save recovers saved create result without another order', async () => {
    const w = await world(); await pay(w);
    const t = (await w.record())!, a = t.payments[0];
    a.state = 'unknown'; a.previousState = 'none'; delete a.orderId; delete a.authorizationId;
    await w.store.put('trip', t); w.restart(); await w.action('reconcile');
    expect((await w.view()).phase).toBe('holding'); expect(writes(w, '/orders')).toHaveLength(1);
  });
  test('crash between failed capture outcome and trip save compensates reservations', async () => {
    const w = await world(); await pay(w); w.sb.captureDeclined = true; await w.action('confirm');
    const t = (await w.record())!, a = t.payments[0]; a.state = 'unknown'; a.previousState = 'authorized';
    t.itinerary.items = t.itinerary.items.map(i => i.booked ? { ...i, state: 'confirmed' } : i);
    await w.store.put('trip', t); w.restart(); await w.action('reconcile');
    const v = await w.view(); expect(v.payments[0].state).toBe('declined');
    expect(v.itinerary.items.filter(i => i.booked).every(i => i.state === 'cancelled')).toBe(true);
    expect(writes(w, '/capture')).toHaveLength(1);
  });
  test('interrupted repair AI leaves a usable rule proposal after restart', async () => {
    const w = await world(); await pay(w);
    w.deps.ai.repairPick = async () => { throw new Error('Interrupted AI call'); };
    await expect(w.action('supplier/hotel-unavailable')).rejects.toThrow('Interrupted'); w.restart();
    const v = await w.view(); expect(v.phase).toBe('repair_proposed'); expect(v.repair!.pickSource).toBe('rule');
    await w.action('repair/accept', { candidateId: v.repair!.pickId }); expect((await w.view()).phase).toBe('requote');
  });
  test('unsent void cap refusal can retry acceptance after midnight', async () => {
    const w = await world(); await pay(w); await w.action('supplier/hotel-unavailable');
    const candidateId = (await w.view()).repair!.pickId; w.gate.counts.set('2026-11-06:writes', 800);
    await expect(w.action('repair/accept', { candidateId })).rejects.toMatchObject({ code: 'PAYPAL_CAP' });
    expect((await w.view()).phase).toBe('repair_proposed');
    w.setNow('2026-11-07T00:00:00Z'); await w.action('repair/accept', { candidateId });
    expect((await w.view()).phase).toBe('requote'); expect(writes(w, '/void')).toHaveLength(1);
  });
  test('unsent refund remains outstanding at the cap and can send after the next daily reset', async () => {
    const w = await world(); await capture(w); w.gate.counts.set('2026-11-06:writes', 800);
    await expect(w.action('supplier/cancel-activity')).rejects.toMatchObject({ code: 'PAYPAL_CAP' });
    expect((await w.view()).phase).toBe('refund_pending'); expect(writes(w, '/refund')).toHaveLength(0);
    w.setNow('2026-11-07T08:00:00Z'); await w.action('reconcile');
    expect((await w.view()).phase).toBe('refunded'); expect(writes(w, '/refund')).toHaveLength(1);
  });
});
