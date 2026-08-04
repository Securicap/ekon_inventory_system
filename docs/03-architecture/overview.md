# Architecture overview

## Shape

```
   shop laptop (browser)   ──┐
   shared, also used for      │
   unrelated work             │      ┌──────────────────────────┐
                              ├─────▶│  one web service         │
   owner, another country   ──┘      │  Fastify + React         │
   (laptop or phone)                 │  same origin, one deploy │
                                     └────────────┬─────────────┘
                                                  │
                                     ┌────────────▼─────────────┐
                                     │  managed PostgreSQL 16   │
                                     │  daily backup + PITR     │
                                     └────────────┬─────────────┘
                                                  │ weekly pg_dump
                                                  ▼
                                        object storage (independent copy)
```

The shop laptop is a client. It runs no server, no database, and no installed
software beyond a browser.

## Why one origin

The backend serves the built frontend from `backend/public`. One deployment, one
TLS certificate, no CORS configuration, no cookie-domain problems. The frontend
always calls relative `/api/...` paths; in development Vite proxies them.

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
| Movements are never edited or deleted                 | Triggers + a role granted only `SELECT, INSERT`                                |
| Before/after quantities are arithmetically consistent | `CHECK (quantity_after = quantity_before + quantity_delta)`                    |
| History cannot fork under concurrency                 | `previous_movement_id UNIQUE` + partial unique index + `SELECT ... FOR UPDATE` |
| A command applies at most once                        | `operations.id` primary key                                                    |
| Stock never goes negative                             | `CHECK (quantity_on_hand >= 0)`                                                |
| Rows with history are not deleted                     | `ON DELETE RESTRICT`                                                           |

Application code can have bugs. These cannot be bypassed by one.

## Single writer, total order

There is one database and one application tier, so the ledger has a total order
by construction. No conflict resolution exists anywhere in this system, and none
is needed.

**This is an assumption the offline milestone must revisit.** Because movements
record `quantity_before`/`quantity_after` and link to a predecessor, the ledger
is order-dependent. A movement queued on a client carries a delta only; the
server assigns its chain position at ingestion. See `docs/07-decisions/0004`.
Movement ids and `recorded_at` are assigned there too — ids are still generated
in application code rather than by the database, but by the server's, not the
browser's. If the offline milestone needs a client-side event identity, it gets
one through a synchronization envelope designed and reviewed on its own, not by
widening the posting command.

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
