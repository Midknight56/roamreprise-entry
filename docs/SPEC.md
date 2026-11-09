# RoamReprise build spec (6 Nov 2026)

Decision record and the detailed failure list live in the private planning notes.
This file freezes the destination, the fixtures, the state machines and the API contract. Every build step works from it.

## The product in one breath

A traveler picks what they enjoy, gets a 2 day plan in Lisbon, and holds the money with PayPal (authorize). Bookings go
to a clearly labelled **Simulated supplier** (local fixtures). The hotel fails. The agent proposes a checked
replacement. Bryntum Scheduler shows which items move and keeps the travel buffers. The money follows: the old hold is
voided, the new quote is authorized, everything is confirmed, then captured. Later a supplier cancels one activity
after capture: the slot is replanned and that amount is refunded. **The recovery is the centre, not plan generation.**

## Frozen facts

| Item | Value |
| --- | --- |
| City | Lisbon, Portugal |
| Days | Day 1 = Sat 13 Mar 2027, Day 2 = Sun 14 Mar 2027 (local time, Europe/Lisbon, UTC+0 in March) |
| Arrival | Own flight lands LIS 10:30 Day 1 (not booked here, shown as a marker) |
| Departure | Own flight leaves LIS 19:00 Day 2; traveler must reach the airport by 17:00 |
| Currency | USD, integer cents everywhere in code |
| Default tastes | `tile art`, `fado music`, `viewpoints`, `food markets` |
| Taste chips | tile art, fado music, viewpoints, food markets, contemporary art, street art, coffee, history, river walks, live music |
| Default ceiling | $600 (traveler can set $300 to $1,500) |
| Minimum slack | 10 minutes between arriving somewhere and the next item starting (`MIN_SLACK_MIN = 10`) |
| Supplier label | Every reservation, state and receipt line says `Simulated supplier`. Fake refs look like `SIM-7F3K2Q` |
| PayPal | Sandbox only, `https://api-m.sandbox.paypal.com`, one purchase unit, `intent: "AUTHORIZE"` |
| custom_id | `rr-<tripId>-v<quoteVersion>` on orders, `rr-<tripId>-r<n>` on refunds. Webhooks without the `rr-` prefix are ignored (other apps share the sandbox app) |
| Palette | azulejo blue `#1D4E89`, ink `#0E1B2C`, tile white `#F7F4EE`, terracotta `#C65A3A`, sun `#E8B04B`, confirmed green `#3F7D5C`, failed red `#B8322A`, provisional stripes of blue on white. Signature touch: an original tile pattern strip (CSS gradients) on the header and the receipt edge |

## Places (real public places, coordinates WGS84)

Places are real public landmarks used only for geography. Every bookable offer at them is fictional and simulated.

| id | name | lat | lon | area |
| --- | --- | --- | --- | --- |
| lis | Lisbon Airport (LIS) | 38.7742 | -9.1342 | Airport |
| alfama | Alfama, Largo de Santa Luzia | 38.7116 | -9.1300 | Alfama |
| castle | Castelo de São Jorge | 38.7139 | -9.1335 | Alfama |
| graca | Miradouro da Senhora do Monte | 38.7193 | -9.1327 | Graça |
| tilemuseum | National Tile Museum | 38.7247 | -9.1135 | Xabregas |
| ribeira | Mercado da Ribeira | 38.7069 | -9.1459 | Cais do Sodré |
| chiado | Chiado, Largo do Camões | 38.7107 | -9.1436 | Chiado |
| bairroalto | Bairro Alto | 38.7135 | -9.1460 | Bairro Alto |
| comercio | Praça do Comércio | 38.7076 | -9.1365 | Baixa |
| principe | Príncipe Real | 38.7166 | -9.1488 | Príncipe Real |
| lxf | LX Factory, Alcântara | 38.7034 | -9.1784 | Alcântara |
| maat | MAAT riverside | 38.6957 | -9.1937 | Belém |
| jeronimos | Jerónimos Monastery | 38.6979 | -9.2068 | Belém |
| belemtower | Belém Tower | 38.6916 | -9.2160 | Belém |
| gulbenkian | Gulbenkian Garden | 38.7375 | -9.1545 | Avenidas Novas |
| avenida | Avenida da Liberdade | 38.7197 | -9.1452 | Avenida |

