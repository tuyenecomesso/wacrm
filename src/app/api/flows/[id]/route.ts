import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

async function getFlowForAccount(accountId: string, id: string) {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT *
     FROM flows
     WHERE id = $1
       AND account_id = $2
     LIMIT 1`,
    [id, accountId]
  )
  return rows[0] ?? null
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await context.params
    const flow = await getFlowForAccount(actor.accountId, id)
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { rows: nodes } = await getPool().query<Record<string, unknown>>(
      `SELECT *
       FROM flow_nodes
       WHERE flow_id = $1
       ORDER BY created_at ASC`,
      [id]
    )

    return NextResponse.json({ flow, nodes })
  } catch (error) {
    console.error('Error fetching flow:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await context.params
    const existing = await getFlowForAccount(actor.accountId, id)
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    }

    const flowPatch: string[] = []
    const flowValues: unknown[] = [id, actor.accountId]
    if (body.name !== undefined) {
      flowValues.push(body.name.trim())
      flowPatch.push(`name = $${flowValues.length}`)
    }
    if (body.description !== undefined) {
      flowValues.push(body.description)
      flowPatch.push(`description = $${flowValues.length}`)
    }
    if (body.trigger_type !== undefined) {
      flowValues.push(body.trigger_type)
      flowPatch.push(`trigger_type = $${flowValues.length}`)
    }
    if (body.trigger_config !== undefined) {
      flowValues.push(JSON.stringify(body.trigger_config))
      flowPatch.push(`trigger_config = $${flowValues.length}::jsonb`)
    }
    if (body.entry_node_id !== undefined) {
      flowValues.push(body.entry_node_id)
      flowPatch.push(`entry_node_id = $${flowValues.length}`)
    }
    if (body.fallback_policy !== undefined) {
      flowValues.push(JSON.stringify(body.fallback_policy))
      flowPatch.push(`fallback_policy = $${flowValues.length}::jsonb`)
    }

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')

      if (flowPatch.length > 0) {
        await client.query(
          `UPDATE flows
           SET ${flowPatch.join(', ')},
               updated_at = now()
           WHERE id = $1
             AND account_id = $2`,
          flowValues
        )
      }

      if (body.nodes !== undefined) {
        await client.query('DELETE FROM flow_nodes WHERE flow_id = $1', [id])
        if (body.nodes.length > 0) {
          const values: string[] = []
          const params: unknown[] = []
          for (const node of body.nodes) {
            params.push(
              id,
              node.node_key,
              node.node_type,
              JSON.stringify(node.config),
              node.position_x ?? 0,
              node.position_y ?? 0,
            )
            const base = params.length - 5
            values.push(
              `($${base}, $${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}, $${base + 5})`
            )
          }
          await client.query(
            `INSERT INTO flow_nodes
               (flow_id, node_key, node_type, config, position_x, position_y)
             VALUES ${values.join(', ')}`,
            params
          )
        }
      }

      const { rows: flowRows } = await client.query<Record<string, unknown>>(
        `SELECT *
         FROM flows
         WHERE id = $1
           AND account_id = $2
         LIMIT 1`,
        [id, actor.accountId]
      )
      const { rows: nodeRows } = await client.query<Record<string, unknown>>(
        `SELECT *
         FROM flow_nodes
         WHERE flow_id = $1
         ORDER BY created_at ASC`,
        [id]
      )

      await client.query('COMMIT')
      return NextResponse.json({ flow: flowRows[0] ?? null, nodes: nodeRows })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      console.error('Error updating flow:', error)
      return NextResponse.json({ error: 'Failed to update flow' }, { status: 500 })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error updating flow:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await context.params
    const { rowCount } = await getPool().query(
      `DELETE FROM flows
       WHERE id = $1
         AND account_id = $2`,
      [id, actor.accountId]
    )
    if ((rowCount ?? 0) === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting flow:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
