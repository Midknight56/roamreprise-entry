import { writeFile } from 'node:fs/promises';
// One explicit live capture, two capped model calls, zero PayPal writes. DEV_ROUTES=1 is required.
const base = process.env.ROAMREPRISE_URL ?? 'https://roamreprise.midknight-labs.workers.dev';
const res = await fetch(new URL('/api/dev/record-ai', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tastes: ['tile art', 'fado music', 'viewpoints', 'food markets'], note: '', ceilingCents: 60000 }) });
if (!res.ok) throw new Error(`Live AI capture HTTP ${res.status}. Existing files kept.`);
const captured = await res.json();
if (!captured.propose || !captured.repair || !captured.capturedAt) throw new Error('Both answers must be live. Existing files kept.');
for (const name of ['propose', 'repair']) {
  await writeFile(new URL(`../src/recorded/default-${name}.json`, import.meta.url), JSON.stringify({ capturedAt: captured.capturedAt, placeholder: false, answer: captured[name] }, null, 2) + '\n');
}
console.log('default-propose.json\ndefault-repair.json');
