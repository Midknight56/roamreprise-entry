import { describe, expect, test } from 'vitest';
import type { PaymentAttempt, TripView } from '../../src/domain/types';
// @ts-expect-error Browser module is plain JavaScript.
import { moneyStory, mandateSteps, netSummary, netSummaryText } from '../../public/js/money-story.js';

function attempt(state: PaymentAttempt['state'], amountCents: number, extra: Partial<PaymentAttempt> = {}): PaymentAttempt {
  return { state, amountCents, quoteVersion: 1, method: 'card', refunds: [], receipts: [], ...extra };
}
function trip(payments: PaymentAttempt[]): TripView {
  return { ceilingCents: 67321, quote: { totalCents: 43219, version: 2, approvedAt: '' }, payments } as TripView;
}

describe('moneyStory', () => {
  test('full happy path totals captures minus only completed refunds', () => {
    const view = trip([
      attempt('voided', 42817, { authorizationId: 'old' }),
      attempt('captured', 39729, { authorizationId: 'new', captureId: 'capture', refunds: [
        { amountCents: 5013, state: 'completed', reason: 'Activity cancelled' },
      ] }),
    ]);
    const story = moneyStory(view);
    expect(story).toContain('You approved $428.17. PayPal held it.');
    expect(story).toContain('That hold was voided and nothing was charged.');
    expect(story).toContain('You approved $397.29. PayPal held it.');
    expect(story).toContain('$50.13 was refunded when an activity was cancelled.');
    expect(story).toContain('Charged in total: $347.16.');
  });
  test('declined then paid counts only the successful capture', () => {
    const story = moneyStory(trip([attempt('declined', 41823), attempt('captured', 41823)]));
    expect(story).toContain('The payment was declined and nothing was charged.');
    expect(story).toContain('Charged in total: $418.23.');
  });
  test.each(['pending', 'failed'] as const)('refund %s does not reduce the charged total', (state) => {
    const story = moneyStory(trip([attempt('captured', 39729, { refunds: [
      { amountCents: 5013, state, reason: 'Activity cancelled' },
    ] })]));
    expect(story).toContain(`The $50.13 refund ${state === 'pending' ? 'is still pending' : 'failed'}`);
    expect(story).toContain('Charged in total: $397.29.');
  });
  test('expired and uncertain payments do not claim a charge or a known final total', () => {
    expect(moneyStory(trip([attempt('expired', 31234)]))).toContain('The hold expired and nothing was charged.');
    const story = moneyStory(trip([attempt('unknown', 31234, { previousState: 'authorized' })]));
    expect(story).toContain('PayPal is checking this payment');
    expect(story).toContain('Confirmed charged so far: $0.00.');
    expect(story).not.toContain('Charged in total:');
  });
  test('unknown refund retains the known capture and requests a status check', () => {
    const story = moneyStory(trip([attempt('unknown', 30031, { previousState: 'captured', captureId: 'cap', refunds: [
      { amountCents: 4012, state: 'unknown', reason: 'Activity cancelled' },
    ] })]));
    expect(story).toContain('PayPal is checking the $40.12 refund');
    expect(story).toContain('Confirmed charged so far: $300.31.');
  });
  test('no attempts describes only the ceiling, never an approval or a hold', () => {
    expect(moneyStory(trip([]))).toBe('You allow up to $673.21. No payment has been charged.');
  });
  test('a pending capture id is not counted as charged', () => {
    const story = moneyStory(trip([attempt('capturing', 31519, { captureId: 'pending' })]));
    expect(story).toContain('PayPal is checking the charge.');
    expect(story).toContain('Confirmed charged so far: $0.00.');
    expect(story).not.toContain('It was charged');
  });
  test('multiple captures and refunds add up without including voided attempts', () => {
    const story = moneyStory(trip([
      attempt('captured', 21823, { refunds: [{ amountCents: 1037, state: 'completed', reason: '' }] }),
      attempt('voided', 41823),
      attempt('captured', 19729, { refunds: [{ amountCents: 1013, state: 'completed', reason: '' }] }),
    ]));
    expect(story).toContain('Charged in total: $395.02.');
  });
});

