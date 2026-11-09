import { ApiError } from '../errors';
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
export interface PayPalCredentials { PAYPAL_CLIENT_ID: string; PAYPAL_CLIENT_SECRET: string; PAYPAL_BASE?: string }
export interface PayPalResult {
  status: number; body: Record<string, any>; debugId?: string; errorName?: string; uncertain?: boolean;
}
export interface CallReceipt { method: string; path: string; status: number; debugId?: string; requestId?: string; paypalStatus?: string }
export interface CallOptions { requestId?: string; headers?: Record<string, string>; retry?: boolean; beforeSend?: () => Promise<void> }
/** Adapted from Circlekeeper (MIT). Tokens stay in memory; never KV, logs, or trip JSON. */
export class PayPal {
  private access?: { token: string; until: number };
  onCall?: (receipt: CallReceipt) => Promise<void>;
  constructor(private env: PayPalCredentials, private fetchFn: typeof fetch = (input, init) => fetch(input, init),
    private clock: () => number = Date.now, private sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {
    if (env.PAYPAL_BASE && env.PAYPAL_BASE !== PAYPAL_BASE) throw new Error('Only PayPal sandbox is allowed.');
  }
  private async token(): Promise<string> {
    if (this.access && this.access.until > this.clock()) return this.access.token;
    const res = await this.fetchFn(PAYPAL_BASE + '/v1/oauth2/token', {
      method: 'POST', headers: { Authorization: 'Basic ' + btoa(this.env.PAYPAL_CLIENT_ID + ':' + this.env.PAYPAL_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new ApiError('PAYPAL_AUTH', 'PayPal sandbox authentication is unavailable.', 503);
    this.access = { token: body.access_token, until: this.clock() + Math.max(0, (body.expires_in ?? 0) - 60) * 1_000 };
    return body.access_token;
  }
  async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown> | string, options: CallOptions = {}): Promise<PayPalResult> {
    const requestId = method === 'POST' ? options.requestId ?? crypto.randomUUID() : undefined;
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    let uncertain = false;
    for (let attempt = 0; ; attempt++) {
      // Token failure happens before the financial write. Once any send was uncertain, retain that fact.
      let token: string;
      try { token = await this.token(); } catch (e) { if (!uncertain) throw e; return { status: 0, body: {}, uncertain: true }; }
      if (options.beforeSend) {
        try { await options.beforeSend(); } catch (e) { if (!uncertain) throw e; return { status: 0, body: {}, uncertain: true }; }
      }
      const headers: Record<string, string> = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation', ...options.headers };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      let result: PayPalResult;
      try {
        const res = await this.fetchFn(PAYPAL_BASE + path, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) });
        const raw = await res.text();
        let parsed: Record<string, any> = {};
        let valid = res.status === 204;
        if (raw) { try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) { parsed = value; valid = true; } } catch { /* Preserve uncertainty. */ } }
        result = { status: res.status, body: parsed, debugId: parsed.debug_id ?? res.headers.get('paypal-debug-id') ?? undefined,
          errorName: res.ok ? undefined : parsed.details?.[0]?.issue ?? parsed.name ?? `HTTP_${res.status}`,
          uncertain: uncertain || !valid || res.status >= 500 || res.status === 429 };
      } catch { result = { status: 0, body: {}, errorName: 'NO_CONNECTION', uncertain: true }; }
      if (this.onCall) await this.onCall({ method, path, status: result.status, debugId: result.debugId, requestId, paypalStatus: result.body.status ?? result.errorName });
      if (result.status === 401 && attempt === 0 && options.retry !== false) { this.access = undefined; continue; }
      // Retry server/throttle responses with exactly the original body and request id. Network loss is reconciled.
      if ((result.status >= 500 || result.status === 429) && attempt < 2 && options.retry !== false) {
        uncertain = true; await this.sleep(200 * 2 ** attempt); continue;
      }
      // A definitive successful replay resolves an earlier uncertain send.
      if (result.status >= 200 && result.status < 300 && result.body.id) result.uncertain = false;
      return result;
    }
  }
}
