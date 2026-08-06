import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { getPool } from '@/lib/pg'

type ActiveRunRow = {
  id: string
  flow_id: string
  user_id: string
  contact_id: string | null
  last_advanced_at: string
  fallback_policy: unknown
}

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever - blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const pool = getPool()

  let runs: ActiveRunRow[]
  try {
    const result = await pool.query<ActiveRunRow>(
      `SELECT fr.id,
              fr.flow_id,
              fr.user_id,
              fr.contact_id,
              fr.last_advanced_at,
              f.fallback_policy
         FROM flow_runs fr
         JOIN flows f ON f.id = fr.flow_id
        WHERE fr.status = 'active'`
    )
    runs = result.rows
  } catch (error) {
    console.error('[flows-cron] active-run scan failed:', error)
    return NextResponse.json({ error: 'Failed to scan active runs' }, { status: 500 })
  }

  if (runs.length === 0) {
    return NextResponse.json({ swept: 0 })
  }

  let swept = 0
  for (const run of runs) {
    const policy = resolveFallbackPolicy(run.fallback_policy)
    const lastAdvanced = new Date(run.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) {
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: updatedRows } = await client.query<{ id: string }>(
        `UPDATE flow_runs
            SET status = 'timed_out',
                ended_at = $2,
                end_reason = 'stale_sweep'
          WHERE id = $1
            AND status = 'active'
        RETURNING id`,
        [run.id, now.toISOString()]
      )

      if (updatedRows.length === 0) {
        await client.query('ROLLBACK')
        continue
      }

      await client.query(
        `INSERT INTO flow_run_events (flow_run_id, event_type, payload)
         VALUES ($1, 'timeout', $2::jsonb)`,
        [
          run.id,
          JSON.stringify({
            age_hours: Math.round(ageHours * 10) / 10,
            policy_hours: policy.on_timeout_hours,
          }),
        ]
      )

      await client.query('COMMIT')
      swept += 1
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      console.error('[flows-cron] timeout sweep failed:', { runId: run.id, error })
    } finally {
      client.release()
    }
  }

  return NextResponse.json({ swept })
}
