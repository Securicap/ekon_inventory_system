# Retail domain and Operational Release 1

This document is the authoritative description of **what Ekon is about** — the
merchandise and inventory operations domain it owns — and of **OR1**, the
milestone at which it becomes the store's real day-to-day system.

**Read it as approved direction, not as a description of the code.** Almost
nothing below the "Inventory operating model" section exists yet.
[README.md](../../README.md) describes what the software does today; this
document describes what it is being built into. Where the two differ, both are
correct about different things, and the README says which is which.

The decisions recorded here are ADR
[11](../07-decisions/0011-retail-merchandise-and-inventory-operations.md) and
ADR [12](../07-decisions/0012-operational-release-one.md). The technical
architecture — one origin, modular monolith, where correctness lives — is
unchanged and stays in [overview.md](overview.md). The ledger guarantees are
unchanged and stay in [invariants.md](../04-database/invariants.md).

---

## What Ekon is

> Ekon is a **retail merchandise and inventory operations system**.

It is not a stock counter, and it is not an ERP.

A stock counter answers "how many". It has a list of things and a number
against each. That is what the current implementation is, and it is not enough
for a shop that sells brands, models, colours, and sizes: "Bel Ami" is not one
thing to count, it is a product with a dozen sellable identities under it, each
with its own shelf quantity, its own price, and its own history.

An ERP answers everything, including the accounting. Ekon deliberately does
not.

### What Ekon owns

Ekon is the authority for:

- merchandise identity — products, variants/SKUs, brands;
- controlled merchandise classification;
- barcode identifiers;
- selling prices;
- operational acquisition cost information;
- inventory locations;
- stock quantities and availability;
- inventory movements;
- receiving;
- physical counts, discrepancies, and reconciliations;
- safe corrections;
- product lifecycle;
- low-stock and reorder policy;
- operational history and audit;
- sales-related inventory depletion;
- retail operational analytics.

