import { expect, test } from 'vitest';
import { PayPal } from '../../src/paypal/client';
import { authorizeOrder, createOrder, type WriteSpec } from '../../src/paypal/payments';
import { FakePayPal } from '../helpers/fake-paypal';

test('fake sandbox replays source-free creates but refuses repeated authorize and exposes the original hold on GET', async () => {
  const sandbox = new FakePayPal(), paypal = new PayPal({ PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test' }, sandbox.fetch);
  const send = (spec: WriteSpec, requestId: string) => paypal.request('POST', spec.path, spec.body, { requestId });
  const spec = createOrder('trip', 1, 10000);
  const created = await send(spec, 'create-id'), replay = await send(spec, 'create-id');
  expect(created.status).toBe(201); expect(replay.status).toBe(200); expect(replay.body.id).toBe(created.body.id);
  const authorize = authorizeOrder(created.body.id, true);
  const first = await send(authorize, 'authorize-id'), second = await send(authorize, 'authorize-id');
  expect(first.status).toBe(201); expect(second).toMatchObject({ status: 422, errorName: 'TRANSACTION_REFUSED' });
  const read = await paypal.request('GET', `${spec.path}/${created.body.id}`);
  expect(read.body.purchase_units[0].payments.authorizations[0].id).toBe(first.body.purchase_units[0].payments.authorizations[0].id);
  expect(sandbox.authorizations.size).toBe(1);
});

test('fake sandbox refuses a legacy card create replay instead of pretending to replay its authorization', async () => {
  const sandbox = new FakePayPal(), paypal = new PayPal({ PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test' }, sandbox.fetch);
  const spec = createOrder('trip', 1, 10000);
  const body = { ...spec.body, ...authorizeOrder('unused', true).body };
  expect((await paypal.request('POST', spec.path, body, { requestId: 'legacy' })).status).toBe(201);
  expect(await paypal.request('POST', spec.path, body, { requestId: 'legacy' })).toMatchObject({ status: 422, errorName: 'TRANSACTION_REFUSED' });
  expect(sandbox.orders.size).toBe(1); expect(sandbox.authorizations.size).toBe(1);
});
