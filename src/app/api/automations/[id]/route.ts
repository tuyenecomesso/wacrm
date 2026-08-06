import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

async function getAutomationForAccount(accountId: string, id: string) {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT *
       FROM automations
      WHERE id = $1
        AND account_id = $2
      LIMIT 1`,
    [id, accountId]
  )
  return rows[0] ?? null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await params
    const automation = await getAutomationForAccount(actor.accountId, id)

    if (!automation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const steps = await loadStepsTree(id)
    return NextResponse.json({ automation, steps })
  } catch (error) {
    console.error('Error loading automation:', error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as
      | (Record<string, unknown> & { steps?: BuilderStepInput[] })
      | null

    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const existing = await getAutomationForAccount(actor.accountId, id)
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = {}
    for (const key of [
      'name',
      'description',
      'trigger_type',
      'trigger_config',
      'is_active',
    ] as const) {
      if (key in body) update[key] = body[key]
    }

    const willBeActive =
      typeof update.is_active === 'boolean'
        ? update.is_active
        : Boolean(existing.is_active)

    if (willBeActive) {
      const mergedTriggerType = String(update.trigger_type ?? existing.trigger_type)
      const mergedTriggerConfig =
        (update.trigger_config ?? existing.trigger_config) as Record<string, unknown>
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id)

      const issues = [
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(mergedSteps),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot keep automation active with invalid configuration',
            issues,
          },
          { status: 400 }
        )
      }
    }

    if (Object.keys(update).length > 0) {
      const setClauses: string[] = []
      const values: unknown[] = [id, actor.accountId]
      for (const [field, value] of Object.entries(update)) {
        values.push(field === 'trigger_config' ? JSON.stringify(value ?? {}) : value)
        const placeholder = values.length
        setClauses.push(
          field === 'trigger_config'
            ? `${field} = $${placeholder}::jsonb`
            : `${field} = $${placeholder}`
        )
      }

      await getPool().query(
        `UPDATE automations
            SET ${setClauses.join(', ')}
          WHERE id = $1
            AND account_id = $2`,
        values
      )
    }

    if (Array.isArray(body.steps)) {
      const error = await replaceSteps(id, body.steps)
      if (error) {
        return NextResponse.json({ error }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error updating automation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await params
    const { rowCount } = await getPool().query(
      `DELETE FROM automations
        WHERE id = $1
          AND account_id = $2`,
      [id, actor.accountId]
    )

    if (!rowCount) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting automation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
