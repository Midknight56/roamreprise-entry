import { money } from './shared.js';

// An id can also belong to a pending capture. Only settled state proves a charge.
export function wasCaptured(payment) {
  return payment.state === 'captured' || payment.previousState === 'captured';
}

function wasHeld(payment) {
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
  const steps = [
    { label: 'You allow up to', cents: trip.ceilingCents, reached: true },
    { label: 'Agent proposes', cents: proposed, reached: proposed !== undefined },
    { label: 'PayPal holds', cents: held?.amountCents, reached: !!held },
    { label: 'Captured', suffix: 'when every booking is confirmed', cents: captures.reduce((sum, payment) => sum + payment.amountCents, 0), reached: captures.length > 0 },
    { label: 'Refunded', suffix: 'when an activity was cancelled', cents: completed.reduce((sum, refund) => sum + refund.amountCents, 0), reached: completed.length > 0 },
  ];
  return steps.map(step => ({ ...step, text: [step.label, step.reached ? money(step.cents) : '', step.suffix].filter(Boolean).join(' ') }));
}

export function renderMandate(trip) {
  return `<p class="eyebrow">AGENTIC COMMERCE</p><ol class="mandate-strip" aria-label="Your spending mandate">${mandateSteps(trip).map(step =>
    `<li class="${step.reached ? 'reached' : 'unreached'}">${step.text}</li>`,
  ).join('')}</ol><p class="mandate-rule">The agent never charges more than you approved, never before every booking is confirmed, and never without a fresh approval when the plan changes.</p>`;
}
