import { test, expect } from './fixtures';
import { happyPath, watchErrors } from './helpers';

test('real sandbox: repair, void, fresh hold, capture, refund and complete receipts', async ({ page }) => {
  const errors = watchErrors(page);
  await happyPath(page);
  expect(errors, 'Page exceptions and console errors').toEqual([]);
});