describe('mandateSteps', () => {
  test('five numbers come from ceiling, current quote, latest authorization, captures and completed refunds', () => {
    const steps = mandateSteps(trip([
      attempt('voided', 42817, { authorizationId: 'old' }),
      attempt('captured', 39729, { authorizationId: 'new', refunds: [
        { amountCents: 5013, state: 'completed', reason: '' },
        { amountCents: 703, state: 'pending', reason: '' },
      ] }),
      attempt('declined', 12345),
    ]));
    expect(steps.map((step: { cents: number }) => step.cents)).toEqual([67321, 43219, 39729, 39729, 5013]);
    expect(steps.every((step: { reached: boolean }) => step.reached)).toBe(true);
  });
  test('unreached steps contain labels without amounts', () => {
    const view = trip([]); delete view.quote;
    const steps = mandateSteps(view);
    expect(steps.map((step: { reached: boolean }) => step.reached)).toEqual([true, false, false, false, false]);
    expect(steps.slice(1).map((step: { text: string }) => step.text)).toEqual([
      'Agent proposes', 'PayPal holds', 'Captured when every booking is confirmed', 'Refunded when an activity was cancelled',
    ]);
  });
  test('a denied authorization id does not prove that PayPal held money', () => {
    const view = trip([attempt('declined', 21519, { authorizationId: 'denied' })]);
    expect(mandateSteps(view)[2].reached).toBe(false);
    expect(moneyStory(view)).not.toContain('PayPal held it.');
  });
});

describe('mandate step 3 tells the truth about latest held attempt', () => {
  test('authorized: PayPal holds $X now', () => {
    const steps = mandateSteps(trip([attempt('authorized', 42800)]));
    expect(steps[2].text).toBe('PayPal holds $428.00 now');
    expect(steps[2].reached).toBe(true);
  });
  test('capturing, voiding, or unknown with earlier held state: PayPal hold of $X, being checked', () => {
    const capturing = mandateSteps(trip([attempt('capturing', 42800)]));
    expect(capturing[2].text).toBe('PayPal hold of $428.00, being checked');
    expect(capturing[2].reached).toBe(true);

    const voiding = mandateSteps(trip([attempt('voiding', 42800)]));
    expect(voiding[2].text).toBe('PayPal hold of $428.00, being checked');
    expect(voiding[2].reached).toBe(true);

    const unknownHeld = mandateSteps(trip([attempt('unknown', 42800, { previousState: 'authorized' })]));
    expect(unknownHeld[2].text).toBe('PayPal hold of $428.00, being checked');
    expect(unknownHeld[2].reached).toBe(true);
  });
  test('captured: PayPal held $X, then captured it', () => {
    const steps = mandateSteps(trip([attempt('captured', 42800)]));
    expect(steps[2].text).toBe('PayPal held $428.00, then captured it');
    expect(steps[2].reached).toBe(true);
  });
  test('voided: PayPal released the $X hold, nothing charged', () => {
    const steps = mandateSteps(trip([attempt('voided', 42800)]));
    expect(steps[2].text).toBe('PayPal released the $428.00 hold, nothing charged');
    expect(steps[2].reached).toBe(true);
  });
  test('expired: The $X hold expired, nothing charged', () => {
    const steps = mandateSteps(trip([attempt('expired', 42800)]));
    expect(steps[2].text).toBe('The $428.00 hold expired, nothing charged');
    expect(steps[2].reached).toBe(true);
  });
  test('none: PayPal holds', () => {
    const steps = mandateSteps(trip([]));
    expect(steps[2].text).toBe('PayPal holds');
    expect(steps[2].reached).toBe(false);
  });
  test("the judge case: one voided $428.00 attempt must not contain 'holds $428.00'", () => {
    const steps = mandateSteps(trip([attempt('voided', 42800)]));
    expect(steps[2].text).not.toContain('holds $428.00');
    expect(steps[2].text).toBe('PayPal released the $428.00 hold, nothing charged');
  });
});

describe('netSummary and netSummaryText', () => {
  test('netSummaryText for voided $428 + captured $397 with completed $50 refund equals example exactly', () => {
    const view = trip([
      attempt('voided', 42800),
      attempt('captured', 39700, {
        refunds: [{ amountCents: 5000, state: 'completed', reason: 'Activity cancelled' }],
      }),
    ]);
    expect(netSummary(view)).toEqual({
      releasedCents: 42800,
      capturedCents: 39700,
      refundedCents: 5000,
      netCents: 34700,
      uncertain: false,
    });
    expect(netSummaryText(view)).toBe(
      'Released, never charged: $428.00 · Captured: $397.00 · Refunded: $50.00 · Net charged: $347.00',
    );
  });
  test('an unknown capture gives Confirmed so far', () => {
    const view = trip([
      attempt('unknown', 39700, { previousState: 'captured' }),
    ]);
    expect(netSummary(view).uncertain).toBe(true);
    expect(netSummaryText(view)).toContain('Confirmed so far');
    expect(netSummaryText(view)).not.toContain('Net charged');
  });
});

