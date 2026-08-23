-- 0011_movement_history_index.sql
--
-- One index, and nothing else. No table, no column, no constraint, no row: the
-- stock-history API reads the ledger that already exists, and the ledger is
-- unchanged by being read.
--
-- The history feed is ordered by `recorded_at DESC, id DESC` — the order Ekon
-- actually wrote the ledger in, which never changes — and paginates with a
-- keyset cursor comparing that same pair. Neither of the existing indexes
-- serves it: `inventory_movements_chain_idx` leads with `(variant_id,
-- location_id)`, so it answers one shelf's history and not the whole feed, and
-- the two foreign-key indexes lead with a single id.
--
-- Measured on 60,000 movements before adding it, rather than assumed:
--
--   first page, no filter        parallel seq scan + top-N heapsort   41 ms, 1322 buffers
--   page ~30,000 deep (cursor)   seq scan + sort                      33 ms, 1283 buffers
--
-- and after:
--
--   first page, no filter        index-only scan backward            0.19 ms, 5 buffers
--   page ~30,000 deep (cursor)   index-only scan backward            0.31 ms, 6 buffers
--   filtered by location         index scan backward                 0.43 ms
--
-- The cost that matters is not the first page — 41 ms would be tolerable for
-- years at this shop's volume. It is that without the index every page costs a
-- full scan and a sort, so reading history *backwards through time*, which is
-- exactly what somebody investigating a discrepancy does, degrades with the
-- size of the ledger rather than with the size of the answer. An append-only
-- table only ever grows.
--
-- Ascending rather than `(recorded_at DESC, id DESC)`: PostgreSQL scans a btree
-- backwards just as cheaply, the plans above are all `Index Scan Backward`, and
-- a plain ascending index also serves a chronological read if one is ever
-- wanted. A DESC index would buy nothing and describe one query.
--
-- Not `CREATE INDEX CONCURRENTLY`: the migration runner puts every migration in
-- a transaction (0001's conventions, and the checksummed runner depends on it),
-- and `CONCURRENTLY` cannot run inside one. On a single shop's ledger the build
-- is momentary; on a table large enough for that to matter, an operator can
-- build it concurrently by hand and this migration will find it already there.

BEGIN;

CREATE INDEX IF NOT EXISTS inventory_movements_recorded_at_idx
  ON inventory_movements (recorded_at, id);

COMMIT;
