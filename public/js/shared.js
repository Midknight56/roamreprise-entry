export function money(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format((cents || 0) / 100);
}

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    function escapeCharacter(character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character];
    },
  );
}

export function minutes(time) {
  const [hours, minute] = time.split(':').map(Number);
  return hours * 60 + minute;
}

export function clock(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

// Avoid showing meaningless decimal cents on a compact repair comparison.
export function compactMoney(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);
}

// Short labels can wrap inside narrow bars; the tooltip retains the full item.
export function shortName(item) {
  if (item.kind === 'transfer') return 'Airport car';
  if (item.slot === 'd2-checkout') return 'Check out';
  return item.name.split(/\s+/).slice(0, 2).join(' ');
}
export const places = {
  lis: ['Lisbon Airport', 38.7742, -9.1342],
  alfama: ['Alfama', 38.7116, -9.13],
  castle: ['Castle hill', 38.7139, -9.1335],
  graca: ['Graça', 38.7193, -9.1327],
  tilemuseum: ['Tile Museum', 38.7247, -9.1135],
  ribeira: ['Mercado da Ribeira', 38.7069, -9.1459],
  chiado: ['Chiado', 38.7107, -9.1436],
  bairroalto: ['Bairro Alto', 38.7135, -9.146],
  comercio: ['Praça do Comércio', 38.7076, -9.1365],
  principe: ['Príncipe Real', 38.7166, -9.1488],
  lxf: ['LX Factory', 38.7034, -9.1784],
  maat: ['MAAT riverside', 38.6957, -9.1937],
  jeronimos: ['Jerónimos', 38.6979, -9.2068],
  belemtower: ['Belém Tower', 38.6916, -9.216],
  gulbenkian: ['Gulbenkian', 38.7375, -9.1545],
  avenida: ['Avenida', 38.7197, -9.1452],
};
// Use the server's checked itinerary, including buffer, price and place changes.
export function previewItems(trip, candidateId) {
  const candidate = trip.repair?.candidates.find((c) => c.id === candidateId);
  if (trip.phase !== 'repair_proposed' || !candidate?.checks.ok)
    return trip.itinerary.items;
  return candidate.itinerary.items.map((item) => {
    const move = candidate.moves.find((m) => m.itemId === item.id);
    const original = trip.itinerary.items.find(
      (previous) => previous.id === item.id || previous.slot === item.slot,
    );
    const changed =
      !original ||
      [
        'offerId',
        'placeId',
        'start',
        'end',
        'bufferMin',
        'travelMode',
        'priceCents',
      ].some((field) => original[field] !== item[field]);
    return {
      ...item,
      ...(move
        ? { movedMin: minutes(move.toStart) - minutes(move.fromStart) }
        : {}),
      preview: changed,
    };
  });
}
export function tooltip(item) {
  return `${item.name} · ${item.start} to ${item.end} · ${money(item.priceCents)}\nSimulated supplier · ${item.supplierRef || 'No reference yet'} · ${item.state}\n${item.bufferMin} min ${item.travelMode} before this stop${item.movedMin ? ` · moved ${item.movedMin > 0 ? '+' : ''}${item.movedMin} min` : ''}${item.why ? `\nThe AI said: ${item.why}${item.whySample ? ' (sample)' : ''}` : ''}`;
}

// Ghosts keep the old times visible beside the checked replacement preview.
export function scheduleItems(trip, candidateId) {
  const items = previewItems(trip, candidateId);
  const candidate = trip.repair?.candidates.find((c) => c.id === (candidateId ?? trip.repair.pickId));
  const movedIds = new Set(candidate?.moves.map((m) => m.itemId) || []);
  const ghosts =
    trip.phase === 'repair_proposed'
      ? (trip.previous?.items || trip.itinerary.items).filter((i) => movedIds.has(i.id)).map((i) => ({
          ...i,
          id: `ghost-${i.id}`,
          ghost: true,
          state: i.id === trip.repair.failedItemId ? 'failed' : 'replaced',
        }))
      : [];
  return [...items, ...ghosts].flatMap((item) => {
    if (item.kind !== 'lodging' || minutes(item.end) > minutes(item.start)) return [item];
    return [
      { ...item, end: clock(Math.min(1440, minutes(item.start) + 20)) },
      { ...item, id: `${item.id}-stay-0`, start: item.start, end: '24:00', checkout: item.end, bufferMin: 0, stay: true },
      { ...item, id: `${item.id}-stay-1`, day: item.day + 1, start: '08:00', end: item.end, bufferMin: 0, stay: true },
    ];
  }).filter((item) => minutes(item.end) > minutes(item.start));
}

// Quotes are escaped at the HTML boundary, just like Scheduler tooltip text.
export function whyWeekend(trip, sample = false) {
  const reasons = [...new Set(trip.itinerary.items.map(item => item.why).filter(Boolean))].slice(0, 3);
  return `<strong>Why this weekend</strong> ${sample && reasons.length ? '<small>Sample AI words</small> ' : ''}${reasons.length ? reasons.map(reason => {
    const lower = reason.toLowerCase();
    const words = new Set(lower.match(/[a-z]+/g) || []);
    const taste = (trip.tastes || []).map(tag => ({ tag, score: tag.toLowerCase().split(/\s+/).filter(word => words.has(word)).length })).sort((a, b) => b.score - a.score).find(match => match.score > 0)?.tag;
    return `<span class="weekend-reason">${taste ? `<span class="state-chip">${esc(taste)}</span> ` : ''}<q>${esc(reason)}</q></span>`;
  }).join(' ') : 'Picked by the rules from your tastes.'}`;
}
