# 2. Cloud-hosted application; the shop laptop is a client only

**Status:** Accepted — 2026-08-02
**Supersedes:** an earlier proposal to run a server on the shop laptop

## Context

The business is in Haiti. Internet there is unreliable, which initially argued
for keeping data in the building.

Two facts made that wrong:

1. The owner is in another country and must review inventory remotely. A
   shop-local server would make the owner's access depend on a laptop in Haiti
   being powered on, awake, connected, and not in use for something else.
2. The shop laptop is shared and used for unrelated work. It is not a server.
   It gets shut down, moved, updated, and its disk is not backed up. Making it
   the only copy of the business's records would put those records one hardware
   failure away from gone.

## Decision

One cloud-hosted web service and one managed PostgreSQL database. The shop
laptop runs a browser and nothing else: no local server, no local database, no
installed software, no Docker, no background service.

The first release requires connectivity to submit and read data. Offline
operation is the next milestone, implemented as a client-side queue, not by
relocating the database.

## Consequences

- The owner's access does not depend on anything in the shop.
- There is one database, one writer tier, one clock, one backup.
- Conflict resolution is not needed: PostgreSQL provides total order.
- The shop cannot record inventory during an internet outage. This is a real
  cost, accepted deliberately, and the reason offline is the next milestone.
- Latency and payload size now matter, so the frontend carries a bundle budget
  enforced in CI.
