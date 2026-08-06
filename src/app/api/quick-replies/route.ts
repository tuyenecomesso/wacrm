import { NextResponse } from 'next/server'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { rows } = await getPool().query<Record<string, unknown>>(
      `SELECT *
         FROM quick_replies
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [actor.accountId]
    )
    return NextResponse.json({ quick_replies: rows })
  } catch (error) {
    console.error('Error listing quick replies:', error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const auditUserId = await resolveAuditUserId(actor.accountId)
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const kind = body.kind === 'interactive' ? 'interactive' : 'text'
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 })
    }

    let contentText: string | null = null
    let interactivePayload: unknown = null

    if (kind === 'interactive') {
      const result = validateInteractivePayload(body.interactive_payload)
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      interactivePayload = body.interactive_payload
    } else {
      const text = typeof body.content_text === 'string' ? body.content_text : ''
      if (!text.trim()) {
        return NextResponse.json(
          { error: 'content_text is required for text quick replies' },
          { status: 400 }
        )
      }
      contentText = text
    }

    const { rows } = await getPool().query<Record<string, unknown>>(
      `INSERT INTO quick_replies
         (account_id, user_id, title, kind, content_text, interactive_payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        actor.accountId,
        auditUserId,
        title,
        kind,
        contentText,
        interactivePayload ? JSON.stringify(interactivePayload) : null,
      ]
    )

    return NextResponse.json({ quick_reply: rows[0] }, { status: 201 })
  } catch (error) {
    console.error('Error creating quick reply:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
