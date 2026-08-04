-- 0007_identity.sql
--
-- Identity: who is acting, and what they are permitted to do. Three tables:
--
--   * `users`             — one row per person. Individual accounts, never a
--                           shared login: the value of every audit record and
--                           every movement's `user_id` depends on the person at
--                           the keyboard being the person signed in.
--   * `sessions`          — server-side session rows. The browser holds an
--                           opaque token; the database holds only its hash.
--   * `role_capabilities` — the role -> capability assignment, seeded here from
--                           the closed vocabularies in `@ekon/shared`.
--
-- Authentication is username + password, and a person may sign in from any
-- browser or computer. There is no device registry, no browser identity, and no
-- trusted-machine behaviour anywhere in this schema (ADR 9). Whether several
-- people share one computer, or one person works from several, has no business
-- significance and is not modelled.
--
-- Scope is deliberately narrow: this migration creates the data model and the
-- invariants that protect it, and nothing more. There is no login route, no
-- cookie, no request principal, and no capability enforcement — those are the
-- next two PRs. No user is seeded here either: the first owner is created by
-- the `identity:create-owner` command, so no credential is ever committed to
-- this repository.
--
-- Conventions from 0001 apply: uuid primary keys generated in application code
-- (no database defaults), timestamptz everywhere, application-supplied
-- timestamps rather than now(), boolean NOT NULL DEFAULT, text + CHECK instead
-- of native enums, and ON DELETE RESTRICT onto rows that carry history.

BEGIN;

-- Users --------------------------------------------------------------------
--
-- Usernames are stored already normalized — trimmed and lower-cased — and a
-- single CHECK enforces that stored form. `citext` (installed by 0001 for
-- exactly this purpose) is deliberately not used: case-insensitive comparison
-- would let `Marie` and `marie` be one login while two different-looking
-- strings sit in the column, and there would then be a display case of the
-- username to keep in step with the identity case. One canonical form is
-- simpler and is what `usernameSchema` in `@ekon/shared` produces. A test
-- compares that pattern against the constraint below.
--
-- There is no email column, and none is planned for this milestone. Nobody in
-- the shop has a work address, an email-based reset would depend on an inbox
-- the business does not control, and an address collected "for later" is a
-- personal detail stored for no current purpose.

CREATE TABLE users (
  id            uuid        PRIMARY KEY,
  username      text        NOT NULL,
  display_name  text        NOT NULL,
  password_hash text        NOT NULL,
  role          text        NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,

  -- One person, one username. The unique index this creates is also the lookup
  -- index the login path will use.
  CONSTRAINT users_username_unique UNIQUE (username),

  -- The normalized stored form, in one constraint: 3-40 characters of lowercase
  -- letters, digits, period, underscore, hyphen. That single pattern is what
  -- rejects a padded, upper-cased, blank, over-long, or oddly-punctuated
  -- username — there is no second rule for any of those cases to disagree with.
  -- Identical to USERNAME_PATTERN in `shared/src/identity.ts`.
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9._-]{3,40}$'),

  -- The name shown on screen. Free text, trimmed and bounded; case preserved,
  -- because it is a person's name.
  CONSTRAINT users_display_name_trimmed   CHECK (display_name = btrim(display_name)),
  CONSTRAINT users_display_name_not_blank CHECK (length(display_name) > 0),
  CONSTRAINT users_display_name_max_len   CHECK (length(display_name) <= 120),

  -- A password hash, and only ever a hash — the application hashes with
  -- Argon2id (see the identity module's `domain/password.ts`) and plaintext
  -- never reaches this column. Around 97 characters at that library's current
  -- defaults; the bound leaves generous room for stronger parameters, or a
  -- different algorithm, without a schema change.
  --
  -- These constraints are structural on purpose: nonblank, trimmed, bounded.
  -- The database deliberately does not try to recognize an Argon2 string. A
  -- CHECK that pinned the encoding would make the schema an authority on which
  -- algorithm is correct — a claim it cannot keep, since it would have to be
  -- migrated in lockstep with any rehash-on-login or algorithm change, and
  -- would block the interim state where old and new hashes coexist. Which
  -- algorithm is in use is the application's decision, enforced where it is
  -- made and tested there.
  CONSTRAINT users_password_hash_trimmed   CHECK (password_hash = btrim(password_hash)),
  CONSTRAINT users_password_hash_not_blank CHECK (length(password_hash) > 0),
  CONSTRAINT users_password_hash_max_len   CHECK (length(password_hash) <= 512),

  -- The closed role vocabulary, identical to ROLES in `shared/src/roles.ts`.
  -- Business code authorizes through capabilities and never reads this column
  -- directly; the mapping from one to the other is `role_capabilities` below.
  CONSTRAINT users_role_known CHECK (
    role IN ('SUPER_ADMIN', 'OWNER', 'MANAGER', 'EMPLOYEE')
  )
);

