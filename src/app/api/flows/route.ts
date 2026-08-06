import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { getPool } from '@/lib/pg'
import { getFlowTemplate } from '@/lib/flows/templates'

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { rows } = await getPool().query<Record<string, unknown>>(
      `SELECT *
       FROM flows
       WHERE account_id = $1
       ORDER BY created_at DESC`,
      [actor.accountId]
    )
    return NextResponse.json({ flows: rows })
  } catch (error) {
    console.error('Error listing flows:', error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const auditUserId = await resolveAuditUserId(actor.accountId)
    const body = (await request.json().catch(() => null)) as
      | {
          name?: string
          description?: string | null
          trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
          trigger_config?: Record<string, unknown>
          template_slug?: string
        }
      | null

    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const pool = getPool()

    if (body.template_slug) {
      const template = getFlowTemplate(body.template_slug)
      if (!template) {
        return NextResponse.json(
          { error: `Unknown template_slug "${body.template_slug}"` },
          { status: 400 },
        )
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const { rows: flowRows } = await client.query<Record<string, unknown>>(
          `INSERT INTO flows
             (user_id, account_id, name, description, status, trigger_type, trigger_config, entry_node_id)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb, $7)
           RETURNING *`,
          [
            auditUserId,
            actor.accountId,
            body.name?.trim() || template.name,
            template.description,
            template.trigger_type,
            JSON.stringify(template.trigger_config),
            template.entry_node_id,
          ]
        )
        const flow = flowRows[0]

        if (template.nodes.length > 0) {
          const values: string[] = []
          const params: unknown[] = []
          for (const node of template.nodes) {
            params.push(flow.id, node.node_key, node.node_type, JSON.stringify(node.config))
            const base = params.length - 3
            values.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}::jsonb)`)
          }
          await client.query(
            `INSERT INTO flow_nodes (flow_id, node_key, node_type, config)
             VALUES ${values.join(', ')}`,
            params
          )
        }

        await client.query('COMMIT')
        return NextResponse.json({ flow }, { status: 201 })
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        console.error('Error cloning flow template:', error)
        return NextResponse.json({ error: 'Failed to create flow' }, { status: 500 })
      } finally {
        client.release()
      }
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const { rows } = await pool.query<Record<string, unknown>>(
      `INSERT INTO flows
         (user_id, account_id, name, description, status, trigger_type, trigger_config)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb)
       RETURNING *`,
      [
        auditUserId,
        actor.accountId,
        body.name.trim(),
        body.description ?? null,
        body.trigger_type ?? 'keyword',
        JSON.stringify(body.trigger_config ?? {}),
      ]
    )

    return NextResponse.json({ flow: rows[0] }, { status: 201 })
  } catch (error) {
    console.error('Error creating flow:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
