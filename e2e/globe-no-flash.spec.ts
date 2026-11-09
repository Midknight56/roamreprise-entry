import { test, expect } from './fixtures';
import { idle, openPlanner } from './helpers';

declare global {
  interface Window {
    __globeFlashWatch?: { firstActive: number | null; checks: number; uncovered: number; firstUncovered: unknown };
    __startGlobeFlashWatch?: () => void;
  }
}

test('route map stays covered until the globe starts flying', async ({ page }) => {
  await openPlanner(page, true);
  await page.locator('#globe.globe-idle').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});

  await page.evaluate(() => {
    const globe = document.querySelector<HTMLElement>('#globe')!;
    const routeMap = document.querySelector<HTMLElement>('#route-map')!;
    const state = {
      watching: false,
      firstActive: null as number | null,
      checks: 0,
      uncovered: 0,
      firstUncovered: null as { source: string; time: number; className: string; oldClassName?: string; opacity: number } | null,
    };
    const record = (source: string, oldClassName?: string) => {
      if (!state.watching || state.firstActive !== null) return;
      const time = performance.now();
      const className = globe.className;
      if (className.split(/\s+/).includes('globe-active')) state.firstActive = time;
      state.checks++;
      const opacity = Number.parseFloat(getComputedStyle(routeMap).opacity);
      if (opacity > 0.01 && !/\bglobe-(?:idle|active)\b/.test(className)) {
        state.uncovered++;
        state.firstUncovered ??= { source, time, className, oldClassName, opacity };
      }
    };
    const observer = new MutationObserver(records => {
      for (const mutation of records) record('class change', mutation.oldValue ?? '');
    });
    observer.observe(globe, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    const frame = () => {
      record('animation frame');
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.__globeFlashWatch = state;
    window.__startGlobeFlashWatch = () => {
      state.watching = true;
      record('click start');
    };
  });

  await page.evaluate(() => window.__startGlobeFlashWatch!());
  await page.getByRole('button', { name: 'Plan my two days' }).click();
  await expect.poll(() => page.evaluate(() => window.__globeFlashWatch!.firstActive), { timeout: 30000 }).not.toBeNull();
  await idle(page);

  const result = await page.evaluate(() => window.__globeFlashWatch!);
  expect(result.uncovered, `route map was uncovered in ${result.uncovered} of ${result.checks} checks; first: ${JSON.stringify(result.firstUncovered)}`).toBe(0);
});