-- A user who leaves is deactivated, never deleted: their name has to stay
-- readable on every movement they ever posted. There is deliberately no
-- `deleted_at` — a row is either active or it is not, and a second, subtly
-- different notion of "gone" would eventually be checked in only half the
-- places that matter.

-- Sessions -----------------------------------------------------------------
--
-- A session is a row, not a stateless token, so that signing out, revoking a
-- session, deactivating a user, or changing someone's role takes effect on the
-- very next request rather than whenever a token happens to expire.
--
-- The database stores only `token_hash`. The raw token exists in the browser
-- and, for the length of one request, in server memory — never at rest. A
-- leaked database backup therefore yields no usable session.
--
-- What is deliberately absent: IP address, user agent, device or browser
-- identifier, last-activity timestamp, refresh token, session payload, and any
-- snapshot of the user's capabilities. The first several would make this a
-- device registry by accident (ADR 9); technical request metadata belongs in
-- security logging, on its own retention schedule. A capability snapshot is
-- worse than useless — it would mean a demoted or deactivated user kept their
-- old permissions until they signed out. Capabilities are resolved from the
-- user's current role on every request, so a role change or a deactivation
-- lands immediately without rewriting a single session row.

CREATE TABLE sessions (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash text        NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,

  -- The lookup key of the login path: one token, one session.
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),

  -- A hex digest of the opaque token. 64 characters for sha-256; the bound
  -- matches `operations.request_hash` and leaves room for a longer digest.
  CONSTRAINT sessions_token_hash_trimmed   CHECK (token_hash = btrim(token_hash)),
  CONSTRAINT sessions_token_hash_not_blank CHECK (length(token_hash) > 0),
  CONSTRAINT sessions_token_hash_max_len   CHECK (length(token_hash) <= 128),

  -- A session that expires when or before it began was never a session.
  CONSTRAINT sessions_expires_after_created CHECK (expires_at > created_at),

  -- Revocation cannot predate the session it revokes.
  CONSTRAINT sessions_revoked_not_before_created CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )

  -- Deliberately no CHECK comparing any column to now(). Whether a session has
  -- expired is a question about the moment a request arrives, answered by
  -- application code against the injected clock. A constraint against the
  -- database clock would make an expired row unwritable and an existing row
  -- retroactively invalid, which would make history unreadable.
);

-- Postgres does not index a foreign-key column automatically. This supports the
-- ON DELETE RESTRICT check and listing one user's sessions.
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Role capabilities --------------------------------------------------------
--
-- The assignment, and nothing else. Two text columns and a composite primary
-- key: no surrogate id, no timestamps, no separate `roles` or `capabilities`
-- table. Both vocabularies are closed sets in `@ekon/shared` and are enforced
-- here by CHECK, so a lookup table would add a join and a second place for the
-- same list to be wrong.
--
-- Roles are not configurable at runtime, and there are no per-user capability
-- overrides. Granting one person something extra is how an authorization model
-- stops being reviewable: within a year nobody can answer "who can reverse a
-- movement?" without reading rows. Changing what a role may do is a migration —
-- reviewable, and it leaves a record.

