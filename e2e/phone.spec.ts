import { test } from './fixtures';
import { eventLabels, happyPath, phoneLayout, startTrip } from './helpers';

test.use({ viewport: { width: 390, height: 844 } });
test('phone happy path: page width, button insets, spacing and text', async ({ page }) => {
  await page.goto('/');
  await phoneLayout(page);
  await happyPath(page, phoneLayout);
});

test('phone itinerary names every stop without clipping', async ({ page }) => {
  await startTrip(page);
  await eventLabels(page, 'vertical');
});
