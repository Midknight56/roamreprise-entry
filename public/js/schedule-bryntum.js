import { esc, minutes, scheduleItems, tooltip } from './shared.js';

// Short names are keyed by the offers in src/domain/offers.ts and itinerary slots.
const placeLabels = {
  't-arrive': 'Airport car', 't-depart': 'Airport car',
  'd1-checkin': 'Check in', 'd2-checkout': 'Check out',
  'a-graca': 'Viewpoint', 'a-tower': 'Riverside', 'a-maat': 'Riverside',
  'a-tilemuseum': 'Tile Museum', 'a-tileclass': 'Tile Class',
  'a-castle': 'Castle', 'm-ribeira': 'Market hall', 'm-fado': 'Fado dinner',
};
function labelFor(item) {
  return placeLabels[item.slot] || (item.kind === 'lodging' ? 'Check in' :
    placeLabels[item.offerId]) || String(item.name).split(/\s+/)[0].slice(0, 12);
}
// Measure in pixels, just like the rendered text; each day has independent lanes.
function labelLanes(items, pixelsPerMinute) {
  const lanes = new Map();
  const context = document.createElement('canvas').getContext('2d');
  context.font = '11px Arial';
  for (const day of [0, 1]) {
    const ends = [];
    for (const item of items.filter(i => i.day === day && !i.ghost && !i.stay)
      .sort((a, b) => a.start.localeCompare(b.start))) {
      const start = item.start;
      const duration = minutes(item.end) - minutes(start);
      if (duration * pixelsPerMinute >= 70) continue;
      const left = (minutes(start) - 540) * pixelsPerMinute;
      const right = left + context.measureText(labelFor(item)).width + 18;
      let lane = ends.findIndex(end => end <= left);
      if (lane < 0) lane = ends.length;
      ends[lane] = right;
      lanes.set(item.id, lane);
    }
  }
  return lanes;
}

// Both resource rows share one internal date so the same 16-hour axis fits them.
function date(time) {
  const [hours, minute] = time.split(':').map(Number);
  return new Date(2027, 2, 13, hours, minute);
}

// Model.set(object) preserves record/assignment identity and commits date pairs
// together. Scheduler 7.3.8's transition.barChange animates these updates.
export function syncRecords(store, rows) {
  const ids = new Set(rows.map(row => row.id));
  const gone = store.records.filter(record => !ids.has(record.id));
  if (gone.length) store.remove(gone);
  for (const row of rows) {
    const record = store.getById(row.id);
    if (!record) {
      store.add(row);
      continue;
    }
    const changes = Object.fromEntries(Object.entries(row).filter(([key, value]) => {
      const previous = record.get(key);
      return value instanceof Date && previous instanceof Date
        ? +value !== +previous : value !== previous;
    }));
    if (Object.keys(changes).length) record.set(changes);
  }
}

