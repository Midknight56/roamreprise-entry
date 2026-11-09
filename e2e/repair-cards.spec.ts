import { test, expect } from './fixtures';
import { startTrip, quote, hold, press, waitPhase, idle, watchErrors } from './helpers';

function rect(box: { x: number; y: number; width: number; height: number }) {
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

for (const { width, height, name } of [
  { width: 1280, height: 800, name: 'desktop' },
  { width: 390, height: 844, name: 'phone' },
]) {
  test(`repair cards readable and unclipped on ${name} (${width}x${height})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors = watchErrors(page);
    await startTrip(page, true);
    await quote(page);
    await hold(page);
    await waitPhase(page, 'holding');
    await press(page, 'Simulate: the hotel cancels our room');
    const view = await waitPhase(page, 'repair_proposed');

    const repair = view.repair!;
    expect(repair).toBeDefined();
    const checkedCandidates = repair.candidates.filter((c) => c.checks.ok);
    expect(checkedCandidates.length).toBeGreaterThan(0);

    const recordedRequests: string[] = [];
    page.on('request', (r) => {
      recordedRequests.push(r.url());
    });

    for (const candidate of checkedCandidates) {
      const card = page
        .locator('.candidate')
        .filter({ has: page.getByRole('heading', { name: candidate.name, exact: true }) });
      await expect(card).toBeVisible();

      const cardBox = rect((await card.boundingBox())!);

      const totalLine = card.locator('.fact-total');
      await expect(totalLine).toBeVisible();
      const totalBox = rect((await totalLine.boundingBox())!);
      expect(totalBox.left).toBeGreaterThanOrEqual(cardBox.left - 1);
      expect(totalBox.right).toBeLessThanOrEqual(cardBox.right + 1);
      expect(totalBox.left).toBeGreaterThanOrEqual(0);
      expect(totalBox.right).toBeLessThanOrEqual(width + 1);

      const activitiesLine = card.locator('.fact-activities');
      await expect(activitiesLine).toBeVisible();
      const activitiesBox = rect((await activitiesLine.boundingBox())!);
      expect(activitiesBox.left).toBeGreaterThanOrEqual(cardBox.left - 1);
      expect(activitiesBox.right).toBeLessThanOrEqual(cardBox.right + 1);
      expect(activitiesBox.left).toBeGreaterThanOrEqual(0);
      expect(activitiesBox.right).toBeLessThanOrEqual(width + 1);

      const factElements = card.locator('.candidate-facts .fact');
      const factCount = await factElements.count();
      for (let i = 0; i < factCount; i++) {
        const fontSize = await factElements
          .nth(i)
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(fontSize).toBeGreaterThanOrEqual(14);
      }

      const previewButton = card.getByRole('button', { name: /Preview/ });
      await previewButton.click();
      await idle(page);

      const useButton = card.getByRole('button', {
        name: new RegExp(`^Use ${candidate.name}`),
      });
      await expect(useButton).toBeVisible();

      const useBox = rect((await useButton.boundingBox())!);
      expect(useBox.left).toBeGreaterThanOrEqual(cardBox.left - 1);
      expect(useBox.right).toBeLessThanOrEqual(cardBox.right + 1);
      expect(useBox.left).toBeGreaterThanOrEqual(15.5);
      expect(useBox.right).toBeLessThanOrEqual(width - 15.5);
    }

    const paymentRequests = recordedRequests.filter((url) => {
      const pathname = new URL(url).pathname.toLowerCase();
      return ['pay', 'authorize', 'void', 'capture', 'refund'].some((route) =>
        pathname.includes(route),
      );
    });
    expect(paymentRequests).toEqual([]);

    const pick =
      checkedCandidates.find((c) => c.id === repair.pickId) || checkedCandidates[0];
    const pickCard = page
      .locator('.candidate')
      .filter({ has: page.getByRole('heading', { name: pick.name, exact: true }) });
    await pickCard.getByRole('button', { name: /Preview/ }).click();
    await idle(page);
    const useBtn = pickCard.getByRole('button', {
      name: new RegExp(`^Use ${pick.name}`),
    });
    await useBtn.click();
    await waitPhase(page, 'requote');

    const step3 = page.locator('.mandate-strip li').nth(2);
    await expect(step3).toContainText(/PayPal released the .* hold, nothing charged/);

    expect(errors).toEqual([]);
  });
}
