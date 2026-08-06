import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { getPool } from '@/lib/pg'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) - requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows.
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

  const pool = getPool()
  const { rows: due } = await pool.query<{
    id: string
    automation_id: string
    account_id: string
    user_id: string
    contact_id: string | null
    log_id: string | null
    parent_step_id: string | null
    branch: 'yes' | 'no' | null
    next_step_position: number
    context: AutomationContext | null
  }>(
    `SELECT id,
            automation_id,
            account_id,
            user_id,
            contact_id,
            log_id,
            parent_step_id,
            branch,
            next_step_position,
            context
       FROM automation_pending_executions
      WHERE status = 'pending'
        AND run_at <= $1
      ORDER BY run_at ASC
      LIMIT 50`,
    [new Date().toISOString()]
  )

  if (due.length === 0) {
    return NextResponse.json({ processed: 0 })
  }

  let processed = 0
  for (const row of due) {
    const { rows: claimRows } = await pool.query<{ id: string }>(
      `UPDATE automation_pending_executions
          SET status = 'running'
        WHERE id = $1
          AND status = 'pending'
      RETURNING id`,
      [row.id]
    )
    if (claimRows.length === 0) {
      continue
    }

    await resumePendingExecution({
      id: row.id,
      automation_id: row.automation_id,
      account_id: row.account_id,
      user_id: row.user_id,
      contact_id: row.contact_id,
      log_id: row.log_id,
      parent_step_id: row.parent_step_id,
      branch: row.branch,
      next_step_position: row.next_step_position,
      context: row.context ?? {},
    })
    processed += 1
  }

  return NextResponse.json({ processed })
}
