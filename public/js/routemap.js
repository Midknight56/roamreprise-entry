import { places, previewItems } from './shared.js';
export class RouteMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);
  }
  update(trip, candidateId) {
    this.trip = trip;
    this.candidateId = candidateId;
    this.draw();
  }
  // Draw original river geometry and place coordinates without map tiles.
  draw() {
    const canvas = this.canvas,
      ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#e9eee8';
    ctx.fillRect(0, 0, w, h);
    // Original schematic geography. Airport uses an inset so the city remains readable.
    function project(lat, lon) {
      return [
        ((lon + 9.225) / 0.125) * (w - 55) + 28,
        ((38.742 - lat) / 0.058) * (h - 42) + 20,
      ];
    }
    // The airport inset preserves detail in the smaller city view.
    function coord(id) {
      return id === 'lis' ? [w - 49, 27] : project(...places[id].slice(1));
    }
    function path(points) {
      ctx.beginPath();
      points.forEach(([lat, lon], i) => {
        const [x, y] = project(lat, lon);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
    }
    path([
      [38.69, -9.23],
      [38.688, -9.21],
      [38.693, -9.194],
      [38.699, -9.178],
      [38.701, -9.16],
      [38.703, -9.145],
      [38.704, -9.135],
      [38.708, -9.115],
      [38.718, -9.1],
      [38.66, -9.1],
      [38.66, -9.24],
    ]);
    ctx.closePath();
    ctx.fillStyle = '#bdd6df';
    ctx.fill();
    ctx.strokeStyle = '#d5ded3';
    ctx.lineWidth = 1;
    for (let n = 0; n < 13; n++) {
      const x = (n * w) / 12;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 70, h);
      ctx.stroke();
    }
    for (let n = 0; n < 9; n++) {
      ctx.beginPath();
      ctx.moveTo(0, (n * h) / 8);
      ctx.lineTo(w, (n * h) / 8 - 30);
      ctx.stroke();
    }
    const riverLabel = { text: 'Rio Tejo', x: w * 0.25, y: h * 0.86 };
    ctx.font = 'italic 17px Georgia';
    riverLabel.width = ctx.measureText(riverLabel.text).width;
    ctx.fillStyle = '#547687';
    ctx.fillText(riverLabel.text, riverLabel.x, riverLabel.y);
    ctx.font = '10px system-ui';
    ctx.fillStyle = '#536658';
    ctx.fillText('BELÉM', 26, h * 0.62);
    ctx.fillText('LISBOA', w * 0.6, h * 0.23);
    if (!this.trip) {
      ctx.font = '16px Georgia';
      ctx.fillStyle = '#1D4E89';
      ctx.fillText('Two days. Room to change.', 24, 36);
      return;
    }
    const items = previewItems(this.trip, this.candidateId).filter(
      (i) => !['replaced', 'cancelled', 'released'].includes(i.state),
    );
    for (const day of [0, 1]) {
      const route = items
        .filter((i) => i.day === day)
        .sort((a, b) => a.start.localeCompare(b.start));
      ctx.beginPath();
      route.forEach((i, n) => {
        const [x, y] = coord(i.placeId);
        n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = day ? '#C65A3A' : '#1D4E89';
      ctx.lineWidth = day ? 2 : 3;
      ctx.setLineDash(day ? [5, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      route.forEach((i, n) => {
        const [x, y] = coord(i.placeId);
        ctx.beginPath();
        ctx.arc(x, y, day ? 9 : 12, 0, Math.PI * 2);
        ctx.fillStyle = day ? '#C65A3A' : '#1D4E89';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(String(n + 1), x, y + 3);
        ctx.textAlign = 'left';
      });
    }
    const hotel = items.find((i) => i.kind === 'lodging');
    if (hotel) {
      const [x, y] = coord(hotel.placeId);
      ctx.fillStyle = '#0e1b2c';
      ctx.fillRect(x - 12, y - 28, 24, 19);
      ctx.fillStyle = 'white';
      ctx.font = 'bold 12px system-ui';
      ctx.fillText('H', x - 4, y - 14);
      ctx.font = '11px system-ui';
      ctx.fillStyle = '#0e1b2c';
      const label = hotel.name.replace(' rooms', '');
      const labelX = Math.max(8, Math.min(w - ctx.measureText(label).width - 10, x - 18));
      let labelY = y + 28;
      const hotelBox = () => ({ left: labelX, right: labelX + ctx.measureText(label).width, top: labelY - 12, bottom: labelY + 2 });
      const riverBox = { left: riverLabel.x, right: riverLabel.x + riverLabel.width, top: riverLabel.y - 18, bottom: riverLabel.y + 3 };
      const a = hotelBox();
      if (a.left < riverBox.right && a.right > riverBox.left && a.top < riverBox.bottom && a.bottom > riverBox.top)
        labelY = y - 34;
      ctx.fillText(label, labelX, labelY);
    }
    if (this.trip.phase === 'repair_proposed') {
      const failed = this.trip.itinerary.items.find(
        (i) => i.id === this.trip.repair.failedItemId,
      );
      if (failed) {
        const [x, y] = coord(failed.placeId);
        ctx.strokeStyle = '#B8322A';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x - 12, y - 12);
        ctx.lineTo(x + 12, y + 12);
        ctx.moveTo(x + 12, y - 12);
        ctx.lineTo(x - 12, y + 12);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#0e1b2c';
    ctx.font = '10px system-ui';
    ctx.fillText(
      'Own flights · LIS 10:30 / 19:00',
      Math.max(10, w - 215),
      h - 10,
    );
  }
  destroy() {
    this.observer.disconnect();
  }
}
