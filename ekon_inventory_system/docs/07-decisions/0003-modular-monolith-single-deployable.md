# 3. Modular monolith, single deployable

**Status:** Accepted — 2026-08-02

## Context

The system will grow: purchasing, shipments, sales, POS, reporting. It is
tempting to prepare for that with service boundaries now.

The team is one to two people. The business is one store.

## Decision

One process, one deployment, one database. Internal modules — `identity`,
`catalog`, `inventory`, `audit` — over a shared `platform` layer. Boundaries are
enforced by ESLint (`no-restricted-imports`) and by the rule that no module
reads another module's tables.

Explicitly rejected: microservices, a message broker, a separate API gateway,
Kubernetes, event sourcing infrastructure, CQRS as a framework.

## Consequences

- A change that spans modules is one transaction and one deploy.
- Module boundaries are real but cheap to move while the design is still
  settling.
- If a module ever genuinely needs separate scaling, the boundary already
  exists and extraction is mechanical.
- `inventory` is the only module permitted to write `inventory_movements`. That
  is the boundary the correctness of the whole system rests on.
