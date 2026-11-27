import { PGlite } from '@electric-sql/pglite';
import { drizzle as localDrizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as postgresDrizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

// All adapters expose the same PostgreSQL Drizzle query/transaction operations.
// Keep the existing domain modules independent of the connection transport.
export type Database = PgliteDatabase<typeof schema>;
export const STOCKFIX_WRITE_LOCK = 73061224;

export async function openDatabase(options: { dataDir?: string; databaseUrl?: string }) {
  if (!options.databaseUrl) {
    const local = new PGlite(options.dataDir);
    await local.waitReady;
    await local.exec(schema.initialSchema);
    return { db: localDrizzle(local, { schema }), remote: false, close: () => local.close() };
  }
  const address = new URL(options.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(address.protocol)) throw new Error('DATABASE_URL debe identificar PostgreSQL.');
  // Explicit TLS verification instead of connection-string modes that vary by driver version.
  address.searchParams.delete('sslmode');
  address.searchParams.delete('channel_binding');
  const pool = new pg.Pool({ connectionString: address.toString(), ssl: { rejectUnauthorized: true },
    max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 20_000, allowExitOnIdle: true });
  pool.on('error', () => { /* Failed idle clients are replaced on the next query. Never log connection secrets. */ });
  const connection = await pool.connect();
  let failed = false;
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock($1)', [STOCKFIX_WRITE_LOCK]);
    await connection.query(schema.initialSchema);
    await connection.query('COMMIT');
  } catch (error) {
    failed = true;
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { connection.release(); if (failed) await pool.end(); }
  return { db: postgresDrizzle(pool, { schema }) as unknown as Database, remote: true, close: () => pool.end() };
}
