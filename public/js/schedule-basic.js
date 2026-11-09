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

// The fallback preserves the same axis, travel zones and dependencies as Scheduler.
export class BasicSchedule {
  constructor(container) {
    this.container = container;
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(container);
    this.onWindowResize = () => this.refit();
    window.addEventListener('resize', this.onWindowResize);
  }

  // Rebuild only when width or breakpoint changes, avoiding observer loops.
  refit() {
    const layout = `${window.innerWidth >= 1024}:${this.container.clientWidth}`;
    if (this.trip && layout !== this.layout)
      this.update(this.trip, this.candidateId);
  }

  update(trip, candidateId) {
    this.trip = trip;
    this.candidateId = candidateId;
    const desktop = window.innerWidth >= 1024;
    this.layout = `${desktop}:${this.container.clientWidth}`;
    const headerWidth = 125;
    const trackWidth = desktop
      ? this.container.clientWidth - headerWidth
      : 1024;
    const pixelsPerMinute = trackWidth / (15 * 60);
    const items = scheduleItems(trip, candidateId).filter((item) => !(item.stay && item.day === 1));
    const axis = Array.from({ length: 15 }, function renderHour(_value, index) {
      const left = headerWidth + (index * trackWidth) / 15;
      return `<span style="left:${left}px">${String(index + 9).padStart(2, '0')}</span>`;
    }).join('');
    const lanes = labelLanes(items, pixelsPerMinute);
    const rows = [0, 1]
      .map(function renderDay(day) {
        const dayItems = items.filter((item) => item.day === day);
        const events = dayItems
          .map((item) => renderEvent(item, pixelsPerMinute, lanes.get(item.id) || 0))
          .join('');
        const active = dayItems.filter(
          (item) =>
            !item.ghost && !item.stay &&
            !['cancelled', 'replaced', 'released'].includes(item.state),
        );
        active.sort((first, second) => first.start.localeCompare(second.start));
        const dependencies = active
          .map((item, index) =>
            renderDependency(item, active[index - 1], pixelsPerMinute),
          )
          .join('');
        return `
        <div class="day-row">
          <strong style="width:${headerWidth}px">Day ${day + 1}<small>${day ? 'Sun 14' : 'Sat 13'} Mar</small></strong>
          <div class="day-track" style="width:${trackWidth}px;min-width:0;background-size:${trackWidth / 15}px 100%">
            ${events}${dependencies}
          </div>
        </div>
      `;
      })
      .join('');
    const markup = `
      <div class="basic-scroll" tabindex="0" aria-label="Two day schedule. ${desktop ? 'The full day is visible.' : 'Scroll sideways for later hours.'}">
        <div class="basic-timeline" style="width:${trackWidth + headerWidth}px">
          <div class="hour-axis"><b>Lisbon time</b>${axis}</div>
          ${rows}
        </div>
      </div>
    `;
    if (!this.container.firstElementChild) {
      this.container.innerHTML = markup;
      return;
    }
    // Keep each bar mounted so left/width transitions have their old geometry.
    const next = document.createElement('div');
    next.innerHTML = markup;
    this.container.querySelector('.basic-scroll').setAttribute('aria-label',
      next.querySelector('.basic-scroll').getAttribute('aria-label'));
    this.container.querySelector('.basic-timeline').style.cssText =
      next.querySelector('.basic-timeline').style.cssText;
    this.container.querySelector('.hour-axis').innerHTML = next.querySelector('.hour-axis').innerHTML;
    this.container.querySelectorAll('.day-track').forEach((track, index) => {
      const nextTrack = next.querySelectorAll('.day-track')[index];
      track.style.cssText = nextTrack.style.cssText;
      const existing = new Map([...track.children].map(node => [node.dataset.scheduleKey, node]));
      [...nextTrack.children].forEach((node, position) => {
        const current = existing.get(node.dataset.scheduleKey);
        if (current) {
          existing.delete(node.dataset.scheduleKey);
          for (const attr of [...current.attributes])
            if (!node.hasAttribute(attr.name)) current.removeAttribute(attr.name);
          for (const attr of node.attributes)
            if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
          if (current.innerHTML !== node.innerHTML) current.innerHTML = node.innerHTML;
        }
        const retained = current || node;
        if (track.children[position] !== retained)
          track.insertBefore(retained, track.children[position] || null);
      });
      existing.forEach(node => node.remove());
    });
  }

  destroy() {
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.container.replaceChildren();
  }
}

// All positions are measured from 09:00; duration is never widened for a label.
function renderEvent(item, pixelsPerMinute, lane) {
  const start = item.start;
  const end = item.stay && item.day === 0 ? '24:00' : item.end;
  const left = (minutes(start) - 540) * pixelsPerMinute;
  const width = (minutes(end) - minutes(start)) * pixelsPerMinute;
  const bufferWidth = item.bufferMin * pixelsPerMinute;
  const travel =
    item.bufferMin && !item.ghost
      ? `
    <span data-schedule-key="buffer-${esc(item.id)}" class="travel-buffer" style="left:${left - bufferWidth}px;width:${bufferWidth}px" title="${item.bufferMin} min ${esc(item.travelMode)}">${item.bufferMin}m</span>
  `
      : '';
  return `
    ${travel}
    <button type="button" data-schedule-key="${esc(item.id)}" class="schedule-event ${item.stay ? 'rr-stay' : ''} kind-${item.kind} state-${item.state} ${item.ghost ? 'ghost' : ''} ${item.preview ? 'preview' : ''}"
      style="left:${left}px;width:${width}px;--label-row:${lane};top:${item.stay ? 116 : item.ghost ? 76 : 64}px;height:${item.stay ? 18 : item.ghost ? 28 : 42}px" title="${esc(tooltip(item))}" aria-label="${esc(tooltip(item))}">
      <span class="rr-short-name ${width < 70 ? 'compact' : ''}">${item.stay ? `Stay: ${esc(item.name.replace(/ rooms$/i, ''))} · ${esc(item.start)} to ${esc(item.checkout || item.end)}` : `<span>${esc(labelFor(item))}</span>${width < 70 ? '' : `<time>${start}</time>`}`}</span>
      ${!item.stay && width < 70 ? `<time class="rr-bar-time">${start.replace(':', ':<wbr>')}</time>` : ''}
    </button>
  `;
}

// Connect consecutive active items, leaving travel zones visible behind the arrow.
function renderDependency(item, previous, pixelsPerMinute) {
  if (!previous) return '';
  const left = (minutes(previous.end) - 540) * pixelsPerMinute;
  const width = (minutes(item.start) - minutes(previous.end)) * pixelsPerMinute;
  return `<span data-schedule-key="dep-${esc(item.id)}" class="basic-dependency" aria-hidden="true" style="left:${left}px;width:${Math.max(0, width)}px">→</span>`;
}
