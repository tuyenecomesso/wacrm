import { Pool } from 'pg'

declare global {
  var __wacrmPgPool: Pool | undefined
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured')
  }
  // node-postgres refuses plaintext connections to remote hosts. The
  // Koyeb DB requires TLS, so the connection string carries
  // `sslmode=require` (see wacrm/.env.local).
  const ssl = /sslmode=(require|verify-full|verify-ca)/i.test(connectionString)
  return new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    connectionTimeoutMillis: 10000,
  })
}

/**
 * Shared Postgres pool for the direct-Postgres persistence layer
 * (webhook_endpoints, whatsapp_config). Stored on globalThis so the
 * pool survives Next.js dev module reloads.
 */
export function getPool(): Pool {
  globalThis.__wacrmPgPool ??= createPool()
  return globalThis.__wacrmPgPool
}
