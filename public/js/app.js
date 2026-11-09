import { api, isMock } from './api.js';
import { ASK_CHIPS, ASK_MAX_CHARS, ASK_BUTTON, askPanel, quoteNote, answerText, askSourceName } from './ask.js';
import { compactMoney, esc, minutes, money, previewItems, whyWeekend } from './shared.js';
import { RouteMap } from './routemap.js';
import { flyToLisbon, stopIdleGlobe } from './globe.js';
import { createSchedule } from './schedule-loader.js';
import { BasicSchedule } from './schedule-basic.js';
import { renderPay } from './pay.js';
import { droppedItemLabel } from './repair-label.js';
import { moneyStory, netSummaryText, renderMandate, wasCaptured } from './money-story.js';
import { failedItemName, repairSummary, candidateFacts } from './repair-view.js';
function $(id) {
  return document.getElementById(id);
}
const defaultTastes = ['tile art', 'fado music', 'viewpoints', 'food markets'];
const tastes = [
  ...defaultTastes,
  'contemporary art',
  'street art',
  'coffee',
  'history',
  'river walks',
  'live music',
];
const selected = new Set(defaultTastes);
let trip,
  config = {},
  schedule,
  busy = false,
  selectedCandidate,
  recorded = false,
  recordedSnapshots = [],
  recordedIndex = 0;
let recordedRun;
const map = new RouteMap($('route-map'));
const query = new URLSearchParams(location.search);
function sourceName(source) {
  return (
    { live: 'AI picked · code checked', cached: 'AI pick (cached today, no new call)', recorded: 'Recorded AI answer', rule: 'Rule pick' }[
      source
    ] || 'rule'
  );
}

const stepTitles = {
  read_trip_request: 'Read your tastes and ceiling',
  read_note: 'Read your note',
  find_options: 'Found checked offers',
  rank_options: 'Ranked them by the rules',
  propose_itinerary: 'AI picked the stops',
  validate_schedule: 'Checked every time, buffer and price',
  reserve_demo_inventory: 'Held bookings with the Simulated supplier',
  repair_failed_leg: 'Checked every other hotel',
  replan_slot: 'Replanned the cancelled slot',
  paypal: 'PayPal',
  ask_agent: 'Changed your plan',
};

