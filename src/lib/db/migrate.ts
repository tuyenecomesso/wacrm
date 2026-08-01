import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getPool } from '@/lib/pg'

/**
 * Direct-Postgres migration runner.
 *
 * Applies `pg/migrations/*.sql` in filename order, recording each
 * applied file in `wacrm_schema_migrations` so it runs exactly once.
 * The files themselves are written idempotently (IF NOT EXISTS), but
 * the ledger makes re-runs cheap and explicit.
 *
 * The ledger is wacrm-specific: the Koyeb database is shared with
 * other projects (vanessa-backend) that already own a table called
 * `schema_migrations`, so we must not collide with it.
 *
 * Safe to call at every server boot: it acquires an advisory lock to
 * avoid two instances migrating concurrently, and no-ops when
 * `DATABASE_URL` is unset (e.g. local dev without the direct DB).
 */
export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.warn('[migrate] DATABASE_URL not set — skipping direct-Postgres migrations')
    return
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    // Serialize against concurrent boots (Koyeb may start >1 instance).
    await client.query('SELECT pg_advisory_lock($1)', [WACRM_MIGRATION_LOCK])

    await client.query(`
      CREATE TABLE IF NOT EXISTS wacrm_schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `)

    const dir = join(process.cwd(), 'pg', 'migrations')
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM wacrm_schema_migrations WHERE name = $1',
        [file]
      )
      if ((rowCount ?? 0) > 0) continue

      const sql = await readFile(join(dir, file), 'utf8')
      console.log(`[migrate] applying ${file}`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO wacrm_schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [WACRM_MIGRATION_LOCK])
    } finally {
      client.release()
    }
  }
}

// Stable 32-bit advisory-lock key ("WACM") — must fit in a JS safe
// integer so the int8 argument is not truncated.
const WACRM_MIGRATION_LOCK = 0x5741434d
