import { NextResponse } from 'next/server'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const auditUserId = await resolveAuditUserId(actor.accountId)
    const { id } = await params
    const client = await getPool().connect()

    try {
      await client.query('BEGIN')

      const { rows: originalRows } = await client.query<Record<string, unknown>>(
        `SELECT *
           FROM automations
          WHERE id = $1
            AND account_id = $2
          LIMIT 1`,
        [id, actor.accountId]
      )
      const original = originalRows[0]
      if (!original) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }

      const { rows: copyRows } = await client.query<Record<string, unknown>>(
        `INSERT INTO automations
           (account_id, user_id, name, description, trigger_type, trigger_config, is_active)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, false)
         RETURNING *`,
        [
          actor.accountId,
          auditUserId,
          `${String(original.name)} (Copy)`,
          original.description ?? null,
          original.trigger_type,
          JSON.stringify(original.trigger_config ?? {}),
        ]
      )
      const copy = copyRows[0]

      const { rows: steps } = await client.query<{
        id: string
        parent_step_id: string | null
        branch: 'yes' | 'no' | null
        step_type: string
        step_config: Record<string, unknown>
        position: number
      }>(
        `SELECT id, parent_step_id, branch, step_type, step_config, position
           FROM automation_steps
          WHERE automation_id = $1
          ORDER BY position ASC`,
        [id]
      )

      if (steps.length > 0) {
        const idMap = new Map<string, string>()
        const makeId = () =>
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36)

        for (const step of steps) {
          idMap.set(step.id, makeId())
        }

        const values: string[] = []
        const paramsList: unknown[] = []
        for (const step of steps) {
          paramsList.push(
            idMap.get(step.id),
            copy.id,
            step.parent_step_id ? idMap.get(step.parent_step_id) ?? null : null,
            step.branch,
            step.step_type,
            JSON.stringify(step.step_config ?? {}),
            step.position
          )
          const base = paramsList.length - 6
          values.push(
            `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`
          )
        }

        await client.query(
          `INSERT INTO automation_steps
             (id, automation_id, parent_step_id, branch, step_type, step_config, position)
           VALUES ${values.join(', ')}`,
          paramsList
        )
      }

      await client.query('COMMIT')
      return NextResponse.json({ automation: copy }, { status: 201 })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      console.error('Error duplicating automation:', error)
      return NextResponse.json({ error: 'Failed to duplicate automation' }, { status: 500 })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error duplicating automation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
