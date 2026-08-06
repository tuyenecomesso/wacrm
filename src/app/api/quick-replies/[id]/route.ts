import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}
    if (typeof body.title === 'string') {
      const title = body.title.trim()
      if (!title) {
        return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
      }
      update.title = title
    }

    if ('kind' in body) {
      if (body.kind !== 'text' && body.kind !== 'interactive') {
        return NextResponse.json(
          { error: 'kind must be "text" or "interactive"' },
          { status: 400 }
        )
      }
      update.kind = body.kind
      if (body.kind === 'interactive') {
        const result = validateInteractivePayload(body.interactive_payload)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 })
        }
        update.interactive_payload = body.interactive_payload
        update.content_text = null
      } else {
        const text = typeof body.content_text === 'string' ? body.content_text : ''
        if (!text.trim()) {
          return NextResponse.json(
            { error: 'content_text is required for text quick replies' },
            { status: 400 }
          )
        }
        update.content_text = text
        update.interactive_payload = null
      }
    } else {
      if ('content_text' in body) update.content_text = body.content_text ?? null
      if ('interactive_payload' in body) {
        if (body.interactive_payload != null) {
          const result = validateInteractivePayload(body.interactive_payload)
          if (!result.ok) {
            return NextResponse.json({ error: result.error }, { status: 400 })
          }
        }
        update.interactive_payload = body.interactive_payload ?? null
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ ok: true })
    }

    const setClauses: string[] = []
    const values: unknown[] = [id, actor.accountId]
    for (const [field, value] of Object.entries(update)) {
      values.push(field === 'interactive_payload' ? JSON.stringify(value ?? null) : value)
      const placeholder = values.length
      setClauses.push(
        field === 'interactive_payload'
          ? `${field} = $${placeholder}::jsonb`
          : `${field} = $${placeholder}`
      )
    }

    const { rowCount } = await getPool().query(
      `UPDATE quick_replies
          SET ${setClauses.join(', ')}
        WHERE id = $1
          AND account_id = $2`,
      values
    )
    if (!rowCount) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error updating quick reply:', error)
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
      `DELETE FROM quick_replies
        WHERE id = $1
          AND account_id = $2`,
      [id, actor.accountId]
    )
    if (!rowCount) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting quick reply:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
