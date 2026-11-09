// Run from the repository root with a static server serving public on port 8873.
// Uses one headless browser and only local mock data. No paid calls.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { babelParse } from '../node_modules/playwright/lib/transform/babelBundle.js';

// Playwright already bundles the TypeScript syntax parser used by this check.
// Read the owning contract instead of duplicating its required field names.
const contractSource = await readFile('src/domain/types.ts', 'utf8');
const contract = babelParse(contractSource, 'types.ts', {
  parserOpts: { plugins: ['typescript'] },
});
const definitions = new Map(
  contract.program.body
    .map((node) => node.declaration || node)
    .filter((node) =>
      ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(node.type),
    )
    .map((node) => [node.id.name, node]),
);

// Validate the TypeScript forms used by TripView and all its nested interfaces.
function assertContract(value, type, path = 'TripView') {
  if (type.type === 'TSInterfaceDeclaration' || type.type === 'TSTypeLiteral') {
    const members =
      type.type === 'TSInterfaceDeclaration' ? type.body.body : type.members;
    assert.ok(
      value && typeof value === 'object' && !Array.isArray(value),
      `${path} must be an object`,
    );
    const names = members.map((member) => member.key.name);
    assert.ok(
      Object.keys(value).every((name) => names.includes(name)),
      `${path} has an unknown field`,
    );
    for (const member of members) {
      const field = member.key.name;
      if (member.optional && value[field] === undefined) continue;
      assertContract(
        value[field],
        member.typeAnnotation.typeAnnotation,
        `${path}.${field}`,
      );
    }
    return;
  }
  if (type.type === 'TSTypeAliasDeclaration')
    return assertContract(value, type.typeAnnotation, path);
  if (type.type === 'TSUnionType') {
    assert.ok(
      type.types.some(function acceptsUnion(option) {
        try {
          assertContract(value, option, path);
          return true;
        } catch {
          return false;
        }
      }),
      `${path} does not match ${contractSource.slice(type.start, type.end)}`,
    );
    return;
  }
  if (type.type === 'TSArrayType') {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    value.forEach((entry, index) =>
      assertContract(entry, type.elementType, `${path}[${index}]`),
    );
    return;
  }
  if (type.type === 'TSTypeReference') {
    const name = type.typeName.name;
    const args = type.typeParameters?.params || [];
    if (name === 'Pick') {
      const base = definitions.get(args[0].typeName.name);
      const keys = (args[1].types || [args[1]]).map(
        (node) => node.literal.value,
      );
      assert.ok(
        value && Object.keys(value).every((key) => keys.includes(key)),
        `${path} has an unknown picked field`,
      );
      for (const member of base.body.body.filter((node) =>
        keys.includes(node.key.name),
      )) {
        assertContract(
          value[member.key.name],
          member.typeAnnotation.typeAnnotation,
          `${path}.${member.key.name}`,
        );
      }
      return;
    }
    if (name === 'Exclude') {
      assertContract(value, args[0], path);
      assert.notEqual(
        value,
        args[1].literal.value,
        `${path} uses an excluded state`,
      );
      return;
    }
    assert.ok(definitions.has(name), `Unsupported contract type ${name}`);
    return assertContract(value, definitions.get(name), path);
  }
  if (type.type === 'TSLiteralType') {
    assert.equal(value, type.literal.value, path);
    return;
  }
  if (type.type === 'TSTypeQuery') {
    assert.equal(value, 'Simulated supplier', path);
    return;
  }
  const primitive = {
    TSStringKeyword: 'string',
    TSNumberKeyword: 'number',
    TSBooleanKeyword: 'boolean',
  }[type.type];
  assert.ok(primitive, `Unsupported contract syntax ${type.type}`);
  assert.equal(typeof value, primitive, path);
}
const origin = process.env.RR_UI_BASE || 'http://127.0.0.1:8873';
const out = 'artifacts/mock-qa';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = {
  at: new Date().toISOString(),
  errors: [],
  expectedErrors: [],
  checks: [],
  shots: [],
};
function check(name, value) {
  assert.ok(value, name);
  report.checks.push(name);
}
async function settled(page) {
  await page.waitForFunction(
    () =>
      document.querySelector('#main')?.getAttribute('aria-busy') === 'false',
  );
}
async function current(page) {
  const trip = await page.evaluate(() => {
    const id = new URL(location.href).searchParams.get('trip');
    return JSON.parse(localStorage.getItem('roamreprise-mock-v1'))[id];
  });
  assertContract(trip, definitions.get('TripView'));
  assert.ok(trip.next.every(action => ['quote', 'pay', 'confirm', 'hotel-unavailable', 'repair/accept', 'cancel-activity', 'reconcile'].includes(action)), 'Mock next tokens match server');
  return trip;
}
async function click(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await settled(page);
}
function watch(page) {
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      if (m.location().url.endsWith('/api/trips/missing'))
        report.expectedErrors.push(m.text());
      else report.errors.push(m.text());
    }
  });
}
async function shot(page, size, name, focus) {
  if (focus)
    await page
      .locator(focus)
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  else await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: `${out}/${size}-${name}.png`,
    animations: 'disabled',
  });
  report.shots.push(`${size}-${name}.png`);
  check(
    `${size} ${name}: no page overflow`,
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
}
try {
  check(
    'QA script is not served from public',
    (await fetch(`${origin}/qa/verify.mjs`)).status === 404,
  );
  check(
    'Evidence gallery is not served from public',
    (await fetch(`${origin}/qa/index.html`)).status === 404,
  );
  check(
    'Artifacts are not served from public',
    (await fetch(`${origin}/artifacts/mock-qa/index.html`)).status === 404,
  );
  for (const [size, width, height] of [
    ['desktop', 1280, 800],
    ['phone', 390, 844],
  ]) {
    const context = await browser.newContext({ viewport: { width, height } }),
      page = await context.newPage();
    watch(page);
    let apiCalls = 0;
    page.on('request', (r) => {
      if (/\/(api|webhooks)\//.test(r.url())) apiCalls++;
    });
    await page.goto(`${origin}/?mock=1`);
    await shot(page, size, 'plan');
    // Capture the real animation once, rather than a static substitute.
    await page
      .getByRole('button', { name: 'Plan my two days', exact: true })
      .click();
    await page.waitForSelector('#globe.globe-active');
    await shot(page, size, 'globe');
    await settled(page);
    let t = await current(page);
    check(
      `${size}: planned TripView`,
      t.phase === 'planned' && t.itinerary.totalCents === 42600,
    );
    check(
      `${size}: Bryntum rendered`,
      (await page.locator('#schedule').getAttribute('data-view')) === 'bryntum',
    );
    check(
      `${size}: travel buffers`,
      (await page.locator('.rr-travel-buffer').count()) > 0,
    );
    check(
      `${size}: dependencies`,
      (await page.locator('.b-sch-dependency').count()) > 0,
    );
    check(`${size}: exact TripView schema`, Boolean(t));
    if (size === 'desktop') {
      for (const resizedWidth of [1280, 1100, 1440, 1024, 390, 1280]) {
        await page.setViewportSize({ width: resizedWidth, height });
        await page.waitForFunction(() => {
          const timeline = document.querySelector('.b-grid-sub-grid-normal');
          return (
            (innerWidth >= 1024
              ? timeline.scrollWidth <= timeline.clientWidth + 1
              : timeline.scrollWidth > timeline.clientWidth) &&
            document.querySelectorAll('.rr-short-name').length === 12
          );
        });
        check(`Schedule refits after resize to ${resizedWidth}`, true);
      }
      const axis = await page.locator('#schedule').evaluate(async (element) => {
        const { Widget } =
          await import('/vendor/bryntum/scheduler/scheduler.module.js');
        const scheduler = Widget.fromElement(element.firstElementChild);
        return {
          start: scheduler.startDate.getHours(),
          end: scheduler.endDate.getHours(),
          hours: (scheduler.endDate - scheduler.startDate) / 3600000,
        };
      });
      check(
        'Desktop axis remains 08:00 to 24:00',
        axis.start === 8 && axis.end === 0 && axis.hours === 16,
      );
      await page.locator('[data-event-id="d1-lunch"]').hover();
      const tip = page.locator('.schedule-tip');
      await tip.waitFor();
      const text = await tip.innerText();
      check(
        'Tooltip keeps full name, time, price, state, supplier and reference',
        [
          'Market hall lunch',
          '12:30',
          '13:45',
          '$24.00',
          'planned',
          'Simulated supplier',
          'No reference yet',
        ].every((value) => text.includes(value)),
      );
      await page.mouse.move(0, 0);
      await tip.waitFor({ state: 'hidden' });
    } else {
      check(
        'Phone schedule scrolls inside its box',
        await page
          .locator('.b-grid-sub-grid-normal')
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      );
    }
    await shot(page, size, 'planned', '#schedule');
    await click(page, 'Approve quote');
    check(`${size}: quoted`, (await current(page)).phase === 'quoted');
    await shot(page, size, 'quoted', '#pay-panel');
    await click(page, 'Hold $426.00 with card (no sign in)');
    check(`${size}: authorized`, (await current(page)).phase === 'holding');
    await shot(page, size, 'authorized', '#state-chips');
    check(`${size}: holding`, (await current(page)).phase === 'holding');
    if (size === 'desktop') {
      await page.locator('[data-event-id="d1-lunch"]').hover();
      const tooltip = page.locator('.schedule-tip');
      await tooltip.waitFor();
      check(
        'Held tooltip retains supplier ref and state',
        await tooltip
          .innerText()
          .then(
            (text) =>
              text.includes('MOCK-SIM-d1-lunch') && text.includes('held'),
          ),
      );
      await page.mouse.move(0, 0);
      await tooltip.waitFor({ state: 'hidden' });
    }
    await shot(page, size, 'holding', '#actions');
    await click(page, 'Simulate: the hotel cancels our room');
    t = await current(page);
    check(`${size}: repair_proposed`, t.phase === 'repair_proposed');
    check(
      `${size}: candidate contract includes checked itinerary and repriced`,
      t.repair.candidates.every(
        (candidate) =>
          Array.isArray(candidate.repriced) &&
          candidate.itinerary.totalCents === candidate.newTotalCents,
      ),
    );
    check(
      `${size}: compact move text`,
      await page
        .locator('.candidate-moves')
        .first()
        .innerText()
        .then((text) =>
          text.includes('Castle hill walk 17:15 → 17:40 (+25 min)'),
        ),
    );
    check(
      `${size}: travel explanation once per checked card`,
      await page
        .locator('.candidate:not(.rejected)')
        .evaluateAll((cards) =>
          cards.every(
            (card) => card.querySelectorAll('.travel-explanation').length === 1,
          ),
        ),
    );
    check(
      `${size}: repriced transfer displayed`,
      await page
        .locator('.candidate-repriced')
        .first()
        .innerText()
        .then((text) => text.includes('Airport car $30 → $32')),
    );
    check(
      `${size}: pick source named`,
      await page
        .locator('.pick-reason .source')
        .innerText()
        .then((text) => text === 'rule'),
    );
    check(
      `${size}: candidate columns`,
      (await page
        .locator('.candidate-grid')
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(' ').length,
        )) === (size === 'phone' ? 1 : 4),
    );
    if (size === 'phone') {
      for (const width of [639, 640, 390]) {
        await page.setViewportSize({ width, height });
        const columns = await page
          .locator('.candidate-grid')
          .evaluate(
            (element) =>
              getComputedStyle(element).gridTemplateColumns.split(' ').length,
          );
        check(
          `Candidate columns at ${width}px`,
          columns === (width < 640 ? 1 : 2),
        );
      }
    }
    const preview = await page.evaluate(async () => {
      const { api } = await import('/js/api.js');
      const { previewItems } = await import('/js/shared.js');
      const trip = await api.trip(
        new URL(location.href).searchParams.get('trip'),
      );
      const candidate = trip.repair.candidates.find(
        (candidate) => candidate.id === trip.repair.pickId,
      );
      return previewItems(trip, candidate.id).every((item, index) =>
        Object.entries(candidate.itinerary.items[index]).every(
          ([field, value]) => item[field] === value,
        ),
      );
    });
    check(`${size}: preview uses all checked itinerary fields`, preview);
    check(
      `${size}: two checked and two rejected`,
      t.repair.candidates.filter((c) => c.checks.ok).length === 2,
    );
    check(
      `${size}: cheaper hotel moves at least three stops`,
      t.repair.candidates.find((c) => c.hotelId === 'h-riocalmo').moves
        .length >= 3,
    );
    check(
      `${size}: ghosts present`,
      await page.locator('#schedule').evaluate(async element => {
        const { Widget } = await import('/vendor/bryntum/scheduler/scheduler.module.js');
        return Widget.fromElement(element.firstElementChild).eventStore.records.some(event => event.get('rrGhost'));
      }),
    );
    await shot(page, size, 'repair', '#repair-panel');
    await page.locator('[data-candidate="rio"]').click();
    check(
      `${size}: alternative preview`,
      (await page
        .locator('[data-candidate="rio"]')
        .getAttribute('aria-pressed')) === 'true',
    );
    await page.locator('[data-candidate="lumen"]').click();
    await click(page, 'Use Lumen Rooms');
    t = await current(page);
    check(
      `${size}: void then requote`,
      t.phase === 'requote' &&
        t.payments[0].state === 'voided' &&
        t.itinerary.version === 2,
    );
    await shot(page, size, 'requote', '#money-title');
    await click(page, 'Hold $474.00 with card (no sign in)');
    await click(page, 'Confirm bookings');
    t = await current(page);
    check(
      `${size}: confirmed_captured`,
      t.phase === 'confirmed_captured' &&
        t.payments.at(-1).state === 'captured',
    );
    await shot(page, size, 'captured', '#money-title');
    await click(page, 'Simulate: the operator cancels an activity');
    t = await current(page);
    check(
      `${size}: refund_pending`,
      t.phase === 'refund_pending' &&
        t.payments.at(-1).refunds[0].amountCents === 5800,
    );
    check(
      `${size}: cancellation and free replacement`,
      t.itinerary.items.some(
        (i) => i.offerId === 'a-tileclass' && i.state === 'cancelled',
      ) &&
        t.itinerary.items.some(
          (i) => i.offerId === 'a-graca' && i.priceCents === 0,
        ),
    );
    await shot(page, size, 'refund-pending', '#state-chips');
    await click(page, 'Check refund status');
    check(`${size}: refunded`, (await current(page)).phase === 'refunded');
    await shot(page, size, 'refunded', '#money-title');
    const receipt = await context.newPage();
    watch(receipt);
    await receipt.goto(
      new URL(await page.locator('#receipt-link').getAttribute('href'), origin)
        .href,
    );
    await receipt.getByText('MOCK-REFUND-58', { exact: true }).waitFor();
    check(
      `${size}: receipt operations`,
      (await receipt.locator('.receipt-operation').count()) === 6,
    );
    check(
      `${size}: no unmarked mock ids`,
      await receipt
        .locator('.receipt-ids dd')
        .evaluateAll((es) =>
          es
            .filter(
              (e) =>
                /id/i.test(e.previousElementSibling.textContent) &&
                e.textContent !== 'Not supplied',
            )
            .every((e) => e.textContent.startsWith('MOCK-')),
        ),
    );
    await receipt.screenshot({ path: `${out}/${size}-receipts.png` });
    report.shots.push(`${size}-receipts.png`);
    await receipt.close();
    await click(page, 'New trip');
    await click(page, 'Plan my two days');
    await click(page, 'Approve quote');
    await page.locator('.failure-paths summary').click();
    await click(page, 'Try a declined card');
    check(`${size}: declined`, (await current(page)).phase === 'declined');
    await shot(page, size, 'declined', '#state-chips');
    await click(page, 'Approve quote');
    await click(page, 'Try a lost payment response');
    check(
      `${size}: checking_payment`,
      (await current(page)).phase === 'checking_payment',
    );
    check(
      `${size}: further writes hidden`,
      (await page.locator('#pay-card').count()) === 0 &&
        (await page.locator('[data-action="confirm"]').count()) === 0,
    );
    await shot(page, size, 'checking-payment', '#state-chips');
    await click(page, 'Check payment');
    check(
      `${size}: reconciled authorization`,
      (await current(page)).phase === 'holding',
    );
    // Refresh retains the same browser mock trip and its receipts.
    const before = (await current(page)).id;
    await page.reload();
    await settled(page);
    check(`${size}: reload persistence`, (await current(page)).id === before);
    await click(page, 'New trip');
    await click(page, 'Watch a recorded run');
    check(
      `${size}: recorded read only`,
      (await page.locator('#recorded-banner').isVisible()) &&
        (await page.locator('#actions button').count()) === 0,
    );
    await shot(page, size, 'recorded', '#recorded-banner');
    check(`${size}: no API network calls in mock`, apiCalls === 0);
    await context.close();
  }
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    }),
    page = await context.newPage();
  watch(page);
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /^webgl/.test(type) ? null : get.call(this, type, ...args);
    };
  });
  await page.goto(`${origin}/?mock=1&schedule=basic`);
  await click(page, 'Plan my two days');
  check(
    'Forced basic timeline renders both days',
    (await page.locator('.day-row').count()) === 2,
  );
  check(
    'Reduced motion / no WebGL leaves usable map',
    (await page.locator('#globe canvas').count()) === 0,
  );
  await shot(page, 'phone', 'fallback', '#schedule');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => {
    const timeline = document.querySelector('.basic-scroll');
    return timeline.scrollWidth <= timeline.clientWidth + 1;
  });
  check('Basic fallback refits the full day on desktop', true);
  await page.setViewportSize({ width: 390, height: 844 });
  const edge = await page.evaluate(async () => {
    const { api } = await import('/js/api.js');
    const t = await api.create({ ceilingCents: 60000, tastes: [], note: '' });
    let refused = false;
    try {
      await api.confirm(t.id);
    } catch (e) {
      refused = e.code === 'STATE';
    }
    await api.quote(t.id);
    await api.fault();
    await api.card(t.id);
    let blocked = false;
    try {
      await api.card(t.id);
    } catch (e) {
      blocked = e.code === 'CHECKING_PAYMENT';
    }
    await api.reconcile(t.id);
    await api.hotelUnavailable(t.id);
    let rejected = false;
    try {
      await api.accept(t.id, 'terraco');
    } catch (e) {
      rejected = e.code === 'STATE';
    }
    const limited = await api.create({
      ceilingCents: 45000,
      tastes: [],
      note: '',
    });
    await api.quote(limited.id);
    await api.card(limited.id);
    const repair = await api.hotelUnavailable(limited.id);
    const tooLow = await api.create({
      ceilingCents: 30000,
      tastes: [],
      note: '',
    });
    return {
      refused,
      blocked,
      rejected,
      budgetPick: repair.repair.pickId === 'rio',
      ceilingBlocked:
        tooLow.next.length === 0 &&
        tooLow.issues.some((i) => i.code === 'CEILING'),
    };
  });
  check('Mock refuses out of order confirmation', edge.refused);
  check('Mock blocks writes during payment uncertainty', edge.blocked);
  check('Mock refuses rejected repair', edge.rejected);
  check(
    'Mock rule picks the checked hotel under a lower ceiling',
    edge.budgetPick,
  );
  check('Mock blocks quotes beyond ceiling', edge.ceilingBlocked);
  await page.goto(`${origin}/about.html`);
  check(
    'About page fits phone viewport',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await context.close();
  const noGL = await browser.newContext(),
    noGLPage = await noGL.newPage();
  watch(noGLPage);
  await noGLPage.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /^webgl/.test(type) ? null : get.call(this, type, ...args);
    };
  });
  await noGLPage.goto(`${origin}/?mock=1&schedule=basic`);
  await click(noGLPage, 'Plan my two days');
  check(
    'No WebGL with motion enabled falls back without throwing',
    (await noGLPage.locator('#globe canvas').count()) === 0,
  );
  await noGL.close();
  const noVendor = await browser.newContext({ reducedMotion: 'reduce' }),
    fallback = await noVendor.newPage();
  watch(fallback);
  await fallback.route(
    '**/vendor/bryntum/scheduler/scheduler.module.js',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: 'throw new Error("QA import unavailable");',
      }),
  );
  await fallback.goto(`${origin}/?mock=1`);
  await click(fallback, 'Plan my two days');
  check(
    'Failed Bryntum import selects basic fallback',
    (await fallback.locator('#schedule').getAttribute('data-view')) === 'basic',
  );
  await noVendor.close();
  // Test the network wrapper and SDK wiring against local scripted responses.
  // This proves client behavior, not a real sandbox transaction or server integration.
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (k) => memory.get(k) || null,
    setItem: (k, v) => memory.set(k, v),
  };
  const { request: mockRequest } = await import('../public/js/mock-api.js');
  const live = await browser.newContext({ reducedMotion: 'reduce' }),
    livePage = await live.newPage();
  watch(livePage);
  const network = [];
  let sdkUrl;
  await live.route('**/healthz', async (route) =>
    route.fulfill({ status: 200, json: await mockRequest('/healthz') }),
  );
  await live.route('**/api/**', async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname;
    network.push({ path, method: r.method(), body: r.postDataJSON() });
    try {
      const data =
        path === '/api/config'
          ? { ...(await mockRequest(path)), paypalClientId: 'QA-client' }
          : await mockRequest(path, r.method(), r.postDataJSON() || {});
      await route.fulfill({ status: 200, json: data });
    } catch (e) {
      await route.fulfill({
        status: e.status || 409,
        json: { error: e.code, message: e.message },
      });
    }
  });
  await live.route('https://www.sandbox.paypal.com/sdk/js?*', (route) => {
    sdkUrl = route.request().url();
    return route.fulfill({
      contentType: 'text/javascript',
      body: `window.paypal={Buttons(options){window.qaWallet=options;return {async render(slot){const b=document.createElement('button');b.textContent='QA PayPal wallet';b.onclick=async()=>{await options.onClick({}, {reject(){},resolve(){return true}});const orderID=await options.createOrder();await options.onApprove({orderID});};slot.append(b);}};}};`,
    });
  });
  await livePage.goto(origin);
  await click(livePage, 'Plan my two days');
  await click(livePage, 'Approve quote');
  await livePage.getByRole('button', { name: 'QA PayPal wallet' }).waitFor();
  await click(livePage, 'QA PayPal wallet');
  check(
    'SDK uses sandbox AUTHORIZE configuration',
    sdkUrl.includes('client-id=QA-client') &&
      sdkUrl.includes('intent=authorize') &&
      sdkUrl.includes('currency=USD') &&
      sdkUrl.includes('components=buttons'),
  );
  check(
    'Wallet createOrder uses pay/order',
    network.some((r) => r.path.endsWith('/pay/order') && r.method === 'POST'),
  );
  check(
    'Wallet approval sends only the order id',
    network.some(
      (r) =>
        r.path.endsWith('/pay/authorize') &&
        Object.keys(r.body).join() === 'orderId',
    ),
  );
  check(
    'Wallet authorized state shown',
    await livePage
      .locator('#state-chips')
      .innerText()
      .then((t) => t.includes('Authorized $426.00')),
  );
  const wrappers = await livePage.evaluate(async () => {
    const { api } = await import('/js/api.js');
    const health = await api.health();
    let failed = false;
    try {
      await api.trip('missing');
    } catch (e) {
      failed = e.code === 'NOT_FOUND' && e.status === 409;
    }
    return { health, failed };
  });
  check('Health wrapper parses JSON', wrappers.health.ok === true);
  check('API errors preserve server code and status', wrappers.failed);
  await live.close();
  const unavailable = await browser.newContext({reducedMotion: 'reduce'});
  const unavailablePage = await unavailable.newPage();
  watch(unavailablePage);
  await unavailable.route('**/api/config', route => route.fulfill({json: {paypalClientId: 'QA-unavailable'}}));
  await unavailable.route('**/api/trips', async route => route.fulfill({json: await mockRequest('/api/trips', 'POST', {})}));
  await unavailable.route('**/api/trips/*/quote', async route => route.fulfill({json: await mockRequest(new URL(route.request().url()).pathname, 'POST', {})}));
  await unavailable.route('https://www.sandbox.paypal.com/sdk/js?*', route => route.fulfill({contentType: 'text/javascript', body: '/* SDK unavailable */'}));
  await unavailablePage.goto(origin);
  await click(unavailablePage, 'Plan my two days');
  await click(unavailablePage, 'Approve quote');
  await unavailablePage.getByText('PayPal button unavailable, use the card button', {exact:true}).waitFor();
  check('PayPal failure keeps labelled wallet box and test card', await unavailablePage.locator('#pay-card').isVisible() && (await unavailablePage.locator('.paypal-box').innerText()).includes('Pay with PayPal'));
  await unavailable.close();
  check('Zero browser console or page errors' , report.errors.length === 0);
} finally {
  await browser.close();
  await writeFile(
    `${out}/verification.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(
    `${out}/index.html`,
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>J3 browser evidence</title><style>body{font:14px system-ui;background:#f7f4ee;margin:24px;color:#0e1b2c}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}img{max-width:100%;border:1px solid #bbb}h1{font-family:Georgia}a{color:#1d4e89}</style><h1>J3 browser evidence</h1><p>${report.checks.length} checks. ${report.errors.length} browser errors. Mock data only.</p><a href="verification.json">Verification report</a><section>${report.shots.map((s) => `<article><h2>${s.replace('.png', '')}</h2><a href="${s}"><img src="${s}" alt="${s}"></a></article>`).join('')}</section></html>`,
  );
}
console.log(
  JSON.stringify({
    checks: report.checks.length,
    errors: report.errors,
    shots: report.shots.length,
  }),
);
