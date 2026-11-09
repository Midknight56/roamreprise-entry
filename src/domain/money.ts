import type { Item, PaymentAttempt, PaymentState, Quote } from './types';

export function toCents(value: string): number {
  if (!/^\d+\.\d{2}$/.test(value)) throw new Error('Use a USD amount with two decimal places.');
  const cents = BigInt(value.replace('.', ''));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large.');
  return Number(cents);
}
export function toValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Use nonnegative integer cents.');
  const value = BigInt(cents);
  return `${value / 100n}.${value % 100n}`.replace(/\.(\d)$/, '.0$1');
}
export function canCapture(attempt: PaymentAttempt, items: Item[], quote: Quote, now: string | number | Date): boolean {
  const at = new Date(now).getTime(), expires = Date.parse(attempt.expiresAt ?? '');
  const booked = items.filter(i => i.booked && !['replaced', 'cancelled'].includes(i.state));
  return attempt.state === 'authorized' && !!attempt.authorizationId && !attempt.captureId &&
    attempt.quoteVersion === quote.version && Number.isSafeInteger(attempt.amountCents) && attempt.amountCents > 0 &&
    attempt.amountCents === quote.totalCents && Number.isFinite(at) && Number.isFinite(expires) && expires > at &&
    booked.length > 0 && booked.every(i => i.state === 'confirmed') && booked.reduce((sum, i) => sum + i.priceCents, 0) === quote.totalCents;
}
export const canVoid = (attempt: PaymentAttempt): boolean => attempt.state === 'authorized' && !!attempt.authorizationId && !attempt.captureId;
/** Pending and uncertain refunds reserve their amount to prevent a second refund. Failed refunds reserve nothing. */
export function refundableCents(attempt: PaymentAttempt): number {
  if (attempt.state !== 'captured' || !attempt.captureId) return 0;
  return Math.max(0, attempt.amountCents - attempt.refunds.filter(r => r.state !== 'failed').reduce((sum, r) => sum + r.amountCents, 0));
}
export const canRefund = (attempt: PaymentAttempt, cents: number): boolean => attempt.state === 'captured' && !!attempt.captureId &&
  !attempt.refunds.some(r => r.state === 'unknown') && Number.isSafeInteger(cents) && cents > 0 && cents <= refundableCents(attempt);
export const blockedByUnknown = (attempts: PaymentAttempt[]): boolean => attempts.some(a => a.state === 'unknown' || a.refunds.some(r => r.state === 'unknown'));

type ReadKind = 'order' | 'authorization' | 'capture' | 'refund';
type Json = Record<string, any>;
const rank: Record<PaymentState, number> = { none: 0, order_created: 1, authorized: 2, capturing: 3, captured: 6, declined: 4, voiding: 4, voided: 5, expired: 5, unknown: -1 };
/** Maps read responses only. A completed AUTHORIZE order is not a captured payment.
 * PayPal: https://developer.paypal.com/api/payments/v2 and /api/orders/v2
 */
