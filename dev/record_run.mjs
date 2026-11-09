import { mkdir, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Explicitly run after deploy: $env:RR_BASE = 'https://...'; node dev/record_run.mjs
// Uses sandbox test money, supplier fixtures and the ordinary capped trip routes.
export function withoutSession(value) {
  if (Array.isArray(value)) return value.map(withoutSession);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:sid|session_?id|rr_sid|cookie|set-cookie)$/i.test(key))
    .map(([key, child]) => [key, withoutSession(child)]));
}

export async function recordRun(base, fetchFn = fetch) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RR_BASE must be an HTTP(S) URL.');
  let cookie = '';
  const snapshots = [];
  async function request(path, body) {
    const response = await fetchFn(new URL(path, url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const session = response.headers.get('set-cookie')?.match(/(?:^|,\s*)rr_sid=([^;]+)/);
    if (session) cookie = `rr_sid=${session[1]}`;
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.error ?? ''}. Existing recording kept.`);
    if (data.itinerary && Array.isArray(data.payments)) snapshots.push(withoutSession(data));
    return data;
  }
  const health = await request('/healthz');
  let trip = await request('/api/trips', { tastes: ['tile art', 'fado music', 'viewpoints', 'food markets'], note: '', ceilingCents: 60000 });
  const path = `/api/trips/${encodeURIComponent(trip.id)}`;
  const action = async (name, body = {}) => {
    trip = await request(`${path}/${name}`, body);
    // A read may settle a delayed response. It must never repeat a payment write.
    for (let n = 0; ['checking_payment', 'refund_pending'].includes(trip.phase) && n < 5; n++)
      trip = await request(`${path}/reconcile`, {});
    return trip;
  };
  const phase = expected => {
    if (trip.phase !== expected) throw new Error(`Expected ${expected}, got ${trip.phase}. Existing recording kept.`);
  };
  await action('quote');
  await action('pay/card'); phase('holding');
  await action('supplier/hotel-unavailable'); phase('repair_proposed');
  await action('repair/accept', { candidateId: trip.repair.pickId }); phase('requote');
  await action('pay/card'); phase('holding');
  await action('confirm'); phase('confirmed_captured');
  await action('supplier/cancel-activity');
  if (!['refunded', 'refund_pending'].includes(trip.phase)) throw new Error(`Unexpected refund phase ${trip.phase}.`);
  return { capturedAt: new Date().toISOString(), build: health.build, snapshots };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.RR_BASE) throw new Error('Set RR_BASE explicitly. No default live target is used.');
  const recording = await recordRun(process.env.RR_BASE);
  const output = new URL('../public/data/recorded-run.json', import.meta.url);
  await mkdir(new URL('.', output), { recursive: true });
  const temporary = new URL('./recorded-run.json.tmp', output);
  await writeFile(temporary, JSON.stringify(recording, null, 2) + '\n');
  await rename(temporary, output);
  console.log(`Saved ${recording.snapshots.length} TripViews to public/data/recorded-run.json`);
}
