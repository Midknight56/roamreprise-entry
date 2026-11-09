import { clock, minutes, money } from './shared.js';
const key = 'roamreprise-mock-v1';
function now() {
  return new Date().toISOString();
}
function copy(value) {
  return structuredClone(value);
}
let store;
try {
  store = JSON.parse(localStorage.getItem(key) || '{}');
} catch {
  store = {};
}
let loseNext = false;
function fail(message, code = 'STATE') {
  throw Object.assign(new Error(message), { code, status: code === 'BAD_REQUEST' ? 400 : 409 });
}
// Browser persistence lets the separate receipt page read the same mock attempts.
function save(t) {
  store[t.id] = t;
  localStorage.setItem(key, JSON.stringify(store));
  return copy(t);
}
function log(t, tool, summary, source = 'rule') {
  t.log.push({ tool, at: now(), summary, source });
}
function phase(t, value, next) {
  t.phase = value;
  t.next = next;
}
// Every synthetic receipt identifier carries the mock prefix.
function receipt(p, op, path, status, paypalStatus, method = 'POST') {
  p.receipts.push({
    op,
    method,
    path,
    status,
    paypalStatus,
    debugId: `MOCK-DEBUG-${p.receipts.length + 1}`,
    requestId: `MOCK-REQUEST-v${p.quoteVersion}-${p.receipts.length + 1}`,
    at: now(),
  });
}
/** Build the scripted sample using the merged TripView field names.
 * @returns {import('../../src/domain/types').TripView}
 */
function makeTrip(body) {
  const specs = [
    [
      'd1-arrive',
      't-arrive',
      'transfer',
      'Airport car · bags at hotel',
      'alfama',
      0,
      '10:45',
      '11:15',
      0,
      0,
      true,
    ],
    [
      'd1-lunch',
      'm-ribeira',
      'meal',
      'Market hall lunch',
      'ribeira',
      0,
      '12:30',
      '13:45',
      20,
      2400,
      true,
    ],
    [
      'd1-pm',
      'a-tilemuseum',
      'activity',
      'National Tile Museum visit',
      'tilemuseum',
      0,
      '14:15',
      '15:45',
      20,
      800,
      true,
    ],
    [
      'd1-checkin',
      'h-patio',
      'lodging',
      'Casa do Pátio rooms',
      'alfama',
      0,
      '16:30',
      '09:00',
      15,
      16800,
      true,
    ],
    [
      'd1-late',
      'a-castle',
      'activity',
      'Castle hill walk',
      'castle',
      0,
      '17:15',
      '18:45',
      10,
      1500,
      true,
    ],
    [
      'd1-dinner',
      'm-fado',
      'meal',
      'Fado dinner in Alfama',
      'alfama',
      0,
      '20:00',
      '22:30',
      10,
      7400,
      true,
    ],
    [
      'd2-checkout',
      'h-patio',
      'lodging',
      'Check out · bags held',
      'alfama',
      1,
      '09:00',
      '09:15',
      0,
      0,
      false,
    ],
    [
      'd2-am',
      'a-tileclass',
      'activity',
      'Tile painting class',
      'tilemuseum',
      1,
      '10:00',
      '12:00',
      15,
      5800,
      true,
    ],
    [
      'd2-lunch',
      'm-coffee',
      'meal',
      'Roastery brunch',
      'principe',
      1,
      '12:45',
      '13:45',
      20,
      1900,
      true,
    ],
    [
      'd2-depart',
      't-depart',
      'transfer',
      'Airport car · arrive by 17:00',
      'lis',
      1,
      '16:00',
      '16:30',
      20,
      0,
      true,
    ],
  ];
  // Fixed airport fixture prices: taxi formula plus $14, rounded to dollars.
  specs[0][9] = 3000;
  specs[9][9] = 3000;
  const items = specs.map(
    ([
      id,
      offerId,
      kind,
      name,
      placeId,
      day,
      start,
      end,
      bufferMin,
      priceCents,
      booked,
    ]) => ({
      id,
      offerId,
      slot: id,
      kind,
      name,
      placeId,
      day,
      start,
      end,
      bufferMin,
      priceCents,
      booked,
      ...({ 'a-tilemuseum': 'Explore tile art and local history', 'a-tileclass': 'Create your own tile art', 'm-fado': 'Enjoy fado music over dinner' }[offerId] ? { why: { 'a-tilemuseum': 'Explore tile art and local history', 'a-tileclass': 'Create your own tile art', 'm-fado': 'Enjoy fado music over dinner' }[offerId], whySample: true } : {}),
      travelMode: kind === 'transfer' ? 'car' : bufferMin ? 'metro' : 'none',
      state: 'planned',
    }),
  );
  const t = {
    id: `MOCK-${crypto.randomUUID().slice(0, 8)}`,
    phase: 'planned',
    asksLeft: 2,
    ceilingCents: body.ceilingCents ?? 60000,
    tastes: body.tastes || [],
    note: body.note || '',
    itinerary: {
      version: 1,
      hotelId: 'h-patio',
      totalCents: items.reduce((s, i) => s + i.priceCents, 0),
      items,
    },
    payments: [],
    webhooks: [
      { eventId: 'SAMPLE-WEBHOOK-1', eventType: 'PAYMENT.AUTHORIZATION.CREATED', receivedAt: '2026-11-06T20:00:03Z', signatureVerified: true, quoteVersion: 1, resourceId: 'SAMPLE-AUTH-1', outcome: 'already known', sample: true },
      { eventId: 'SAMPLE-WEBHOOK-2', eventType: 'PAYMENT.CAPTURE.COMPLETED', receivedAt: '2026-11-06T20:05:12Z', signatureVerified: true, quoteVersion: 2, resourceId: 'SAMPLE-CAPTURE-2', outcome: 'already known', sample: true },
    ],
    log: [],
    issues: [],
    next: ['quote'],
  };
  log(
    t,
    'read_trip_request',
    'Two days in Lisbon. Keep room for the unexpected.',
  );
  log(
    t,
    'find_options',
    'Hotel, transfers, tile art and fado from local fixtures.',
  );
  log(t, 'rank_options', 'Ranked the checked offers by the rules.');
  log(
    t,
    'validate_schedule',
    'Opening times, travel buffers and airport arrival checked.',
  );
  log(
    t,
    'propose_itinerary',
    'A walkable first day, with tile painting on Sunday.',
    'recorded',
  );
  log(t, 'read_note', 'Read your note: nothing to change.', 'rule');
  if (t.itinerary.totalCents > t.ceilingCents) {
    t.issues = [
      {
        code: 'CEILING',
        message:
          'This sample exceeds your ceiling. Raise it to approve the quote.',
      },
    ];
    t.next = [];
  }
  return t;
}
/** Return complete checked previews, with time and price changes kept separate.
 * @returns {import('../../src/domain/types').Candidate[]}
 */
