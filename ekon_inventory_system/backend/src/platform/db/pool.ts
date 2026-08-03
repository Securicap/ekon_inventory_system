import pg from 'pg';
import type { Config } from '../../config/index.js';

const { Pool, types } = pg;

/**
 * `bigint` (OID 20) arrives as a string by default because it can exceed
 * Number.MAX_SAFE_INTEGER. Our bigints are ledger sequence numbers and money in
 * minor units; both are safely below 2^53 for this business, and callers expect
 * numbers. Parsing here keeps the coercion in one place instead of scattered
 * `Number(row.x)` calls.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

/**
 * `numeric` (OID 1700) is deliberately NOT parsed to a float. We do not use
 * numeric for quantities or money — quantities are integers in base units and
 * money is integers in minor units — so if a numeric column ever appears, it
 * should surface as a string and be reviewed rather than silently become a
 * float.
 */

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createPool(config: Config): DatabasePool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ...(config.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
    // Fail fast rather than hanging a request behind an exhausted pool.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Postgres will terminate a statement that runs away; this protects the
    // pool from a single pathological query holding a connection forever.
    statement_timeout: 15_000,
  });
}
