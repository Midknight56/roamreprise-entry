import { describe, expect, test } from 'vitest';
import about from '../../public/about.html?raw';
import caps from '../../src/caps.ts?raw';

function cap(name: string) {
  const match = caps.match(new RegExp(`export const ${name} = ([\\d_]+)`));
  if (!match) throw new Error(`Could not read ${name} from src/caps.ts`);
  return Number(match[1].replaceAll('_', ''));
}
describe('public copy matches the code', () => {
  test('about page cap values match src/caps.ts', () => {
    const visible = about.replace(/<[^>]*>/g, ' ');
    expect(visible).toContain(`${cap('RESERVED_NEURONS')} neurons`);
    expect(visible).toContain(`${cap('DAILY_NEURONS') / cap('RESERVED_NEURONS')} such reservations`);
    expect(visible).toContain(`At most ${cap('MAX_AI_CALLS_PER_TRIP')} AI calls`);
  });

  test('public visitor text has no fixed $58 refund', () => {
    const files = import.meta.glob<string>('../../public/**/*.{html,js}', { eager: true, query: '?raw', import: 'default' });
    const visibleText = Object.entries(files).flatMap(([path, content]) => {
      if (path.endsWith('.html')) return [content.replace(/<[^>]*>/g, ' ')];
      if (!path.endsWith('.js')) return [];
      return [...content.matchAll(/'[^']*'|"[^"]*"|`[^`]*`/g)].map((match) => match[0].slice(1, -1));
    }).join('\n');
    expect(visibleText).not.toMatch(/\$58(?:\.00)?\b/);
  });
});