## Travel time (code, deterministic)

`travelMinutes(a, b)`: haversine distance d in km.
- d <= 1.2: walk, `ceil5(d * 13)` minutes, $0.
- d <= 4.5: tram or metro, `ceil5(6 + d * 4)` minutes, $2.
- otherwise taxi, `ceil5(8 + d * 2.6)` minutes, `round(400 + d * 160)` cents.
`ceil5` rounds up to the next multiple of 5, minimum 5. Same place: 0 minutes.
The travel time before an item is its **buffer** (Bryntum EventBuffer `preamble`). Rule: `item.start >= prev.end +
travelMinutes(prev.place, item.place) + MIN_SLACK_MIN`. Local moves are not booked; their cost is shown but not
charged. Airport transfers are booked items (Simulated supplier car, fixed prices below).

## Offers (fixtures, all `Simulated supplier`)

Hotels (one night, 13 to 14 Mar). Check-in from 15:00, check-out by 11:00, bags held at the desk from arrival.

| id | name | place | price | availability | role in demo |
| --- | --- | --- | --- | --- | --- |
| h-patio | Casa do Pátio rooms | alfama | $168 | held, then FAILS when "Simulate: the hotel cancels our room" is pressed | the original pick for the default tastes |
| h-lumen | Lumen Rooms | chiado | $214 | available | checked replacement, fewer moves, costs more |
| h-riocalmo | Rio Calmo Inn | maat | $142 | available | checked replacement, cheaper, more moves |
| h-terraco | Terraço Hostel | graca | $96 | NO rooms for 13 Mar | shown as rejected by the check ("no rooms that night") |
| h-avenida | Avenida Grand | avenida | $398 | available | rejected by the check when the new total passes the ceiling |

Airport transfers (car): `t-arrive` LIS to hotel, `t-depart` hotel or last stop to LIS. Price = taxi formula above
plus $14 meet and greet, rounded to whole dollars. Duration = travel minutes.

Activities and meals (`days` lists the days the offer runs, 0 = Day 1, 1 = Day 2):

| id | kind | name | place | price | minutes | opens | closes | days | tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a-tileclass | activity | Tile painting class | tilemuseum | $58 | 120 | 10:00 | 17:00 | 0,1 | tile art, history |
| a-tilemuseum | activity | National Tile Museum visit | tilemuseum | $8 | 90 | 10:00 | 18:00 | 0,1 | tile art, history |
| a-castle | activity | Castle hill walk | castle | $15 | 90 | 09:00 | 21:00 | 0,1 | viewpoints, history |
| a-graca | activity | Senhora do Monte viewpoint walk | graca | $0 | 60 | 07:00 | 23:00 | 0,1 | viewpoints |
| a-streetart | activity | Alcântara street art walk | lxf | $28 | 120 | 10:00 | 18:00 | 0,1 | street art, contemporary art |
| a-maat | activity | MAAT riverside galleries | maat | $12 | 90 | 10:00 | 19:00 | 0,1 | contemporary art, river walks |
| a-jeronimos | activity | Jerónimos cloister tour | jeronimos | $18 | 75 | 09:30 | 18:00 | 0,1 | history |
| a-tower | activity | Belém river walk | belemtower | $0 | 60 | 08:00 | 20:00 | 0,1 | river walks, viewpoints |
| a-gulbenkian | activity | Gulbenkian garden and collection | gulbenkian | $15 | 120 | 10:00 | 18:00 | 0 | contemporary art, history |
| a-jazz | activity | Bairro Alto jazz cellar | bairroalto | $22 | 120 | 21:00 | 23:59 | 0,1 | live music |
| m-ribeira | meal | Market hall lunch | ribeira | $24 | 75 | 10:00 | 23:00 | 0,1 | food markets |
| m-coffee | meal | Roastery brunch | principe | $19 | 60 | 08:00 | 16:00 | 0,1 | coffee |
| m-chiado | meal | Chiado bistro lunch | chiado | $31 | 75 | 12:00 | 15:30 | 0,1 | food markets |
| m-fado | meal | Fado dinner in Alfama | alfama | $74 | 150 | 19:30 | 23:30 | 0,1 | fado music, live music |
| m-riverside | meal | Riverside seafood dinner | comercio | $56 | 120 | 19:00 | 23:00 | 0,1 | food markets |

