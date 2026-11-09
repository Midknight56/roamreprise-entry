import { describe, expect, test } from 'vitest';
import type { TripAI } from '../../src/ai/agent';
import type { RepairPolicy, TripView } from '../../src/domain/types';
import { isActive } from '../../src/domain/validate';
import recorded from '../../src/recorded/default-propose.json';
import doc from '../../docs/SCENARIOS.md?raw';
import { world } from '../helpers/world';

// Every case starts from the recorded live AI plan ($428.00) and uses the rule pick for repairs:
// fake PayPal sandbox, simulated supplier, no live AI.
const ai: TripAI = { proposeItinerary: async () => ({ answer: recorded.answer as never, neurons: 0 }), repairPick: async () => null };
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
type World = Awaited<ReturnType<typeof world>>;
interface Row { n: number; name: string; policy: RepairPolicy; ceiling: number; plan: number; replacement: string; removed: string;
  moved: string; check: string; released: number; captures: number; captured: number; refunded: number; net: number; captureWrites: number }

async function run(n: number, name: string, policy: RepairPolicy, ceiling: number,
  steps: { hotelFails?: boolean; loseCapture?: boolean; cancelActivity?: boolean }): Promise<Row & { view: TripView; w: World }> {
  const w = await world({ ai, input: { repairPolicy: policy, ceilingCents: ceiling } });
  const plan = (await w.view()).itinerary.totalCents;
  let replacement = 'none (no failure)', removed = '', moved = '', check = 'passed';
  await w.action('quote'); await w.action('pay/card');
  if (steps.hotelFails) {
    await w.action('supplier/hotel-unavailable');
    const repair = (await w.view()).repair!;
    const pick = repair.candidates.find(c => c.id === repair.pickId && c.checks.ok);
    if (pick) {
      replacement = `${pick.name}, ${usd(pick.newTotalCents)}`;
      removed = pick.droppedActivities.join(', ') || 'none';
      moved = `${pick.moves.length} (${pick.movedMinutes} min)`;
      check = `passed; rejected: ${repair.candidates.filter(c => !c.checks.ok).map(c => `${c.name}: ${c.checks.issues.map(i => i.code).join(' ')}`).join(', ')}`;
      await w.action('repair/accept', { candidateId: pick.id }); await w.action('pay/card');
    } else {
      replacement = 'none fits';
      removed = 'none'; moved = '0';
      check = repair.candidates.map(c => `${c.name}: ${c.checks.issues.map(i => i.code).join(' ')}`).join('; ');
    }
  }
  if (replacement !== 'none fits') {
    if (steps.loseCapture) { await w.action('dev/fault', { kind: 'lose_next_response' }); await w.action('confirm'); w.restart(); await w.action('reconcile'); }
    else await w.action('confirm');
    if (steps.cancelActivity) { await w.action('supplier/cancel-activity'); await w.action('reconcile'); }
  }
  const view = await w.view();
  const capturedPayments = view.payments.filter(p => p.state === 'captured');
  const captured = capturedPayments.reduce((s, p) => s + p.amountCents, 0);
  const refunded = view.payments.flatMap(p => p.refunds).filter(r => r.state === 'completed').reduce((s, r) => s + r.amountCents, 0);
  const released = view.payments.filter(p => ['voided', 'expired'].includes(p.state)).reduce((s, p) => s + p.amountCents, 0);
  const captureWrites = w.sb.sent.filter(s => s.method === 'POST' && s.path.endsWith('/capture')).length;
  return { n, name, policy, ceiling, plan, replacement, removed: removed || 'none', moved: moved || '0', check, released,
    captures: capturedPayments.length, captured, refunded, net: captured - refunded, captureWrites, view, w };
}

function table(rows: Row[]) {
  const head = '| # | Case | Repair choice | Ceiling | Plan total | Replacement (rule pick) | Activities removed | Stops moved | Schedule check | Released, never charged | Captures | Refunded | Net charged |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  return [head, ...rows.map(r => `| ${r.n} | ${r.name} | ${r.policy === 'keep_activities' ? 'My activities' : 'Lowest total'} | ${usd(r.ceiling)} | ${usd(r.plan)} | ${r.replacement} | ${r.removed} | ${r.moved} | ${r.check} | ${usd(r.released)} | ${r.captures} (${usd(r.captured)}) | ${usd(r.refunded)} | ${usd(r.net)} |`)].join('\n');
}

describe('scenario table (docs/SCENARIOS.md)', () => {
  test('six cases, each reproduced here; the table in the doc matches exactly', async () => {
    const rows = [
      await run(1, 'Hotel fails', 'lowest_total', 60_000, { hotelFails: true }),
      await run(2, 'Hotel fails, tighter ceiling', 'lowest_total', 45_000, { hotelFails: true }),
      await run(3, 'Hotel fails, keep activities', 'keep_activities', 60_000, { hotelFails: true }),
      await run(4, 'No acceptable replacement', 'keep_activities', 45_000, { hotelFails: true }),
      await run(5, 'Capture response lost', 'lowest_total', 60_000, { loseCapture: true }),
      await run(6, 'Activity cancelled after capture', 'lowest_total', 60_000, { hotelFails: true, cancelActivity: true }),
    ];
    for (const r of rows) {
      // Net is completed captures minus completed refunds. A released hold is never counted as money back.
      expect(r.net).toBe(r.captured - r.refunded);
      expect(r.captureWrites).toBe(r.captures);
    }
    expect(rows[0].replacement).toMatch(/^Rio Calmo Inn/); expect(rows[0].removed).toBe('Castle hill walk');
    expect(rows[1].replacement).toMatch(/^Rio Calmo Inn/); expect(rows[1].check).toContain('Lumen Rooms: CEILING');
    expect(rows[2].replacement).toMatch(/^Lumen Rooms/); expect(rows[2].removed).toBe('none');
    expect(rows[3].captures).toBe(0); expect(rows[3].captureWrites).toBe(0);
    expect(rows[4].captures).toBe(1); expect(rows[4].captureWrites).toBe(1);
    const cancelled = rows[5].view.itinerary.items.find(i => i.state === 'cancelled')!;
    const replacement = rows[5].view.itinerary.items.find(i => i.slot === cancelled.slot && isActive(i))!;
    expect(rows[5].refunded).toBe(cancelled.priceCents - replacement.priceCents);
    const generated = table(rows);
    const inDoc = doc.split('<!-- scenarios:start -->')[1]?.split('<!-- scenarios:end -->')[0]?.trim().replace(/\r\n/g, '\n');
    // On a change, this assertion prints the new table: paste it between the markers in docs/SCENARIOS.md.
    expect(inDoc).toBe(generated);
  });
});
