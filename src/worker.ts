import { D1Ledger } from './ai/ledger';
import { readText } from './body';
import { DAILY_NEURONS, utcDay } from './caps';
import type { Env } from './env';
import { ApiError, errorResponse } from './errors';
import { PayPal } from './paypal/client';
import { handleWebhook } from './paypal/webhooks';
import recordedProposal from './recorded/default-propose.json';
import recordedRepair from './recorded/default-repair.json';
export { TripDO } from './trip/do';
export { GateDO } from './gate/do';
const ACTIONS = new Set(['quote', 'pay/card', 'pay/order', 'pay/authorize', 'reserve', 'supplier/hotel-unavailable', 'repair/accept', 'ask', 'confirm', 'supplier/cancel-activity', 'reconcile', 'dev/fault']);
function randomId(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map(n => 'abcdefghijklmnopqrstuvwxyz234567'[n & 31]).join(''); }
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const raw = await readText(request, 8_192);
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* Report a JSON error. */ }
  throw new ApiError('BAD_REQUEST', 'Send a JSON object.', 400);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let fresh = false;
    let sid = /(?:^|;\s*)rr_sid=([a-z2-7]{16})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];
    if (!sid) { sid = randomId(); fresh = true; }
    let response: Response;
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') response = Response.json({ ok: true, build: env.BUILD_TAG });
      else if (request.method === 'GET' && url.pathname === '/api/config') {
        let left = 0; try { left = Math.max(0, DAILY_NEURONS - await new D1Ledger(env.LEDGER).spent('roamreprise', utcDay(new Date()))); } catch { /* Fail closed on ledger error. */ }
        response = Response.json({ paypalClientId: env.PAYPAL_CLIENT_ID ?? '', build: env.BUILD_TAG, liveAi: env.LIVE_AI === '1' && left >= 15, aiLeftToday: left, recordedRunDate: recordedProposal.capturedAt });
      } else if (request.method === 'GET' && url.pathname === '/api/recorded') {
        response = Response.json({ capturedAt: recordedProposal.capturedAt, placeholder: recordedProposal.placeholder || recordedRepair.placeholder,
          label: recordedProposal.placeholder ? 'Rule pick. No recorded live run exists yet.' : `Recorded run, captured ${recordedProposal.capturedAt}. No PayPal request is sent.`, propose: recordedProposal, repair: recordedRepair });
      } else if (request.method === 'POST' && url.pathname === '/webhooks/paypal') {
        response = await handleWebhook(request, new PayPal(env), env.PAYPAL_WEBHOOK_ID, (id, event) => env.TRIP.getByName(id).receiveEvent(event));
      } else if (request.method === 'POST' && url.pathname === '/api/trips') {
        const body = await bodyOf(request), id = randomId();
        response = await env.TRIP.getByName(id).request(id, sid, 'create', body);
      } else if (request.method === 'POST' && url.pathname === '/api/dev/record-ai' && env.DEV_ROUTES === '1') {
        const id = randomId();
        response = await env.TRIP.getByName(id).record(id, sid, await bodyOf(request));
      } else {
        const match = /^\/api\/trips\/([a-z2-7]{16})(?:\/(.+))?$/.exec(url.pathname);
        if (match) {
          const [, id, action] = match;
          if (request.method === 'GET' && !action) response = await env.TRIP.getByName(id).request(id, sid, 'get');
          else if (request.method === 'POST' && ACTIONS.has(action) && (action !== 'dev/fault' || env.DEV_ROUTES === '1')) {
            response = await env.TRIP.getByName(id).request(id, sid, action, await bodyOf(request));
          } else throw new ApiError('NOT_FOUND', 'Route not found.', 404);
        } else if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) throw new ApiError('NOT_FOUND', 'Route not found.', 404);
        else response = await env.ASSETS.fetch(request);
      }
    } catch (error) { response = errorResponse(error); }
    const headers = new Headers(response.headers);
    if (fresh) headers.append('Set-Cookie', `rr_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${url.protocol === 'https:' ? '; Secure' : ''}`);
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