CREATE TABLE role_capabilities (
  role       text NOT NULL,
  capability text NOT NULL,

  -- One grant per (role, capability). The primary key also indexes the lookup
  -- the authorization hook will make, so no separate index is needed.
  PRIMARY KEY (role, capability),

  -- Identical to ROLES in `shared/src/roles.ts`.
  CONSTRAINT role_capabilities_role_known CHECK (
    role IN ('SUPER_ADMIN', 'OWNER', 'MANAGER', 'EMPLOYEE')
  ),

  -- Identical to CAPABILITIES in `shared/src/capabilities.ts`. A test asserts
  -- the two sets are equal, so a capability cannot be added to the code without
  -- being addable to the database.
  CONSTRAINT role_capabilities_capability_known CHECK (
    capability IN (
      'catalog.read',
      'catalog.write',
      'catalog.deactivate',
      'inventory.read',
      'inventory.receive',
      'inventory.adjust',
      'inventory.count',
      'inventory.reverse',
      'audit.read',
      'identity.manage',
      'reports.export'
    )
  ),

  -- Redundant with the vocabularies above, and kept anyway: if a value is ever
  -- added to those lists, these keep the stored form honest on its own terms.
  CONSTRAINT role_capabilities_role_trimmed         CHECK (role = btrim(role)),
  CONSTRAINT role_capabilities_role_not_blank       CHECK (length(role) > 0),
  CONSTRAINT role_capabilities_capability_trimmed   CHECK (capability = btrim(capability)),
  CONSTRAINT role_capabilities_capability_not_blank CHECK (length(capability) > 0)
);

-- The seed. Every grant is written out explicitly rather than generated, so the
-- migration produces exactly the same 35 rows on every environment and every
-- replay, and so a reviewer can read the whole authorization model in one
-- place. It does not import TypeScript, and it never will; a test compares
-- these rows against DEFAULT_ROLE_CAPABILITIES in `@ekon/shared` and fails if
-- either side gains or loses a single grant.

INSERT INTO role_capabilities (role, capability) VALUES
  -- SUPER_ADMIN — everything. The account that exists to fix the system itself.
  ('SUPER_ADMIN', 'catalog.read'),
  ('SUPER_ADMIN', 'catalog.write'),
  ('SUPER_ADMIN', 'catalog.deactivate'),
  ('SUPER_ADMIN', 'inventory.read'),
  ('SUPER_ADMIN', 'inventory.receive'),
  ('SUPER_ADMIN', 'inventory.adjust'),
  ('SUPER_ADMIN', 'inventory.count'),
  ('SUPER_ADMIN', 'inventory.reverse'),
  ('SUPER_ADMIN', 'audit.read'),
  ('SUPER_ADMIN', 'identity.manage'),
  ('SUPER_ADMIN', 'reports.export'),

  -- OWNER — everything. It is their business and their records.
  ('OWNER', 'catalog.read'),
  ('OWNER', 'catalog.write'),
  ('OWNER', 'catalog.deactivate'),
  ('OWNER', 'inventory.read'),
  ('OWNER', 'inventory.receive'),
  ('OWNER', 'inventory.adjust'),
  ('OWNER', 'inventory.count'),
  ('OWNER', 'inventory.reverse'),
  ('OWNER', 'audit.read'),
  ('OWNER', 'identity.manage'),
  ('OWNER', 'reports.export'),

  -- MANAGER — everything except managing users. A manager runs the shop floor;
  -- creating accounts, changing roles, and deactivating people is the owner's.
  ('MANAGER', 'catalog.read'),
  ('MANAGER', 'catalog.write'),
  ('MANAGER', 'catalog.deactivate'),
  ('MANAGER', 'inventory.read'),
  ('MANAGER', 'inventory.receive'),
  ('MANAGER', 'inventory.adjust'),
  ('MANAGER', 'inventory.count'),
  ('MANAGER', 'inventory.reverse'),
  ('MANAGER', 'audit.read'),
  ('MANAGER', 'reports.export'),

  -- EMPLOYEE — read the catalog, read stock, book in what arrives. That is the
  -- job at the counter. Adjusting, counting, reversing, deactivating a product,
  -- reading the audit log, and exporting reports are all withheld: each either
  -- changes what the numbers mean or can hide the fact that they changed.
  ('EMPLOYEE', 'catalog.read'),
  ('EMPLOYEE', 'inventory.read'),
  ('EMPLOYEE', 'inventory.receive');

COMMIT;