function candidates(t) {
  return [
    ['lumen', 'h-lumen', 'Lumen Rooms', 'Chiado', 4600, 1],
    ['rio', 'h-riocalmo', 'Rio Calmo Inn', 'Belém', -2600, 5],
    ['terraco', 'h-terraco', 'Terraço Hostel', 'Graça', -7200, 2],
    ['avenida', 'h-avenida', 'Avenida Grand', 'Avenida', 23000, 1],
  ].map(([id, hotelId, name, area, delta, count]) => {
    const moves = (
      id === 'rio'
        ? ['d1-checkin', 'd1-late', 'd2-checkout', 'd2-am', 'd2-lunch']
        : ['d1-late', 'd1-checkin']
    )
      .slice(0, count)
      .map((itemId) => {
        const i = t.itinerary.items.find((i) => i.id === itemId);
        const offset =
          id === 'rio' ? { 'd1-late': 55, 'd2-lunch': 25 }[itemId] || 40 : 25;
        return {
          itemId,
          name: i.name,
          fromStart: i.start,
          fromEnd: i.end,
          toStart: clock(minutes(i.start) + offset),
          toEnd: clock(minutes(i.end) + offset),
          reason: 'Keep travel time and 10 minutes of slack.',
        };
      });
    const itinerary = copy(t.itinerary);
    itinerary.hotelId = hotelId;
    itinerary.items = itinerary.items.map(function buildCandidateItem(item) {
      const move = moves.find((change) => change.itemId === item.id);
      const next = {
        ...item,
        ...(move ? { start: move.toStart, end: move.toEnd } : {}),
      };
      if (item.kind === 'lodging' || item.slot === 'd1-arrive') {
        next.placeId =
          hotelId === 'h-riocalmo'
            ? 'maat'
            : hotelId === 'h-terraco'
              ? 'graca'
              : hotelId === 'h-avenida'
                ? 'avenida'
                : 'chiado';
      }
      if (item.kind === 'lodging') {
        next.offerId = hotelId;
        next.name = item.booked ? name : 'Check out · bags held';
        next.priceCents = item.booked ? item.priceCents + delta : 0;
      }
      // A transfer price change is separate from a schedule move in Candidate.
      if (item.slot === 'd1-arrive')
        next.priceCents += id === 'rio' ? 600 : id === 'lumen' ? 200 : 0;
      const changed = ['offerId', 'placeId', 'start', 'end', 'priceCents'].some(
        (field) => next[field] !== item[field],
      );
      if (changed) {
        next.state = 'planned';
        delete next.supplierRef;
      }
      return next;
    });
    const repriced = itinerary.items.flatMap(function priceChanges(item) {
      const original = t.itinerary.items.find(
        (previous) => previous.id === item.id,
      );
      return original.priceCents === item.priceCents
        ? []
        : [
            {
              itemId: item.id,
              name: item.kind === 'transfer' ? 'Airport car' : item.name,
              fromCents: original.priceCents,
              toCents: item.priceCents,
            },
          ];
    });
    itinerary.totalCents = itinerary.items
      .filter((item) => item.booked)
      .reduce((sum, item) => sum + item.priceCents, 0);
    const issues =
      id === 'terraco'
        ? [{ code: 'AVAILABILITY', message: 'No rooms that night.' }]
        : itinerary.totalCents > t.ceilingCents
          ? [
              {
                code: 'CEILING',
                message: 'New total exceeds your spending ceiling.',
              },
            ]
          : [];
    return {
      id,
      hotelId,
      name,
      area,
      priceDeltaCents: itinerary.totalCents - t.itinerary.totalCents,
      newTotalCents: itinerary.totalCents,
      moves,
      repriced,
      dropped: [],
      checks: { ok: !issues.length, issues },
      itinerary,
    };
  });
}
// Mirror the API state guards without making a network or payment request.
export async function request(path, method = 'GET', body = {}) {
  if (path === '/healthz') return { ok: true, build: 'MOCK-local' };
  if (path === '/api/config')
    return {
      paypalClientId: '',
      build: 'MOCK-local',
      liveAi: false,
      aiLeftToday: 0,
      recordedRunDate: '2026-11-06',
    };
  if (path === '/api/dev/fault') {
    loseNext = true;
    return { ok: true };
  }
  if (path === '/webhooks/paypal') return { ok: true };
  if (path === '/api/recorded') {
    const t = save(makeTrip({})),
      snapshots = [t];
    for (const [action, payload] of [
      ['quote'],
      ['pay/card'],
      ['supplier/hotel-unavailable'],
      ['repair/accept', { candidateId: 'lumen' }],
      ['pay/card'],
      ['confirm'],
      ['supplier/cancel-activity'],
      ['reconcile'],
    ]) {
      snapshots.push(
        await request(`/api/trips/${t.id}/${action}`, 'POST', payload || {}),
      );
    }
    return { capturedAt: '2026-11-06', snapshots };
  }
  if (path === '/api/trips' && method === 'POST') return save(makeTrip(body));
  const match = path.match(/^\/api\/trips\/([^/]+)(?:\/(.*))?$/);
  if (!match || !store[match[1]])
    fail('Trip not found. Start a new sample.', 'NOT_FOUND');
  const t = copy(store[match[1]]),
    action = match[2];
  if (method === 'GET') return t;
  if (action === 'ask') return save(askTrip(t, body.text));
  const last = () => t.payments.at(-1);
  if (t.phase === 'checking_payment' && action !== 'reconcile')
    fail(
      'Check the existing payment before any new write.',
      'CHECKING_PAYMENT',
    );
  const permitted = {
    quote: 'quote',
    'pay/card': 'pay',
    'pay/order': 'pay',
    'pay/authorize': 'pay',
    'supplier/hotel-unavailable': 'hotel-unavailable',
    'repair/accept': 'repair/accept',
    confirm: 'confirm',
    'supplier/cancel-activity': 'cancel-activity',
    reconcile: 'reconcile',
  };
  if (!t.next.includes(permitted[action]))
    fail('This action is not available in the current state.');
  if (action === 'quote') {
    t.quote = {
      version: t.itinerary.version,
      totalCents: t.itinerary.totalCents,
      approvedAt: now(),
    };
    phase(t, 'quoted', ['pay']);
  }
  if (action === 'pay/order') {
    const orderId = `MOCK-ORDER-v${t.itinerary.version}`;
    return { orderId };
  }
  if (action === 'pay/card' || action === 'pay/authorize') {
    const p = {
      quoteVersion: t.quote.version,
      amountCents: t.quote.totalCents,
      method: action === 'pay/card' ? 'card' : 'paypal',
      state: body.declineTest ? 'declined' : 'authorized',
      orderId: `MOCK-ORDER-v${t.quote.version}`,
      refunds: [],
      receipts: [],
    };
    if (!body.declineTest) p.authorizationId = `MOCK-AUTH-v${t.quote.version}`;
    receipt(
      p,
      'create_order',
      '/v2/checkout/orders',
      body.declineTest ? 422 : 201,
      body.declineTest ? 'INSTRUMENT_DECLINED' : 'COMPLETED',
    );
    t.payments.push(p);
    if (body.declineTest) {
      t.itinerary.items.forEach((i) => (i.state = 'released'));
      phase(t, 'declined', ['quote']);
    } else {
      holdBookings(t);
      if (loseNext) {
        loseNext = false;
        p.previousState = p.state;
        p.state = 'unknown';
        phase(t, 'checking_payment', ['reconcile']);
      }
    }
    log(
      t,
      'paypal',
      body.declineTest
        ? 'Mock card declined. No bookings confirmed.'
        : t.phase === 'checking_payment'
          ? 'Response lost. Check this order before another payment.'
          : 'Mock payment authorized. Nothing captured.',
    );
  }
  if (action === 'supplier/hotel-unavailable') {
    t.previous = {
      version: t.itinerary.version,
      items: copy(t.itinerary.items),
    };
    t.itinerary.items
      .filter((i) => i.offerId === t.itinerary.hotelId)
      .forEach((i) => (i.state = 'failed'));
    const options = candidates(t),
      pick = options
        .filter((c) => c.checks.ok)
        .sort(
          (a, b) =>
            a.moves.length - b.moves.length ||
            a.newTotalCents - b.newTotalCents,
        )[0];
    t.repair = {
      failedItemId: 'd1-checkin',
      candidates: options,
      pickId: pick.id,
      pickReason: `${pick.name} keeps the most stops in place within your ceiling.`,
      pickSource: 'rule',
    };
    phase(t, 'repair_proposed', ['repair/accept']);
    log(
      t,
      'repair_failed_leg',
      `${options.filter((c) => c.checks.ok).length} hotels pass. The other checks show their rejection reasons.`,
    );
  }
  if (action === 'repair/accept') {
    const c = t.repair.candidates.find((c) => c.id === body.candidateId);
    if (!c?.checks.ok) fail('Choose a checked candidate.');
    const next = copy(c.itinerary);
    next.version++;
    acceptHeldChange(t, next);
    delete t.repair;
    delete t.previous;
  }
  if (action === 'confirm') {
    t.itinerary.items.forEach((i) => (i.state = 'confirmed'));
    last().state = 'captured';
    last().captureId = `MOCK-CAPTURE-v${t.quote.version}`;
    receipt(
      last(),
      'capture',
      `/v2/payments/authorizations/${last().authorizationId}/capture`,
      201,
      'COMPLETED',
    );
    phase(t, 'confirmed_captured', ['cancel-activity']);
    log(t, 'paypal', 'Simulated supplier confirmed. Mock capture completed.');
  }
  if (action === 'supplier/cancel-activity') {
    const i = t.itinerary.items.find((i) => i.offerId === 'a-tileclass');
    i.state = 'cancelled';
    t.itinerary.items.push({
      ...i,
      id: 'replacement-tilemuseum',
      offerId: 'a-tilemuseum',
      name: 'National Tile Museum visit',
      placeId: 'tilemuseum',
      end: clock(minutes(i.start) + 90),
      priceCents: 800,
      state: 'confirmed',
      supplierRef: 'MOCK-SIM-TILEMUSEUM',
    });
    const replacement = t.itinerary.items.at(-1);
    const refundCents = i.priceCents - replacement.priceCents;
    last().refunds.push({
      id: `MOCK-REFUND-${last().refunds.length + 1}`,
      amountCents: refundCents,
      state: 'pending',
      reason: `Tile painting class cancelled. The ${money(replacement.priceCents)} museum visit replaces it.`,
    });
    receipt(
      last(),
      'refund',
      `/v2/payments/captures/${last().captureId}/refund`,
      201,
      'PENDING',
    );
    phase(t, 'refund_pending', ['reconcile']);
    log(
      t,
      'replan_slot',
      `Tile painting cancelled. The ${money(replacement.priceCents)} museum visit fits. Refund ${money(refundCents)} pending.`,
    );
  }
  if (action === 'reconcile') {
    if (t.phase === 'checking_payment') {
      last().state = 'authorized';
      delete last().previousState;
      receipt(
        last(),
        'read_order',
        `/v2/checkout/orders/${last().orderId}`,
        200,
        'COMPLETED',
        'GET',
      );
      holdBookings(t);
    } else {
      last().refunds.forEach((r) => (r.state = 'completed'));
      receipt(
        last(),
        'read_refund',
        `/v2/payments/refunds/${last().refunds.at(-1).id}`,
        200,
        'COMPLETED',
        'GET',
      );
      phase(t, 'refunded', []);
    }
    log(t, 'paypal', 'Mock reconciliation complete.');
  }
  return save(t);
}

