import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { validateFlowForActivation } from '@/lib/flows/validate'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await context.params
    const body = (await request.json().catch(() => null)) as
      | { status?: 'draft' | 'active' | 'archived' }
      | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) {
      return NextResponse.json(
        { error: "status must be one of 'draft' | 'active' | 'archived'" },
        { status: 400 },
      )
    }

    const { rows: flowRows } = await getPool().query<{
      id: string
      name: string
      trigger_type: 'keyword' | 'first_inbound_message' | 'manual'
      trigger_config: Record<string, unknown>
      entry_node_id: string | null
    }>(
      `SELECT id, name, trigger_type, trigger_config, entry_node_id
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

    if (status === 'active') {
      const { rows: nodes } = await getPool().query<{
        node_key: string
        node_type: string
        config: Record<string, unknown>
      }>(
        `SELECT node_key, node_type, config
         FROM flow_nodes
         WHERE flow_id = $1`,
        [id]
      )
      const issues = validateFlowForActivation(flow, nodes)
      const blockers = issues.filter((issue) => issue.severity === 'error')
      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot activate flow — fix the issues below first.',
            issues,
          },
          { status: 422 },
        )
      }
    }

    const { rows: updatedRows } = await getPool().query<Record<string, unknown>>(
      `UPDATE flows
       SET status = $3,
           updated_at = now()
       WHERE id = $1
         AND account_id = $2
       RETURNING *`,
      [id, actor.accountId, status]
    )

    return NextResponse.json({ flow: updatedRows[0] ?? null })
  } catch (error) {
    console.error('Error changing flow status:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
