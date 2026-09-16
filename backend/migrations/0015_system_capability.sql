-- 0015_system_capability.sql
--
-- One capability: `system.manage`, granted to `SUPER_ADMIN` and `OWNER`.
--
-- Ekon Local runs on a computer in a shop with nobody on site who administers
-- anything (ADR 13). There is no provider taking snapshots and no dashboard to
-- open — so the questions an operator would otherwise ask infrastructure have
-- to be answerable from inside the application: which build is this, which
-- schema is it on, and did last night's backup actually finish.
-- `GET /api/system/status` answers them, and this is the capability that opens
-- it.
--
-- **Not `audit.read`, and not `inventory.read`.** Audit is about what people
-- did; this is about what the machine is doing, and the two have different
-- audiences and different reasons to be withheld. Reusing an existing
-- capability would have meant that granting somebody the ability to read stock
-- history also told them how the installation is configured and when its
-- records were last copied — a fact worth keeping narrow, because the answer to
-- "when was the last backup" is also the answer to "how much would be lost".
--
-- **Owner and super-admin only, and not `MANAGER`.** A manager runs the shop
-- floor. Whether the business could survive losing the computer is the owner's
-- question, and the person who would have to act on a failed backup is the
-- person who owns the records. A shop that wants a manager to watch it grants
-- this later; starting narrow and widening is the direction that works.
--
-- No table is created and no row is rewritten. The capability vocabulary lives
-- in a CHECK constraint (0001's convention: text + CHECK, not native enums), so
-- widening it means replacing the constraint — an additive change to what the
-- column accepts.
--
-- Kept identical to CAPABILITIES and DEFAULT_ROLE_CAPABILITIES in
-- `@ekon/shared`. A test compares both sides and fails if either gains or loses
-- a single grant.

BEGIN;

-- The vocabulary -----------------------------------------------------------
--
-- Replacing the CHECK is the additive technique 0008 used for the same reason:
-- the column is `text`, so nothing is rewritten, and the new constraint is
-- strictly wider than the old one — every value the old one accepted, the new
-- one accepts — so the validation scan cannot fail and runs inside this
-- transaction with no window in which the column is unconstrained.
--
-- 0007's list predates `inventory.remove`, which 0008 added. Both are written
-- out here, in the order `CAPABILITIES` declares them, so this constraint is
-- the whole vocabulary rather than a diff a reader has to assemble from three
-- migrations.

ALTER TABLE role_capabilities
  DROP CONSTRAINT role_capabilities_capability_known;

ALTER TABLE role_capabilities
  ADD CONSTRAINT role_capabilities_capability_known CHECK (
    capability IN (
      'catalog.read',
      'catalog.write',
      'catalog.deactivate',
      'inventory.read',
      'inventory.receive',
      'inventory.remove',
      'inventory.adjust',
      'inventory.count',
      'inventory.reverse',
      'audit.read',
      'identity.manage',
      'reports.export',
      'system.manage'
    )
  );

-- The grants ---------------------------------------------------------------
--
-- Written out explicitly, exactly as 0007 and 0008 wrote theirs, so the whole
-- authorization model stays readable rather than generated. No existing grant
-- is touched and nothing is revoked.

INSERT INTO role_capabilities (role, capability) VALUES
  ('SUPER_ADMIN', 'system.manage'),
  ('OWNER',       'system.manage');

COMMIT;
