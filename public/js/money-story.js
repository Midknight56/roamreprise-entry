import { money } from './shared.js';

// An id can also belong to a pending capture. Only settled state proves a charge.
export function wasCaptured(payment) {
  return payment.state === 'captured' || payment.previousState === 'captured';
}

export function wasHeld(payment) {
  return wasCaptured(payment) ||
    ['authorized', 'capturing', 'voiding', 'voided', 'expired'].includes(payment.state) ||
    ['authorized', 'capturing', 'voiding'].includes(payment.previousState);
}

/** Plain sentences based only on payment history and the spending ceiling. */
export function moneyStory(trip) {
  if (!trip.payments.length)
    return `You allow up to ${money(trip.ceilingCents)}. No payment has been charged.`;
  const sentences = [];
  let charged = 0, uncertain = false;
  for (const payment of trip.payments) {
    sentences.push(`You approved ${money(payment.amountCents)}.`);
    if (wasHeld(payment)) sentences.push('PayPal held it.');
    if (wasCaptured(payment)) {
      charged += payment.amountCents;
      sentences.push('It was charged when every booking was confirmed.');
    }
    switch (payment.state) {
      case 'declined': sentences.push('The payment was declined and nothing was charged.'); break;
      case 'expired': sentences.push('The hold expired and nothing was charged.'); break;
      case 'voided': sentences.push('That hold was voided and nothing was charged.'); break;
      case 'authorized': sentences.push('Nothing has been charged on this payment yet.'); break;
      case 'order_created': sentences.push('PayPal is waiting for your payment approval. Nothing has been charged yet.'); break;
      case 'none': sentences.push('No payment has been made on this attempt.'); break;
      case 'voiding':
        uncertain = true;
        sentences.push('PayPal is releasing that hold. Check its status before another payment.'); break;
      case 'capturing':
        uncertain = true;
        sentences.push('PayPal is checking the charge. Its result is not confirmed yet.'); break;
      case 'unknown':
        uncertain = true;
        sentences.push('PayPal is checking this payment. Check its status before another payment.'); break;
    }
    for (const refund of payment.refunds) {
      const amount = money(refund.amountCents);
      if (refund.state === 'completed') {
        charged -= refund.amountCents;
        sentences.push(`${amount} was refunded when an activity was cancelled.`);
      } else if (refund.state === 'failed') {
        sentences.push(`The ${amount} refund failed. It has not reduced the charged total.`);
      } else if (refund.state === 'pending') {
        sentences.push(`The ${amount} refund is still pending. It has not reduced the charged total yet.`);
      } else {
        uncertain = true;
        sentences.push(`PayPal is checking the ${amount} refund. It has not reduced the confirmed charged total yet.`);
      }
    }
  }
  sentences.push(`${uncertain ? 'Confirmed charged so far' : 'Charged in total'}: ${money(charged)}.`);
  return sentences.join(' ');
}

/** The five mandate amounts share the same settled payment rules as the story. */
export function mandateSteps(trip) {
  const held = trip.payments.findLast(wasHeld);
  const captures = trip.payments.filter(wasCaptured);
  const completed = trip.payments.flatMap(payment => payment.refunds).filter(refund => refund.state === 'completed');
  const proposed = trip.quote?.totalCents ?? trip.itinerary?.totalCents;

  let step3Text = 'PayPal holds';
  let step3Reached = false;
  if (held) {
    step3Reached = true;
    const amount = money(held.amountCents);
    if (held.state === 'authorized') {
      step3Text = `PayPal holds ${amount} now`;
    } else if (['capturing', 'voiding'].includes(held.state) || (held.state === 'unknown' && wasHeld(held))) {
      step3Text = `PayPal hold of ${amount}, being checked`;
    } else if (held.state === 'captured') {
      step3Text = `PayPal held ${amount}, then captured it`;
    } else if (held.state === 'voided') {
      step3Text = `PayPal released the ${amount} hold, nothing charged`;
    } else if (held.state === 'expired') {
      step3Text = `The ${amount} hold expired, nothing charged`;
    } else {
      step3Text = `PayPal hold of ${amount}, being checked`;
    }
  }

  const steps = [
    { label: 'You allow up to', cents: trip.ceilingCents, reached: true, text: `You allow up to ${money(trip.ceilingCents)}` },
    { label: 'Agent proposes', cents: proposed, reached: proposed !== undefined, text: ['Agent proposes', proposed !== undefined ? money(proposed) : ''].filter(Boolean).join(' ') },
    { label: 'PayPal holds', cents: held?.amountCents, reached: step3Reached, text: step3Text },
    { label: 'Captured', suffix: 'when every booking is confirmed', cents: captures.reduce((sum, payment) => sum + payment.amountCents, 0), reached: captures.length > 0 },
    { label: 'Refunded', suffix: 'when an activity was cancelled', cents: completed.reduce((sum, refund) => sum + refund.amountCents, 0), reached: completed.length > 0 },
  ];
  return steps.map(step => ({ ...step, text: step.text ?? [step.label, step.reached ? money(step.cents) : '', step.suffix].filter(Boolean).join(' ') }));
}

export function netSummary(trip) {
  const payments = trip?.payments || [];
  const releasedCents = payments
    .filter(p => ['voided', 'expired'].includes(p.state) && !wasCaptured(p))
    .reduce((sum, p) => sum + p.amountCents, 0);
  const capturedCents = payments
    .filter(wasCaptured)
    .reduce((sum, p) => sum + p.amountCents, 0);
  const refundedCents = payments
    .flatMap(p => p.refunds || [])
    .filter(r => r.state === 'completed')
    .reduce((sum, r) => sum + r.amountCents, 0);
  const netCents = capturedCents - refundedCents;
  const uncertainPayment = payments.some(p => ['capturing', 'voiding', 'unknown'].includes(p.state));
  const uncertainRefund = payments.some(p => (p.refunds || []).some(r => r.state !== 'completed' && r.state !== 'failed'));
  const uncertain = uncertainPayment || uncertainRefund;
  return { releasedCents, capturedCents, refundedCents, netCents, uncertain };
}

export function netSummaryText(trip) {
  const summary = netSummary(trip);
  const parts = [];
  if (summary.releasedCents > 0) parts.push(`Released, never charged: ${money(summary.releasedCents)}`);
  if (summary.capturedCents > 0) parts.push(`Captured: ${money(summary.capturedCents)}`);
  if (summary.refundedCents > 0) parts.push(`Refunded: ${money(summary.refundedCents)}`);
  if (summary.uncertain) {
    parts.push(`Confirmed so far: ${money(summary.netCents)}`);
  } else if (summary.netCents > 0) {
    parts.push(`Net charged: ${money(summary.netCents)}`);
  }
  return parts.join(' · ');
}

export function renderMandate(trip) {
  return `<p class="eyebrow">AGENTIC COMMERCE</p><ol class="mandate-strip" aria-label="Your spending mandate">${mandateSteps(trip).map(step =>
    `<li class="${step.reached ? 'reached' : 'unreached'}">${step.text}</li>`,
  ).join('')}</ol><p class="mandate-rule">The agent never charges more than you approved, never before every booking is confirmed, and never without a fresh approval when the plan changes.</p>`;
}
