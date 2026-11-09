import type { PayPal } from './client';
import { readText } from '../body';
import { ApiError } from '../errors';
export const WEBHOOK_EVENTS = ['PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.REFUNDED'] as const;
export interface PayPalEvent { id: string; event_type: string; create_time?: string; resource: Record<string, any> }
const SIG_HEADERS = [['auth_algo', 'paypal-auth-algo'], ['cert_url', 'paypal-cert-url'], ['transmission_id', 'paypal-transmission-id'], ['transmission_sig', 'paypal-transmission-sig'], ['transmission_time', 'paypal-transmission-time']] as const;
/** Adapted from Circlekeeper (MIT). Keep the raw event byte-for-byte, including whitespace. */
export function buildVerifyBody(headers: Headers, webhookId: string, raw: string): string | null {
  if (!webhookId) return null;
  const fields: Record<string, string> = { webhook_id: webhookId };
  for (const [field, header] of SIG_HEADERS) { const value = headers.get(header); if (!value) return null; fields[field] = value; }
  return JSON.stringify(fields).slice(0, -1) + ',"webhook_event":' + raw + '}';
}
export async function handleWebhook(request: Request, paypal: PayPal, webhookId: string, process: (id: string, event: PayPalEvent) => Promise<void>): Promise<Response> {
  const bad = () => Response.json({ error: 'BAD_SIGNATURE', message: 'The PayPal signature could not be verified.' }, { status: 400 });
  let raw: string; try { raw = await readText(request, 1_048_576); } catch { return bad(); }
  if (!raw || new TextEncoder().encode(raw).length > 1_048_576) return bad();
  let event: PayPalEvent;
  try {
    event = JSON.parse(raw) as PayPalEvent;
    if (!event || typeof event.id !== 'string' || typeof event.event_type !== 'string' || !event.resource || typeof event.resource !== 'object') return bad();
  } catch { return bad(); }
  const verifyBody = buildVerifyBody(request.headers, webhookId, raw);
  if (!verifyBody) return bad();
  try {
    const verified = await paypal.request('POST', '/v1/notifications/verify-webhook-signature', verifyBody);
    if (verified.status !== 200 || verified.body.verification_status !== 'SUCCESS') return bad();
  } catch { return bad(); }
  if (typeof event.resource.custom_id !== 'string' || !event.resource.custom_id.startsWith('rr-') || !WEBHOOK_EVENTS.includes(event.event_type as typeof WEBHOOK_EVENTS[number])) return Response.json({ ok: true });
  const match = /^rr-([a-z2-7]{16})-(?:v|r)\d+$/.exec(event.resource.custom_id);
  if (!match) return Response.json({ ok: true });
  // Await durable processing so a failure returns 5xx and PayPal retries. No acknowledged lost events.
  try { await process(match[1], event); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'NOT_FOUND' || error.message !== 'Trip not found.') throw error;
    console.log(JSON.stringify({ webhook: 'ignored', reason: 'unknown trip' }));
  }
  return Response.json({ ok: true });
}
