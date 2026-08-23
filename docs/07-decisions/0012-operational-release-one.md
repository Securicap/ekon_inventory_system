# 12. OR1 is the production-readiness milestone, and staging's launch invariant is not it

**Status:** Accepted — 2026-08-23

## Context

Hosted staging passed its launch invariant: an owner bootstraps, signs in,
creates employee accounts and the first product; an employee receives it, sees
its stock and location, removes it, and signs out — all through supported
workflows, with no API call, SQL statement, or shell command in the sequence.
That was performed against a real hosted environment and it is recorded in
`docs/06-operations/deployment.md`.

It is easy to read that as "ready", and it is not. It proved the **earlier**
operating loop — the stock-counter product model — against a real deployment. It
says nothing about the merchandise and inventory operations product decided in
ADR 11, which does not exist yet. Meanwhile "production" has been the word used
for two different things: a host that is running, and a system a business has
put its records into.

There is a second problem with leaving this undefined. The moment a shop starts
recording its real stock, the database stops being disposable. Every later
migration has to preserve what is in it. Without a named line, nobody knows
which side of it they are on.

## Decision

**OR1 — Ekon Operational Release 1 — is the milestone at which Ekon is safe and
useful enough to become the store's real day-to-day inventory system, while
development continues.**

It is not feature completeness and it is not 1.0. It is the point at which the
shop stops keeping its stock somewhere else.

**The staging launch invariant is explicitly not OR1.** It stands as the tested
staging baseline for the earlier model and is not erased. OR1 has its own,
broader production acceptance gate, and it is exercised in PR 8.

**Crossing OR1 makes production data durable business data.** From that moment,
every migration and every piece of development must preserve inventory history,
product identity, variant/SKU identity, generated SKUs, audit history, and
production data.

**OR1's required capabilities** are the minimum, and deliberately not the
roadmap: a corrected structured merchandise/SKU model; brand and classification;
selling price; basic acquisition/reference cost where appropriate; current
stock and location visibility; receiving; legitimate stock-out handling;
movement and history visibility; safe corrections and reversals; basic physical
count and discrepancy reconciliation; product lifecycle control; authentication
and session handling; capability authorization; hosted production deployment;
production data preservation.

**Named as post-OR1**, so that OR1 cannot absorb them: richer count approvals,
blind counts, advanced approval thresholds, low-stock alerts, reorder targets,
automated external-sales batching, supplier management, purchase orders, barcode
scanning, advanced costing, inventory valuation, richer reporting, native POS,
deeper analytics.

**OR1 depends on no particular host and on no zero-cost infrastructure.**
Roughly $20 has been set aside for hosting, so a paid managed platform is a
legitimate choice. The Oracle Cloud Always Free runbook in
`docs/06-operations/oci-zero-cost.md` remains a valid optional infrastructure
candidate with real tooling behind it, and is not the plan of record. **The OR1
host is chosen in PR 8**, against the acceptance gate and the budget.

**The route to OR1** is PR 2 merchandise foundation/schema, PR 3 merchandise
backend/contracts, PR 4 stock history/evidence, PR 5 corrections and lifecycle,
PR 6 basic count/reconciliation, PR 7 OR1 information architecture and UI, PR 8
OR1 acceptance, hardening, and production deployment. **UI redesign follows
domain correction**, which is why 7 is where it is. None of those PRs is
designed here.

This sequence sits ahead of the offline milestone that ADR 2 called next. ADR 2
and ADR 6 are not rewritten and nothing about how offline would work has
changed — only when it happens. A shop that cannot use the system at all does
not benefit from being able to use it without internet.

## Consequences

- "Ready" now has one meaning, and a gate that has to be passed rather than
  argued.
- The staging achievement keeps its credit without being mistaken for the
  finish line.
- Schema work from PR 2 onward is done knowing exactly when the data stops
  being disposable — before OR1 a migration may be destructive, after it may
  not.
- The post-OR1 list is a place to put every good idea that arrives during PRs
  2–8, instead of arguing about it each time.
- Accepted cost: OR1 will ship without low-stock alerts, valuation, reporting,
  and scanning, and someone will reasonably ask for each of them. The answer is
  that the shop cannot use the system at all until OR1, and can use it
  imperfectly the day after.
- Accepted cost: deferring the host choice to PR 8 means the OCI tooling
  already built may end up unused. It was cheap, it is documented, and choosing
  a host before the acceptance gate exists would be choosing it blind.
