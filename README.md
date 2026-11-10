# RoamReprise

A prototype for a small tour operator who sells a Lisbon weekend as one package with one PayPal payment. When a
simulated supplier fails, it proposes a checked replacement, and once the traveler approves, the payment follows:
void before capture, capture when every booking is confirmed, partial refund after capture. Suppliers are simulated;
payments are real PayPal sandbox calls with test money.

Try it: https://roamreprise.midknight-labs.workers.dev (free, no sign in).

## Judging criteria at a glance

**Technological Implementation.** PayPal Orders v2 (create with AUTHORIZE, authorize), Payments v2 (capture, void, refund, and a read for each) and verified Webhooks. Every write carries a PayPal-Request-Id stored before the call. AI: IBM Granite 4.0 H Micro on Workers AI picks among options the code has already checked. Code owns every time, price and state.

**Design.** A globe flies in and becomes the itinerary on a Bryntum Scheduler. A five step strip shows what the traveler allows, what the agent proposes, what PayPal holds, what was captured and what was refunded. Each replacement card leads with its new total and what it drops.

**Potential Impact.** For a small tour operator selling a weekend as one package. When a supplier cancels, the plan and the one payment must change together, and today that is a phone call, a spreadsheet and a refund form.

**Innovation/Idea.** The money follows the repaired plan: void the old hold, authorize the approved new total, capture only when every booking is confirmed, refund what a supplier cancels. Six repair and payment cases in docs/SCENARIOS.md are each reproduced by a test.

**Presentation.** The video runs 2 minutes 47 seconds. Try it at https://roamreprise.midknight-labs.workers.dev. The receipt shows the recorded run in one line: $428.00 released and never charged, $397.00 captured, $50.00 refunded, $347.00 net charged.

## For judges

The 60 second path, with no login:

1. Open the site. Under "If a booking falls through, protect", keep **Lowest total** (or pick **My activities**).
   Press **Plan my two days**. A globe flies into Lisbon and becomes a two day plan on a Bryntum
   Scheduler, with the estimated travel time between stops drawn as buffers.
2. Optional: under the Scheduler, press **Make Sunday morning slower**, then **Ask the agent**. The Sunday stops
   slide and the quote asks for approval again. You have two changes per trip, before or during a hold, before capture. After a hold, a checked change voids the old authorization. Hold the new total to continue.
3. Press **Approve quote**, then **Hold $428.00 with sandbox test card (no sign in)** (the amount is your current
   total; $428.00 for the default plan with no changes). This is a real PayPal sandbox
   authorization. Its ids are on the money panel and the receipt page.
4. Press **Simulate: the hotel cancels our room**. The hotel turns red. The agent lists the other hotels with the result of every check
   (no rooms in the simulated inventory, over the ceiling, estimated travel times), the activities each one drops, the
   stops that move, and its pick.
5. Press **Use** on the picked hotel (with Lowest total it is Rio Calmo Inn, which drops the castle walk; with My
   activities it is Lumen Rooms, which keeps it). The old authorization is **voided**. Hold the new total, then **Confirm bookings**: every booking is
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
| AI | Workers AI, IBM Granite 4.0 H Micro, within a daily cap. Without a live answer the step is labelled: cached answer, recorded answer (default trip only) or rule pick |

## What it does

- **Plan.** You pick tastes and a budget ceiling. The code ranks options and the AI picks among them. The code checks
  every time, travel buffer, opening hour, price and the ceiling. The AI never sets a price or a payment field.
- **Hold.** PayPal authorizes the quote (`intent: AUTHORIZE`, one purchase unit). Bookings are held, not confirmed.
- **Repair.** When the hotel fails, every other hotel is checked. The Scheduler shows the old times as ghosts and the
  moved stops, and keeps the estimated travel buffers. The traveler chose earlier what a repair protects: the lowest
  total, or every activity. Nothing changes until they accept.
- **Money follows.** A changed trip never reuses the old approval: the old authorization is voided and the new total is
  authorized. Capture uses `final_capture: true` and only runs when every booking is confirmed. A supplier cancellation
  after capture becomes a partial refund, shown as pending until PayPal says it is completed.
- **Payment safety.** Every write stores its PayPal-Request-Id and body before it is sent and reuses both on a retry.
  If an answer is lost, the trip shows "Checking payment", refuses every other write, and reads PayPal to settle it.
  A lost authorize answer is settled by reading the order, never by a second hold. Writes for one trip run one at a
  time inside its Durable Object. Webhooks are verified, stored once, and never move a state backwards.

Six repair and payment cases, each reproduced by a test: [docs/SCENARIOS.md](docs/SCENARIOS.md).

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
