export const isMock = new URLSearchParams(location.search).get('mock') === '1';
const mock = isMock ? import('./mock-api.js') : null;
// Mock mode never reaches fetch; live errors retain their server code and status.
export async function request(path, method = 'GET', body) {
  if (mock) return (await mock).request(path, method, body);
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response
    .json()
    .catch(() => ({ message: `Server returned HTTP ${response.status}` }));
  if (!response.ok)
    throw Object.assign(new Error(data.message || data.error), {
      code: data.error,
      status: response.status,
    });
  return data;
}
function post(id, path, body = {}) {
  return request(`/api/trips/${encodeURIComponent(id)}/${path}`, 'POST', body);
}
export const api = {
  health() {
    return request('/healthz');
  },
  config() {
    return request('/api/config');
  },
  create(body) {
    return request('/api/trips', 'POST', body);
  },
  trip(id) {
    return request(`/api/trips/${encodeURIComponent(id)}`);
  },
  quote(id) {
    return post(id, 'quote');
  },
  ask(id, text) {
    return post(id, 'ask', { text });
  },
  card(id, declineTest = false) {
    return post(id, 'pay/card', { declineTest });
  },
  order(id) {
    return post(id, 'pay/order');
  },
  authorize(id, orderId) {
    return post(id, 'pay/authorize', { orderId });
  },
  reserve(id) {
    return post(id, 'reserve');
  },
  hotelUnavailable(id) {
    return post(id, 'supplier/hotel-unavailable');
  },
  accept(id, candidateId) {
    return post(id, 'repair/accept', { candidateId });
  },
  confirm(id) {
    return post(id, 'confirm');
  },
  cancelActivity(id) {
    return post(id, 'supplier/cancel-activity');
  },
  reconcile(id) {
    return post(id, 'reconcile');
  },
  async recorded() {
    if (mock) return (await mock).request('/api/recorded');
    // Saved TripViews are a static asset. Playback cannot reach any trip/payment API.
    try {
      const response = await fetch('/data/recorded-run.json', { credentials: 'omit' });
      if (!response.ok) return null;
      const data = await response.json();
      return Array.isArray(data.snapshots) && data.snapshots.length &&
        data.snapshots.every(v => v.itinerary && Array.isArray(v.payments)) ? data : null;
    } catch { return null; }
  },
  fault() {
    return request('/api/dev/fault', 'POST', { kind: 'lose_next_response' });
  },
  webhook(event) {
    return request('/webhooks/paypal', 'POST', event);
  },
};
