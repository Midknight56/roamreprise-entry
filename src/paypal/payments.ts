import { toValue } from '../domain/money';
import type { OperationKind } from '../trip/store';
export interface WriteSpec { op: OperationKind; path: string; body: Record<string, unknown>; headers?: Record<string, string> }
export const amount = (cents: number) => ({ currency_code: 'USD', value: toValue(cents) });
export function createOrder(tripId: string, version: number, cents: number): WriteSpec {
  const body: Record<string, unknown> = { intent: 'AUTHORIZE', purchase_units: [{ custom_id: `rr-${tripId}-v${version}`, amount: amount(cents), description: 'RoamReprise sandbox trip. Simulated supplier.' }] };
  return { op: 'create', path: '/v2/checkout/orders', body };
}
const testCard = () => ({ card: {
    // PayPal's published SANDBOX test Visa only. Never accept or store a visitor's card details.
    number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Test Traveler',
    billing_address: { address_line_1: '123 Main Street', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
  } });
const encoded = (id: string) => encodeURIComponent(id);
export const authorizeOrder = (id: string, card = false, declineTest = false): WriteSpec => ({
  op: 'authorize', path: `/v2/checkout/orders/${encoded(id)}/authorize`,
  body: card ? { payment_source: testCard() } : {},
  ...(declineTest ? { headers: { 'PayPal-Mock-Response': '{"mock_application_codes":"INSTRUMENT_DECLINED"}' } } : {}),
});
export const captureAuthorization = (id: string, cents: number): WriteSpec => ({ op: 'capture', path: `/v2/payments/authorizations/${encoded(id)}/capture`, body: { amount: amount(cents), final_capture: true } });
export const voidAuthorization = (id: string): WriteSpec => ({ op: 'void', path: `/v2/payments/authorizations/${encoded(id)}/void`, body: {} });
export const refundCapture = (id: string, cents: number, tripId: string, n: number): WriteSpec => ({ op: 'refund', path: `/v2/payments/captures/${encoded(id)}/refund`, body: { amount: amount(cents), custom_id: `rr-${tripId}-r${n}`, note_to_payer: 'Simulated supplier cancelled an activity. Refund of the price difference.' } });
export const readOrder = (id: string) => `/v2/checkout/orders/${encoded(id)}`;
export const readAuthorization = (id: string) => `/v2/payments/authorizations/${encoded(id)}`;
export const readCapture = (id: string) => `/v2/payments/captures/${encoded(id)}`;
export const readRefund = (id: string) => `/v2/payments/refunds/${encoded(id)}`;