## Itinerary skeleton (slots)

Planner fills slots in order. Each slot has a kind and a target start; the real start is the later of the target and
the buffer rule. Slot ids are stable.

| slot | day | kind | target start | notes |
| --- | --- | --- | --- | --- |
| d1-arrive | 0 | transfer | 10:45 | `t-arrive`, LIS to hotel (bags dropped at the desk) |
| d1-lunch | 0 | meal | 12:30 | |
| d1-pm | 0 | activity | 14:15 | |
| d1-checkin | 0 | lodging | 16:30 | hotel check-in, 20 minutes; the stay item runs from check-in to Day 2 check-out |
| d1-late | 0 | activity | 17:15 | optional; dropped (with a log line) if it cannot fit before dinner |
| d1-dinner | 0 | meal | 20:00 | |
| d2-checkout | 1 | lodging | 09:00 | check-out, 15 minutes, bags held at the desk |
| d2-am | 1 | activity | 09:45 | |
| d2-lunch | 1 | meal | 12:45 | |
| d2-pm | 1 | activity | 14:15 | |
| d2-depart | 1 | transfer | 16:00 latest | `t-depart`, from the hotel (bags) to LIS, must arrive by 17:00. Starts at `17:00 - duration` at the latest; if Day 2 pm cannot end in time, the pm item is swapped for a nearer one or dropped |

The stay is ONE booked item (`h-*`, price per night), shown on the scheduler as check-in and check-out events tied to
it. Default tastes must produce: d1-lunch m-ribeira, d1-pm a-tilemuseum or a-castle, d1-dinner m-fado, d2-am
a-tileclass, plus Casa do Pátio. Total for the default plan must sit between $380 and $520.

## Checks (`validateSchedule`), every one with its own code

`BUFFER` (buffer rule above), `OVERLAP`, `OPEN_HOURS`, `DAY_WINDOW` (Day 1 nothing before 10:30 plus the arrival
transfer; Day 2 at LIS by 17:00), `CHECKIN` (check-in at or after 15:00, check-out at or before 11:00), `PRICE_MATCH`
(every item price equals its fixture price; the model never supplies a price), `CEILING` (total <= ceiling),
`DAYS` (offer runs that day), `DUPLICATE` (one offer once per trip), `STATE` (only permitted reservation states).
Output: `{ ok: boolean, issues: { code, itemId?, message }[] }`. Messages are plain short English.

## Repair (`repairFailedLeg`)

Input: itinerary, failed item id, ceiling. For the hotel: every other hotel becomes a candidate. For each candidate
the code rebuilds the times of the affected items (the arrival transfer and price, check-in, the items around it, the
Day 2 check-out and first item, the departure transfer), keeps every buffer, and runs `validateSchedule`.
Each candidate gets: `{ id, hotelId, name, area, priceDeltaCents, newTotalCents, moves: { itemId, name, fromStart,
toStart, fromEnd, toEnd, reason }[], dropped: itemId[], checks: { ok, issues } }`. Only candidates with `checks.ok`
can be picked. The AI picks one of the checked ids with a reason of at most 30 words; if the AI is not available, the
rule pick is the checked candidate with the lowest new total, then the fewest moves, then the lowest id. With the default plan:
h-terraco fails (no rooms), h-avenida fails CEILING at a $600 ceiling, h-lumen and h-riocalmo pass, and h-riocalmo
moves at least 3 items.

