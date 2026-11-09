import { test, expect } from 'vitest';
// @ts-ignore Browser JavaScript
import * as shared from '../../public/js/shared.js';
test('both Scheduler tooltips show the AI own words', () => {
  expect(shared.tooltip({ name: 'Tiles', start: '10:30', end: '11:30', priceCents: 800, bufferMin: 10, travelMode: 'walk', why: 'Enjoy tile art' })).toContain('The AI said: Enjoy tile art');
});
test('Why this weekend strip quotes at most three reasons with matching taste chips and a rule fallback', () => {
  expect(shared).toHaveProperty('whyWeekend');
  const render = (shared as any).whyWeekend;
  const html = render({ tastes: ['contemporary art', 'tile art'], itinerary: { items: [{ why: 'Enjoy tile art' }, { why: '<script>' }, { why: 'Third' }, { why: 'Fourth' }] } });
  expect(html).toContain('<span class="state-chip">tile art</span>');
  expect(html).not.toContain('contemporary art');
  expect(html.match(/<q>/g)).toHaveLength(3);
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('Fourth');
  expect(render({ tastes: [], itinerary: { items: [] } })).toContain('Picked by the rules from your tastes.');
});
