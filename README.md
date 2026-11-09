# RoamReprise

Plan a weekend around what you enjoy, hold the money with PayPal, and repair the plan when a booking falls through.
The money follows the plan: void before capture, capture when every booking is confirmed, refund after capture.

Try it: https://roamreprise.midknight-labs.workers.dev (free, no sign in).

## For judges

The 60 second path, with no login:

1. Open the site and press **Plan my two days**. A globe flies into Lisbon and becomes a two day plan on a Bryntum
   Scheduler, with the travel time between stops drawn as buffers.
2. Optional: under the Scheduler, press **Make Sunday morning slower**, then **Ask the agent**. The Sunday stops
   slide and the quote asks for approval again. You have two changes per trip, before or during a hold, before capture. After a hold, a checked change voids the old authorization. Hold the new total to continue.
3. Press **Approve quote**, then **Hold $428.00 with sandbox test card (no sign in)** (the amount is your current
   total; $428.00 for the default plan with no changes). This is a real PayPal sandbox
   authorization. Its ids are on the money panel and the receipt page.
4. Press **Simulate: the hotel cancels our room**. The hotel turns red. The agent lists the other hotels with the result of every check
   (no rooms, over budget, buffers kept), the stops that move, and its pick.
5. Press **Use** on the picked hotel (the AI may pick Lumen Rooms or Rio Calmo Inn). The old authorization is **voided**. Hold the new total, then **Confirm bookings**: every booking is
   confirmed and the payment is **captured**.
6. Press **Simulate: the operator cancels an activity**. The slot is replanned and the computed price difference is **refunded** (a partial refund).
7. Open **All receipts** to see every PayPal call: path, HTTP status, PayPal status, ids, request id and debug id.

Also open **For judges: failure paths** and press **Try a declined card** (a real sandbox decline through PayPal's negative testing header).

Pay with the PayPal button instead (sandbox buyer login, test money only):

<!-- judge-login -->
- Email: `sb-bzdbn21339224@personal.example.com`
- Password: `!_B%e5W%`
<!-- /judge-login -->

What is real and what is simulated:

| Part | Real or simulated |
| --- | --- |
| PayPal calls | Real, PayPal sandbox (test money): Orders v2 create and authorize, Payments v2 capture, void, refund and reads, webhooks with signature verification |
| Hotels, transfers, activities | **Simulated supplier**: local fixtures, labelled on every booking and receipt. No real booking is made |
| Places | Real public places in Lisbon, used for geography only |
| AI | Workers AI, IBM Granite 4.0 H Micro, within a daily cap. When the cap is used up, the step says "rule pick" |

## What it does

- **Plan.** You pick tastes and a budget ceiling. The code ranks options and the AI picks among them. The code checks
  every time, travel buffer, opening hour, price and the ceiling. The AI never sets a price or a payment field.
- **Hold.** PayPal authorizes the quote (`intent: AUTHORIZE`, one purchase unit). Bookings are held, not confirmed.
- **Repair.** When the hotel fails, every other hotel is checked. The Scheduler shows the old times as ghosts and the
  moved stops, and keeps every buffer.
- **Money follows.** A changed trip never reuses the old approval: the old authorization is voided and the new total is
  authorized. Capture uses `final_capture: true` and only runs when every booking is confirmed. A supplier cancellation
  after capture becomes a partial refund, shown as pending until PayPal says it is completed.
- **Payment safety.** Every write stores its PayPal-Request-Id and body before it is sent and reuses both on a retry.
  If an answer is lost, the trip shows "Checking payment", refuses every other write, and reads PayPal to settle it.
  A lost authorize answer is settled by reading the order, never by a second hold. Writes for one trip run one at a
  time inside its Durable Object. Webhooks are verified, stored once, and never move a state backwards.

## How it is built

| Piece | Where |
| --- | --- |
| Worker and routes | `src/worker.ts` |
| Trip engine (one Durable Object per trip) | `src/trip/` |
| Daily caps and cache (one Durable Object) | `src/gate/`, `src/caps.ts` |
| PayPal client, payments, webhooks | `src/paypal/` |
| Workers AI with a shared neuron ledger | `src/ai/` |
| Fixtures, checks, planner, repair, money rules | `src/domain/` |
| Browser app (globe, route map, Scheduler, money panel) | `public/` |
| Spec | `docs/SPEC.md` |

## Cost guard

A visitor never costs money. PayPal sandbox calls are free. Workers AI is capped at 900 neurons a day for this app,
with 15 reserved before each call in a shared D1 ledger; the arithmetic is beside each constant in `src/caps.ts`. A
refused reservation means no AI call.

## Run it yourself

Needs Node 22 or later, Python 3, a Cloudflare account and a PayPal sandbox REST app.

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

Fill in your account id and a D1 database id (create the table with `dev/ledger.sql`). Put `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` in `.dev.vars` for local runs, or as Worker secrets for a deploy.

```bash
python dev/vendor.py
npx wrangler dev
```

Tests:

```bash
npm test
npm run typecheck
```

## Third party parts

- Bryntum Scheduler, trial build (`@bryntum/scheduler-trial`), under Bryntum's own trial licence. It is installed from
  npm and copied into `public/vendor/` at build time; it is not in this repository. The trial watermark is kept.
- three.js (MIT), installed from npm.
- Natural Earth 1:110m land (public domain), `public/data/ne_110m_land.geojson`.

## Licence

MIT, see `LICENSE`. Third party parts keep their own licences.