Activity cancellation after capture (`replanSlot`): the cancelled item's slot is refilled with the best checked offer
that costs $0 or less than the cancelled one and fits the buffers; the refund is the cancelled item's price (minus the
replacement price if it is not free). Default: a-tileclass ($58) is cancelled, a-graca ($0) replaces it, refund $58.

## Reservation states (Simulated supplier)

`planned -> held -> confirmed`; `held -> failed` (supplier says no); `held -> released` (we let it go);
`confirmed -> cancelled` (supplier cancels after capture); an item replaced by repair becomes `replaced`.
Anything else is refused with code `STATE`.

## Payment states (one attempt per approved quote version)

```
none -> order_created -> authorized -> capturing -> captured -> (refunds)
                     \-> declined     \-> voiding -> voided
                                       \-> expired
any write -> unknown ("Checking payment") -> reconciled to the state PayPal reports
```
Rules, all enforced in code and covered by tests:
1. Capture only when every booked item is `confirmed`, the attempt is `authorized`, the amount equals the quote total,
   and the authorization is not expired. `final_capture: true`.
2. Void only before capture. A changed itinerary never reuses an old approval: it voids the old authorization and
   needs a new quote and a new authorization.
3. Refund only after capture, never more than captured minus refunded, tied to a cancelled item. A refund is
   `pending` until PayPal says `COMPLETED`; the itinerary repair never implies the refund is done.
4. While any attempt of a trip is `unknown`, every PayPal write for that trip is refused (`CHECKING_PAYMENT`) until a
   reconcile read settles it. A lost authorize response is settled by reading the order, never by a second hold.
5. Every write stores `{ op, requestId, body }` in the trip's Durable Object BEFORE it is sent and reuses the same
   `PayPal-Request-Id` and body on a retry. Writes for one trip are serialized inside its Durable Object.
6. The browser never supplies an amount, a recipient or a PayPal id for a write; the server reads them from its own
   stored quote. Model text never reaches a payment field.

Declined (real sandbox failure): the card path with `declineTest: true` sends `PayPal-Mock-Response:
{"mock_application_codes":"INSTRUMENT_DECLINED"}` on the separate order authorize call. Measured 6 Nov 2026: answers 422
`UNPROCESSABLE_ENTITY` issue `INSTRUMENT_DECLINED`. The trip then releases every hold and confirms nothing.

