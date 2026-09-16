# Architecture overview

This document describes the **technical** architecture — the shape of the
deployment, the layers, and where correctness is enforced. All of it is
implemented and none of it changes with the merchandise work.

What the system is _about_ — the retail merchandise domain, the
`Classification → Product → Variant/SKU → SKU × Location` model, the count and
reconciliation principle, and the OR1 milestone — is in
[retail-domain-and-or1.md](retail-domain-and-or1.md), which is authoritative for
those and is approved direction rather than a description of the code. The
ledger guarantees below are unchanged by it.

## Shape

```
   the shop computer
   ┌────────────────────────────────────────────────────────┐
   │                                                        │
   │   browser ─────────▶ ┌──────────────────────────┐      │
   │   127.0.0.1          │  one web service         │      │
   │                      │  Fastify + React         │      │
   │                      │  same origin, one deploy │      │
   │                      └────────────┬─────────────┘      │
   │                                   │                    │
   │                      ┌────────────▼─────────────┐      │
   │                      │  PostgreSQL 16           │      │
   │                      │  local, bundled          │      │
   │                      │  127.0.0.1:5432          │      │
   │                      └────────────┬─────────────┘      │
   │                                   │ scheduled pg_dump  │
   └───────────────────────────────────┼────────────────────┘
                                       ▼
                            a backup copy off the machine
```

The shop computer is the server. Nothing Ekon installs listens outside the
loopback interface, and no workflow needs the internet — see
[ADR 13](../07-decisions/0013-local-first-shop-installation.md), which supersedes
[ADR 2](../07-decisions/0002-cloud-hosted-not-shop-local.md). Because there is no
provider taking snapshots, backup and restore are part of the product.

## Why one origin

The backend serves the built frontend from `backend/public`. One deployment, no
CORS configuration, no cookie-domain problems. The frontend always calls
relative `/api/...` paths; in development Vite proxies them.

## What the browser holds

Nothing authoritative, and no credential.

The session token lives in an `HttpOnly` cookie the browser sends and JavaScript
cannot read. There is no token in memory, no `Authorization` header, no JWT, and
nothing about the signed-in user in `localStorage`, `sessionStorage`, IndexedDB,
or any cookie written by frontend code. On every page load the application asks
`GET /api/auth/me` and renders nothing protected until the server has answered;
a refresh restores the user the same way.

Screens decide what to show from the capabilities that answer returns — never
from a role name — and that decision is usability only. Every request is
authorized again by the server, which is the authority. A hidden link is not a
boundary.

The current screens are a temporary shell, not the platform's visual design; see
[frontend/README.md](../../frontend/README.md).

## Layers

```
  frontend/                React, browser only, holds no authoritative data
      │  HTTP (relative /api)
  backend/src/app.ts       Fastify: request id, error mapping, static assets
      │
  backend/src/modules/     identity · catalog · inventory · audit
      │                    each: domain / application / infrastructure / http
  backend/src/platform/    db · http · ids · clock · errors · config
      │
  PostgreSQL               constraints, triggers, transactions
```

Dependencies point inward. `platform` never imports a module; a module never
reaches into another module's internals. ESLint enforces both.

## Where correctness lives

Deliberately, in the database rather than in application code:

| Guarantee                                             | Mechanism                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| Movements are never edited or deleted                 | Triggers; a role granted only `SELECT, INSERT` is planned (Phase 1)            |
| Before/after quantities are arithmetically consistent | `CHECK (quantity_after = quantity_before + quantity_delta)`                    |
| History cannot fork under concurrency                 | `previous_movement_id UNIQUE` + partial unique index + `SELECT ... FOR UPDATE` |
| A command applies at most once                        | `operations.id` primary key                                                    |
| Stock never goes negative                             | `CHECK (quantity_on_hand >= 0)`                                                |
| Rows with history are not deleted                     | `ON DELETE RESTRICT`                                                           |

Application code can have bugs. These cannot be bypassed by one.

## Single writer, total order

There is one database and one application tier, on one computer, so the ledger
has a total order by construction. No conflict resolution exists anywhere in
this system, and none is needed.

**This is an assumption a future synchronization milestone must revisit.**
Because movements record `quantity_before`/`quantity_after` and link to a
predecessor, the ledger is order-dependent. A movement arriving from elsewhere
carries a delta only; the server assigns its chain position at ingestion. See
`docs/07-decisions/0004`. Movement ids and `recorded_at` are assigned there too
— ids are still generated in application code rather than by the database, but
by the server's, not the browser's. If that milestone needs a client-side event
identity, it gets one through a synchronization envelope designed and reviewed
on its own, not by widening the posting command.

## Request lifecycle for a state-changing command

1. The browser generates an `operation_id` when the form opens and mirrors the
   form to `localStorage`.
2. `POST /api/...` carries `x-ekon-operation-id`. The request identifies the
   command, and the session cookie identifies the user — nothing identifies
   the machine (ADR 9).
3. Before the handler — before the body is even parsed — one hook resolves the
   session cookie to the current user and checks the capability the route
   declared. No session is `401`; a session without the capability is `403`.
   Every `/api/` route declares `auth: 'public'`, `auth: 'authenticated'`, or a
   `capability`, and one that declares nothing fails to register, so an endpoint
   cannot be added unprotected by accident. The handler receives the person as
   `request.actor` and takes `user_id` from there — never from the body.
4. One transaction opens. The server clock is read once, and the `operations`
   row is inserted with `ON CONFLICT DO NOTHING`; a conflict means replay, and
   the stored result is returned — no new identity, no new timestamp.
5. Domain work runs: mint the movement id, lock the balance row, compute
   before/after, insert the movement, update the balance, write the audit event.
   The `operation_id` is the client's; the movement's own id and its
   `recorded_at` are the server's, alongside the chain position and the
   quantities. `occurred_at` — when the stock physically moved — stays the
   caller's, and may precede `recorded_at`.
6. Commit. All of it, or none of it.
7. On success the client clears the draft. On failure the draft — and its
   operation id — survive, so retrying is safe.
