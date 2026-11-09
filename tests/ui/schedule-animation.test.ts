import { afterEach, expect, test, vi } from 'vitest';
// @ts-ignore Browser module is also safe to load without constructing the view.
import { BryntumSchedule, syncRecords } from '../../public/js/schedule-bryntum.js';
import recorded from '../../public/data/recorded-run.json';

class Record {
  updates = 0;
  constructor(public data: any) {}
  get id() { return this.data.id; }
  get(key: string) { return this.data[key]; }
  set(changes: any) { Object.assign(this.data, changes); this.updates++; }
}
class Store {
  records: Record[] = [];
  added: string[] = [];
  removed: string[] = [];
  getById(id: string) { return this.records.find(r => r.id === id); }
  add(row: any) { this.records.push(new Record(row)); this.added.push(row.id); }
  remove(rows: Record[]) {
    this.removed.push(...rows.map(r => r.id));
    this.records = this.records.filter(r => !rows.includes(r));
  }
}
afterEach(() => vi.unstubAllGlobals());

test('two update(trip) calls preserve moved event and resource records', async () => {
  vi.stubGlobal('window', { innerWidth: 1280 });
  const view = Object.create(BryntumSchedule.prototype);
  const eventStore = new Store(), resourceStore = new Store();
  view.scheduler = { eventStore, resourceStore, dependencyStore: new Store(), project: { commitAsync: async () => {} } };
  view.fit = () => {};
  const trip = recorded.snapshots.find(t => t.phase === 'repair_proposed')!;
  await view.update(trip);
  const moved = trip.repair!.candidates.find(c => c.checks.ok)!.moves[0].itemId;
  const event = eventStore.getById(moved)!;
  const resource = resourceStore.getById('d0');
  const oldStart = +event.get('startDate');
  eventStore.added = [];
  await view.update(trip, trip.repair!.candidates.find(c => c.checks.ok)!.id);
  expect(eventStore.getById(moved)).toBe(event);
  expect(resourceStore.getById('d0')).toBe(resource);
  expect(+event.get('startDate')).not.toBe(oldStart);
  expect(event.updates).toBeGreaterThan(0);
  expect(eventStore.added).not.toContain(moved);
  expect(eventStore.removed).not.toContain(moved);
});

test('store reconciliation adds and removes only changed ids and skips equal dates', () => {
  const store = new Store();
  syncRecords(store, [{ id: 'keep', startDate: new Date(1000) }, { id: 'gone' }]);
  const keep = store.getById('keep')!;
  syncRecords(store, [{ id: 'keep', startDate: new Date(1000) }, { id: 'new' }]);
  expect(store.getById('keep')).toBe(keep);
  expect(keep.updates).toBe(0);
  expect(store.removed).toEqual(['gone']);
  expect(store.records.map(r => r.id)).toEqual(['keep', 'new']);
});

test('breakpoint rebuild replays the selected repair and preserves same-mode records', async () => {
  const screen = { innerWidth: 1280, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', screen);
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  const instances: any[] = [];
  class Scheduler {
    resourceStore = new Store();
    eventStore = new Store();
    dependencyStore = new Store();
    project = { commitAsync: async () => {} };
    subGrids = { normal: { element: { clientWidth: 900 } } };
    resourceColumns = { columnWidth: 110 };
    destroy = vi.fn();
    constructor(config: any) { Object.assign(this, config); instances.push(this); }
  }
  const view = new BryntumSchedule({ clientWidth: 1027, dataset: {} }, {
    Scheduler, InstancePlugin: class {}, GridFeatureManager: { registerFeature() {} },
  });
  const trip = recorded.snapshots.find(t => t.phase === 'repair_proposed')!;
  const candidate = trip.repair!.candidates.find(c => c.checks.ok)!;
  await view.update(trip, candidate.id);
  const expected = instances[0].eventStore.records.map((r: Record) => r.data);
  for (const width of [390, 1280, 390, 1280]) {
    const old = view.scheduler;
    screen.innerWidth = width;
    await view.fit();
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(view.scheduler.mode).toBe(width === 390 ? 'vertical' : 'horizontal');
    expect(view.scheduler.eventStore.records.map((r: Record) => r.data)).toEqual(expected);
    expect(view.scheduler.transitionDuration).toBe(600);
    const record = view.scheduler.eventStore.records[0];
    await view.update(trip, candidate.id);
    expect(view.scheduler.eventStore.records[0]).toBe(record);
  }
  view.destroy();
  expect(disconnect).toHaveBeenCalledOnce();
  await view.fit();
  expect(instances).toHaveLength(5);
});