function receiptUrl() {
  return `/receipt.html?trip=${encodeURIComponent(trip.id)}${isMock ? '&mock=1' : ''}`;
}
$('mock-badge').hidden = !isMock;
if (matchMedia('(max-width:760px)').matches) $('agent-log').open = false;
for (const taste of tastes) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = taste;
  b.setAttribute('aria-pressed', String(selected.has(taste)));
  b.onclick = function toggleTaste() {
    selected.has(taste) ? selected.delete(taste) : selected.add(taste);
    b.setAttribute('aria-pressed', String(selected.has(taste)));
  };
  $('tastes').append(b);
}
function error(error) {
  $('error').hidden = false;
  $('error').textContent = error.message || String(error);
}
// Lock all conflicting actions while a write or wallet approval is in flight.
function lock(value) {
  busy = value;
  document
    .querySelectorAll(
      '#plan-form button,#watch-recorded,#actions button,#pay-panel button,#repair-panel button,#ask-panel button,#ask-panel input,#new-trip',
    )
    .forEach((b) => (b.disabled = value));
  $('main').setAttribute('aria-busy', String(value));
}
// Refresh after uncertain writes before restoring actions from TripView.next.
async function run(operation, { fly = false } = {}) {
  if (busy) return;
  lock(true);
  $('error').hidden = true;
  try {
    trip = await operation();
    selectedCandidate = trip.repair?.pickId;
    if (!recorded) {
      const url = new URL(location.href);
      url.searchParams.set('trip', trip.id);
      history.replaceState(null, '', url);
    }
    await render({ keepIdleGlobe: fly });
    if (fly) await flyToLisbon($('globe'), trip);
    else stopIdleGlobe($('globe'));
  } catch (e) {
    error(e);
    // A lost write response can already have changed server state. Read before offering another write.
    if (trip && !recorded)
      try {
        trip = await api.trip(trip.id);
        await render();
      } catch {
        /* Keep the original error visible. */
      }
  } finally {
    lock(false);
  }
}
$('plan-form').onsubmit = function submitPlan(e) {
  e.preventDefault();
  recorded = false;
  run(
    () =>
      api.create({
        tastes: [...selected],
        note: $('note').value.trim(),
        ceilingCents: Math.round(Number($('ceiling').value) * 100),
        repairPolicy: document.querySelector('input[name="repairPolicy"]:checked')?.value ?? 'lowest_total',
      }),
    { fly: true },
  );
};
// Reset the view without removing stored trip and payment history.
$('new-trip').onclick = function startNewTrip() {
  if (busy) return;
  trip = undefined;
  recorded = false;
  recordedSnapshots = [];
  $('trip').hidden = true;
  $('receipts-panel').hidden = true;
  $('planner').hidden = false;
  $('recorded-banner').hidden = true;
  $('route-stops').replaceChildren();
  $('log-list').replaceChildren();
  $('log-count').textContent = 'Waiting for your trip';
  const u = new URL(location.href);
  u.searchParams.delete('trip');
  history.replaceState(null, '', u);
  map.trip = undefined;
  map.draw();
  $('note').focus();
};
function paymentLabel(p) {
  if (!p) return 'PayPal: Not authorized';
  const labels = {
    none: 'Not authorized',
    order_created: 'Awaiting approval',
    authorized: 'Authorized',
    capturing: 'Capture pending',
    captured: 'Captured',
    voiding: 'Void pending',
    voided: 'Voided',
    expired: 'Expired',
    declined: 'Declined',
    unknown: 'Checking payment',
  };
  return `PayPal: ${labels[p.state] || p.state} ${money(p.amountCents)}`;
}
function summaries(t) {
  const labels = {
    planned: 'A checked plan, before any holds. Approve the quote to continue.',
    quoted:
      'A hold reserves the money. Capture waits until all bookings are confirmed.',
    authorized: 'Payment is authorized. Place the simulated supplier holds next.',
    holding:
      'Your holds are provisional. Try a hotel failure to see the recovery.',
    repair_proposed: repairSummary(t),
    requote:
      'The previous hold was voided. This changed plan needs a new authorization.',
    confirmed_captured:
      'Bookings confirmed with the Simulated supplier. Payment captured.',
    refund_pending: 'The slot is repaired. The computed refund is still pending.',
    refunded: 'Your replacement fits. The computed refund is completed.',
    declined:
      'The card was declined. No bookings are confirmed and no payment was captured.',
    checking_payment:
      'The response was lost. Check the existing payment before any new payment or booking.',
  };
  return labels[t.phase] || t.phase;
}
// Keep every panel on the same returned TripView, including checked previews.
async function render({ keepIdleGlobe = false } = {}) {
  if (!keepIdleGlobe) stopIdleGlobe($('globe'));
  $('planner').hidden = true;
  $('trip').hidden = false;
  $('receipts-panel').hidden = false;
  if (!$('why-weekend')) $('schedule').insertAdjacentHTML('beforebegin', '<p id="why-weekend" class="why-weekend"></p>');
  $('why-weekend').innerHTML = whyWeekend(trip, isMock && !recorded);
  $('version').textContent = `v${trip.itinerary.version}`;
  $('total').textContent = money(
    trip.quote?.totalCents ?? trip.itinerary.totalCents,
  );
  $('ceiling-label').textContent = `Ceiling ${money(trip.ceilingCents)}`;
  if (!$('mandate')) {
    $('phase-summary').insertAdjacentHTML('beforebegin', '<div id="mandate"></div><p id="money-net-summary" class="net-summary" hidden></p><div id="money-story-chips" class="state-chips money-story-chips" aria-label="What happened to my money" aria-live="polite"></div>');
  }
  $('mandate').innerHTML = renderMandate(trip);
  const netEl = $('money-net-summary');
  const hasCapture = trip.payments.some(wasCaptured);
  if (hasCapture) {
    const summaryText = netSummaryText(trip);
    netEl.textContent = summaryText;
    netEl.hidden = !summaryText;
  } else {
    netEl.textContent = '';
    netEl.hidden = true;
  }
  const storyChips = $('money-story-chips');
  storyChips.hidden = !trip.payments.some(payment => wasCaptured(payment) || payment.state === 'voided');
  storyChips.innerHTML = storyChips.hidden ? '' : [
    ...trip.payments.flatMap(payment => [
      ...(payment.state === 'voided' ? [`Voided ${money(payment.amountCents)}. Nothing charged.`] : []),
      ...(wasCaptured(payment) ? [`Charged ${money(payment.amountCents)} after bookings confirmed.`] : []),
      ...payment.refunds.filter(refund => refund.state === 'completed').map(refund => `Refunded ${money(refund.amountCents)} after cancellation.`),
    ]),
    moneyStory(trip).split('. ').at(-1),
  ].map(sentence => `<span class="state-chip">${esc(sentence)}</span>`).join('');
  const p = trip.payments.at(-1),
    counts = {};
  for (const i of trip.itinerary.items.filter((i) => i.booked))
    counts[i.state] = (counts[i.state] || 0) + 1;
  const bookings = Object.entries(counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
  const refunds = trip.payments.flatMap((p) => p.refunds);
  $('state-chips').innerHTML = `
    <span class="state-chip payment ${trip.phase === 'checking_payment' ? 'warning' : ''} ${trip.phase === 'declined' ? 'danger' : ''}">${esc(paymentLabel(p))}</span>
    <span class="state-chip">Bookings: ${esc(bookings || 'None')} · Simulated supplier</span>
    ${refunds.map(renderRefundState).join('')}
  `;
  $('phase-summary').textContent = quoteNote(trip) || summaries(trip);
  if (['refund_pending', 'refunded'].includes(trip.phase)) {
    const amount = money(refunds.reduce((sum, refund) => sum + refund.amountCents, 0));
    $('phase-summary').textContent = trip.phase === 'refunded'
      ? `Your replacement fits. The ${amount} refund is completed.`
      : `The slot is repaired. The ${amount} refund is still pending.`;
  }
  if (trip.issues.length)
    $('phase-summary').textContent +=
      ` ${trip.issues.map((i) => i.message).join(' ')}`;
  $('payment-attempts').innerHTML = trip.payments.map(renderAttempt).join('');
  $('price-list').innerHTML = trip.itinerary.items
    .filter((i) => i.booked)
    .map(renderPrice)
    .join('');
  $('receipt-link').href = receiptUrl();
  $('receipt-link').hidden = recorded;
  $('log-count').textContent = `${trip.log.length} steps`;
  let neuronsToday = 0;
  $('log-list').innerHTML = trip.log.map((step) => {
    neuronsToday += step.neurons || 0;
    return renderAgentStep(step, neuronsToday);
  }).join('');
  const items = previewItems(trip, selectedCandidate);
  $('route-stops').innerHTML = `
    <details>
      <summary>Numbered route stops · ${trip.phase === 'repair_proposed' ? 'proposed' : 'current'} plan</summary>
      ${[0, 1].map((day) => renderRouteDay(day, items)).join('')}
    </details>
  `;
  renderRepair();
  renderAsk();
  map.update(trip, selectedCandidate);
  if (!schedule)
    schedule = await createSchedule($('schedule'), {
      wanted: query.get('schedule'),
    });
  try {
    await schedule.update(trip, selectedCandidate);
  } catch {
    schedule.destroy();
    schedule = new BasicSchedule($('schedule'));
    $('schedule').dataset.view = 'basic';
    await schedule.update(trip, selectedCandidate);
  }
  $('schedule-engine').textContent =
    $('schedule').dataset.view === 'bryntum'
      ? 'Bryntum Scheduler'
      : 'Basic schedule fallback';
  renderActions();
  if (!recorded)
    renderPay($('pay-panel'), trip, config, {
      run,
      onError: error,
      isBusy: () => busy,
      setBusy: lock,
    }).catch(error);
  else $('pay-panel').replaceChildren();
}
function renderRefundState(refund) {
  return `<span class="state-chip ${refund.state !== 'completed' ? 'warning' : ''}">Refund ${money(refund.amountCents)} ${esc(refund.state)}</span>`;
}

function renderPrice(item) {
  return `
    <li>
      <div>${esc(item.name)}
        <small>Simulated supplier · ${esc(item.state)}${item.supplierRef ? ` · ${esc(item.supplierRef)}` : ''}</small>
      </div>
      <span>${money(item.priceCents)}</span>
    </li>
  `;
}

function renderAsk() {
  const panel = $('ask-panel'), state = askPanel(trip, recorded);
  panel.hidden = state.mode === 'hidden';
  if (panel.hidden) { panel.replaceChildren(); return; }
  panel.innerHTML = `<h2>${ASK_BUTTON}</h2>
    ${state.mode === 'used' ? `<p>${esc(state.text)}</p>` : `
    <form id="ask-form">
      <label for="ask-input">What would you like to change?</label>
      <div class="ask-controls"><input id="ask-input" name="text" type="text" maxlength="${ASK_MAX_CHARS}" required autocomplete="off"><button type="submit">${ASK_BUTTON}</button></div>
      <div class="ask-examples">${ASK_CHIPS.map(text => `<button type="button" data-ask-example="${esc(text)}">${esc(text)}</button>`).join('')}</div>
    </form>`}
    <p id="ask-answer" role="status">${esc(answerText(trip))}</p>`;
  if (state.mode !== 'input') return;
  panel.querySelectorAll('button,input').forEach(control => { control.disabled = busy; });
  panel.querySelectorAll('[data-ask-example]').forEach(button => {
    button.onclick = () => { $('ask-input').value = button.dataset.askExample; $('ask-input').focus(); };
  });
  $('ask-form').onsubmit = event => {
    event.preventDefault();
    const text = $('ask-input').value.trim();
    if (text) run(() => api.ask(trip.id, text));
  };
}
function renderAgentStep(step, neuronsToday) {
  const aiWords = step.tool === 'propose_itinerary'
    ? [...new Set(trip.itinerary.items.map((item) => item.why).filter(Boolean))]
    : step.tool === 'repair_failed_leg' && step.source !== 'rule' && step.aiWords !== false
      ? [trip.repair?.pickReason?.split(/every travel buffer kept\.|travel buffers kept \(estimated times\)\./i).at(-1)?.trim()].filter(Boolean)
      : [];
  const aiLine = aiWords.length
    ? `<p class="ai-words"><span>The AI said:</span> ${aiWords.map((word) => `“${esc(word)}”`).join(' ')}</p>`
    : step.tool === 'repair_failed_leg' && (step.aiWords === false || step.source === 'live') && !step.summary.includes('The AI gave no reason; this sentence is from the code checks.')
      ? '<p class="ai-words">The AI gave no reason; this sentence is from the code checks.</p>'
      : '';
  return `
    <li>
      <div><strong>${esc(stepTitles[step.tool] || step.tool)}</strong><small class="step-code">${esc(step.tool)}</small><span class="source">${step.tool === 'ask_agent' ? askSourceName(step) : sourceName(step.source)}</span></div>
      <p>${esc(step.summary)}</p>
      ${aiLine}
      ${step.neurons !== undefined ? `<small>cost ${(Math.max(0, 900 - (config.aiLeftToday ?? 900)) + neuronsToday).toFixed(1)} of 900 today</small>` : ''}
    </li>
  `;
}

// Saved operations stay inline so recorded viewing never fetches a live receipt.
function renderAttempt(payment) {
  const ids = [payment.orderId, payment.authorizationId, payment.captureId]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  return `
    <div class="attempt-line">
      <span>v${payment.quoteVersion} · ${esc(payment.state)} · ${money(payment.amountCents)}</span>
      <code>${esc(payment.authorizationId || payment.orderId || 'No payment id')}</code>
      ${recorded ? '' : `<a href="${receiptUrl()}#attempt-${payment.quoteVersion}">Receipt ↗</a>`}
    </div>
    ${
      recorded
        ? `
      <details>
        <summary class="fine">Recorded operations</summary>
        <p class="fine">${ids}</p>
        ${payment.receipts.map(renderRecordedOperation).join('')}
      </details>
    `
        : ''
    }
  `;
}

function renderRecordedOperation(receipt) {
  return `
    <p class="fine">
      ${esc(receipt.op)} · ${esc(receipt.method)} ${esc(receipt.path)}<br>
      HTTP ${esc(receipt.status)} · ${esc(receipt.paypalStatus)}<br>
      Request ${esc(receipt.requestId)} · Debug ${esc(receipt.debugId)}<br>
      ${esc(receipt.at)}
    </p>
  `;
}

// Match the map numbering by omitting historical and cancelled reservations.
function renderRouteDay(day, items) {
  const active = items.filter(
    (item) =>
      item.day === day &&
      !['cancelled', 'replaced', 'released'].includes(item.state),
  );
  active.sort((first, second) => first.start.localeCompare(second.start));
  return `
    <p class="fine">Day ${day + 1}</p>
    <ol>${active.map(renderRouteStop).join('')}</ol>
  `;
}

function renderRouteStop(item) {
  return `<li>${esc(item.name)} <span>${item.start} to ${item.end} · ${item.bufferMin} min travel</span></li>`;
}

// Only the server's current next tokens may create mutation buttons.
function renderActions() {
  $('actions').replaceChildren();
  if (recorded) return;
  const handlers = {
    quote: ['Approve quote', () => api.quote(trip.id)],
    'hotel-unavailable': [
      'Simulate: the hotel cancels our room',
      () => api.hotelUnavailable(trip.id),
      'danger',
    ],
    confirm: ['Confirm bookings', () => api.confirm(trip.id)],
    'cancel-activity': [
      'Simulate: the operator cancels an activity',
      () => api.cancelActivity(trip.id),
      'danger',
    ],
    reconcile: [
      trip.phase === 'refund_pending' ? 'Check refund status' : 'Check payment',
      () => api.reconcile(trip.id),
    ],
  };
  const supplier = document.createElement('fieldset');
  supplier.className = 'supplier-events';
  const title = document.createElement('legend');
  title.textContent = 'Simulated tour operator';
  supplier.append(title);
  for (const action of trip.next) {
    const h = handlers[action];
    if (!h) continue;
    const b = document.createElement('button');
    b.textContent = h[0];
    b.className = h[2] || 'primary';
    b.dataset.action = action;
    b.onclick = () => run(h[1]);
    (['hotel-unavailable', 'cancel-activity'].includes(action) ? supplier : $('actions')).append(b);
  }
  if (supplier.querySelector('button')) $('actions').append(supplier);
}
// Report the signed time change without repeating the shared travel explanation.
function renderMove(move) {
  const endOnly = move.fromStart === move.toStart;
  const from = endOnly ? move.fromEnd : move.fromStart;
  const to = endOnly ? move.toEnd : move.toStart;
  const delta = minutes(to) - minutes(from);
  return `<li>${esc(move.name)}${endOnly ? ' arrives' : ''} ${esc(from)} → ${esc(to)} (${delta >= 0 ? '+' : ''}${delta} min)</li>`;
}

function renderReprice(change) {
  return `<li>${esc(change.name)} ${compactMoney(change.fromCents)} → ${compactMoney(change.toCents)}</li>`;
}

// Keep checked, moved and repriced information together for each candidate.
function renderCandidate(candidate) {
  const isSelected = candidate.id === selectedCandidate;
  const classes = [
    'candidate',
    isSelected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const facts = candidateFacts(trip, candidate);
  return `
    <article class="${classes}">
      <span class="badge">Checked · fits</span>
      <h3>${esc(candidate.name)}</h3>
      <p class="candidate-area">${esc(candidate.area)} · Simulated supplier</p>
      <div class="candidate-facts">
        <p class="fact fact-total">${esc(facts.fact1)}</p>
        <p class="fact fact-activities">${esc(facts.fact2)}</p>
        <p class="fact fact-moves">${esc(facts.fact3)}</p>
        <p class="fact fact-checks">${esc(facts.fact4.main)}<br><small class="fact-sub">${esc(facts.fact4.sub)}</small></p>
        ${facts.fact5 ? `<p class="fact fact-hold">${esc(facts.fact5)}</p>` : ''}
      </div>
      ${candidate.moves.length ? `<ul class="candidate-moves fine-list">${candidate.moves.map(renderMove).join('')}${candidate.dropped.map((id) => `<li>Drop ${esc(droppedItemLabel(trip.itinerary, id))}</li>`).join('')}</ul>` : ''}
      ${candidate.moves.length ? '<p class="travel-explanation">Keep travel time and 10 minutes of slack.</p>' : ''}
      ${candidate.repriced.length ? `<ul class="candidate-repriced fine-list">${candidate.repriced.map(renderReprice).join('')}</ul>` : ''}
      ${!recorded ? `<button type="button" data-candidate="${esc(candidate.id)}" aria-pressed="${isSelected}">${isSelected ? 'Previewing this hotel' : 'Preview this hotel'}</button>${isSelected && trip.next.includes('repair/accept') ? `<button type="button" class="primary" data-accept="${esc(candidate.id)}">Use ${esc(candidate.name)}</button>` : ''}` : ''}
    </article>
  `;
}

function renderRejectedCandidate(candidate) {
  return `
    <div class="candidate rejected rejected-line">
      <span class="badge">Rejected</span>
      <h4>${esc(candidate.name)}</h4>
      <span class="candidate-price">${money(candidate.newTotalCents)} total</span>
      <span class="rejection">${esc(candidate.checks.issues.map((issue) => issue.message).join(' '))}</span>
    </div>
  `;
}

// Preview selection redraws geography and scheduling without approving the repair.
function renderRepair() {
  const panel = $('repair-panel');
  panel.hidden = trip.phase !== 'repair_proposed' || !trip.repair;
  if (panel.hidden) return;
  const r = trip.repair;
  const failedName = failedItemName(trip) || 'The hotel';
  const checked = r.candidates.filter((c) => c.checks.ok);
  const rejected = r.candidates.filter((c) => !c.checks.ok);
  panel.innerHTML = `
    <div class="section-heading"><div>
      <p class="eyebrow">A CHANGE OF PLANS</p>
      <h2 id="repair-title">A room fell through.<br>Your weekend doesn't have to.</h2>
    </div></div>
    <p class="repair-intro">${esc(failedName)} · <span class="rejection">failed</span> · Simulated supplier</p>
    <div class="candidate-grid">${checked.map(renderCandidate).join('')}</div>
    ${rejected.length ? `
      <section class="rejected-block">
        <h3>Also checked, not usable</h3>
        <div class="rejected-list">
          ${rejected.map(renderRejectedCandidate).join('')}
        </div>
      </section>
    ` : ''}
    <p class="pick-reason"><span class="source">${sourceName(r.pickSource)}</span> ${esc(r.pickReason.replace(/^Rule pick:\s*/i, ''))}</p>
  `;
  panel.querySelector('[data-accept]')?.addEventListener('click', () => run(() => api.accept(trip.id, selectedCandidate ?? r.pickId)));
  panel.querySelectorAll('[data-candidate]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (busy) return;
        selectedCandidate = b.dataset.candidate;
        await render();
      }),
  );
}
// Replay saved TripViews through the same panels without exposing payment writes.
$('watch-recorded').onclick = function watchRecorded() {
  return run(
    async function loadRecordedTrip() {
      const data = recordedRun;
      if (!data) return;
      const values = Array.isArray(data)
        ? data
        : data.snapshots || data.tripViews || data.steps || [data.trip || data];
      recordedSnapshots = values
        .map((v) => v.trip || v.tripView || v.view || v)
        .filter((v) => v.itinerary && Array.isArray(v.payments));
      if (!recordedSnapshots.length)
        throw new Error(
          'The recorded run has no TripView snapshots yet. Try the interactive sample.',
        );
      recorded = true;
      recordedIndex = 0;
      $('recorded-banner').hidden = false;
      $('recorded-banner').innerHTML =
        `<strong>Recorded run, captured ${esc(data.capturedAt || data.recordedRunDate || config.recordedRunDate || 'date unavailable')}. No PayPal request is sent.</strong><div class="recorded-controls"><button id="recorded-prev">Previous step</button><span id="recorded-step"></span><button id="recorded-next">Next step</button></div>`;
      async function advance(delta) {
        recordedIndex = Math.max(
          0,
          Math.min(recordedSnapshots.length - 1, recordedIndex + delta),
        );
        trip = recordedSnapshots[recordedIndex];
        selectedCandidate = trip.repair?.pickId;
        await render();
        recordedControls();
      }
      $('recorded-prev').onclick = () => advance(-1);
      $('recorded-next').onclick = () => advance(1);
      recordedControls();
      return recordedSnapshots[0];
    },
    { fly: true },
  );
};
function recordedControls() {
  if (!$('recorded-step')) return;
  $('recorded-step').textContent =
    `${recordedIndex + 1} / ${recordedSnapshots.length}`;
  $('recorded-prev').disabled = recordedIndex === 0;
  $('recorded-next').disabled = recordedIndex === recordedSnapshots.length - 1;
}
// Restore a shared trip URL after the configuration request settles.
async function init() {
  const recording = api.recorded().then(data => {
    recordedRun = data;
    $('watch-recorded').hidden = !data;
  });
  try {
    config = await api.config();
  } catch (e) {
    error(e);
  }
  const id = query.get('trip');
  if (id) await run(() => api.trip(id));
  await recording;
}
await init();
