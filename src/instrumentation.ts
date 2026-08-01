/**
 * Server startup hook (Next.js 16 instrumentation).
 *
 * `register()` runs once when the Node server boots, before it accepts
 * requests. We use it to apply the direct-Postgres migrations
 * (pg/migrations/*.sql) so a freshly provisioned DB is up to date as
 * soon as the server starts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('./lib/db/migrate')
    await runMigrations()
  }
}