export class BryntumSchedule {
  constructor(container, { Scheduler, InstancePlugin, GridFeatureManager }) {
    // Scheduler 7.3.8 does not ship Pro's EventBuffer. Keep the requested standard
    // Scheduler, and use its public feature/renderer API for a local equivalent.
    class TravelBuffer extends InstancePlugin {
      static $name = 'TravelBuffer';
      // Standard Scheduler exposes event rendering hooks, but no Pro EventBuffer.
      render(record, data) {
        const preamble = record.get('preamble');
        if (!preamble || record.get('rrGhost')) return;
        const width =
          (data.width * preamble) /
          ((record.endDate - record.startDate) / 60000);
        data.children.push({
          className: 'rr-travel-buffer',
          style: { left: `${-width}px`, width: `${width}px` },
          dataset: { btip: `${preamble} min travel before this stop` },
          text: `${preamble}m`,
        });
      }
    }
    GridFeatureManager.registerFeature(TravelBuffer, false, 'Scheduler');
    this.container = container;
    this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.Scheduler = Scheduler;
    this.createScheduler();
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.onMotionChange = () => {
      this.scheduler.transitionDuration = this.motion.matches ? 0 : 600;
    };
    this.motion.addEventListener('change', this.onMotionChange);
    this.resizeObserver.observe(container);
    this.onWindowResize = () => this.fit();
    window.addEventListener('resize', this.onWindowResize);
    this.fit();
  }
  createScheduler() {
    const phone = window.innerWidth < 760;
    const desktop = window.innerWidth >= 1024;
    const rowHeaderWidth = 125;
    this.scheduler = new this.Scheduler({
      appendTo: this.container,
      height: 324,
      readOnly: true,
      mode: phone ? 'vertical' : 'horizontal',
      useInitialAnimation: false,
      transitionDuration: this.motion.matches ? 0 : 600,
      transition: { barChange: true },
      rowHeight: 140,
      barMargin: 22,
      eventLayout: 'none',
      eventStyle: 'filled',
      startDate: date('09:00'),
      endDate: date('24:00'),
      forceFit: desktop,
      viewPreset: {
        base: 'hourAndDay',
        tickWidth: desktop
          ? Math.max(1, (this.container.clientWidth - rowHeaderWidth - 2) / 15)
          : 64,
        headers: [{ unit: 'hour', dateFormat: 'HH' }],
      },
      columns: phone ? [] : [
        {
          text: 'Lisbon time',
          field: 'name',
          width: rowHeaderWidth,
          htmlEncode: true,
        },
      ],
      ...(phone ? { resourceColumns: { columnWidth: 110 } } : {}),
      resources: [
        { id: 'd0', name: phone ? 'Day 1' : 'Day 1 · Sat 13 Mar' },
        { id: 'd1', name: phone ? 'Day 2' : 'Day 2 · Sun 14 Mar' },
      ],
      features: {
        travelBuffer: true,
        dependencies: true,
        eventEdit: false,
        eventDrag: false,
        eventResize: false,
        scheduleMenu: false,
        eventMenu: false,
        eventDragCreate: false,
        eventTooltip: {
          template: ({ eventRecord }) =>
            `<div class="schedule-tip">${esc(eventRecord.get('rrTooltip')).replaceAll('\n', '<br>')}</div>`,
        },
      },
      eventRenderer: ({ eventRecord, renderData }) => {
        for (const cls of eventRecord.get('rrClass').split(' ').filter(Boolean))
          renderData.cls.add(cls);
        this.scheduler.features.travelBuffer.render(eventRecord, renderData);
        const stay = eventRecord.get('rrStay');
        const narrow = renderData.width < 70 && window.innerWidth >= 760;
        const lanes = labelLanes(this.items || [], this.scheduler.tickSize / 60);
        const lane = lanes.get(eventRecord.id) || 0;
        if (window.innerWidth >= 760) {
          renderData.top = stay ? 116 : eventRecord.get('rrGhost') ? 76 : 64;
          renderData.height = stay ? 18 : eventRecord.get('rrGhost') ? 28 : 42;
        }
        return `<span style="--label-row:${lane}" class="rr-short-name ${narrow ? 'compact' : ''}">${stay ? `${esc(eventRecord.name)} · ${esc(eventRecord.get('rrStart'))}` : `<span>${esc(eventRecord.name)}</span>${narrow ? '' : `<time>${esc(eventRecord.get('rrStart'))}</time>`}`}</span>${!stay && narrow ? `<time class="rr-bar-time">${esc(eventRecord.get('rrStart')).replace(':', ':<wbr>')}</time>` : ''}`;
      },
      events: [],
      dependencies: [],
    });
  }
  // Fit all 16 hourly ticks on desktop; retain readable, scrollable ticks on phones.
  fit() {
    const phone = window.innerWidth < 760;
    const desktop = window.innerWidth >= 1024;
    if (this.destroyed) return;
    const mode = phone ? 'vertical' : 'horizontal';
    // Scheduler 7.3.8 declares mode readonly; its orientation-specific columns
    // and renderers are initialized at construction, not by assigning mode.
    if (this.scheduler.mode !== mode) {
      this.scheduler.destroy();
      this.createScheduler();
      if (this.lastUpdate) return this.update(...this.lastUpdate);
    }
    const timelineWidth = this.scheduler.subGrids.normal.element.clientWidth;
    const tickWidth = desktop ? Math.max(1, timelineWidth / 15) : 64;
    this.scheduler.forceFit = desktop;
    if (phone)
      this.scheduler.resourceColumns.columnWidth = 110;
    if (Math.abs(this.scheduler.tickSize - tickWidth) > 0.05)
      this.scheduler.tickSize = tickWidth;
    this.container.dataset.desktop = String(desktop);
  }

  // Display checked preview rows and connect only active, non-ghost events.
  async update(trip, candidateId) {
    this.lastUpdate = [trip, candidateId];
    const scheduler = this.scheduler;
    const items = scheduleItems(trip, candidateId).filter((i) => !(i.stay && i.day === 1));
    this.items = items;
    const events = items.map((i) => ({
      id: i.id,
      resourceId: `d${i.day}`,
      name: i.stay ? `Stay: ${i.name.replace(/ rooms$/i, '')}` : labelFor(i),
      rrStay: Boolean(i.stay),
      rrStart: i.stay && i.day === 0 ? `${i.start} to ${i.checkout || i.end}` : i.start,
      startDate: date(i.start),
      endDate: date(i.stay && i.day === 0 ? '24:00' : i.end),
      preamble: i.bufferMin,
      rrGhost: Boolean(i.ghost),
      eventColor: {
        lodging: '#1D4E89',
        transfer: '#697b8d',
        activity: '#C65A3A',
        meal: '#a07824',
      }[i.kind],
      rrTooltip: tooltip(i),
      rrClass: `rr-event kind-${i.kind} state-${i.state} ${i.stay ? 'rr-stay' : ''} ${i.ghost ? 'ghost' : ''} ${i.preview ? 'preview' : ''}`,
    }));
    const dependencies = [];
    for (const day of [0, 1]) {
      const sorted = items
        .filter(
          (i) =>
            i.day === day &&
            !i.ghost && !i.stay &&
            !['cancelled', 'replaced', 'released'].includes(i.state),
        )
        .sort((a, b) => a.start.localeCompare(b.start));
      for (let n = 1; n < sorted.length; n++)
        dependencies.push({
          id: `dep-${day}-${n}`,
          from: sorted[n - 1].id,
          to: sorted[n].id,
          type: 2,
        });
    }
    const phone = window.innerWidth < 760;
    syncRecords(this.scheduler.resourceStore, [
      { id: 'd0', name: phone ? 'Day 1' : 'Day 1 · Sat 13 Mar' },
      { id: 'd1', name: phone ? 'Day 2' : 'Day 2 · Sun 14 Mar' },
    ]);
    syncRecords(this.scheduler.eventStore, events);
    syncRecords(this.scheduler.dependencyStore, dependencies);
    await scheduler.project.commitAsync();
    if (!this.destroyed && this.scheduler === scheduler) await this.fit();
  }
  destroy() {
    this.destroyed = true;
    this.motion.removeEventListener('change', this.onMotionChange);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.scheduler.destroy();
  }
}
