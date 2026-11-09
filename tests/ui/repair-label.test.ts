import { describe, expect, test } from 'vitest';
import { droppedItemLabel } from '../../public/js/repair-label.js';

describe('repair drop labels', () => {
  test('uses the current item name or a plain day and time label', () => {
    expect(droppedItemLabel({ items: [{ slot: 'd2-pm', name: 'Castle hill' }] }, 'd2-pm')).toBe('Castle hill');
    expect(droppedItemLabel({ items: [] }, 'd2-pm')).toBe('Day 2 afternoon');
    expect(droppedItemLabel({ items: [] }, 'd1-lunch')).toBe('Day 1 lunch');
  });
});
