# 11. Ekon is a retail merchandise and inventory operations system

**Status:** Accepted — 2026-08-23

## Context

Every decision so far described a system that holds a list of stockable things
and a quantity against each. That was enough to build a correct ledger, and the
ledger is correct: movements are append-only, balances are a projection, stock
cannot go negative, and a retry posts once. None of that is in question.

What is in question is the thing being counted. The `catalog` module models a
product with a set of free-text key/value attributes per variant, and nothing
else — no brand, no classification, no price, no cost, no lifecycle beyond an
`is_active` column nothing sets. A shop selling footwear cannot use that. "Steve
Madden Bel Ami, black, size 8, width M" has a brand that has to be its own
field, a classification that is not a variant attribute, a price that belongs to
that size and not to the model, and a cost the owner needs in order to buy well.
Written into the current model, the brand ends up inside the product name, the
category ends up in the same key/value table as the colour, and the shop's
merchandise data is unusable the day it is entered.

The scope has to be pinned in the other direction too. "Inventory system" has no
natural edge — every one of them is asked for purchase orders, then suppliers,
then invoices, then margin, then a balance sheet, and a very small team building
intermittently will not survive that.

## Decision

**Ekon is a retail merchandise and inventory operations system.** Not a stock
counter, not an ERP. The full description is
[docs/03-architecture/retail-domain-and-or1.md](../03-architecture/retail-domain-and-or1.md),
which is authoritative for the domain; this ADR records the decisions and why
they were taken.

**The boundary.** Ekon is the authority for merchandise identity, brands,
classification, barcodes, selling price, operational acquisition cost, locations,
stock, movements, receiving, counts and reconciliations, corrections, lifecycle,
reorder policy, operational history, sales-related depletion, and retail
operational analytics. Ekon is not responsible for general ledger accounting,
payroll, bank reconciliation, AP, AR, tax filing, depreciation, balance sheets,
statutory financial statements, or bookkeeping. That exclusion is about
accounting, not about money: selling price, cost, inventory value, margin, and
product performance are operational retail metrics and stay in scope.

**The merchandise model** is four levels, and none of them may be collapsed:

```text
Classification → Product → Variant / SKU → SKU × Location Inventory
```

- **Product** is a recognizable model, and carries no stock. Brand is a
  structured field on it, never text inside the product name. Classification
  (audience, category, type) describes grouping and is a product concern.
- **Variant / SKU** is the smallest independently sellable and stockable
  identity, and owns its inventory, its price, and its history independently.
  Variant attributes describe variation — colour, size, width, material — and
  are a different thing from classification.
- Variant attributes become **controlled** rather than arbitrary free text, while
  staying flexible across merchandise types. Shoe-specific columns are not the
  universal design, and how this is modelled is not decided here.
- **Inventory is per SKU and location.** This is unchanged: the ledger is already
  keyed that way and stays that way.

**The generated SKU is preserved exactly as it is** — `EKN-XXXXXXXX`,
server-assigned, non-semantic, unique, and immutable (INV-13). It is on physical
shelf labels. **A barcode never replaces it**: a barcode is a separate,
externally issued identifier attached to a SKU, which may be absent, duplicated,
or changed by somebody else, and is therefore an alternate lookup key rather than
an identity. Barcode storage may be prepared before any scanning workflow exists.

**Selling price belongs at SKU level**, with a possible product-level default
that a SKU may override. A **basic acquisition/reference cost** is acceptable,
and is explicitly recorded as _not_ inventory valuation and _not_ profit
accounting — one mutable number cannot say what the units on the shelf cost.
Historical costing and valuation are later work.

**Lifecycle is `Active → Discontinued → Archived`.** A record with no inventory
and no history may be deleted; merchandise carrying history never may (INV-12).
**Stock removal is not a lifecycle change** — a quantity reaching zero is a fact
about a shelf, and discontinuing is a decision about merchandise.

**Counting is separated into three acts:** a count observes reality,
reconciliation changes the system, investigation explains the difference. A
physical count must never silently overwrite the expected balance; the variance
is investigated and applied through an auditable reconciliation movement, which
is INV-9 and is already what the posting engine supports. The count workflow,
its tables and its API are not designed here.

**The append-only inventory engine is not redesigned.** Movements, not balance
edits; balances as a projection; append-only history; operation-id idempotency;
server-owned before/after quantities and direction; no negative stock; no
deletion of history-bearing rows. Every workflow this direction adds posts
through that engine.

**Sales stay outside.** OR1 needs no native POS; sales may originate in an
external ledger. Today's generic `Remove → SOLD` is transitional and is **not**
the permanent sales architecture. A later controlled workflow will translate
legitimate external sales into depletion, and whether depletion eventually comes
from a POS or an integration, it feeds the same ledger.

## Consequences

- The merchandise schema changes substantially, and that work comes before any
  UI redesign — a shell redrawn over the wrong model is a shell drawn twice.
- Generated SKUs, movements, balances, and audit history survive that change.
  Any migration that could not be made without discarding them is not made.
- The exclusion list is now something a future request can be measured against,
  rather than a judgement call each time somebody asks for purchase orders.
- Accepted cost: a shop can put a price and a cost into Ekon and get a margin
  that is an estimate against today's cost number, not a historical fact. That
  is a real limitation, written down rather than discovered later.
- Accepted cost: barcodes and controlled attributes both add structure before
  the workflows that exploit them exist. Both are cheap to prepare and expensive
  to retrofit onto merchandise data people have already typed.
- ADR 4's ledger decisions, ADR 9's attribution decisions, and the invariants in
  `docs/04-database/invariants.md` are untouched. This decision sits above them.