Measured the same day on the shared sandbox app: `POST /v2/checkout/orders` with `intent AUTHORIZE` and a
`payment_source.card` (PayPal's published test Visa 4111 1111 1111 1111) answers 201 `COMPLETED` with
`purchase_units[0].payments.authorizations[0]` status `CREATED`; void 200 then GET reads `VOIDED`; capture with
`final_capture: true` 201 `COMPLETED`; partial refund 201 `COMPLETED`. A wallet order with no payment source answers
201 `CREATED` (needs buyer approval through the PayPal button).

## Two ways to pay (both live sandbox)

1. **Sandbox test card, no sign in** (the judge's 60 second path): create without a payment source, then authorize that stored order with `payment_source.card`. Each step stores its own request id before sending. Lost create replies replay the same create; lost authorize replies only read the order, never repeat authorize. An order read without an authorization leaves Checking payment and its Check payment button in place.
2. **PayPal button** (JS SDK, `intent=authorize`, sandbox client id): buyer logs in with the sandbox buyer from the
   README, server authorizes with `POST /v2/checkout/orders/{id}/authorize`.

## AI (Workers AI, bounded, fail closed)

Model `@cf/ibm-granite/granite-4.0-h-micro` (function calling yes, 131,000 token context, NO "Planned Deprecation"
line on its model page, read live 6 Nov 2026). Llama 3.2 3B and Qwen3 30B are NOT used: their pages say "Planned
Deprecation 11/20/2026", before judging (1 to 15 Dec). Price (Cloudflare pricing page, read live 6 Nov 2026): $0.017
per M input tokens = 1,542 neurons per M; $0.112 per M output tokens = 10,158 neurons per M; free day 10,000 neurons
per account, "$0.011 per 1,000 Neurons" only on the paid plan above that. Input capped at 16,000 characters (4,000
tokens), output at 512 tokens: `4,000 x 1,542 / 1,000,000 + 512 x 10,158 / 1,000,000 = 6.17 + 5.20 = 11.37` neurons
worst case, so **15 are reserved before each call** in the shared D1 ledger `hackathon-ledger.ai_calls` (app
`roamreprise`), then settled to the real figure. App cap **900 a day** (60 calls = 30 full trips), account guard 9,500
of the free 10,000. A ledger refusal or error means NO call: the step uses the rule pick (or the recorded answer for
the default tastes) and is labelled so. A unit test fails if `MODEL_ID` is in `DEPRECATED_MODELS` (the two ids above),
and `dev/check_model.mjs` (run before every deploy by `dev/cf.py deploy`) fetches the model page and stops the deploy
if it shows "Planned Deprecation".
Two calls per trip at most: `propose_itinerary` (pick one offer id per slot from at most 4 checked candidates each,
plus a 12 word why per slot) and `repair_failed_leg` (pick one checked candidate id, reason <= 30 words). Answers must
be JSON; ids not in the candidate list are dropped and the rule pick fills the slot. The propose answer is cached per
(tastes, note) for 24 hours; a cached answer is labelled "cached live answer from HH:MM UTC".

## Caps (free visitor = $0, arithmetic beside each constant in `src/caps.ts`)

Trips per browser per UTC day 12; trips per day 400; PayPal writes per trip 30; PayPal writes per day 800; AI as
above; note text 280 characters. PayPal sandbox costs $0. Durable Objects and D1 on the free plan fail with an error
past their free daily rows, never bill (see Circlekeeper's caps.ts for the cited figures to copy).

## Sessions and ownership

Cookie `rr_sid` (random, HttpOnly, SameSite=Lax, Secure on https). A trip stores its sid; every trip route answers 403
`NOT_YOUR_TRIP` for another sid. Trip ids are 16 random base32 characters.

## API contract

All JSON. Errors: `{ error: CODE, message }` with a 4xx status.

| Method and path | Body | Answer |
| --- | --- | --- |
| GET /healthz | | `{ ok: true, build }` |
| GET /api/config | | `{ paypalClientId, build, liveAi, aiLeftToday, recordedRunDate }` |
| POST /api/trips | `{ tastes: string[], note: string, ceilingCents: number }` | TripView |
| GET /api/trips/:id | | TripView |
| POST /api/trips/:id/quote | | TripView (current version approved as the quote) |
| POST /api/trips/:id/pay/card | `{ declineTest?: boolean }` | TripView |
| POST /api/trips/:id/pay/order | | `{ orderId }` (wallet order for the PayPal button) |
| POST /api/trips/:id/pay/authorize | `{ orderId }` | TripView (orderId must match the stored one) |
| POST /api/trips/:id/reserve | | TripView (holds every booked item) |
| POST /api/trips/:id/supplier/hotel-unavailable | | TripView (hotel failed, repair proposal with candidates and pick) |
| POST /api/trips/:id/repair/accept | `{ candidateId }` | TripView (releases holds, voids the old authorization, new version and quote awaiting payment) |
| POST /api/trips/:id/confirm | | TripView (confirms holds, then captures) |
| POST /api/trips/:id/supplier/cancel-activity | | TripView (after capture: replans the slot, requests the partial refund) |
| POST /api/trips/:id/reconcile | | TripView (reads PayPal, settles `unknown`) |
| POST /webhooks/paypal | PayPal event | 200 after signature verify, 400 otherwise |
| GET /api/recorded | | the recorded run JSON |
| POST /api/trips/:id/dev/fault (DEV_ROUTES=1 only) | `{ kind: "lose_next_response" \| "expire_authorization" }` | `{ ok }`; drop the next PayPal write response, or treat the next authorization read as EXPIRED |
| POST /api/dev/record-ai (DEV_ROUTES=1 only) | Default trip request | `{ propose, repair, capturedAt }`; two capped live AI answers for the recording tool, no PayPal write |

TripView:
```ts
{
  id, phase, ceilingCents, tastes, note,
  itinerary: { version, hotelId, totalCents, items: Item[] },
  previous?: { version, items: Item[] },            // shown as ghosts during a repair preview
  repair?: { failedItemId, candidates: Candidate[], pickId, pickReason, pickSource: "live"|"cached"|"recorded"|"rule" },
  quote?: { version, totalCents, approvedAt },
  payments: PaymentAttempt[],
  log: AgentStep[],
  issues: { code, itemId?, message }[],
  next: string[]                                     // the actions the UI may offer now, e.g. ["pay", "hotel-unavailable"]
}
Item = { id, offerId, slot, kind: "lodging"|"transfer"|"activity"|"meal", name, placeId, day: 0|1, start: "HH:MM",
         end: "HH:MM", bufferMin, travelMode: "walk"|"metro"|"taxi"|"car"|"none", priceCents, booked: boolean,
         state: "planned"|"held"|"confirmed"|"failed"|"released"|"cancelled"|"replaced", supplierRef?, why? }
PaymentAttempt = { quoteVersion, amountCents, method: "card"|"paypal", state, orderId?, authorizationId?, captureId?,
         expiresAt?, refunds: { id?, amountCents, state: "pending"|"completed"|"failed"|"unknown", reason }[],
         receipts: { op, method, path, status, paypalStatus?, debugId?, requestId?, at }[] }
AgentStep = { tool: "read_trip_request"|"find_options"|"validate_schedule"|"propose_itinerary"|
         "reserve_demo_inventory"|"repair_failed_leg"|"replan_slot"|"paypal", at, summary, source?, neurons? }
```
Phases: `planned`, `quoted`, `authorized`, `holding`, `repair_proposed`, `requote`, `confirmed_captured`,
`refund_pending`, `refunded`, `declined`, `checking_payment`.

## Screens (every one photographed at 1280x800 and 390x844)

1. Plan: taste chips, one sentence, ceiling, "Plan my two days". A link "Watch a recorded run" (only when the static `/data/recorded-run.json` exists) and "How this works". Playback uses saved TripView snapshots with no API or PayPal calls. `node dev/record_run.mjs` captures a run against an explicit `RR_BASE` after deploy; it removes sessions and cookies before saving. The separate `/api/recorded` endpoint contains AI answers, not viewer snapshots.
2. Globe: three.js dotted globe (Natural Earth 110m land, public domain, bundled in `public/data/`) flies from the
   Atlantic to Lisbon, pins rise, then it resolves into the city route map and the Bryntum Scheduler.
3. Itinerary: route map (two day colours), Scheduler (rows Day 1 and Day 2, 08:00 to 23:59, buffers drawn, dependencies
   between consecutive items), agent log, price list with "Simulated supplier" on every booked line.
4. Hold: "Hold $X with PayPal" with the two pay buttons and a "Try a declined card" link.
5. Holding: every booked item `held` (Simulated supplier refs), buttons "Confirm bookings" and "Simulate: the hotel cancels our room".
6. Repair preview: the failed hotel red, candidates with price change, moves and check results (rejected ones with
   their reason), the pick and its reason with its source label, Scheduler shows ghosts of old times and striped new
   times, route map redraws. "Accept repair".
7. Money follows: old authorization voided (receipt), new quote, pay again, holds, confirm, captured (receipt).
8. After capture: "Simulate: the operator cancels an activity" replans the slot and shows the refund pending, then completed.
9. Receipt page `/receipt.html?trip=<id>`: every PayPal operation with ids, statuses, request ids, debug ids, times.
10. Declined and Checking payment states. The recorded run viewer, labelled "Recorded run, captured <date>. No PayPal
    request is sent."