Supplier management, purchase orders, barcode scanning, advanced costing,
external sales integrations, and a native POS may come later. **They are not
OR1** — see [Explicitly post-OR1](#explicitly-post-or1).

### What Ekon does not own

Ekon is not responsible for general ledger accounting, payroll, bank
reconciliation, accounts payable, accounts receivable, tax filing, depreciation
accounting, balance sheets, statutory financial statements, or full
bookkeeping.

That exclusion is about **accounting**, not about money. Selling price,
acquisition cost, inventory value, gross margin, gross profit, sales
quantities, and product performance are operational retail metrics, they are
what a shop owner needs in order to buy and price well, and they are legitimate
Ekon concerns. The line is: Ekon says what the shop has and what it is worth to
run; it does not produce financial statements.

---

## The merchandise domain

```text
Classification
    ↓
Product
    ↓
Variant / SKU
    ↓
SKU × Location Inventory
```

Four levels, and each answers a different question. Collapsing any two of them
is the mistake this model exists to prevent.

### Product

A product is a recognizable piece of merchandise — a model, the thing a
customer names.

```text
Brand:    Steve Madden
Product:  Bel Ami
Category: Footwear / Sandals
Audience: Women
```

**Brand is structured data**, held as its own field on the product and not
typed into the product name. A shop that writes "Steve Madden Bel Ami" into a
name column can never answer "what does Steve Madden do for us", cannot rename
a brand, and gets a different spelling every third product.

A product carries no stock. It is a heading.

### Variant / SKU

**The variant is the smallest independently sellable and stockable merchandise
identity.** It is the level at which the business actually trades.

```text
Product: Steve Madden Bel Ami
Color:   Black
Size:    8
Width:   M
SKU:     EKN-...
```

Each SKU owns its inventory independently. Black/8 and Black/9 are two
quantities, two prices if the shop wants, two histories, and two lines on a
count sheet. This is already how the ledger works — `inventory_movements` and
`inventory_balances` are keyed by variant and location, never by product — and
that part of the system does not change.

### SKU

The Ekon-generated SKU stays exactly as it is: **immutable, internal, and
permanent**, `EKN-XXXXXXXX`, assigned by the server, chosen by nobody, and
printed on shelf labels. See INV-13 in
[invariants.md](../04-database/invariants.md) and the
[catalog module README](../../backend/src/modules/catalog/README.md).

**A barcode must never replace the SKU.** They are different identifiers with
different owners.

### Barcode

A barcode is a **separate identifier attached to a SKU**, issued by whoever
manufactured or distributed the merchandise. It can be missing, it can be
duplicated across unrelated goods, it can change between production runs, and
the same physical item can carry several. None of that is true of the SKU,
which is why the SKU stays the system's own handle on a variant and the barcode
is an alternate lookup key onto it.

Barcode support may be **structurally prepared** — a place to record one, and a
way to look a SKU up by it — before any scanning workflow exists. Scanning is
post-OR1.

### Classification

Classification describes **how merchandise is grouped**, not how it varies.

```text
Audience: Kids
Category: Footwear
Type:     Sandals
```

Classification belongs to the product. It is how the shop navigates, reports,
and merchandises.

**Classification is not a variant attribute.** "Sandals" does not produce a
sellable identity; "Size 8" does. Mixing the two produces a catalog where
`category: Footwear` and `color: Black` sit in the same key/value table and
nothing can tell a grouping from a variation.

### Variant attributes

Attributes must stay flexible enough for merchandise that varies in different
ways, while becoming **controlled** rather than arbitrary free text:

| Merchandise | Attributes         |
| ----------- | ------------------ |
| Footwear    | color, size, width |
| Handbags    | color, material    |
| Socks       | color, size        |

Controlled means the set of attribute names, and where sensible their values,
is defined data rather than whatever somebody typed — so `colour`, `Color`, and
`couleur` cannot become three attributes, and a report by colour is possible at
all.

**Shoe-specific columns are not the universal design.** A `size` column and a
`width` column on the variant table would be wrong for a handbag and wrong
again for the next category the shop takes on. How controlled attributes are
actually modelled is PR 2's problem, and this document deliberately does not
decide it.

### Price

**Selling price belongs at the SKU level**, because that is the level that is
sold. A product may eventually carry a default that its variants inherit and
may override — a shop that prices every size of one sandal the same should say
so once — but the authoritative price is the SKU's.

### Cost

A basic acquisition / reference cost per SKU is acceptable for OR1, and is what
makes margin visible at all.

**A single mutable cost value is not inventory valuation and it is not profit
accounting.** It is one number that gets overwritten the next time the shop
buys the same item at a different price. It cannot tell you what the stock on
the shelf actually cost, because it does not know which units came from which
purchase, and any margin computed from it is an estimate against today's number
rather than a historical fact. Real costing — layered cost, weighted average,
valuation as of a date — needs cost to be carried on receipts and consumed by
depletions, which is a ledger concern and later work.

This is written down so that nobody later mistakes the OR1 cost field for an
accounting-grade one.

### Lifecycle

```text
Active  →  Discontinued  →  Archived
```

- **Active** — sold and stocked normally.
- **Discontinued** — no longer bought or reordered; existing stock is still
  sold and still counted.
- **Archived** — out of day-to-day operation; retained for history and
  reporting.

An unused erroneous record — created by mistake, with no inventory and no
history referencing it — may be deleted. **Merchandise that carries history
must never be deleted**, which is INV-12 and is enforced by `ON DELETE
RESTRICT` rather than by anybody's care.

> **Stock removal is not a product lifecycle change.**

Selling the last unit does not discontinue anything. A quantity reaching zero
is a fact about a shelf; discontinuing is a decision about merchandise. A
system that conflates them either hides live products that happen to be out of
stock, or keeps ordering things the shop deliberately stopped selling.

---

## Inventory operating model

```text
Merchandise
    ↓
Inventory / Stock
    ↓
Movements
    ↓
Business workflows / documents
```

| Layer       | The question it answers    |
| ----------- | -------------------------- |
| Merchandise | What is this SKU?          |
| Stock       | Where is it, and how many? |
| Movements   | What quantity changed?     |
| Workflows   | Why did it change?         |

**The existing append-only inventory engine is the foundation of all of this
and is not being redesigned.** The merchandise correction happens above it. The
guarantees below hold unchanged, and every workflow OR1 adds — counts,
reconciliations, corrections, eventual sales depletion — posts through the same
engine:

- inventory changes are **movements**, never direct balance edits;
- `inventory_balances` is a **projection**, rebuildable from the ledger;
- movements are **append-only** — never updated, never deleted;
- **operation ids provide idempotency**; a retry reuses the same operation id
  and the same command, and posts once;
- the **server owns** `quantity_before`, `quantity_after`, the chain position,
  and the movement direction — a client never supplies them;
- **stock cannot go negative**, by any path, for any role;
- balances are **per SKU and location**;
- **history-bearing records are protected from deletion**.

Full detail and enforcement: [invariants.md](../04-database/invariants.md) and
[ADR 4](../07-decisions/0004-append-only-ledger-with-before-after.md).

---

## The physical count principle

> **A count observes reality. Reconciliation changes the system. Investigation
> explains the difference.**

```text
Expected:       7
Physical count: 6
Variance:       −1
```

**A count must never silently overwrite the expected balance.** Setting the
number to 6 destroys the only signal the shop had: that one unit is
unaccounted for. What produced the variance has to be investigated, and the
system changes only through an auditable reconciliation movement that records
what was expected, what was counted, and why the difference was accepted.

Plausible explanations for that −1 include: a legitimate sale that was never
recorded, damage, a receipt that was missed, a data-entry error, merchandise
misplaced in another location, a counting error, shrinkage or theft, or another
documented cause. **They are not the same event**, and a system that flattens
all of them into "adjust to 6" cannot tell a shop it is being stolen from.

This is already recorded as INV-9: a count line produces a
`COUNT_RECONCILIATION` movement of `counted_quantity − expected_quantity`, with
`expected_quantity` snapshotted when the line is entered. The posting engine
can already post one. The count workflow, its tables, and its API are **not
designed in this PR**.

---

## Sales, and the boundary today

Ekon does **not** need a native POS for OR1.

Sales may originate in an external sales ledger, and OR1's job is to keep the
shelf honest, not to ring up customers.

What exists today is `POST /api/inventory/remove` with a reason, where `SOLD` is
one of four reasons. That is a **transitional mechanism and not the permanent
sales architecture.** It records that stock left and asserts nothing about a
sale: no customer, no price, no transaction, no quantity sold that can be
reconciled against anything.

What is needed, after OR1, is a **controlled workflow that translates
legitimate external sales into inventory depletion** — one that knows which
sales it has already applied, so that running it twice does not deplete twice,
and that leaves a trail from a depletion back to the sale that caused it.

Whether depletion eventually arrives from a native POS or from an external
integration, **it feeds the same movement ledger.** The engine underneath does
not change, and nothing about sales is implemented in OR1.

---

## Ekon Operational Release — OR1

> **OR1 means: safe and useful enough to become the store's real day-to-day
> inventory system, while development continues.**

It is not "feature complete" and it is not "version 1.0". It is the point at
which the shop stops keeping its stock somewhere else.

### OR1 is not the staging launch invariant

Hosted staging has passed its launch invariant — sign in, create accounts,
create a product, receive it, see it, remove it, sign out, all through
supported workflows. That happened, it is real, and it is recorded in
[deployment.md](../06-operations/deployment.md#the-launch-invariant).

**It proved the earlier operating loop against the earlier product model.** It
does not carry over to the redesigned merchandise and inventory product, which
does not exist yet. OR1 has its own, broader acceptance gate.

### Production data becomes durable business data

The moment OR1 goes live, what is in the database stops being test data. From
then on every migration and every piece of development must preserve:

- inventory history;
- product identity;
- variant / SKU identity;
- generated SKUs;
- audit history;
- production data.

Migrations stay additive; a merchandise change that cannot be made without
discarding SKUs or movements is not a change that gets made.

### OR1 required capabilities

The minimum. Not the roadmap.

- a corrected, structured merchandise / SKU model;
- brand and classification;
- selling price;
- basic acquisition / reference cost where appropriate;
- current stock and location visibility;
- receiving;
- legitimate stock-out handling;
- movement and history visibility;
- safe corrections and reversals;
- basic physical count and discrepancy reconciliation;
- product lifecycle control;
- authentication and session handling;
- capability authorization;
- hosted production deployment;
- production data preservation.

### Explicitly post-OR1

Naming these keeps OR1 from growing: richer count approvals, blind counts,
advanced approval thresholds, low-stock alerts, reorder targets, automated
external-sales batching, supplier management, purchase orders, barcode
scanning, advanced costing, inventory valuation, richer reporting, a native
POS, and deeper analytics.

Each is legitimate. None of them is what stands between the shop and using
this system for its real stock.

---

## Implementation sequence

High level, and deliberately not a design for any of it. Each PR is scoped when
it is opened, against this document.

| PR  | What it establishes                              |
| --- | ------------------------------------------------ |
| 1   | Architecture and OR1 documentation (this PR)     |
| 2   | Merchandise foundation and schema                |
| 3   | Merchandise backend and contracts                |
| 4   | Stock history and evidence                       |
| 5   | Corrections and lifecycle                        |
| 6   | Basic count and reconciliation                   |
| 7   | OR1 information architecture and UI              |
| 8   | OR1 acceptance, hardening, production deployment |

**UI redesign follows domain correction, not the other way round.** The current
screens are a temporary shell over the current model; redrawing them before the
merchandise model is right would produce a second shell. The current UI is not
redesigned in this PR and PR 7 is not designed here.

Offline operation, described in [README.md](../../README.md) and
[ADR 2](../07-decisions/0002-cloud-hosted-not-shop-local.md) as the next major
milestone, sits after this sequence. Those documents recorded the ordering that
was true when the system was a stock counter; the merchandise correction and
OR1 now come first. The ADRs are not rewritten — nothing about _how_ offline
would work has changed, only when it happens.

---

## Hosting

**OR1 does not depend on any particular host, and it does not depend on
zero-cost infrastructure.** Roughly $20 has been set aside for hosting, so a
paid managed platform is a legitimate OR1 choice.

The Oracle Cloud Always Free runbook in
[oci-zero-cost.md](../06-operations/oci-zero-cost.md) remains a valid optional
infrastructure candidate, with real tooling behind it. It is one option, not
the plan of record. **The OR1 host is chosen in PR 8**, against the acceptance
gate and the budget, not here.
