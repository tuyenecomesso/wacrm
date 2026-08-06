import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await context.params

    const { rows: flowRows } = await getPool().query<{ id: string; name: string }>(
      `SELECT id, name
       FROM flows
       WHERE id = $1
         AND account_id = $2
       LIMIT 1`,
      [id, actor.accountId]
    )
    const flow = flowRows[0]
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { rows: runs } = await getPool().query<Record<string, unknown>>(
      `SELECT
         fr.id,
         fr.status,
         fr.current_node_key,
         fr.started_at,
         fr.last_advanced_at,
         fr.ended_at,
         fr.end_reason,
         fr.vars,
         fr.reprompt_count,
         json_build_object('id', c.id, 'name', c.name, 'phone', c.phone) AS contact
       FROM flow_runs fr
       LEFT JOIN contacts c ON c.id = fr.contact_id
       WHERE fr.flow_id = $1
       ORDER BY fr.started_at DESC
       LIMIT 50`,
      [id]
    )

    const runIds = runs
      .map((run) => run.id)
      .filter((id): id is string => typeof id === 'string')

    let events: Array<{
      flow_run_id: string
      event_type: string
      node_key: string | null
      payload: Record<string, unknown>
      created_at: string
    }> = []

    if (runIds.length > 0) {
      const { rows: eventRows } = await getPool().query<{
        flow_run_id: string
        event_type: string
        node_key: string | null
        payload: Record<string, unknown>
        created_at: string
      }>(
        `SELECT flow_run_id, event_type, node_key, payload, created_at
         FROM flow_run_events
         WHERE flow_run_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [runIds]
      )
      events = eventRows
    }

    return NextResponse.json({ flow, runs, events })
  } catch (error) {
    console.error('Error listing flow runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