export function applyPayPalRead(attempt: PaymentAttempt, kind: ReadKind, body: unknown): PaymentAttempt {
  const next: PaymentAttempt = { ...attempt, refunds: attempt.refunds.map(r => ({ ...r })), receipts: attempt.receipts.map(r => ({ ...r })), log: [...(attempt.log ?? [])] };
  const log = (message: string) => next.log!.push(message);
  // A capture id alone can also refer to a pending/declined capture. Do not invent a successful capture.
  const lastKnown = attempt.previousState ?? (attempt.captureId ? 'capturing' : 'none');
  const current = (): PaymentState => next.state === 'unknown' ? lastKnown : next.state;
  function advance(state: PaymentState) {
    const prev = current();
    if (rank[state] < rank[prev] || (['voided', 'expired', 'declined'].includes(prev) && state !== prev && state !== 'captured')) { log(`Ignored stale ${state} read after ${prev}.`); return; }
    next.state = state;
    delete next.previousState;
  }
  function read(resourceKind: ReadKind, resource: Json) {
    const status = resource.status;
    if (typeof status !== 'string' || typeof resource.id !== 'string') { log('Ignored an incomplete PayPal read.'); return; }
    const key = resourceKind === 'order' ? 'orderId' : resourceKind === 'authorization' ? 'authorizationId' : resourceKind === 'capture' ? 'captureId' : undefined;
    if (key && next[key] && next[key] !== resource.id) { log('Ignored a read for another PayPal resource.'); return; }
    if (resource.amount) {
      try {
        const cents = toCents(resource.amount.value);
        if (resource.amount.currency_code !== 'USD' || (resourceKind !== 'refund' && cents !== next.amountCents)) { log('Ignored a PayPal amount or currency mismatch.'); return; }
      } catch { log('Ignored an invalid PayPal amount.'); return; }
    }
    if (resourceKind === 'order') {
      if (resource.purchase_units?.length !== undefined && resource.purchase_units.length !== 1) { log('Ignored an order with multiple purchase units.'); return; }
      if (resource.purchase_units !== undefined && !Array.isArray(resource.purchase_units)) { log('Ignored invalid purchase units.'); return; }
      const unit = resource.purchase_units?.[0];
      if (unit?.payments && (['authorizations', 'captures'] as const).some(k => unit.payments[k] !== undefined && !Array.isArray(unit.payments[k]))) { log('Ignored invalid payment details.'); return; }
      if (unit?.amount) {
        try { if (unit.amount.currency_code !== 'USD' || toCents(unit.amount.value) !== next.amountCents) { log('Ignored an order amount mismatch.'); return; } } catch { log('Ignored an invalid order amount.'); return; }
      }
      next.orderId = resource.id;
      if (['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(status)) advance('order_created');
      if (status === 'VOIDED') advance('voided');
      for (const auth of unit?.payments?.authorizations ?? []) {
        if (auth && typeof auth === 'object') read('authorization', auth); else log('Ignored invalid authorization details.');
      }
      for (const capture of unit?.payments?.captures ?? []) {
        if (capture && typeof capture === 'object') read('capture', capture); else log('Ignored invalid capture details.');
      }
      if (status === 'COMPLETED' && !unit?.payments?.authorizations?.length && !unit?.payments?.captures?.length) log('Completed order has no payment details; keep checking.');
    } else if (resourceKind === 'authorization') {
      next.authorizationId = resource.id;
      if (typeof resource.expiration_time === 'string') next.expiresAt = resource.expiration_time;
      if (status === 'CREATED') advance('authorized');
      else if (status === 'CAPTURED') advance('captured');
      else if (status === 'VOIDED') { if (current() === 'captured') log('Ignored stale VOIDED read after captured.'); else advance('voided'); }
      else if (status === 'DENIED') advance('declined');
      else if (status === 'EXPIRED') advance('expired');
      else log(`Authorization ${status}; keep checking.`);
    } else if (resourceKind === 'capture') {
      next.captureId = resource.id;
      if (['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(status)) advance('captured');
      else if (status === 'PENDING') advance('capturing');
      else if (['DECLINED', 'DENIED', 'FAILED'].includes(status)) advance('declined');
      else log(`Capture ${status}; keep checking.`);
    } else {
      let refund = next.refunds.find(r => r.id === resource.id);
      // A lost response may leave a single persisted pending refund without its PayPal id.
      if (!refund && resource.amount?.currency_code === 'USD') {
        let cents: number;
        try { cents = toCents(resource.amount.value); } catch { log('Ignored an invalid refund amount.'); return; }
        const matching = next.refunds.filter(r => !r.id && r.amountCents === cents && ['unknown', 'pending'].includes(r.state));
        if (matching.length === 1) { refund = matching[0]; refund.id = resource.id; }
      }
      if (!refund) { log('Ignored an untracked refund.'); return; }
      if (resource.amount && toCents(resource.amount.value) !== refund.amountCents) { log('Ignored a refund amount mismatch.'); return; }
      if (refund.state === 'completed') { if (status !== 'COMPLETED') log('Ignored a stale refund read.'); return; }
      if (refund.state === 'failed' && status === 'PENDING') { log('Ignored a stale refund read.'); return; }
      if (status === 'COMPLETED') refund.state = 'completed';
      else if (status === 'PENDING') refund.state = 'pending';
      else if (['FAILED', 'CANCELLED'].includes(status)) refund.state = 'failed';
      else { log(`Refund ${status}; keep checking.`); return; }
      if (next.state === 'unknown') advance('captured');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { log('Ignored an invalid PayPal read.'); return next; }
  read(kind, body as Json);
  return next;
}
