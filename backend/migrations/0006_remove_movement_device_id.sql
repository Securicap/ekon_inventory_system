-- 0006_remove_movement_device_id.sql
--
-- Removes device identity from the ledger.
--
-- `device_id` was captured on the assumption that a movement had to record
-- which browser installation entered it, and that such an identifier could
-- never be backfilled once the offline milestone needed it. Neither assumption
-- holds. Employees sign in from whichever computer is free; the permanent
-- business actor is the authenticated user, and "which machine" answers no
-- question anyone asks about stock. See ADR 9, which supersedes that part of
-- ADR 6.
--
-- Dropped rather than made nullable: a column nobody populates is a column
-- somebody eventually reads and trusts. Nothing replaces it here — no terminal,
-- session, IP, or user-agent column. Technical request metadata belongs in
-- audit and security logging, and lands there when there is a concrete reason,
-- not in the permanent stock ledger.
--
-- Safe to drop outright: the column has never been read by application code and
-- carries no production business data. Once it did, this would be a two-step
-- deploy — stop writing, then drop.

BEGIN;

ALTER TABLE inventory_movements DROP COLUMN device_id;

COMMIT;
