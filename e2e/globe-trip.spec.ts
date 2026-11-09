import { test, expect } from './fixtures';
import { startTrip, idle } from './helpers';

test('route map appears after planning and after reopening the trip URL', async ({ page }) => {
  await startTrip(page, true);
  await idle(page);
  await expect(page.locator('#route-map')).toBeVisible();
  await expect(page.locator('#globe canvas.idle-globe')).toHaveCount(0);

  const tripUrl = page.url();
  expect(new URL(tripUrl).searchParams.get('trip')).toBeTruthy();
  await page.goto(tripUrl);
  await expect(page.locator('#route-map')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#globe canvas.idle-globe')).toHaveCount(0);
});