// The sample has a small fixed offer list. Other requests use these same named days and tags.
const askTags = { 'a-castle': ['viewpoints', 'history'], 'a-tilemuseum': ['tile art', 'history'], 'a-tileclass': ['tile art', 'history'], 'a-roastery': ['coffee'], 'm-coffee': ['coffee'], 'm-ribeira': ['food markets'], 'm-fado': ['fado music', 'live music'] };
const askSampleOffers = [
  { offerId: 'a-roastery', name: 'Coffee roastery tasting', kind: 'activity', placeId: 'principe', priceCents: 1200, duration: 60, tags: ['coffee'], opens: 600, closes: 1200 },
  { offerId: 'a-graca', name: 'Senhora do Monte viewpoint walk', kind: 'activity', placeId: 'graca', priceCents: 0, duration: 60, tags: ['viewpoints'], opens: 420, closes: 1380 },
  { offerId: 'a-maat', name: 'MAAT riverside galleries', kind: 'activity', placeId: 'maat', priceCents: 1200, duration: 90, tags: ['contemporary art', 'river walks'], opens: 600, closes: 1140 },
  { offerId: 'm-chiado', name: 'Chiado bistro lunch', kind: 'meal', placeId: 'chiado', priceCents: 3100, duration: 75, tags: ['food markets'], opens: 720, closes: 930 },
];
const askWords = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function askTrip(t, raw) {
  const holding = t.phase === 'holding' && t.payments.at(-1)?.state === 'authorized';
  if (!holding && (!['planned', 'quoted'].includes(t.phase) || t.payments.length)) fail('You can ask for a change before a hold or while the money is held, before capture.');
  if (t.asksLeft === 0) fail('You used both changes for this trip.');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > 160) fail('Write a request of 1 to 160 characters.', 'BAD_REQUEST');
  t.asksLeft = (t.asksLeft ?? 2) - 1;
  const before = copy(t.itinerary), next = copy(before), said = askWords(text);
  const active = next.items.filter(i => !['released', 'cancelled', 'replaced'].includes(i.state));
  const swap = /\b(?:swap|replace|change)\s+(.+?)\s+(?:for|with)\s+(.+)$/.exec(said);
  let item, from, to, reason;
  if (swap) {
    const strip = value => value.replace(/^(?:the|a|an|some|my)\s+/, '');
    const name = strip(swap[1]), tag = strip(swap[2]);
    item = active.find(i => ['activity', 'meal'].includes(i.kind) && (askWords(i.name).includes(name) || (askTags[i.offerId] || askSampleOffers.find(o => o.offerId === i.offerId)?.tags)?.includes(name)));
    const pick = item && askSampleOffers.filter(o => o.kind === item.kind && o.tags.includes(tag) && !active.some(i => i.offerId === o.offerId) && minutes(item.start) >= o.opens && minutes(item.start) + o.duration <= o.closes)
      .sort((a, b) => b.tags.filter(tag => t.tastes.includes(tag)).length - a.tags.filter(tag => t.tastes.includes(tag)).length || a.priceCents - b.priceCents)[0];
    if (pick) {
      from = item.name;
      Object.assign(item, { offerId: pick.offerId, name: pick.name, placeId: pick.placeId, priceCents: pick.priceCents, end: clock(minutes(item.start) + pick.duration), bufferMin: 20, travelMode: 'metro' });
      delete item.why;
      to = item.name;
    }
  } else if (/\b(?:slower|later|sleep in)\b/.test(said)) {
    const sunday = /\b(?:sunday|day (?:2|two))\b/.test(said), saturday = /\b(?:saturday|day (?:1|one))\b/.test(said);
    if (sunday !== saturday) item = active.find(i => i.kind === 'activity' && i.day === (sunday ? 1 : 0));
    if (item) {
      from = item.start;
      item.start = clock(minutes(item.start) + 30);
      item.end = clock(minutes(item.end) + 30);
      to = item.start;
    }
  }
  let message = 'I could not turn that into a change. Try one of the examples.';
  if (to) {
    // Carry later stops forward, retaining the sample's checked travel buffers and ten minute slack.
    const changedIndex = active.indexOf(item);
    for (let n = changedIndex + 1; n < active.length && active[n].day === item.day; n++) {
      const prev = active[n - 1], stop = active[n];
      const end = minutes(prev.start) + (prev.slot === 'd1-checkin' ? 20 : minutes(prev.end) - minutes(prev.start));
      const start = Math.max(minutes(stop.start), end + stop.bufferMin + 10);
      const offset = start - minutes(stop.start);
      stop.start = clock(start);
      if (stop.slot !== 'd1-checkin') stop.end = clock(minutes(stop.end) + offset);
    }
    if (active.some(i => i.slot === 'd2-depart' && minutes(i.end) > 1020)) reason = 'That would not leave time to reach the airport by 17:00, so I kept the plan.';
    const closes = { 'a-tilemuseum': 1080, 'a-tileclass': 1020, 'a-roastery': 1200, 'a-castle': 1260, 'a-graca': 1380, 'a-maat': 1140, 'm-chiado': 930, 'm-coffee': 960, 'm-fado': 1410, 'm-ribeira': 1380 };
    if (!reason && active.some(i => closes[i.offerId] && minutes(i.end) > closes[i.offerId])) reason = 'A stop would run outside its opening hours, so I kept the plan.';
    next.totalCents = next.items.filter(i => i.booked).reduce((sum, i) => sum + i.priceCents, 0);
    if (next.totalCents > t.ceilingCents) reason = 'That would put the total over your ceiling, so I kept the plan.';
    if (!reason) {
      const labels = { 'd1-lunch': 'Day 1 lunch', 'd1-pm': 'Day 1 afternoon', 'd1-late': 'Day 1 evening', 'd1-dinner': 'Day 1 dinner', 'd2-am': 'Day 2 morning', 'd2-lunch': 'Day 2 lunch', 'd2-pm': 'Day 2 afternoon' };
      message = `The agent changed ${labels[item.slot] || 'your stop'}: ${from} to ${to}.`;
      next.version++;
      t.previous = { version: before.version, items: before.items };
      t.itinerary = next;
    } else message = reason;
  }
  const changed = t.itinerary.version !== before.version, reapprove = changed && !!t.quote;
  t.lastAsk = { text, changed, message, reapprove };
  if (changed && holding) acceptHeldChange(t, next);
  else if (reapprove) {
    delete t.quote;
    phase(t, 'planned', ['quote']);
    t.lastAsk.quoteNote = `The quote changed to ${money(next.totalCents)}. Approve it again.`;
  }
  log(t, 'ask_agent', `You asked: ${text.replace(/[.!?\s]+$/, '')}. ${changed ? message : `No change was made. ${message}`}`);
  if (['Make Sunday morning slower', 'Swap the castle for coffee'].includes(text)) t.log.at(-1).sample = true;
  return t;
}

function acceptHeldChange(t, next) {
  const payment = t.payments.at(-1);
  payment.state = 'voided';
  receipt(payment, 'void', `/v2/payments/authorizations/${payment.authorizationId}/void`, 204, 'VOIDED');
  next.items.forEach(item => { item.state = 'planned'; delete item.supplierRef; });
  t.itinerary = next;
  t.quote = { version: next.version, totalCents: next.totalCents, approvedAt: now() };
  phase(t, 'requote', ['pay']);
  log(t, 'paypal', 'Old authorization voided. Approve a fresh hold for the changed quote.');
}

function holdBookings(t) {
  t.itinerary.items.forEach((i) => {
    if (['cancelled', 'replaced', 'released'].includes(i.state)) return;
    i.state = 'held';
    if (i.booked) i.supplierRef = `MOCK-SIM-${i.id}`;
  });
  phase(t, 'holding', ['confirm', 'hotel-unavailable']);
  log(t, 'reserve_demo_inventory', 'Simulated supplier holds placed.');
}
