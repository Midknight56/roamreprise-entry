// Scriptable sandbox, adapted from Circlekeeper's injected-fetch tests (MIT). Never uses the network.
export interface Sent { method: string; path: string; headers: Headers; body: Record<string, any>; raw: string }
export class FakePayPal {
  sent: Sent[] = [];
  orders = new Map<string, Record<string, any>>();
  authorizations = new Map<string, Record<string, any>>();
  captures = new Map<string, Record<string, any>>();
  refunds = new Map<string, Record<string, any>>();
  results = new Map<string, { body: Record<string, any>; status: number }>();
  captureDeclined = false; refundStatus = 'COMPLETED'; captureStatus = 'COMPLETED'; signatureValid = true;
  transientCapture = 0; loseAuthorize = false; loseCreate = false; loseCapture = false; loseRefund = false;
  checkBeforeWrite?: (sent: Sent) => void | Promise<void>;
  private n = 0;
  calls(prefix: string) { return this.sent.filter(s => `${s.method} ${s.path}`.startsWith(prefix)); }
  private auth(order: Record<string, any>) {
    const a = { id: `AUTH-${++this.n}`, status: 'CREATED', amount: order.purchase_units[0].amount, custom_id: order.purchase_units[0].custom_id, expiration_time: new Date(Date.now() + 29 * 86_400_000).toISOString() };
    this.authorizations.set(a.id, a); order.status = 'COMPLETED'; order.purchase_units[0].payments = { authorizations: [a] };
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), raw = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, any> = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* OAuth body. */ }
    const s: Sent = { method: init?.method ?? 'GET', path: url.pathname, headers: new Headers(init?.headers), body, raw };
    this.sent.push(s);
    if (s.path === '/v1/oauth2/token') return Response.json({ access_token: 'test-token', expires_in: 3_600 });
    if (s.path === '/v1/notifications/verify-webhook-signature') return Response.json({ verification_status: this.signatureValid ? 'SUCCESS' : 'FAILURE' });
    if (s.method === 'GET') {
      const id = s.path.split('/').at(-1)!;
      const obj = this.orders.get(id) ?? this.authorizations.get(id) ?? this.captures.get(id) ?? this.refunds.get(id);
      return obj ? Response.json(obj) : Response.json({ name: 'RESOURCE_NOT_FOUND' }, { status: 404 });
    }
    await this.checkBeforeWrite?.(s);
    const key = s.headers.get('paypal-request-id')!;
    if (this.results.has(key)) {
      if (s.path.endsWith('/authorize') || (s.path === '/v2/checkout/orders' && s.body.payment_source?.card))
        return Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'TRANSACTION_REFUSED' }], debug_id: 'replay-refused' }, { status: 422 });
      const r = this.results.get(key)!;
      return Response.json(r.body, { status: s.path === '/v2/checkout/orders' ? 200 : r.status });
    }
    let result: Record<string, any> = {}, status = 201;
    let lose = false;
    if (s.path === '/v2/checkout/orders') {
      if (s.headers.has('paypal-mock-response')) return Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }], debug_id: 'decline-debug' }, { status: 422 });
      result = { id: `ORDER-${++this.n}`, status: 'CREATED', purchase_units: structuredClone(s.body.purchase_units) };
      this.orders.set(result.id, result);
      if (s.body.payment_source?.card) this.auth(result);
      lose = this.loseCreate; this.loseCreate = false;
    } else if (s.path.endsWith('/authorize')) {
      if (s.headers.has('paypal-mock-response')) return Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }], debug_id: 'decline-debug' }, { status: 422 });
      result = this.orders.get(s.path.split('/').at(-2)!)!;
      this.auth(result); lose = this.loseAuthorize; this.loseAuthorize = false;
    } else if (s.path.endsWith('/capture')) {
      if (this.transientCapture-- > 0) return Response.json({ name: 'INTERNAL_SERVER_ERROR', debug_id: 'retry-debug' }, { status: 503 });
      if (this.captureDeclined) return Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }, { status: 422 });
      const a = this.authorizations.get(s.path.split('/').at(-2)!)!;
      a.status = this.captureStatus === 'COMPLETED' ? 'CAPTURED' : 'CREATED';
      result = { id: `CAP-${++this.n}`, status: this.captureStatus, amount: a.amount, custom_id: a.custom_id };
      this.captures.set(result.id, result);
      for (const o of this.orders.values()) if (o.purchase_units[0].payments?.authorizations.some((p: Record<string, any>) => p.id === a.id)) o.purchase_units[0].payments.captures = [result];
      lose = this.loseCapture; this.loseCapture = false;
    } else if (s.path.endsWith('/void')) {
      result = this.authorizations.get(s.path.split('/').at(-2)!)!; result.status = 'VOIDED'; status = 200;
    } else if (s.path.endsWith('/refund')) {
      result = { id: `REF-${++this.n}`, status: this.refundStatus, amount: s.body.amount, custom_id: s.body.custom_id };
      this.refunds.set(result.id, result); lose = this.loseRefund; this.loseRefund = false;
    } else return Response.json({ name: 'UNEXPECTED_TEST_CALL' }, { status: 404 });
    result.debug_id = 'test-debug';
    this.results.set(key, { body: structuredClone(result), status });
    if (lose) throw new Error('Response lost after applying the write.');
    return Response.json(result, { status });
  };
}
