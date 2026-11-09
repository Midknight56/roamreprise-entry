import { Agent } from '../../src/ai/agent';
import { DEFAULT_TASTES } from '../../src/domain/planner';
import { SimulatedSupplier } from '../../src/domain/supplier';
import { MemoryGate } from '../../src/gate/engine';
import { PayPal } from '../../src/paypal/client';
import { SerialQueue } from '../../src/queue';
import { TripEngine } from '../../src/trip/engine';
import { MemoryStore, type TripRecord } from '../../src/trip/store';
import { FakePayPal } from './fake-paypal';
import { placeholderRecorded } from './recorded';
export const ID = 'abcdefghijklmnop', SID = 'ponmlkjihgfedcba';
export const input = () => ({ tastes: [...DEFAULT_TASTES], note: '', ceilingCents: 60_000 });
export async function world() {
  const sb = new FakePayPal(), store = new MemoryStore();
  let now = new Date('2026-11-06T20:00:00Z');
  const clock = () => now;
  const gate = new MemoryGate(clock), supplier = new SimulatedSupplier(ID);
  const paypal = new PayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, sb.fetch, () => clock().getTime(), async () => {});
  const ai = new Agent({ call: async () => null });
  const deps = { store, paypal, gate, supplier, ai, clock, recorded: placeholderRecorded };
  let engine = new TripEngine(deps);
  const queue = new SerialQueue();
  await engine.create(ID, SID, input());
  return { sb, store, gate, supplier, paypal, deps,
    action: (action: string, body: Record<string, unknown> = {}) => queue.run(() => engine.action(SID, action, body)),
    view: () => engine.get(SID), record: () => store.get<TripRecord>('trip'),
    restart: () => { engine = new TripEngine(deps); },
    engine: () => engine,
    setNow: (iso: string) => { now = new Date(iso); },
  };
}
