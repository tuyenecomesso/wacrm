import { NextResponse } from 'next/server'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { rows } = await getPool().query<Record<string, unknown>>(
      `SELECT *
         FROM automations
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [actor.accountId]
    )
    return NextResponse.json({ automations: rows })
  } catch (error) {
    console.error('Error listing automations:', error)
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
          trigger_type?: string
          trigger_config?: Record<string, unknown>
          is_active?: boolean
          steps?: BuilderStepInput[]
          template?: string
        }
      | null

    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    let effectiveSteps: BuilderStepInput[] | undefined = body.steps
    let effectiveName = body.name
    let effectiveDescription = body.description
    let effectiveTriggerType = body.trigger_type
    let effectiveTriggerConfig = body.trigger_config

    if (body.template && (!body.steps || body.steps.length === 0)) {
      const template = getTemplate(body.template)
      if (template) {
        effectiveName = effectiveName ?? template.name
        effectiveDescription = effectiveDescription ?? template.description
        effectiveTriggerType = effectiveTriggerType ?? template.trigger_type
        effectiveTriggerConfig =
          effectiveTriggerConfig ??
          (template.trigger_config as unknown as Record<string, unknown>)
        effectiveSteps = template.steps as unknown as BuilderStepInput[]
      }
    }

    if (!effectiveName || !effectiveTriggerType) {
      return NextResponse.json(
        { error: 'name and trigger_type are required' },
        { status: 400 }
      )
    }

    if (body.is_active) {
      const issues = [
        ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as {
            step_type: string
            step_config: Record<string, unknown>
          }[]
        ),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          { error: 'Cannot activate automation with invalid configuration', issues },
          { status: 400 }
        )
      }
    }

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const { rows: automationRows } = await client.query<Record<string, unknown>>(
        `INSERT INTO automations
           (user_id, account_id, name, description, trigger_type, trigger_config, is_active)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          auditUserId,
          actor.accountId,
          effectiveName,
          effectiveDescription ?? null,
          effectiveTriggerType,
          JSON.stringify(effectiveTriggerConfig ?? {}),
          Boolean(body.is_active),
        ]
      )

      const automation = automationRows[0]
      if (effectiveSteps && effectiveSteps.length > 0) {
        const error = await insertSteps(automation.id as string, effectiveSteps, client)
        if (error) {
          await client.query('ROLLBACK')
          return NextResponse.json({ error }, { status: 500 })
        }
      }

      await client.query('COMMIT')
      return NextResponse.json({ automation }, { status: 201 })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      console.error('Error creating automation:', error)
      return NextResponse.json({ error: 'Failed to create automation' }, { status: 500 })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Error creating automation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
