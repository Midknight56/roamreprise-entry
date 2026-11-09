import { api, isMock } from './api.js';
import { esc, money } from './shared.js';
import { moneyStory } from './money-story.js';

const query = new URLSearchParams(location.search);
const id = query.get('trip');
document.getElementById('mock-badge').hidden = !isMock;
if (id) {
  document.getElementById('back-link').href =
    `/?trip=${encodeURIComponent(id)}${isMock ? '&mock=1' : ''}`;
}

// Escape both labels and values because receipts contain server supplied strings.
function entries(values) {
  const rows = values
    .map(function renderEntry([label, value]) {
      return `<dt>${esc(label)}</dt><dd>${esc(value ?? 'Not supplied')}</dd>`;
    })
    .join('');
  return `<dl class="receipt-ids">${rows}</dl>`;
}

function renderOperation(receipt) {
  return `
    <li class="receipt-operation">
      <strong>${esc(receipt.op)}</strong>
      <p><code>${esc(receipt.method)} ${esc(receipt.path)}</code></p>
      ${entries([
        ['HTTP status', receipt.status],
        ['PayPal status', receipt.paypalStatus],
        ['Request id', receipt.requestId],
        ['Debug id', receipt.debugId],
        ['Time', receipt.at],
      ])}
    </li>
  `;
}

// Refund state remains distinct from the attempt's authorization or capture state.
function renderRefund(refund) {
  return `
    <div class="refund-row">
      <strong>Refund ${money(refund.amountCents)} ${esc(refund.state)}</strong>
      ${entries([
        ['Refund id', refund.id],
        ['Reason', refund.reason],
      ])}
    </div>
  `;
}

function renderWebhook(webhook) {
  const received = new Date(webhook.receivedAt).toISOString().slice(11, 19);
  return `<li class="receipt-webhook"><code>${esc(webhook.eventType)}</code> · received ${received} UTC · signature verified · ${esc(webhook.outcome)} to attempt ${esc(webhook.quoteVersion)}${webhook.sample ? ' · sample' : ''}</li>`;
}

function renderAttempt(payment, index) {
  return `
    <section class="card receipt-attempt receipt-edge" id="attempt-${payment.quoteVersion}">
      <p class="eyebrow">ATTEMPT ${index + 1} · QUOTE v${payment.quoteVersion}</p>
      <h2>${money(payment.amountCents)} · ${esc(payment.state)}</h2>
      ${entries([
        ['Method', payment.method],
        ['Order id', payment.orderId],
        ['Authorization id', payment.authorizationId],
        ['Capture id', payment.captureId],
        ['Expires', payment.expiresAt],
      ])}
      <h3>PayPal operations</h3>
      <ol class="receipt-operations">
        ${payment.receipts.map(renderOperation).join('') || '<li>No operation receipts supplied.</li>'}
      </ol>
      <h3>Webhooks from PayPal</h3>
      <ul class="receipt-webhooks">${(window.currentWebhooks ?? []).filter(row => row.quoteVersion === payment.quoteVersion && window.currentPayments.findLastIndex(attempt => attempt.quoteVersion === row.quoteVersion) === index).map(renderWebhook).join('') || '<li>No verified webhooks for this attempt.</li>'}</ul>
      ${payment.refunds.length ? `<h3>Refunds</h3>${payment.refunds.map(renderRefund).join('')}` : ''}
      <p class="fine">Bookings: Simulated supplier. Payments: PayPal sandbox (test money).</p>
    </section>
  `;
}

async function loadReceipts() {
  try {
    if (!id) throw new Error('No trip id. Open receipts from your trip.');
    const trip = await api.trip(id);
    document.getElementById('money-story').textContent = moneyStory(trip);
    document.getElementById('money-story-panel').hidden = false;
    window.currentWebhooks = trip.webhooks ?? [];
    window.currentPayments = trip.payments;
    document.getElementById('receipt-status').textContent =
      `${isMock ? 'Mock data · ' : ''}Trip ${trip.id} · ${trip.payments.length} payment attempt${trip.payments.length === 1 ? '' : 's'}`;
    document.getElementById('receipts').innerHTML =
      trip.payments.map(renderAttempt).join('') ||
      '<p>No payment attempts yet.</p>';
  } catch (error) {
    document.getElementById('receipt-status').textContent = error.message;
    document.getElementById('receipt-status').setAttribute('role', 'alert');
  }
}

await loadReceipts();
