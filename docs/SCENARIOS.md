# Repair and payment scenarios

Each row below is produced by `tests/domain/scenarios.test.ts`, which runs the real trip engine with simulated
suppliers and a fake PayPal sandbox (the live site uses the real PayPal sandbox). Every case starts from the same
recorded plan ($428.00 for a Lisbon weekend) and uses the rule pick for the repair. Amounts are US dollars, test money.

A voided or expired hold is never counted as a refund or a saving: "Net charged" is completed captures minus
completed refunds.

<!-- scenarios:start -->
| # | Case | Repair choice | Ceiling | Plan total | Replacement (rule pick) | Activities removed | Stops moved | Schedule check | Released, never charged | Captures | Refunded | Net charged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Hotel fails | Lowest total | $600.00 | $428.00 | Rio Calmo Inn, $397.00 | Castle hill walk | 2 (20 min) | passed; rejected: Terraço Hostel: AVAILABILITY, Avenida Grand: CEILING | $428.00 | 1 ($397.00) | $0.00 | $397.00 |
| 2 | Hotel fails, tighter ceiling | Lowest total | $450.00 | $428.00 | Rio Calmo Inn, $397.00 | Castle hill walk | 2 (20 min) | passed; rejected: Lumen Rooms: CEILING, Terraço Hostel: AVAILABILITY, Avenida Grand: CEILING | $428.00 | 1 ($397.00) | $0.00 | $397.00 |
| 3 | Hotel fails, keep activities | My activities | $600.00 | $428.00 | Lumen Rooms, $474.00 | none | 1 (5 min) | passed; rejected: Rio Calmo Inn: POLICY, Terraço Hostel: AVAILABILITY, Avenida Grand: CEILING | $428.00 | 1 ($474.00) | $0.00 | $474.00 |
| 4 | No acceptable replacement | My activities | $450.00 | $428.00 | none fits | none | 0 | Lumen Rooms: CEILING; Rio Calmo Inn: POLICY; Terraço Hostel: AVAILABILITY; Avenida Grand: CEILING | $0.00 | 0 ($0.00) | $0.00 | $0.00 |
| 5 | Capture response lost | Lowest total | $600.00 | $428.00 | none (no failure) | none | 0 | passed | $0.00 | 1 ($428.00) | $0.00 | $428.00 |
| 6 | Activity cancelled after capture | Lowest total | $600.00 | $428.00 | Rio Calmo Inn, $397.00 | Castle hill walk | 2 (20 min) | passed; rejected: Terraço Hostel: AVAILABILITY, Avenida Grand: CEILING | $428.00 | 1 ($397.00) | $50.00 | $347.00 |
<!-- scenarios:end -->

In case 4 no hotel meets the request, so nothing is changed or captured. The $428.00 authorization stays open and
unused; PayPal lets it expire. In case 5 the capture answer is lost on the way back; the app reads PayPal, finds the
capture, and never sends a second one.

To refresh the table after a change: `npx vitest run tests/domain/scenarios.test.ts`. When the table differs, the test
fails and prints the new table; paste it between the markers.
